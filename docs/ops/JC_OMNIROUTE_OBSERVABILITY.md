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

| State                                    | Meaning                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `inactive`                               | `is_active` is off                                                 |
| `expired`, `banned`, `credits_exhausted` | Terminal status; excluded until an operator acts                   |
| `cooldown`                               | `rate_limited_until` is in the future; `stateUntil` is its end     |
| `active`                                 | Passes the stored-state filters, including after an ended cooldown |

The stored `test_status` is reported beside it as `testStatus`: an account can read `unavailable`
there while its state is `active`, because an ended cooldown no longer excludes it. `active`
only means the stored state does not exclude the account; whether it serves a given request
still depends on the authorized pool, the model (a model-scoped lockout lives in memory) and
quota policy.

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
| 400      | Malformed request target                        |
| 401      | Missing or wrong token                          |
| 500      | Unexpected error; `error: "internal_error"`     |
| 503      | No successful poll yet; body carries `observer` |
| 404/405  | Other path or method                            |

A 500 comes from an unexpected exception while a request is answered, on any path including
`/healthz`. The process keeps running and keeps the report it holds; if the response had already
started, the connection is closed instead.

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

### Manual refresh (the panel's "Atualizar" button)

With a `refresh` block as well, the panel can ask Omni Route for a new vendor reading of the
quotas. The service reads the key `omni-route/refresh-request` of the same artifact through the
daemon socket every `requestPollMs` (2 s). The value is
`{ "schema": "omni-route-refresh-request/v1" }`; other fields are ignored and the value is not
trusted. A request is identified by the entry's `version` (a UUIDv7, newer than the last one
seen), and its time is the entry's `updatedAt`. When the service starts, a request already in the
store is answered only if it is at most 90 s old; an older one is marked seen.

```json
"refresh": {
  "baseUrl": "http://127.0.0.1:20128",
  "tokenFile": "/Users/giovanni/.omniroute/observability/omniroute-access-token",
  "minIntervalMs": 120000,
  "requestPollMs": 2000,
  "timeoutMs": 60000
}
```

`baseUrl` must be an `http(s)` loopback origin (`127.0.0.1`, `localhost`, `[::1]`) with no
credentials, path or query; `tokenFile` is an absolute path; `minIntervalMs` is at least 60000,
`requestPollMs` 500–10000, `timeoutMs` 5000–120000; an explicit `null` is refused. The block
needs the `happy` block and a non-empty `authorizedConnections`. A `spacingMs` left from the
earlier per-account version is ignored: Omni Route spaces its own reads.

To read the quotas again, the service makes **one** call to Omni Route's own provider-limits
sync, `POST /api/usage/provider-limits` (`src/app/api/usage/provider-limits/route.ts`), the
dashboard's "refresh all". It runs `syncAllProviderLimits({ source: "manual" })`
(`src/lib/usage/providerLimits.ts`), **the same sync Omni Route runs on its own every 70
minutes**: it reads every active connection of a supported provider, not only the authorized
Claude accounts (on 2026-11-19, seven OAuth connections: three `claude`, one each of `agy`,
`codex`, `cursor` and `kimi-coding`), OAuth ones strictly one at a time with
`PROVIDER_LIMITS_SYNC_SPACING_MS` (1.5 s) between them, and stores the readings in
`providerLimitsCache` with a new `fetchedAt` when the call ends. A connection with an exclusive
lease is left out, as in the automatic run, and the automatic run's schedule does not move.

It differs from the automatic run in one respect: `source: "manual"` passes `forceRefresh: true`
for every connection, where the automatic run skips those whose cached reading is still recent
and does not force. For Antigravity (`agy`) that matters: **when Omni Route runs with
`ANTIGRAVITY_CREDITS=always`, a forced reading probes the account's credit balance with an
inference call that spends Antigravity credits** (`probeAntigravityCreditBalance`,
`open-sse/services/usage/antigravity.ts`); with the default (`off`) or `retry` it does not. On
2026-11-19 the gateway's LaunchAgent did not set that variable; its `.env` was not read, so
whether it is set there was not checked. Before relying on the button with an Antigravity
connection active, the operator should confirm that mode is not `always`, or accept that each
click may spend credits.

The request carries an empty body, `content-type: application/json` and
`Authorization: Bearer <token>`, where the token is an Omni Route access token (`oma_…`) of
scope **`write`**: a `POST` needs `write` (`src/server/authz/accessScopes.ts`); a `read` token is
answered 403. The token is created by the operator in the Omni Route dashboard and kept in
`tokenFile`, mode 0600, owned by this user; it is read again for every refresh and never logged
or published. While the file is missing or not owner-only, a request is answered with
`error: "not_configured"` and nothing is called. **A `write` token is more than this service
needs**: it is accepted by every non-admin management route of Omni Route that changes
something, so whoever obtains it can change Omni Route's configuration short of the admin-only
surfaces (access tokens, OAuth flows, providers, policy). It lives only in that file, and if it
leaks it is revoked in the dashboard (Settings → access tokens), which turns the button into
`gateway_auth_failed` until a new one is written to the file. The machine CLI token
(`x-omniroute-cli-token`) is not used: in the installed build (3.8.50, `09966db`) the compiled
middleware cannot read the machine id, so the server rejects every CLI token.

**What the gateway does on such a call.** What its automatic sync does, sooner and forced as
described above; the observer itself writes nothing. The sync does **not** pass `allowRotatingRefresh`, so it never
renews the OAuth credentials of a rotating-refresh provider (`claude`, `codex`, `kimi-coding`,
`open-sse/services/refreshSerializer.ts`): the Claude accounts' tokens are not touched. For the
other providers it renews a token near expiry, as the automatic run does. As in the automatic
run, a reading may clear a recovered account's transient error state
(`maybeClearRecoveredQuotaState`) and update the account's Claude bootstrap and extra-usage state
(`syncClaudeBootstrapIfNeeded`, `syncClaudeExtraUsageStateIfNeeded`; with the extra-usage block
policy on and extra usage queued, that puts the account in a cooldown until the reported reset).
When a read fails, Omni Route keeps the previous reading with its old `fetchedAt`.

`timeoutMs` (60 s) bounds the whole call, response body included (at most 1 MiB). After it the
database is read again, and an authorized account counts as updated when its quota `fetchedAt`
is at or after the start of the refresh. From Omni Route's answer only the status code and, for
the authorized accounts, the kind of error the sync recorded are used; the rest of the body
(which carries the cached limits of every provider) is not logged or published.

A timeout only ends the wait: the sync goes on in the gateway and stores its readings when it
ends. The accounts not yet updated then read `tempo esgotado`, and with none updated the round
fails with `gateway_timeout`. The minimum interval starts again at the timeout, and
`nextAllowedAt` says so, so the next sync waits a whole `minIntervalMs` (120 s) after it.

When the service starts, before it publishes anything, it reads its own last report from the
artifact and takes back the refresh state: the request it last answered is not answered again,
and the interval stays where it was. A refresh that was running when the service stopped is
reported `failed` and not repeated, and the next round waits a whole interval from the
restart, since that round may have timed out late without its longer wait being written. That report sits in a store the artifact's viewers can write,
so only well-formed values are taken back: a request version from the future, an interval more
than one interval ahead, or an unknown status is ignored, and texts are sanitized again. Until
that read succeeds (a store with no previous report counts), nothing is published and no
request is read; it is retried on every tick and request poll. The first read of the request key
after a start still ignores a request older than 90 s, whatever was taken back.

While `NODE_DEBUG` is set, Node may print request headers on stderr, so the gateway credential
is not read at all and requests are answered `not_configured`.

The gateway is called only after the `running` state has been written to the artifact. When that
write fails, nothing is called, the request is answered `failed` with `error: null`, and it does
not use the interval. Every write and read of the data store has a 10 s deadline for the whole
exchange, and a response that is cut off counts as a failure. At most one periodic publish
waits behind a slow write; later ticks join it, so a stuck daemon cannot pile up writes. Every
call, to the daemon and to Omni Route, goes through an agent of its own, never the process's
global agent, so a proxy set in the environment (`NODE_USE_ENV_PROXY` with `HTTP_PROXY`) never
sees a request or its credential, and `localhost` in `baseUrl` is used as `127.0.0.1`.

**Why at most one refresh every two minutes.** Each click runs one whole sync: every active
connection of a supported provider (seven on 2026-11-19) is read once, one at a time, 1.5 s
apart by default — what the automatic sync already does every 70 minutes. With the default
interval of 120 s there are at most 30 manual syncs an hour in the worst case, on top of the
automatic one, so at most 30 manual reads an hour per account, and never two reads of one
account at once. Omni Route already waits 180 s per token when `/api/oauth/usage` answers 429
(`open-sse/services/claudeUsageCooldown.ts`): Anthropic limits that endpoint on a scale of
minutes, and the quota is a whole percentage that moves slowly, so a shorter interval would
mostly earn stale answers. A request inside the interval does not call the gateway: the database is read again and
the request is answered as `throttled`. A request made while a refresh runs (by the store's
`updatedAt`, whether it is seen during the refresh or only after it) is answered as `throttled`,
even if the interval ran out meanwhile; since `last` holds one request, only the newest of them
is answered. Only one refresh runs at a time.

The result goes out in the published report (and in `GET /internal/omni-route/usage`) as
`refresh`, and is published as soon as it changes:

```json
"refresh": {
  "minIntervalMs": 120000,
  "nextAllowedAt": "2026-11-19T19:43:00.000Z",
  "last": {
    "requestVersion": "019a…",
    "requestedAt": "2026-11-19T19:41:00.000Z",
    "status": "done",
    "startedAt": "2026-11-19T19:41:00.200Z",
    "finishedAt": "2026-11-19T19:41:05.400Z",
    "accounts": [{ "shortId": "6726837b", "updated": true, "reason": null }],
    "error": null
  }
}
```

| `status`    | Meaning                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `running`   | Published before the sync call; `startedAt` set, `finishedAt` null                           |
| `done`      | Every authorized account has a new reading                                                   |
| `partial`   | Some accounts have one; the others carry a short `reason`                                    |
| `failed`    | None has; `error` holds the cause when the sync call itself failed                           |
| `throttled` | Inside the interval; `startedAt` null, `accounts` empty, `nextAllowedAt` is when it opens up |

`error` is `null` or one of `not_configured`, `gateway_unreachable`, `gateway_auth_failed` (401 or
403: the access token is wrong, revoked or not `write`), `gateway_timeout` or
`gateway_http_<code>`; it is `null` when the sync ran but read no account again. Per-account
reasons are fixed Portuguese texts shown by the panel as they are. When the sync ran, an account
the sync recorded an error for gets a text chosen from the fixed messages Omni Route throws (the
message itself is never kept): `em uso exclusivo` (exclusive lease), `credencial da conta
recusada` (the account's credentials failed), `Anthropic inacessível` (network or proxy failure)
or, for anything else, `a Anthropic não devolveu a cota (provável limite de consultas)`. An
account without a recorded error is `não incluída no sync do Omni Route` when the report shows it
inactive or does not list it, or when an exclusive lease kept it out of the sync. Leases are read
from the database just before the call, with the same rule as Omni Route
(`isConnectionUnavailableToAuxiliaryActivity`): an `ACTIVE` row of
`exclusive_connection_leases` not yet expired, or a connection listed in `allowed_connections` of
an active, unrevoked, unexpired key with the `lease:exclusive` scope in `api_keys`. Those two
statements select only `connection_id` and `allowed_connections`; no credential column is read.
If that read fails, no account is taken as leased. Any other account is `a Anthropic não devolveu
a cota (provável limite de consultas)`: Omni Route answered without quotas and kept the previous
reading. That cause cannot be told apart further: when `/api/oauth/usage` answers 429, the
installed build falls back to a legacy endpoint and reports that endpoint's message without
failing (`open-sse/services/usage/claude.ts`), so it is given as probable. When the call itself
failed, every account gets `credencial do painel recusada` (401/403),
`Omni Route respondeu HTTP <code>`, `tempo esgotado` or `Omni Route inacessível`. Without a `refresh`
block the report carries `"refresh": null` and the request key is never read. The log records
only events: `refresh requested`, `refresh done 3/3`, `refresh partial 1/3`,
`refresh throttled`, `refresh failed: <error>`.

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

To go back to the previous install (for example from the provider-limits sync to the
per-account version), only the observability service changes; the gateway is not touched:

```bash
ln -sfn ~/.omniroute/observability/<previous-sha8> ~/.omniroute/observability/current
cp <backup>/config.before.json ~/.omniroute/observability/config.json   # mode 0600
launchctl kickstart -k gui/$(id -u)/com.jcdecor.omniroute-observability
```

Removing the `refresh` block from the configuration and restarting the service is enough to turn
the button off (the panel then shows manual refresh as unavailable); revoke the access token in
the Omni Route dashboard as well when it is no longer needed.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.jcdecor.omniroute-observability
rm ~/Library/LaunchAgents/com.jcdecor.omniroute-observability.plist
rm -r ~/.omniroute/observability
```

The gateway is untouched either way.
