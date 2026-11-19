import { isModelExcludedByConnection } from "@/domain/connectionModelRules";
import { getRawProviderConnections } from "@/lib/db/providers";
import { getModelLockoutInfo } from "@omniroute/open-sse/services/accountFallback.ts";

const QUOTA_LOCKS = new Set(["quota_exhausted", "rate_limit_exceeded", "rate_limited"]);
const TERMINAL_STATES = new Set(["credits_exhausted", "banned", "expired"]);
export type TerminalReason = "accounts_rate_limited" | "accounts_unavailable";

export function canExhaustClaudeAccount(status: number): boolean {
  return [401, 402, 403, 408, 429].includes(status) || (status >= 500 && status <= 599);
}

/** Only real account evidence counts, not the last error or a null selector result. */
export async function describeClaudeTerminalPool(
  model: string,
  allowedIds: string[],
  attempts: ReadonlyMap<string, number>,
  poolRateLimited: boolean
): Promise<TerminalReason | null> {
  const rows = (
    await getRawProviderConnections({ provider: "claude" }, undefined, undefined, [
      "id",
      "is_active",
      "test_status",
      "error_code",
      "last_error",
      "rate_limited_until",
      "provider_specific_data",
    ])
  ).filter(
    (row) =>
      allowedIds.includes(String(row.id)) &&
      !isModelExcludedByConnection(model, row.providerSpecificData)
  );
  // An empty/misconfigured pool is not an outage. Do not turn revoked access into failover.
  if (rows.length === 0) return null;
  const statuses = rows.map((row) => {
    const attempted = attempts.get(String(row.id));
    if (attempted !== undefined) return attempted;
    if (TERMINAL_STATES.has(String(row.testStatus))) return 401;
    if (!row.isActive) return 0;
    const status = Number(row.errorCode);
    if (Date.parse(String(row.rateLimitedUntil)) > Date.now()) {
      // Quarantines left by local limiter failures are not upstream evidence.
      if (
        /RATE_LIMIT_(?:QUEUE|EXECUTION)|semaphore|renewal|proxy_unreachable|timeout/i.test(
          String(row.lastError ?? "")
        )
      )
        return 0;
      // Persisted 5xx does not distinguish a gateway timeout or proxy failure
      // from an upstream HTTP response. Require request-scoped provenance for it.
      if ([401, 402, 403, 429].includes(status)) return status;
      return 0;
    }
    const lock = getModelLockoutInfo("claude", String(row.id), model);
    if (lock && lock.remainingMs > 0 && QUOTA_LOCKS.has(lock.reason)) return 429;
    return poolRateLimited ? 429 : 0;
  });
  if (!statuses.every(canExhaustClaudeAccount)) return null;
  return statuses.every((status) => status === 429)
    ? "accounts_rate_limited"
    : "accounts_unavailable";
}
