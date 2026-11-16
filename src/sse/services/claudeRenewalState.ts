import { getProviderConnectionById } from "@/lib/db/providers";
import type { RenewalOutcome } from "@omniroute/open-sse/services/tokenRefresh/renewalOutcome.ts";

export const CLAUDE_RENEWAL_PENDING_REASON = "Claude credential renewal is temporarily unavailable";

/**
 * After an upstream 401, tells a renewal outage apart from a dead account.
 *
 * Temporary only when this request's last renewal attempt could not get a definite
 * answer (transport error, timeout, 5xx/429 from the token endpoint, or the renewal
 * circuit breaker open) and the stored account is untouched: still active, still
 * holding its grant, with the same access credential that was dispatched. A rejected
 * grant deactivates the account, a successful renewal rotates the credential, and any
 * other answer from the token endpoint is definite; all of those stay terminal. The
 * scheduler never retries a terminal account, so an outage must not become one.
 */
export async function isClaudeRenewalPending(
  connectionId: string,
  dispatchedAccessToken: unknown,
  outcome: RenewalOutcome
): Promise<boolean> {
  if (!outcome.unreachable) return false;
  if (typeof dispatchedAccessToken !== "string" || dispatchedAccessToken.length === 0) return false;
  const current = await getProviderConnectionById(connectionId);
  return (
    current?.authType === "oauth" &&
    current.isActive !== false &&
    typeof current.refreshToken === "string" &&
    current.refreshToken.length > 0 &&
    current.accessToken === dispatchedAccessToken
  );
}
