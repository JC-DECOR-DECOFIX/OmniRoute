import { parseRetryFromErrorText } from "../../services/accountFallback.ts";
import { parseRetryHintFromJsonBody } from "../../services/retryAfterJson.ts";

export function getClaude429RetryAt(
  headers: Headers,
  message: string,
  parsedBody: unknown,
  parsedDelayMs: number | null,
  now = Date.now()
): number | null {
  let retryAt = 0;
  const consider = (at: number) => {
    if (Number.isFinite(at) && at > now && at <= 8.64e15) retryAt = Math.max(retryAt, at);
  };
  for (const [name, value] of headers) {
    if (name === "retry-after") {
      consider(/^\d{1,12}$/.test(value) ? now + Number(value) * 1000 : Date.parse(value));
    } else if (
      /^(?:x-|anthropic-)?ratelimit(?:-[a-z0-9]{1,24}){0,7}-reset$/.test(name) &&
      isApplicableReset(headers, name)
    ) {
      const epoch = Number(value);
      consider(
        /^\d{1,15}$/.test(value) ? (epoch < 1e11 ? epoch * 1000 : epoch) : Date.parse(value)
      );
    }
  }
  consider(now + (parsedDelayMs ?? 0));
  consider(now + (parseRetryFromErrorText(message) ?? 0));
  if (parsedBody && typeof parsedBody === "object") {
    consider(
      now + (parseRetryHintFromJsonBody(JSON.stringify(parsedBody), Number.MAX_SAFE_INTEGER) ?? 0)
    );
  }
  return retryAt || null;
}

function isApplicableReset(headers: Headers, name: string) {
  // A scheduled reset is not a wait unless that Anthropic window was rejected.
  if (["ratelimit-reset", "x-ratelimit-reset", "anthropic-ratelimit-reset"].includes(name))
    return true;
  const prefix = name.slice(0, -"-reset".length);
  const remaining = headers.get(`${prefix}-remaining`)?.trim();
  const status = headers.get(`${prefix}-status`)?.trim().toLowerCase();
  const utilization = headers.get(`${prefix}-utilization`)?.trim();
  return (
    status === "rejected" ||
    (remaining && Number(remaining) === 0) ||
    (prefix.startsWith("anthropic-ratelimit-unified-") && utilization && Number(utilization) >= 1)
  );
}
