import {
  buildErrorBody,
  sanitizeErrorMessage,
  unavailableResponse,
} from "@omniroute/open-sse/utils/error.ts";
import {
  canExhaustClaudeAccount,
  describeClaudeTerminalPool,
} from "../services/claudeTerminalPool";
import type { PoolRateLimit } from "../services/claudePoolRateLimit";
import { markClaudeTerminalPool, type ClaudeModelFallback } from "./claudeModelFallback";
import * as log from "../utils/logger";

export async function buildClaudePoolReply({
  credentials,
  lastStatus,
  lastError,
  model,
  modelStr,
  modelFallback,
  noLog,
  continuityAttemptedConnections,
  terminalAttempts,
  terminalPoolEnabled,
  isCombo,
  comboName,
  hasForcedConnection,
  requestSignal,
  effectiveAllowedConnections,
}: {
  credentials: {
    lastErrorCode?: number | string | null;
    lastError?: string | null;
    allExpired?: boolean;
    expiredStatus?: string;
    expiredCount?: number;
    allRateLimited?: boolean;
    retryAfter?: string | null;
    poolRateLimit?: PoolRateLimit;
  } | null;
  lastStatus: number | null;
  lastError: string | null;
  model: string;
  modelStr: string;
  modelFallback?: ClaudeModelFallback | null;
  noLog: boolean;
  continuityAttemptedConnections: ReadonlySet<string>;
  terminalAttempts: ReadonlyMap<string, number>;
  terminalPoolEnabled: boolean;
  isCombo: boolean;
  comboName: string | null;
  hasForcedConnection: boolean;
  requestSignal: AbortSignal | null;
  effectiveAllowedConnections: string[] | null;
}) {
  const attempts = continuityAttemptedConnections.size;
  const upstreamStatus = Number(lastStatus || credentials?.lastErrorCode);
  const terminalStatus =
    credentials?.expiredStatus === "credits_exhausted"
      ? 402
      : credentials?.expiredStatus === "banned"
        ? 403
        : 401;
  const status =
    upstreamStatus >= 400 && upstreamStatus <= 599
      ? upstreamStatus
      : credentials?.allExpired
        ? terminalStatus
        : credentials?.allRateLimited
          ? 429
          : 503;
  const reason = sanitizeErrorMessage(
    String(
      lastError ||
        credentials?.lastError ||
        (credentials?.allExpired
          ? `${credentials.expiredCount} authorized account(s) are ${credentials.expiredStatus}`
          : "No authorized healthy Claude account is available")
    )
  );
  const subscriptionExpired =
    /(?:subscription|assinatura|plan).{0,48}(?:expired|inactive|expirad[ao]|expirou|inativ[ao])|(?:renew|renov[ae]).{0,32}(?:subscription|assinatura|plan)/i.test(
      reason
    );
  const recovery =
    (credentials?.expiredStatus === "banned" && !lastError) ||
    /\b(?:account|conta)\b.{0,24}\b(?:banned|suspended|banid[ao]|suspens[ao])\b/i.test(reason)
      ? "Verify the Claude account restriction with Anthropic support before retrying."
      : status === 429
        ? "Wait for the account usage reset or cooldown, then retry the same model."
        : status === 401
          ? "Re-authenticate the unavailable accounts through OmniRoute's official Claude OAuth flow."
          : subscriptionExpired
            ? "Verify or renew the Claude subscription with Anthropic before retrying the same model."
            : status === 403
              ? "Verify Claude account permissions and access to the requested model in Anthropic."
              : status === 402
                ? "Verify the account's Claude subscription, billing and available credits with Anthropic."
                : "Check upstream service health and account availability in OmniRoute before retrying the same model.";
  const responseHeaders = new Headers({
    "Content-Type": "application/json",
    "x-omniroute-continuity-status": "accounts-unavailable",
    "x-should-retry": "false",
  });
  // Gateway authentication already succeeded. Do not label an exhausted
  // upstream credential pool as an invalid client API key.
  const responseStatus = status === 401 ? 502 : status;
  const retryAfterAt = credentials?.poolRateLimit?.eligibleAt ?? credentials?.retryAfter;
  if (credentials?.allRateLimited && retryAfterAt) {
    const retryAfter = unavailableResponse(status, "", retryAfterAt).headers.get("Retry-After");
    if (retryAfter) responseHeaders.set("Retry-After", retryAfter);
  }
  const continuity = {
    provider: "claude",
    requested_model: model,
    ...(attempts === 0 ? { local_status: responseStatus } : {}),
    // Keep the existing auth/recovery status contract for non-429 responses.
    ...(attempts > 0 || status !== 429 ? { upstream_status: status } : {}),
    mode: hasForcedConnection ? "fixed" : "authorized-pool",
    attempts,
    attempted_connections: Array.from(
      continuityAttemptedConnections,
      (id) => `${id.slice(0, 8)}...`
    ),
    result: "unavailable",
    ...(modelFallback ? { model_fallback: modelFallback } : {}),
    recovery,
    ...(responseHeaders.has("Retry-After")
      ? {
          retry_after: Number(responseHeaders.get("Retry-After")),
          retry_after_at: retryAfterAt,
        }
      : {}),
    ...(credentials?.poolRateLimit?.allRateLimited
      ? {
          pool_rate_limited: true,
          pool_eligible_at: credentials.poolRateLimit.eligibleAt,
        }
      : {}),
  };
  if (!noLog) {
    if (attempts === 0) {
      log.warn("CLAUDE_CONTINUITY", "Claude pool rejected before dispatch", {
        provider: continuity.provider,
        requested_model: continuity.requested_model,
        local_status: responseStatus,
        attempts,
        pool_rate_limited: continuity.pool_rate_limited === true,
        pool_eligible_at: continuity.pool_eligible_at ?? null,
      });
    } else {
      log.warn("CLAUDE_CONTINUITY", JSON.stringify(continuity));
    }
  }
  const errorBody = buildErrorBody(
    responseStatus,
    attempts === 0 && status === 429
      ? `No authorized Claude account is currently eligible for this model. ${recovery}`
      : `Claude upstream accounts unavailable: ${reason}. ${recovery}`
  );
  const poolResponse = new Response(
    JSON.stringify({
      ...errorBody,
      error: { ...errorBody.error, code: "upstream_accounts_unavailable" },
      continuity,
    }),
    {
      status: responseStatus,
      headers: responseHeaders,
    }
  );
  if (
    terminalPoolEnabled &&
    !isCombo &&
    !comboName &&
    !hasForcedConnection &&
    !requestSignal?.aborted &&
    effectiveAllowedConnections?.length &&
    canExhaustClaudeAccount(status)
  ) {
    const verdict = await describeClaudeTerminalPool(
      model,
      modelStr,
      effectiveAllowedConnections,
      terminalAttempts
    );
    if (verdict) markClaudeTerminalPool(poolResponse, model, verdict);
  }
  return poolResponse;
}
