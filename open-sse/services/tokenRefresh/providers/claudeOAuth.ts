// @ts-nocheck
// Extracted from open-sse/services/tokenRefresh.ts — see ../shared.ts for
// provenance notes (ported idea from KooshaPari's PR #7338, redone on tip).
import { PROVIDERS, OAUTH_ENDPOINTS } from "../../../config/constants.ts";
import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import { buildFormParams, readRefreshErrorBody } from "../shared.ts";
import { noteRenewalAttempt } from "../renewalOutcome.ts";

/**
 * Specialized refresh for Claude OAuth tokens
 */
export async function refreshClaudeOAuthToken(refreshToken, log, proxyConfig: unknown = null) {
  try {
    // Standard OAuth2 token refresh uses form-urlencoded (not JSON)
    const params = buildFormParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: PROVIDERS.claude.clientId,
    });

    const response = await runWithProxyContext(proxyConfig, () =>
      fetch(OAUTH_ENDPOINTS.anthropic.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(25_000),
      })
    );

    if (!response.ok) {
      // Only an overloaded or failing endpoint is an outage; any other answer is definite.
      noteRenewalAttempt(response.status === 429 || response.status >= 500);
      // Read + classify the body ONCE, shape-agnostic. A proxy/MITM can deliver
      // the invalid_grant 400 as a JSON string, a double-encoded string, a
      // nested {error:{code}}, or raw text — all must yield the sentinel so the
      // HealthCheck deactivates instead of looping every 60s.
      const { rawText, code } = await readRefreshErrorBody(response);
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Claude OAuth token", {
        status: response.status,
        code: code || "unclassified_refresh_error",
      });
      if (code === "invalid_grant") {
        return {
          error: "unrecoverable_refresh_error",
          code,
          reason: /refresh token expired/i.test(rawText)
            ? "refresh_token_expired"
            : "refresh_token_rejected",
        };
      }
      // A malformed/rejected request does not prove that a credential was
      // consumed. Stop request-time retries; the scheduler applies its backoff.
      if (code === "invalid_request") {
        return { error: "refresh_request_rejected", code, retryable: false };
      }
      return null;
    }

    noteRenewalAttempt(false);
    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Claude OAuth token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  } catch (error) {
    noteRenewalAttempt(true);
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Claude token: ${error.message}`);
    return null;
  }
}
