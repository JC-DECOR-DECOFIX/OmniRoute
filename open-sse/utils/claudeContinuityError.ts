import { sanitizeErrorMessage } from "./error.ts";

export const CLAUDE_EXPLICIT_RECOVERY =
  "Resume explicitly from the preserved conversation context; do not replay completed tools or external effects.";

// Claude Code automatically continues a partial response for generic api_error.
// This distinct gateway error preserves the partial output and exposes recovery.
export function buildClaudeInterruptedError(message: unknown) {
  const cause =
    sanitizeErrorMessage(message) || "Upstream stream interrupted after partial output.";
  return {
    type: "upstream_interrupted_error",
    code: "upstream_partial_output",
    message: cause.includes(CLAUDE_EXPLICIT_RECOVERY)
      ? cause
      : `${cause} ${CLAUDE_EXPLICIT_RECOVERY}`,
  };
}
