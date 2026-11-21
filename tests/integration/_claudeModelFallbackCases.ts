import assert from "node:assert/strict";
import test from "node:test";
import type { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

type Harness = Awaited<ReturnType<typeof createChatPipelineHarness>>;

export async function registerClaudeModelFallbackCases({
  h,
  pool,
  sse,
  call,
}: {
  h: Harness;
  pool: () => Promise<{
    connections: Awaited<ReturnType<Harness["seedConnection"]>>[];
    key: Awaited<ReturnType<Harness["seedApiKey"]>>;
  }>;
  sse: (text: string, complete?: boolean, responseModel?: string) => Response;
  call: (
    key: string,
    body: Record<string, unknown>,
    headers?: Record<string, string>
  ) => Promise<Response>;
}) {
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
  type Sent = {
    account: string;
    model: string;
    body: UpstreamBody;
    headers: Record<string, string>;
  };
  type LoggedCall = { status?: number; model?: string; requestedModel?: string | null };
  /** Synthetic upstream that records which account received which model. */
  function upstream(answer: (account: string, model: string) => Response | Promise<Response>) {
    const sent: Sent[] = [];
    globalThis.fetch = async (_url, init) => {
      const headers = h.toPlainHeaders(init?.headers);
      const upstreamBody = JSON.parse(String(init?.body));
      sent.push({
        account: headers["x-api-key"],
        model: upstreamBody.model,
        body: upstreamBody,
        headers,
      });
      return answer(headers["x-api-key"], upstreamBody.model);
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
          content: [
            { type: "tool_result", tool_use_id: "toolu_fable", content: "already executed" },
          ],
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
    const sent = upstream((_account, upstreamModel) =>
      h.buildClaudeResponse("opus", upstreamModel)
    );
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
    assert.ok(
      Math.abs(Date.parse(error.continuity.retry_after_at) - Date.parse(opusReset)) < 5_000
    );
    assert.equal(response.headers.get("x-should-retry"), "false");
  });

  test("model fallback: Retry-After waits for an account free of all its limits, not the first cooldown", async () => {
    const { key, connections } = await pooledFallback();
    const { lockModel } = await import("../../open-sse/services/accountFallback.ts");
    const { updateProviderConnection } = await import("../../src/lib/db/providers.ts");
    // Fable for 1h and Opus for 30min on every account; the first account also has a 60s
    // per-minute cooldown, which frees none of them.
    for (const connection of connections) {
      lockModel("claude", connection.id, FABLE, "quota_exhausted", 3_600_000);
      lockModel("claude", connection.id, OPUS, "rate_limited", 1_800_000);
    }
    await updateProviderConnection(connections[0].id, {
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
      testStatus: "unavailable",
      errorCode: 429,
    });
    const sent = upstream(() => rateLimited());
    const response = await call(key.key, fableToolLoop());
    const error = await response.json();
    assert.equal(response.status, 429);
    assert.deepEqual(sent, []);
    assert.equal(error.continuity.model_fallback.result, "unavailable");
    const retryAfter = Number(response.headers.get("Retry-After"));
    assert.ok(retryAfter > 1_790 && retryAfter <= 1_801, `Retry-After ${retryAfter}`);
    assert.ok(
      Math.abs(Date.parse(error.continuity.retry_after_at) - (Date.now() + 1_800_000)) < 5_000
    );
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
      upstreamModel === FABLE ? rateLimited() : sse("opus streamed", true, OPUS)
    );
    const response = await call(key.key, fableToolLoop({ stream: true }));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /opus streamed/);
    assert.match(text, /message_stop/);
    assert.equal(response.headers.get("X-OmniRoute-Effective-Model"), OPUS);
  });

  test("model fallback: a thinking-only turn removed between two user turns leaves them merged", () => {
    const adapted = fallbackChain.adaptRequestForFallbackModel(
      {
        model: `claude/${FABLE}`,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
          { role: "user", content: [{ type: "text", text: "second" }] },
        ],
      },
      OPUS
    );
    assert.deepEqual(adapted.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  for (const order of [
    ["503", "429", "429"],
    ["429", "429", "503"],
  ]) {
    test(`model fallback: accounts answering ${order.join(", ")} on Fable never switch the model`, async () => {
      const { key } = await pooledFallback();
      const sent = upstream((account, upstreamModel) => {
        if (upstreamModel !== FABLE) return h.buildClaudeResponse("wrong model", OPUS);
        return order[Number(account.slice(-1)) - 1] === "503"
          ? upstreamError(503, "api_error", "Service unavailable")
          : rateLimited();
      });
      const response = await call(key.key, fableToolLoop());
      await response.text();
      assert.notEqual(response.status, 200);
      assert.equal(
        sent.some((entry) => entry.model === OPUS),
        false,
        route(sent).join(" ")
      );
      // The next request, answered from the cached state without any upstream call, neither.
      const before = sent.length;
      const cached = await call(key.key, fableToolLoop());
      await cached.text();
      assert.equal(
        sent.slice(before).some((entry) => entry.model === OPUS),
        false,
        route(sent.slice(before)).join(" ")
      );
    });
  }

  test("model fallback: a key not bound to an account pool keeps the Fable rate-limit answer", async () => {
    await pooledFallback();
    const unbound = await h.seedApiKey({ name: "unbound-key" });
    const sent = upstream((_account, upstreamModel) =>
      upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("wrong model", OPUS)
    );
    const response = await call(unbound.key, fableToolLoop());
    await response.text();
    assert.notEqual(response.status, 200);
    assert.equal(
      sent.some((entry) => entry.model === OPUS),
      false,
      route(sent).join(" ")
    );
  });

  test("model fallback: with the requested-model echo on, the answer still names Opus", async () => {
    const { key } = await pooledFallback();
    await h.settingsDb.updateSettings({ echoRequestedModelName: true });
    try {
      upstream((_account, upstreamModel) =>
        upstreamModel === FABLE ? rateLimited() : sse("opus streamed", true, OPUS)
      );
      const streamed = await call(key.key, fableToolLoop({ stream: true }));
      const events = (await streamed.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      const start = events.find((event) => event.type === "message_start");
      assert.ok(start, "message_start is streamed");
      assert.match(String(start.message.model), /claude-opus-5-5/);
      assert.doesNotMatch(String(start.message.model), /fable/);

      upstream((_account, upstreamModel) =>
        upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("opus answer", OPUS)
      );
      const json = await call(key.key, fableToolLoop());
      const answer = await json.json();
      assert.equal(json.status, 200);
      assert.match(String(answer.model), /claude-opus-5-5/);
      assert.doesNotMatch(String(answer.model), /fable/);
    } finally {
      await h.settingsDb.updateSettings({ echoRequestedModelName: false });
    }
  });

  test("model fallback: Opus receives the headers and betas Fable received", async () => {
    const { key } = await pooledFallback();
    const sent = upstream((_account, upstreamModel) =>
      upstreamModel === FABLE ? rateLimited() : h.buildClaudeResponse("opus answer", OPUS)
    );
    const response = await call(key.key, fableToolLoop(), {
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });
    await response.text();
    assert.equal(response.status, 200);
    const fable = sent.find((entry) => entry.model === FABLE && entry.account === "synthetic-1")!;
    const opus = sent.find((entry) => entry.model === OPUS)!;
    assert.equal(opus.account, "synthetic-1");
    assert.ok(opus.headers["anthropic-beta"], "Opus receives the Claude betas");
    assert.equal(opus.headers["anthropic-beta"], fable.headers["anthropic-beta"]);
    const differing = Object.keys({ ...fable.headers, ...opus.headers }).filter(
      (name) => name !== "content-length" && fable.headers[name] !== opus.headers[name]
    );
    assert.deepEqual(differing, []);
  });
}
