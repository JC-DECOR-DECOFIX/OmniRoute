---
title: Claude account continuity on the JC Mac
---

# Claude account continuity on the JC Mac

This maintained branch starts from upstream OmniRoute v3.8.50, commit
`5458026c216f77a3da68ea49152dc33470cfe2cb`. The installed critical source files
matched this tag on 2026-11-15; the original bundled `dist/BUILD_SHA` read `dea6bb8`.
The npm repository URL redirects from `diegosouzapw/OmniRoute` to
`cheaper-inference/OmniRoute`. The local build is identified by its committed build SHA. JC's canonical maintenance branch is
`JC-DECOR-DECOFIX/OmniRoute:jc/macos-v3.8.50`.

## Observed cause and request path

The three Claude connections, in configured priority order, were inactive,
expired and without refresh tokens. Original application logs show HTTP 400,
`invalid_grant`, **Refresh token expired**, at:

| Account prefix | Priority | Original rejection (UTC) |
| -------------- | -------- | ------------------------ |
| `6726837b...`  | 1        | 2026-10-17 20:28:37      |
| `598035c1...`  | 2        | 2026-10-15 03:28:36      |
| `78dc4b41...`  | 3        | 2026-10-16 04:10:35      |

The scheduler's generic "consumed" message did not establish reuse or a race.
Historical cause beyond the provider's expiration response remains unproven.
Subscription expiration and usage exhaustion were not established for these
gateway records. One native Claude transcript independently reported its
five-hour usage limit, resetting at 14:00 America/Sao_Paulo on 2026-11-15.

Inspected running VS Code Claude processes had no gateway base URL, gateway
credential or connection pin. Global settings had no `apiKeyHelper`. Those
processes used the native path; they were preserved. The official CLI's read-only
`auth status` independently reported `loggedIn=true`, `authMethod=claude.ai`,
`apiProvider=firstParty`, and `subscriptionType=max`. Mission Worker uses the
gateway only when explicitly configured as `OMNIROUTE`. Its AUTO environment
builder already strips inherited pins. Engineering Control's separate AUTO
builder still retains an inherited pin and must not be used as proof of this
client's AUTO behavior.

One production LaunchAgent was loaded: `com.jcdecor.omniroute`, supervising the
CLI and one server listening on `127.0.0.1:20128`. The on-disk plist contained
invalid XML comments and must be serialized as a valid plist when installing.

## Policy and changes

Set `OMNIROUTE_CLAUDE_ACCOUNT_CONTINUITY_ONLY=true` in this installation's private
environment file to enable the policy. The default remains off for upstream
compatibility. Claude requests retain their model, messages and tools. They
cannot use emergency provider fallback or intra-family model substitution.
The live Claude strategy was verified as `priority` and session affinity as `0` ms.
For native Claude Code model IDs without a provider prefix, explicitly enable the
existing `preferClaudeCodeForUnprefixedClaudeModels` setting. Together with the
continuity flag, that preference stays on the subscription route even when all
Claude accounts are inactive, so the client receives account recovery guidance.
Explicit provider prefixes retain their meaning; no model ID is substituted.
The normal authorized account selector uses configured priorities, excludes
terminal states, applies cooldowns, and clears recoverable errors only after
successful use. Cooldown-aware request restarts are disabled in this mode;
each selected account is excluded after failure for that request.

The dedicated client's API key must have `allowedConnections` set to the three
approved IDs, only traffic scope, and Claude model/endpoint restrictions. Existing
shared keys are not changed. AUTO strips inherited `x-omniroute-connection`;
`fixed_connection_id` emits an explicit pin. A direct explicit pin never silently
degrades to automatic selection. Existing reset-aware combo behavior is retained.

Before useful streaming content, lifecycle/ping frames are buffered and a failed
account can yield to the next authorized account. Readiness is bounded by its
timeout and a 256 KiB pre-output buffer. Once text, reasoning or a tool call has
been forwarded, another account is never spliced into that stream. A drop emits
an explicit SSE error explaining recovery from preserved conversation context;
completed tools and external effects must not be replayed.

The existing per-connection in-process refresh mutex remains. Metadata writes
now read, merge and write inside one SQLite transaction after asynchronous
validation. Refresh persistence additionally compares the attempted credential
pair inside that transaction. Late successes return the current pair without an
unguarded second persist; late terminal failures cannot deactivate a newer login.
This does not claim a distributed OAuth lock across independent installations.
Only one production supervisor is supported for this data directory.

Claude `invalid_request` is a rejected refresh request, not evidence of consumed
credentials. It stops immediate retries and receives scheduler backoff.
`invalid_grant` retains an expiration/rejection reason. Failed rotating Claude
refresh credentials are not destroyed merely on that generic classification.
No invalid connection is reactivated by this change.

The continuity OAuth flow also excludes `org:create_api_key`: the three existing
grants did not contain that scope. Recovery retains the subscription user scopes
and does not grant organization API-key creation or switch to paid API billing.

## Persistent client and operational verification

`scripts/ops/claude-continuity-client.mjs` accepts the Claude binary followed by
its original arguments, including VS Code's `claudeProcessWrapper` invocation.
It reads `~/.omniroute/claude-continuity-client.json` (owner-only, mode 0600):

```json
{
  "base_url": "http://127.0.0.1:20128",
  "gateway_key": "REPLACE_WITH_DEDICATED_KEY_LOCALLY",
  "allowed_connections": ["APPROVED_ID_1", "APPROVED_ID_2", "APPROVED_ID_3"]
}
```

Never print that file or put its credential in shell arguments. For an isolated
canary, `CLAUDE_CONTINUITY_CONFIG` can name a separate owner-only config. Native
sessions already running are not changed. Switch a consumer to this client only
after its accounts are authenticated and a real inference succeeds.

Real acceptance requires the committed, installed client and server: a consistent
SQLite clone on another loopback port, only the approved Claude accounts/key/model,
all refresh tokens removed **only from the clone**, and all background services
off. Prove A's real inference, then replace A's access credential **only in the
clone** with an invalid synthetic value. A real upstream 401 must lead to B's real
inference with the same model and context. Restore/discard the clone afterward.
No production credential is revoked, refreshed by the canary, or restored blindly.
Health and model listings are not acceptance evidence.

## Validation and rollback

Focused behavioral tests cover A/B/C exhaustion, gateway versus upstream auth,
fixed/AUTO selection, authorization boundaries, cooldown recovery, same-model
404/billing handling, pre/post-output streaming, partial tools, concurrent refresh,
late responses and metadata lost updates. Fixtures and mocked fetch exist only in
tests. `npm ci` on the original tag failed with a missing optional
`brace-expansion@1.1.22` entry; the lockfile correction makes the CI install
reproducible.

Before installation keep a SQLite online backup with `integrity_check=ok`, the
private environment/client settings, LaunchAgent plist and the complete previous
npm package. Deploy a built package, not loose edits under node_modules. Retain
the previous package and plist for rollback. Never restore the database backup
over credentials that were reauthenticated after it was taken; reconcile only
the specific reversible configuration changes.

The 2026-11-15 implementation checkpoint has no real failover acceptance yet:
official OAuth is open, but the browser account does not match the authorized
three. The account holder must select the correct account. Existing credentials
remain inactive until successful official authentication. This is an authentication
blocker, not a claim that implementation tests establish operational completion.
