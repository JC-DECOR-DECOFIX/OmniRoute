// EARLIEST_QUOTA_RENEWAL_FIRST fields of omni-route-usage/v1 (additive): routing policy,
// per-account tier/position/reason, chosen and reserve, pins and failover events.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildUsageReport } from "../../scripts/ops/omniroute-observability/aggregate.mjs";

const NOW = Date.parse("2026-11-21T21:30:00.000Z");
const H = 3_600_000;
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const P1 = "6726837b-0000-4000-8000-000000000001";
const P2 = "598035c1-0000-4000-8000-000000000002";
const P4 = "bd7bc37c-0000-4000-8000-000000000004";
const SECRET = "sk-ant-oat01-SECRETSECRETSECRET";

function fixture({ strategy = "earliest-quota-renewal", gateway = null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, email TEXT, name TEXT,
      display_name TEXT, priority INTEGER, is_active INTEGER, test_status TEXT,
      rate_limited_until TEXT, last_error_type TEXT, access_token TEXT, refresh_token TEXT,
      id_token TEXT, api_key TEXT, provider_specific_data TEXT);
    CREATE TABLE call_logs (id TEXT PRIMARY KEY, timestamp TEXT, status INTEGER, model TEXT,
      requested_model TEXT, provider TEXT, account TEXT, connection_id TEXT, error_type TEXT,
      error_summary TEXT, correlation_id TEXT, request_type TEXT, api_key_id TEXT);
    CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY (namespace, key));
    CREATE TABLE quota_snapshots (id INTEGER PRIMARY KEY, provider TEXT, connection_id TEXT,
      window_key TEXT, remaining_percentage REAL, is_exhausted INTEGER, next_reset_at TEXT,
      window_duration_ms INTEGER, raw_data TEXT, created_at TEXT);
  `);
  const conn = db.prepare(
    `INSERT INTO provider_connections VALUES (?, 'claude', ?, ?, NULL, ?, 1, 'active', NULL, NULL, ?, ?, ?, ?, NULL)`
  );
  conn.run(P1, "p1@example.com", "p1", 1, SECRET, SECRET, SECRET, SECRET);
  conn.run(P2, "p2@example.com", "p2", 2, SECRET, SECRET, SECRET, SECRET);
  conn.run(P4, "p4@example.com", "p4", 4, SECRET, SECRET, SECRET, SECRET);
  const kv = db.prepare("INSERT INTO key_value VALUES (?, ?, ?)");
  const cache = (quotas) =>
    JSON.stringify({ quotas, fetchedAt: iso(-2 * 60_000), source: "manual" });
  kv.run("providerLimitsCache", P1, cache({ "weekly (7d)": { used: 14, resetAt: iso(152 * H) } }));
  kv.run(
    "providerLimitsCache",
    P2,
    cache({
      "session (5h)": { used: 0, resetAt: null },
      "weekly (7d)": { used: 44, resetAt: iso(17.5 * H) },
    })
  );
  kv.run(
    "providerLimitsCache",
    P4,
    cache({ "weekly (7d)": { used: 100, resetAt: iso(32.5 * H) } })
  );
  kv.run(
    "settings",
    "providerStrategies",
    JSON.stringify({ claude: { fallbackStrategy: strategy, sessionAffinityTtlMs: H } })
  );
  kv.run(
    "session_account_affinity",
    "claude:abc",
    JSON.stringify({
      connectionId: P2,
      createdAt: iso(-H),
      lastUsedAt: iso(-60_000),
      expiresAt: iso(H),
    })
  );
  kv.run(
    "session_account_affinity",
    "claude:old",
    JSON.stringify({
      connectionId: P1,
      createdAt: iso(-3 * H),
      lastUsedAt: iso(-2 * H),
      expiresAt: iso(-H),
    })
  );
  kv.run(
    "account_failover_events",
    "000001",
    JSON.stringify({
      at: iso(-10 * 60_000),
      provider: "claude",
      kind: "failover",
      fromConnectionId: P2,
      toConnectionId: P1,
      reason: "upstream 429",
      model: "claude-opus-5-5",
      sessionHash: "0123456789abcdef",
    })
  );
  kv.run(
    "account_session_activity",
    "claude:abc0000000000000",
    JSON.stringify({
      provider: "claude",
      sessionHash: "abc0000000000000",
      connectionId: P2,
      model: "claude-opus-5-5",
      client: "happy-claude-code",
      firstServedAt: iso(-30 * 60_000),
      lastServedAt: iso(-60_000),
      lastChange: { at: iso(-20 * 60_000), fromConnectionId: P1, reason: "failover: upstream 429" },
    })
  );
  kv.run(
    "session_account_affinity",
    "claude:abc0000000000000ffff",
    JSON.stringify({
      connectionId: P2,
      createdAt: iso(-H),
      lastUsedAt: iso(-60_000),
      expiresAt: iso(H),
    })
  );
  if (gateway) kv.run("account_selection_ranking", "claude", JSON.stringify(gateway));
  return db;
}

const byId = (report) => Object.fromEntries(report.accounts.map((a) => [a.connectionId, a]));

test("mirror ranking: earliest weekly renewal chosen, exhausted out, policy and pins reported", () => {
  const report = buildUsageReport(fixture(), { now: NOW, authorized: [P1, P2, P4] });
  assert.equal(report.pool.strategy, "earliest-quota-renewal");
  assert.deepEqual(report.pool.policy, {
    name: "EARLIEST_QUOTA_RENEWAL_FIRST",
    strategy: "earliest-quota-renewal",
    enabled: true,
    sessionAffinityTtlMs: H,
    quotaFreshMs: 600000,
  });
  assert.equal(report.pool.chosen.connectionId, P2);
  assert.equal(report.pool.reserve.connectionId, P1);
  assert.equal(report.pool.selectionSource, "observability:mirror");
  const a = byId(report);
  assert.deepEqual(
    [a[P2].selection.tier, a[P2].selection.position, a[P2].selection.reason],
    ["A", 1, "weekly_usable_earliest_reset"]
  );
  assert.equal(a[P4].selection.tier, "out");
  assert.equal(a[P4].selection.reason, "weekly_exhausted");
  assert.equal(a[P2].sessionPins, 2);
  assert.equal(report.sessions.length, 1);
  assert.deepEqual(
    [report.sessions[0].shortId, report.sessions[0].model, report.sessions[0].client],
    ["598035c1", "claude-opus-5-5", "happy-claude-code"]
  );
  assert.equal(report.sessions[0].pinned, true);
  assert.equal(report.sessions[0].lastChange.reason, "failover: upstream 429");
  assert.equal(a[P1].sessionPins, 0, "expired pins are not counted");
  assert.equal(report.failoverEvents.length, 1);
  assert.equal(report.failoverEvents[0].reason, "upstream 429");
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test("the gateway's own recent ranking wins over the mirror", () => {
  const gateway = {
    evaluatedAt: iso(-60_000),
    requestedModel: "claude-opus-5-5",
    ordered: [
      {
        connectionId: P1,
        tier: "A",
        position: 1,
        reason: "weekly_usable_earliest_reset",
        limitingWindow: "weekly",
        resetAt: iso(5 * H),
      },
      { connectionId: P2, tier: "B", position: 2, reason: "quota_stale" },
    ],
    excluded: [{ connectionId: P4, tier: "out", position: null, reason: "weekly_exhausted" }],
  };
  const report = buildUsageReport(fixture({ gateway }), { now: NOW, authorized: [P1, P2, P4] });
  assert.equal(report.pool.selectionSource, "omniroute:gateway_ranking");
  assert.equal(report.pool.chosen.connectionId, P1);
  assert.equal(byId(report)[P2].selection.reason, "quota_stale");
  assert.equal(byId(report)[P4].selection.tier, "out");
});

test("an old gateway ranking is ignored; rollback to priority is reported as disabled", () => {
  const gateway = {
    evaluatedAt: iso(-2 * H),
    ordered: [{ connectionId: P1, tier: "A", position: 1, reason: "x" }],
  };
  const report = buildUsageReport(fixture({ strategy: "priority", gateway }), {
    now: NOW,
    authorized: [P1, P2, P4],
  });
  assert.equal(report.pool.selectionSource, "observability:mirror");
  assert.equal(report.pool.policy.enabled, false);
  assert.equal(report.pool.policy.sessionAffinityTtlMs, 0);
  assert.equal(report.pool.strategy, "priority");
});
