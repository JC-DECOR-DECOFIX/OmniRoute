import { inheritTrustedLocalRateLimitResponse } from "@omniroute/open-sse/services/rateLimitManager/errors.ts";

export function withSessionHeader(response: Response, sessionId: string | null): Response {
  if (!response || !sessionId) return response;

  try {
    response.headers.set("X-OmniRoute-Session-Id", sessionId);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("X-OmniRoute-Session-Id", sessionId);
    return inheritTrustedLocalRateLimitResponse(response, cloned);
  }
}

export function withCorrelationId(response: Response, correlationId: string | null): Response {
  if (!response || !correlationId) return response;

  try {
    response.headers.set("X-Correlation-Id", correlationId);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("X-Correlation-Id", correlationId);
    return inheritTrustedLocalRateLimitResponse(response, cloned);
  }
}

/**
 * Modality Bridge transparency (PR-1 Task 9): stamp the
 * `x-omniroute-modality-bridge` header on responses whose request payload was
 * transparently transformed (e.g. image→text describe). `value` comes from
 * buildModalityBridgeHeader(); null (untouched/rerouted request) is a no-op.
 * Same try-set/clone-fallback shape as withSessionHeader — the clone reuses
 * `response.body`, so SSE streams pass through untouched.
 */
export function withModalityBridgeHeader(response: Response, value: string | null): Response {
  if (!response || !value) return response;

  try {
    response.headers.set("x-omniroute-modality-bridge", value);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("x-omniroute-modality-bridge", value);
    return cloned;
  }
}

export function withConversationId(response: Response, conversationId: string | null): Response {
  if (!response || !conversationId) return response;

  try {
    response.headers.set("X-ConversationId", conversationId);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("X-ConversationId", conversationId);
    return cloned;
  }
}

export function withSelectedConnectionHeader(
  response: Response,
  connectionId: string | null | undefined
): Response {
  if (!response || !connectionId) return response;

  try {
    response.headers.set("X-OmniRoute-Selected-Connection-Id", connectionId);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    cloned.headers.set("X-OmniRoute-Selected-Connection-Id", connectionId);
    return inheritTrustedLocalRateLimitResponse(response, cloned);
  }
}
