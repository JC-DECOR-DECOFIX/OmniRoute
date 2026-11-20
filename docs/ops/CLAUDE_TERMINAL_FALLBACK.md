---
title: "Claude continuity: terminal GPT-6.2 Sol fallback"
---

# Claude continuity: terminal GPT-6.2 Sol fallback

This route is **off by default**. With Claude continuity enabled, only Messages requests
from a restricted API key with an exact `codex/gpt-6.2-sol` grant and an explicit connection
list can cross providers. Authorize the workspace and the conversation data transfer before
opening enrollment. Use a new dedicated key; do not expand a previously exposed key.

Claude accounts are exhausted first. With terminal fallback enabled for a key, a proven
mixed outage also walks the configured Claude model chain (Fable → Opus by default). Local
admission/limiter pressure, client errors, explicit pins, combo routing, managed leases,
and aborts or streams already delivering output do not trigger the cross-provider hop.
Local proxy failures, renewal interruptions and timeouts are not upstream account evidence.
Only requests resolved to the canonical Claude subscription IDs `claude-opus-5-5` and
`claude-fable-5-2` can reach Sol. Existing aliases and context hints qualify only if they
resolve to one of those exact IDs and the key already permits the alias. A connection
default that changes the dispatched model cannot count as proof of exhaustion. Fable
cannot skip Opus. For an enrolled key, a disabled chain or a grant that denies Opus blocks
the terminal hop; an unexpected next model is never dispatched and also blocks the hop.
A direct Opus request does not require a Fable attempt. Other models and
keys not enrolled in terminal fallback keep the configured Claude-only routing behavior.
An ambiguous account selection failure (including a provider breaker with no per-account
verdict for this request) fails closed. If Codex rejects the request before it starts
responding, the gateway keeps the original Claude error and reports the terminal status in
`continuity.model_fallback`.

The Messages adapter carries conversation content, applicable tool definitions and results,
images and system instructions to Codex. It drops signed Claude thinking and does not send
Codex thinking to the Messages client. This is not data anonymization. Headers name the
effective model; the Claude response schema names it too. The observer accepts only
server-tagged terminal call logs as the current model; direct Codex traffic and Codex
quota never enter the Claude pool report. An inline text warning would change the response
content and tool replay, so the gateway does not inject one.

## Activation checklist (authorized maintenance only)

1. Verify the previous Claude build, readiness, and recovery package. Back up settings and
   preserve the packages and LaunchAgents for both the gateway and the observer.
2. Confirm **live**, account-specific Codex discovery lists `gpt-6.2-sol`; a GitHub fallback
   catalog, an old cache, or the CLI's catalog under a different identity is not sufficient.
   `CODEX_CLIENT_VERSION` controls the discovery query and Version header independently
   of `CODEX_USER_AGENT`. Test a coherent approved version/UA pair; stop if the live catalog
   still does not offer the model. A mock with a synthetic minimum proves the version
   plumbing, not the minimum imposed by the live service.
3. Enable `OMNIROUTE_CLAUDE_TERMINAL_FALLBACK=codex/gpt-6.2-sol` only after authorization.
   Grant the new key only the intended Claude and Codex connections/models. Verify normal
   Claude traffic, terminal tool replay, recovery to Claude, observer attribution, and the
   no-restart kill switch. Check available Codex quota and retain only sanitized evidence.

## Rollback

1. Remove the exact Codex grant (and Codex connection) from the dedicated key or revoke
   it. No restart; requests already dispatched cannot be recalled. Verify a fresh request
   is back to the Claude-only result. Do not re-enable or change the exposed key.
2. During an authorized idle window, set `OMNIROUTE_CLAUDE_TERMINAL_FALLBACK=off` (or unset
   it). Restore prior version/UA values if changed solely for this rollout. Restart
   the gateway and check its build and readiness.
3. If reverting code, restore the saved gateway and observer packages separately, restart
   their services, and verify the build, normal Claude serving, and sanitized observer
   report. Do not restore a SQLite snapshot over the live data directory.

The fallback does not guarantee parity with a Claude 1M context. It rejects a request
estimated at or above the smaller of the synced input limit and 500k before contacting
Codex. The gateway preserves the Claude error; Codex quota and client-side session labels
remain independent.
