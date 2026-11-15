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
    { type: "content_block_start", index: 0, content_block: { type: "text", text } },
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
    assert.equal(response.status, failures < 3 ? 200 : 401);
    if (failures === 3) {
      const error = JSON.parse(responseText);
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
  assert.doesNotMatch(text, /"stop_reason":"max_tokens"/);
  assert.ok(text.indexOf("event: error") < text.indexOf("event: message_stop"));
});

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

for (const first of ["lifecycle-only", "authentication-error"] as const) {
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
      return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, {
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
  assert.equal(response.status, 401);
  const error = await response.json();
  assert.equal(error.continuity.requested_model, nativeModel);
  assert.equal(error.continuity.provider, "claude");
  assert.equal(error.continuity.attempts, 0);
  assert.match(error.continuity.recovery, /Re-authenticate/);

  const { getModelInfo } = await import("../../src/sse/services/model.ts");
  const explicit = await getModelInfo(`anthropic/${nativeModel}`);
  assert.equal(explicit.provider, "anthropic");
  assert.equal(explicit.model, nativeModel);
  process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "false";
  try {
    assert.notEqual((await getModelInfo(nativeModel)).provider, "claude");
  } finally {
    process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
  }
  await h.settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: false });
  assert.notEqual((await getModelInfo(nativeModel)).provider, "claude");
});
