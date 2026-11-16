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

The published package additionally contained upstream migration
`163_model_capabilities.sql`, already applied locally on 2026-09-17. It is retained
byte-for-byte from the actual upstream build commit
`dea6bb8b6b64d3a3d9f639a044625c3452442c56` (SHA-256
`f1c75ae4b6e15c3af225c0d86816ec4129a10e00130b528e23311be9a5b0df05`).
The other 159 migration SQL files and 3,227 comparable installed source files
matched the base tag. Fresh creation, reapplication and a populated legacy table
are tested without changing the live database.

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
If all upstream accounts reject authentication, the accepted gateway request
returns HTTP 502 with `upstream_status: 401` and code
`upstream_accounts_unavailable`. Invalid gateway credentials retain HTTP 401.
Terminal pool exhaustion includes `x-should-retry: false`, so the Claude Code
client reports the recovery message instead of retrying an unavailable pool.
Temporary usage exhaustion retains its reset time and `Retry-After` for a later retry.
The normal authorized account selector uses configured priorities, excludes
terminal states, applies cooldowns, and clears recoverable errors only after
successful use. Cooldown-aware request restarts are disabled in this mode;
each selected account is excluded after failure for that request.

The dedicated client's API key must have `allowedConnections` set to the explicitly
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
Post-output interruptions use the distinct SSE error type
`upstream_interrupted_error`, rather than a generic `api_error` that Claude Code
can automatically continue. This applies to both a dropped stream and an
upstream error frame, using the existing frame parser across split network chunks.
The real CLI preserved partial text, displayed the explicit recovery and made no
further text request in isolated protocol tests. A fully completed tool block can
still produce the client's normal next turn with its original `tool_result` under
existing permissions; that is a context-preserving continuation, not reexecution
or a server-side splice into the interrupted stream.

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

The continuity OAuth flow also excludes `org:create_api_key`: the original grants
did not contain that scope. Recovery retains the subscription user scopes and
does not grant organization API-key creation or switch to paid API billing.

Native Claude Code requests keep their validated client version and billing
entrypoint on the native Claude provider. A real VS Code 2.1.319 request for
`claude-fable-5-2` exposed the prior downgrade to 2.1.220: upstream rejected the
model because it requires at least 2.1.290. The correction preserves a strictly
parsed, matching native User-Agent/billing pair, including newer billing lines
without CCH. Older CCH-bearing requests are re-signed after routing changes.
Absent, duplicate, malformed or inconsistent pairs keep the existing pinned
fallback. Other providers and compatible relays retain their defaults. Client
authentication is never forwarded as upstream authentication. Acceptance must
repeat the request through the actual VS Code extension with the same model;
changing models would conceal this regression.

The native entrypoint allowlist includes `cli`, `sdk-cli` and `claude-vscode`.
The installed 2.1.325 VS Code GUI sets `CLAUDE_CODE_ENTRYPOINT=claude-vscode`;
the signed binary emits that value in both User-Agent and billing. Restricting
the parser to the first two entrypoints passed a bundled CLI test but left the
actual GUI on the old fallback identity. Regression tests exercise the measured
VS Code pair through the executor, preserve tool history and reject unknown or
mismatched entrypoints. Operational acceptance must include the GUI submission.

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

## Operational evidence and final authorized pool (2026-11-15)

An actual GUI POST subsequently showed the complete native User-Agent includes
`, agent-sdk/0.3.325` after `claude-vscode`. The isolated binary entrypoint probe
did not include that SDK environment and was not a complete GUI wire fixture.
The parser accepts only a bounded numeric SDK version on the measured VS Code
entrypoint, still requiring matching CLI version and entrypoint in billing.
The full executor regression now covers this actual GUI identity as well as
the plain native and SDK CLI forms. Positive GUI acceptance remains a separate
operational check after installation.

The account holder explicitly excluded Financeiro (`78dc4b41...`) from failover.
The account holder subsequently requested adding `gigiosanches@gmail.com`. The
production traffic key and private client configuration now authorize only the
following connections, in configured priority order:

| Account prefix | Priority | Continuity policy      |
| -------------- | -------- | ---------------------- |
| `6726837b...`  | 1        | First eligible account |
| `598035c1...`  | 2        | Next eligible account  |
| `bd7bc37c...`  | 4        | Third eligible account |

The original first two accounts were recovered under their existing IDs. Gigio
was provisioned through the same official OAuth flow as a new connection. Its
identity was verified before persistence; its refresh grant is stored privately
and never shared with canary processes. Global priority 3 still belongs to the
excluded, inactive Financeiro record, so Gigio has global priority 4 and is third
among authorized candidates. No existing account was silently relabeled.
Financeiro was not recovered, reactivated, deleted, or used for inference.

The first persistent continuity build was `1e791d7`, from reviewed source commit
`1e791d754a991f533f747739a5f1721caf3284b5`, integrated by
`d0005c076dee5ceeee904b0409d00f5744d3e6d3`. Later executable build IDs and VS Code
request results are recorded in the private mission checkpoint after installation.
One LaunchAgent supervises one loopback listener.
The private environment preserves the original encryption, gateway and JWT
secrets. Migration 163 remains applied and SQLite integrity checks pass.

The installed client and actual VS Code bundled Claude Code 2.1.319 completed
real `claude-haiku-5-5` inference through port 20128. An isolated gateway clone
then completed these real-account checks, with background work disabled and no
refresh tokens in the clone:

- Healthy priority 1: one attempt, `CONTINUIDADE_OK JCMAC-731`.
- A synthetic invalid access token on priority 1, only in the clone: real upstream
  HTTP 401, then priority 2 succeeded after two account attempts with the same
  model and context marker.
- Both authorized accounts invalid only in the clone: two upstream attempts,
  explicit account reauthentication guidance, and no inference through Financeiro
  or any other provider/model.
- An explicit fixed account did not switch to its healthy sibling.

The original production credential pairs and priority order were unchanged by
these canaries. The two-account policy was exercised again after the Financeiro exclusion. After
the owner requested Gigio, a further real canary used the final three-account
allowlist: A and B received invalid access credentials only in the disposable
clone, real upstream authentication failed, and Gigio answered successfully after
three account attempts. `claude-haiku-5-5` and context marker `JCMAC-731` were
preserved. All production credential pairs and priorities remained unchanged. An
explicit Financeiro pin on the live gateway had already been rejected with zero
upstream attempts; Financeiro remains absent from the expanded allowlist.

The VS Code machine setting `claudeCode.claudeProcessWrapper` now points to the
installed `~/.local/bin/claude-continuity`. Existing native processes were
preserved; already running native sessions keep their original authentication
until safely reopened or resumed. This setting alone is not evidence that an
existing process changed its request path. Real bundled-client inference and
failover evidence are recorded separately from authenticated dashboard and
native UI acceptance in the private mission checkpoint.

Backups, sanitized reports, final policy, client activation proof, and rollback
are under `~/.omniroute/mission-backups/20261115T124526/`. Additional real inference
and canary reports are in the adjacent `continuity-live-inference-*` and
`continuity-real-canary-*` directories. These files contain no printed tokens or
keys; private configuration and SQLite backups remain owner-only.
