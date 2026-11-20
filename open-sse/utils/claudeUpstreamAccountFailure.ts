// Internal provenance only: a response body/header cannot attest to dispatch.
const upstreamAccountFailures = new WeakMap<Response, number | null>();
const rejectedOpusRecovery = new WeakSet<Response>();

export function markOpusRecoveryRejected(response: Response): Response {
  rejectedOpusRecovery.add(response);
  return response;
}

export function isOpusRecoveryRejected(response: Response): boolean {
  return rejectedOpusRecovery.has(response);
}

export function markClaudeUpstreamAccountFailure(
  response: Response,
  retryAt: number | null = null
): void {
  upstreamAccountFailures.set(response, retryAt);
}

export function isClaudeUpstreamAccountFailure(response: Response): boolean {
  return upstreamAccountFailures.has(response);
}

export function getClaudeUpstreamRetryAt(response: Response): number | null {
  return upstreamAccountFailures.get(response) ?? null;
}
