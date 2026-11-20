import { getQuotaCache, isQuotaExhaustedForRequest } from "@/domain/quotaCache";
import { isModelExcludedByConnection } from "@/domain/connectionModelRules";
import { getProviderConnectionById } from "@/lib/db/providers";
import {
  toProviderConnection,
  type ProviderConnectionView,
} from "@/lib/db/providers/lazyConnectionView";
import {
  getModelLockoutInfo,
  isAccountUnavailable,
} from "@omniroute/open-sse/services/accountFallback.ts";
import { resolveBareModelToConnectionDefault } from "@omniroute/open-sse/services/model.ts";
import { getRefreshLeadMs } from "@omniroute/open-sse/services/tokenRefresh.ts";
import { applyExclusiveConnectionLeasePolicy } from "./exclusiveConnectionLeasePolicy";
import { evaluateQuotaLimitPolicy } from "./accountQuotaPolicy";
import { isTerminalConnectionStatus } from "./connectionTerminalStatus";

export const CLAUDE_RECOVERY_MODEL = "claude-opus-5-5";
export type RecoverySlot = { used: boolean };
export type OpusRecoverySelection = { modelStr: string; signal: AbortSignal | null };
export type Claude429Evidence = {
  confirmedClaude429?: boolean;
  claudeRetryAt?: number | null;
  allowOpusRecovery?: boolean;
};
// Give a transient throttle time to settle before the one-shot exception.
// This is not a reset estimate and never shortens the one-hour lock itself.
const MIN_COOLDOWN_AGE_MS = 120_000;
const MAX_QUOTA_AGE_MS = 5 * 60_000;

export function getOpusRecoverySlot(connectionId: string, claimed?: RecoverySlot) {
  const lock = getModelLockoutInfo("claude", connectionId, CLAUDE_RECOVERY_MODEL);
  const now = Date.now();
  const lockedAt = Date.parse(lock?.lockedAt ?? "");
  if (
    !lock?.confirmedClaude429 ||
    !lock.opusRecovery ||
    (claimed ? lock.opusRecovery !== claimed : lock.opusRecovery.used) ||
    lock.remainingMs <= 0 ||
    now - lockedAt < MIN_COOLDOWN_AGE_MS ||
    isQuotaExhaustedForRequest(connectionId, "claude", CLAUDE_RECOVERY_MODEL)
  )
    return null;

  const data = getQuotaCache(connectionId);
  if (
    !data ||
    data.provider !== "claude" ||
    !data.observedLive ||
    data.fetchedAt <= lockedAt ||
    data.fetchedAt > now ||
    now - data.fetchedAt > MAX_QUOTA_AGE_MS
  )
    return null;

  // Positive account-wide observations do not prove a model reset. They are only
  // a prerequisite for one recovery attempt. Missing/unknown windows fail closed.
  for (const name of ["session (5h)", "weekly (7d)"]) {
    const window = data.quotas[name];
    if (
      !window ||
      window.fractionReported === false ||
      window.remainingPercentage <= 2 ||
      (window.resetAt !== null && !(Date.parse(window.resetAt) > now))
    )
      return null;
  }
  for (const [name, window] of Object.entries(data.quotas)) {
    if (
      /\bopus\b/i.test(name) &&
      (window.fractionReported === false || window.remainingPercentage <= 2)
    ) {
      return null;
    }
  }
  return lock.opusRecovery;
}

export function opusRecoverySelectionAllowed(
  provider: string,
  model: string | null,
  allowed: string[] | null,
  options: {
    opusRecovery?: OpusRecoverySelection;
    lease?: unknown;
    forcedConnectionId?: string | null;
  },
  suppressed: boolean,
  bypassQuota: boolean
) {
  return (
    provider === "claude" &&
    model === CLAUDE_RECOVERY_MODEL &&
    Boolean(allowed?.length) &&
    !options.lease &&
    !options.forcedConnectionId &&
    !suppressed &&
    !bypassQuota &&
    !options.opusRecovery?.signal?.aborted
  );
}

export function isOpusRecoveryCandidate(
  connection: ProviderConnectionView,
  recovery: OpusRecoverySelection
) {
  return Boolean(
    getOpusRecoverySlot(connection.id) &&
    isExactOpusRecoveryModel(recovery.modelStr, connection.defaultModel) &&
    isCredentialFresh(connection)
  );
}

function isCredentialFresh(connection: ProviderConnectionView) {
  if (connection.authType === "apikey") return Boolean(connection.apiKey);
  if (connection.authType !== "oauth" || !connection.accessToken) return false;
  const expiry = Date.parse(connection.tokenExpiresAt ?? connection.expiresAt ?? "");
  return expiry > Date.now() + getRefreshLeadMs("claude", connection.providerSpecificData);
}

/** Recheck mutable account fences after preflight/queueing and immediately before the probe. */
export async function revalidateOpusRecovery(
  connectionId: string,
  modelStr: string,
  selected: { authType: string | null; accessToken: string | null; apiKey: string | null }
) {
  const connection = toProviderConnection(await getProviderConnectionById(connectionId));
  if (
    !connection.isActive ||
    connection.provider !== "claude" ||
    isTerminalConnectionStatus(connection) ||
    isAccountUnavailable(connection.rateLimitedUntil) ||
    isModelExcludedByConnection(CLAUDE_RECOVERY_MODEL, connection.providerSpecificData) ||
    !isExactOpusRecoveryModel(modelStr, connection.defaultModel) ||
    evaluateQuotaLimitPolicy("claude", connection, CLAUDE_RECOVERY_MODEL).blocked ||
    connection.authType !== selected.authType ||
    connection.accessToken !== selected.accessToken ||
    connection.apiKey !== selected.apiKey ||
    !isCredentialFresh(connection)
  )
    return false;
  const policy = await applyExclusiveConnectionLeasePolicy([connection], {});
  return policy.connections.length === 1;
}

export function opusRetryWaitMs(
  provider: string | null,
  model: string | null,
  status: number,
  hint?: number | null
) {
  return provider === "claude" && model === CLAUDE_RECOVERY_MODEL && status === 429 && hint
    ? Math.max(0, hint - Date.now())
    : 0;
}

export function modelScoped429Evidence(
  modelScoped: boolean,
  model: string,
  evidence: Claude429Evidence
) {
  const confirmed = modelScoped && evidence.confirmedClaude429;
  return {
    confirmedClaude429: confirmed ? (true as const) : undefined,
    opusRecovery:
      confirmed &&
      model === CLAUDE_RECOVERY_MODEL &&
      evidence.allowOpusRecovery &&
      !evidence.claudeRetryAt
        ? { used: false }
        : undefined,
  };
}

export function isExactOpusRecoveryModel(modelStr: string, defaultModel: string | null) {
  return (
    resolveBareModelToConnectionDefault(modelStr, CLAUDE_RECOVERY_MODEL, defaultModel) ===
    CLAUDE_RECOVERY_MODEL
  );
}
