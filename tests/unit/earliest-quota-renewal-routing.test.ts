// ENVIRONMENT NOTE: exercises a real better-sqlite3 database in an isolated DATA_DIR
// (see tests/unit/_helpers/betterSqlite3Availability.ts). No provider is contacted:
// quota readings are injected with setQuotaCache and credentials are synthetic.
/**
 * EARLIEST_QUOTA_RENEWAL_FIRST end to end through getProviderCredentials:
 * ranking + per-session affinity + failover + rollback by configuration.
 * All dates are relative to Date.now() at seeding time — never hardcoded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-earliest-renewal-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.AMBIENTE = "desenvolvimento";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "earliest-renewal-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const affinityDb = await import("../../src/lib/db/sessionAccountAffinity.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const auth = await import("../../src/sse/services/auth.ts");
const ranking = await import("../../src/sse/services/quotaRenewalRanking.ts");
const { resolveSessionAffinityTtlMs } =
  await import("../../src/sse/services/sessionAffinityPin.ts");

const H = 3_600_000;
const TTL = 3_600_000;
const MODEL = "claude-opus-5-5";
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Ids = { p1: string; p2: string; p3inactive: string; p4: string };

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  quotaCache.__clearForTests();
  ranking.__resetQuotaRenewalRankingForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedClaude(priority: number, overrides: Record<string, unknown> = {}) {
  const connection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: `claude-p${priority}`,
    email: `p${priority}@example.test`,
    priority,
    accessToken: `synthetic-access-${priority}`,
    refreshToken: `synthetic-refresh-${priority}`,
    isActive: true,
    testStatus: "active",
    ...overrides,
  });
  return connection.id as string;
}

/** The production pool of 2026-11-21, shifted to "now". */
async function seedAcceptancePool(strategy = "earliest-quota-renewal"): Promise<Ids> {
  await settingsDb.updateSettings({
    providerStrategies: { claude: { fallbackStrategy: strategy, sessionAffinityTtlMs: TTL } },
  });
  const ids = {
    p1: await seedClaude(1), // 6726837b-like: weekly 86 %, resets last
    p2: await seedClaude(2), // 598035c1-like: weekly 56 %, resets first, 5h idle
    p3inactive: await seedClaude(3, { isActive: false, testStatus: "expired" }),
    p4: await seedClaude(4), // bd7bc37c-like: weekly exhausted
  };
  quotaCache.setQuotaCache(ids.p1, "claude", {
    "weekly (7d)": { remainingPercentage: 86, resetAt: at(152 * H) },
  });
  quotaCache.setQuotaCache(ids.p2, "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 56, resetAt: at(17.5 * H) },
  });
  quotaCache.setQuotaCache(ids.p4, "claude", {
    "weekly (7d)": { remainingPercentage: 0, resetAt: at(32.5 * H) },
  });
  return ids;
}

const select = (sessionKey: string | null, options: Record<string, unknown> = {}) =>
  auth.getProviderCredentials("claude", null, null, MODEL, { sessionKey, ...options });

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("acceptance: new eligible sessions go to the earliest weekly renewal; exhausted never chosen", async () => {
  const ids = await seedAcceptancePool();
  for (const session of ["s-a", "s-b", "s-c"]) {
    const creds = await select(session);
    assert.equal(creds?.connectionId, ids.p2, `${session} must land on the earliest renewal`);
    assert.match(
      String(creds?.accountSelection),
      /^EARLIEST_QUOTA_RENEWAL_FIRST; tier=A; pos=1\/2/
    );
  }
  const last = ranking.getLastAccountSelectionRanking("claude");
  assert.deepEqual(
    last?.ordered.map((d) => d.connectionId),
    [ids.p2, ids.p1]
  );
  assert.ok(!last?.ordered.some((d) => d.connectionId === ids.p4));
  assert.ok(!last?.ordered.some((d) => d.connectionId === ids.p3inactive));
});

test("rollback: 'priority' keeps today's behaviour (priority 1, no pins)", async () => {
  const ids = await seedAcceptancePool("priority");
  assert.equal(resolveSessionAffinityTtlMs("claude", {}, await settingsDb.getSettings()), 0);
  const creds = await select("s-rollback");
  assert.equal(creds?.connectionId, ids.p1);
  assert.equal(creds?.accountSelection, undefined);
  assert.equal(affinityDb.getSessionAccountAffinity("s-rollback", "claude", TTL), null);
});

test("(3) 5h exhausted on the best account moves new sessions to the next one", async () => {
  const ids = await seedAcceptancePool();
  quotaCache.setQuotaCache(ids.p2, "claude", {
    "session (5h)": { remainingPercentage: 0, resetAt: at(0.5 * H) },
    "weekly (7d)": { remainingPercentage: 55, resetAt: at(17.5 * H) },
  });
  const creds = await select("s-5h");
  assert.equal(creds?.connectionId, ids.p1);
});

test("(4) 429 failover retries the same model on the next ranked account", async () => {
  const ids = await seedAcceptancePool();
  const first = await select("s-429");
  assert.equal(first?.connectionId, ids.p2);
  const retry = await select("s-429", { excludeConnectionIds: [ids.p2] });
  assert.equal(retry?.connectionId, ids.p1);
});

test("(5) credential failure removes the account; it returns after refresh", async () => {
  const ids = await seedAcceptancePool();
  await providersDb.updateProviderConnection(ids.p2, { testStatus: "expired" });
  assert.equal((await select("s-auth-1"))?.connectionId, ids.p1);
  await providersDb.updateProviderConnection(ids.p2, { testStatus: "active" });
  assert.equal((await select("s-auth-2"))?.connectionId, ids.p2);
});

test("(6) an existing session keeps its account when another one becomes better", async () => {
  const ids = await seedAcceptancePool();
  quotaCache.setQuotaCache(ids.p2, "claude", {
    "weekly (7d)": { remainingPercentage: 56, resetAt: at(200 * H) },
  });
  assert.equal((await select("s-sticky"))?.connectionId, ids.p1, "p1 renews first now");
  quotaCache.setQuotaCache(ids.p2, "claude", {
    "weekly (7d)": { remainingPercentage: 56, resetAt: at(1 * H) },
  });
  assert.equal((await select("s-sticky"))?.connectionId, ids.p1, "the session is not moved");
  assert.equal((await select("s-new"))?.connectionId, ids.p2, "a new session follows the ranking");
});

test("(7) manual pin wins; a GPT/Codex request never touches the Claude pool", async () => {
  const ids = await seedAcceptancePool();
  const codexId = (
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "codex-only",
      accessToken: "synthetic-codex",
      isActive: true,
      testStatus: "active",
    })
  ).id as string;
  const pinned = await select("s-manual", {
    forcedConnectionId: ids.p1,
    strictForcedConnection: true,
  });
  assert.equal(pinned?.connectionId, ids.p1);
  const codex = await auth.getProviderCredentials("codex", null, null, "gpt-6.2-sol", {
    sessionKey: "s-manual",
  });
  assert.equal(codex?.connectionId, codexId);
  assert.equal(
    ranking.getLastAccountSelectionRanking("codex"),
    null,
    "(12) Codex stays on its strategy"
  );
});

test("(8) simultaneous requests: one pin per session, first writer wins", async () => {
  const ids = await seedAcceptancePool();
  const same = await Promise.all(Array.from({ length: 12 }, () => select("s-parallel")));
  assert.equal(new Set(same.map((c) => c?.connectionId)).size, 1);
  assert.equal(
    affinityDb.getSessionAccountAffinity("s-parallel", "claude", TTL)?.connectionId,
    same[0]?.connectionId
  );
  const different = await Promise.all(Array.from({ length: 8 }, (_, i) => select(`s-par-${i}`)));
  assert.ok(different.every((c) => c?.connectionId === ids.p2));

  // Atomic claim: a later writer for the same session gets the existing pin back.
  assert.equal(
    affinityDb.claimSessionAccountAffinity("s-claim", "claude", ids.p1, Date.now(), TTL),
    ids.p1
  );
  assert.equal(
    affinityDb.claimSessionAccountAffinity("s-claim", "claude", ids.p2, Date.now(), TTL),
    ids.p1
  );
});

test("(9) renewal with active sessions: pins re-evaluate only on real exhaustion", async () => {
  const ids = await seedAcceptancePool();
  assert.equal((await select("s-active"))?.connectionId, ids.p2);
  // The pinned account hits its 5h limit (future reset): real event → session moves.
  quotaCache.setQuotaCache(ids.p2, "claude", {
    "session (5h)": { remainingPercentage: 0, resetAt: at(2 * H) },
    "weekly (7d)": { remainingPercentage: 40, resetAt: at(17.5 * H) },
  });
  assert.equal((await select("s-active"))?.connectionId, ids.p1);
  // bd7bc37c-like account renews its weekly window: it becomes eligible again.
  quotaCache.setQuotaCache(ids.p4, "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 100, resetAt: at(7 * 24 * H) },
  });
  quotaCache.setQuotaCache(ids.p2, "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 40, resetAt: at(17.5 * H) },
  });
  assert.equal(
    (await select("s-active"))?.connectionId,
    ids.p1,
    "moved session does not bounce back"
  );
  assert.equal((await select("s-fresh"))?.connectionId, ids.p2, "new sessions follow the ranking");
  const order = ranking
    .getLastAccountSelectionRanking("claude")
    ?.ordered.map((d) => d.connectionId);
  assert.deepEqual(order, [ids.p2, ids.p1, ids.p4]);
});

test("(10) without any reading the pool degrades to the configured priority (tier B)", async () => {
  const ids = await seedAcceptancePool();
  quotaCache.__clearForTests();
  // Snapshots on disk would rebuild the cache; this pool has none for a fresh DB copy.
  core.getDbInstance().prepare("DELETE FROM quota_snapshots").run();
  const creds = await select("s-unknown");
  assert.equal(creds?.connectionId, ids.p1);
  assert.match(String(creds?.accountSelection), /tier=B; pos=1\/3; reason=quota_missing/);
});

test("(13) pins persist in SQLite across a router restart", async () => {
  const ids = await seedAcceptancePool();
  assert.equal((await select("s-restart"))?.connectionId, ids.p2);
  core.resetDbInstance();
  quotaCache.__clearForTests();
  ranking.__resetQuotaRenewalRankingForTests();
  assert.equal(
    affinityDb.getSessionAccountAffinity("s-restart", "claude", TTL)?.connectionId,
    ids.p2
  );
  assert.equal((await select("s-restart"))?.connectionId, ids.p2);
});

test("sliding TTL: an idle pin expires and the session is re-evaluated", async () => {
  const ids = await seedAcceptancePool();
  const t0 = Date.now();
  affinityDb.upsertSessionAccountAffinity("s-ttl", "claude", ids.p1, t0 - TTL - 1, TTL);
  assert.equal(affinityDb.getSessionAccountAffinity("s-ttl", "claude", TTL, t0), null);
  assert.equal((await select("s-ttl"))?.connectionId, ids.p2);
});

test("only the full pool of a normal selection is published as the last decision", async () => {
  const ids = await seedAcceptancePool();
  await select("s-full");
  const persisted = () => {
    const row = core
      .getDbInstance()
      .prepare(
        "SELECT value FROM key_value WHERE namespace = 'account_selection_ranking' AND key = 'claude'"
      )
      .get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as { ordered: Array<{ connectionId: string }> }) : null;
  };
  const full = [ids.p2, ids.p1];
  assert.deepEqual(
    ranking.getLastAccountSelectionRanking("claude")?.ordered.map((d) => d.connectionId),
    full
  );
  assert.deepEqual(
    persisted()?.ordered.map((d) => d.connectionId),
    full
  );

  // A retry that excluded an account or an operator pin narrows the pool: neither may replace
  // the published "next session / reserve".
  ranking.__resetQuotaRenewalRankingForTests();
  await select("s-retry", { excludeConnectionIds: [ids.p2] });
  await select("s-forced", { forcedConnectionId: ids.p1, strictForcedConnection: true });
  assert.equal(ranking.getLastAccountSelectionRanking("claude"), null);
  assert.deepEqual(
    persisted()?.ordered.map((d) => d.connectionId),
    full
  );
  // A pinned session still ranks the full pool, so it publishes the full order.
  await select("s-full");
  assert.deepEqual(
    ranking.getLastAccountSelectionRanking("claude")?.ordered.map((d) => d.connectionId),
    full
  );
});
