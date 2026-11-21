/**
 * @file alibaba-free-tier-allowlist.test.ts
 * @description Tests for built-in Alibaba free-tier text model allowlists.
 *
 * @changes
 * - [2026-07-25] [Composer] - Add built-in allowlist regression tests
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALIBABA_FREE_TIER_TEXT_CAPABLE_MODELS,
  ALIBABA_NO_FREE_TIER_TEXT_MODELS,
  isAlibabaBuiltinFreeTierTextModel,
  isAlibabaBuiltinNoFreeTierTextModel,
  isAlibabaFreeTierAllowlistPackValid,
  loadAlibabaFreeTierAllowlistPack,
  resetAlibabaFreeTierAllowlistCache,
} from "../../open-sse/services/alibabaFreeTierAllowlist.ts";

test("built-in allowlist includes operator free models and excludes paid blocklist", () => {
  assert.ok(ALIBABA_FREE_TIER_TEXT_CAPABLE_MODELS.includes("qwen3.6-plus"));
  assert.ok(ALIBABA_FREE_TIER_TEXT_CAPABLE_MODELS.includes("glm-5.2"));
  assert.ok(ALIBABA_NO_FREE_TIER_TEXT_MODELS.includes("qwen3.7-max"));
  assert.ok(ALIBABA_NO_FREE_TIER_TEXT_MODELS.includes("glm-5.2-fast-preview"));
  assert.equal(isAlibabaBuiltinFreeTierTextModel("qwen3.6-plus"), true);
  assert.equal(isAlibabaBuiltinNoFreeTierTextModel("kimi-k2.7-code"), true);
  assert.equal(isAlibabaBuiltinFreeTierTextModel("qwen3.7-max"), false);
});

test("the shipped JSON pack overrides embedded lists only through its expiry", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "alibaba-allowlist-"));
  const packPath = fileURLToPath(
    new URL("../../config/alibaba-free-tier-allowlist.json", import.meta.url)
  );
  const previousPath = process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH;
  const previousDataDir = process.env.DATA_DIR;
  t.after(() => {
    if (previousPath === undefined) delete process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH;
    else process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH = previousPath;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    resetAlibabaFreeTierAllowlistCache();
    rmSync(dataDir, { recursive: true, force: true });
  });
  process.env.ALIBABA_FREE_TIER_ALLOWLIST_PATH = packPath;
  process.env.DATA_DIR = dataDir;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-28T00:00:00Z") });
  resetAlibabaFreeTierAllowlistCache();

  const pack = loadAlibabaFreeTierAllowlistPack();
  assert.ok(pack);
  assert.ok(pack.validUntil, "the shipped pack must have an expiry");
  assert.ok(pack.capable.includes("qwen3.6-plus"));

  const expiry = Date.parse(pack.validUntil);
  assert.ok(expiry > Date.now());
  t.mock.timers.setTime(expiry);
  resetAlibabaFreeTierAllowlistCache();
  assert.ok(isAlibabaFreeTierAllowlistPackValid(pack));
  assert.deepEqual(loadAlibabaFreeTierAllowlistPack(), pack);

  t.mock.timers.tick(1);
  resetAlibabaFreeTierAllowlistCache();
  assert.equal(isAlibabaFreeTierAllowlistPackValid(pack), false);
  assert.equal(loadAlibabaFreeTierAllowlistPack(), null);
  assert.equal(isAlibabaBuiltinFreeTierTextModel("qwen3.6-plus"), true);
});
