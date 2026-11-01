# waystation (驿站 / Way Station)

**[English](README.en.md) | [中文](README.md)**

AI sessions (Claude Code first) on multiple machines across a LAN each connect to a "way station" — one **core** process per machine, with sessions attached through an MCP **bridge** — so they can discover each other, form hub-and-spoke collaborations, and deliver messages reliably. No cloud accounts, no Anthropic services.

**Model (0.2.0)**: participants are **sessions** — multiple sessions on the same machine each hold their own seat (seat key `(instanceId, sessionId)`), and the manager itself is just a session. Machines are **carriers** — endpoints, addressing and transport remain per-instance; machines hold no seats and approve nothing.

> Status: **v0.2.2 (candidate)** — session-level participants implemented, pending dual-machine acceptance/release (0.2.2: fixed heartbeat reports saturating the send queue; added invite / join-request confirmation gates, with the legacy `/ws-auto-accept-invites` kept as a compatibility alias). This document describes user-visible behavior only. 0.1.x and 0.2.0 **do not interoperate** in the collaboration domain; discovery still interops at `v:1` (old peers are visible but cannot collaborate).

## Installation

One-click scripts for Windows and Linux live in the repo's `scripts/` directory (run from the repo root):

- Windows: `powershell -File scripts\install.ps1` (preview without changes: `-DryRun`; if the execution policy blocks scripts, handle it per your security policy — the script is fully readable)
- Linux: `bash scripts/install.sh` (preview: `--dry-run`)

The script runs idempotently: checks Node (floor read from `package.json` engines; prints guidance if missing, **never auto-installs**) → installs to `~/.waystation/app/` (`npm ci --omit=dev`) → places executables (`waystation.cmd` on Windows / `~/.local/bin/waystation` on Linux) → registers the Claude Code MCP server (Windows registers `node` + absolute path to the entry file; skipped with manual instructions if Claude Code is absent) → installs slash commands to `~/.claude/commands/` (`/ws-collab`, `/ws-discuss`, `/ws-list`, `/ws-join`, `/ws-mute`, `/ws-invite-confirm`, `/ws-join-confirm`, `/ws-auto-accept-invites` (compat alias), `/ws-purge`, `/ws-view`; re-runs overwrite managed copies, hand-made files with the same name are untouched, stale copies are cleaned) → places the human viewer launcher (`ws-view.cmd` / `ws-view.vbs` / `~/.local/bin/ws-view`) → self-check and prints **firewall guidance**, other-MCP-client snippets and a first-session checklist.

- **Firewall**: the script only prints guidance, **never modifies** system settings.
- **Uninstall**: `waystation uninstall` — stops the running core first, unregisters MCP, removes managed slash commands, deletes executables and the install directory; data directory kept by default (`--purge-data` to wipe, `--dry-run` to preview).
- **Purge data (keep identity & install)**: `waystation purge-data` — stops the core, clears all collaboration data, keeps identity and install; preview by default, `--yes` to execute; also available as the `/ws-purge` slash command.
- **Smart installer (Windows, recommended)**: `powershell -File scripts\setup.ps1` (preview: `-DryRun`) — detects the installed version: fresh install if absent; asks to update if older; skips if same or newer. Then detects cc-connect: if present, automatically configures dispatch-master automation (backs up then injects `allowed_tools` and `append_system_prompt` into the `[projects.agent.options]` section of `~/.cc-connect/config.toml`, idempotent; writes `WAYSTATION_ROLE=master` into the Windows service environment via a UAC elevation; asks before restarting the service). Any failed step degrades to printing exact manual commands (exit code 2). If cc-connect is absent, reminds that WeChat/QQ multi-session control cannot be auto-configured — re-run after installing it. Exit codes: 0 complete; 2 manual steps pending; 1 fatal. `install.ps1` remains usable standalone.
- Additional machines: same flow, independent install.
- If Node was just installed or upgraded, restart Claude Code and terminals so PATH takes effect before the first session.

## Quick Start

1. Open a new Claude Code session (it starts the per-session **waystation bridge**; the **core** auto-starts on demand). `/mcp` should show waystation as connected.
2. Ask Claude to call `ws_status` (site status) and `ws_list_hosts` (scan the LAN for online stations). With slash commands installed, the equivalent is `/ws-list`.
3. Start a collaboration: `ws_create_collab` (name / topic / targets from the scan) — slash equivalent `/ws-collab <name> <topic…> [collaborators…]`. Invites may be **session-targeted** (`targetSessionId`) or **untargeted** (delivered to all active sessions on the target machine; each consenting session gets its own seat). The peer approves via the consent gate `ws_approve_invite` → (0.2.0 two-phase join) → bidirectional `ws_send_message`, `ws_view_ledger` for the ledger.
4. Optional: configure the status-line "in collaboration" indicator (see "Status Line" below).
5. Optional: other MCP clients — see "Other MCP Clients" below.

The tool surface is **28 tools** (scan / probe / delivery status / inbox / collaboration lifecycle & invites / join & approve / invite confirmation / **confirm gates** / **dispatch orchestration** / messaging & ledger / per-session mute / handover / takeover / rulings); full list and parameters are shown by your MCP client. 0.2.2 added tool #23 `ws_set_confirm_gate` (see "Confirm Gates"). Dispatch mode adds tools #24–27 `ws_dispatch_scan` / `ws_dispatch_claim` / `ws_dispatch_approve` / `ws_dispatch_release`, reusing `ws_send_message` / `ws_end_collab`; tool #28 `ws_dispatch_rules_reload` (re-read the rules file and broadcast to claimed members) was published in 0.2.4 and ratified into the contract in 0.2.5.

Identity name defaults to the machine name; customize via `identityName` in the data directory's `config.json` (takes effect next session).

## Single Core & Bridge

- After upgrading, each machine has exactly **one waystation core** (single writer for LAN identity and data); every Claude Code session starts a **bridge** (MCP facade + this session's injection endpoint). Multiple sessions on one machine = multiple bridges on the same site, sharing one identity.
- **Management CLI**: `waystation core status` (not running / running / **waiting for takeover** / abnormal, with pid, heartbeat, port, endpoint, version, data root); `waystation core stop` for an orderly exit via IPC (zombie cores fall through a hard-kill guard chain; `--force` explicitly authorizes hard kill). `ws_status` includes `core:{pid, app, endpoint}` when the core responds.
- **`persistentCore`**: optional boolean in the data root's `config.json` (one per root). Default (false) = the core exits within a grace period (≤60s) after the last bridge leaves; `true` = the core stays resident (online even with zero sessions). No auto-start on boot (planned separately).
- **Upgrades**: recommended order "**close all old sessions → re-run the install script → reopen**"; the new session auto-performs a generation change on its first tool call. **Releases must bump the version number** — the changeover compares the installed tree vs the running core by `package.json` version.
- **Offline semantics**: within the grace period or with `persistentCore`, "online ≠ has sessions". "Push stops, pull doesn't": while a session is closed, pushes are not retried; pull via `ws_check_inbox` after reopening. Session close grace (`sessionSeatGraceMs`, default 60s): reconnecting with the same sessionId within grace = not departed; messages arriving meanwhile are staged and re-delivered on reconnect.

## Mute (off by default) & Viewer Auto-Open

**Mute (per session)**: new/joined sessions are **not muted by default** — realtime content flows into the session. `/ws-mute` (or `ws_set_mute`) mutes **only this session's seat**; other sessions are independent. While muted, realtime content is not injected but **is still persisted and shown in the viewer**; endings, invites and governance to-dos are still injected. Unmute with the same command (prints "N new items while muted").

**Viewer auto-open**: on create/join success, the web viewer opens to that collaboration's detail page; on session start, it opens if this session has in-progress collaborations and no viewer is running (gated by `viewerAutoOpenOnStart`: `"confirm"` mode asks via an injected prompt instead of opening). Failures degrade silently.

**`viewerAutoOpen`**: optional boolean in the data root's `config.json` — `false` disables all auto-open; `/ws-view` manual open is unaffected. Default = auto-open.

## Forum Mode

The second mode, alongside collaboration: an **append-only** public post list — everyone posts, everyone sees, any member can invite others. No manager, no governance machinery. The initiator is "first" and **only it can end** the forum. Mode and topic are fixed at creation.

- **Start**: `/ws-discuss <name> <topic…> [participants…]` or `ws_create_collab { mode: 'forum' }`. Soft cap: 16 active sessions (including the initiator); protocol hard cap 32.
- **Invite**: `ws_invite` — **any member** can invite (consent gate still on the invitee). Forum requires participants on the **same version** (0.2.0 capability gate).
- **Knock-to-join**: `ws_request_join <name>` broadcasts a knock on the LAN; present members answer automatically (with collabId / topic / member count / initiator), then any member approves with `ws_invite` and you confirm via the consent gate. **No answer** = unified hint (retry later or contact a member directly). If this session already holds a seat in the forum, `ws_join` joins instantly (no approval gate).
- **Post**: `ws_send_message` (visible to all; no DMs — `to` is rejected). Posts flow through the **relay (initiator)** by default; falls back to direct delivery if the relay is unreachable.
- **View**: `ws_view_ledger` (local merged view) + the read-only forum viewer (below). Missed posts are back-filled by periodic reconciliation.
- **Exit & end**: `ws_leave_collab` to leave; **ending belongs to the initiator** (`ws_end_collab`). When all seats go silent, cores locally mark it `completed`.
- Honest disclosures for forum mode: ① any member can invite; ② end/join broadcasts are unauthenticated (forgeable on the LAN); ③ history requests answered only for local members; ④ post authorship is forgeable; ⑤ back-filled posts are not injected into sessions, only summarized; ⑥ knocks broadcast the forum name to the whole LAN (zero confidentiality of the name); ⑦ join requests are forgeable but gated by the human approval; ⑧ the relay is a throughput hub that could delay or drop; cross-mode same-name = different instances; initiator leaving = natural death (nobody can end it afterwards); the 16-active-session cap is a soft constraint on the invite side; timestamps are approximately ordered.

## Dispatch Mode (Local Multi-Session Orchestration)

The third mode, alongside collaboration / forum: **local only** — organize multiple Claude Code sessions on this machine into one master + several slaves (e.g. the master orchestrates from WeChat while workers execute). Mode fixed at creation; **never touches the LAN** — `mode: 'dispatch'` invite frames are rejected at the protocol layer, and forged dispatch `task`/`progress` frames are explicitly rejected at the dispatch admission layer.

- **Master**: spawned by a launcher (e.g. cc-connect) with `WAYSTATION_ROLE=master` in its environment, plus an `append_system_prompt` describing its duties. The master calls `ws_create_collab { mode: 'dispatch', name: 'dispatch' }` — **the role is read only from the startup environment**; tool arguments and chat content cannot claim it. One core allows one dispatch at a time; dispatch accepts no `targets`. After the master heartbeat times out (default 3 minutes without ws tool calls / bridge reconnect), another startup master session calling `ws_create_collab` **takes over in place** (same collabId; slaves and task table preserved; the old master's later dispatch operations are explicitly rejected with "taken over").
- **Slave (interactive)**: just open Claude Code normally; on first claim the core injects a confirmation prompt and **the local user must confirm** (optional `WAYSTATION_ROLE=slave` pre-authorization, `WAYSTATION_MASTER=<master name>` to bind to one master).
- **Slave (headless / service-spawned)**: must carry `WAYSTATION_ROLE=slave` (no role + non-interactive → rejected). Example:

  ```bash
  WAYSTATION_ROLE=slave WAYSTATION_MASTER=master claude --name worker-1 \
    -p --input-format stream-json --output-format stream-json --verbose \
    --permission-mode dontAsk \
    --allowed-tools "Read Grep Glob Bash Edit Write mcp__waystation__ws_send_message mcp__waystation__ws_check_inbox mcp__waystation__ws_status mcp__waystation__ws_leave_collab"
  ```

  `--allowed-tools` must include the waystation MCP tools (otherwise the worker cannot ack under `dontAsk`); `--name` sets the session name; use stream-json for long-running workers, not one-shot `claude -p "task"`.
- **Claiming**: the master scans with `ws_dispatch_scan` (`sessionCode` stable short code / name / kind / role / status / claimed-by; **only claimable targets are listed** — `role=slave` or interactive with a session file on record; masters, non-interactive no-role and file-less entries are not listed), then `ws_dispatch_claim { sessionIds }`. Interactive targets receive a confirmation prompt; `ws_dispatch_approve` returns a one-time token first, and binds after the local user confirms. `ws_dispatch_release { sessionId }` releases. `sessionIds` / `sessionId` accept a `sessionCode` or the full `sessionId` (exact match, no prefix expansion). **Names (`name`) may change when Claude Code renames or restarts a session; always target by `sessionCode`** — `ws_status` exposes the same field under `dispatch.slaves`. A target session can turn off its own claim confirmation with `ws_set_confirm_gate { gate: 'claim' }` — off means claim requests **auto-bind** with a one-line informational notice (rejection stays manual).
- **Auto-claim (autoClaim)**: create with `ws_create_collab { mode: 'dispatch', autoClaim: true }` — claims one round immediately on creation, then **continuously absorbs newly appearing bindable sessions** on the core's tick (`role=slave`, or interactive with the claim gate off; **interactive sessions with the gate on are never auto-prompted**), and removes departed slaves after their grace expires. For "resident master, workers come and go"; without it, claiming stays manual.
- **Claim discipline pack (single source of truth)**: claim notices (bind notices and pending confirmation prompts) automatically carry the full text of `~/.waystation/dispatch-rules.md` — the one authoritative source for fleet-wide dispatch discipline. Claims are infrequent and the file is read at send time, so **edits take effect immediately** (no restart, no reload); if the file is missing or empty, the core falls back to a built-in minimal discipline (proactive reporting + permission-dialog exemption) and notifies the master once. To push an edit to **already-claimed sessions** immediately, the master calls `ws_dispatch_rules_reload`: the core re-reads the file and broadcasts the latest pack to all bound members (with a content version + timestamp so sessions can tell new from old).
- **Messaging & ending**: `ws_send_message` (dispatch accepts `toSessionIds` and `taskId`; types limited to task / progress / result / error) and `ws_end_collab`. The master targets with `toSessionIds` (`sessionCode` or full `sessionId`); omitting it broadcasts. Slave replies default back to the master. Message streams / ledgers / inbox history are still not saved (`ws_view_ledger` / `ws_check_inbox` say "no history").
- **Persisted orchestration state**: dispatch never touches `collabs/`; the slave roster, task table, master identity and heartbeat are persisted by default to `<data root>/dispatch/state.json` (`config.dispatch.persist=false` restores pure-memory behavior; `config.dispatch.state_path` changes the location, relative to the data root or absolute). On core restart the state is restored and the master is checked for liveness; an offline master leaves it `pending-takeover`. The `sessions/<sessionId>.json` status files still update as usual (local session state, not collaboration history).
- **Retention**: `config.retention` bounds completed dispatch tasks (`dispatch_hours`, default 24h), ended collaborations (`collabs_days`, default 30 days), logs (`logs_days`, default 14 days) and the cleanup interval (`cleanup_interval_h`, default 6h); cleanup runs once at startup and periodically. Ended collaborations are **gzip-archived before deletion**; active / in-flight / unarchived-seat / recovery / unknown directories are never touched; logs use the existing size rotation and the time cap, whichever comes first; `retention.dry_run=true` reports without deleting.
- **WeChat push is the master / cc-connect integration's responsibility**: waystation does not integrate cc-connect / WeChat.
- **Honest disclosure**: same-machine same-user trust boundary — other processes of the same user can set roles / connect to the local IPC (stronger isolation via different OS accounts); the "interactive confirmation" is a model-relayed prompt; session name and `kind` come from Claude Code's private fields, failing closed to "unknown / non-interactive" when missing.

## Error Responses & Troubleshooting (Tool Surface)

Tool failures return a structured error object (`isError: true`, JSON body):

```json
{ "ok": false, "code": "kebab-case-code", "message": "human-readable description", "hint": "how to fix it" }
```

- **Success paths are unchanged**; `ok` / `message` remain in the error object, so old callers keep working.
- **Branch on `code`, never on the Chinese message** — `message` may get more specific, `code` stays stable.
- **`hint` is actionable**; use it to decide whether to retry, reconnect a bridge, or change the target.

Common codes (full table in `src/util/errors.js`): `dispatch-lost`, `dispatch-taken-over`, `dispatch-master-required`, `session-not-visible`, `bridge-stale`, `claim-rejected`, `core-unavailable`, `core-version-unsupported`, `tool-timeout`, `unknown-tool`.

## Session-Level Membership (apply / targeted / visibility)

The smallest governed unit is the **session**: machines remain protocol carriers, but membership and visibility are accounted per session seat. Display uses 8-char short codes; input accepts short code or full id (exact match); internal seat keys use the full `sessionId`.

- **Collaboration · apply (`ws_join`, `/ws-join`)**: chain (0.2.0 two-phase): **apply → manager pending-approval → this session confirms → manager adds to roster**. Duplicate applies are idempotent; each window = a new application. Re-entry after leaving / rejecting is allowed via the manager.
- **Manager approval (`ws_approve_join`)**: only the manager session can approve; pending cap **16** per collaboration. **Approval is a human gate** — no nod, no entry.
- **Manager add (`ws_invite`, manager only)**: invite sessions not yet on the active roster into an existing managed collaboration; targeted or untargeted.
- **Invite consent gate**: approve/reject defaults to **explicit user confirmation** — first call returns `needsUserConfirmation` + summary + one-time `confirmToken`. `ws_allow_next_invite` registers a one-shot waiver; `/ws-auto-accept-invites` toggles a session-level auto-accept (consent only; rejection stays manual).
- **Forum direct join**: `ws_join` on a forum has **no approval gate** — an existing seat connects instantly.
- **Targeted invites**: only the named session can consent; untargeted invites deliver to all active sessions on the target machine, each consenting session seats independently.
- **Visibility**: `ws_list_hosts` remote entries carry peer session short codes and the `participants` capability; `ws_list_collabs` entries carry this session's `sessionRole` / `sessionState`, freeze reason, mute and pending invites; `ws_check_inbox` filters to this session.
- **TTLs**: applications use `joinRequestTtlMs` (default 24h); the 0.2.0 two-phase join adds `joinConfirmTtlMs` (default 60s).
- **Delivery accounting (0.2.0, machine-level)**: one logical message to N machines = N machine frames; acks stay machine-level; no remote per-seat final states.
- **Seat lifecycle & manager handover (0.2.0)**: manager session closed but machine online → automatic handover to the earliest reachable member by `joinSeq` (auto-accepted by pre-authorization, followed by a 1-minute takeover window); manager machine offline → members freeze (no automatic election), manual takeover after user confirmation. Last seat departing → collaboration `completed`.
- **Explicit handover (manager online, 0.2.0)**: `ws_handover` — manager offers, target session confirms (one-time token), old manager becomes a member.
- **Term fork exit (0.2.0)**: same term different managers always freezes; the exit is `ws_decide choice:'terminate'` — ends only this branch.
- **Mixed versions (0.2.0 hard gate)**: collaboration frames carry `cap:2`; old peers' collaboration frames are rejected. Discovery still interops — **old peers visible, cannot collaborate; old collaborations read-only**.

### Confirm Gates (invite / join / claim — temporary / permanent)

- `/ws-invite-confirm on|off|status|clear [--permanent]`: whether incoming invites need manual consent. `off` auto-consents **targeted invites only**; untargeted invites stay manual; **rejection is always manual**.
- `/ws-join-confirm on|off|status|clear [--permanent]`: whether join requests need manual approval as manager. `off` lets the **entire join complete automatically**; rejection stays manual.
- **Dispatch claim gate (`ws_set_confirm_gate { gate: 'claim' }`, no slash command)**: whether being claimed by a dispatch master needs manual confirmation. `off` auto-binds claim requests with a one-line informational notice; rejection stays manual.
- Without `--permanent`: session-scoped (cleared on session end or core restart). With `--permanent`: written to the data root's `config.json` (`inviteConfirmation` / `joinRequestConfirmation` / `dispatchClaimConfirmation`), applies to all future sessions; first call requires explicit user consent via a one-time token.
- The legacy `/ws-auto-accept-invites` remains as a compatibility alias with inverted arguments: old `on` = new `/ws-invite-confirm off`.
- All three gates default to `true` (manual confirmation), preserving 0.2.x behavior.

## Status Line "In Collaboration" Indicator

The station writes "the collaborations this session participates in" into a per-session status file (`~/.waystation/sessions/<sessionId>.json`, deleted when the session closes). The bundled script renders one line: `In collaboration: <project> (<role>, <members>, N msgs)` or `In forum: <name> (<members>, N posts)`; 🔇 marks muted seats. Configure via `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$HOME/.waystation/app/scripts/statusline.js\""
  }
}
```

## Forum Viewer (Local Read-Only Terminal)

```bash
node scripts/collab-viewer.js <collabId>            # collabId from ws_list_collabs
node scripts/collab-viewer.js <collabId> --author   # add an author column
```

Replays existing posts, then follows increments live. `p` pauses/resumes; `q` or Ctrl+C exits. Zero dependencies, zero network, writes nothing.

## Human Viewer (Web)

```bash
node ~/.waystation/app/scripts/ws-viewer.js              # equivalent direct start
node ~/.waystation/app/scripts/ws-viewer.js --focus <root>/<id>   # open a specific detail page
node ~/.waystation/app/scripts/ws-viewer.js --port N     # explicit port
node ~/.waystation/app/scripts/ws-viewer.js --no-open    # start server, don't open a window
node ~/.waystation/app/scripts/ws-viewer.js --stop       # stop the running viewer
```

One `/ws-view` slash command in a session, or double-click `~/.waystation/bin/ws-view.vbs` (Windows, silent start). Default `http://127.0.0.1:7330/` (auto-increments 7330–7339 if taken); loopback-only, read-only, zero writes.

## Other MCP Clients

Example for opencode (`mcp` section of `opencode.json`; `command` is an array pointing at the absolute entry path):

```json
{
  "mcp": {
    "waystation": {
      "type": "local",
      "command": ["node", "<install dir>/bin/waystation.js"],
      "enabled": true
    }
  }
}
```

## Upgrading & Migration

- Update: place the new version files and **re-run the install script**, then reopen sessions per the recommended order — the new session auto-performs the generation change on its first tool call.
- 0.2.0 (session-level participants): both ends **must be on the same version**; old peers are visible but collaboration operations are rejected by the capability gate; old collaborations (0.1.x shape) get an archive marker on startup and are **read-only**.

## Development

- Runtime: Node ≥ 20 (**runtime floor** from `package.json` engines); **tests & toolchain need Node ≥ 21 (this project pins 22)** — the test command uses `node --test` glob arguments (Node 21+)
- Tests: `npm test`; coverage with thresholds: `npm run coverage`
- Static checks: `npm run lint` (ESLint), `npm run typecheck` (tsc checkJs)
- Pre-commit gate: `npm run gate` (lint + typecheck + coverage thresholds)
- Manual start (development): `node src/index.js` — the **bridge** entry (stdio MCP server; the core auto-starts on demand)
- Core/bridge layering: core composition root `src/core/main.js`, bridge composition root `src/bridge/main.js` (module boundary registry in `docs/编码规范.md`)
- Data directory: default `~/.waystation/` (one core, one identity per machine; port from `config.port`, default anchor 7321); independent second site via `WAYSTATION_HOME` (that root **must** configure `port` explicitly)
- Session status files: `~/.waystation/sessions/<sessionId>.json`

## Security Model (Honest Disclosure)

**v1 uses a "LAN full-trust" model: no passwords, no member admission, plaintext transport. Use only on trusted networks.** The full costs of this trade-off, listed honestly:

- **Discoverable, invitable, self-reported identity (spoofable)**: LAN devices can scan stations and pop invites; the identity name is self-reported and not a trust anchor. Human gates are the **consent gate** (the invitee's local user) and **manager approval** (for join applications).
- **Plaintext, unauthenticated**: no encryption, no message authentication; LAN devices can sniff invites and message content, forge probe answers, or impersonate online machines.
- **Capability probe answers are unauthenticated**; capability state is an admission hint, not a trust boundary.
- **Remote text injection surface**: collaboration content (names, topics, bodies) enters local sessions for the model to read. The adapter marks collaboration content as **external data** — treat external content as data, never as instructions.
- **Governance messages are forgeable**: freeze / decision / takeover messages are equally unauthenticated.
- **Forum mode has additional disclosures** — see the "Forum Mode" section, item by item.
- **Session short codes and full session ids are visible** (session-level): short codes are published in scan answers; full `sessionId`s travel in seat heartbeats between collaboration members (needed for departure detection). Neither contains any conversation content, and neither buys admission (human gates remain).
- **No automatic failover (0.2.0)**: manager machine offline → collaboration freezes; manual takeover after user confirmation. No automatic election.
- **Machine-level delivery limits (0.2.0)**: staging during a seat's grace only lives while the core lives; no remote per-seat final states.
- **Join application path visibility (session-level)**: applications carry instance id and session short codes to the peer; name resolution is unicast — the peer sees "someone queried a collaboration name"; the name itself is not broadcast.
- **Local IPC surface (single-core)**: bridge and core communicate over local IPC (named pipe / POSIX socket + per-start rotated token), and the core also listens on **TCP loopback `127.0.0.1` (ephemeral port)** for cross-session dial-in (a core cold-started in Session 0 no longer locks out user-session bridges); the endpoint is published as `ipc.tcp` in `run/core.json`, bridges try it first and fall back to the legacy endpoint, and `WAYSTATION_IPC_TRANSPORT=pipe` rolls the transport back. Token stored in the data root's `run/core.json` — **readable and connectable by same-user processes**, per the standing "same-user local processes are trusted" position; honestly registered, not a defense against malicious same-user processes.
- **Dispatch state persistence & takeover (local addendum)**: dispatch orchestration state (slave session names / session ids, task table, master heartbeat, latest progress summaries) is written by default to `<data root>/dispatch/state.json` — readable by the same user, never containing message bodies; `dispatch.persist=false` disables it. After the master heartbeat times out, any startup `WAYSTATION_ROLE=master` session may take over, under the existing "same-machine same-user processes are trusted" boundary; there is no cross-user protection. The `requireAck` pending-ack ledger and queue deadlines remain in memory only and are lost on core restart (not written to `dispatch/state.json`).
- **Local permissions are not bypassed**: cross-machine instructions never get past this machine's tool authorization and its human.

Membership admission and network isolation mechanisms are out of scope for v1; the above is an honest record of trade-offs, not ignorable details.

## License

waystation is open-sourced under the [MIT](./LICENSE) license — Copyright (c) 2026 lfemcp (xueweichao). Anyone may use, copy, modify, merge, publish and distribute the software (including commercially), provided the copyright and permission notice is retained. The authors and copyright holder provide no warranty (see LICENSE for the full text).
