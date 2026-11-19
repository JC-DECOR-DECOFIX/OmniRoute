import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
const h = await createChatPipelineHarness("claude-continuity");
const { runAuthzPipeline } = await import("../../src/server/authz/pipeline.ts");
const model = "claude-3-5-sonnet-20241022";
test.beforeEach(() => h.resetStorage());
test.after(() => h.cleanup());

async function pool() {
  const connections = [];
  for (let n = 1; n <= 3; n++) {
    connections.push(
      await h.seedConnection("claude", {
        name: `account-${n}`,
        apiKey: `synthetic-${n}`,
        priority: n,
      })
    );
  }
  const key = await h.seedApiKey({ allowedConnections: connections.map((c) => c.id) });
  return { connections, key };
}
function body(stream = false) {
  return {
    model: `claude/${model}`,
    max_tokens: 40,
    stream,
    messages: [{ role: "user", content: "continuity" }],
  };
}
function sse(text: string, complete = true) {
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
  ];
  if (complete)
    events.push(
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    );
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}
async function call(
  key: string,
  requestBody: Record<string, unknown> = body(),
  headers: Record<string, string> = {}
) {
  const request = new NextRequest(
    h.buildRequest({
      url: "http://localhost/v1/messages",
      authKey: key,
      body: requestBody,
      headers,
    })
  );
  const auth = await runAuthzPipeline(request, { enforce: true });
  if (auth && !auth.headers.get("x-middleware-next")) return auth;
  return h.handleChat(request);
}

for (const failures of [1, 2, 3]) {
  test(`automatic pool: ${failures} unavailable account(s)`, async () => {
    const { key } = await pool();
    const attempts: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const account = h.toPlainHeaders(init?.headers)["x-api-key"];
      attempts.push(account);
      assert.equal(JSON.parse(String(init?.body)).model, model);
      return attempts.length <= failures
        ? new Response(
            JSON.stringify({
              error: { type: "authentication_error", message: "synthetic invalid credentials" },
            }),
            { status: 401 }
          )
        : h.buildClaudeResponse("valid next account", model);
    };
    const response = await call(key.key);
    const responseText = await response.text();
    assert.equal(response.status, failures < 3 ? 200 : 502);
    if (failures === 3) {
      const error = JSON.parse(responseText);
      assert.equal(response.headers.get("x-should-retry"), "false");
      assert.equal(error.error.code, "upstream_accounts_unavailable");
      assert.equal(error.continuity.upstream_status, 401);
      assert.match(error.error.message, /Claude upstream accounts unavailable/);
      assert.equal(error.continuity.attempts, 3);
      assert.match(error.continuity.recovery, /Re-authenticate/);
      assert.ok(
        error.continuity.attempted_connections.every((id: string) => /^[a-f0-9]{8}\.\.\.$/.test(id))
      );
    }
    assert.deepEqual(
      attempts,
      ["synthetic-1", "synthetic-2", "synthetic-3"].slice(0, Math.min(failures + 1, 3))
    );
  });
}

test("explicit fixed account in cooldown cannot silently use its sibling", async () => {
  const { key, connections } = await pool();
  const db = await import("../../src/lib/db/providers.ts");
  await db.updateProviderConnection(connections[0].id, {
    rateLimitedUntil: new Date(Date.now() + 3600000).toISOString(),
  });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return h.buildClaudeResponse("wrong account");
  };
  const response = await call(key.key, body(), { "x-omniroute-connection": connections[0].id });
  await response.text();
  assert.notEqual(response.status, 200);
  assert.equal(attempts, 0);
});

test("before useful stream output AUTO fails over A to B", async () => {
  const { key } = await pool();
  const attempts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const account = h.toPlainHeaders(init?.headers)["x-api-key"];
    attempts.push(account);
    return account === "synthetic-1"
      ? new Response("", { headers: { "content-type": "text/event-stream" } })
      : sse("valid B");
  };
  const response = await call(key.key, body(true));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(attempts, ["synthetic-1", "synthetic-2"]);
  assert.match(text, /valid B/);
});

test("after partial output signals recovery without dispatching B or synthesizing success", async () => {
  const { key } = await pool();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return sse("partial A", false);
  };
  const response = await call(key.key, body(true));
  const text = await response.text();
  assert.equal(attempts, 1);
  assert.match(text, /partial A/);
  assert.match(text, /event: error/);
  assert.match(text, /upstream_interrupted_error/);
  assert.match(text, /Resume explicitly from the preserved conversation context/);
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.doesNotMatch(text, /"stop_reason":"max_tokens"/);
  assert.ok(text.indexOf("event: error") < text.indexOf("event: message_stop"));
});

for (const continuity of [true, false]) {
  test(`upstream SSE error after useful output preserves cause and explicit recovery=${continuity}`, async () => {
    const { key } = await pool();
    process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = String(continuity);
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      const source =
        (await sse("partial A", false).text()) +
        'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"synthetic upstream stream failure"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';
      const bytes = new TextEncoder().encode(source);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    try {
      const response = await call(key.key, body(true));
      const text = await response.text();
      assert.equal(attempts, 1);
      assert.match(text, /partial A/);
      assert.match(text, /synthetic upstream stream failure/);
      if (continuity) {
        assert.match(text, /upstream_interrupted_error/);
        assert.match(text, /Resume explicitly from the preserved conversation context/);
        assert.equal(response.headers.get("x-should-retry"), "false");
      } else {
        assert.match(text, /api_error/);
        assert.doesNotMatch(text, /upstream_interrupted_error/);
      }
    } finally {
      process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
    }
  });
}

test("invalid gateway credentials do not reach any upstream account", async () => {
  await pool();
  process.env.REQUIRE_API_KEY = "true";
  await h.settingsDb.updateSettings({ requireApiKey: true });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("must not dispatch");
  };
  const response = await call("sk-invalidsynthetic");
  await response.text();
  assert.equal(response.status, 401);
  assert.notEqual(response.headers.get("x-omniroute-continuity-status"), "accounts-unavailable");
  assert.equal(attempts, 0);
  process.env.REQUIRE_API_KEY = "false";
});

test("tool_use and tool_result survive failover without executing a tool", async () => {
  const { key } = await pool();
  const requestBody = {
    ...body(),
    tools: [
      {
        name: "lookup",
        description: "Read a value",
        input_schema: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: "lookup" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_prior", name: "lookup", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_prior", content: "already executed" }],
      },
    ],
  };
  let attempts = 0;
  globalThis.fetch = async (_url, init) => {
    const upstream = JSON.parse(String(init?.body));
    assert.deepEqual(upstream.messages, requestBody.messages);
    assert.deepEqual(
      upstream.tools,
      requestBody.tools.map((tool) => ({ ...tool, type: "custom" }))
    );
    attempts++;
    if (attempts === 1)
      return new Response(JSON.stringify({ error: { message: "account unavailable" } }), {
        status: 401,
      });
    return new Response(
      JSON.stringify({
        id: "tool-response",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "tool_use", id: "toolu_next", name: "lookup", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  };
  const response = await call(key.key, requestBody);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(result.content[0].id, "toolu_next");
  assert.equal(result.stop_reason, "tool_use");
});

test("cache breakpoints reach the next account exactly as they reached the first", async () => {
  const { key } = await pool();
  const marker = { type: "ephemeral" };
  // Two cached system blocks and a marked mid-conversation system note: the gateway
  // lifts the note into `system` and re-anchors its breakpoint on the preceding turn.
  const requestBody = {
    ...body(),
    system: [
      { type: "text", text: "base prompt", cache_control: marker },
      { type: "text", text: "project prompt", cache_control: marker },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "turn 1" }] },
      { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      {
        role: "system",
        content: [{ type: "text", text: "mid-conversation note", cache_control: marker }],
      },
      { role: "user", content: [{ type: "text", text: "turn 2" }] },
    ],
  };
  const marked = (blocks: unknown) =>
    Array.isArray(blocks) ? blocks.filter((block) => block?.cache_control != null).length : 0;
  const sent: Array<{ breakpoints: number; messages: unknown; system: unknown }> = [];
  globalThis.fetch = async (_url, init) => {
    const upstream = JSON.parse(String(init?.body));
    const breakpoints =
      marked(upstream.system) +
      upstream.messages.reduce(
        (count: number, message: { content?: unknown }) => count + marked(message.content),
        0
      );
    sent.push({ breakpoints, messages: upstream.messages, system: upstream.system });
    // Anthropic rejects a fifth breakpoint; the first account is simply unavailable.
    if (breakpoints > 4)
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `A maximum of 4 blocks with cache_control may be provided. Found ${breakpoints}.`,
          },
        }),
        { status: 400 }
      );
    if (sent.length === 1)
      return new Response(JSON.stringify({ error: { message: "account unavailable" } }), {
        status: 401,
      });
    return h.buildClaudeResponse("valid B", model);
  };
  const response = await call(key.key, requestBody);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /valid B/);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].breakpoints <= 4);
  assert.deepEqual(sent[1], sent[0]);
});

test("temporary cooldown recovers eligibility after expiry and a successful request", async () => {
  const { key, connections } = await pool();
  const db = await import("../../src/lib/db/providers.ts");
  await db.updateProviderConnection(connections[0].id, {
    rateLimitedUntil: new Date(Date.now() + 3600000).toISOString(),
  });
  const attempts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    attempts.push(h.toPlainHeaders(init?.headers)["x-api-key"]);
    return h.buildClaudeResponse("ok", model);
  };
  await (await call(key.key)).text();
  await db.updateProviderConnection(connections[0].id, {
    rateLimitedUntil: new Date(Date.now() - 1000).toISOString(),
  });
  await (
    await call(key.key, {
      ...body(),
      messages: [{ role: "user", content: "new recovered request" }],
    })
  ).text();
  assert.deepEqual(attempts, ["synthetic-2", "synthetic-1"]);
});

test("an unauthorized healthy sibling is excluded from the pool", async () => {
  const { connections } = await pool();
  const key = await h.seedApiKey({ name: "only-A", allowedConnections: [connections[0].id] });
  const attempts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    attempts.push(h.toPlainHeaders(init?.headers)["x-api-key"]);
    return new Response(JSON.stringify({ error: { message: "invalid account" } }), { status: 401 });
  };
  await (await call(key.key)).text();
  assert.deepEqual(attempts, ["synthetic-1"]);
});

test("billing failure stays within Claude and preserves the requested model", async () => {
  const { key } = await pool();
  const attempts: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /anthropic/);
    assert.equal(JSON.parse(String(init?.body)).model, model);
    attempts.push(h.toPlainHeaders(init?.headers)["x-api-key"]);
    return attempts.length === 1
      ? new Response(JSON.stringify({ error: { message: "billing payment required" } }), {
          status: 402,
        })
      : h.buildClaudeResponse("B", model);
  };
  const response = await call(key.key);
  await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(attempts, ["synthetic-1", "synthetic-2"]);
});

test("a model-unavailable response tries B with the exact model instead of a family downgrade", async () => {
  const { key } = await pool();
  const requested = "claude-sonnet-4-6";
  const attempts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const upstream = JSON.parse(String(init?.body));
    attempts.push(upstream.model);
    return attempts.length === 1
      ? new Response(
          JSON.stringify({ error: { type: "not_found_error", message: "model not found" } }),
          { status: 404 }
        )
      : h.buildClaudeResponse("B exact model", requested);
  };
  const response = await call(key.key, { ...body(), model: `claude/${requested}` });
  await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(attempts, [requested, requested]);
});

test("partial tool output is never replayed against another account", async () => {
  const { key } = await pool();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    const events = [
      {
        type: "message_start",
        message: {
          id: "synthetic-tool",
          type: "message",
          role: "assistant",
          model,
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_partial", name: "lookup", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"value":' },
      },
    ];
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } }
    );
  };
  const response = await call(key.key, body(true));
  const text = await response.text();
  assert.equal(attempts, 1);
  assert.match(text, /toolu_partial/);
  assert.match(text, /event: error/);
  assert.doesNotMatch(text, /"stop_reason":"max_tokens"/);
});

for (const first of [
  "lifecycle-only",
  "authentication-error",
  "empty-text-then-authentication-error",
] as const) {
  test(`before useful output ${first} fails over without forwarding A`, async () => {
    const { key } = await pool();
    const attempts: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const account = h.toPlainHeaders(init?.headers)["x-api-key"];
      attempts.push(account);
      if (account !== "synthetic-1") return sse("valid B");
      const event =
        first === "lifecycle-only"
          ? {
              type: "message_start",
              message: {
                id: "not-useful",
                type: "message",
                role: "assistant",
                model,
                content: [],
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }
          : {
              type: "error",
              error: { type: "authentication_error", message: "synthetic account expired" },
            };
      const emptyText =
        first === "empty-text-then-authentication-error"
          ? 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
          : "";
      return new Response(`${emptyText}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const response = await call(key.key, body(true));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(attempts, ["synthetic-1", "synthetic-2"]);
    assert.match(text, /valid B/);
    assert.doesNotMatch(text, /not-useful|synthetic account expired/);
  });
}

for (const failure of [
  {
    message: "Your subscription does not include access to this model",
    recovery: /permissions and access to the requested model/,
  },
  {
    message: "Your Claude subscription has expired. Renew your subscription to continue.",
    recovery: /renew the Claude subscription/,
  },
  {
    message: "Permission denied for the requested model",
    recovery: /permissions and access to the requested model/,
  },
  {
    message: "Please contact support about the banned model",
    recovery: /permissions and access to the requested model/,
  },
  {
    message: "Your account is banned",
    recovery: /restriction with Anthropic support/,
  },
  {
    message: "Sua conta foi suspensa",
    recovery: /restriction with Anthropic support/,
  },
]) {
  test(`upstream 403 recovery distinguishes ${failure.message}`, async () => {
    const { key } = await pool();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { type: "permission_error", message: failure.message } }),
        { status: 403 }
      );
    const response = await call(key.key);
    const error = await response.json();
    assert.equal(response.status, 403);
    assert.match(error.continuity.recovery, failure.recovery);
    assert.doesNotMatch(error.continuity.recovery, /Re-authenticate/);
  });
}

test("temporary pool exhaustion preserves Retry-After and recovery time", async () => {
  const { key, connections } = await pool();
  const db = await import("../../src/lib/db/providers.ts");
  const reset = new Date(Date.now() + 60000).toISOString();
  for (const connection of connections)
    await db.updateProviderConnection(connection.id, {
      rateLimitedUntil: reset,
      errorCode: "429",
      testStatus: "unavailable",
      lastError: "Usage limit reached for your Claude subscription",
    });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("cooling accounts must not dispatch");
  };
  const response = await call(key.key);
  const error = await response.json();
  assert.equal(response.status, 429);
  assert.equal(attempts, 0);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.equal(error.continuity.retry_after_at, reset);
  assert.match(error.continuity.recovery, /Wait for the account usage reset/);
});

test("existing exhausted-credit state requests account billing recovery rather than OAuth", async () => {
  const { key, connections } = await pool();
  const db = await import("../../src/lib/db/providers.ts");
  for (const connection of connections)
    await db.updateProviderConnection(connection.id, {
      isActive: false,
      testStatus: "credits_exhausted",
    });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("inactive accounts must not dispatch");
  };
  const response = await call(key.key);
  const error = await response.json();
  assert.equal(response.status, 402);
  assert.equal(attempts, 0);
  assert.match(error.continuity.recovery, /billing and available credits/);
  assert.doesNotMatch(error.continuity.recovery, /Re-authenticate/);
});

test("an account restriction stays terminal and requests provider support", async () => {
  const { key, connections } = await pool();
  const db = await import("../../src/lib/db/providers.ts");
  for (const connection of connections)
    await db.updateProviderConnection(connection.id, { isActive: false, testStatus: "banned" });
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    throw new Error("restricted accounts must not dispatch");
  };
  const response = await call(key.key);
  const error = await response.json();
  assert.equal(response.status, 403);
  assert.equal(attempts, 0);
  assert.match(error.continuity.recovery, /restriction with Anthropic support/);
  assert.doesNotMatch(error.continuity.recovery, /Re-authenticate/);
});

test("native Claude Code model uses the restricted subscription pool without changing the model", async () => {
  const { key } = await pool();
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, {
    modelAccessMode: "restricted",
    allowedModels: ["claude/*"],
  });
  const nativeModel = "claude-haiku-5-5";
  const attempts: string[] = [];
  globalThis.fetch = async (_url, init) => {
    attempts.push(h.toPlainHeaders(init?.headers)["x-api-key"]);
    assert.equal(JSON.parse(String(init?.body)).model, nativeModel);
    return attempts.length === 1
      ? new Response(JSON.stringify({ error: { message: "invalid account credentials" } }), {
          status: 401,
        })
      : h.buildClaudeResponse("native valid B", nativeModel);
  };
  const response = await call(key.key, { ...body(), model: nativeModel });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /native valid B/);
  assert.deepEqual(attempts, ["synthetic-1", "synthetic-2"]);
});

test("native model with all Claude accounts inactive reports recovery even while Codex is active", async () => {
  const { connections, key } = await pool();
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
  await h.apiKeysDb.updateApiKeyPermissions(key.id, {
    modelAccessMode: "restricted",
    allowedModels: ["claude/*"],
  });
  const db = await import("../../src/lib/db/providers.ts");
  for (const connection of connections) {
    await db.updateProviderConnection(connection.id, { isActive: false, testStatus: "expired" });
  }
  await h.seedConnection("codex");
  globalThis.fetch = async () => {
    assert.fail("Unavailable subscription accounts must not dispatch another provider");
  };
  const nativeModel = "claude-haiku-5-5";
  const response = await call(key.key, { ...body(), model: nativeModel });
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.continuity.requested_model, nativeModel);
  assert.equal(error.continuity.provider, "claude");
  assert.equal(error.continuity.attempts, 0);
  assert.equal(error.continuity.upstream_status, 401);
  assert.equal(error.error.code, "upstream_accounts_unavailable");
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.match(error.continuity.recovery, /Re-authenticate/);

  const { getModelInfo } = await import("../../src/sse/services/model.ts");
  const explicit = await getModelInfo(`anthropic/${nativeModel}`);
  assert.equal(explicit.provider, "anthropic");
  assert.equal(explicit.model, nativeModel);
  try {
    for (const disabledValue of ["false", "1", "yes", "on", "TRUE"]) {
      process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = disabledValue;
      assert.notEqual((await getModelInfo(nativeModel)).provider, "claude", disabledValue);
    }
  } finally {
    process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
  }
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: false });
  assert.notEqual((await getModelInfo(nativeModel)).provider, "claude");
});

// ── Model fallback: Fable 5.2 → Opus 5.5 when the whole pool is rate-limited for Fable ─────────

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const RATE_LIMIT_WORDING =
  "This request would exceed your account's rate limit. Please try again later.";
const fallbackChain = await import("../../src/sse/handlers/claudeModelFallback.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

type UpstreamBody = {
  model: string;
  thinking?: { type?: string };
  messages: Array<{ role: string; content: Array<{ type: string }> }>;
  [field: string]: unknown;
};
type Sent = { account: string; model: string; body: UpstreamBody };
type LoggedCall = { status?: number; model?: string; requestedModel?: string | null };
/** Synthetic upstream that records which account received which model. */
function upstream(answer: (account: string, model: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  globalThis.fetch = async (_url, init) => {
    const account = h.toPlainHeaders(init?.headers)["x-api-key"];
    const upstreamBody = JSON.parse(String(init?.body));
    sent.push({ account, model: upstreamBody.model, body: upstreamBody });
    return answer(account, upstreamBody.model);
  };
  return sent;
}
/** model@account in dispatch order, with the executor's same-account 429 retries collapsed. */
function route(sent: Sent[]) {
  return sent
    .map((entry) => `${entry.model}@${entry.account}`)
    .filter((step, index, steps) => step !== steps[index - 1]);
}
function rateLimited(message = RATE_LIMIT_WORDING) {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }),
    { status: 429, headers: { "content-type": "application/json" } }
  );
}
function upstreamError(status: number, type: string, message: string) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
/** A Fable turn in the middle of a tool loop: signed thinking, tool_use, tool_result. */
function fableToolLoop(extra: Record<string, unknown> = {}) {
  return {
    model: `claude/${FABLE}`,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [
      {
        name: "lookup",
        description: "Read a value",
        input_schema: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: "look the value up" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I should call lookup.",
            signature: "c2lnbmVkLWJ5LWZhYmxl",
          },
          { type: "tool_use", id: "toolu_fable", name: "lookup", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_fable", content: "already executed" }],
      },
    ],
    ...extra,
  };
}
async function pooledFallback() {
  const pooled = await pool();
  h.BaseExecutor.RETRY_CONFIG.delayMs = 5;
  return pooled;
}

test("model fallback: chain parsing keeps only well-formed links and can be disabled", () => {
  const parse = fallbackChain.parseClaudeModelFallbackChain;
  assert.deepEqual([...parse(undefined)], [[FABLE, OPUS]]);
  assert.deepEqual(
    [...parse("a-1>b-2>c-3, x>y")],
    [
      ["a-1", "b-2"],
      ["b-2", "c-3"],
      ["x", "y"],
    ]
  );
  assert.deepEqual([...parse("a>a, bad model>y, >y, x>, x>y, x>z")], [["x", "y"]]);
  for (const disabled of ["", " ", "off", "none", "false", "0"])
    assert.equal(parse(disabled).size, 0);
});

test("model fallback: the adapted request drops only signed thinking and keeps the client's request", () => {
  const original = {
    model: `claude/${FABLE}`,
    max_tokens: 500000,
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "s" },
          { type: "text", text: "a" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "r" }] },
      { role: "assistant", content: "plain text answer" },
    ],
  };
  const snapshot = structuredClone(original);
  const adapted = fallbackChain.adaptRequestForFallbackModel(original, OPUS) as typeof original;
  assert.deepEqual(original, snapshot, "the client's request is not mutated");
  assert.equal(adapted.model, original.model);
  assert.equal(adapted.max_tokens, 128000);
  assert.deepEqual(adapted.messages, [
    original.messages[0],
    {
      role: "assistant",
      content: [original.messages[2].content[1], original.messages[2].content[2]],
    },
    original.messages[3],
    original.messages[4],
  ]);
});

test("model fallback: every account limited on Fable answers with Opus on the first account in priority", async () => {
  const { key } = await pooledFallback();
  const sent = upstream((_account, upstreamModel) =>
    upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("opus answer", OPUS)
  );
  const requestBody = fableToolLoop();
  const response = await call(key.key, requestBody);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /opus answer/);
  assert.equal(JSON.parse(text).model, OPUS);
  assert.deepEqual(route(sent), [
    `${FABLE}@synthetic-1`,
    `${FABLE}@synthetic-2`,
    `${FABLE}@synthetic-3`,
    `${OPUS}@synthetic-1`,
  ]);
  assert.equal(response.headers.get("X-OmniRoute-Effective-Model"), OPUS);
  assert.match(
    String(response.headers.get("X-OmniRoute-Model-Fallback")),
    /claude-fable-5-2>claude-opus-5-5/
  );

  // Opus receives the request Fable received, without Fable's signed thinking: the same
  // system, tools, thinking mode, tool_use and tool_result; only the model differs.
  const fable = sent.find((entry) => entry.model === FABLE)!.body;
  const opus = sent.find((entry) => entry.model === OPUS)!.body;
  assert.deepEqual(fable.messages[1].content[0], requestBody.messages[1].content[0]);
  const withoutThinking = structuredClone(fable);
  withoutThinking.messages[1].content = withoutThinking.messages[1].content.filter(
    (block: { type: string }) => block.type !== "thinking"
  );
  assert.deepEqual({ ...opus, model: "same" }, { ...withoutThinking, model: "same" });
  assert.deepEqual(opus.messages[1].content, [
    { type: "tool_use", id: "toolu_fable", name: "lookup", input: {} },
  ]);
  assert.equal(opus.thinking.type, "adaptive");

  // The call log keeps the model the client asked for next to the one that answered.
  const served = async () =>
    ((await callLogs.getCallLogs({ model: OPUS, limit: 5 })) as LoggedCall[]).find(
      (row) => row.status === 200
    );
  const logged = await h.waitFor(served);
  assert.ok(logged, "the Opus answer is in the call log");
  assert.equal(logged.model, OPUS);
  assert.equal(logged.requestedModel, `claude/${FABLE}`);
});

test("model fallback: while Fable cools down the next request goes to Opus without a Fable call", async () => {
  const { key } = await pooledFallback();
  const sent = upstream((_account, upstreamModel) =>
    upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("opus answer", OPUS)
  );
  await (await call(key.key, fableToolLoop())).text();
  const before = sent.length;
  const response = await call(key.key, fableToolLoop({ metadata: { user_id: "second-turn" } }));
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(route(sent.slice(before)), [`${OPUS}@synthetic-1`]);
});

test("model fallback: Fable stays on Fable while one account can still serve it", async () => {
  const { key } = await pooledFallback();
  const sent = upstream((account, upstreamModel) =>
    account === "synthetic-1" && upstreamModel === FABLE
      ? rateLimited()
      : h.buildClaudeResponse(`answer ${upstreamModel}`, upstreamModel)
  );
  const response = await call(key.key, fableToolLoop());
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /answer claude-fable-5-2/);
  assert.deepEqual(route(sent), [`${FABLE}@synthetic-1`, `${FABLE}@synthetic-2`]);
  assert.equal(response.headers.get("X-OmniRoute-Effective-Model"), null);
});

test("model fallback: a direct Opus request is unchanged", async () => {
  const { key } = await pooledFallback();
  const sent = upstream((_account, upstreamModel) => h.buildClaudeResponse("opus", upstreamModel));
  const response = await call(key.key, fableToolLoop({ model: `claude/${OPUS}` }));
  await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(route(sent), [`${OPUS}@synthetic-1`]);
  assert.equal(response.headers.get("X-OmniRoute-Model-Fallback"), null);
});

for (const failure of [
  {
    name: "401 invalid credentials",
    answer: () => upstreamError(401, "authentication_error", "Invalid bearer token"),
    status: 502,
  },
  {
    name: "400 invalid request",
    answer: () => upstreamError(400, "invalid_request_error", "messages: bad shape"),
    status: 400,
  },
  {
    name: "503 upstream outage",
    answer: () => upstreamError(503, "api_error", "Service unavailable"),
    status: 503,
  },
  {
    name: "529 overloaded",
    answer: () => upstreamError(529, "overloaded_error", "Overloaded"),
    status: 529,
  },
]) {
  test(`model fallback: ${failure.name} on Fable never switches the model`, async () => {
    const { key } = await pooledFallback();
    const sent = upstream((_account, upstreamModel) =>
      upstreamModel === FABLE ? failure.answer() : h.buildClaudeResponse("wrong model", OPUS)
    );
    const response = await call(key.key, fableToolLoop());
    await response.text();
    assert.equal(
      sent.some((entry) => entry.model === OPUS),
      false,
      route(sent).join(" ")
    );
    assert.notEqual(response.status, 200);
  });
}

test("model fallback: an explicit connection pin keeps its model", async () => {
  const { key, connections } = await pooledFallback();
  const sent = upstream((_account, upstreamModel) =>
    upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("wrong model", OPUS)
  );
  const response = await call(key.key, fableToolLoop(), {
    "x-omniroute-connection": connections[0].id,
  });
  await response.text();
  assert.equal(response.status, 429);
  assert.deepEqual(route(sent), [`${FABLE}@synthetic-1`]);
});

test("model fallback: a key that may not use Opus keeps the Fable rate-limit answer", async () => {
  const { key } = await pooledFallback();
  await h.apiKeysDb.updateApiKeyPermissions(key.id, {
    modelAccessMode: "restricted",
    allowedModels: [`claude/${FABLE}`],
  });
  const sent = upstream((_account, upstreamModel) =>
    upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("wrong model", OPUS)
  );
  const response = await call(key.key, fableToolLoop());
  const error = await response.json();
  assert.equal(response.status, 429);
  assert.equal(error.continuity.requested_model, FABLE);
  assert.equal(
    sent.some((entry) => entry.model === OPUS),
    false
  );
});

test("model fallback: the variable can disable the chain", async () => {
  const { key } = await pooledFallback();
  process.env.OMNIROUTE_CLAUDE_MODEL_FALLBACK_CHAIN = "off";
  try {
    const sent = upstream((_account, upstreamModel) =>
      upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("wrong model", OPUS)
    );
    const response = await call(key.key, fableToolLoop());
    await response.text();
    assert.equal(response.status, 429);
    assert.equal(
      sent.some((entry) => entry.model === OPUS),
      false
    );
  } finally {
    delete process.env.OMNIROUTE_CLAUDE_MODEL_FALLBACK_CHAIN;
  }
});

test("model fallback: Opus limited too answers 429 with the earliest retry of both models", async () => {
  const { key, connections } = await pooledFallback();
  const { lockModel } = await import("../../open-sse/services/accountFallback.ts");
  // Opus is already cooling on every account, sooner than the Fable limit will clear.
  const opusReset = new Date(Date.now() + 120_000).toISOString();
  const sent = upstream(() => rateLimited());
  for (const connection of connections) {
    lockModel("claude", connection.id, OPUS, "rate_limited", 120_000);
  }
  const response = await call(key.key, fableToolLoop());
  const error = await response.json();
  assert.equal(response.status, 429);
  assert.deepEqual(route(sent), [
    `${FABLE}@synthetic-1`,
    `${FABLE}@synthetic-2`,
    `${FABLE}@synthetic-3`,
  ]);
  assert.equal(error.error.code, "upstream_accounts_unavailable");
  assert.equal(error.continuity.requested_model, FABLE);
  assert.equal(error.continuity.model_fallback.to, OPUS);
  assert.equal(error.continuity.model_fallback.result, "unavailable");
  const retryAfter = Number(response.headers.get("Retry-After"));
  assert.ok(retryAfter > 0 && retryAfter <= 121, `Retry-After ${retryAfter}`);
  assert.ok(Math.abs(Date.parse(error.continuity.retry_after_at) - Date.parse(opusReset)) < 5_000);
  assert.equal(response.headers.get("x-should-retry"), "false");
});

test("model fallback: an Opus failure other than the pool limit keeps the Fable answer", async () => {
  const { key } = await pooledFallback();
  const sent = upstream((_account, upstreamModel) =>
    upstreamModel === FABLE
      ? rateLimited()
      : upstreamError(400, "invalid_request_error", "Invalid signature in thinking block")
  );
  const response = await call(key.key, fableToolLoop());
  const error = await response.json();
  assert.equal(response.status, 429);
  assert.equal(error.continuity.requested_model, FABLE);
  assert.equal(error.continuity.model_fallback.result, "failed");
  assert.equal(error.continuity.model_fallback.status, 400);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.ok(route(sent).includes(`${OPUS}@synthetic-1`));
});

test("model fallback: a streamed Fable request is streamed by Opus before any Fable output", async () => {
  const { key } = await pooledFallback();
  upstream((_account, upstreamModel) =>
    upstreamModel === FABLE ? rateLimited() : sse("opus streamed")
  );
  const response = await call(key.key, fableToolLoop({ stream: true }));
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /opus streamed/);
  assert.match(text, /message_stop/);
  assert.equal(response.headers.get("X-OmniRoute-Effective-Model"), OPUS);
});
