import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Bounded startup timers so a stalled synthetic upstream fails over inside the test.
process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
process.env.FETCH_TIMEOUT_MS = "1500";
process.env.STREAM_READINESS_TIMEOUT_MS = "700";

const { createChatPipelineHarness } = await import("./_chatPipelineHarness.ts");
const h = await createChatPipelineHarness("claude-oauth-failover");
const { runAuthzPipeline } = await import("../../src/server/authz/pipeline.ts");
const db = await import("../../src/lib/db/providers.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const refreshBreaker = await import("../../open-sse/services/tokenRefresh/circuitBreaker.ts");

const model = "claude-haiku-5-5";
const HOUR = 3_600_000;
test.beforeEach(async () => {
  // The previous request's fire-and-forget logging can still be writing into the
  // data directory while it is removed.
  for (let attempt = 0; ; attempt++) {
    try {
      await h.resetStorage();
      break;
    } catch (error) {
      if (attempt >= 5 || (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  h.BaseExecutor.RETRY_CONFIG.delayMs = 5;
  quotaCache.__clearForTests();
  refreshBreaker.__resetCircuitBreakerForTests();
});
test.after(() => h.cleanup());

type Call = { kind: "messages" | "token" | "other"; account: string; url: string };
type Upstream = {
  messages: (account: string, init: RequestInit, nth: number) => Response | Promise<Response>;
  token?: (refreshToken: string) => Response | Promise<Response>;
};

// The gateway remembers rotated grants in memory, so every test gets its own
// synthetic credentials; reported names are normalized back to access-N / refresh-N.
let tag = "";
const norm = (value: unknown) => String(value ?? "").replaceAll(`${tag}-`, "");

/** Three synthetic OAuth subscription accounts, in the production priority shape. */
async function pool(expiresAt: Record<number, string> = {}) {
  tag = crypto.randomUUID().slice(0, 8);
  const connections = [];
  for (const n of [1, 2, 3]) {
    connections.push(
      await db.createProviderConnection({
        provider: "claude",
        authType: "oauth",
        name: `account-${n}`,
        email: `account-${n}@example.invalid`,
        accessToken: `access-${tag}-${n}`,
        refreshToken: `refresh-${tag}-${n}`,
        expiresAt: expiresAt[n] ?? new Date(Date.now() + 8 * HOUR).toISOString(),
        isActive: true,
        testStatus: "active",
        priority: n,
      })
    );
  }
  const key = await h.seedApiKey({ allowedConnections: connections.map((c) => c.id) });
  return { connections, key };
}

function install(upstream: Upstream) {
  const calls: Call[] = [];
  const perAccount = new Map<string, number>();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/oauth\/token/.test(url)) {
      const refreshToken = norm(new URLSearchParams(String(init.body)).get("refresh_token"));
      calls.push({ kind: "token", account: refreshToken, url });
      if (!upstream.token) throw new Error("unexpected refresh request");
      return upstream.token(refreshToken);
    }
    if (/\/v1\/messages/.test(url)) {
      const headers = h.toPlainHeaders(init.headers);
      const account = norm(
        String(headers.authorization || headers["x-api-key"] || "").replace(/^Bearer /, "")
      );
      const nth = (perAccount.get(account) || 0) + 1;
      perAccount.set(account, nth);
      calls.push({ kind: "messages", account, url });
      return upstream.messages(account, init, nth);
    }
    calls.push({ kind: "other", account: "", url });
    return new Response("{}", { status: 404 });
  };
  return {
    calls,
    messages: () => calls.filter((c) => c.kind === "messages").map((c) => c.account),
    tokens: () => calls.filter((c) => c.kind === "token").map((c) => c.account),
  };
}

/** Account order with the executor's bounded same-account retries collapsed. */
function order(accounts: string[]) {
  return accounts.filter((account, index) => account !== accounts[index - 1]);
}

function body(stream = false, messages: unknown[] = [{ role: "user", content: "continuity" }]) {
  return { model: `claude/${model}`, max_tokens: 40, stream, messages };
}

async function call(key: string, requestBody: Record<string, unknown> = body()) {
  const request = new NextRequest(
    h.buildRequest({ url: "http://localhost/v1/messages", authKey: key, body: requestBody })
  );
  const auth = await runAuthzPipeline(request, { enforce: true });
  if (auth && !auth.headers.get("x-middleware-next")) return auth;
  return h.handleChat(request);
}

function ok(text: string) {
  return h.buildClaudeResponse(text, model);
}
function upstreamError(status: number, type: string, message: string, headers = {}) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function tokenOk(refreshToken: string) {
  return new Response(
    JSON.stringify({
      access_token: `rotated-${tag}-${refreshToken}`,
      refresh_token: `next-${tag}-${refreshToken}`,
      expires_in: 28800,
    }),
    { headers: { "content-type": "application/json" } }
  );
}
function tokenRejected() {
  return new Response(
    JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}
function sse(text: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "synthetic",
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}
/** A request that never answers until the gateway's own abort signal fires. */
function hang(init: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init.signal as AbortSignal | undefined;
    const abort = () =>
      reject(signal?.reason ?? new DOMException("The operation timed out", "TimeoutError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function connectionReset() {
  const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}
async function state(id: string) {
  const row = await db.getProviderConnectionById(id);
  return {
    isActive: row?.isActive,
    testStatus: row?.testStatus,
    accessToken: norm(row?.accessToken),
    refreshToken: norm(row?.refreshToken),
    cooling: !!row?.rateLimitedUntil && Date.parse(String(row.rateLimitedUntil)) > Date.now(),
    rateLimitedUntil: row?.rateLimitedUntil ?? null,
  };
}

// ── 401 ──────────────────────────────────────────────────────────────────────

test("401: a rejected access credential is renewed officially and the same account answers", async () => {
  const { key, connections } = await pool();
  const seen = install({
    messages: (account) =>
      account === "access-1"
        ? upstreamError(401, "authentication_error", "OAuth token has expired")
        : ok(`answer ${account}`),
    token: tokenOk,
  });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer rotated-refresh-1/);
  assert.deepEqual(seen.messages(), ["access-1", "rotated-refresh-1"]);
  assert.deepEqual(seen.tokens(), ["refresh-1"]);
  const a = await state(connections[0].id);
  assert.equal(a.accessToken, "rotated-refresh-1");
  assert.equal(a.refreshToken, "next-refresh-1");
  assert.equal(a.isActive, true);
});

for (const failed of [1, 2, 3]) {
  test(`401: ${failed} account(s) with an unrecoverable grant leave the pool in priority order`, async () => {
    const { key, connections } = await pool();
    const seen = install({
      messages: (account) =>
        Number(account.slice(-1)) <= failed
          ? upstreamError(401, "authentication_error", "Invalid bearer token")
          : ok(`answer ${account}`),
      token: tokenRejected,
    });
    const response = await call(key.key);
    const text = await response.text();
    assert.deepEqual(seen.messages(), ["access-1", "access-2", "access-3"].slice(0, failed + 1));
    if (failed < 3) {
      assert.equal(response.status, 200);
      assert.match(text, new RegExp(`answer access-${failed + 1}`));
    } else {
      const error = JSON.parse(text);
      assert.equal(response.status, 502);
      assert.equal(error.error.code, "upstream_accounts_unavailable");
      assert.equal(error.continuity.upstream_status, 401);
      assert.equal(error.continuity.attempts, 3);
      assert.match(error.continuity.recovery, /Re-authenticate/);
      assert.equal(response.headers.get("x-should-retry"), "false");
    }
    for (const [index, connection] of connections.entries()) {
      const row = await state(connection.id);
      // A failed grant is never rewritten or discarded by the request path.
      assert.equal(row.refreshToken, `refresh-${index + 1}`);
      assert.equal(row.isActive, index + 1 > failed, `account ${index + 1} active`);
    }
  });
}

// ── 429 ──────────────────────────────────────────────────────────────────────

for (const wording of [
  "This request would exceed your account's rate limit. Please try again later.",
  "Usage limit reached for your Claude subscription",
]) {
  test(`429: "${wording.slice(0, 24)}…" cools only that account, keeps its grant and recovers later`, async () => {
    const { key, connections } = await pool();
    let limited = true;
    const seen = install({
      messages: (account) =>
        account === "access-1" && limited
          ? upstreamError(429, "rate_limit_error", wording, { "retry-after": "120" })
          : ok(`answer ${account}`),
    });
    const first = await call(key.key);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /answer access-2/);
    const cooled = await state(connections[0].id);
    assert.equal(cooled.isActive, true);
    assert.equal(cooled.cooling, true);
    assert.equal(cooled.refreshToken, "refresh-1");
    assert.deepEqual(seen.tokens(), []);

    // While A cools, a new turn goes straight to B without touching A again.
    const beforeSecond = seen.messages().length;
    const second = await call(key.key, body(false, [{ role: "user", content: "second turn" }]));
    assert.equal(second.status, 200);
    await second.text();
    assert.deepEqual(order(seen.messages()), ["access-1", "access-2"]);
    assert.deepEqual(seen.messages().slice(beforeSecond), ["access-2"]);
    assert.ok(seen.messages().filter((account) => account === "access-1").length <= 3);

    // After the usage window A is eligible again and a success clears its temporary state.
    limited = false;
    quotaCache.__clearForTests();
    await db.updateProviderConnection(connections[0].id, {
      rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const third = await call(key.key, body(false, [{ role: "user", content: "third turn" }]));
    assert.match(await third.text(), /answer access-1/);
    const recovered = await state(connections[0].id);
    assert.equal(recovered.cooling, false);
    assert.equal(recovered.testStatus, "active");
  });
}

test("429: all three accounts limited reports a temporary wait, never re-authentication", async () => {
  const { key, connections } = await pool();
  const seen = install({
    messages: () =>
      upstreamError(
        429,
        "rate_limit_error",
        "This request would exceed your account's rate limit. Please try again later.",
        { "retry-after": "300" }
      ),
  });
  const response = await call(key.key);
  const error = await response.json();
  assert.equal(response.status, 429);
  assert.deepEqual(order(seen.messages()), ["access-1", "access-2", "access-3"]);
  assert.equal(error.continuity.attempts, 3);
  assert.match(error.continuity.recovery, /Wait for the account usage reset/);
  assert.doesNotMatch(error.continuity.recovery, /Re-authenticate/);
  assert.equal(response.headers.get("x-should-retry"), "false");
  for (const connection of connections) {
    const row = await state(connection.id);
    assert.equal(row.isActive, true);
    assert.equal(row.cooling, true);
    assert.notEqual(row.testStatus, "expired");
  }
  assert.deepEqual(seen.tokens(), []);

  // While the pool cools no upstream call is made and the wait is announced.
  const dispatched = seen.messages().length;
  const waiting = await call(key.key, body(false, [{ role: "user", content: "retry" }]));
  const waitingError = await waiting.json();
  assert.equal(waiting.status, 429);
  assert.equal(seen.messages().length, dispatched);
  assert.ok(Number(waiting.headers.get("Retry-After")) > 0);
  assert.ok(Date.parse(waitingError.continuity.retry_after_at) > Date.now());
});

// ── Expiration ───────────────────────────────────────────────────────────────

test("expiration: an expired access credential is renewed before dispatch", async () => {
  const { key, connections } = await pool({ 1: new Date(Date.now() - HOUR).toISOString() });
  const seen = install({ messages: (account) => ok(`answer ${account}`), token: tokenOk });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer rotated-refresh-1/);
  assert.deepEqual(seen.messages(), ["rotated-refresh-1"]);
  assert.deepEqual(seen.tokens(), ["refresh-1"]);
  const a = await state(connections[0].id);
  assert.equal(a.accessToken, "rotated-refresh-1");
  assert.equal(a.refreshToken, "next-refresh-1");
});

test("expiration: an expired grant removes only that account and B answers", async () => {
  const { key, connections } = await pool({ 1: new Date(Date.now() - HOUR).toISOString() });
  const seen = install({
    messages: (account) =>
      account === "access-1"
        ? upstreamError(401, "authentication_error", "OAuth token has expired")
        : ok(`answer ${account}`),
    token: tokenRejected,
  });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer access-2/);
  assert.equal(seen.messages().at(-1), "access-2");
  assert.ok(seen.tokens().every((token) => token === "refresh-1"));
  const a = await state(connections[0].id);
  assert.equal(a.isActive, false);
  assert.equal(a.refreshToken, "refresh-1");
  const b = await state(connections[1].id);
  assert.equal(b.isActive, true);
});

for (const outage of ["network", "server-error", "rate-limited"] as const) {
  test(`expiration: a renewal endpoint ${outage} outage is temporary and the account renews later`, async () => {
    const { key, connections } = await pool({ 1: new Date(Date.now() - HOUR).toISOString() });
    let renewalAvailable = false;
    const seen = install({
      messages: (account) =>
        account === "access-1"
          ? upstreamError(401, "authentication_error", "OAuth token has expired")
          : ok(`answer ${account}`),
      token: (refreshToken) => {
        if (renewalAvailable) return tokenOk(refreshToken);
        if (outage === "network") throw connectionReset();
        return upstreamError(
          outage === "server-error" ? 503 : 429,
          outage === "server-error" ? "api_error" : "rate_limit_error",
          "synthetic renewal outage"
        );
      },
    });
    const response = await call(key.key);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /answer access-2/);
    assert.deepEqual(order(seen.messages()), ["access-1", "access-2"]);
    const cooled = await state(connections[0].id);
    assert.equal(cooled.isActive, true, "an unreachable renewal is not proof of a dead grant");
    assert.notEqual(cooled.testStatus, "expired");
    assert.equal(cooled.cooling, true);
    assert.equal(cooled.refreshToken, "refresh-1");

    // Once the endpoint answers again the same account renews and returns to priority 1.
    renewalAvailable = true;
    await db.updateProviderConnection(connections[0].id, {
      rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const later = await call(key.key, body(false, [{ role: "user", content: "later turn" }]));
    assert.equal(later.status, 200);
    assert.match(await later.text(), /answer rotated-refresh-1/);
    const renewed = await state(connections[0].id);
    assert.equal(renewed.accessToken, "rotated-refresh-1");
    assert.equal(renewed.refreshToken, "next-refresh-1");
    assert.equal(renewed.testStatus, "active");
  });
}

test("expiration: a renewal outage on every account asks to retry, never to re-authenticate", async () => {
  const past = new Date(Date.now() - HOUR).toISOString();
  const { key, connections } = await pool({ 1: past, 2: past, 3: past });
  const seen = install({
    messages: () => upstreamError(401, "authentication_error", "OAuth token has expired"),
    token: () => upstreamError(503, "api_error", "synthetic renewal outage"),
  });
  const response = await call(key.key);
  const error = await response.json();
  assert.equal(response.status, 503);
  assert.deepEqual(order(seen.messages()), ["access-1", "access-2", "access-3"]);
  assert.equal(error.error.code, "upstream_accounts_unavailable");
  assert.equal(error.continuity.attempts, 3);
  assert.doesNotMatch(error.continuity.recovery, /Re-authenticate/);
  assert.doesNotMatch(error.error.message, /Re-authenticate/);
  for (const [index, connection] of connections.entries()) {
    const row = await state(connection.id);
    assert.equal(row.isActive, true);
    assert.notEqual(row.testStatus, "expired");
    assert.equal(row.refreshToken, `refresh-${index + 1}`);
  }
});

test("expiration: concurrent requests sharing one renewal outage all leave the account recoverable", async () => {
  const { connections } = await pool();
  // One authorized account, so every concurrent request awaits the same renewal.
  const only = await h.seedApiKey({ name: "only-A", allowedConnections: [connections[0].id] });
  const seen = install({
    messages: () => upstreamError(401, "authentication_error", "OAuth token has expired"),
    token: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return upstreamError(503, "api_error", "synthetic renewal outage");
    },
  });
  const responses = await Promise.all(
    [1, 2, 3].map((turn) =>
      call(only.key, body(false, [{ role: "user", content: `concurrent ${turn}` }]))
    )
  );
  for (const response of responses) {
    const error = await response.json();
    assert.equal(response.status, 503);
    assert.doesNotMatch(error.error.message, /Re-authenticate/);
  }
  // Fewer renewal requests than three independent requests would make proves sharing.
  assert.ok(seen.tokens().length < 9, `renewals: ${seen.tokens().length}`);
  const a = await state(connections[0].id);
  assert.equal(a.isActive, true);
  assert.notEqual(a.testStatus, "expired");
  assert.equal(a.cooling, true);
  assert.equal(a.refreshToken, "refresh-1");
});

test("expiration: a request that joins an in-flight renewal receives its outcome", async () => {
  const { connections } = await pool({ 1: new Date(Date.now() - HOUR).toISOString() });
  const { getAccessToken } = await import("../../open-sse/services/tokenRefresh.ts");
  const { withRenewalOutcome } =
    await import("../../open-sse/services/tokenRefresh/renewalOutcome.ts");
  let answer = () => upstreamError(503, "api_error", "synthetic renewal outage");
  const seen = install({
    messages: () => ok("unused"),
    token: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return answer();
    },
  });
  const credentials = {
    connectionId: connections[0].id,
    accessToken: `access-${tag}-1`,
    refreshToken: `refresh-${tag}-1`,
    expiresAt: new Date(Date.now() - HOUR).toISOString(),
  };
  const renewTwice = async (initial: boolean) => {
    const owner = { unreachable: initial };
    const joiner = { unreachable: initial };
    const first = withRenewalOutcome(owner, getAccessToken)("claude", { ...credentials }, null);
    const second = withRenewalOutcome(joiner, getAccessToken)("claude", { ...credentials }, null);
    await Promise.all([first, second]);
    return { owner, joiner };
  };

  // An outage reaches both requests although only one renewal request was made.
  const outage = await renewTwice(false);
  assert.deepEqual(seen.tokens(), ["refresh-1"]);
  assert.deepEqual(outage, { owner: { unreachable: true }, joiner: { unreachable: true } });

  // So does a definite rejection: neither request may treat it as temporary.
  answer = () =>
    new Response(JSON.stringify({ error: "invalid_client" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  const rejected = await renewTwice(true);
  assert.equal(seen.tokens().length, 2);
  assert.deepEqual(rejected, { owner: { unreachable: false }, joiner: { unreachable: false } });
});

test("expiration: a renewal outage never opens the provider breaker or blocks recovery", async () => {
  const past = new Date(Date.now() - HOUR).toISOString();
  const { key, connections } = await pool({ 1: past, 2: past, 3: past });
  let renewalAvailable = false;
  const seen = install({
    messages: (account) =>
      account.startsWith("access-")
        ? upstreamError(401, "authentication_error", "OAuth token has expired")
        : ok(`answer ${account}`),
    token: (refreshToken) =>
      renewalAvailable
        ? tokenOk(refreshToken)
        : upstreamError(503, "api_error", "synthetic renewal outage"),
  });
  await (await call(key.key)).text();
  // More requests than any provider breaker threshold while the outage lasts.
  for (let request = 0; request < 16; request++) {
    const waiting = await call(
      key.key,
      body(false, [{ role: "user", content: `wait ${request}` }])
    );
    const error = await waiting.json();
    assert.equal(error.error.code, "upstream_accounts_unavailable");
    assert.doesNotMatch(error.error.message, /circuit breaker|Re-authenticate/);
  }
  assert.ok(seen.tokens().length > 0);

  renewalAvailable = true;
  for (const connection of connections)
    await db.updateProviderConnection(connection.id, {
      rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
    });
  const recovered = await call(key.key, body(false, [{ role: "user", content: "recovered" }]));
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /answer rotated-refresh-1/);
});

for (const answer of [
  { status: 401, code: "invalid_client", renewals: 3 },
  { status: 403, code: "access_denied", renewals: 3 },
  { status: 400, code: "unsupported_grant_type", renewals: 3 },
  { status: 400, code: "invalid_request", renewals: 1 },
]) {
  test(`expiration: a definite ${answer.status} ${answer.code} from the renewal endpoint stays terminal`, async () => {
    const { key, connections } = await pool();
    const seen = install({
      messages: (account) =>
        account === "access-1"
          ? upstreamError(401, "authentication_error", "OAuth token has expired")
          : ok(`answer ${account}`),
      token: () =>
        new Response(JSON.stringify({ error: answer.code }), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        }),
    });
    const response = await call(key.key);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /answer access-2/);
    assert.equal(seen.tokens().length, answer.renewals);
    const a = await state(connections[0].id);
    assert.equal(a.testStatus, "expired");
    assert.equal(a.cooling, false);
    assert.equal(a.refreshToken, "refresh-1");
  });
}

test("expiration: an open renewal circuit breaker keeps the account recoverable", async () => {
  const { key, connections } = await pool();
  for (let failure = 0; failure < 5; failure++) {
    await refreshBreaker.refreshWithRetry(async () => null, 1, null, "claude");
  }
  assert.equal(refreshBreaker.isProviderBlocked("claude"), true);
  const seen = install({
    messages: (account) =>
      account === "access-1"
        ? upstreamError(401, "authentication_error", "OAuth token has expired")
        : ok(`answer ${account}`),
    token: tokenOk,
  });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer access-2/);
  assert.deepEqual(seen.messages(), ["access-1", "access-2"]);
  assert.deepEqual(seen.tokens(), []);
  const a = await state(connections[0].id);
  assert.equal(a.isActive, true);
  assert.notEqual(a.testStatus, "expired");
  assert.equal(a.cooling, true);
  assert.equal(a.refreshToken, "refresh-1");
});

test("expiration: a renewed credential that is still rejected stays terminal", async () => {
  const { key, connections } = await pool();
  const seen = install({
    messages: (account) =>
      account.endsWith("-1")
        ? upstreamError(401, "authentication_error", "Invalid bearer token")
        : ok(`answer ${account}`),
    token: tokenOk,
  });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer access-2/);
  assert.deepEqual(seen.messages(), ["access-1", "rotated-refresh-1", "access-2"]);
  const a = await state(connections[0].id);
  assert.equal(a.testStatus, "expired");
  assert.equal(a.cooling, false);
});

// ── Timeout ──────────────────────────────────────────────────────────────────

test("timeout: the gateway's own response deadline is reported without cooling a healthy account", async () => {
  const { key, connections } = await pool();
  let stalled = true;
  const seen = install({
    messages: (account, init) => (stalled ? hang(init) : ok(`answer ${account}`)),
  });
  const response = await call(key.key);
  await response.text();
  // A response deadline is not an account fault: one bounded retry on the same
  // account, then the timeout is reported. No sibling replays a slow request.
  assert.equal(response.status, 504);
  assert.deepEqual(seen.messages(), ["access-1", "access-1"]);
  const a = await state(connections[0].id);
  assert.equal(a.isActive, true);
  assert.equal(a.cooling, false);
  assert.notEqual(a.testStatus, "expired");
  assert.deepEqual(seen.tokens(), []);

  stalled = false;
  const next = await call(key.key, body(false, [{ role: "user", content: "client retry" }]));
  assert.equal(next.status, 200);
  assert.match(await next.text(), /answer access-1/);
});

test("timeout: a stream that only pings fails over before any output reaches the client", async () => {
  const { key, connections } = await pool();
  const seen = install({
    messages: (account, init) => {
      if (account !== "access-1") return sse("valid B");
      const signal = init.signal as AbortSignal | undefined;
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream({
          start(controller) {
            const ping = () => {
              try {
                controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
              } catch {
                clearInterval(timer);
              }
            };
            ping();
            timer = setInterval(ping, 100);
            signal?.addEventListener("abort", () => clearInterval(timer), { once: true });
          },
          cancel() {
            clearInterval(timer);
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    },
  });
  const response = await call(key.key, body(true));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /valid B/);
  assert.deepEqual(seen.messages(), ["access-1", "access-2"]);
  const a = await state(connections[0].id);
  assert.equal(a.isActive, true);
});

// ── Reconnection ─────────────────────────────────────────────────────────────

test("reconnection: a reset connection to A is retried and then yields to B", async () => {
  const { key, connections } = await pool();
  const seen = install({
    messages: (account) => {
      if (account === "access-1") throw connectionReset();
      return ok(`answer ${account}`);
    },
  });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer access-2/);
  assert.equal(seen.messages().at(-1), "access-2");
  assert.ok(!seen.messages().includes("access-3"));
  const a = await state(connections[0].id);
  assert.equal(a.isActive, true);
  assert.equal(a.refreshToken, "refresh-1");
});

test("reconnection: a transient reset recovers on the same account without leaving the pool", async () => {
  const { key } = await pool();
  const seen = install({
    messages: (account, _init, nth) => {
      if (account === "access-1" && nth === 1) throw connectionReset();
      return ok(`answer ${account}`);
    },
  });
  const response = await call(key.key);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /answer access-1/);
  assert.deepEqual(new Set(seen.messages()), new Set(["access-1"]));
});

test("reconnection: the next turn carries the whole conversation to the account that took over", async () => {
  const { key } = await pool();
  const history = [
    { role: "user", content: "lookup" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_prior", name: "lookup", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_prior", content: "already executed" }],
    },
  ];
  const received: unknown[] = [];
  const seen = install({
    messages: (account, init) => {
      if (account === "access-1")
        return upstreamError(429, "rate_limit_error", "Usage limit reached", {
          "retry-after": "600",
        });
      received.push(JSON.parse(String(init.body)).messages);
      return ok(`answer ${account}`);
    },
  });
  await (await call(key.key, body(false, history.slice(0, 1)))).text();
  const resumed = await call(key.key, body(false, history));
  assert.equal(resumed.status, 200);
  await resumed.text();
  assert.deepEqual(order(seen.messages()), ["access-1", "access-2"]);
  assert.equal(seen.messages().at(-1), "access-2");
  assert.deepEqual(received[1], history);
});
