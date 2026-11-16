import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request record of whether the last credential renewal attempt reached a
 * definite answer. "Unreachable" means a transport error, a timeout, a 5xx/429
 * from the token endpoint, or the renewal circuit breaker being open — never a
 * rejection. Callers that did not open a scope are unaffected.
 */
export type RenewalOutcome = { unreachable: boolean };

const scope = new AsyncLocalStorage<RenewalOutcome>();

/** Wraps `fn` so every renewal it triggers reports into `outcome`. */
export function withRenewalOutcome<A extends unknown[], R>(
  outcome: RenewalOutcome,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args) => scope.run(outcome, () => fn(...args));
}

/** Records the latest attempt; a later definite answer overrides an earlier outage. */
export function noteRenewalAttempt(unreachable: boolean): void {
  const outcome = scope.getStore();
  if (outcome) outcome.unreachable = unreachable;
}

/**
 * One renewal can be awaited by several requests. The renewal runs in its own
 * scope, and each request that awaits it receives the shared outcome.
 */
export function runInRenewalScope<T>(shared: RenewalOutcome, renewal: () => T): T {
  return scope.run(shared, renewal);
}

export function deliverRenewalOutcome<T>(shared: RenewalOutcome, awaited: Promise<T>): Promise<T> {
  const caller = scope.getStore();
  if (!caller) return awaited;
  return awaited.finally(() => {
    caller.unreachable = shared.unreachable;
  });
}
