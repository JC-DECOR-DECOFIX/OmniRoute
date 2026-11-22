/**
 * Claude Code session identifier, for per-session account affinity.
 *
 * Every Claude Code client (terminal CLI, VS Code, and the Happy harnesses, which run the
 * same binary through `claude-happy-gateway`) sends the same per-session UUID twice:
 *   - header `X-Claude-Code-Session-Id: <uuid>`;
 *   - body `metadata.user_id`, either the JSON string
 *     `{"device_id":"…","account_uuid":"…","session_id":"<uuid>"}` (current CLIs) or the
 *     legacy `user_<hex>_account_<uuid>_session_<uuid>` form.
 * Header and body resolve to the same value, so either one yields the same affinity key.
 * Only the session UUID is extracted; device and account identifiers are never returned.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_SESSION_RE =
  /_session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_USER_ID_LENGTH = 2048;

type HeaderSource = Headers | { get?: (name: string) => string | null } | null | undefined;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers || typeof headers.get !== "function") return null;
  const value = headers.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/** Session UUID carried in Claude Code's `metadata.user_id`, in either format. */
export function parseClaudeCodeUserIdSession(userId: unknown): string | null {
  if (typeof userId !== "string") return null;
  const raw = userId.trim();
  if (!raw || raw.length > MAX_USER_ID_LENGTH) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return asUuid(parsed?.session_id);
    } catch {
      return null;
    }
  }
  const legacy = LEGACY_SESSION_RE.exec(raw);
  return legacy ? legacy[1].toLowerCase() : null;
}

export function extractClaudeCodeSessionId(body: unknown, headers?: HeaderSource): string | null {
  const fromHeader = asUuid(readHeader(headers, "x-claude-code-session-id"));
  if (fromHeader) return fromHeader;
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};
  return parseClaudeCodeUserIdSession(metadata.user_id);
}
