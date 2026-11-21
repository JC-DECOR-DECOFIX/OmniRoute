---
title: "Earliest Quota Renewal First"
version: 3.8.50
lastUpdated: 2026-11-21
---

# EARLIEST_QUOTA_RENEWAL_FIRST — account selection by earliest quota renewal

Provider-level account strategy `earliest-quota-renewal`. Among the healthy accounts that can
serve exactly the requested model, a new session goes to the account whose usable quota renews
soonest. It replaces static priority, least-used and LRU ordering for that provider only.

Source: `src/sse/services/quotaRenewalRanking.ts` (ranking), wired in
`src/sse/services/auth.ts::getProviderCredentials` and in
`src/sse/services/sessionAffinityPin.ts` (new session pins).

## Decision order

The ranking only reorders connections that already passed every existing filter of
`getProviderCredentials`: requested model (per-account model rules, synced inventory), active
connection, terminal status (`expired`, `banned`, `credits_exhausted`), connection cooldown,
model lockout, quota policy, quota exhaustion, API-key `allowedConnections` and leases.

| Tier | Condition                                                                                                                                                                                                   | Order inside the tier                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A    | Reading ≤ 10 min old, weekly window with headroom and a future reset, 5h window idle, with headroom, already past its reset, or omitted by a live reading (no 5h session open)                              | Earliest reset of the limiting weekly window, then 5h headroom, then priority |
| B    | Uncertain data: no reading, reading older than 10 min, weekly window missing, weekly reset in the past, a window used but without a reset, unparseable reset, `exhausted` flag contradicting the percentage | Configured priority                                                           |
| Out  | Weekly or 5h window exhausted with a future reset (usage only grows inside a window, so this holds even for an old reading; the 5h case clears when its reset passes)                                       | Not selectable                                                                |

- Missing data is never read as 0 % nor as 100 %: it is tier B, behind every tier A account.
- A model-scoped weekly window (`weekly <scope> (7d)`, e.g. `weekly opus (7d)`) limits only
  requests whose model contains the scope.
- When every candidate is out, the pool is left as it was, so the existing pipeline keeps its
  behaviour: honest 429 with `Retry-After` from the first account to recover, and the model
  fallback chain already authorized (Fable → Opus, last rung GPT-6.2 Sol).
- Freshness limit `QUOTA_RENEWAL_FRESH_MS` = 10 min. Measured on the production database on
  2026-11-21: live readings arrive every 5–6 min (quota cache refresh) plus on-demand refreshes,
  so 10 min is two cadences and matches `QUOTA_FRESH_MS` of the observability aggregate.

## Sessions

- Session key: `X-Claude-Code-Session-Id`, or the `session_id` inside `metadata.user_id` (JSON or
  legacy form). A loopback capture on 2026-11-21 confirmed that the terminal CLI, VS Code, Happy's
  `claude_code` harness (Agent SDK) and Happy's own harness (both run the Claude Code binary)
  send the same UUID in both places, stable across `--resume` and new for each new session.
  Explicit `x-session-id` / `x-omniroute-session` / `x-codex-session-id` keep precedence.
- A new session is pinned to the first ranked account. The pin is claimed atomically
  (`claimSessionAccountAffinity`, first writer wins) and persisted in SQLite (`key_value`,
  namespace `session_account_affinity`, hashed keys), so it survives a restart.
- The session stays on its account while the account remains in tier A or B. It does not move
  because another account became better. It is re-evaluated on a new session, when the pin
  expires (sliding TTL), or on a real event: 429, quota exhausted, credential failure, terminal
  status.
- An operator pin (`x-omniroute-connection`) keeps precedence.
- Accounts never change after useful streaming output: the Claude continuity retry runs only
  before the first useful output (`src/sse/handlers/chat.ts`).

## Observability

- Response header `X-OmniRoute-Account-Selection`, e.g.
  `EARLIEST_QUOTA_RENEWAL_FIRST; tier=A; pos=1/2; reason=weekly_usable_earliest_reset; window=weekly; reset=<UTC>`.
- `GET /api/usage/account-selection?provider=claude` (management auth): per-account windows,
  tier, position, reason, freshness, last sync, the chosen and reserve accounts, persisted pins,
  recent sessions with their effective model and the failover log. Credential-free.
- Failovers and operator pins that move a session are recorded in `key_value` namespace
  `account_failover_events` (bounded to 500, session key stored as a sha256 prefix).
- Per-session activity (account, effective model, client family from the Claude Code
  User-Agent — `claude-code-cli`, `claude-code-vscode`, `happy-claude-code`, `agent-sdk` — and the
  last account change with its reason) is kept in `key_value` namespace
  `account_session_activity` for 24 h. Its session hash equals the first 16 hex characters of
  the session pin key, so pins, activity and failover events join without the raw identifier.
- The gateway persists its last ranking in `key_value` namespace `account_selection_ranking`;
  `scripts/ops/omniroute-observability/aggregate.mjs` publishes it in `omni-route-usage/v1`
  (`pool.policy`, `pool.chosen`, `pool.reserve`, `accounts[].selection`, `accounts[].sessionPins`,
  `failoverEvents`, `sessions`), falling back to its own mirror of the rules when that decision is older
  than 15 min.

## Turn on, turn off, roll back

Enable for Claude only (settings, namespace `settings`, key `providerStrategies`):

```json
{
  "claude": { "fallbackStrategy": "earliest-quota-renewal", "sessionAffinityTtlMs": 3600000 }
}
```

`sessionAffinityTtlMs` here is scoped to the provider and honored only together with
`earliest-quota-renewal`. 60 min matches the longest prompt-cache lifetime: after an hour without
use, moving a session to another account loses no cache.

Roll back by configuration: set `providerStrategies.claude.fallbackStrategy` back to `priority`.
That single key restores the previous behaviour exactly (priority order, no session pins), and
the scoped TTL becomes inert. Existing pins expire on their own.

Codex is intentionally left on its own strategy: the pool has a single Codex account and the
Codex account pool already rotates by its own quota scopes. GPT/Codex requests never enter the
Claude pool.

## Tests

`tests/unit/quota-renewal-ranking.test.ts`, `tests/unit/earliest-quota-renewal-routing.test.ts`,
`tests/unit/claude-code-session-key.test.ts`, `tests/unit/account-selection-audit.test.ts`,
`tests/unit/account-selection-report.test.ts`,
`tests/unit/omniroute-observability-selection.test.mjs`.
