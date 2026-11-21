/**
 * GET /api/usage/account-selection — the EARLIEST_QUOTA_RENEWAL_FIRST report is complete
 * (per-account windows, tier, position, reason, chosen/reserve, pins, sessions, failovers)
 * and credential-free. Synthetic credentials, isolated DATA_DIR, no provider contacted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-selection-report-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AMBIENTE = "desenvolvimento";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "selection-report-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const auth = await import("../../src/sse/services/auth.ts");
const events = await import("../../src/lib/db/accountFailoverEvents.ts");
const { buildAccountSelectionReport } =
  await import("../../src/sse/services/accountSelectionReport.ts");

const H = 3_600_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const SECRETS = [
  "synthetic-access-1",
  "synthetic-refresh-1",
  "synthetic-access-2",
  "synthetic-access-4",
];

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("report: tiers, chosen and reserve, pins and failovers, no credential", async () => {
  await settingsDb.updateSettings({
    providerStrategies: {
      claude: { fallbackStrategy: "earliest-quota-renewal", sessionAffinityTtlMs: H },
    },
  });
  const make = async (priority: number, extra: Record<string, unknown> = {}) =>
    (
      await providersDb.createProviderConnection({
        provider: "claude",
        authType: "oauth",
        name: `p${priority}`,
        email: `p${priority}@example.test`,
        priority,
        accessToken: `synthetic-access-${priority}`,
        refreshToken: `synthetic-refresh-${priority}`,
        isActive: true,
        testStatus: "active",
        ...extra,
      })
    ).id as string;
  const p1 = await make(1);
  const p2 = await make(2);
  const p3 = await make(3, { isActive: false, testStatus: "expired" });
  const p4 = await make(4);
  quotaCache.setQuotaCache(p1, "claude", {
    "weekly (7d)": { remainingPercentage: 86, resetAt: at(152 * H) },
  });
  quotaCache.setQuotaCache(p2, "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 56, resetAt: at(17.5 * H) },
  });
  quotaCache.setQuotaCache(p4, "claude", {
    "weekly (7d)": { remainingPercentage: 0, resetAt: at(32.5 * H) },
  });

  await auth.getProviderCredentials("claude", null, null, "claude-opus-5-5", {
    sessionKey: "claude:r1",
  });
  events.recordAccountFailoverEvent({
    provider: "claude",
    kind: "failover",
    fromConnectionId: p2,
    toConnectionId: p1,
    reason: "upstream 429",
    model: "claude-opus-5-5",
    sessionKey: "claude:r1",
  });

  const report = await buildAccountSelectionReport("claude");
  assert.equal(report.schema, "omni-route-account-selection/v1");
  assert.equal(report.policy.enabled, true);
  assert.equal(report.policy.sessionAffinityTtlMs, H);
  assert.deepEqual(report.chosen, {
    connectionId: p2,
    reason: "weekly_usable_earliest_reset",
    tier: "A",
  });
  assert.equal(report.reserve?.connectionId, p1);
  const byId = Object.fromEntries(report.accounts.map((a) => [a.connectionId, a]));
  assert.equal(byId[p2].position, 1);
  assert.equal(byId[p2].weekly?.remainingPercentage, 56);
  assert.equal(byId[p2].fiveHour?.state, "idle");
  assert.equal(byId[p2].freshness, "fresh");
  assert.equal(byId[p2].activeSessionPins, 1);
  assert.equal(byId[p4].tier, "out");
  assert.equal(byId[p4].reason, "weekly_exhausted");
  assert.equal(byId[p3].tier, "blocked");
  assert.deepEqual(byId[p3].blocked, ["inactive", "terminal:expired"]);
  assert.equal(report.sessions.pinned.length, 1);
  assert.match(report.sessions.pinned[0].keyHash, /^[0-9a-f]{16}$/);
  assert.equal(report.failovers[0].fromConnectionId, p2);
  assert.equal(report.lastDecision?.chosen, p2);

  const text = JSON.stringify(report);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `report leaks ${secret}`);
  assert.ok(!/accessToken|refreshToken|apiKey|claude:r1/.test(text));
});

test("route: rejects an invalid provider without leaking internals", async () => {
  const { GET } = await import("../../src/app/api/usage/account-selection/route.ts");
  const res = await GET(new Request("http://127.0.0.1/api/usage/account-selection?provider=../x"));
  assert.ok([400, 401, 403].includes(res.status), `status ${res.status}`);
  const body = (await res.json()) as { error?: unknown };
  assert.ok(!String(JSON.stringify(body)).includes("at /"));
});
