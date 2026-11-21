import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import * as log from "../../utils/logger";

export function validateChatRequest(body: unknown, sourceFormat: string): Response | null {
  // Early guard: an invalid `messages` field is rejected here with a clear
  // OmniRoute-level 400 before any routing or upstream call (#5110, #6402).
  // Without this guard, schema-invalid bodies fell through to model resolution
  // and surfaced as a misleading 404 `model_not_found` from chatHelpers.ts (#6402).
  // Cases covered:
  //   - present-but-non-array (null, number, string, object) → 400 (#6402)
  //   - empty array → 400 ("at least one message is required") (#5110)
  //   - missing entirely, when the Responses-API `input` discriminator is also
  //     absent → 400 (#6402). Responses-API requests use `input` (not `messages`),
  //     and Antigravity requests use a cloudcode `request` envelope.
  const msgBody = body as { messages?: unknown; input?: unknown };
  if ("messages" in msgBody && !Array.isArray(msgBody.messages)) {
    log.warn("CHAT", "Rejecting request with non-array messages");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "messages: Expected array");
  }
  if (Array.isArray(msgBody.messages) && msgBody.messages.length === 0) {
    log.warn("CHAT", "Rejecting request with empty messages array");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "messages: at least one message is required");
  }
  if (!("messages" in msgBody) && !("input" in msgBody) && sourceFormat !== "antigravity") {
    log.warn("CHAT", "Rejecting request with missing messages");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "messages: Expected array, received undefined");
  }

  // Reject non-string `model` before it reaches downstream code that calls
  // `.toLowerCase()` / `.split()` / `.startsWith()` on it (crash-then-500 with an
  // empty body, escaping the error sanitizer — #6407). An explicit `null`/`undefined`
  // stays permitted here because the existing `Missing model` guard below returns a
  // clean 400 for those; anything else that is not a string is a client type error.
  const rawModel = (body as { model?: unknown }).model;
  if (rawModel !== undefined && rawModel !== null && typeof rawModel !== "string") {
    log.warn("CHAT", `Rejecting non-string model (typeof=${typeof rawModel})`);
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `model: Expected string, received ${Array.isArray(rawModel) ? "array" : typeof rawModel}`
    );
  }

  // Early schema validation for scalar params BEFORE provider/model resolution (#6412).
  // Previously, a bad `temperature: "not-a-number"` on an unknown provider returned
  // 404 "model_not_found" — hiding the real schema error. Validate the param shape
  // first so the client gets a 400 with the field name. Kept narrow to widely-supported
  // OpenAI-spec params (temperature 0..2, top_p 0..1, max_tokens int >=1) so we don't
  // reject legitimate provider-specific fields.
  {
    const b = body as {
      temperature?: unknown;
      top_p?: unknown;
      max_tokens?: unknown;
      n?: unknown;
    };
    const badParam = (name: string, msg: string) =>
      errorResponse(HTTP_STATUS.BAD_REQUEST, `${name}: ${msg}`);
    if (b.temperature !== undefined) {
      if (typeof b.temperature !== "number" || Number.isNaN(b.temperature)) {
        return badParam("temperature", "must be a number");
      }
      if (b.temperature < 0 || b.temperature > 2) {
        return badParam("temperature", "must be between 0 and 2");
      }
    }
    if (b.top_p !== undefined) {
      if (typeof b.top_p !== "number" || Number.isNaN(b.top_p)) {
        return badParam("top_p", "must be a number");
      }
      if (b.top_p < 0 || b.top_p > 1) {
        return badParam("top_p", "must be between 0 and 1");
      }
    }
    if (b.max_tokens !== undefined) {
      if (typeof b.max_tokens !== "number" || !Number.isInteger(b.max_tokens) || b.max_tokens < 1) {
        return badParam("max_tokens", "must be a positive integer");
      }
    }
    if (b.n !== undefined) {
      if (typeof b.n !== "number" || !Number.isInteger(b.n) || b.n < 1) {
        return badParam("n", "must be a positive integer");
      }
    }
  }
  return null;
}
