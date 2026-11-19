// Internal provenance only: a response body/header cannot attest to dispatch.
const upstreamAccountFailures = new WeakSet<Response>();

export function markClaudeUpstreamAccountFailure(response: Response): void {
  upstreamAccountFailures.add(response);
}

export function isClaudeUpstreamAccountFailure(response: Response): boolean {
  return upstreamAccountFailures.has(response);
}
