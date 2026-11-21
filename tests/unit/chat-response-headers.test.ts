import assert from "node:assert/strict";
import test from "node:test";
import {
  getTrustedLocalRateLimitResponse,
  markLocalRateLimitError,
  markTrustedLocalRateLimitResponse,
  RATE_LIMIT_QUEUE_FULL_CODE,
} from "../../open-sse/services/rateLimitManager/errors.ts";
import {
  withConversationId,
  withCorrelationId,
  withModalityBridgeHeader,
  withSelectedConnectionHeader,
  withSessionHeader,
} from "../../src/sse/handlers/chat/responseHeaders.ts";

const wrappers = [
  [withSessionHeader, "X-OmniRoute-Session-Id", true],
  [withCorrelationId, "X-Correlation-Id", true],
  [withSelectedConnectionHeader, "X-OmniRoute-Selected-Connection-Id", true],
  [withModalityBridgeHeader, "x-omniroute-modality-bridge", false],
  [withConversationId, "X-ConversationId", false],
] as const;

for (const [wrap, header, preservesMarker] of wrappers) {
  test(`${header}: preserves body, status, and existing provenance behavior`, async () => {
    const original = new Response("data: fixture\n\n", {
      status: 429,
      statusText: "Fixture",
      headers: { "Content-Type": "text/event-stream", "Retry-After": "7" },
    });
    markTrustedLocalRateLimitResponse(
      original,
      markLocalRateLimitError(new Error("fixture"), RATE_LIMIT_QUEUE_FULL_CODE)
    );
    assert.equal(wrap(original, null), original);
    assert.equal(wrap(original, "mutable"), original);
    assert.equal(original.headers.get(header), "mutable");
    assert.equal(getTrustedLocalRateLimitResponse(original)?.code, RATE_LIMIT_QUEUE_FULL_CODE);

    // Emulate an immutable Headers guard without making a network request.
    original.headers.set = () => {
      throw new TypeError("immutable fixture headers");
    };
    const wrapped = wrap(original, "cloned");
    assert.notEqual(wrapped, original);
    assert.equal(wrapped.body, original.body);
    assert.equal(wrapped.status, original.status);
    assert.equal(wrapped.statusText, original.statusText);
    assert.equal(wrapped.headers.get("Retry-After"), "7");
    assert.equal(wrapped.headers.get(header), "cloned");
    assert.equal(
      getTrustedLocalRateLimitResponse(wrapped)?.code,
      preservesMarker ? RATE_LIMIT_QUEUE_FULL_CODE : undefined
    );
    assert.equal(await wrapped.text(), "data: fixture\n\n");
  });
}
