/**
 * EARLIEST_QUOTA_RENEWAL_FIRST — pure ranking (src/sse/services/quotaRenewalRanking.ts).
 * Every date is derived from a fixed `now`, so the suite never depends on the wall clock.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  rankByEarliestQuotaRenewal,
  assessQuotaWindow,
  applyEarliestQuotaRenewal,
  describeSelection,
  QUOTA_RENEWAL_FRESH_MS,
} = await import("../../src/sse/services/quotaRenewalRanking.ts");

const NOW = Date.parse("2026-11-21T21:30:00.000Z");
const H = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

type Win = { remainingPercentage: number | null; resetAt: string | null; exhausted?: boolean };
function reading(windows: Record<string, Win>, ageMs = 60_000, live = true) {
  return { fetchedAtMs: NOW - ageMs, live, windows };
}
const rank = (
  candidates: Parameters<typeof rankByEarliestQuotaRenewal>[0],
  model = "claude-opus-5-5"
) => rankByEarliestQuotaRenewal(candidates, { now: NOW, requestedModel: model });

// Real shape of the pool on 2026-11-21 (quota_snapshots / quotaCache), relative to NOW.
function acceptancePool() {
  return [
    {
      id: "6726837b",
      priority: 1,
      // weekly 86 %, reset in ~6.4 days; live reading omits five_hour (no session open)
      reading: reading({ "weekly (7d)": { remainingPercentage: 86, resetAt: iso(152.5 * H) } }),
    },
    {
      id: "598035c1",
      priority: 2,
      reading: reading({
        "session (5h)": { remainingPercentage: 100, resetAt: null },
        "weekly (7d)": { remainingPercentage: 56, resetAt: iso(17.5 * H) },
      }),
    },
    {
      id: "bd7bc37c",
      priority: 4,
      reading: reading({ "weekly (7d)": { remainingPercentage: 0, resetAt: iso(32.5 * H) } }),
    },
  ];
}

test("acceptance: 598035c1 (earliest weekly reset with balance) first, bd7bc37c out", () => {
  const result = rank(acceptancePool());
  assert.deepEqual(
    result.ordered.map((d) => d.connectionId),
    ["598035c1", "6726837b"]
  );
  assert.equal(result.ordered[0].tier, "A");
  assert.equal(result.ordered[0].limitingWindow, "weekly");
  assert.equal(result.ordered[0].resetAt, iso(17.5 * H));
  assert.equal(result.ordered[0].fiveHour.state, "idle");
  assert.equal(
    result.ordered[1].tier,
    "A",
    "five_hour omitted by a live reading = no session open"
  );
  assert.deepEqual(
    result.excluded.map((d) => [d.connectionId, d.reason]),
    [["bd7bc37c", "weekly_exhausted"]]
  );
  assert.equal(result.excluded[0].position, null);
});

test("(1) earliest reset with balance wins over configured priority and over larger balance", () => {
  const result = rank([
    {
      id: "late",
      priority: 1,
      reading: reading({ "weekly (7d)": { remainingPercentage: 99, resetAt: iso(100 * H) } }),
    },
    {
      id: "soon",
      priority: 9,
      reading: reading({ "weekly (7d)": { remainingPercentage: 3, resetAt: iso(2 * H) } }),
    },
  ]);
  assert.equal(result.ordered[0].connectionId, "soon");
});

test("(2) earliest reset but exhausted is out until it renews", () => {
  const result = rank([
    {
      id: "soon-empty",
      priority: 1,
      reading: reading({ "weekly (7d)": { remainingPercentage: 0, resetAt: iso(1 * H) } }),
    },
    {
      id: "later",
      priority: 2,
      reading: reading({ "weekly (7d)": { remainingPercentage: 40, resetAt: iso(50 * H) } }),
    },
  ]);
  assert.deepEqual(
    result.ordered.map((d) => d.connectionId),
    ["later"]
  );
  assert.equal(result.excluded[0].reason, "weekly_exhausted");
  // Once the reset passes the old reading is no longer proof of exhaustion: uncertain (B), not out.
  const after = rankByEarliestQuotaRenewal(
    [
      {
        id: "soon-empty",
        priority: 1,
        reading: reading({ "weekly (7d)": { remainingPercentage: 0, resetAt: iso(1 * H) } }),
      },
    ],
    { now: NOW + 2 * H }
  );
  assert.equal(after.ordered[0].tier, "B");
  assert.equal(after.ordered[0].reason, "quota_stale");
});

test("(3) 5h exhausted with weekly balance is out; a passed 5h reset counts as available", () => {
  const pool = [
    {
      id: "best-weekly",
      priority: 1,
      reading: reading({
        "session (5h)": { remainingPercentage: 0, resetAt: iso(0.5 * H) },
        "weekly (7d)": { remainingPercentage: 50, resetAt: iso(5 * H) },
      }),
    },
    {
      id: "other",
      priority: 2,
      reading: reading({ "weekly (7d)": { remainingPercentage: 50, resetAt: iso(90 * H) } }),
    },
  ];
  const now = rank(pool);
  assert.deepEqual(
    now.ordered.map((d) => d.connectionId),
    ["other"]
  );
  assert.equal(now.excluded[0].reason, "five_hour_exhausted");
  assert.equal(now.excluded[0].limitingWindow, "5h");

  const later = rankByEarliestQuotaRenewal(
    pool.map((c) => ({ ...c, reading: { ...c.reading, fetchedAtMs: NOW + 0.6 * H - 60_000 } })),
    { now: NOW + 0.6 * H }
  );
  assert.equal(later.ordered[0].connectionId, "best-weekly");
  assert.equal(later.ordered[0].fiveHour.state, "reset_passed");
});

test("(10) missing, stale and contradictory data are tier B (behind A, by priority), never out", () => {
  const result = rank([
    { id: "missing", priority: 1, reading: null },
    {
      id: "stale",
      priority: 2,
      reading: reading(
        { "weekly (7d)": { remainingPercentage: 90, resetAt: iso(1 * H) } },
        QUOTA_RENEWAL_FRESH_MS + 1
      ),
    },
    {
      id: "contradictory",
      priority: 3,
      reading: reading({
        "weekly (7d)": { remainingPercentage: 40, resetAt: iso(1 * H), exhausted: true },
      }),
    },
    {
      id: "no-reset",
      priority: 4,
      reading: reading({ "weekly (7d)": { remainingPercentage: 40, resetAt: null } }),
    },
    {
      id: "past-reset",
      priority: 5,
      reading: reading({ "weekly (7d)": { remainingPercentage: 40, resetAt: iso(-1 * H) } }),
    },
    {
      id: "no-weekly",
      priority: 6,
      reading: reading({ "session (5h)": { remainingPercentage: 80, resetAt: iso(1 * H) } }),
    },
    {
      id: "healthy",
      priority: 99,
      reading: reading({ "weekly (7d)": { remainingPercentage: 10, resetAt: iso(150 * H) } }),
    },
  ]);
  assert.equal(result.excluded.length, 0);
  assert.deepEqual(
    result.ordered.map((d) => [d.connectionId, d.tier, d.reason]),
    [
      ["healthy", "A", "weekly_usable_earliest_reset"],
      ["missing", "B", "quota_missing"],
      ["stale", "B", "quota_stale"],
      ["contradictory", "B", "weekly_contradictory"],
      ["no-reset", "B", "weekly_contradictory"],
      ["past-reset", "B", "weekly_reset_passed"],
      ["no-weekly", "B", "weekly_missing"],
    ]
  );
  assert.equal(result.ordered[1].freshness, "missing");
  assert.equal(result.ordered[2].freshness, "stale");
});

test("a snapshot-rebuilt (non-live) reading without the 5h window is uncertain", () => {
  const result = rank([
    {
      id: "rebuilt",
      priority: 1,
      reading: reading(
        { "weekly (7d)": { remainingPercentage: 70, resetAt: iso(3 * H) } },
        60_000,
        false
      ),
    },
  ]);
  assert.equal(result.ordered[0].tier, "B");
  assert.equal(result.ordered[0].reason, "five_hour_missing");
});

test("ties in tier A: more 5h headroom, then configured priority", () => {
  const reset = iso(10 * H);
  const result = rank([
    {
      id: "p1-low-5h",
      priority: 1,
      reading: reading({
        "session (5h)": { remainingPercentage: 20, resetAt: iso(1 * H) },
        "weekly (7d)": { remainingPercentage: 60, resetAt: reset },
      }),
    },
    {
      id: "p3-idle",
      priority: 3,
      reading: reading({
        "session (5h)": { remainingPercentage: 100, resetAt: null },
        "weekly (7d)": { remainingPercentage: 60, resetAt: reset },
      }),
    },
    {
      id: "p2-idle",
      priority: 2,
      reading: reading({ "weekly (7d)": { remainingPercentage: 60, resetAt: reset } }),
    },
  ]);
  assert.deepEqual(
    result.ordered.map((d) => d.connectionId),
    ["p2-idle", "p3-idle", "p1-low-5h"]
  );
});

test("model-scoped weekly window limits only the matching model", () => {
  const pool = [
    {
      id: "opus-empty",
      priority: 1,
      reading: reading({
        "weekly (7d)": { remainingPercentage: 80, resetAt: iso(2 * H) },
        "weekly opus (7d)": { remainingPercentage: 0, resetAt: iso(3 * H) },
      }),
    },
    {
      id: "plain",
      priority: 2,
      reading: reading({ "weekly (7d)": { remainingPercentage: 80, resetAt: iso(50 * H) } }),
    },
  ];
  assert.equal(rank(pool, "claude-opus-5-5").ordered[0].connectionId, "plain");
  assert.equal(rank(pool, "claude-fable-5-2").ordered[0].connectionId, "opus-empty");
});

test("assessQuotaWindow states", () => {
  assert.equal(
    assessQuotaWindow("w", { remainingPercentage: 50, resetAt: iso(H) }, NOW).state,
    "ok"
  );
  assert.equal(
    assessQuotaWindow("w", { remainingPercentage: 100, resetAt: null }, NOW).state,
    "idle"
  );
  assert.equal(
    assessQuotaWindow("w", { remainingPercentage: 0, resetAt: iso(H) }, NOW).state,
    "exhausted"
  );
  assert.equal(
    assessQuotaWindow("w", { remainingPercentage: 0, resetAt: null }, NOW).state,
    "contradictory"
  );
  assert.equal(
    assessQuotaWindow("w", { remainingPercentage: 10, resetAt: "not-a-date" }, NOW).state,
    "contradictory"
  );
  assert.equal(
    assessQuotaWindow(
      "w",
      { remainingPercentage: 0, resetAt: iso(H), fractionReported: false },
      NOW
    ).state,
    "unknown"
  );
  assert.equal(assessQuotaWindow(null, undefined, NOW).state, "absent");
});

test("applyEarliestQuotaRenewal keeps the input pool when every candidate is out", () => {
  const connections = [
    { id: "a", priority: 1 },
    { id: "b", priority: 2 },
  ];
  const readings: Record<string, ReturnType<typeof reading>> = {
    a: reading({ "weekly (7d)": { remainingPercentage: 0, resetAt: iso(H) } }),
    b: reading({
      "session (5h)": { remainingPercentage: 0, resetAt: iso(H) },
      "weekly (7d)": { remainingPercentage: 9, resetAt: iso(9 * H) },
    }),
  };
  const selection = applyEarliestQuotaRenewal("claude-test", connections, "claude-opus-5-5", {
    now: NOW,
    read: (id) => readings[id],
  });
  assert.equal(selection.ranking.ordered.length, 0);
  assert.deepEqual(
    selection.pool.map((c) => c.id),
    ["a", "b"],
    "existing pipeline keeps its behaviour"
  );
});

test("selection description is short, ASCII and credential-free", () => {
  const result = rank(acceptancePool());
  const text = describeSelection(result, "598035c1");
  assert.match(
    text,
    /^EARLIEST_QUOTA_RENEWAL_FIRST; tier=A; pos=1\/2; reason=weekly_usable_earliest_reset; window=weekly; reset=/
  );
  assert.match(text, /^[\x20-\x7e]+$/);
  assert.match(
    describeSelection(result, "bd7bc37c"),
    /tier=out; pos=-\/2; reason=weekly_exhausted/
  );
});
