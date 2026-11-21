/**
 * EARLIEST_QUOTA_RENEWAL_FIRST — account ranking by the earliest usable quota renewal.
 *
 * Leaf module (kept out of the frozen `auth.ts`). Given the connections that already
 * passed every existing filter in `getProviderCredentials` (model rules, active,
 * terminal status, cooldown, model lockout, quota policy, API-key allowlist), it orders
 * them so the account whose usable quota renews soonest is used first:
 *
 * - Tier A: a fresh reading (≤ QUOTA_RENEWAL_FRESH_MS) with usable weekly headroom and an
 *   available 5h window (idle, with headroom, or whose 5h reset already passed). Ordered
 *   by the limiting weekly window's reset (earliest first), then 5h headroom, then the
 *   configured priority.
 * - Tier B: uncertain data (no reading, stale reading, weekly window missing, weekly reset
 *   in the past, or a contradictory window). Still eligible, always behind A, ordered by
 *   the configured priority. Missing data is never treated as zero nor as a full balance.
 * - Out: weekly or 5h window exhausted with a future reset. Usage only grows inside a
 *   window, so this holds even for an old reading; the 5h case clears itself once the reset
 *   passes. When every candidate is out, callers keep their previous behaviour (honest 429
 *   / Retry-After from the existing pipeline).
 *
 * A live reading that carries the weekly window but omits the 5h one means no 5h session
 * is open (Anthropic's /api/oauth/usage reports `five_hour` only while a window runs) —
 * the same semantics as `scripts/ops/omniroute-observability/aggregate.mjs::windowReading`.
 *
 * Dates are always compared with the injected `now`; nothing here is hardcoded.
 */

import { getQuotaCache } from "@/domain/quotaCache";

export const EARLIEST_QUOTA_RENEWAL_STRATEGY = "earliest-quota-renewal";
export const EARLIEST_QUOTA_RENEWAL_POLICY = "EARLIEST_QUOTA_RENEWAL_FIRST";
/**
 * Freshness limit. Measured cadence on the production DB (2026-11-21): live readings land
 * every 5–6 min (quotaCache ACTIVE_TTL 5 min + 1 min tick) plus on-demand refreshes; 10 min
 * is two cadences and matches QUOTA_FRESH_MS in the observability aggregate.
 */
export const QUOTA_RENEWAL_FRESH_MS = 10 * 60_000;

export type QuotaRenewalTier = "A" | "B" | "out";
export type QuotaFreshness = "fresh" | "stale" | "missing";
export type QuotaWindowState =
  "ok" | "idle" | "exhausted" | "reset_passed" | "unknown" | "contradictory" | "absent";

export interface QuotaWindowReading {
  remainingPercentage: number | null | undefined;
  resetAt: string | null | undefined;
  /** false = upstream explicitly did not report this window's fraction. */
  fractionReported?: boolean;
  /** Optional per-window exhaustion flag (e.g. quota_snapshots.is_exhausted). */
  exhausted?: boolean;
}

export interface QuotaRenewalReading {
  fetchedAtMs: number | null;
  /** true when the entry came from a live vendor fetch (not rebuilt from snapshots). */
  live: boolean;
  windows: Record<string, QuotaWindowReading>;
}

export interface QuotaRenewalCandidate {
  id: string;
  priority?: number | null;
  reading: QuotaRenewalReading | null;
}

export interface QuotaWindowAssessment {
  window: string | null;
  state: QuotaWindowState;
  remainingPercentage: number | null;
  resetAt: string | null;
}

export interface QuotaRenewalDecision {
  connectionId: string;
  tier: QuotaRenewalTier;
  /** 1-based position among eligible accounts; null when out. */
  position: number | null;
  limitingWindow: "weekly" | "5h" | null;
  resetAt: string | null;
  remainingPercentage: number | null;
  weekly: QuotaWindowAssessment;
  fiveHour: QuotaWindowAssessment;
  freshness: QuotaFreshness;
  dataAgeMs: number | null;
  priority: number | null;
  reason: string;
}

export interface QuotaRenewalRanking {
  policy: typeof EARLIEST_QUOTA_RENEWAL_POLICY;
  evaluatedAt: string;
  requestedModel: string | null;
  /** Tier A then tier B, best first. */
  ordered: QuotaRenewalDecision[];
  excluded: QuotaRenewalDecision[];
}

export interface RankOptions {
  now?: number;
  freshnessMs?: number;
  requestedModel?: string | null;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isFiveHourWindow(name: string): boolean {
  const n = normalizeName(name);
  return n === "session 5h" || n === "session" || n === "5h" || n === "five hour";
}

/** "weekly 7d" (generic) or "weekly <scope> 7d" (model-scoped, e.g. opus). */
function weeklyScope(name: string): string | null | undefined {
  const n = normalizeName(name);
  if (n === "weekly 7d" || n === "weekly" || n === "seven day") return null;
  const match = /^weekly (.+) 7d$/.exec(n);
  return match ? match[1] : undefined;
}

function applicableWeeklyWindows(
  windows: Record<string, QuotaWindowReading>,
  requestedModel: string | null
): string[] {
  const model = (requestedModel || "").toLowerCase();
  return Object.keys(windows).filter((name) => {
    const scope = weeklyScope(name);
    if (scope === undefined) return false;
    if (scope === null) return true;
    return model.length > 0 && model.includes(scope);
  });
}

/** null for no value, NaN for an unparseable one. */
function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function assessQuotaWindow(
  name: string | null,
  reading: QuotaWindowReading | undefined,
  now: number
): QuotaWindowAssessment {
  if (!name || !reading) {
    return { window: name, state: "absent", remainingPercentage: null, resetAt: null };
  }
  const rawRemaining = reading.remainingPercentage;
  const remaining =
    typeof rawRemaining === "number" && Number.isFinite(rawRemaining)
      ? Math.max(0, Math.min(100, rawRemaining))
      : null;
  const resetAt = reading.resetAt || null;
  const base = { window: name, remainingPercentage: remaining, resetAt };
  if (reading.fractionReported === false || remaining === null) {
    return { ...base, state: "unknown" };
  }
  const resetMs = parseMs(resetAt);
  if (Number.isNaN(resetMs)) return { ...base, state: "contradictory" };
  if (typeof reading.exhausted === "boolean" && reading.exhausted !== remaining <= 0) {
    return { ...base, state: "contradictory" };
  }
  if (resetMs !== null && resetMs <= now) return { ...base, state: "reset_passed" };
  if (remaining <= 0) {
    return { ...base, state: resetMs !== null ? "exhausted" : "contradictory" };
  }
  if (resetMs !== null) return { ...base, state: "ok" };
  // No reset: an untouched window (100%) is idle; a used one without a reset is inconsistent.
  return { ...base, state: remaining >= 100 ? "idle" : "contradictory" };
}

/** The weekly window that actually limits capacity: least remaining, then earliest reset. */
function pickLimitingWeekly(assessments: QuotaWindowAssessment[]): QuotaWindowAssessment {
  const rank = (a: QuotaWindowAssessment) =>
    a.state === "exhausted" ? 0 : a.state === "ok" || a.state === "idle" ? 2 : 1;
  return [...assessments].sort((a, b) => {
    const tier = rank(a) - rank(b);
    if (tier !== 0) return tier;
    const remaining = (a.remainingPercentage ?? 101) - (b.remainingPercentage ?? 101);
    if (remaining !== 0) return remaining;
    return (parseMs(a.resetAt) || Infinity) - (parseMs(b.resetAt) || Infinity);
  })[0];
}

function priorityOf(candidate: QuotaRenewalCandidate): number {
  return Number.isFinite(candidate.priority) && Number(candidate.priority) > 0
    ? Number(candidate.priority)
    : 999;
}

function fiveHourHeadroom(assessment: QuotaWindowAssessment): number {
  if (assessment.state === "ok") return assessment.remainingPercentage ?? 0;
  return 100; // idle, reset_passed or omitted by a live reading: a full window is available
}

function decide(
  candidate: QuotaRenewalCandidate,
  now: number,
  freshnessMs: number,
  requestedModel: string | null
): QuotaRenewalDecision {
  const reading = candidate.reading;
  const priority = Number.isFinite(candidate.priority) ? Number(candidate.priority) : null;
  const dataAgeMs =
    reading && reading.fetchedAtMs !== null ? Math.max(0, now - reading.fetchedAtMs) : null;
  const freshness: QuotaFreshness =
    !reading || dataAgeMs === null ? "missing" : dataAgeMs <= freshnessMs ? "fresh" : "stale";
  const windows = reading?.windows ?? {};
  const fiveHourName = Object.keys(windows).find(isFiveHourWindow) ?? null;
  const fiveHour = assessQuotaWindow(
    fiveHourName,
    fiveHourName ? windows[fiveHourName] : undefined,
    now
  );
  const weeklyNames = applicableWeeklyWindows(windows, requestedModel);
  const weekly =
    weeklyNames.length > 0
      ? pickLimitingWeekly(weeklyNames.map((name) => assessQuotaWindow(name, windows[name], now)))
      : assessQuotaWindow(null, undefined, now);

  const result = (
    tier: QuotaRenewalTier,
    reason: string,
    limiting: QuotaWindowAssessment | null
  ): QuotaRenewalDecision => ({
    connectionId: candidate.id,
    tier,
    position: null,
    limitingWindow: limiting === weekly ? "weekly" : limiting === fiveHour ? "5h" : null,
    resetAt: limiting?.resetAt ?? null,
    remainingPercentage: limiting?.remainingPercentage ?? null,
    weekly,
    fiveHour,
    freshness,
    dataAgeMs,
    priority,
    reason,
  });

  // Out first: exhaustion with a future reset holds even for an old reading.
  if (weekly.state === "exhausted") return result("out", "weekly_exhausted", weekly);
  if (fiveHour.state === "exhausted") return result("out", "five_hour_exhausted", fiveHour);

  if (!reading) return result("B", "quota_missing", null);
  if (freshness !== "fresh") return result("B", "quota_stale", weekly.window ? weekly : null);
  if (weekly.state === "absent") return result("B", "weekly_missing", null);
  if (weekly.state !== "ok" && weekly.state !== "idle") {
    return result("B", `weekly_${weekly.state}`, weekly);
  }
  if (fiveHour.state === "absent" && !reading.live) {
    return result("B", "five_hour_missing", weekly);
  }
  if (fiveHour.state === "unknown" || fiveHour.state === "contradictory") {
    return result("B", `five_hour_${fiveHour.state}`, weekly);
  }
  return result("A", "weekly_usable_earliest_reset", weekly);
}

/** Pure ranking. Never mutates its input. */
export function rankByEarliestQuotaRenewal(
  candidates: QuotaRenewalCandidate[],
  options: RankOptions = {}
): QuotaRenewalRanking {
  const now = options.now ?? Date.now();
  const freshnessMs = options.freshnessMs ?? QUOTA_RENEWAL_FRESH_MS;
  const requestedModel = options.requestedModel ?? null;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const decisions = candidates.map((candidate) =>
    decide(candidate, now, freshnessMs, requestedModel)
  );
  const tiebreak = (a: QuotaRenewalDecision, b: QuotaRenewalDecision) => {
    const priority = priorityOf(byId.get(a.connectionId)!) - priorityOf(byId.get(b.connectionId)!);
    return priority !== 0 ? priority : a.connectionId.localeCompare(b.connectionId);
  };
  const tierA = decisions
    .filter((decision) => decision.tier === "A")
    .sort((a, b) => {
      const reset =
        (parseMs(a.resetAt) || Number.MAX_SAFE_INTEGER) -
        (parseMs(b.resetAt) || Number.MAX_SAFE_INTEGER);
      if (reset !== 0) return reset;
      const headroom = fiveHourHeadroom(b.fiveHour) - fiveHourHeadroom(a.fiveHour);
      if (headroom !== 0) return headroom;
      return tiebreak(a, b);
    });
  const tierB = decisions.filter((decision) => decision.tier === "B").sort(tiebreak);
  const ordered = [...tierA, ...tierB].map((decision, index) => ({
    ...decision,
    position: index + 1,
  }));
  const excluded = decisions.filter((decision) => decision.tier === "out").sort(tiebreak);
  return {
    policy: EARLIEST_QUOTA_RENEWAL_POLICY,
    evaluatedAt: new Date(now).toISOString(),
    requestedModel,
    ordered,
    excluded,
  };
}

/** Reads the shared in-memory quota cache (live fetches and snapshot hydration). */
export function readQuotaRenewalReading(connectionId: string): QuotaRenewalReading | null {
  const entry = getQuotaCache(connectionId) as {
    fetchedAt?: number;
    observedLive?: boolean;
    quotas?: Record<string, QuotaWindowReading>;
  } | null;
  if (!entry || !entry.quotas) return null;
  const fetchedAtMs = Number.isFinite(entry.fetchedAt) ? Number(entry.fetchedAt) : null;
  // A 429-sourced placeholder (no windows) says nothing about the renewal dates.
  if (Object.keys(entry.quotas).length === 0) return null;
  return { fetchedAtMs, live: entry.observedLive === true, windows: entry.quotas };
}

export function isEarliestQuotaRenewalStrategy(strategy: unknown): boolean {
  return strategy === EARLIEST_QUOTA_RENEWAL_STRATEGY;
}

export interface EarliestRenewalSelection<T extends { id: string }> {
  ranking: QuotaRenewalRanking;
  /** Eligible connections in ranking order; the input order when nothing is eligible. */
  pool: T[];
  /** Short, credential-free summary for `X-OmniRoute-Account-Selection`. */
  describe: (connectionId: string) => string;
}

/**
 * Applies the ranking to the connections `getProviderCredentials` already filtered.
 * When every candidate is out, the pool stays as given so the existing pipeline keeps
 * its current behaviour (upstream 429, cooldown and the honest Retry-After).
 */
export function applyEarliestQuotaRenewal<T extends { id: string; priority?: number | null }>(
  provider: string,
  connections: T[],
  requestedModel: string | null,
  options: { now?: number; read?: (connectionId: string) => QuotaRenewalReading | null } = {}
): EarliestRenewalSelection<T> {
  const read = options.read ?? readQuotaRenewalReading;
  const ranking = rankByEarliestQuotaRenewal(
    connections.map((connection) => ({
      id: connection.id,
      priority: connection.priority ?? null,
      reading: read(connection.id),
    })),
    { now: options.now, requestedModel }
  );
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const ranked = ranking.ordered.map((decision) => byId.get(decision.connectionId)!);
  const pool = ranked.length > 0 ? ranked : connections;
  recordAccountSelectionRanking(provider, ranking);
  return {
    ranking,
    pool,
    describe: (connectionId) => describeSelection(ranking, connectionId),
  };
}

export function describeSelection(ranking: QuotaRenewalRanking, connectionId: string): string {
  const decision =
    ranking.ordered.find((entry) => entry.connectionId === connectionId) ??
    ranking.excluded.find((entry) => entry.connectionId === connectionId);
  if (!decision) return `${EARLIEST_QUOTA_RENEWAL_POLICY}; outside-ranking`;
  const parts = [
    EARLIEST_QUOTA_RENEWAL_POLICY,
    `tier=${decision.tier}`,
    `pos=${decision.position ?? "-"}/${ranking.ordered.length}`,
    `reason=${decision.reason}`,
  ];
  if (decision.limitingWindow) parts.push(`window=${decision.limitingWindow}`);
  if (decision.resetAt) parts.push(`reset=${decision.resetAt}`);
  return parts.join("; ");
}

// ─── Last ranking per provider (observability, process-local) ─────────────────

interface RankingState {
  last: Map<string, QuotaRenewalRanking>;
}

declare global {
  var __omnirouteQuotaRenewalRankingState: RankingState | undefined;
}

function rankingState(): RankingState {
  if (!globalThis.__omnirouteQuotaRenewalRankingState) {
    globalThis.__omnirouteQuotaRenewalRankingState = { last: new Map() };
  }
  return globalThis.__omnirouteQuotaRenewalRankingState;
}

export function recordAccountSelectionRanking(provider: string, ranking: QuotaRenewalRanking) {
  rankingState().last.set(provider, ranking);
}

export function getLastAccountSelectionRanking(provider: string): QuotaRenewalRanking | null {
  return rankingState().last.get(provider) ?? null;
}

export function __resetQuotaRenewalRankingForTests() {
  rankingState().last.clear();
}
