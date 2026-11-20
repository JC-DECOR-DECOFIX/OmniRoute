import test from "node:test";
import assert from "node:assert/strict";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { resolveNativeClaudeCodeIdentity } from "../../open-sse/executors/claudeIdentity.ts";
import { signRequestBody, computeCCH } from "../../open-sse/services/claudeCodeCCH.ts";

const agent = "claude-cli/2.1.319 (external, sdk-cli)";
const billing = "x-anthropic-billing-header: cc_version=2.1.319.c15; cc_entrypoint=sdk-cli;";
const headers = { "User-Agent": agent, "x-app": "cli" };
const system = [{ type: "text", text: billing }];
// Isolated signed binary with the GUI entrypoint, without the extension's SDK suffix.
const vscodeAgent = "claude-cli/2.1.325 (external, claude-vscode)";
const vscodeBilling =
  "x-anthropic-billing-header: cc_version=2.1.325.486; cc_entrypoint=claude-vscode;";
// Observed on an actual VS Code GUI POST, recording only identity metadata.
const vscodeSdkAgent = "claude-cli/2.1.325 (external, claude-vscode, agent-sdk/0.3.325)";
const vscodeSdkBilling =
  "x-anthropic-billing-header: cc_version=2.1.325.6bf; cc_entrypoint=claude-vscode;";

// Measured on 2026-11-20 from the 2.1.321 binary Happy embeds for its claude_code harness
// (TypeScript Agent SDK 0.3.321), recording only identity metadata.
const agentSdkAgent = "claude-cli/2.1.321 (external, sdk-ts, agent-sdk/0.3.321)";
const agentSdkBilling = "x-anthropic-billing-header: cc_version=2.1.321.cf7; cc_entrypoint=sdk-ts;";

test("the TypeScript Agent SDK identity is kept only in its measured form", () => {
  const resolve = (userAgent: string, text: string) =>
    resolveNativeClaudeCodeIdentity(
      "claude",
      { "user-agent": userAgent },
      { system: [{ type: "text", text }] }
    );
  assert.deepEqual(resolve(agentSdkAgent, agentSdkBilling), {
    userAgent: agentSdkAgent,
    billingLine: agentSdkBilling,
  });
  const subagent = agentSdkBilling + " cc_is_subagent=true;";
  assert.deepEqual(resolve(agentSdkAgent, subagent), {
    userAgent: agentSdkAgent,
    billingLine: subagent,
  });
  for (const badAgent of [
    // The SDK always sends its version; a bare sdk-ts entrypoint was never measured.
    "claude-cli/2.1.321 (external, sdk-ts)",
    agentSdkAgent.replace("0.3.321", "0.3.next"),
    agentSdkAgent.replace("0.3.321", "0.3.321.1"),
    agentSdkAgent.replace("agent-sdk", "unrelated-sdk"),
    agentSdkAgent.replace(")", ", extra)"),
    agentSdkAgent.replace("sdk-ts", "sdk-py"),
    agentSdkAgent.replace("sdk-ts", "sdk-ts-other"),
    // Forcing CLAUDE_CODE_ENTRYPOINT=sdk-cli under the SDK keeps the suffix; still unmeasured.
    agentSdkAgent.replace("sdk-ts", "sdk-cli"),
    agentSdkAgent.replace("sdk-ts", "cli"),
  ]) {
    assert.equal(resolve(badAgent, agentSdkBilling), null, badAgent);
  }
  for (const badBilling of [
    agentSdkBilling.replace("2.1.321", "2.1.320"),
    agentSdkBilling.replace("cc_entrypoint=sdk-ts", "cc_entrypoint=sdk-cli"),
    agentSdkBilling.replace("cc_entrypoint=sdk-ts", "cc_entrypoint=cli"),
    agentSdkBilling.replace("sdk-ts", "sdk-py"),
    agentSdkBilling + " cc_is_subagent=false;",
  ]) {
    assert.equal(resolve(agentSdkAgent, badBilling), null, badBilling);
  }
});

test("actual VS Code SDK suffix is bounded and still requires coherent native billing", () => {
  const body = { system: [{ type: "text", text: vscodeSdkBilling }] };
  assert.deepEqual(
    resolveNativeClaudeCodeIdentity("claude", { "user-agent": vscodeSdkAgent }, body),
    { userAgent: vscodeSdkAgent, billingLine: vscodeSdkBilling }
  );
  for (const badAgent of [
    vscodeSdkAgent.replace("0.3.325", "0.3.next"),
    vscodeSdkAgent.replace("0.3.325", "0.3.325.1"),
    vscodeSdkAgent.replace("0.3.325", "0.3.12345"),
    vscodeSdkAgent.replace("agent-sdk", "unrelated-sdk"),
    vscodeSdkAgent.replace(")", ", extra)"),
    vscodeSdkAgent.replace("claude-vscode", "sdk-cli"),
  ]) {
    assert.equal(resolveNativeClaudeCodeIdentity("claude", { "user-agent": badAgent }, body), null);
  }
  for (const text of [
    vscodeSdkBilling.replace("2.1.325", "2.1.324"),
    vscodeSdkBilling.replace("claude-vscode", "sdk-cli"),
  ]) {
    assert.equal(
      resolveNativeClaudeCodeIdentity(
        "claude",
        { "user-agent": vscodeSdkAgent },
        {
          system: [{ type: "text", text }],
        }
      ),
      null
    );
  }
});

test("VS Code native identity requires the same measured entrypoint in UA and billing", () => {
  assert.deepEqual(
    resolveNativeClaudeCodeIdentity(
      "claude",
      { "user-agent": vscodeAgent },
      {
        system: [{ type: "text", text: vscodeBilling }],
      }
    ),
    { userAgent: vscodeAgent, billingLine: vscodeBilling }
  );
  for (const bad of [
    vscodeBilling.replace("cc_entrypoint=claude-vscode", "cc_entrypoint=sdk-cli"),
    vscodeBilling.replace("cc_version=2.1.325", "cc_version=2.1.324"),
    vscodeBilling.replaceAll("claude-vscode", "claude-vscode-other"),
  ]) {
    assert.equal(
      resolveNativeClaudeCodeIdentity(
        "claude",
        { "user-agent": vscodeAgent },
        {
          system: [{ type: "text", text: bad }],
        }
      ),
      null
    );
  }
  assert.equal(
    resolveNativeClaudeCodeIdentity(
      "claude",
      {
        "user-agent": vscodeAgent.replace("claude-vscode", "claude-vscode-other"),
      },
      {
        system: [
          { type: "text", text: vscodeBilling.replace("claude-vscode", "claude-vscode-other") },
        ],
      }
    ),
    null
  );
});

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

for (const [clientAgent, clientBilling] of [
  [agent, billing],
  [vscodeAgent, vscodeBilling],
  [vscodeSdkAgent, vscodeSdkBilling],
  [agentSdkAgent, agentSdkBilling],
]) {
  test(`executor keeps Fable version, selected account and tool context: ${clientAgent}`, async () => {
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
          system: [
            { type: "text", text: clientBilling },
            { type: "text", text: "Keep fixture context." },
          ],
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
        clientHeaders: {
          ...headers,
          "User-Agent": clientAgent,
          Authorization: "Bearer client-gateway-secret",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(captured.length, 1);
    const wire = captured[0];
    assert.equal(wire.headers.get("user-agent"), clientAgent);
    assert.equal(wire.headers.get("authorization"), "Bearer sk-ant-oat-synthetic-test-only");
    assert.equal(wire.body.model, "claude-fable-5-2");
    assert.equal((wire.body.system as { text: string }[])[0].text, clientBilling);
    assert.ok(
      (wire.body.system as { text: string }[]).some(
        (block) => block.text === "Keep fixture context."
      )
    );
    assert.deepEqual(wire.body.messages, messages);
  });
}

// Measured on the VS Code 2.1.325 binary against a loopback capture server: a subagent
// request repeats the parent's User-Agent and marks its billing line.
const subagentBilling =
  "x-anthropic-billing-header: cc_version=2.1.325.a35; cc_entrypoint=claude-vscode; cc_is_subagent=true;";
// The same capture, auto permission mode: the betas the client negotiates for its own body.
const negotiatedBetas = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "thinking-token-count-2026-05-13",
  "effort-2025-11-24",
  "dangerous-tool-use-2026-09-03",
  "afk-mode-2026-01-31",
  // Rejected upstream on 2026-11-16/17 when dropped: `tool_addition` blocks need inline-tools,
  // and thinking.display "highlights" needs thinking-display-updates.
  "inline-tools-2026-09-15",
  "thinking-display-updates-2026-08-18",
  "advanced-tool-use-2025-11-20",
];

test("a subagent's billing line keeps the native identity, and only in its measured form", () => {
  const resolve = (text: string) =>
    resolveNativeClaudeCodeIdentity(
      "claude",
      { "user-agent": vscodeSdkAgent },
      { system: [{ type: "text", text }] }
    );
  assert.deepEqual(resolve(subagentBilling), {
    userAgent: vscodeSdkAgent,
    billingLine: subagentBilling,
  });
  for (const bad of [
    subagentBilling.replace("cc_is_subagent=true;", "cc_is_subagent=false;"),
    subagentBilling.replace("cc_is_subagent=true;", "cc_is_subagent=true; cc_other=1;"),
    subagentBilling.replace("cc_is_subagent=true;", "cc_is_subagent=true"),
    subagentBilling.replace(
      "cc_entrypoint=claude-vscode; cc_is_subagent=true;",
      "cc_is_subagent=true; cc_entrypoint=claude-vscode;"
    ),
    subagentBilling.replace("2.1.325", "2.1.324"),
  ]) {
    assert.equal(resolve(bad), null, bad);
  }
});

async function nativeWire(options: {
  billingLine: string;
  model: string;
  userAgent?: string;
  beta?: string;
  continuity?: boolean;
}) {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY;
  let wire: { headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = async (_url, init) => {
    wire = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return new Response(
      JSON.stringify({ id: "msg_test", content: [{ type: "text", text: "ok" }] }),
      { headers: { "Content-Type": "application/json" } }
    );
  };
  if (options.continuity) process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
  else delete process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY;
  try {
    await new DefaultExecutor("claude").execute({
      model: options.model,
      stream: false,
      body: {
        model: options.model,
        system: [
          { type: "text", text: options.billingLine },
          { type: "text", text: "Keep fixture context." },
        ],
        tools: [{ name: "Read", description: "Read", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "fixture" }],
        max_tokens: 32,
      },
      credentials: {
        accessToken: "sk-ant-oat-synthetic-test-only",
        providerSpecificData: {
          accountUUID: "550e8400-e29b-41d4-a716-446655440000",
          cliUserID: "a".repeat(64),
        },
      },
      clientHeaders: {
        "x-app": "cli",
        "User-Agent": options.userAgent ?? vscodeSdkAgent,
        Authorization: "Bearer client-gateway-secret",
        ...(options.beta ? { "anthropic-beta": options.beta } : {}),
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY;
    else process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = originalFlag;
  }
  assert.ok(wire, "one upstream request is expected");
  const beta = (wire.headers.get("anthropic-beta") ?? "").split(",").map((token) => token.trim());
  return { ...wire, beta };
}

for (const model of ["claude-opus-5-5", "claude-fable-5-2"]) {
  test(`executor keeps a subagent on its native client version: ${model}`, async () => {
    const wire = await nativeWire({ billingLine: subagentBilling, model });
    // Before the fix this was the pinned fallback client, which upstream refuses for this model.
    assert.equal(wire.headers.get("user-agent"), vscodeSdkAgent);
    const billingLines = (wire.body.system as { text: string }[]).filter((block) =>
      block.text.startsWith("x-anthropic-billing-header:")
    );
    assert.deepEqual(
      billingLines.map((block) => block.text),
      [subagentBilling]
    );
    assert.equal(wire.body.model, model);
  });
}

test("a verified native client keeps the betas it negotiated under the continuity policy", async () => {
  const wire = await nativeWire({
    billingLine: vscodeSdkBilling,
    model: "claude-fable-5-2",
    beta: [...negotiatedBetas, "not a token", "x"].join(","),
    continuity: true,
  });
  for (const token of negotiatedBetas) assert.ok(wire.beta.includes(token), token);
  // The gateway authenticates upstream with the subscription grant.
  assert.ok(wire.beta.includes("oauth-2025-04-20"));
  assert.ok(!wire.beta.includes("not a token"));
  assert.ok(!wire.beta.includes("x"));
  assert.equal(new Set(wire.beta).size, wire.beta.length, "no beta is sent twice");
});

test("negotiated betas stay on the allowlist without the policy or without a native identity", async () => {
  const beta = negotiatedBetas.join(",");
  const dropped = [
    "per-turn-control-2026-07-01",
    "mid-conversation-tool-changes-2026-07-01",
    "dangerous-tool-use-2026-09-03",
    "afk-mode-2026-01-31",
  ];
  const withoutPolicy = await nativeWire({
    billingLine: vscodeSdkBilling,
    model: "claude-fable-5-2",
    beta,
  });
  const opaqueClient = await nativeWire({
    billingLine: vscodeSdkBilling,
    model: "claude-fable-5-2",
    beta,
    continuity: true,
    userAgent: "claude-cli/2.1.325 (external, unmeasured-entrypoint)",
  });
  for (const wire of [withoutPolicy, opaqueClient]) {
    for (const token of dropped) assert.ok(!wire.beta.includes(token), token);
    // Already forwarded for every client.
    assert.ok(wire.beta.includes("effort-2025-11-24"));
  }
});

test("Happy's Agent SDK client keeps its own version on Opus 5.5, subagents included", async () => {
  for (const billingLine of [agentSdkBilling, agentSdkBilling + " cc_is_subagent=true;"]) {
    const wire = await nativeWire({
      billingLine,
      model: "claude-opus-5-5",
      userAgent: agentSdkAgent,
    });
    // Before the fix this was claude-cli/2.1.220, which upstream refuses for Opus 5.5.
    assert.equal(wire.headers.get("user-agent"), agentSdkAgent);
    const billing = (wire.body.system as { text: string }[]).filter((block) =>
      block.text.startsWith("x-anthropic-billing-header:")
    );
    assert.deepEqual(
      billing.map((block) => block.text),
      [billingLine]
    );
    assert.equal(wire.body.model, "claude-opus-5-5");
  }
});
