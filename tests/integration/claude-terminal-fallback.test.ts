import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const SOL = "gpt-6.2-sol";
const TARGET = `codex/${SOL}`;
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
process.env.OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY = "true";
const h = await createChatPipelineHarness("claude-terminal");
const { updateApiKeyPermissions } = await import("../../src/lib/db/apiKeys.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
const { clearAllModelLockouts } = await import("../../open-sse/services/accountFallback.ts");
const { runAuthzPipeline } = await import("../../src/server/authz/pipeline.ts");
const { getCallLogs } = await import("../../src/lib/usage/callLogs.ts");
const { markLocalRateLimitError, RATE_LIMIT_QUEUE_FULL_CODE } =
  await import("../../open-sse/services/rateLimitManager/errors.ts");
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
      account: String(url).includes("chatgpt.com") ? "Codex" : headers["x-api-key"],
      body,
      model: body.model,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
  return calls;
}

for (const [name, statuses] of [
  ["normal Opus", [200]],
  ["Claude sibling succeeds", [401, 200]],
  ["three 429s", [429, 429, 429]],
  ["three 401s", [401, 401, 401]],
  ["three upstream 500s", [500, 500, 500]],
  ["mixed account outages", [401, 500, 429]],
  ["client payload error", [400]],
] as const) {
  test(name, async () => {
    const { key, codex } = await pool();
    const sent = mockUpstream(({ account, model }) => {
      if (account === "Codex") return codexSse();
      const status = statuses["ABC".indexOf(account)];
      return status === 200 ? claudeJson(model) : upstreamError(status);
    });
    const response = await call(key.key);
    if (statuses.length === 3) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-omniroute-effective-model"), SOL);
      assert.equal((await response.json()).model, SOL);
      const log = await h.waitFor(async () =>
        (await getCallLogs({ limit: 20 })).find(
          (row: { provider?: string; status?: number }) =>
            row.provider === "codex" && row.status === 200
        )
      );
      assert.equal(log?.requestedModel, `claude/${OPUS}`);
      assert.equal(log?.connectionId, codex.id);
      assert.equal(log?.requestType, "claude_terminal_fallback");
      assert.equal(log?.apiKeyId, key.id);
    } else {
      assert.equal(response.status, statuses.at(-1));
      assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
      await response.text();
    }
    const expected = [..."ABC".slice(0, statuses.length)].flatMap((account, index) =>
      statuses[index] === 429 ? [account, account, account] : [account]
    );
    if (statuses.length === 3) expected.push("Codex");
    assert.deepEqual(
      sent.map(({ account }) => account),
      expected
    );
  });
}

test("Fable → Opus → Codex; a mixed Fable pool must still try eligible Opus accounts", async () => {
  const { key } = await pool();
  const sent = mockUpstream(({ account, model }) =>
    account === "Codex"
      ? codexSse()
      : model === FABLE && account === "A"
        ? upstreamError(401)
        : upstreamError(429)
  );
  const response = await call(key.key, messages(FABLE));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, SOL);
  assert.deepEqual(
    [...new Set(sent.map(({ model, account }) => `${model}:${account}`))],
    [`${FABLE}:A`, `${FABLE}:B`, `${FABLE}:C`, `${OPUS}:B`, `${OPUS}:C`, `${SOL}:Codex`]
  );
});

test("rejected Codex returns the original Claude verdict", async () => {
  const { key } = await pool();
  const sent = mockUpstream(({ account }) => upstreamError(account === "Codex" ? 400 : 429));
  const response = await call(key.key);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-omniroute-continuity-status"), "accounts-unavailable");
  assert.deepEqual((await response.json()).continuity.model_fallback, {
    from: OPUS,
    to: SOL,
    provider: "codex",
    reason: "accounts_rate_limited",
    tried: [SOL],
    result: "failed",
    status: 400,
  });
  assert.equal(sent.filter(({ account }) => account === "Codex").length, 1);
});

test("Codex 429 cannot send the conversation to a second or unauthorized account", async () => {
  const { key, codex } = await pool();
  await h.seedConnection("codex", { name: "unauthorized", apiKey: "synthetic-unauthorized" });
  const sent = mockUpstream(({ account }) => upstreamError(account === "Codex" ? 429 : 500));
  const response = await call(key.key);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).continuity.model_fallback.status, 429);
  assert.equal(sent.filter(({ account }) => account === "Codex").length, 1);
  assert.ok(codex.id);
});

test("local limiter failure is not an upstream quota verdict", async () => {
  const { key } = await pool();
  const sent = mockUpstream(() => {
    throw markLocalRateLimitError(new Error("Synthetic local limiter"), RATE_LIMIT_QUEUE_FULL_CODE);
  });
  const response = await call(key.key);
  await response.text();
  assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
  assert.equal(sent[0]?.account, "A");
  assert.ok(sent.every(({ account }) => account === "A"));
});

for (const unavailable of ["renewal", "proxy", "timeout"] as const) {
  test(`a cached ${unavailable} error is not proof of a Claude outage`, async () => {
    const { key, connections } = await pool();
    const lastError = {
      renewal: "Claude credential renewal is temporarily unavailable",
      proxy: "PROXY_UNREACHABLE",
      timeout: "Local upstream timeout",
    }[unavailable];
    await updateProviderConnection(connections[0].id, {
      errorCode: unavailable === "timeout" ? 504 : 503,
      lastError,
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const sent = mockUpstream(() => upstreamError(500));
    const response = await call(key.key);
    assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
    await response.text();
    assert.deepEqual(
      sent.map(({ account }) => account),
      ["B", "C"]
    );
  });
}

for (const chain of ["off", "denied"] as const) {
  test(`Fable never bypasses an ${chain} Opus hop`, async () => {
    const { key } = await pool([`claude/${FABLE}`, TARGET]);
    if (chain === "off") process.env.OMNIROUTE_CLAUDE_MODEL_FALLBACK_CHAIN = "off";
    try {
      const sent = mockUpstream(() => upstreamError(429));
      const response = await call(key.key, messages(FABLE));
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
      await response.text();
      assert.equal(sent.length, 9);
      assert.ok(sent.every(({ model }) => model === FABLE));
    } finally {
      delete process.env.OMNIROUTE_CLAUDE_MODEL_FALLBACK_CHAIN;
    }
  });
}

test("key rate limit and removing the exact Sol grant take effect without restart", async () => {
  const { key } = await pool();
  const sent = mockUpstream(({ account }) =>
    account === "Codex" ? codexSse() : upstreamError(429)
  );
  const first = await call(key.key);
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(sent.filter(({ account }) => account === "Codex").length, 1);
  await updateApiKeyPermissions(key.id, { allowedModels: ["claude/*"] });
  const second = await call(key.key);
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("x-omniroute-model-fallback"), null);
  await second.text();
  await updateApiKeyPermissions(key.id, {
    allowedModels: ["claude/*", TARGET],
    maxRequestsPerMinute: 1,
  });
  for (let i = 0; i < 3; i++) {
    const response = await call(key.key);
    const body = await response.text();
    if (/Request limit exceeded/i.test(body)) {
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
      assert.ok(sent.filter(({ account }) => account === "Codex").length <= 2);
      return;
    }
  }
  assert.fail("Expected the local key limit to reject a request");
});

for (const deny of ["off", "ACL", "wildcard", "catalog", "pin", "abort", "partial"] as const) {
  test(`no Codex on ${deny}`, async () => {
    const { key, connections } = await pool(
      deny === "ACL" ? ["claude/*"] : deny === "wildcard" ? ["claude/*", "codex/*"] : undefined,
      deny !== "catalog"
    );
    if (deny === "off") process.env.OMNIROUTE_CLAUDE_TERMINAL_FALLBACK = "off";
    const ctl = new AbortController();
    const sent = mockUpstream(({ model }) => {
      if (deny === "abort") {
        ctl.abort();
        return upstreamError(499);
      }
      return deny === "partial" ? claudeSse(model, false) : upstreamError(429);
    });
    const response = await call(
      key.key,
      messages(OPUS, { stream: deny === "partial" }),
      deny === "pin" ? { "x-omniroute-connection": connections[0].id } : {},
      ctl.signal
    );
    const text = await response.text();
    if (deny === "partial") assert.match(text, /Claude answered/);
    if (deny === "abort") {
      assert.equal(response.status, 499);
      assert.deepEqual(
        sent.map(({ account }) => account),
        ["A"]
      );
    }
    assert.equal(response.headers.get("x-omniroute-model-fallback"), null);
    assert.ok(sent.every(({ account }) => account !== "Codex"));
  });
}

for (const stream of [false, true]) {
  test(`Messages → Responses → Messages tool replay, images, effort and usage (stream=${stream})`, async () => {
    const { key, connections } = await pool();
    let useClaude = false;
    let gptTurns = 0;
    const sent = mockUpstream(({ account, model }) =>
      account === "Codex"
        ? codexSse(++gptTurns === 1)
        : useClaude
          ? stream
            ? claudeSse(model)
            : claudeJson(model)
          : upstreamError(429)
    );
    const request = {
      stream,
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
      tools: [
        {
          name: "lookup",
          description: "Read a value",
          input_schema: { type: "object", properties: { key: { type: "string" } } },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look it up" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "signed prior rationale",
              signature: "synthetic-signature",
            },
            { type: "redacted_thinking", data: "synthetic-redacted" },
            { type: "text", text: "Considering it" },
          ],
        },
        { role: "user", content: "continue" },
      ],
    };
    const first = await call(key.key, messages(OPUS, request));
    assert.equal(first.status, 200);
    const text = await first.text();
    assert.doesNotMatch(
      text,
      /must not be replayed|thinking_delta|"type":"thinking"|redacted_thinking/
    );
    assert.match(text, /call_abc/);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /"output_tokens":20/);
    const gpt = sent.find(({ account }) => account === "Codex");
    assert.match(JSON.stringify(gpt?.body), /input_image/);
    assert.match(JSON.stringify(gpt?.body.reasoning), /xhigh/);
    assert.doesNotMatch(
      JSON.stringify(gpt?.body),
      /synthetic-signature|synthetic-redacted|signed prior rationale/
    );
    const replay = messages(OPUS, {
      ...request,
      messages: [
        request.messages[0],
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_abc", name: "lookup", input: { key: "x" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_abc", content: "local lookup result" },
          ],
        },
      ],
    });
    const second = await call(key.key, replay);
    assert.match(await second.text(), /Sol answered/);
    const gptReplay = JSON.stringify(
      sent.filter(({ account }) => account === "Codex").at(-1)?.body.input
    );
    assert.match(
      gptReplay,
      /"type":"function_call_output","call_id":"call_abc","output":"local lookup result"/
    );
    clearAllModelLockouts();
    for (const conn of connections) {
      await updateProviderConnection(conn.id, {
        rateLimitedUntil: null,
        errorCode: null,
        lastError: null,
        testStatus: "active",
      });
    }
    useClaude = true;
    const third = await call(key.key, replay);
    assert.match(await third.text(), /Claude answered/);
    assert.equal(sent.at(-1)?.account, "A");
    assert.match(JSON.stringify(sent.at(-1)?.body.messages), /"tool_use_id":"call_abc"/);
    assert.doesNotMatch(
      JSON.stringify(sent.at(-1)?.body),
      /signature|reasoning_summary|redacted_thinking/
    );
  });
}

const claudeBinary = process.env.OMNIROUTE_TEST_CLAUDE_BINARY;
test("Claude Code runs a local tool on the mock Codex path", { skip: !claudeBinary }, async () => {
  const { key } = await pool();
  const markerFile = `${process.env.DATA_DIR}/canary-tool-result.txt`;
  writeFileSync(markerFile, "MOCK_TOOL_RESULT_619");
  let toolIssued = false;
  let resultReceived = false;
  let mocked = 0;
  mockUpstream(({ account, body }) => {
    if (account !== "Codex") return upstreamError(429);
    mocked++;
    const inputs = JSON.stringify(body.input);
    if (inputs.includes("MOCK_TOOL_RESULT_619") && inputs.includes("call_abc")) {
      resultReceived = true;
      return codexSse();
    }
    const tools = body.tools as Array<{ name?: string }> | undefined;
    const read = tools?.find(({ name }) => name?.toLowerCase() === "read")?.name;
    if (read) {
      toolIssued = true;
      return codexSse(true, read, JSON.stringify({ file_path: markerFile }));
    }
    return codexSse();
  });
  const { POST } = await import("../../src/app/api/v1/messages/route.ts");
  const server = createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/messages"
    ) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new NextRequest(`http://localhost${req.url}`, {
        method: "POST",
        headers,
        body: Buffer.concat(chunks),
      });
      const auth = await runAuthzPipeline(request, { enforce: true });
      const response =
        auth && !auth.headers.get("x-middleware-next") ? auth : await POST(request, {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const { stdout } = await promisify(execFile)(
      claudeBinary!,
      [
        "-p",
        "Read the single requested file with Read and then answer.",
        "--model",
        `claude/${OPUS}`,
        "--tools",
        "Read",
        "--allowedTools",
        "Read",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--settings",
        '{"disableAllHooks":true}',
        "--no-session-persistence",
        "--max-turns",
        "3",
        "--output-format",
        "json",
      ],
      {
        cwd: process.env.DATA_DIR,
        timeout: 30000,
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          CLAUDE_CONFIG_DIR: `${process.env.DATA_DIR}/cli-config`,
          CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_MAX_RETRIES: "0",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}`,
          ANTHROPIC_AUTH_TOKEN: key.key,
          HTTPS_PROXY: "http://127.0.0.1:1",
          HTTP_PROXY: "http://127.0.0.1:1",
          NO_PROXY: "127.0.0.1,localhost",
        },
      }
    );
    assert.ok(toolIssued, `Codex tool not issued (mock responses: ${mocked})`);
    assert.ok(resultReceived, "CLI did not send the mock file's contents as a tool result");
    assert.match(stdout, /Sol answered/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
