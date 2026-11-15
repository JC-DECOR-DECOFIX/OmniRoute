import test from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { resolveNativeClaudeCodeIdentity } from "../../open-sse/executors/claudeIdentity.ts";
import { signRequestBody, computeCCH } from "../../open-sse/services/claudeCodeCCH.ts";

const agent = "claude-cli/2.1.319 (external, sdk-cli)";
const billing = "x-anthropic-billing-header: cc_version=2.1.319.c15; cc_entrypoint=sdk-cli;";
const headers = { "User-Agent": agent, "x-app": "cli" };
const system = [{ type: "text", text: billing }];

test("CCH signing changes only billing and remains stable across retries", async () => {
  const messages = [{ role: "user", content: "Preserve literal cch=abcde; exactly." }];
  const plain = JSON.stringify({ messages, system });
  assert.equal(await signRequestBody(plain), plain);
  const old = billing + " cch=abcde;";
  const raw = JSON.stringify({
    messages,
    system: [{ text: old }],
    tools: [{ description: "cch=abcde;" }],
  });
  const signed = JSON.parse(await signRequestBody(raw));
  assert.deepEqual(signed.messages, messages);
  assert.equal(signed.tools[0].description, "cch=abcde;");
  const placeholder = raw.replace(old, old.replace("abcde", "00000"));
  const expected = await computeCCH(new TextEncoder().encode(placeholder));
  assert.equal(signed.system[0].text, old.replace("abcde", expected));
  assert.equal(await signRequestBody(JSON.stringify(signed)), JSON.stringify(signed));
});

test("opaque and mismatched native clients retain the pinned fallback identity", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { headers: Headers; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (_url, init) => {
    captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  };
  try {
    for (const clientHeaders of [{}, { ...headers, "User-Agent": agent.replace("319", "320") }]) {
      await new DefaultExecutor("claude").execute({
        model: "claude-haiku-5-5",
        stream: false,
        body: {
          system: structuredClone(system),
          messages: [{ role: "user", content: "test" }],
          max_tokens: 32,
        },
        credentials: {
          accessToken: "sk-ant-oat-synthetic-test-only",
          providerSpecificData: {
            accountUUID: "550e8400-e29b-41d4-a716-446655440000",
            cliUserID: "a".repeat(64),
          },
        },
        clientHeaders,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.length, 2);
  for (const wire of captured) {
    assert.equal(wire.headers.get("user-agent"), "claude-cli/2.1.220 (external, cli)");
    assert.match(
      (wire.body.system as { text: string }[])[0].text,
      /cc_version=2\.1\.220\.1f2; cc_entrypoint=cli; cch=[a-f0-9]{5};/
    );
  }
});

test("native identity requires matching version and entrypoint, never arbitrary headers", () => {
  assert.deepEqual(resolveNativeClaudeCodeIdentity("claude", headers, { system }), {
    userAgent: agent,
    billingLine: billing,
  });
  for (const [provider, hs, sys] of [
    ["anthropic-compatible-cc-example", headers, system],
    ["claude", {}, system],
    ["claude", { ...headers, "user-agent": agent }, system],
    ["claude", { "user-agent": "unrelated-client/9.9" }, system],
    ["claude", { "user-agent": agent + "\r\nx-api-key: unsafe" }, system],
    ["claude", headers, []],
    ["claude", headers, [...system, ...system]],
    ["claude", headers, [{ text: billing.replace("2.1.319", "2.1.220") }]],
    ["claude", headers, [{ text: billing.replace("cc_entrypoint=sdk-cli", "cc_entrypoint=cli") }]],
    ["claude", headers, [{ text: billing + "\nprivate data" }]],
  ] as const) {
    assert.equal(resolveNativeClaudeCodeIdentity(provider, hs, { system: sys }), null);
  }
});

test("older native billing CCH is invalidated before re-signing", () => {
  const old = billing.replace("2.1.319.c15", "2.1.220.1f2") + " cch=abcde;";
  const identity = resolveNativeClaudeCodeIdentity(
    "claude",
    {
      "user-agent": agent.replace("2.1.319", "2.1.220"),
    },
    { system: [{ text: old }] }
  );
  assert.equal(identity?.billingLine, old.replace("abcde", "00000"));
});

test("executor keeps Fable client's real version, selected account and tool context on wire", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { headers: Headers; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (_url, init) => {
    captured.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ id: "msg_test", content: [{ type: "text", text: "ok" }] }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  };
  const messages = [
    { role: "user", content: "Read the fixture and preserve cch=abcde; exactly." },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_fixture", name: "Read", input: { file_path: "/fixture" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_fixture",
          content: "context-preserved cch=abcde;",
        },
      ],
    },
  ];
  try {
    await new DefaultExecutor("claude").execute({
      model: "claude-fable-5-2",
      stream: false,
      body: {
        model: "claude-fable-5-2",
        system: [...system, { type: "text", text: "Keep fixture context." }],
        messages,
        max_tokens: 32,
      },
      credentials: {
        accessToken: "sk-ant-oat-synthetic-test-only",
        providerSpecificData: {
          accountUUID: "550e8400-e29b-41d4-a716-446655440000",
          cliUserID: "a".repeat(64),
        },
      },
      clientHeaders: { ...headers, Authorization: "Bearer client-gateway-secret" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.length, 1);
  const wire = captured[0];
  assert.equal(wire.headers.get("user-agent"), agent);
  assert.equal(wire.headers.get("authorization"), "Bearer sk-ant-oat-synthetic-test-only");
  assert.equal(wire.body.model, "claude-fable-5-2");
  assert.equal((wire.body.system as { text: string }[])[0].text, billing);
  assert.ok(
    (wire.body.system as { text: string }[]).some((block) => block.text === "Keep fixture context.")
  );
  assert.deepEqual(wire.body.messages, messages);
});
