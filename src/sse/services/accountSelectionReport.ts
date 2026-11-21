/**
 * Account-selection report (EARLIEST_QUOTA_RENEWAL_FIRST observability), served by
 * GET /api/usage/account-selection. Credential-free by construction: every field is picked
 * explicitly from the connection row; tokens, cookies, keys, request bodies and raw session
 * identifiers are never read into the report. Times are UTC ISO strings; the UI formats BRT.
 */
import { getProviderConnections } from "@/lib/db/providers";
import { getSettings } from "@/lib/db/settings";
import { getProviderLimitsCache } from "@/lib/db/providerLimits";
import { listSessionAccountAffinities } from "@/lib/db/sessionAccountAffinity";
import { listAccountFailoverEvents } from "@/lib/db/accountFailoverEvents";
import { isAccountQuotaExhausted } from "@/domain/quotaCache";
import { isAccountUnavailable } from "@omniroute/open-sse/services/accountFallback.ts";
import { isTerminalConnectionStatus } from "./connectionTerminalStatus";
import { resolveSessionAffinityTtlMs } from "./sessionAffinityPin";
import { listRecentSessions } from "./accountSessionTracker";
import {
  EARLIEST_QUOTA_RENEWAL_POLICY,
  QUOTA_RENEWAL_FRESH_MS,
  getLastAccountSelectionRanking,
  isEarliestQuotaRenewalStrategy,
  rankByEarliestQuotaRenewal,
  readQuotaRenewalReading,
  type QuotaRenewalDecision,
} from "./quotaRenewalRanking";

export const ACCOUNT_SELECTION_REPORT_SCHEMA = "omni-route-account-selection/v1";
const RECENT_SESSION_WINDOW_MS = 60 * 60_000;

type Row = Record<string, unknown>;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

function blockedReasons(row: Row, now: number): string[] {
  const reasons: string[] = [];
  if (row.isActive === false || row.isActive === 0) reasons.push("inactive");
  if (isTerminalConnectionStatus(row as never)) reasons.push(`terminal:${String(row.testStatus)}`);
  const until = str(row.rateLimitedUntil);
  if (until && isAccountUnavailable(until) && Date.parse(until) > now) reasons.push("cooldown");
  return reasons;
}

function windowView(decision: QuotaRenewalDecision | undefined, which: "weekly" | "fiveHour") {
  const window = decision?.[which];
  return window
    ? {
        remainingPercentage: window.remainingPercentage,
        resetAt: window.resetAt,
        state: window.state,
      }
    : null;
}

export async function buildAccountSelectionReport(provider = "claude", now = Date.now()) {
  const settings = (await getSettings()) as Row;
  const overrides = (settings.providerStrategies || {}) as Record<string, Row | undefined>;
  const strategy =
    str(overrides[provider]?.fallbackStrategy) || str(settings.fallbackStrategy) || "fill-first";
  const sessionAffinityTtlMs = resolveSessionAffinityTtlMs(provider, {}, settings as never);

  const rows = ((await getProviderConnections({ provider })) as unknown as Row[]).filter(
    (row) => typeof row.id === "string"
  );
  const blocked = new Map(rows.map((row) => [row.id as string, blockedReasons(row, now)]));
  const candidates = rows
    .filter((row) => blocked.get(row.id as string)!.length === 0)
    .map((row) => {
      isAccountQuotaExhausted(row.id as string); // hydrates the cache from snapshots if needed
      return {
        id: row.id as string,
        priority: Number.isFinite(row.priority) ? Number(row.priority) : null,
        reading: readQuotaRenewalReading(row.id as string),
      };
    });
  const ranking = rankByEarliestQuotaRenewal(candidates, { now });
  const decisions = new Map(
    [...ranking.ordered, ...ranking.excluded].map((decision) => [decision.connectionId, decision])
  );

  const pins = listSessionAccountAffinities(provider, now);
  const pinsByConnection = new Map<string, number>();
  for (const pin of pins) {
    pinsByConnection.set(pin.connectionId, (pinsByConnection.get(pin.connectionId) ?? 0) + 1);
  }

  const accounts = rows.map((row) => {
    const id = row.id as string;
    const decision = decisions.get(id);
    const reading = decision ? readQuotaRenewalReading(id) : null;
    return {
      connectionId: id,
      shortId: id.slice(0, 8),
      email: str(row.email),
      priority: Number.isFinite(row.priority) ? Number(row.priority) : null,
      testStatus: str(row.testStatus),
      rateLimitedUntil: str(row.rateLimitedUntil),
      blocked: blocked.get(id) ?? [],
      tier: decision?.tier ?? "blocked",
      position: decision?.position ?? null,
      reason: decision?.reason ?? (blocked.get(id) ?? [])[0] ?? null,
      limitingWindow: decision?.limitingWindow ?? null,
      resetAt: decision?.resetAt ?? null,
      fiveHour: windowView(decision, "fiveHour"),
      weekly: windowView(decision, "weekly"),
      freshness: decision?.freshness ?? null,
      dataAgeMs: decision?.dataAgeMs ?? null,
      quotaReadAt:
        reading?.fetchedAtMs != null ? new Date(reading.fetchedAtMs).toISOString() : null,
      quotaReadLive: reading?.live ?? null,
      lastProviderLimitsSyncAt: str(getProviderLimitsCache(id)?.fetchedAt),
      activeSessionPins: pinsByConnection.get(id) ?? 0,
    };
  });

  const pick = (decision: QuotaRenewalDecision | undefined) =>
    decision
      ? { connectionId: decision.connectionId, reason: decision.reason, tier: decision.tier }
      : null;
  const last = getLastAccountSelectionRanking(provider);

  return {
    schema: ACCOUNT_SELECTION_REPORT_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    provider,
    policy: {
      name: EARLIEST_QUOTA_RENEWAL_POLICY,
      strategy,
      enabled: isEarliestQuotaRenewalStrategy(strategy),
      sessionAffinityTtlMs,
      freshnessMs: QUOTA_RENEWAL_FRESH_MS,
    },
    chosen: pick(ranking.ordered[0]),
    reserve: pick(ranking.ordered[1]),
    lastDecision: last
      ? {
          evaluatedAt: last.evaluatedAt,
          requestedModel: last.requestedModel,
          chosen: last.ordered[0]?.connectionId ?? null,
          order: last.ordered.map((decision) => decision.connectionId),
        }
      : null,
    accounts,
    sessions: {
      pinned: pins.slice(0, 50).map((pin) => ({
        keyHash: pin.keyHash,
        connectionId: pin.connectionId,
        createdAt: pin.createdAt,
        lastUsedAt: pin.lastUsedAt,
        expiresAt: pin.expiresAt,
      })),
      recent: listRecentSessions(provider, now - RECENT_SESSION_WINDOW_MS),
    },
    failovers: listAccountFailoverEvents({ provider, limit: 20 }),
  };
}
