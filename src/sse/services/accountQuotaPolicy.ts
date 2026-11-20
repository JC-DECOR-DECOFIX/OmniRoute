import { DEFAULT_QUOTA_THRESHOLD_PERCENT, getQuotaWindowStatus } from "@/domain/quotaCache";
import type { ProviderConnectionView } from "@/lib/db/providers/lazyConnectionView";
import { toNumber } from "@/shared/utils/numeric";
import {
  toCodexBaseQuotaWindowName,
  toCodexScopedQuotaWindowName,
} from "@omniroute/open-sse/config/codexQuotaScopes.ts";
import { cooldownUntilMs } from "@omniroute/open-sse/services/accountFallback.ts";

type JsonRecord = Record<string, unknown>;
const MIN_QUOTA_THRESHOLD_PERCENT = 1;
const MAX_QUOTA_THRESHOLD_PERCENT = 100;
function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function toBooleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function getCodexLimitPolicy(providerSpecificData: JsonRecord): {
  use5h: boolean;
  useWeekly: boolean;
} {
  const policy = asRecord(providerSpecificData.codexLimitPolicy);
  return {
    use5h: toBooleanOrDefault(policy.use5h, true),
    useWeekly: toBooleanOrDefault(policy.useWeekly, true),
  };
}
export interface QuotaLimitPolicy {
  enabled: boolean;
  thresholdPercent: number;
  windows: string[];
}
function normalizeQuotaThreshold(
  value: unknown,
  fallback = DEFAULT_QUOTA_THRESHOLD_PERCENT
): number {
  const parsed = toNumber(value, fallback);
  return Math.min(MAX_QUOTA_THRESHOLD_PERCENT, Math.max(MIN_QUOTA_THRESHOLD_PERCENT, parsed));
}
export function normalizeWindowName(windowName: unknown): string | null {
  if (typeof windowName !== "string") return null;
  const normalized = windowName.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
export function uniqueWindows(windows: string[]): string[] {
  return [...new Set(windows)];
}
function normalizeCodexWindowName(windowName: unknown): string | null {
  if (typeof windowName !== "string") return null;
  const normalized = windowName.trim().toLowerCase();
  if (normalized === "session (5h)" || normalized === "5h" || normalized === "five_hour") {
    return "session";
  }
  if (normalized === "weekly (7d)" || normalized === "7d" || normalized === "seven_day") {
    return "weekly";
  }
  return toCodexBaseQuotaWindowName(normalized);
}
function applyCodexWindowPolicy(rawWindows: string[], providerSpecificData: JsonRecord): string[] {
  const codexPolicy = getCodexLimitPolicy(providerSpecificData);
  const normalizedRaw = rawWindows.map(normalizeCodexWindowName).filter(Boolean) as string[];

  // Preserve explicitly configured custom windows, but enforce canonical Codex windows
  // from toggles so weekly exhaustion is never skipped when useWeekly=true.
  let windows = [...normalizedRaw];
  windows = windows.filter((windowName) => {
    if (windowName === "session") return codexPolicy.use5h;
    if (windowName === "weekly") return codexPolicy.useWeekly;
    return true;
  });
  if (codexPolicy.use5h) windows.push("session");
  if (codexPolicy.useWeekly) windows.push("weekly");

  return uniqueWindows(windows);
}
export function resolveQuotaLimitPolicy(
  provider: string,
  providerSpecificData: JsonRecord
): QuotaLimitPolicy {
  const rawPolicy = asRecord(providerSpecificData.limitPolicy);
  const rawWindows = Array.isArray(rawPolicy.windows) ? rawPolicy.windows : [];
  const windows = rawWindows.map(normalizeWindowName).filter(Boolean) as string[];

  if (provider === "codex") {
    const defaultWindows = applyCodexWindowPolicy(windows, providerSpecificData);
    const enabled = toBooleanOrDefault(rawPolicy.enabled, defaultWindows.length > 0);

    return {
      enabled,
      thresholdPercent: normalizeQuotaThreshold(rawPolicy.thresholdPercent),
      windows: defaultWindows,
    };
  }

  return {
    enabled: toBooleanOrDefault(rawPolicy.enabled, false),
    thresholdPercent: normalizeQuotaThreshold(rawPolicy.thresholdPercent),
    windows,
  };
}
export function evaluateQuotaLimitPolicy(
  provider: string,
  connection: ProviderConnectionView,
  requestedModel: string | null = null
): { blocked: boolean; reasons: string[]; resetAt: string | null } {
  const policy = resolveQuotaLimitPolicy(provider, connection.providerSpecificData);
  if (!policy.enabled || policy.windows.length === 0) {
    return { blocked: false, reasons: [], resetAt: null };
  }

  const reasons: string[] = [];
  const resetCandidates: Array<string | null> = [];

  for (const windowName of policy.windows) {
    const effectiveWindowName =
      provider === "codex" ? toCodexScopedQuotaWindowName(windowName, requestedModel) : windowName;
    const status = getQuotaWindowStatus(
      connection.id,
      effectiveWindowName,
      policy.thresholdPercent
    );
    if (!status?.reachedThreshold) continue;
    reasons.push(`${effectiveWindowName} usage ${Math.round(status.usedPercentage)}%`);
    resetCandidates.push(status.resetAt);
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    resetAt: getEarliestFutureDate(resetCandidates),
  };
}
export function parseFutureDateMs(value: string | null): number | null {
  if (!value) return null;
  // Tolerate numeric-epoch strings (e.g. "1781696905131.0") as well as ISO
  // strings — the rate_limited_until TEXT column can hold either (#3954).
  const ms = cooldownUntilMs(value);
  if (!Number.isFinite(ms) || ms <= Date.now()) return null;
  return ms;
}
export function getEarliestFutureDate(candidates: Array<string | null>): string | null {
  return (
    candidates
      .map((candidate) => ({
        raw: candidate,
        ms: parseFutureDateMs(candidate),
      }))
      .filter((entry) => entry.ms !== null)
      .sort((a, b) => (a.ms as number) - (b.ms as number))[0]?.raw || null
  );
}
