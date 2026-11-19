import test from "node:test";
import assert from "node:assert/strict";

import { clearAllModelLockouts, lockModel } from "../../open-sse/services/accountFallback.ts";
import { describePoolRateLimit } from "../../src/sse/services/claudePoolRateLimit.ts";

const MODEL = "claude-fable-5-2";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

test.afterEach(() => clearAllModelLockouts());

test("every account with a 429 cooldown or a rate-limit lock is a rate-limited pool", () => {
  lockModel("claude", "b", MODEL, "quota_exhausted", 60_000);
  const verdict = describePoolRateLimit(
    [{ id: "a", rateLimitedUntil: inMs(120_000), errorCode: 429 }, { id: "b" }],
    "claude",
    MODEL
  );
  assert.equal(verdict.allRateLimited, true);
  assert.ok(Math.abs(Date.parse(String(verdict.eligibleAt)) - (Date.now() + 60_000)) < 2_000);
});

test("an account down for any other reason is not a rate limit", () => {
  lockModel("claude", "b", MODEL, "rate_limit_exceeded", 60_000);
  for (const other of [
    { id: "a", rateLimitedUntil: inMs(60_000), errorCode: 503 },
    { id: "a", testStatus: "credits_exhausted" },
    { id: "a" },
  ]) {
    const verdict = describePoolRateLimit([other, { id: "b" }], "claude", MODEL);
    assert.deepEqual(verdict, { allRateLimited: false, eligibleAt: null }, JSON.stringify(other));
  }
  lockModel("claude", "a", MODEL, "server_error", 60_000);
  assert.equal(
    describePoolRateLimit([{ id: "a" }, { id: "b" }], "claude", MODEL).allRateLimited,
    false
  );
});

test("a lock of another model does not count, an exhausted window does", () => {
  lockModel("claude", "a", "claude-opus-5-5", "rate_limited", 60_000);
  assert.equal(describePoolRateLimit([{ id: "a" }], "claude", MODEL).allRateLimited, false);
  const resets = new Map([["a", inMs(300_000)]]);
  const verdict = describePoolRateLimit([{ id: "a" }], "claude", MODEL, resets);
  assert.equal(verdict.allRateLimited, true);
  assert.ok(Math.abs(Date.parse(String(verdict.eligibleAt)) - (Date.now() + 300_000)) < 2_000);
});

test("an account is eligible again only when its last limit clears; an unknown end hides the date", () => {
  lockModel("claude", "a", MODEL, "rate_limited", 30_000);
  const longest = describePoolRateLimit(
    [{ id: "a", rateLimitedUntil: inMs(90_000), errorCode: "429" }],
    "claude",
    MODEL
  );
  assert.ok(Math.abs(Date.parse(String(longest.eligibleAt)) - (Date.now() + 90_000)) < 2_000);
  const unknown = describePoolRateLimit([{ id: "a" }], "claude", MODEL, new Map([["a", null]]));
  assert.deepEqual(unknown, { allRateLimited: true, eligibleAt: null });
  assert.deepEqual(describePoolRateLimit([], "claude", MODEL), {
    allRateLimited: false,
    eligibleAt: null,
  });
});
