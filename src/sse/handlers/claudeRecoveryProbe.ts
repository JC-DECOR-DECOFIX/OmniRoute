import { getApiKeyMetadata, isModelAllowedForKey } from "@/lib/db/apiKeys";
import type { CircuitBreaker } from "@/shared/utils/circuitBreaker";
import { shouldIsolateProbeFailures } from "@/shared/utils/probeOrigin";
import {
  clearModelLock,
  getModelLockoutInfo,
  type ProviderProfile,
} from "@omniroute/open-sse/services/accountFallback.ts";
import {
  getClaudeUpstreamRetryAt,
  isClaudeUpstreamAccountFailure,
  isOpusRecoveryRejected,
} from "@omniroute/open-sse/utils/claudeUpstreamAccountFailure.ts";
import {
  extractApiKey,
  getProviderCredentialsWithQuotaPreflight,
  markAccountUnavailable,
} from "../services/auth";
import {
  CLAUDE_RECOVERY_MODEL,
  getOpusRecoverySlot,
  revalidateOpusRecovery,
  type RecoverySlot,
} from "../services/claudeOpusRecovery";
import { shouldTripProviderBreakerForResult } from "./chatPredicates";

type SelectedConnection = Parameters<typeof revalidateOpusRecovery>[2] & { connectionId: string };
type ProbeContext = { modelStr: string; signal: AbortSignal | null; breaker: CircuitBreaker };

function isProbeAllowed({ signal, breaker }: ProbeContext) {
  return !signal?.aborted && breaker.canExecute() && breaker.getStatus().state !== "HALF_OPEN";
}

export async function claimOpusRecovery(
  ctx: ProbeContext & { allowed: string[] | null; sessionKey: string; attempts: number },
  verdict: { allRateLimited?: boolean; lastErrorCode?: unknown } | null
) {
  if (
    !verdict?.allRateLimited ||
    Number(verdict.lastErrorCode) !== 429 ||
    ctx.attempts !== 0 ||
    !isProbeAllowed(ctx) ||
    (await shouldIsolateProbeFailures())
  )
    return null;
  const credentials = await getProviderCredentialsWithQuotaPreflight(
    "claude",
    null,
    ctx.allowed,
    CLAUDE_RECOVERY_MODEL,
    {
      sessionKey: ctx.sessionKey,
      reserveOAuthSession: true,
      opusRecovery: { modelStr: ctx.modelStr, signal: ctx.signal },
    }
  );
  if (!credentials?.connectionId) return null;
  // Claim the same per-account/model episode across all keys without an await.
  const slot = isProbeAllowed(ctx) && getOpusRecoverySlot(credentials.connectionId);
  if (!slot) {
    credentials.releaseOAuthSession?.();
    return null;
  }
  slot.used = true;
  return { credentials, slot };
}

export function createOpusSendFence(
  ctx: ProbeContext,
  req: Parameters<typeof extractApiKey>[0],
  keyId: string | undefined,
  connection: SelectedConnection,
  slot: RecoverySlot
) {
  return async () => {
    try {
      const key = extractApiKey(req);
      const latest = await getApiKeyMetadata(key);
      return Boolean(
        key &&
        latest &&
        latest.id === keyId &&
        latest.isActive &&
        !latest.isBanned &&
        !latest.revokedAt &&
        (!latest.expiresAt || Date.parse(latest.expiresAt) > Date.now()) &&
        latest.allowedConnections?.includes(connection.connectionId) &&
        !latest.scopes?.includes("lease:exclusive") &&
        (await isModelAllowedForKey(key, ctx.modelStr)) &&
        (await revalidateOpusRecovery(connection.connectionId, ctx.modelStr, connection)) &&
        isProbeAllowed(ctx) &&
        getOpusRecoverySlot(connection.connectionId, slot) === slot
      );
    } catch {
      // A local read error is not proof of an upstream attempt or permission.
      return false;
    }
  };
}

type ProbeResult = Parameters<typeof shouldTripProviderBreakerForResult>[0] & {
  response: Response;
  success: boolean;
  rawMessage?: string;
};

export async function finishOpusRecoveryFailure(
  ctx: ProbeContext,
  result: ProbeResult,
  connectionId: string,
  profile: ProviderProfile
) {
  if (result.success || isOpusRecoveryRejected(result.response) || ctx.signal?.aborted) return;
  // No token renewal runs in this path. Leave a 401/403 for ordinary routing to
  // handle through its existing renewal/terminal-state logic after cooldown.
  if (isClaudeUpstreamAccountFailure(result.response) && result.status === 429) {
    await markAccountUnavailable(
      connectionId,
      429,
      String(result.rawMessage ?? result.error ?? ""),
      "claude",
      CLAUDE_RECOVERY_MODEL,
      profile,
      { confirmedClaude429: true, claudeRetryAt: getClaudeUpstreamRetryAt(result.response) }
    );
  }
  if (!ctx.signal?.aborted && shouldTripProviderBreakerForResult(result, false, false))
    ctx.breaker._onFailure();
}

export function clearRecoveredModelLock(
  provider: string,
  account: string,
  model: string,
  slot?: RecoverySlot
) {
  if (!slot || getModelLockoutInfo(provider, account, model)?.opusRecovery === slot)
    clearModelLock(provider, account, model);
}
