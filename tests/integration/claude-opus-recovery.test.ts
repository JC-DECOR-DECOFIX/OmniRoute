import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const SOL = "gpt-6.2-sol";
const TARGET = `codex/${SOL}`;
const OPUS = "claude-opus-5-5";
process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
const h = await createChatPipelineHarness("claude-opus-recovery");
const { updateApiKeyPermissions } = await import("../../src/lib/db/apiKeys.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const { getProviderConnectionById } = await import("../../src/lib/db/providers.ts");
const { clearAllModelLockouts, getModelLockoutInfo } =
  await import("../../open-sse/services/accountFallback.ts");
const { setQuotaCache } = await import("../../src/domain/quotaCache.ts");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.ts");
const { runAuthzPipeline } = await import("../../src/server/authz/pipeline.ts");
const { getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const { getUsageHistory } = await import("../../src/lib/usage/usageHistory.ts");
const { logger } = await import("../../src/shared/utils/logger.ts");
const { symbols } = await import("pino");
const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
test.beforeEach(async () => {
  await h.resetStorage();
  process.env.OMNIROUTE_CLAUDE_TERMINAL_FALLBACK = TARGET;
});
test.after(() => h.cleanup());

async function pool(models = ["claude/*", TARGET], catalog = true) {
  const connections = [];
  for (const account of ["A", "B", "C"]) {
    connections.push(
      await h.seedConnection("claude", {
        name: `terminal-${account}`,
        apiKey: account,
        priority: connections.length + 1,
      })
    );
  }
  const codex = await h.seedConnection("codex", { apiKey: "synthetic-codex" });
  if (catalog) {
    await replaceSyncedAvailableModelsForConnection("codex", codex.id, [
      {
        id: SOL,
        name: "GPT-6.2 Sol",
        source: "imported",
        supportedEndpoints: ["responses"],
        inputTokenLimit: 500000,
      },
    ]);
  }
  const key = await h.seedApiKey({
    allowedModels: models,
    allowedConnections: [...connections.map((c) => c.id), codex.id],
  });
  await updateApiKeyPermissions(key.id, { modelAccessMode: "restricted" });
  h.BaseExecutor.RETRY_CONFIG.delayMs = 5;
  return { connections, codex, key };
}

function messages(model = OPUS, extra: Record<string, unknown> = {}) {
  return {
    model: `claude/${model}`,
    max_tokens: 100,
    messages: [{ role: "user", content: "look it up" }],
    ...extra,
  };
}

async function call(
  key: string,
  body = messages(),
  headers: Record<string, string> = {},
  signal?: AbortSignal
) {
  const fixture = h.buildRequest({
    url: "http://localhost/v1/messages",
    authKey: key,
    body,
    headers: { "anthropic-version": "2023-06-01", ...headers },
  });
  const request = new NextRequest(fixture.url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: fixture.headers,
    signal,
  });
  const auth = await runAuthzPipeline(request, { enforce: true });
  if (auth && !auth.headers.get("x-middleware-next")) return auth;
  return h.handleChat(request);
}

function upstreamError(status: number) {
  const [type, message] =
    status === 429
      ? [
          "rate_limit_error",
          "This request would exceed your account's rate limit. Please try again later.",
        ]
      : status === 401
        ? ["authentication_error", "Invalid upstream token"]
        : status === 400
          ? ["invalid_request_error", "Tool reference not found in available tools"]
          : ["api_error", "Upstream failed"];
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function claudeSse(model: string, complete = true) {
  return events([
    {
      type: "message_start",
      message: {
        id: "msg_claude",
        role: "assistant",
        type: "message",
        model,
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Claude answered" },
    },
    ...(complete
      ? [
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]
      : []),
  ]);
}

function claudeJson(model: string) {
  return Response.json({
    id: "msg_claude",
    role: "assistant",
    type: "message",
    model,
    content: [{ type: "text", text: "Claude answered" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 3 },
  });
}

function events(entries: Record<string, unknown>[]) {
  return new Response(
    entries.map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

function codexSse(tool = false, toolName = "lookup", toolArgs = '{"key":"x"}') {
  const output = tool
    ? {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: toolName,
        arguments: toolArgs,
      }
    : {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Sol answered" }],
      };
  return events([
    { type: "response.created", response: { id: "resp_1", model: SOL, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "synthetic-encrypted",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "must not be replayed" }],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...output, ...(tool ? { arguments: "" } : { content: [] }) },
    },
    tool
      ? {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          item_id: "fc_1",
          delta: toolArgs,
        }
      : {
          type: "response.output_text.delta",
          output_index: 1,
          content_index: 0,
          item_id: "msg_1",
          delta: "Sol answered",
        },
    { type: "response.output_item.done", output_index: 1, item: output },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        model: SOL,
        status: "completed",
        output: [output],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 10 },
        },
      },
    },
  ]);
}

type UpstreamRequest = {
  account: string;
  body: Record<string, unknown>;
  model: string;
  signal?: AbortSignal | null;
};
function mockUpstream(respond: (request: UpstreamRequest) => Response | Promise<Response>) {
  const calls: UpstreamRequest[] = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/(?:api\.anthropic\.com|chatgpt\.com)\//);
    const headers = h.toPlainHeaders(init?.headers);
    const body = JSON.parse(String(init?.body));
    const call = {
      account: String(url).includes("chatgpt.com")
        ? "Codex"
        : (headers["x-api-key"] ?? headers.authorization?.replace(/^Bearer /i, "")),
      body,
      model: body.model,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
  return calls;
}

async function opusCooldownFixture(t: TestContext) {
  const {
    key,
    connections: [a, b, c],
  } = await pool();
  await h.seedConnection("claude", { name: "unauthorized-healthy", apiKey: "outside-pool" });
  const when = (time: string) => new Date(`2026-11-20T${time}Z`);
  t.mock.timers.enable({ apis: ["Date"], now: when("13:25:47.000") });
  t.after(() => clearAllModelLockouts());
  const weeklyReset = "2026-11-22T15:00:00.000Z";
  for (const account of [a, b]) {
    setQuotaCache(account.id, "claude", {
      "session (5h)": { remainingPercentage: 0, resetAt: "2026-11-20T15:00:00.000Z" },
      "weekly (7d)": { remainingPercentage: 0, resetAt: weeklyReset },
    });
  }
  setQuotaCache(c.id, "claude", {
    "session (5h)": { remainingPercentage: 2, resetAt: "2026-11-20T14:00:00.000Z" },
    "weekly (7d)": { remainingPercentage: 5, resetAt: weeklyReset },
  });
  t.mock.timers.setTime(when("13:26:41.617").getTime());
  // Replay the 429 recorded at 13:26:41.608Z using the actual cooldown writer.
  const cooldown = await markAccountUnavailable(
    c.id,
    429,
    "This request would exceed your account's rate limit. Please try again later.",
    "claude",
    OPUS,
    null,
    { confirmedClaude429: true }
  );
  assert.equal(cooldown.cooldownMs, 3_600_000);
  t.mock.timers.setTime(when("13:30:02.646").getTime());
  setQuotaCache(c.id, "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 100, resetAt: "2026-11-22T15:00:00.001Z" },
  });
  const sent = mockUpstream(({ account, model }) => {
    if (account === "Codex") return codexSse();
    assert.equal(account, "C");
    return claudeJson(model);
  });
  return { key, c, sent, advance: (time: string) => t.mock.timers.setTime(when(time).getTime()) };
}

async function recoverableOpusFixture(
  t: TestContext,
  first429 = () => upstreamError(429),
  oauth = false
) {
  const {
    key,
    connections: [a, b, c],
  } = await pool();
  await h.seedConnection("claude", { name: "unauthorized-healthy", apiKey: "outside-pool" });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T13:26:41.617Z") });
  t.after(() => clearAllModelLockouts());
  const time = (value: string) => t.mock.timers.setTime(Date.parse(`2026-11-20T${value}Z`));
  if (oauth) {
    await updateProviderConnection(c.id, {
      authType: "oauth",
      apiKey: null,
      accessToken: "C",
      expiresAt: "2026-11-20T16:00:00Z",
    });
  }
  for (const account of [a, b]) {
    setQuotaCache(account.id, "claude", {
      "session (5h)": { remainingPercentage: 0, resetAt: "2026-11-20T15:00:00Z" },
      "weekly (7d)": { remainingPercentage: 0, resetAt: "2026-11-22T15:00:00Z" },
    });
  }
  const initial = mockUpstream(first429);
  const limited = await call(key.key);
  assert.equal(limited.status, 429);
  await limited.text();
  assert.deepEqual(
    initial.map(({ account }) => account),
    ["C", "C", "C"]
  );
  return { key, a, b, c, time };
}

function observeOpusHeadroom(connectionId: string, windows: Record<string, unknown> = {}) {
  setQuotaCache(connectionId, "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 100, resetAt: "2026-11-22T15:00:00Z" },
    ...windows,
  });
}

test("Opus recovery: one isolated 429 cannot keep an authorized Opus account idle for an hour", async (t) => {
  const { key, c, time } = await recoverableOpusFixture(t, () => {
    const response = upstreamError(429);
    response.headers.set("anthropic-ratelimit-unified-reset", "2026-11-22T15:00:00Z");
    response.headers.set("anthropic-ratelimit-unified-status", "allowed");
    response.headers.set("anthropic-ratelimit-unified-7d-reset", "2026-11-22T15:00:00Z");
    response.headers.set("anthropic-ratelimit-unified-7d-status", "allowed");
    response.headers.set("anthropic-ratelimit-unified-7d-utilization", "0.95");
    return response;
  });
  assert.equal(getModelLockoutInfo("claude", c.id, OPUS)?.remainingMs, 3_600_000);
  time("13:30:02.646");
  observeOpusHeadroom(c.id);
  const sent = mockUpstream(({ model }) => claudeJson(model));
  time("13:34:09.400");
  const recovered = await call(key.key);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).model, OPUS);
  assert.deepEqual(
    sent.map(({ account, model }) => `${account}/${model}`),
    [`C/${OPUS}`]
  );
  assert.equal(getModelLockoutInfo("claude", c.id, OPUS), null);
});

for (const elapsedMs of [120_000, 240_000]) {
  test(`Opus recovery: policy allows one request after ${elapsedMs / 1000}s independently of the incident`, async (t) => {
    const { key, c } = await recoverableOpusFixture(t);
    const lockedAt = Date.now();
    t.mock.timers.setTime(lockedAt + 60_000);
    observeOpusHeadroom(c.id);
    const sent = mockUpstream(({ model }) => claudeJson(model));
    t.mock.timers.setTime(lockedAt + 119_999);
    const early = await call(key.key);
    assert.equal(early.status, 429);
    await early.text();
    assert.deepEqual(sent, []);
    t.mock.timers.setTime(lockedAt + elapsedMs);
    const response = await call(key.key);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(
      sent.map(({ account, model }) => `${account}/${model}`),
      [`C/${OPUS}`]
    );
  });
}

test("Opus recovery: credits exhausted is terminal even when a 429 supplies Retry-After", async () => {
  const {
    connections: [account],
  } = await pool();
  const outcome = await markAccountUnavailable(
    account.id,
    429,
    "Credits exhausted",
    "claude",
    OPUS,
    null,
    { confirmedClaude429: true, claudeRetryAt: Date.now() + 7_200_000, allowOpusRecovery: true }
  );
  const row = await getProviderConnectionById(account.id);
  assert.equal(outcome.cooldownMs, 0);
  assert.equal(row?.testStatus, "credits_exhausted");
  assert.equal(row?.rateLimitedUntil ?? null, null);
  assert.equal(getModelLockoutInfo("claude", account.id, OPUS), null);
});

for (const name of [
  "Retry-After",
  "reset header",
  "quota exhausted",
  "unknown snapshot",
  "stale snapshot",
  "pin",
  "managed lease",
  "abort",
  "breaker",
] as const) {
  test(`Opus recovery: ${name} prohibits the recovery request`, async (t) => {
    const { key, c, time } = await recoverableOpusFixture(t, () => {
      const response = upstreamError(429);
      if (name === "Retry-After") response.headers.set("Retry-After", "7200");
      if (name === "reset header") {
        response.headers.set("anthropic-ratelimit-unified-status", "rejected");
        response.headers.set(
          "anthropic-ratelimit-unified-reset",
          String(Date.parse("2026-11-20T15:26:41Z") / 1000)
        );
      }
      return response;
    });
    if (name === "stale snapshot") time("13:28:00.000");
    else time("13:34:04.000");
    observeOpusHeadroom(
      c.id,
      name === "quota exhausted"
        ? {
            "weekly opus (7d)": { remainingPercentage: 0, resetAt: "2026-11-22T15:00:00Z" },
          }
        : name === "unknown snapshot"
          ? {
              "session (5h)": { remainingPercentage: 100, fractionReported: false },
            }
          : {}
    );
    time("13:35:01.000");
    if (name === "managed lease") {
      await h.apiKeysDb.createApiKey("managed Opus fixture", "test", ["lease:exclusive"], {
        allowedConnections: [c.id],
      });
    }
    const controller = new AbortController();
    if (name === "abort") controller.abort();
    if (name === "breaker") getCircuitBreaker("claude", { failureThreshold: 1 })._onFailure();
    const sent = mockUpstream(() => assert.fail(`unexpected upstream with ${name}`));
    const response = await call(
      key.key,
      messages(),
      name === "pin" ? { "x-omniroute-connection": c.id } : {},
      controller.signal
    );
    assert.equal(response.status, name === "abort" ? 499 : name === "breaker" ? 503 : 429);
    const responseBody = await response.json();
    if (name === "Retry-After" || name === "reset header") {
      assert.match(responseBody.continuity.retry_after_at, /T15:00:00|T15:26:41/);
      assert.ok((getModelLockoutInfo("claude", c.id, OPUS)?.remainingMs ?? 0) > 100 * 60_000);
    }
    assert.deepEqual(sent, []);
  });
}

for (const status of [401, 403]) {
  test(`Opus recovery: ${status} from the one-shot request does not terminalize the account`, async (t) => {
    const { key, c, time } = await recoverableOpusFixture(t, undefined, true);
    time("13:30:02.646");
    observeOpusHeadroom(c.id);
    time("13:34:09.400");
    const sent = mockUpstream(() => upstreamError(status));
    const response = await call(key.key);
    assert.equal(response.status, status);
    await response.text();
    assert.deepEqual(
      sent.map(({ account }) => account),
      ["C"]
    );
    const account = await getProviderConnectionById(c.id);
    assert.equal(account?.testStatus, "active");
    assert.equal(account?.isActive, true);
    assert.ok((getModelLockoutInfo("claude", c.id, OPUS)?.remainingMs ?? 0) > 0);
  });
}

for (const expiry of [null, "2026-11-20T13:34:10Z"]) {
  test(`Opus recovery: an OAuth token with ${expiry ? "insufficient lead" : "unknown expiry"} does not dispatch`, async (t) => {
    const { key, c, time } = await recoverableOpusFixture(t, undefined, true);
    await updateProviderConnection(c.id, { expiresAt: expiry });
    time("13:30:02.646");
    observeOpusHeadroom(c.id);
    time("13:34:09.400");
    const sent = mockUpstream(() => assert.fail("ineligible OAuth token must not dispatch"));
    const response = await call(key.key);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).continuity.attempts, 0);
    assert.deepEqual(sent, []);
  });
}

test("Opus recovery: concurrent requests share one slot and a new 429 closes it", async (t) => {
  const { key, c, time } = await recoverableOpusFixture(t);
  time("13:34:04.000");
  observeOpusHeadroom(c.id);
  time("13:34:09.400");
  const racingKey = await h.seedApiKey({ name: "racing key", allowedConnections: [c.id] });
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const sent = mockUpstream(async () => {
    started.resolve();
    await finish.promise;
    return upstreamError(429);
  });
  const winningRequest = call(key.key);
  try {
    // Fail rather than hang if a regression keeps the first request from reaching the mock.
    assert.equal(
      await Promise.race([
        started.promise.then(() => "started"),
        winningRequest.then((r) => r.status),
      ]),
      "started"
    );
    const raced = await call(racingKey.key, messages(OPUS, { max_tokens: 101 }));
    assert.equal(raced.status, 429);
    assert.equal((await raced.json()).continuity.attempts, 0);
  } finally {
    finish.resolve();
  }
  const denied = await winningRequest;
  assert.equal(denied.status, 429);
  await denied.text();
  assert.deepEqual(
    sent.map(({ account }) => account),
    ["C"]
  );

  time("13:35:01.000");
  observeOpusHeadroom(c.id);
  const again = await call(key.key);
  assert.equal(again.status, 429);
  await again.text();
  assert.deepEqual(
    sent.map(({ account }) => account),
    ["C"]
  );
  assert.ok((getModelLockoutInfo("claude", c.id, OPUS)?.remainingMs ?? 0) > 0);
  time("13:43:02.000");
  observeOpusHeadroom(c.id);
  const wellAfterFloor = await call(key.key);
  assert.equal(wellAfterFloor.status, 429);
  await wellAfterFloor.text();
  assert.equal(sent.length, 1);
});

test("Opus recovery: normal eligible accounts retain priority", async (t) => {
  const { key, a, c, time } = await recoverableOpusFixture(t);
  time("13:34:04.000");
  observeOpusHeadroom(c.id);
  observeOpusHeadroom(a.id);
  time("13:35:01.000");
  const sent = mockUpstream(({ model }) => claudeJson(model));
  const response = await call(key.key);
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(
    sent.map(({ account }) => account),
    ["A"]
  );
});

test("Opus recovery: partial stream is not replayed or sent to Codex", async (t) => {
  const { key, c, time } = await recoverableOpusFixture(t);
  time("13:34:04.000");
  observeOpusHeadroom(c.id);
  time("13:35:01.000");
  const sent = mockUpstream(({ model }) => claudeSse(model, false));
  const response = await call(key.key, messages(OPUS, { stream: true }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Claude answered/);
  assert.match(text, /upstream_interrupted_error/);
  assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
  assert.deepEqual(
    sent.map(({ account }) => account),
    ["C"]
  );
});

test("Opus recovery: revoking the account while queued prevents sending and upstream metrics", async (t) => {
  const { key, a, c, time } = await recoverableOpusFixture(t);
  const semaphore = await import("../../open-sse/services/accountSemaphore.ts");
  const semaphoreKey = semaphore.buildAccountSemaphoreKey({ provider: "claude", accountKey: c.id });
  await updateProviderConnection(c.id, { maxConcurrent: 1 });
  time("13:34:04.000");
  observeOpusHeadroom(c.id);
  time("13:35:01.000");
  const before = await getUsageHistory({ provider: "claude", model: OPUS });
  const release = await semaphore.acquire(semaphoreKey, { maxConcurrency: 1 });
  const sent = mockUpstream(() => assert.fail("revoked account must not dispatch"));
  const request = call(key.key);
  try {
    for (let i = 0; i < 40 && !semaphore.getStats()[semaphoreKey]?.queued; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(semaphore.getStats()[semaphoreKey]?.queued, 1);
    await updateApiKeyPermissions(key.id, { allowedConnections: [a.id] });
  } finally {
    release();
  }
  const response = await request;
  assert.equal(response.status, 503);
  await response.text();
  assert.deepEqual(sent, []);
  assert.deepEqual(await getUsageHistory({ provider: "claude", model: OPUS }), before);
});

test("Opus cooldown: an ambiguous quota snapshot leaves the authorized pool locally blocked", async (t) => {
  process.env.OMNIROUTE_CLAUDE_TERMINAL_FALLBACK = "off";
  const { key, c, sent, advance } = await opusCooldownFixture(t);
  const haiku = "claude-haiku-5-5";
  advance("13:33:56.000");
  const haikuResponse = await call(key.key, messages(haiku));
  assert.equal(haikuResponse.status, 200);
  await haikuResponse.text();
  assert.ok((getModelLockoutInfo("claude", c.id, OPUS)?.remainingMs ?? 0) > 0);

  advance("13:34:09.400");
  const response = await call(key.key);
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.continuity.attempts, 0);
  assert.equal(body.continuity.local_status, 429);
  assert.equal(body.continuity.upstream_status, undefined);
  assert.equal(body.continuity.pool_eligible_at, "2026-11-20T14:26:41.617Z");
  assert.equal(body.continuity.retry_after_at, body.continuity.pool_eligible_at);
  assert.equal(response.headers.get("retry-after"), "3153");
  assert.deepEqual(
    sent.map(({ account, model }) => [account, model]),
    [["C", haiku]]
  );
  assert.deepEqual(await getCallLogs({ model: OPUS }), []);
  assert.deepEqual(await getUsageHistory({ provider: "claude", model: OPUS }), []);

  advance("14:26:41.618");
  const recovered = await call(key.key);
  assert.equal(recovered.status, 200);
  await recovered.text();
  assert.deepEqual(
    sent.map(({ account, model }) => [account, model]),
    [
      ["C", haiku],
      ["C", OPUS],
    ]
  );
});

for (const noLog of [false, true]) {
  test(`Opus cooldown: one confirmed 429 plus two cached quotas cannot prove terminal exhaustion (noLog=${noLog})`, async (t) => {
    const { key, sent, advance } = await opusCooldownFixture(t);
    if (noLog) await updateApiKeyPermissions(key.id, { noLog });
    const logLines: string[] = [];
    t.mock.method(logger[symbols.streamSym], "write", (line: string) => {
      logLines.push(line);
      return true;
    });
    advance("13:34:09.400");
    const response = await call(
      key.key,
      messages(OPUS, {
        messages: [{ role: "user", content: "synthetic-payload-not-for-logs" }],
      })
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
    assert.equal((await response.json()).continuity.attempts, 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(await getCallLogs({ model: OPUS }), []);
    assert.deepEqual(await getUsageHistory({ provider: "claude", model: OPUS }), []);
    const diagnostic = logLines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.msg === "Claude pool rejected before dispatch");
    if (noLog) {
      assert.equal(diagnostic, undefined);
    } else {
      assert.equal(diagnostic?.local_status, 429);
      assert.equal(diagnostic?.attempts, 0);
      assert.equal(diagnostic?.upstream_status, undefined);
    }
    assert.ok(logLines.every((line) => !line.includes("synthetic-payload-not-for-logs")));
  });
}

test("Opus cooldown: three confirmed model 429s remain proof until expiry", async (t) => {
  const { key } = await pool();
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T13:26:41Z") });
  t.after(() => clearAllModelLockouts());
  const first = mockUpstream(({ account }) =>
    account === "Codex" ? codexSse() : upstreamError(429)
  );
  const response = await call(key.key);
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual([...new Set(first.map(({ account }) => account))], ["A", "B", "C", "Codex"]);

  const second = mockUpstream(({ account }) =>
    account === "Codex" ? codexSse() : upstreamError(429)
  );
  const cached = await call(key.key);
  assert.equal(cached.status, 200);
  await cached.text();
  assert.deepEqual(
    second.map(({ account }) => account),
    ["Codex"]
  );

  t.mock.timers.setTime(Date.parse("2026-11-20T14:26:42Z"));
  const expired = mockUpstream(({ model }) => claudeJson(model));
  const recovered = await call(key.key);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).model, OPUS);
  assert.deepEqual(
    expired.map(({ account }) => account),
    ["A"]
  );
});

for (const blockedBy of ["abort", "open circuit"] as const) {
  test(`Opus cooldown: ${blockedBy} makes no upstream call`, async (t) => {
    const { key, sent, advance } = await opusCooldownFixture(t);
    advance("13:34:09.400");
    const controller = new AbortController();
    if (blockedBy === "abort") {
      controller.abort();
    } else {
      getCircuitBreaker("claude", { failureThreshold: 1 })._onFailure();
    }
    const response = await call(key.key, messages(), {}, controller.signal);
    assert.equal(response.status, blockedBy === "abort" ? 499 : 503);
    assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
    await response.text();
    assert.deepEqual(sent, []);
  });
}
