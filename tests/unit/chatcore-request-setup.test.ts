// tests/unit/chatcore-request-setup.test.ts
// Characterization of resolveChatCoreRequestSetup — the first extracted pure slice of
// chatCore's request-setup phase (god-file decomposition). Locks the structural-narrowing
// of apiFormat/targetFormat and the requestedModel fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChatCoreRequestSetup } from "../../open-sse/handlers/chatCore/requestSetup.ts";

test("reads apiFormat / targetFormat only when present as strings", () => {
  const r = resolveChatCoreRequestSetup(
    { apiFormat: "responses", targetFormat: "openai" },
    { model: "gpt-4o" },
    "resolved-model"
  );
  assert.equal(r.apiFormat, "responses");
  assert.equal(r.customModelTargetFormat, "openai");
});

test("apiFormat / targetFormat absent or non-string → undefined", () => {
  assert.equal(resolveChatCoreRequestSetup({}, {}, "m").apiFormat, undefined);
  assert.equal(resolveChatCoreRequestSetup({ apiFormat: 123 }, {}, "m").apiFormat, undefined);
  assert.equal(
    resolveChatCoreRequestSetup({ targetFormat: null }, {}, "m").customModelTargetFormat,
    undefined
  );
});

test("modelInfo that is not an object → both markers undefined", () => {
  const r = resolveChatCoreRequestSetup(null, { model: "x" }, "m");
  assert.equal(r.apiFormat, undefined);
  assert.equal(r.customModelTargetFormat, undefined);
});

test("requestedModel uses the client body.model when it is a non-blank string", () => {
  assert.equal(
    resolveChatCoreRequestSetup({}, { model: "claude-3" }, "fallback").requestedModel,
    "claude-3"
  );
});

test("requestedModel falls back to the resolved model id when body.model is blank/absent/non-string", () => {
  assert.equal(
    resolveChatCoreRequestSetup({}, { model: "   " }, "fallback").requestedModel,
    "fallback"
  );
  assert.equal(resolveChatCoreRequestSetup({}, {}, "fallback").requestedModel, "fallback");
  assert.equal(
    resolveChatCoreRequestSetup({}, { model: 42 }, "fallback").requestedModel,
    "fallback"
  );
  assert.equal(resolveChatCoreRequestSetup({}, null, "fallback").requestedModel, "fallback");
});

test("an explicit modelInfo.requestedModel names the call-log model, never the echoed one", () => {
  const setup = resolveChatCoreRequestSetup(
    { requestedModel: "claude/claude-fable-5-2" },
    { model: "claude/claude-opus-5-5" },
    "claude-opus-5-5"
  );
  assert.equal(setup.callLogRequestedModel, "claude/claude-fable-5-2");
  assert.equal(setup.requestedModel, "claude/claude-opus-5-5");
  const blank = resolveChatCoreRequestSetup({ requestedModel: " " }, { model: "claude-3" }, "m");
  assert.equal(blank.callLogRequestedModel, "claude-3");
  assert.equal(resolveChatCoreRequestSetup({}, {}, "m").callLogRequestedModel, "m");
});
