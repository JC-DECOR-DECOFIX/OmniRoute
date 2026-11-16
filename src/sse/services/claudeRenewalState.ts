import { getProviderConnectionById } from "@/lib/db/providers";

export const CLAUDE_RENEWAL_PENDING_REASON = "Claude credential renewal is temporarily unavailable";

/**
 * After an upstream 401, tells a temporary renewal failure apart from a dead account.
 *
 * A successful renewal rotates the stored access credential, and a rejected grant
 * deactivates the account. When neither happened the renewal endpoint was unreachable
 * (network, timeout, 5xx/429) and the stored grant can still renew later, so the
 * account must cool down instead of becoming terminal: the scheduler never retries a
 * terminal account, which would otherwise require a manual login to recover.
 */
export async function isClaudeRenewalPending(
  connectionId: string,
  dispatchedAccessToken: unknown
): Promise<boolean> {
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
