/**
 * EARLIEST_QUOTA_RENEWAL_FIRST — response header and auditable switch events for the
 * chat dispatch loop (leaf module so the frozen chat.ts only gains one call site).
 *
 * - `X-OmniRoute-Account-Selection`: the short, credential-free selection reason that
 *   getProviderCredentials attached to the credentials it returned.
 * - Failover event: the request succeeded on a different account than its first attempt
 *   (same model, before any useful output — see claudeAccountContinuityOnly in chat.ts).
 * - Manual pin event: an operator pin (`x-omniroute-connection`) moved a session to an
 *   account different from the one it last used in this process.
 */
import { recordAccountFailoverEvent } from "@/lib/db/accountFailoverEvents";
import { trackSessionServed } from "../../services/accountSessionTracker";
import * as log from "../../utils/logger";

export const ACCOUNT_SELECTION_HEADER = "X-OmniRoute-Account-Selection";
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,300}$/;

export interface AccountSelectionOutcome {
  provider: string;
  model: string | null;
  credentials: { connectionId?: string | null; accountSelection?: unknown } | null | undefined;
  attemptedConnectionIds: string[];
  sessionKey?: string | null;
  lastStatus?: number | string | null;
  forcedConnection?: boolean;
}

function setHeader(response: Response, value: string): Response {
  try {
    response.headers.set(ACCOUNT_SELECTION_HEADER, value);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set(ACCOUNT_SELECTION_HEADER, value);
    return cloned;
  }
}

/** Best-effort: never throws into the dispatch path. */
export function finalizeAccountSelection(
  response: Response,
  outcome: AccountSelectionOutcome
): Response {
  let out = response;
  try {
    const finalId = outcome.credentials?.connectionId ?? null;
    const selection = outcome.credentials?.accountSelection;
    if (typeof selection === "string" && HEADER_VALUE_RE.test(selection) && out) {
      out = setHeader(out, selection);
    }
    if (!finalId) return out;
    const firstId = outcome.attemptedConnectionIds[0] ?? null;
    if (firstId && firstId !== finalId) {
      recordAccountFailoverEvent({
        provider: outcome.provider,
        kind: "failover",
        fromConnectionId: firstId,
        toConnectionId: finalId,
        reason: outcome.lastStatus ? `upstream ${outcome.lastStatus}` : "account unavailable",
        model: outcome.model,
        sessionKey: outcome.sessionKey,
        attempts: outcome.attemptedConnectionIds.length,
      });
    }
    const { previousConnectionId } = trackSessionServed({
      provider: outcome.provider,
      sessionKey: outcome.sessionKey,
      connectionId: finalId,
      model: outcome.model,
    });
    if (outcome.forcedConnection && previousConnectionId && previousConnectionId !== finalId) {
      recordAccountFailoverEvent({
        provider: outcome.provider,
        kind: "manual_pin",
        fromConnectionId: previousConnectionId,
        toConnectionId: finalId,
        reason: "x-omniroute-connection",
        model: outcome.model,
        sessionKey: outcome.sessionKey,
      });
    }
  } catch (error) {
    log.warn("ACCOUNT_SELECTION", "audit skipped", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return out;
}
