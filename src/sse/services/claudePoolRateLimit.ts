/**
 * Per-account verdict behind the Claude continuity model fallback (see
 * src/sse/handlers/claudeModelFallback.ts): when account selection finds no account for a model,
 * is every account of the pool unavailable for that model only because of a rate limit or an
 * exhausted quota?
 *
 * The status of the last failed attempt cannot answer this: one account may be down with a 503
 * while the last one answered 429. Each account is judged on the state the request path recorded
 * for it. A 429 cooldown, a rate-limit or quota lock of this model, or an exhausted usage window
 * counts; a cooldown left by any other status, a terminal state, or no recorded state at all (an
 * account skipped for local capacity, or with cooling disabled) means it is not a rate limit.
 */

import { getModelLockoutInfo } from "@omniroute/open-sse/services/accountFallback.ts";

const RATE_LIMIT_LOCK_REASONS = new Set(["quota_exhausted", "rate_limit_exceeded", "rate_limited"]);
const TERMINAL_STATUSES = new Set(["credits_exhausted", "banned", "expired"]);

type PoolConnection = {
  id: string;
  rateLimitedUntil?: string | null;
  errorCode?: unknown;
  testStatus?: string | null;
};

export type PoolRateLimit = {
  /** Every account is unavailable for the model only because of a rate limit or quota. */
  allRateLimited: boolean;
  /** First instant at which some account has no remaining limit, when every end is known. */
  eligibleAt: string | null;
};

function futureMs(value: string | null | undefined): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > Date.now() ? ms : null;
}

/** When this account is free of every rate limit, `null` if unknown, `false` if not rate-limited. */
function rateLimitedUntil(
  connection: PoolConnection,
  provider: string,
  model: string | null,
  quotaResetAt: Map<string, string | null>
): number | null | false {
  if (TERMINAL_STATUSES.has(String(connection.testStatus ?? "").toLowerCase())) return false;
  const ends: Array<number | null> = [];
  const cooldown = futureMs(connection.rateLimitedUntil);
  if (cooldown !== null) {
    if (Number(connection.errorCode) !== 429) return false;
    ends.push(cooldown);
  }
  const lock = model ? getModelLockoutInfo(provider, connection.id, model) : null;
  if (lock && lock.remainingMs > 0) {
    if (!RATE_LIMIT_LOCK_REASONS.has(lock.reason)) return false;
    ends.push(Date.now() + lock.remainingMs);
  }
  if (quotaResetAt.has(connection.id)) ends.push(futureMs(quotaResetAt.get(connection.id)));
  if (ends.length === 0) return false;
  return ends.includes(null) ? null : Math.max(...(ends as number[]));
}

export function describePoolRateLimit(
  connections: PoolConnection[],
  provider: string,
  model: string | null,
  quotaResetAt: Map<string, string | null> = new Map()
): PoolRateLimit {
  const ends = connections.map((connection) =>
    rateLimitedUntil(connection, provider, model, quotaResetAt)
  );
  const allRateLimited = ends.length > 0 && ends.every((end) => end !== false);
  const known = ends.filter((end): end is number => typeof end === "number");
  return {
    allRateLimited,
    eligibleAt:
      allRateLimited && known.length === ends.length
        ? new Date(Math.min(...known)).toISOString()
        : null,
  };
}
