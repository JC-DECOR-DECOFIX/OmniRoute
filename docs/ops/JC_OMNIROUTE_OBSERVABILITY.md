---
title: Omni Route account observability on the JC Mac
---

# Omni Route account observability on the JC Mac

`scripts/ops/omniroute-observability/` is a small companion service that reports, from Omni
Route's own records, which Claude subscription account is serving requests, how much of each
account's subscription quota is used, and when and why a request moved from one account to
another. It complements the account continuity policy in
[JC_CLAUDE_CONTINUITY.md](./JC_CLAUDE_CONTINUITY.md).

It runs as its **own process** under its own LaunchAgent. It does not load, patch, restart or
configure the gateway, and the gateway does not depend on it: stopping or removing it changes
nothing in request routing. It has no dependencies beyond Node itself (`node:sqlite`,
`node:http`, `node:crypto`).

## Data sources

Every poll (15 s by default) opens the gateway database **read-only**, runs a fixed set of
`SELECT` statements and closes it. Each statement names its columns explicitly; no statement
selects a credential column and no statement writes.

| Source                                      | Columns or fields read                                                                                                                                     | Used for                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `call_logs`                                 | `timestamp`, `status`, `provider`, `requested_model`, `model`, `connection_id`, `account` (compared only), `error_type`, `error_summary`, `correlation_id` | Current account, accounts in use, switches, last error  |
| `provider_connections`                      | `id`, `email`, `priority`, `is_active`, `test_status`, `rate_limited_until`                                                                                | Account list, state and cooldown end                    |
| `key_value` namespace `providerLimitsCache` | `fetchedAt`, `plan`, `quotas["session (5h)"]`, `quotas["weekly (7d)"]` (`used`, `resetAt`)                                                                 | Subscription quota and when it was read                 |
| `quota_snapshots`                           | `remaining_percentage`, `next_reset_at`, `created_at` for `session (5h)` and `weekly (7d)`                                                                 | A newer quota reading than the cache, when there is one |

Only `provider = 'claude'` rows are read, and only rows attributed to an account
(a `connection_id` of letters, digits and dashes, at most 64 characters) take part in the account facts; rows and connections with any other id are left out. Every text value is checked against the
shape it should have (model ids, error types, plan names, e-mails, ids, ISO 8601 timestamps) and dropped
when it does not match. Error summaries are free text: they are passed through a redactor that
replaces Bearer credentials, Anthropic keys, JWTs, `token=`/`api_key:`-style assignments and any
other long opaque run of key-like characters, and are truncated to 160 characters. Redaction is
a defense in depth, not a guarantee, which is why the report is served only on loopback with a
token. The unit test `tests/unit/omniroute-observability.test.mjs` fails if either
service file mentions a credential column name or if a seeded credential value reaches the
report.

## What "current account" means

The pool serves conversations in parallel, so there is no single account that "the gateway is
using". The configured priority is also not the answer: on 2026-11-19 at 00:17 UTC the first and
second accounts were serving different conversations at the same time.

The report therefore gives three distinct facts:

- `current`: the account of the **newest successful (2xx) Claude request** in `call_logs`, with
  its requested and effective model and timestamp. That is the account that most recently
  answered anything. Its e-mail comes from the OAuth connection record; `call_logs.account` is
  only a label (it can be a name or a short id), so it is never shown, and `emailConfirmed` says
  whether it equals the connection's e-mail.
- `inUse`: every account with a successful request in the last five minutes, with its request
  count.
- `switches` and `lastSwitch`: attempts of one client request share a `correlation_id`. When a
  failed attempt on one account is followed by an attempt of the same request on another account,
  that is a switch; it carries the failed attempt's status, error type and sanitized summary, the
  requested model, the model of the next attempt, and whether that attempt was served. Up to 20
  switches from the last seven days are kept, newest first.

Omni Route infers `session_tag` from message content; it is not a Happy session id. Mapping a
specific Happy conversation to an account needs the client to send an identifier, which it does
not do today, so the report does not attempt it.

## Subscription quota is not API usage

The quota figures come from the Anthropic OAuth usage endpoint that Omni Route itself reads per
account (`open-sse/services/usage/claude.ts`): `utilization` is the **percentage of the
subscription window already used**, with its reset time. They are not token counts or API spend,
and they are not measured by the observer.

Omni Route stores that reading in two places:

- `providerLimitsCache`, overwritten on every fetch and stamped with `fetchedAt`. Its background
  sync runs every 70 minutes by default (`PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES`,
  `src/lib/usage/providerLimits.ts`). The 5-second refresh after use in that module applies only
  to `antigravity`/`agy`, not to Claude.
- `quota_snapshots`, written by the in-memory quota cache (`src/domain/quotaCache.ts`), which
  rechecks each active OAuth account about every five minutes but writes a snapshot only on the
  first observation of a window or when its value changes. It rechecks only accounts already in
  that in-memory cache. A snapshot's `created_at` is when the value last changed, not when it
  was last confirmed.

When a fetch fails, Omni Route keeps the previous good cache entry with its original `fetchedAt`
(`mergeProviderLimitsCacheEntry`, `src/lib/usage/providerLimitsCache.ts`), so a failing vendor
read shows up here as an aging reading, not as a new one. A cache entry without a quota table, or
with no valid window, is not treated as a reading at all; a window key that is present but holds no valid percentage says nothing about that window (only an absent key is an omission); invalid snapshot rows are skipped in favor of the newest valid one; and a missing percentage is never read
as 0 % or 100 %.

Because the five-minute rechecks that find no change leave no record, an account whose usage is
steady can be reported `stale` although Omni Route confirmed it recently. The report shows the
newest reading it can prove, and its time.

For each window the newer of the two readings wins. Two cases deliberately show **no number**
instead of a guessed one:

- Anthropic omits the five-hour window when no session window is open. When a complete cached
  reading is newer than the last snapshot of that window and does not contain it, the window is
  `null` ("not reported"), never 0 %.
- When the reading's reset time has passed, the window shows `state: "reset_pending_reading"` and
  `usedPercent: null` until Omni Route reads it again.

## Account state

`accounts[].state` follows the gateway's own account selection (`isTerminalConnectionStatus` and
the cooldown check in `src/sse/services/auth.ts`):

| State                                    | Meaning                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `inactive`                               | `is_active` is off                                                        |
| `expired`, `banned`, `credits_exhausted` | Terminal status; excluded until an operator acts                          |
| `cooldown`                               | `rate_limited_until` is in the future; `stateUntil` is its end            |
| `active`                                 | Eligible for selection, including after a cooldown that has already ended |

The stored `test_status` is reported beside it as `testStatus`: an account can read `unavailable`
there while its state is `active`, because an ended cooldown no longer excludes it.

## Staleness

Two independent signals are reported:

- `observer.status` describes the observer itself: `fresh` while the last successful poll is at
  most two poll intervals old and the latest poll succeeded, `stale` from the first failed poll on (or when no poll has succeeded for two intervals), `unavailable` before the first
  successful poll. The endpoint answers 503 until the first report exists. While polls fail, the
  last good report is kept as it was: its account, quota and reset states are history as of
  `observer.lastSuccessAt`, and consumers must present them that way. `observer.lastError` holds
  only the error code (for SQLite also its fixed result text, such as `database is locked`), never
  the error message.
- `accounts[].quota.status` describes the vendor reading: `fresh` when the newest reading is at
  most 10 minutes old, `stale` when older, `unavailable` when there is no reading at all.

## Interface

`GET /internal/omni-route/usage` on `127.0.0.1` only, with `Authorization: Bearer <token>`. The
token is read from an owner-only file and compared in constant time.

| Response | Meaning                                         |
| -------- | ----------------------------------------------- |
| 200      | Report (`schema: "omni-route-usage/v1"`)        |
| 401      | Missing or wrong token                          |
| 503      | No successful poll yet; body carries `observer` |
| 404/405  | Other path or method                            |

`GET /healthz` needs no token and returns only `{ ok, status }`.

The service refuses to start when its configuration or token file is readable by group or others,
when a path is not absolute, or when the poll interval is below one second. A bind failure ends
the process with a `fatal:` log line so the supervisor retries it.

### Happy publisher

With a `happy` block in the configuration (`socketPath`, `tokenFile`, `artifactId`, optional
`heartbeatMs`), each report is also written to the data store of a Happy artifact under the key
`omni-route/usage`, through the local daemon socket, only when the report changed or at least once
per heartbeat (60 s). That is how the Happy desktop and phone apps can show it without any change
to those apps. The block stays absent until the panel itself has been approved.

## Installation on this Mac

Deploy from a merged commit of `jc/macos-v3.8.50`, never from a working tree.

```bash
SHA=$(git rev-parse --short=8 HEAD)
DEST=~/.omniroute/observability/$SHA
mkdir -p "$DEST"
cp scripts/ops/omniroute-observability/{aggregate,server}.mjs "$DEST/"
ln -sfn "$DEST" ~/.omniroute/observability/current
```

Configuration `~/.omniroute/observability/config.json`, mode 0600:

```json
{
  "dbPath": "/Users/giovanni/.omniroute/storage.sqlite",
  "authorizedConnections": [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ],
  "gateway": { "build": "INSTALLED_BUILD_SHA" },
  "tokenFile": "/Users/giovanni/.omniroute/observability/token",
  "listen": { "port": 20141 },
  "pollIntervalMs": 15000
}
```

Port 20141 is used because the installed gateway process itself listens on 20128, 20131 and 20132
(measured with `lsof` on 2026-11-19), and 20130 is the default port of the embedded 9Router
service. Check that the chosen port is free before loading the agent.

`authorizedConnections` is copied from `allowed_connections` of the continuity client
configuration; only that field is read from it, never its gateway credential. The token file
holds 32 random bytes in hex, mode 0600, generated once.

LaunchAgent `~/Library/LaunchAgents/com.jcdecor.omniroute-observability.plist` runs
`/opt/homebrew/bin/node ~/.omniroute/observability/current/server.mjs <config>` with
`KeepAlive` → `SuccessfulExit = false`, `ThrottleInterval = 15`, and logs in
`~/Library/Logs/omniroute/observability.{out,err}.log`. Load it with
`launchctl bootstrap gui/$(id -u) <plist>`.

Verify with a request without a token (401), one with the token (200), and compare `current` with
the newest 2xx Claude row in `call_logs` read independently. The gateway's process, build and
listener on port 20128 must be the same before and after.

## Rollback

```bash
launchctl bootout gui/$(id -u)/com.jcdecor.omniroute-observability
rm ~/Library/LaunchAgents/com.jcdecor.omniroute-observability.plist
rm -r ~/.omniroute/observability
```

The gateway is untouched either way.
