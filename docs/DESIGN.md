# Workbench: design (v1)

Status: v1 design, 2026-10-11. Workbench runs terminal and AI-agent sessions on a server and presents them as cards on a browser canvas. A long-lived hub process owns the sessions. A restartable web process serves the UI and the API. This document is the binding design for v1: the wire contracts (§3), the component designs (§4-§7), the security model (§8), the test strategy (§9) and the build plan (§10). Where a detail is stated in §3, §3 wins.

References to "the prototype" mean the earlier Python daemon and its single-page frontend, which this design ports and replaces.

Edwin (edwind, its frame runtime and "the edwind spec") lives in its own repository, [github.com/yathxyz/edwin](https://github.com/yathxyz/edwin), which this one takes as the flake input `edwin` (since 2026-10-19). A path written `edwin/…` here is a path in that repository, whose root is the former `edwin/` directory.

**Identifier conventions.**

| Prefix | Meaning |
|---|---|
| `H-n`, `W-n` | Hub (§4) and web (§5) design points |
| `F-An` | Frontend amendments (§6.1) |
| `N-n` | Nix and deploy design points (§7) |
| `T-Sn` | Security regression cases (§9.3) |
| `Nn` | Frontend UI suite checks, run by `tests/ui.mts`. N1-N26 are the baseline checks of that suite; new checks are documented as described in §9.5. |
| `Mn-X` | Build-plan work packages of v1 (§10; the list is in git history) |

---

## 1. Goal and non-goals

**Goal.** Run one Workbench instance on a server that is good enough to use every day with many agent sessions and shells running at once.
- It answers "which session needs me now?" at a glance, including when the tab is not in front of the user.
- Sessions survive restarts of the web daemon without tmux.

**Quality bar:** performance and robustness.
- **Robustness:** no single bad input, slow viewer, full disk, panic or corrupt file takes down more than one session. The hub is never killed by the OOM killer while a child is available instead.
- **Performance:** the backend never sits between the user and their keystrokes:
  - the PTY reader never waits for viewers;
  - replay is bounded;
  - same-page reconnects are lossless and cheap (the byte ring).

  The biggest frontend performance lever is xterm.js level-of-detail rendering. It is out of v1 scope because the frontend is kept as is.

**In scope (v1):**
- hub-owned PTYs and ACP (Agent Client Protocol) agents (claude-agent-acp, codex-acp, omp acp) with elicitation;
- revive after a reboot;
- the existing SPA with its fix list (§6);
- a public origin behind an authenticating reverse proxy;
- the `wb` CLI over a peer-credential socket;
- notes, review, `sample` and srcdoc artifacts, ported from the prototype;
- nix packaging, a NixOS module and a VM test.

**Non-goals (v1):**
- multi-host and federation (the protocol stays host-aware). **Reversed in stages from 2026-11-17 (§3.8):** there is still one hub, on one host, and it now serves a mesh of hosts: every host reports its agent sessions to it, clients on the mesh steer it over an HTTP API, and it starts agents on the other hosts;
- tmux adoption;
- `/mcp`;
- hub hot-upgrade through the systemd fd store;
- mutating `systemctl` and `sudo`;
- the second artifact origin;
- the full node model (markdown-it, FTS5, event log);
- JSON Canvas boards;
- Web Push to a phone in a pocket;
- per-session cgroups;
- frontend trimming beyond hiding one dead button.

---

## 2. Architecture

```
 Browser: desktop tab or phone PWA (Chromium)
   │  https/wss, session cookie issued by the authenticating proxy (SameSite=Lax)
   ▼
 Reverse proxy host ─ Caddy :443 "wb.example.org" ──forward_auth──► OIDC auth proxy ──► OIDC provider
   │       reverse_proxy 198.51.100.2:8090 {
   │         header_up X-Workbench-Proxy-Secret {env.CADDY_UPSTREAM_SECRET_WORKBENCH}                   # sets, overwrites client value
   │         stream_close_delay 5m }                                                   # WebSockets survive Caddy reloads
   │  private link 198.51.100.0/24: 198.51.100.1 ──► 198.51.100.2
   ▼
 Workbench host ─ firewall (iptables nixos-fw): -s 198.51.100.1 -d 198.51.100.2 -p tcp --dport 8090 -j nixos-fw-accept
 ┌──────────────────────────── workbench.slice  MemoryMax=20G CPUWeight=100 TasksMax=8192 ─────────────────────────────┐
 │ workbench-web.service  (User=alice, restarts freely)        workbench-hub.service (User=alice, restartIfChanged=false)│
 │  wb-web: auth floor → static SPA (in memory)                wb-hub: PTY masters + vt100 + byte ring,                 │
 │          /api (board, fs, notes, sample, artifacts)          agent stdio + ACP client, journals,                     │
 │          /pty /acp /rpc relays ── one hub conn per socket ─►  pending requests (first answer wins)                  │
 │          derive(state), attention feed, leader election      hub.sock 0600 + SO_PEERCRED                             │
 │          web.sock 0600 + SO_PEERCRED ◄── wb CLI              children (oom_score_adj 800, NoNewPrivileges):          │
 │          LoadCredential: proxy-secret, media-NAME            shell -i, claude-agent-acp, codex-acp, omp acp          │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 Disk (uid alice): ~/.local/state/workbench/hub/{pty,acp}/…   ~/.local/state/workbench/web/{artifacts,…}
                   ~/work/boards/<host>.json, ~/work/notes
```

**Responsibilities.**
- **The hub holds only what must outlive the web**, and it holds facts, never policy:
  - PTY masters, VT state, snapshots and the byte ring;
  - agent stdio, the ACP client, journals and pending requests;
  - session facts.
- **Everything that changes often lives in the web**, which deploys without ending sessions:
  - auth;
  - HTTP;
  - the board, notes, `sample` and artifacts;
  - the derived display state;
  - the attention feed;
  - leader election.
- **Version skew runs one way.** After a deploy the web is newer than the hub, so every hub protocol change is additive. `hub.stale` tells the user when a hub restart, which ends every session, would pick up hub changes.

**Data flow, one ACP turn.**
1. The browser's `/acp` socket sends `prompt`.
2. wb-web relays `acp.prompt` over that socket's own hub connection.
3. The hub journals `prompt`, then writes `session/prompt` to the agent's stdin.
4. Each `session/update` is appended to the journal, folded into the facts, fanned out as `acp.ev` to every attached connection, and published as `session` to watchers.
5. wb-web derives `state` and pushes `session{…state}` on every `/rpc` socket. That is the attention feed.
6. A `session/request_permission` is journaled and held, and appears in every tab and on the status chip. When the tab is hidden, the service worker shows a notification. The first answer from any tab wins.

---

## 3. Contracts

This section is binding for every work package.

**Conventions.**
- JSON field names are camelCase.
- Message discriminators use the key `t`; enum values are snake_case strings.
- Times are integer milliseconds since the Unix epoch.
- MUST and SHOULD carry their RFC 2119 meaning.

### 3.1 Workspace, crates, toolchain

**Repo layout:**

```
Cargo.toml        [workspace] resolver="3", members=["crates/*"]; [workspace.package] version, edition="2024", rust-version="1.98"
Cargo.lock        committed; nix uses cargoLock.lockFile
crates/wb-proto/  lib: wire types, NDJSON helpers, limits, derive()        deps: serde, serde_json only
crates/wb-hub/    bin wb-hub; [[bin]] wb-fake-acp (src/bin/wb-fake-acp.rs, test-only, never installed to $out/bin)
crates/wb-web/    bin wb-web
crates/wb-cli/    bin wb (std + wb-proto only)
web/              index.html app.ts keys.ts bridge.ts sw.ts style.css manifest.webmanifest icon.svg, globals.d.ts board.d.ts page.d.ts tsconfig.json tsconfig.sw.json   (the web root serves app.js, keys.js, bridge.js and sw.js, stripped from the .ts by tools/strip.mts; vendor/, the font files and fonts/fonts.css are generated by nix, never committed)
tools/            package.json package-lock.json vendor-entry.js strip.mts
tests/            harness.py wbctl.py test_daemon.py test_security.py ui.mts perf.mts keys.test.mts address.test.mts tsconfig.json adapter_probe.py address-seeds.json caddy/{live,expired,loginpage}.Caddyfile
nix/              package.nix vendor.nix web.nix module.nix checks.nix vm.nix adapter-check.nix
flake.nix flake.lock   (inputs: nixpkgs, edwin = github:yathxyz/edwin)
```

**wb-proto modules.** Every binary imports these exact names.

| Module | Contents |
|---|---|
| `line` | `encode<T: Serialize>(&T) -> Vec<u8>` (compact JSON + `\n`), `MAX_LINE`, blocking `read_line_capped` for the CLI |
| `hub` | `HubRequest`, `HubMessage`, `SpawnPty`, `SpawnAcp`, `ConfigValue`, `ConfigOption`, `ConfigError`, `AcpOpenReply`, `Resume`, `Summary`, `PtyFacts`, `AcpFacts`, `Fault`, `Exit`, `Pending`, `Last`, `AcpSessionInfo`, `PROTO` |
| `journal` | `JournalEvent { seq, ts, body: EventBody }`, with `EventBody` tagged by `e` |
| `state` | `enum State`, `pub fn derive(&Summary) -> State`, and the table tests that define it |
| `websock` | `WbRequest`, `WbMessage` |
| `limits` | every constant in §3.2.9 |

**Serde rules (all wire types).**
- `#[serde(tag = "t")]`, an explicit `rename` per variant, and `rename_all_fields = "camelCase"`.
- Every tagged receiving enum ends with `#[serde(other)] Unknown`. `ConfigValue` is an untagged string-or-boolean enum.
- **Never** `deny_unknown_fields` on wire types. Config structs may use it.
- ACP payloads are carried as `serde_json::Value` and never re-shaped.

**Dependencies.** Versions verified on crates.io on 2026-10-11, none yanked. Use caret requirements at the minor shown; `Cargo.lock` pins exact versions.

| Crate | Version | Used by | Features / notes |
|---|---|---|---|
| tokio | 1.53.2 | hub, web | `rt-multi-thread, macros, net, io-util, process, signal, time, fs, sync` |
| tokio-util | 0.7.20 | web | `codec`: `LinesCodec::new_with_max_length(MAX_LINE)` for the web's hub connections and web.sock. The hub does not use it: it reads hub.sock and agent stdout with its own tolerant, hand-rolled `read_line_capped`, because a `FramedRead` stream ends after one decoder error. |
| serde / serde_json | 1.0.229 / 1.0.152 | all | `derive` |
| rustix | 1.1.5 | hub, web | hub: `pty, termios, process, fs` (`openpt`, `ioctl_tiocgptpeer`, `ioctl_tiocsctty`, `tcsetwinsize`, `tcgetpgrp`, `kill_process_group`). web: `fs, param, process` (`renameat_with` + `RenameFlags::NOREPLACE`, `statvfs`, `geteuid`) |
| vt100 | 0.16.2 | hub | VT state, snapshots, capture |
| axum | 0.8.9 | web | `ws, http1, json, query, tokio`, default features off. Path syntax `/{id}`. |
| subtle | 2.6.1 | web | `ConstantTimeEq` |
| reqwest | 0.13.5 | web | `default-features=false, features=["rustls","json","stream"]`. aws-lc-sys 0.45.0 uses its cc builder, so no cmake is needed. |
| futures-util | 0.3.34 | web | |
| regex | 1.13.1 | web | notes parsers |
| uuid | 1.28.0 | web | `v5` only, for bit-exact node ids |
| sha2 | 0.11.0 | web | static ETags, artifact versions |
| tracing / tracing-subscriber | 0.1.44 / 0.3.23 | hub, web | `fmt` to stderr (journald) |
| anyhow | 1.0.104 | bins | binary edges only |
| libc | 0.2.190 | hub | restore `SIGCHLD` to `SIG_DFL` before starting Tokio |
| agent-client-protocol-schema | =1.11.0 | hub dev-dep | `default-features=false`, round-trip conformance |
| tokio-tungstenite, tempfile | 0.29, latest | web dev-deps | test clients |

**Not used:**
- `tower-http`: its mtime-based ETags break on nix store mtime 1;
- `rusqlite`/sqlite: the notes index is in memory;
- `clap`, `cmake`, `hyper`/`tungstenite` directly;
- the `agent-client-protocol` SDK 3.3.0, `portable-pty`, `alacritty_terminal`, `avt`;
- `sd-notify`, `chrono`, `rand`, `nix`, `bytes`.

**Toolchain.**
- Nixpkgs `e7439b6b14ad`, with rustc/cargo 1.98.1. The highest MSRV in the tree is 1.89 (uuid).
- Release profile: `panic="unwind"`, `lto="thin"`.
- Unsafe code is confined to `pty/spawn.rs`: startup signal setup and the `pre_exec` closures, which make only async-signal-safe raw syscalls.

### 3.2 Hub protocol (`hub.sock`; the same framing is used by `web.sock`)

#### 3.2.1 Transport and authentication
- **Socket:** AF_UNIX stream at config `socket`, default `/run/workbench-hub/hub.sock`. Its directory is `RuntimeDirectory=workbench-hub`, mode 0700.
- **Binding:** the hub binds under umask 0077, then `chmod 0600`. It refuses to start if the path is 108 bytes or longer.
- **Single instance:** `flock(LOCK_EX|LOCK_NB)` on `<stateDir>/hub.lock` before binding. If the lock is held, exit 1. With the lock held, a stale socket path is unlinked.
- **Peer check:** on every accept, `peer_cred()`. If `uid ∉ {geteuid(), 0}`, the connection is closed **without writing a byte**.

#### 3.2.2 Framing
- NDJSON: one compact UTF-8 JSON object per line.
- `MAX_LINE` = 16 MiB. The hub closes any connection that sends a longer line.
- Text only. PTY bytes are decoded into strings by the hub (§3.4.3).

#### 3.2.3 Handshake and versioning
1. The hub sends first:
   `{"t":"hello","proto":1,"server":"wb-hub","version":"0.1.0","build":"<WB_HUB_BUILD>","host":"devbox","pid":1234,"startedAt":…,"acpConfig":true,"acpTask":true,"agents":[{"name":"claude","label":"Claude"},…],"shells":["bash","nu"],"defaultShell":"bash"}`
   - `build` comes from `option_env!("WB_HUB_BUILD")`. It is absent in local cargo builds.
   - `shells` lists the names of the configured shells that have an existing, executable path when the connection opens (the hub re-checks at each spawn). `defaultShell` is the configured default (§3.7.2).
   - `acpConfig:true` advertises ordered startup configuration and live configuration requests. Missing or false means unsupported; clients must not infer support from the version or build. Older hubs ignore an unknown `SpawnAcp.config`, so the web refuses a non-empty batch unless the connected hub advertises support.
   - `acpWorktree:true` advertises local ACP worktree management and is sent only when `git` is configured (§3.7.2); absent or false means unsupported.
   - `acpTask:true` advertises support for both `SpawnAcp.task` and `acp.set_task`; absent or false means unsupported.
   - `sessionActionEpoch:true` advertises the action preconditions in §3.2.7; do not send them to a hub that omits it or reports false, since older hubs ignore unknown fields.
2. The client answers within `HELLO_TIMEOUT` with `{"t":"hello","proto":1,"client":"wb-web/0.1.0"}`, or it is closed.
3. A `proto` mismatch gives `err{code:"proto"}`, then close.
4. **Additive rule:** `proto` stays 1 while changes are additive. Receivers ignore unknown fields and unknown events. An unknown request gets `err{code:"unknown_type"}` and the connection stays open.
5. **Staleness, computed by the web:** if both sides have a `build`, `stale = hub.build != web.build`. Otherwise `stale = hub.version != web.version`.

#### 3.2.4 Envelope and error codes
- A request carries `rid` (u64, nonzero, unique per connection) and gets exactly one reply: `{"t":"ok","rid":N,…}` or `{"t":"err","rid":N,"code":…,"message":…}`.
- A `list` or `watch` request with `stream:true` may also receive `sessions.page{rid,sessions}` before its one terminal reply.
- `pty.input` and `pty.resize` have no `rid` and get no reply.
- Events never carry `rid`. An asynchronous error is `{"t":"err","sid":…,"code":…,"message":…}`.

The error codes are a closed set:

| code | meaning |
|---|---|
| `bad_request` | malformed request or a limit exceeded |
| `not_found` | sid unknown, or a `*.open` without spawn fields for an unknown sid |
| `kind_mismatch` | sid exists with the other kind |
| `not_alive` | needs a live process |
| `busy` | an ACP turn or the session's initial configuration batch is outstanding |
| `conflict` | the requested worktree path or branch is in use, or the worktree cannot be removed safely |
| `already_resolved` | permission or elicitation already answered |
| `bad_option` | `optionId`, `modeId`, `methodId` or `configId` not offered, or a config value not offered for that option |
| `not_revivable` | revive impossible |
| `spawn_failed` | spawn or exec failed |
| `agent_error` | the agent returned a JSON-RPC error |
| `timeout` | the agent did not answer `set_mode` or `set_config_option` within 30 s. (`authenticate` has no separate timer: it runs under the setup idle timeout, §3.2.9.) |
| `unknown_agent` | agent name not in the table |
| `input_overflow` | PTY input queue full |
| `stale` | **new**: `epoch` does not match the session's current incarnation |
| `faulted` | **new**: the session has a `fault` (§3.4.4) and refuses this action |
| `proto` | protocol version mismatch |
| `unknown_type` | unknown request type |
| `internal` | hub-side failure, including "session reloaded" after a panic |

#### 3.2.5 Connection model and ordering
- Attachments are scoped to the connection. `*.open` attaches; `*.detach` or close detaches.
- The web uses one hub connection per browser `/pty` or `/acp` socket, plus one control connection for `watch`, `list` and `pty.capture`.
- **Ordering** per connection and sid: the `ok` of `*.open` comes before any event for that sid. Replay and live subscription are atomic: no gap, no duplicate.
- At most 8 requests in flight per connection. Further lines are read when one completes.

#### 3.2.6 Shared types

```jsonc
// Summary: the hub's facts about one session (list / watch / *.open replies). The hub never sends `state`; the web adds it.
{
  "sid": "n_k3m9x2",                 // ^[A-Za-z0-9_-]{1,64}$ (the board node id)
  "kind": "pty",                     // "pty" | "acp"
  "host": "devbox",
  "createdAt": 1791460000000,        // ALSO the incarnation id: every field named `epoch` carries this value
  "updatedAt": 1791460123000,        // last Summary change (not last output byte)
  "alive": true,
  "viewers": 2,
  "cwd": "/home/alice/proj/x",
  "fault": null,                     // null | {"code": "load_failed"|"journal_write", "message": "…"} (§3.4.4)
  "pty": {                           // iff kind == "pty"
    "argv": ["/run/current-system/sw/bin/bash"],   // argv[0] is the resolved path of the shell that ran
    "pid": 4242,                     // absent when !alive
    "fg": {"comm": "nvim", "pgid": 4301, "leader": false},   // absent when !alive
    "exit": {"code": 0, "signal": null, "reason": "exited", "at": 1791460123000}  // absent while alive
  },
  "acp": {                           // iff kind == "acp"
    "agent": "claude",
    "agentSessionId": "c0ffee…",     // null until session/new|resume|load succeeded
    "revivable": true,               // see §3.4.6
    "activity": "turn",              // "none" | "setup" | "turn"
    "pending": [{"req": 812, "kind": "permission", "title": "Run `rm -rf build`", "ts": 1791460120000}],
    "last": {"seq": 790, "ts": 1791460100000, "outcome": "end_turn", "error": null},
    "headSeq": 815, "seenSeq": 790,
    "title": "Fix flaky test",
    "modeId": "default",
    "task": "issue 44",               // optional; absent when there is no task
    "configOptions": null             // null until offered; otherwise the agent's full config option list
  }
}
```

- **`Exit.reason`:** `"exited"`, `"killed"`, `"hub_restart"` or `"spawn_failed"`. `code` and `signal` are null when unknown.
- **`Pending`:**
  - `kind` is `"permission"` or `"elicitation"`;
  - `req` is the seq of the immutable journal event that announced the question, not the agent's JSON-RPC id;
  - within the same incarnation and journal history, `(sid, epoch, req)` identifies exactly one question: answering or cancelling consumes it, and another question gets a fresh seq even if the agent reuses its id;
  - `title` is the permission's `toolCall.title` or the elicitation's `message`, cut to 200 characters for both kinds. It is `""` when the request has none.
- **`AcpSessionInfo`:** `{protocolVersion, agentInfo, agentCapabilities, promptCapabilities, authMethods, modes, configOptions, availableCommands, plan, usage}`. It holds the latest materialised values; absent optional values are omitted. `Summary.acp.configOptions` is always present, with `null` when absent.
- Snapshots and watch events publish live and restored summaries unchanged, including the full option list, whenever they fit in a single-summary page with the longest request ID.
  Only on overflow does the hub shorten the wire summary; it leaves the journal and session records unchanged.
- **`Summary.acp.managedWorktree`** is present only for a recorded worktree: `{path, branch, mainRoot}`, with both paths absolute.
  This record is independent of the web's best-effort top-level git metadata (`repo`, `worktree`, `branch`).
- **`Summary.acp.policy`:** the session's non-empty `Policy` (§3.4.5), omitted when none. It is a hub fact, not an agent config option. Optional rule `programs` is an ordinary policy field, preserved along with roots and command regexes through validation, installation, journaling and replay.
- **Incarnation:** a sid can be forgotten and recreated, and `createdAt` distinguishes the incarnations.
  - It is persisted in `<kind>/<sid>.json` and survives hub restarts, revive and PTY respawn.
  - A new value is assigned only when a session is created.
  - Across both kinds the allocator takes the larger of the wall clock in milliseconds and one past its durable high-water mark.
    It commits the mark before exposing an epoch, so a failed creation may leave a gap, but forget, restart and clock rollback cannot reuse an issued value.
    After the clock steps backwards, the mark runs ahead of wall time; `createdAt` and `updatedAt` can look future-dated until the clock catches up.

#### 3.2.7 Requests (client to hub)

Every row except `pty.input` and `pty.resize` carries a `rid`.

| t | Fields | ok reply | Semantics |
|---|---|---|---|
| `list` | `stream?: bool` | `{sessions: Summary[]}` | snapshot of every known session, in sid order; see below |
| `watch` | `stream?: bool` | `{sessions: Summary[]}` | snapshot and subscription; then `session` on every Summary change and `gone` on forget |
| `session.kill` | `sid, epoch, forget` | `{}` | End the matching incarnation, whether PTY or ACP; the hub selects its kind and checks `createdAt` in the same registry lookup. `forget` has the same semantics as the corresponding kind-specific kill below. |
| `pty.open` | `sid, cols, rows, spawn?: SpawnPty, resume?: {stream, out}` | `{new, pid?, cwd, exit?, epoch, stream, out, resumed, replay?}` | rules below |
| `pty.detach` | `sid` | `{}` | |
| `pty.input` | `sid, d` | – | `d` ≤ 1 MiB. Written completely and in order. If queued input would exceed 8 MiB, the whole message is dropped and the connection gets `err{sid, code:"input_overflow"}`. Input to a dead session is dropped silently. |
| `pty.resize` | `sid, cols, rows` | – | `TIOCSWINSZ` plus the VT resize (§3.4.3). Clamped to cols 2..=1000 and rows 1..=500. Last writer wins. |
| `pty.kill` | `sid, forget, epoch?` | `{}` | SIGHUP to the captured members of the PTY's session, SIGKILL survivors from that set after 3 s, close the master. **`forget:false`:** ok when the kill starts. **`forget:true`:** ok only after the exit, the file deletion and the registry removal. Every attached connection, and every watcher, gets `gone`. |
| `pty.capture` | `sid, lines?` (default 200, max 1000) | `{text}` | plain text from the VT state, each row right-trimmed and blank rows after the last text left out; works on dead sessions |
| `acp.open` | `sid, since, epoch?, spawn?: SpawnAcp` | `{new, summary, session, head, from, reset, configErrors?: ConfigError[]}` | then the replay as `acp.ev`, then `acp.replayed`, then live events. With a non-empty spawn config, the initiating reply waits for the hub-owned batch or its termination. Rules below. |
| `acp.detach` | `sid` | `{}` | |
| `acp.prompt` | `sid, prompt: ContentBlock[], epoch?` | `{}` once written | needs `alive` (`not_alive`), `activity=="none"` (`busy`) and no fault (`faulted`). Blocks non-empty, ≤ `PROMPT_MAX`. `image`, `audio` and `resource` need the matching `promptCapabilities`. Journals `prompt`, sets `seenSeq=headSeq`. |
| `acp.cancel` | `sid, epoch?` | `{}` | sends the `session/cancel` notification when a turn is running, answers every pending request with cancelled (`by:"cancel"`), sets `seenSeq=headSeq`. Later permissions in that same turn bypass policy and ask through the ordinary manual path. With no turn and nothing pending it only sets `seenSeq`. |
| `acp.permission` | `sid, req, epoch, outcome` | `{}` | `epoch` mismatch → `stale`. First answer wins; later answers get `already_resolved`. An unknown `optionId` gets `bad_option`. |
| `acp.elicitation` | `sid, req, epoch, response` | `{}` | `epoch` mismatch → `stale`. First answer wins. `content` must be an object of string, number, boolean or string[]. |
| `acp.set_mode` | `sid, modeId, epoch?` | `{}` after the agent answers (30 s) | `modeId` must be in `availableModes`. Journals `mode{modeId}`. |
| `acp.set_config_option` | `sid, epoch, checkEpochFirst?: bool, configId, value: string\|boolean` | `{}` after the agent answers and the result is journaled (30 s) | `configId` must be offered in `configOptions`. A select value must be offered (including within grouped options); a boolean option requires a JSON boolean. Sends `session/set_config_option`; journals `config{configOptions}` from the agent's result. The result is authoritative, not a local patch of the requested value. |
| `acp.set_task` | `sid, task: string\|null` | `{}` after journaling | Replace the reference, or clear it with null or an empty trimmed string. This changes hub metadata, not the agent's configuration. |
| `acp.set_policy` | `sid, epoch, policy: Policy` | `{}` after journaling | replace the whole permission policy; `{rules:[]}` removes it. Existing pending requests are unchanged. |
| `acp.seen` | `sid, seq` | `{}` | `seenSeq = max(seenSeq, min(seq, headSeq))`, persisted |
| `acp.revive` | `sid` | `{}` once started | only when `!alive && revivable && fault == null`, else `not_revivable`/`faulted`; if the saved local `cwd` is no longer a directory, `not_revivable` before spawn. §3.4.5. |
| `acp.authenticate` | `sid, methodId` | `{}` after the agent answers | only during a failed setup, agent-handled methods only (`type:"terminal"` → `bad_option`) |
| `acp.kill` | `sid, forget, epoch?` | `{}` | teardown stages in §3.4.5. **`forget:false`:** ok when the kill starts; the session stays revivable. **`forget:true`:** ok only after exit, deletion of `acp/<sid>.*` and registry removal. `gone` goes to attached connections and watchers. |
| `acp.remove_worktree` | `sid` | `{}` | Verify `workbench-session` in the recorded checkout's private git directory, remove without force, then persist and publish the cleared record; an absent record is `not_found`, a running agent or dirty worktree is `conflict`. A missing checkout, missing marker or different sid clears the record without deletion and returns `not_found`: “session worktree already gone; record cleared; nothing deleted”. |

**`list` and `watch` snapshots.**
- With `stream:true`, concatenate the `sessions` arrays from any `sessions.page{rid,sessions}` lines and the final `ok{rid,sessions}`.
  Each line fits `MAX_LINE` (newline excluded), independent of session count; each summary is whole.
  The last summary uses the final `ok` line's budget.
  If a summary cannot fit its envelope even on a line of its own, the hub sends `err{rid,sid,code:"internal"}` and closes the connection if it was a `watch` request.
- A `watch` captures the snapshot and subscribes atomically.
  All live `session` and `gone` events from that subscription follow the snapshot, including changes made while it is being sent.
  If a live or legacy catch-up `session` event cannot fit `MAX_LINE`, the hub closes the watch connection.
  A `list` on a watching connection is ordered with any live events at the moment its snapshot is captured.
- Without `stream:true`, the hub sends the original single `ok` reply when it fits.
  If it does not fit, `list` returns `bad_request` directing the caller to `stream:true`; `watch` sends a bounded `ok` with a prefix of the snapshot, then ordinary `session` events for the rest, before any live changes.
  This lets older web fronts retain all summaries and options using their existing upsert path.
- Older hubs ignore `stream:true` and respond with their original single-line snapshot.
  The web accepts that reply without requiring a page, but the old hub's snapshot is still subject to `MAX_LINE`.

**Caller-supplied action precondition.**
On prompt, cancel, set_mode and the kind-specific kills, an optional `epoch` binds the action to that session's `createdAt`; the kind-independent `session.kill` always requires it.
On set_config_option the wire epoch has always been required; `checkEpochFirst:true` selects the same precondition semantics instead of the legacy check order below.
For these guarded actions, an unknown sid gives `not_found`; an existing sid with a different epoch gives `stale` before kind or actor-state checks, with no action on the replacement.
This holds even if a command was queued as the old session was being forgotten.

**Check order.** While a non-empty initial configuration batch is active (including its preceding setup), `acp.prompt`, `acp.cancel`, `acp.set_mode`, `acp.set_config_option`, `acp.revive` and `acp.authenticate` fail with `busy` before their normal actor checks. They are rejected, never queued for a future turn. Permission and elicitation answers, `acp.seen` and `acp.kill` remain usable. Otherwise, when a request fails several checks, the first in this list applies:
- `acp.prompt`: `faulted`, `not_alive`, `bad_request` (no ACP session yet), `busy`, then the content rules.
- `acp.set_config_option`: `faulted`, `not_alive`, `bad_request` (no ACP session yet), `stale` (epoch differs from `createdAt`), then `bad_option` (unknown id, unsupported option type or wrong/unoffered value). Registry errors `not_found` and `kind_mismatch` apply before these actor checks.
- `acp.set_policy`: registry `not_found`/`kind_mismatch`, then `stale`, `faulted`, `bad_request` (invalid policy). It is usable during setup, an initial config batch, a turn, or while dead.
- `acp.permission`, `acp.elicitation`: `stale`; an unknown `req` is `bad_request` (`already_resolved` when that request was announced and has been answered); then `bad_option` or the shape rules.
- `acp.authenticate`: `bad_option` (a method that is not offered, or one with a `type`), `faulted`, then `bad_request` unless the agent is alive and waiting after a failed setup.
- `acp.revive`: `faulted`, then `not_revivable`.

**`SpawnPty`** = `{argv: string[1..=256] (≤256 KiB in total), shell?: string, cwd?: absolute path, cwdFrom?: sid, env?: {KEY: value}}`.
- **Program.** The hub never runs a path from a client. The program is always one of its configured shells, chosen by name:
  - `shell` is a name from `hello.shells`. When absent, a respawn uses the shell the session last ran on, and any other spawn uses `defaultShell`. An explicit `shell` wins over the session's last shell on a respawn and is persisted.
  - An unknown or unavailable name gives `err{code:"bad_request", message:"shell <name> not available"}`. A fresh sid is abandoned, leaving no registry entry and no files. A corpse is left unchanged.
  - The hub runs the first existing executable among the shell's configured paths, re-checked at every spawn.
- **argv.** The hub replaces `argv[0]` with that resolved path. `argv[0]` is never executed or looked up, and clients send the shell name there. `argv[1..]` pass unchanged (`["-c", cmd]`). A single-item `argv` is an interactive start: the hub appends the shell's configured `args` (§3.7.2). So `cmd` cannot name an arbitrary binary through this request.
- Cwd precedence: the cwd of a live `cwdFrom`, then `cwd`, then `$HOME`. A missing or non-directory cwd falls back to `$HOME`.
- `env`: at most 32 entries. Keys match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, values are ≤ 4096 bytes, and keys the hub sets cannot be overridden.

**`SpawnAcp`** = `{agent, cwd: absolute existing directory, config?: ConfigOption[], task?: string, policy?: Policy, worktree?: {branch: string, base?: string}}` (remote `host` rules in §3.8.5).
- **`ConfigValue`** is a JSON string or boolean, never a number, null, array or object. **`ConfigOption`** = `{id: string, value: ConfigValue}`. The optional `config` array is ordered: at most 16 entries, with distinct ids. The hub rejects an invalid batch with `bad_request` before spawning. Absent or empty `config` preserves the old asynchronous open behaviour; serializers omit the empty array.
- **`ConfigError`** = `{id: string, value: ConfigValue, code: ErrorCode, error: string}`. `AcpOpenReply.configErrors` reports failed entries in input order, retaining their requested values and a required hub error code. It is omitted when empty and defaults to an empty array when absent. These errors belong only to the initiating open reply, not to the session facts or later attaches.
- **Managed worktree (F-A52).** A request with `worktree` requires a local agent and an absolute `cwd` inside a non-bare git checkout, including a subdirectory of a linked worktree, but not a submodule.
  The same rule applies to `branch` and `base`: 1–255 ASCII bytes in `[A-Za-z0-9._/-]`, not `HEAD`, no initial `-`, no `..`, and no empty slash-separated component or component starting with `.` or ending with `.lock`.
  Invalid names are `bad_request` before git runs.
  For git's resolved main worktree root `R` and branch `B` with each `/` replaced by `-`, the default destination is `R-wt/B`.
  If `worktreeRoot` is set, the hub starts at that directory, appends the normal path components of `R` after its leading `/`, then appends `B`; main checkouts with the same basename but different full paths therefore do not collide.
  Before creating any directories, the hub rejects a destination inside the repository's common git directory with 400 `bad_request`, resolving symlinks and accounting for separate git directories.
  From a linked checkout with a separate main git directory, git must identify the main checkout (for example via `core.worktree`); if it reports only its metadata directory, the hub refuses rather than guessing a destination.
  The hub creates missing parent directories and leaves them in place, even after rollback or removal; it atomically reserves the final directory and never adopts an existing destination, even if empty.
  A local branch is checked out unchanged; otherwise the hub creates it from the commit id resolved from `base`, defaulting to the `HEAD` of the checkout containing `cwd`, without configuring an upstream or fetching.
  An occupied destination, a destination still registered with git, or a branch listed as checked out elsewhere by `git worktree list --porcelain -z` is `conflict`.
  Any other failure of `git worktree add`, including a checkout race after the list or a failed required filter, is `internal` with git's bounded first error line, control characters removed.
  The agent's actual `cwd` is the new root, and its managed-worktree record survives restart and revive.
  A change to `worktreeRoot`, including unsetting it, affects new creations only: removal uses the path in the record and verifies the ownership marker, never recomputing the path from today's configuration.
  If creation is refused after checkout, the hub attempts a non-forced removal before abandoning the session, keeps the branch, and reports the path if rollback leaves the worktree.
  An accepted dead session following an exec or setup failure (§3.2.7) is not an abandoned creation and keeps its record.
  Git runs outside the actor, without blocking other sessions on the connection or delaying shutdown.
  During unpublished worktree creation, including rollback, all `acp.open` requests (with or without `spawn`) and all ACP actions except the first `acp.kill` get `conflict` immediately; `acp.detach` is handled normally.
  The first `acp.kill`, whether `forget` is true or false, requests cancellation and waits for cleanup; if creation fails independently, the opener receives its original error and the kill succeeds unless a leftover is reported.
  During explicit removal, only `acp.open` with `spawn.worktree`, `acp.remove_worktree`, `acp.revive` and `acp.kill` (either `forget` value) get `conflict` because of the removal; everything else, including attach, detach, `acp.prompt` and `acp.seen`, follows the normal session rules.
  Once a session is accepted, killing or forgetting it never removes the checkout.
  Only a timed-out or cancelled `worktree add` permits forced cleanup: the hub verifies the reserved directory's device and inode before it unlocks and force-removes the incomplete checkout; no agent has run in it.
  If the hub itself stops before creation completes, an incomplete, locked worktree can remain without a session record; inspect the path and recover it manually as described in F-A52.
  A panic in the git creation task can likewise skip rollback and leave a marked checkout without a record; use the same manual recovery in F-A52.
- **`task`** is a free-text reference (F-A51): reject Unicode control characters, line and paragraph separators (U+2028 and U+2029), and bidirectional controls (U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069) anywhere in the input.
  Trim surrounding whitespace, then reject more than `TASK_MAX` UTF-8 bytes; an empty result means no task.
  Invalid input returns `bad_request`, never a truncated value.
  A spawn task applies only to a new session; failure to journal it leaves no session or files and the sid can be reused.
- The hub validates the entire optional policy before registering or starting a session. Existing-sid opens validate but ignore spawn policy, as they ignore spawn config; an attach cannot replace either.
  With a managed worktree, the hub compiles the policy against the new session `cwd`, not the original checkout.
  A refusal while journaling initial events rolls the worktree back before releasing the sid; a policy-only write fault leaves an accepted, faulted session with its worktree record.

**`pty.open` rules.** Principle: **a request without `spawn` never starts a process**.
- **Alive:** attach, whether or not `spawn` is present. An alive session is never respawned.
  - With `resume` matching the current `stream`, and the ring still holding `out`: reply `resumed:true`, with `replay` = the ring bytes after `out`.
  - Otherwise: `resumed:false`, with `replay` = the vt100 snapshot.
  - The requested size is applied only when this connection is the session's **only** viewer (§3.4.3).
- **Unknown sid:** with `spawn`, spawn and reply `new:true`. Without `spawn`: `not_found`.
- **Dead:** with `spawn`, spawn again (a respawn: same sid, same `createdAt`, the ring continues, the output decoder is reset) and reply `new:true`.
  - Without `spawn`: attach to the corpse. Reply `new:false`, with `replay` = the last snapshot (possibly `""`) and `exit`.
  - The corpse parser is resized to the request first. Nothing runs.
- **Exec failure** (fresh sid or respawn): the session stays as a corpse with `exit{reason:"spawn_failed"}`. The corpse is persisted and published before the reply `err{code:"spawn_failed"}`, and the next `pty.open` with `spawn` tries again.
- A `pty.fg` event follows the `ok` for live sessions.

**`acp.open` rules.**
- **Unknown sid:** with `spawn`, create it (`new:true`). Absent or empty spawn config replies immediately with `activity:"setup"` while setup runs asynchronously. Non-empty config waits for setup and the initial configuration batch (§3.4.5) to finish or terminate, then replies with the resulting Summary and `AcpSessionInfo`. Without `spawn`: `not_found`.
  - If the agent cannot be executed, the reply is still `ok`. The journal gets `setup_error{spawn_failed}`, with no `spawn` or `exit` line, and the session stays dead; non-empty config also records unapplied-entry failures as described in §3.4.5. A failed `acp.revive` spawn writes the same setup-error line and replies `err{code:"spawn_failed"}`.
  - Configuration failures do not undo an accepted creation or turn the open into an `err`. They are returned as `configErrors`; setup failure accounts for every unapplied entry and releases the open reply.
- **Existing sid:** attach, whether alive or dead. Nothing runs, and spawn config is not applied to it.
- **Reset:** `reset:true`, with a replay from seq 1, when `since > headSeq` **or** `epoch` is present and differs from `createdAt`.

#### 3.2.8 Events (hub to client)

| t | Fields | Sent to |
|---|---|---|
| `pty.out` | `sid, d, out` | Attached connections. `d` is decoded text (§3.4.3). `out` is the stream's byte offset after `d`. |
| `pty.fg` | `sid, comm, cwd` | Attached connections, after open and on change (2 s poll) |
| `pty.exit` | `sid, code, signal, reason` | Attached connections |
| `acp.ev` | `sid, ev: JournalEvent` | Attached connections (replay, then live) |
| `acp.replayed` | `sid, head, truncated` | Attached connections, once per `acp.open` |
| `acp.info` | `sid, summary, session` | Attached connections, on change. A change that touches only `headSeq` is published at once if at least 500 ms have passed since the last publish, otherwise at that publish + 500 ms with the latest state (at most one per 500 ms). Any other change publishes at once. |
| `session` | `session: Summary` | Watchers, same coalescing rule |
| `gone` | `sid, epoch` | Watchers **and** connections attached to the sid, after a forget. The hub then detaches those connections. |
| `err` | `sid?, code, message` | Asynchronous errors. `err{sid, code:"internal", message:"session reloaded"}` goes to the attached connections when a session actor panicked and is reloaded from disk; the attachment is dropped and the client must re-open. A request that was in flight at the panic gets the same message as its reply. A journal fault sends no `err`: the Summary's `fault` is the signal. |

#### 3.2.9 Limits (`wb_proto::limits`)

| Constant | Value | Overflow action |
|---|---|---|
| `MAX_LINE` | 16 MiB | close the connection. The web refuses a browser request that would exceed it after re-encoding (§3.5.2). |
| `PTY_INPUT_FRAME` | 1 MiB | `bad_request` (the web splits larger browser input) |
| `PTY_INPUT_QUEUE` | 8 MiB | drop the message, `input_overflow` |
| `PTY_RING` | 1 MiB per PTY session | the oldest bytes fall out; resume falls back to the snapshot |
| `CONN_QUEUE` | 4 MiB per connection | close the connection. An event is admitted whatever its size when the queue is empty. Replies are always admitted. |
| `ACP_REPLAY_MAX` | 4 MiB | truncate the oldest events (`truncated:true`); also the largest merged chunk event (§3.4.4) |
| `PROMPT_MAX` | 8 MiB | `bad_request` |
| `ACP_CONFIG_MAX` | 16 initial configuration entries, with distinct ids | hub `bad_request`; API 400 "bad body", before spawn |
| `ACP_CONFIG_OPTIONS_MAX` | 64 options in an agent's full offering | a larger list is malformed |
| `ACP_CONFIG_OPTIONS_BYTES` | 64 KiB of compact serialized UTF-8 JSON for the full offering | a larger list is malformed; oversized legacy journal offerings fold to none (§3.4.5) |
| `GIT_NAME_MAX` | 255 bytes per requested branch or base | `bad_request` |
| `GIT_TIMEOUT` / `GIT_WORKTREE_TIMEOUT` | 30 s for git queries and branch/lock updates; 120 s for `worktree add` and `worktree remove` | kill the process group and fail the request |
| `TASK_MAX` | 512 UTF-8 bytes after trimming | ACP: hub `bad_request`, API 400; harness report: ignore the field, keep the stored task |
| `POLICY_MAX` | 256 KiB serialized JSON per policy | hub `bad_request`; API 400 "bad body", before spawn; invalid journal replacements clear policy until a later valid event |
| `POLICY_RULES_MAX` / `POLICY_PATTERNS_MAX` / `POLICY_PATTERN_MAX` | 64 rules / 128 command patterns across all rules / 4096 bytes per pattern | hub `bad_request`; API 400 "bad body", before spawn |
| `POLICY_SELECTORS_MAX` / `POLICY_KIND_MAX` / `POLICY_PROGRAM_MAX` | 64 roots, kinds or programs per rule / 64 bytes per kind / 256 UTF-8 bytes per program | same; program entries require 1..=256 bytes, with no whitespace or NUL |
| `POLICY_REGEX_SIZE_MAX` / `POLICY_ROOT_MAX` | 64 KiB compiled regex size per pattern / 4096 UTF-8 bytes per root | hub `bad_request`; API 400 "bad body", before spawn; Unicode classes are large: use ASCII classes (`[A-Za-z0-9_]`, `[ \t]`) or scoped `(?-u:…)` |
| `POLICY_COMMAND_MAX` / `POLICY_COMMAND_WORDS_MAX` | 64 KiB raw command / 1024 shell words including redirection targets | request asks; limits are independent of framing |
| `POLICY_REGEX_COMMAND_MAX` / `POLICY_DECISION_TIMEOUT` | 8 KiB raw command for regex evaluation / 100 ms decision deadline checked before every pattern search | at a reached rule requiring regex evaluation, the whole decision asks; no fallthrough |
| `POLICY_FRAGMENTS_MAX` / `POLICY_FRAGMENT_BYTES_MAX` | 2048 candidate fragments / 256 KiB aggregate fragment bytes per request | request asks; charge count and string bytes before every set insertion attempt, including duplicates, independently of normalization work |
| `POLICY_PATHS_MAX` / `POLICY_PATH_BYTES_MAX` | 2048 candidate resolutions (locations included) / 256 KiB aggregate bytes normalized, including cwd bytes for relative candidates | request asks; independent of the fragment count/byte budget |
| `POLICY_PATH_CHECKS_MAX` / `POLICY_CWDS_MAX` | 65536 path/root comparisons across all rules / 32 possible working directories | request asks; normalized paths are deduplicated and checked at most once per rule |
| `VT_SCROLLBACK` | 1000 lines | |
| `SNAPSHOT_MAX` | 4 MiB | halve the scrollback budget until it fits |
| `ESC_HOLDBACK_MAX` | 4 KiB | flush the held tail as is |
| `CAPTURE_MAX` | 1000 lines | clamp |
| `SNAPSHOT_EVERY` | 30 s while dirty | |
| `FG_POLL` | 2 s | |
| `HELLO_TIMEOUT` | 5 s | close |
| `SETUP_IDLE_TIMEOUT` | 30 s without an agent message (paused while a request is pending) | `setup_error{timeout}` |
| `REQS_IN_FLIGHT` | 8 per connection | stop reading until one completes |
| `CMD_TIMEOUT_DEFAULT` / `_MAX` | 60 s / 300 s | `timeout` |
| `WS_MAX_PTY` / `WS_MAX_ACP` / `WS_MAX_RPC` | 2 MiB / 9 MiB / 32 MiB per browser message | close 1009 |
| `CARD_OPEN_DEADLINE` | 30 s from upgrade to `open` | close 1008 |
| `WS_PING` / `WS_DEAD` | 25 s / 60 s of silence | close |

**Slow-consumer policy:**
- The PTY reader never waits for viewers.
- Live events are queued per connection without awaiting. If one would take the queue past `CONN_QUEUE`, the hub closes that connection. The web closes the matching browser socket, and the frontend reconnects:
  - a PTY resumes from the ring or gets a snapshot;
  - an ACP card resumes from `since`.
- Replies are always admitted. The hub stops reading a connection's requests while its queue is at the cap, so replies are bounded too.
- Replay is paced: each replayed event, and `acp.replayed`, waits until the queue has room.
- Live events that arrive during a replay wait in a per-connection backlog with its own `CONN_QUEUE` cap (an empty backlog admits one event of any size). Overflowing the backlog closes the connection. The backlog is released only after the writer has drained the replay from the queue. Queue and backlog together can therefore hold up to 2 × `CONN_QUEUE`.
- The hub writer may send consecutive queued lines together; a blocked write keeps all but its current line charged to the queue.
- On `/acp` and `/pty`, the web may flush already available output frames together, without changing frame boundaries or waiting for another message.

#### 3.2.10 Hub availability as seen from the web
- The control connection reconnects with backoff: 250 ms doubling to 5 s, with jitter.
- The web treats an incomplete or undecodable initial watch as a lost connection and discards its staged summaries.
- Readiness and the session map change together; the web reports the hub up only after the final watch reply.
- While the hub is down:
  - `/api/info.hub.status="down"`;
  - new card sockets are accepted, then closed with 1013;
  - `/api/sessions` returns 503;
  - `/rpc` gets `hub{status:"down"}`.
- When a hub connection drops under a live browser socket, the web closes that socket with 1011.

### 3.3 `web.sock` (the `wb` CLI to wb-web)
- **Socket:** config `socket`, default `/run/workbench-web/web.sock`. Directory 0700, socket 0600, SO_PEERCRED `uid ∈ {geteuid(), 0}`. Same framing and `MAX_LINE` as hub.sock.
- **Handshake:** the server sends `{"t":"hello","proto":1,"server":"wb-web","version":…}`; the client answers `{"t":"hello","proto":1,"client":"wb/0.1.0"}`.
- **Request:** `{"t":"cmd","rid":1,"tool":"read_node","input":{…},"timeout":60}`.
- **Reply:** `{"t":"ok","rid":1,"result":"…"}` or `{"t":"err","rid":1,"code":C,"message":…}`, where C is `no_page | timeout | page_gone | tool | bad_request`.
- **Leader policy (fix 4):**
  - Each `/rpc` client has `lastActive`. It is the server receive time of its latest `active{ago}` message minus `ago`, and starts at "never".
  - The leader is the client with the greatest `lastActive`. Clients that never sent `active` rank below all that did. Ties go to the most recent connection.
  - A `cmd` goes to the leader only, and only the leader's `cmd_result` with the same `id` is accepted.
  - If the leader disconnects first, the call fails with `page_gone`. It is never re-sent to another tab.
- **Authority, stated explicitly:** any process running as the service user that can reach web.sock gets the full board tool set (`run_in_shell`, `publish_artifact`, `create_node`, …) through the leader tab. That is the authority such a process already holds.

### 3.3.1 `edit.sock` (the `wb` CLI and frames to edwind)
- **Socket:** `/run/edwind/edit.sock`, created by edwind (`edwin/server/main.mts`) in the `RuntimeDirectory` of the host's `edwind.service` (Edwin's `services.edwind`; Workbench neither runs nor ships edwind); directory 0700, socket 0600, no `SO_PEERCRED` (Node has none): the file permissions admit the same peers, `uid ∈ {geteuid(), 0}`, and edwind refuses to start unless the directory and socket are its own with those modes. NDJSON with the same `MAX_LINE` as hub.sock and web.sock; the messages are those of the edwind spec §7 (`hello`/`welcome`, `open`, `edit`/`ack`/`edits`, `save`, `call`/`result`, `image?`/`image`/`var`, and since E2 `ask`/`answer`, `interrupt`, `display`, `notes`, and the `sample` family wb-web forwards). Every `call` runs on a thread of the server image (edwind spec §4.8): a `call{form}` or a `(:where 'server)` command may block, ask its frame for input, time out (2 s for frames, 30 s for `wb`) or stop in the debugger; `edwin/README.md` Step E2 has the scheduler's rules.
- **Authority, stated explicitly:** any process running as the service user that can reach edit.sock runs arbitrary code as the service user: `call` with a `form` and `wb eval` evaluate Scheme on the server image, which can open, edit and save any file the unit can write. That is the authority such a process already holds.
- **Frames (`/edit`, edwind spec R9.16, R9.17):** each browser tab opens one WebSocket to `/edit`, behind the same floor as `/pty`, and wb-web (`relay_edit.rs`) opens one `edit.sock` connection for it. The relay parses nothing: a text frame is a line and a line is a text frame, so the browser sends `hello` with `kind: "frame"` itself. A binary frame or a text frame holding a newline closes 1003; a frame or line over `MAX_LINE` closes 1009; no `editSocket` or a failed connect closes 1013; edwind closing its end closes 1011; wb-web stopping closes 1012. The frame runtime is served under `/edwin/` (§3.5.5).

### 3.4 Session model

#### 3.4.1 Identity and the nothing-auto-runs rule
- **sid:**
  - The sid is the board node id, sanitised by the web to `[A-Za-z0-9_-]`, max 64 characters. An id that is empty after sanitising is rejected.
  - pty and acp share one namespace; a clash gives `kind_mismatch`.
  - Each ACP card has one agent process. No process is shared between cards.
- **Nothing auto-runs.** A process starts only on an explicit user action:
  - creating a card in this page;
  - pressing Enter on an ended or missing terminal;
  - **Start new session** or **Revive** on an ACP card;
  - a `wb create_node` tool call, which is an agent acting as the service user.

  On the wire that means a request without spawn fields never starts anything (§3.2.7). There is no "unknown sid + page load spawns" exception, for either kind. Wiping the hub `stateDir` and reloading therefore shows every card as "No session: press Enter / Start new session".

#### 3.4.2 On-disk layout
**Hub `stateDir`:** the module passes `/home/alice/.local/state/workbench/hub`. Directories are 0700 and files 0600.
```
hub.lock                                  flock, single instance
last-created                              decimal high-water mark for allocated session epochs
pty/<sid>.json                            {sid, shell (name), argv (argv[0] = the resolved shell path), cwd, env (client-supplied only), createdAt, cols, rows, exit|null}
pty/<sid>.snap                            last VT snapshot (on exit, on SIGTERM, every 30 s while dirty)
acp/<sid>.json                            {sid, agent, cwd, createdAt, agentSessionId|null, init|null, seenSeq, managedWorktree?}
acp/<sid>.jsonl                           journal (§3.4.4)
acp/<sid>.stderr.log[.1]                  agent stderr, rotated at 1 MiB (one generation kept)
<kind>/<sid>.quarantine-<ms>.<ext>        files of a session that failed to load (kept for inspection, never loaded)
```
- The loader considers only `<sid>.json` files whose stem matches the sid regex. Quarantined names contain a dot, so they never match.
- `.json` and `.snap` are written atomically: tmp, fsync, rename, fsync the directory.
- `last-created` uses the same atomic write and is never deleted by forget.
  On upgrade, the hub seeds the mark from the maximum epoch in valid PTY and ACP metadata, including ACP records shadowed by a PTY or paired with an unreadable journal. The mark is durable before any such metadata is quarantined, any faulted record gets a new epoch, or clients are accepted.
  This ordering guarantee cannot cover a session forgotten before the upgrade: its epoch is no longer on disk.
  On the first start without a mark, recovery continues past unreadable metadata; its epoch cannot seed the mark and may be issued again.
  Before trusting an existing mark, startup fsyncs the state directory even if the recovered maximum equals the mark.
  This validation happens under `hub.lock`, before creating session directories or removing their temporary files.
  An unreadable or malformed mark is an error, not a reset.
  An orderly stop waits for outstanding mark writes before releasing `hub.lock`. Each writer also retains the same flocked open file description through its write, so unwinding without an orderly stop cannot hand the lock to a successor too early.
- The journal is appended with one `pwrite(2)` per event at the tracked end of its last complete line, never with `O_APPEND`. If a failed append cannot even be truncated away, what is left is a prefix of a line with no `\n`: the next append overwrites it, and the next open truncates it. `fdatasync` runs on `session`, `setup_error`, `turn_end`, `turn_error`, `exit` and SIGTERM.

**Web `stateDir`** (`…/workbench/web`): `web.lock`, `artifacts/<node>/…`, artifact `db.json`. **There is no `index.db`**: the notes index lives in memory.

**Board:** `<boardsDir>/<host>.json` (`~/work/boards/devbox.json`). **Notes:** `notesDir` (`~/work/notes`); reviews go in `<notesDir>/.reviews/<host>.jsonl`.

#### 3.4.3 PTY sessions
- **Spawn:**
  - `openpt(O_RDWR|O_NOCTTY|O_CLOEXEC)`, `grantpt`, `unlockpt`, slave via `ioctl_tiocgptpeer`;
  - `std::process::Command` with stdio = slave, `env_clear()` + §3.7.3, and cwd;
  - `pre_exec`: restore the child umask, write `800` to `/proc/self/oom_score_adj`, `setsid()`, `TIOCSCTTY`;
  - argv is the request's `argv` with `argv[0]` replaced by the chosen shell's resolved path (§3.2.7): a single-item `argv` also gets the shell's configured `args` (an interactive, non-login start), and `[shell, "-c", cmd]` runs `cmd`;
  - the shell name is persisted in `pty/<sid>.json`. A respawn without `shell` uses it. A `shell` that names another shell wins and is persisted;
  - the hub restores the default `SIGCHLD` disposition before the first spawn so an inherited `SIG_IGN` cannot discard child status.
    Normally `waitid` with `WNOWAIT` observes exit without reaping until the actor has drained output and recorded the exit.
    `ECHILD` ends the wait with unknown code and signal; cleanup may use previously captured handles, never the released pid.
    On other wait errors the actor keeps the child until its owned child handle confirms exit; where reaping releases the leader early, pre-reap handles protect panic cleanup.
- **Kill:** while the leader is still unreaped, the hub opens `/proc/<pid>` handles and checks session membership (stat field 6) through those handles.
  Both SIGHUP and the delayed SIGKILL use those same handles, so a survivor is still targeted after the leader exits, but a reused pid or session id is not.
  A process forked after the snapshot is not killed by this escalation; covering later forks would require containment at spawn.
  The hub warns with the session id on capture or signal-delivery errors other than a vanished process; a kill request fails if SIGHUP could not be delivered to a still-live leader.
  A failed hangup leaves the live leader owed: a retry or teardown targets only the owned leader, without taking another snapshot.
- **Output path:**
  1. read ≤ 64 KiB;
  2. **OutStream** holds back an incomplete UTF-8 tail (≤ 3 bytes) and an unterminated ESC/CSI/OSC/DCS tail (≤ `ESC_HOLDBACK_MAX`, counted from the sequence's ESC). The next read releases both. After 20 ms without output only the escape tail is released, as is: an incomplete character cannot be shown and waits for the next read, which completes it or turns it into U+FFFD. A respawn resets the decoder;
  3. the released text chunk `d` is fed to `vt100` (`process()` under `catch_unwind`; a parser panic resets only that parser);
  4. it is appended to the **ring**;
  5. it is fanned out as `pty.out{d, out}`.
  - `out` counts bytes of the UTF-8 encoding of the emitted `d`, so an invalid input byte counts as the 3 bytes of U+FFFD.
- **Stream and ring:**
  - `stream` is the ms timestamp at which this PTY actor instance started: a spawn, a load at hub start, or a reload after a panic.
  - Offsets and the ring (`PTY_RING`) restart with each actor instance. A respawn inside the same instance continues the stream, matching what the viewer's xterm already holds.
  - `resume{stream, out}` is honoured only if `stream` matches and `ringStart ≤ out ≤ ringEnd`.
- **Snapshot** (`replay` when not resumed). Written into a freshly reset xterm.js of the same size, it reproduces:
  - primary scrollback (≤ `VT_SCROLLBACK`) and the primary screen with SGR;
  - when the alt screen is active, `\x1b[?1049h` and then the alt screen. The primary screen is recovered from a cloned `Screen` after `\x1b[?47l`;
  - cursor position and visibility, the SGR pen, DECCKM, DECKPAM, bracketed paste 2004, mouse 9/1000/1002/1003/1005/1006, and focus reporting 1004 (tracked through `Callbacks::unhandled_csi`).

  It is capped at `SNAPSHOT_MAX`: the scrollback budget halves, down to none, until it fits. Corpse parsers are loaded lazily from `.snap`.
- **Size policy:**
  - `pty.resize` is last-writer-wins. The frontend sends it only from a visible, focused tab for the active card (§3.5.1).
  - `pty.open` applies its size only when the opener is the session's sole viewer.
  - **VT shrink rule:** before reducing rows, when the cursor row is at or below the new row count, feed the parser (not the PTY) `CSI n S` then `CSI n A`, with n = cursor_row − new_rows + 1. The top rows then move to scrollback, as xterm.js does. After that, `set_size`.
  - Known residual: vt100 clears soft-wrap flags on every `set_size`.
- **Resize nudge** (alt-screen attaches only): `TIOCSWINSZ` rows−1, then after 50 ms the *currently desired* size. A `pty.resize` that arrives during the nudge cancels the restore.
- **Liveness:**
  - `alive` runs from spawn to `wait()`.
  - `fg` comes from `tcgetpgrp(master)` every 2 s, with `leader = (pgid == child pid)`.
  - For `bash -c CMD` the CMD is the leader, so it shows as idle. The frontend keeps its own `#agent` tagging from `fg.comm`.
- **Hub restart:** every `pty/*.json` without `exit` gets `exit{reason:"hub_restart", code:null}`, with `at` taken from the snapshot file's mtime (now if there is none). The record is rewritten on a best-effort basis: a failed write is logged and does not quarantine the session.
- **Load failure and panics:** a session whose files fail to load is quarantined (§3.4.4). It is registered as a dead session with `fault{load_failed}` and a `hub_restart` exit, so a card attaches to it as a corpse, and a respawn clears the fault. A panicking PTY actor hangs up its child and is reloaded through the same startup path.

#### 3.4.4 ACP journal (`acp/<sid>.jsonl`), replay, fail-closed

Each line is `{"seq":N,"ts":…,"e":KIND,…}`.
- `seq` starts at 1, increases by exactly 1, and has no gaps on disk.
- Readers skip unknown `e` values.
- ACP payloads are verbatim.

| e | Payload | Written when |
|---|---|---|
| `spawn` | `pid, via: "new"\|"revive"` | the agent process started |
| `session` | `via: "new"\|"resume"\|"load", sessionId, modes?, configOptions?` | setup succeeded |
| `setup_error` | `code: auth_required\|agent_error\|timeout\|revive_failed\|spawn_failed\|agent_exited\|interrupted, message, rpc?` | setup failed or was cut. An exec failure writes this with no `spawn`/`exit`. |
| `authenticate` | `methodId` | an accepted `acp.authenticate`; activity re-enters `setup` |
| `prompt` | `prompt` | a prompt was sent |
| `update` | `update`, plus `sessionId` only when it differs from `agentSessionId` | every `session/update`, unknown variants included |
| `turn_end` | `stopReason` | the `session/prompt` response arrived |
| `turn_error` | `code: agent_error\|agent_exited\|interrupted, message, rpc?` | the prompt failed, or the agent died or was killed mid-turn |
| `permission` | `toolCall, options` | `session/request_permission` arrived; `req` = this seq |
| `permission_resolved` | `req, outcome, by: "user"\|"cancel"\|"hub"\|"agent"` | the answer was sent; `agent` = the agent's own `$/cancel_request` |
| `permission_auto` | `toolCall, options, outcome, policy:{rule, action}` | one atomic request-and-answer event for policy; zero-based rule index, `allow` or `reject`, selected once-only option. No `permission` or `permission_resolved` event is written for it. Its seq identifies the resolved request. |
| `elicitation` | `request` (verbatim params) | `elicitation/create` arrived; `req` = seq |
| `elicitation_resolved` | `req, response, by` | the answer was sent |
| `elicitation_complete` | `elicitationId` | `elicitation/complete` arrived (url mode) |
| `mode` | `modeId` | `session/set_mode` succeeded |
| `config` | `configOptions` (full list) | `session/set_config_option` succeeded; written before its hub reply |
| `task` | `task: string\|null` | task reference set on creation, replaced or cleared; the latest event determines `Summary.acp.task` across revive and restart |
| `policy` | `policy: Policy` | supplied spawn policy, before starting the agent, or accepted replacement/removal before replying; an empty rule array explicitly removes the policy |
| `notice` | `level, text` | hub notes: initial configuration entry failures, the revive method, `agent stderr: <last line>` (≤ 500 characters) for an unclean exit, "agent stopped after failed setup", and the fault probe's `warn` |
| `exit` | `code, signal, reason: "exited"\|"killed"\|"hub_restart"` | the process ended. `code` and `signal` are the agent's real exit status, including on a graceful stop; they are null only in the lines startup normalisation writes. |

**Death invariant (pure fold).** When an agent dies, the hub writes, in order:
1. one `*_resolved{by:"hub"}` per pending request;
2. `turn_error` if `activity=="turn"`, or `setup_error` if `"setup"`, with code `agent_exited`, or `interrupted` for a kill or SIGTERM;
3. for an unclean exit (a non-zero code or a signal) with a non-empty last stderr line, `notice{error, "agent stderr: …"}` (≤ 500 characters);
4. `exit`.

At startup, a journal whose last `spawn` has no `exit` gets these lines with `reason:"hub_restart"` and `code:"interrupted"`. `Facts::apply` is the single fold used both live and at startup.

**Write rule, fail-closed.** `record(body)`:
1. assign `seq = head+1`;
2. write the full line at the tracked end;
3. **only on a complete write** advance head, fold, fan out and publish.

On a short or failed write:
- `ftruncate` back to the last good length;
- set `fault = {code:"journal_write"}`;
- record nothing more;
- fail every unapplied initial configuration entry with `faulted`, release the batch gate and answer the creating open, even if spawning failed before an agent process existed;
- tear the agent down (§3.4.5) without journaling;
- answer the agent's pending requests with cancelled, unjournaled.

While faulted:
- `prompt` and `revive` get `faulted`. No `err` event is sent: the Summary's `fault` is the signal.
- The agent's `exit`, once it has happened, is held back until the fault clears.
- On `acp.revive`, on `acp.kill`, and every 60 s, the hub probes the journal. If the death-invariant lines are outstanding, it appends them, including the held-back `exit`. Otherwise it appends a `notice{warn}`. On success the fault clears and the session is an ordinary dead session; a triggering `acp.revive` then proceeds under the normal rules.

Memory never runs ahead of disk, so seqs are never reissued.

**Load and quarantine.**
- Every session (both kinds) loads in its own task under `catch_unwind` plus error handling.
- A torn journal tail is the bytes after the last `\n`. They are truncated away and logged. A failed truncation is a load failure.
- Any other load failure, including a complete line that does not parse and a `seq` that is not the previous one plus 1 (starting at 1; a gap or a repeat): rename the session's files to `<sid>.quarantine-<ms>.<ext>`, then register a dead Summary with:
  - `fault={code:"load_failed", message}`;
  - `createdAt=now`;
  - `revivable:false`;
  - defaulted kind-specific fields.

  Startup continues.
- A panicking session actor is reloaded by its supervisor through this same path, never on the main task. Its attachments get `err{internal,"session reloaded"}` and are dropped.
- `kill{forget:true}` removes a quarantined registration and leaves its files on disk.

**Replay (`acp.open` with `since`).**
1. Take every event with `seq > since` (a `since` above `headSeq` counts as 0), skipping events of unknown kind.
2. The announcing events of **currently pending** requests are pinned: they are always sent, at their own seq position.
3. Coalesce runs of text `agent_message_chunk`, `agent_thought_chunk` or `user_message_chunk` updates with the same variant, `messageId` (null counts as absent) and session. The merged event takes the run's last seq and ts. A pinned event ends a run, and so does a merged text that would exceed `ACP_REPLAY_MAX`. Live events are never merged.
4. The other events get the budget `ACP_REPLAY_MAX` minus the bytes of the pinned events. If they exceed it, drop the oldest until they fit; the newest is always kept. `from` is the first kept event's first seq when events were dropped, else `since + 1`.
5. Send everything as **one stream in ascending seq order**, then `acp.replayed{head, truncated}`.

A pinned event appears at its own seq position, never ahead of a lower seq. Clients use `seq` as a strictly increasing cursor; gaps are allowed.

#### 3.4.5 ACP lifecycle and teardown
- **Spawn:**
  - argv and env from the agent table, cwd = session cwd, piped stdio;
  - `process_group(0)`, never combined with `setsid`;
  - `env_clear()` + §3.7.3. The fixed variables are applied last and win over `agents.<name>.env`. The agent's `SHELL` is the resolved path of the configured shell named `bash`; if none is configured, the spawn fails with `setup_error{spawn_failed}`;
  - `pre_exec`: umask and `oom_score_adj` 800.
- **stdout:** read with the tolerant `read_line_capped`:
  - over-long lines are discarded up to the next `\n`;
  - a trailing `\r` is stripped;
  - lines that are not JSON objects go to `stderr.log`.
- **initialize:**
  ```json
  {"protocolVersion":1,"clientInfo":{"name":"workbench","version":"0.1.0"},
   "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{},"url":{}},"session":{"configOptions":{"boolean":{}}}}}
  ```
  The response must have `protocolVersion == 1`, else `setup_error{agent_error}`.
- **Setup steps:** `session/new {cwd, mcpServers:[]}`. Each step runs under `SETUP_IDLE_TIMEOUT`.
  - A failed setup ends with `auth_required` and at least one agent-handled auth method (one without a `type`): the agent is kept and waits for `acp.authenticate`.
  - Any other failed setup journals `notice{warn, "agent stopped after failed setup"}` and kills the agent.
  - A setup response that arrives once teardown has started is ignored.
  - A malformed `configOptions` list in a successful `session/new`, `session/resume` or `session/load` result is omitted from the `session` event, not a setup failure. Setup continues; an initial batch without an offering fails each entry with `bad_option`. This does not change the resume-error fallback to load.
- **Initial configuration batch (non-empty `SpawnAcp.config`):**
  1. The hub owns the batch from creation, including the setup interval. It blocks the live actions listed in §3.2.7 for every client, not only the opener. No prompt is sent implicitly.
  2. After a successful `session/new` is journaled as `session`, apply the ordered array one entry at a time with the ordinary `session/set_config_option` RPC and 30 s timeout. Validate each entry against the latest full offering, including changes from earlier results.
  3. A successful result must be journaled as a full-list `config` event before proceeding. A bad id/value gives `bad_option`; an agent error or malformed result gives `agent_error`; a timeout gives `timeout`. Append the entry's `configErrors` result and journal a failure `notice` before starting the next RPC, continue with later entries while the session remains usable, and ignore replies to timed-out or otherwise completed requests.
  4. A setup failure fails every unapplied entry (`spawn_failed` for spawn failure, `timeout` for setup timeout, otherwise `agent_error`). Death or kill fails the outstanding and remaining entries with `not_alive`; a journal failure uses `faulted`. Every entry must be either successfully journaled or accounted for in `configErrors`; termination also journals a failure `notice` for each unapplied entry while the journal remains writable.
  5. End the gate and release the initiating `acp.open` reply on batch completion or termination, preserving the normal reply-before-replay/live-event ordering. The reply carries the final materialised options and opener-only errors; the hub does not need a web client to sequence configuration. Empty or absent config adds no gate or wait.
- **Revive:**
  1. `spawn{via:"revive"}` and initialize.
  2. `session/resume` if `sessionCapabilities.resume` is advertised.
  3. Otherwise, or if resume fails, `session/load` when `loadSession` is set. During a load the history-replay variants (`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`) are not journaled. State variants are.
  4. Success journals `session{via}` and a `notice`. If both fail: `setup_error{revive_failed}` and a kill.
  5. `seenSeq = headSeq` at the start.
- **Agent-to-client:**
  - `session/request_permission` first consults the hub's policy below. Requests left to ask, and every `elicitation/create`, are held with no timeout until answered by any viewer, by cancel, by the agent's `$/cancel_request` (`by:"agent"`), or by the hub at death.
  - Any other method gets −32601. Unknown notifications are logged and dropped.
- **Session configuration:** `session/set_config_option` carries `{sessionId, configId, value}` for a select string, with no `type` member; a boolean carries `{sessionId, configId, type:"boolean", value:true|false}`. The agent's successful response must carry a valid full `configOptions` list. The hub journals that list as `config` before answering `{}` or advancing an initial batch; an agent error, malformed list, timeout or journal fault is not success. Malformed results leave the previous full list unchanged and produce no successful `config` event; `[]` is a valid result that clears the offering. This does not change `acp.set_mode`.
- **Session permission policy (F-A50):** `Policy = {rules: Rule[]}`; `Rule = {action: "allow"|"reject"|"ask", kinds?: string[], roots?: string[], programs?: string[], command?: {matches?: string[], notMatches?: string[]}}`. Policy, rule and command objects refuse unknown fields. Optional conditions may be absent, but explicit `null` is invalid; supplied conditions must have their declared types. Omitted conditions impose no restriction; empty `kinds` or `roots` matches nothing, and empty `programs` matches no execute command. Rules run in order; all supplied applicable conditions must hold. A failed roots, programs or regex condition continues to the next rule. The first match wins, including `ask`; no match means `ask`. No policy is installed by default.
  - This is a convenience for supervising **cooperative agents, not a sandbox**. The bounded shell-word subset below narrows mistakes, not a hostile agent's capabilities. Symlinks, what a program does with its arguments, a script's contents, and adapter truthfulness are not seen; the hub does not enforce filesystem/network access or run a shell to inspect commands. The lexical model assumes **noninteractive POSIX `sh` or bash with default options**, no inherited aliases or functions, `CDPATH` unset, and a trusted initial environment and startup state. A harness that changes those assumptions voids the lexical guarantee.
  - **omp keeps one shell per session.** Functions, aliases and shell options set by a command a person approved stay in force for later commands, which policy may then allow: after a manually approved `git() { … }`, an allowed `git status` runs the function. Policy never allows a command that defines them, but cannot inspect or reset prior manually approved shell state.
  - The matcher judges the command text and `rawInput.cwd` **as the agent sent them**, not the eventual expanded command. Forms an agent is known to rewrite ask as specified below; adapter truthfulness and other rewrites remain outside the lexical guarantee.
  - Every automatic decision requires a well-formed tool call with non-empty string `toolCallId`, `title`, `kind`, a `locations` array whose entries each have a non-empty string `path`, and valid permission options. **An execute request may have empty `locations`; every other kind requires at least one location.** Command evidence is **`rawInput.command`**, a non-empty string required for `execute`; a non-`execute` kind carrying any `rawInput.command` member asks. Execute `rawInput` must be an object: apart from `command` and `cwd`, only **`timeout`, `async`, `pty`, `description`, `run_in_background`** are inert members, checked by name, not value (`INERT_EXECUTE_INPUT_MEMBERS`); any other member asks. `rawInput.cwd`, when present, must be a non-empty **plain path**: it asks if it starts with `~` or `@`, contains **`:` anywhere**, or contains any non-ASCII or control character. These refusals include embedded internal URLs such as `sub/local://notes`, which omp can route outside the literal directory. A plain cwd is resolved lexically against the session cwd, becomes the starting command directory, and is itself checked against any rule roots. `title` is checked for envelope validity only and is never matched, parsed or treated as command evidence. Missing, malformed or unsupported evidence, a wrong/missing request `sessionId`, missing required locations, or no suitable once-only option asks without falling through to a permissive rule. Cooperative adapters must report truthful kinds and the actual command in this field.
  - `kinds` matches the reported tool-call kind exactly (`read`, `edit`, `execute`, `fetch`, and future strings). `roots` requires **every** reported location, starting/possible working directory, and command path candidate to lie in at least one listed root. Roots are absolute paths or exactly `"$cwd"` (always the session cwd, not a command override); each root is at most 4096 UTF-8 bytes. Empty/NUL roots and kinds are refused.
  - `programs` and `command` are **execute-only conditions**: a rule containing either does not match read/edit or any other request without command evidence, even without `kinds` or with an empty condition. Use separate read/edit and execute rules to share roots. `programs` has at most 64 entries per rule; each is 1..=256 UTF-8 bytes and contains no whitespace or NUL. Every simple command's actual command word, after POSIX assignment prefixes, must match, including each pipeline/conditional command and `cd`. A listed name without `/` matches only an exactly identical bare command word: `git` does not match `./git` or `/usr/bin/git`, and there is no basename or `PATH` lookup. Entries containing `/` are lexically normalized against the **session cwd at installation**, not a command override or subsequent tracked cwd. A command word containing `/` is normalized against every possible tracked cwd, and every resulting path must equal a listed normalized program path. The original entries remain ordinary persisted policy fields; installation/replay derives their normalized comparisons from the session cwd. If directory changes are wanted, list `cd` explicitly as well as permitting its modeled destination.
  - For `execute`, the hub tokenizes literal shell words: single/double quotes are removed and adjacent quoted/unquoted fragments join into one word. Simple commands split at `;`, `&&`, `||`, `|` and unquoted newlines; `<`, `>` and `>>` have literal word targets. A whole word containing `/`, or equal to `.` or `..`, is a path candidate. In addition, both sides of **each** `=`, `:` and `,`, and each segment split on those delimiters, are independently considered by that same predicate; checking pieces never replaces checking the whole word. Redirection targets and command names are included. Bare names without `/` are not path candidates: they are relative to a tracked directory that must itself be inside any required roots. Fragment generation charges its aggregate count and string-byte budget **before every set insertion attempt**, including duplicates; this budget is separate from subsequent path-resolution/normalization limits (§3.2.9).
  - The tracked directory starts at **plain `rawInput.cwd` resolved against the session cwd**, or the session cwd when absent, and changes only for **`cd WORD`**, with exactly one non-empty literal operand and no assignment prefix, options or glob metacharacters. A dequoted `cd` operand starting with **`@`**, containing **`:` anywhere**, or containing non-ASCII asks, including omp's hoisted leading `cd X &&` / `cd X;` forms. This refuses colon-prefix rewrites and file URLs whose percent-decoded dot segments differ from lexical normalization, including quoted or concatenated spellings; tilde forms are also refused. The destination itself must be inside the roots, even if it is a bare name. Failed `cd`/redirections leave the old directory possible; `&&`/`||` retain both success/failure branches, and `;`/newline merge their possible directories. Pipelines share their incoming directory; `cd` in a pipeline asks because its subshell behavior is not modeled. **`chdir` always asks**, including with no operand; its shell-specific directory semantics are not modeled.
  - **Only omp is known to reset the working directory for every command.** The hub derives that fact from the session's persisted configured agent key (`omp`), not the sid or agent-supplied permission fields, and passes it when compiling the policy. **For every other agent, policy never answers an execute request:** it always takes the ordinary pending path, regardless of rule action or whether the command contains `cd`. Other kinds are unaffected. The matcher keeps no directory state between requests; a person-approved `cd` in a persistent shell would invalidate its starting-directory assumption for every later command. Other agents' request shapes and cwd behavior have not been examined.
  - **These ask:** `$` anywhere (variables, `${…}`, `$(…)`, arithmetic expansion), backticks, `{` or `}` (including brace expansion), `(` or `)` (subshells and process substitution), backslash escapes outside single quotes, words or delimiter fragments starting with `~`, non-ASCII bytes and control characters other than unquoted newline. Unbalanced quotes and quoted newlines ask. Also unsupported: here-documents/here-strings; redirections other than `<`, `>` and `>>` (including descriptor prefixes/duplication); background `&`; unquoted comments beginning a word; malformed/empty commands or missing operands; and assignment-only or redirection-only commands at any command boundary.
  - Before a command word, a word containing `=` must be a POSIX assignment prefix: `NAME=value`, where `NAME` matches `[A-Za-z_][A-Za-z0-9_]*` and both the name and separating `=` are unquoted in the source token; the value may contain quoted fragments. Assignment eligibility is preserved before quote removal: an apparent prefix with quotes in its name or around its `=` asks instead of hiding the actual command word. Prefixes assigning **`CDPATH`, `PATH`, `IFS`, `ENV`, `BASH_ENV`, `HOME`, `PWD`, `OLDPWD`, `SHELLOPTS`, `BASHOPTS`, `GLOBIGNORE`, `LD_PRELOAD`, `LD_LIBRARY_PATH` or `LD_AUDIT`** ask even when their value is empty. Other literal assignment values remain subject to ordinary path/syntax checks.
  - An assignment-shaped word (`NAME=…`) following a redirection **before the command word** asks, even with valid assignment provenance. omp's embedded shell can execute that word as the command instead of treating it as another assignment prefix; assignments wholly before redirections and arguments after the actual command word retain the ordinary rules.
  - **Builtin/keyword classification is complete, not a partial denylist:** one shared table covers all POSIX/bash builtins and reserved words. Every reserved word and every builtin is refused in command position except the ordinary builtin allowlist **`echo`, `printf`, `true`, `false`, `test`, `[`, `pwd`**, exactly. Classification never bypasses other guards: the command-word glob guard below still refuses literal `[`. A `printf` format accepts each `%` sequence only as `%%` or `%[-+ #0']*([0-9]+|\*)?(\.([0-9]+|\*)?)?[diouxXeEfFgGaAcsbq]`: known flags, optional numeric/star width, optional precision, and a known printing conversion. All other sequences ask, including `n` with any flags (such as `%'n`), `(…)T`, length modifiers and a trailing lone `%`; `%%n` remains literal output. A missing format, a `printf` first operand starting with `-v`, and `test` with any `-v` operand also ask: Bash's variable-writing forms can change shell resolution state directly or through array-index arithmetic. **`cd` is separate**, permitted only by its exact modeled form above; `cd -` and all other forms ask. This refusal includes dispatch/state-changing builtins such as `eval`, `exec`, `source`/`.`, `command`, `builtin`, `enable`, `set`, `shopt`, `trap`, `export`, `readonly`, `unset`, `read`, `pushd` and `popd`, without limiting refusal to those examples.
  - As an additional **convenience refusal by command-word basename**, invoking common shells (`sh`, `bash`, `dash`, `zsh`, `ksh`, `fish`) or dispatchers **`env`, `nice`, `nohup`, `timeout`, `time`, `xargs`, `busybox`, `sudo`, `doas`, `su`, `watch`, `stdbuf`, `setsid`, `chroot`, `unshare`, `nsenter`, `flock`, `strace`, `ltrace`, `parallel`, `ssh`, `script`** asks, including invocation by a path. This is not complete dispatcher detection or a program-semantics guarantee; nested shell programs are not parsed.
  - A command word containing **`*`, `?` or `[` anywhere** asks. In an ordinary argument or redirection target, any path component that both contains one of those metacharacters and starts with **`.` or `[`** asks. Other ordinary-argument/redirection globs remain lexical candidates, not expanded: under the assumed default shell behavior they cannot match `/`, `.` or `..`, while the refused leading-dot/bracket forms could obscure traversal or hidden components. These syntax/evidence, assignment, builtin, dispatcher and glob guards apply to **every automatic execute decision**, including rules without `roots` or `programs`.
  - Paths are normalised **lexically** once per candidate: remove `.` and resolve `..` before component-wise containment, clamping `..` at `/`. Relative locations resolve against the starting command directory for execute and the session cwd for other kinds; relative command candidates resolve against every possible tracked cwd. `/home/u/proj-other` is not under `/home/u/proj`. No filesystem lookup or symlink resolution occurs: a symlink named inside a root counts as inside even if its target is outside. This also works for remote session paths without inspecting the hub filesystem. Bounds in §3.2.9 cap command bytes/words, aggregate fragment count/bytes before insertion, candidates/normalization work (including an explicit command cwd), possible directories and total root comparisons; excess asks. Repeated normalized paths are checked once per rule, not once per occurrence.
  - **Command-word checks are not program interpretation.** Without `programs`, roots constrain visible command words/path candidates, not which external program runs or what it does. With `programs`, the policy author chooses named programs and conventions to trust; the matcher still does not interpret arguments, dispatch, or script bodies. In particular, `git`/`make`/`tar -C` can change a program's own directory semantics without changing the tracked shell cwd; joined options such as `-o/etc/x`, response files such as `@file`, and interpreter/script arguments can name resources the lexical path checks do not correctly interpret. No program allowlist makes those semantics, symlinks or adapter truthfulness enforceable here.
  - `command` regexes inspect **both raw `rawInput.command` and a canonical rendering of the modeled command**. Canonical rendering removes word quotes/concatenation. For each simple command it writes the dequoted words first, in order, then that command's redirections in their original order with their targets; words/tokens are joined by single spaces. Original separator spellings (`;`, newline, `&&`, `||`, `|`) and redirection spellings (`<`, `>`, `>>`) are retained, but redirection positions among arguments are not: `git >/tmp/o push` becomes `git push > /tmp/o`. It is regex input, not a command to execute. For an **allow** rule, each `matches` pattern must match **both** texts, and no `notMatches` pattern may match **either**. For a **reject or ask** rule, each `matches` pattern must match **either** text, and a `notMatches` pattern excludes only when it matches **both**. Thus disagreement always resolves away from allow. A rule carrying `command` does not match a request without command evidence. Patterns use the Rust `regex` crate syntax, without backtracking, compiled with `RegexBuilder::size_limit(64 * 1024)` per pattern. **Unicode classes are large:** oversized-pattern errors recommend ASCII classes (`[A-Za-z0-9_]`, `[ \t]`) or a scoped `(?-u:…)`; the compiled-size limit is not relaxed. Policy bounds, program-entry validation and regex compilation are checked before any agent starts; oversized compiled patterns are validation errors, and invalid installation requests leave an existing session and its journal unchanged.
  - A raw command longer than **8 KiB** is not tested against regex patterns. Each decision starts a **100 ms** deadline, checked before each raw or canonical pattern search; a search already in progress is not preempted. When evaluation reaches a rule whose patterns would need evaluation and either limit is exceeded, the **whole decision asks**, never skips that rule or falls through to a later allow. Earlier decisions without patterns stand, and rules already excluded by kinds/programs/roots need no pattern evaluation. An empty `command` condition has no patterns to evaluate.
  - `allow` selects only an option whose ACP `kind` is `allow_once`, never `allow_always`; `reject` selects only `reject_once`, never `reject_always`. Missing required once-only options ask without consulting later rules. `ask` leaves the ordinary client-answer path unchanged. Elicitations never enter the matcher.
  - A policy answer is written as **one `permission_auto` event before sending the agent response**, never as a pending announcement. Thus neither live clients nor a replay can briefly expose it as pending; older clients skip the new event. A failed journal write sends only cancellation and tears the agent down under the existing fail-closed rule. Manual permissions retain their old journal shape; old journals load without a policy.
  - Policy answers permissions **only while a prompt turn is in progress and has not been cancelled**. A permission arriving after `acp.cancel`, or outside a turn (including after the cancelled turn's prompt response), asks even if policy would allow or reject it. It is journaled and held on the ordinary manual path, not `permission_auto`; clients may answer it or cancel again. The cancellation guard resets for the next accepted prompt.
  - A supplied spawn policy is journaled before spawn. Replacement/removal writes `policy` before success and affects **future requests only**: requests already pending remain manually answerable, even if a replacement would allow or reject them. The journal is authoritative on restart and revive. The policy belongs to the sid's persisted `createdAt` incarnation; forget deletes it, creation never inherits it, and replacements carry `epoch`. Policy decisions do not mark events seen on a user's behalf.
  - The complete serialized policy is at most **256 KiB**, including JSON escaping and UTF-8 bytes. Validation counts output bytes without allocating an unbounded serialized copy. Journal folding also validates replacements: an oversized or otherwise invalid policy event **clears policy**, so every request takes the ordinary pending path until a later valid policy event. It never restores the policy that the invalid event replaced. A valid empty policy also removes it.
  - When the last replayed policy event is invalid, the hub emits one session `notice` of level `warn` per load, explaining that requests ask unless a later valid policy is set. A later valid or empty policy event suppresses the warning. The warning is journaled for replay; an existing warning following the invalid events suppresses another, so repeated restarts do not accumulate notices. A later newly invalid policy event can produce a new warning.

  Example: an explicitly installed outside supervisor's rule set, not a default policy; every non-match asks. Read/edit have their own roots-only rule, because command-conditioned rules cannot match them. The execute rule does not permit `cd`; add it to `programs` explicitly if modeled directory changes are desired. **Subcommand exclusions are best-effort**, even with canonical matching: `git -C . push` does not match `git\s+(push|...)`. Program argument conventions are not parsed; the real control against authenticated operations is **not giving the agent the credential**, not this regex:
  ```json
  {"rules":[
    {"action":"allow","kinds":["read","edit"],"roots":["$cwd","/nix/store","/tmp"]},
    {"action":"allow","kinds":["execute"],"roots":["$cwd","/nix/store","/tmp"],
    "programs":["cargo","nix","git","ls","cat","grep","rg","sed","head","tail","wc","node"],
    "command":{"notMatches":["sudo","git\\s+(push|tag|remote|config|reset|clean|checkout|switch|branch|rebase|merge|stash|worktree)","gh ","systemctl","ssh","scp","curl","wget","nc","kill","pkill","secrets","sops","~/","\\$HOME"]}}]}
  ```
- **Facts:**
  - `activity`: in the journal fold, `setup` from `spawn`/`authenticate` to `session`/`setup_error`; `turn` from `prompt` to `turn_end`/`turn_error`; otherwise `none`. Published snapshots additionally report `setup` for the entire active initial configuration batch, including after its `session` line, until its gate ends.
  - `pending` = unresolved requests.
  - `last` comes from `turn_end`, `turn_error` and `setup_error`.
  - `title` from `session_info_update`; `modeId` from `session`, `current_mode_update` and `mode`.
  - `configOptions` from `session.configOptions`, `update{sessionUpdate:"config_option_update", configOptions}` and `config.configOptions`. Each valid supplied list replaces the previous list whole in both the Summary and `AcpSessionInfo`, including an empty list; it is never merged by id. A valid list contains at most `ACP_CONFIG_OPTIONS_MAX` (64) options and serializes to at most `ACP_CONFIG_OPTIONS_BYTES` (64 KiB), with every member a supported option object. Malformed `session/set_config_option` results and `config_option_update` lists are rejected before journaling and keep the previous offering, but malformed setup or revive lists leave it empty because the `session` event carries none. Valid options survive a hub restart; an oversized offering in a legacy journal folds to none, including when a valid offering preceded it. A `session` without `configOptions` clears the previous offering.
    The page applies `config.configOptions` during journal replay too, without waiting for another `info` snapshot.
  - `policy` comes only from `policy` events, with empty rules materialised as absent. `permission_auto` never adds a pending request.
  - User actions set `seenSeq = headSeq`: prompt, cancel, permission, elicitation, revive, authenticate.
  - An answer (permission, elicitation, cancel, or the agent's own cancel) is journaled **before** the response goes to the agent. If that write faults, the agent receives only the cancel marker, so it never acts on an answer the journal lacks.
- **Teardown.** One routine serves user kill, failed setup, fault, crash and shutdown.
  - **Stages for a deliberate kill:**
    1. `session/close`, only when the agent has a session and advertised `sessionCapabilities.close`; wait ≤ 2 s.
    2. Close stdin; wait ≤ 3 s.
    3. SIGTERM the process group; wait ≤ 3 s.
    4. SIGKILL the process group.

    A hub stop skips step 1 and waits 5 s after closing stdin and 1 s after SIGTERM, so SIGKILL comes 6 s in.
  - **After the agent process exits by any path, crash included:** stdout may still deliver for ≤ 1 s. If stdout reaches EOF first, the agent has 3 s to exit before the process group is killed. If the process group still has members (`kill(-pgid, 0)` succeeds), SIGTERM it and SIGKILL it after 2 s.
  - **Then finalise:**
    - write the death-invariant lines and `exit`, then `fdatasync`;
    - after a **user** `acp.kill`, set `seenSeq = headSeq` **after** finalising. Other kills (a failed setup, a fault, a hub stop) leave `seenSeq` alone.
  - **Not touched:** descendants that left the group with `setsid`/`setpgid` survive, like processes after an ssh logout. They are visible in `/api/proc`.
- **SIGTERM shutdown** (`TimeoutStopSec=15` is systemd's external limit). Accepting has stopped first.
  1. Every session actor refuses later requests with `err{internal, "hub stopping"}`.
  2. PTY actors snapshot their screens and SIGHUP their sessions. Agent actors close stdin and, if the agent is still there, send SIGTERM to its group at 5 s and SIGKILL at 6 s, measured from the start of actor teardown, not the shutdown mailbox send.
  3. The shared 5 s `HANGUP_WAIT` starts only after the hub has fenced in-flight epoch writes and awaited every shutdown mailbox send.
     A stalled mark write or a full mailbox delays the start of this deadline.
     Each exit is recorded with `reason:"hub_restart"` and the observed `code`/`signal`, both null if the child was already reaped.
  4. As soon as all acknowledgement channels resolve or close, or the shared 5 s grace expires, the hub sends SIGKILL through all remaining captured PTY handles, including those of sessions already forgotten.
     This can shorten the ordinary three-second grace for a user kill; later captures escalate immediately.
     After sending KILL, the hub waits up to 3 s more (`KILL_WAIT`) for any outstanding exit records.
  5. Exit 0.

  `KillMode=mixed` reaps the rest, and the next start completes any record the stop did not finish.

#### 3.4.6 Derived state: `wb_proto::state::derive(&Summary) -> State`

`State` is one of: `idle`, `running`, `waiting_permission`, `waiting_input`, `done`, `error`, `exited`, `detached`. Only the web calls `derive`; the function is pure, and its table tests are normative.

```
Both kinds:
  0. fault != null                           -> error
PTY:
  !alive                                     -> exited
  fg.leader == false                         -> running
  otherwise                                  -> idle
ACP (a = summary.acp), first match wins:
  1. a.pending has a "permission"            -> waiting_permission
  2. a.pending non-empty                     -> waiting_input
  3. a.last && a.last.seq > a.seenSeq && a.last.outcome in {error, refusal, max_tokens, max_turn_requests} -> error
  4. alive && a.activity != "none"           -> running
  5. !alive && a.revivable                   -> detached
  6. !alive                                  -> exited
  7. a.last && a.last.seq > a.seenSeq && a.last.outcome != "cancelled" -> done
  8. otherwise                               -> idle
```

- **`revivable`**, computed by the fold, holds when all of these are true:
  - `agentSessionId != null`;
  - the last initialize advertised `loadSession` or `sessionCapabilities.resume`;
  - no `setup_error{revive_failed}` since the last `session` event.

  A session that never got an `agentSessionId` (for example a logged-out claude) is not revivable, and the card offers **Start new session**.
- **A fault clears** on PTY respawn, on a successful journal probe, or on forget.

**Attention mapping:**

| Level | States |
|---|---|
| `bad` | `waiting_permission`, `waiting_input`, `error` |
| `normal` | `done`, and the frontend's aggregate line "N agents detached" |
| none | `idle`, `running`, a single `detached`, PTY `exited` with `reason:"hub_restart"` |
| the existing "ended" item | other PTY `exited` |

#### 3.4.7 What survives what

| Event | Processes | Pending requests | ACP transcript | PTY screen | Board, notes |
|---|---|---|---|---|---|
| Web restart or crash, browser reload, network blip | all survive | survive, re-shown, first answer wins | full | **lossless resume** from the ring on the same page; exact snapshot on a new page | on disk |
| Reverse-proxy reload | survive; sockets stay open (`stream_close_delay 5m`) | same | same | same | same |
| Hub restart (manual or crash) | all end | resolved `by:"hub"` | full; turn marked interrupted | last snapshot (≤ 30 s stale on a crash, exact on a clean stop) | on disk |
| Reboot | same as a clean hub stop | same | same | exact snapshot | on disk |
| Disk full | survive (PTYs); the affected agent is stopped with `fault` | cancelled | intact up to the fault | snapshot writes fail and are logged | – |

### 3.5 Browser contract (wb-web)

#### 3.5.1 `/pty`, kept wire-compatible with the prototype plus additive fields

Client to server. Frames that are not JSON objects, and unknown `t`, are ignored.

| t | Fields | Notes |
|---|---|---|
| `open` | `id, cmd, parent, cwd, cols, rows, env, shell?, attach?, spawn: bool, resume?: {stream, out}` | Only the JSON value `true` spawns: `false`, `null`, `"true"`, `1` and an absent `spawn` only attach (M0 treats absent as true, §10). The web ignores `cmd`/`env`/`cwd`/`parent`/`shell`/`attach` unless `spawn` is true. With `spawn:true`, `attach` names an observed record and excludes `cmd` (§3.8.3). `tmux` is ignored. A malformed `resume` is dropped. `cols` and `rows` default to 80 and 24. |
| `in` | `d` | split by the web at 1 MiB char boundaries |
| `resize` | `cols, rows` | sent only when the page is visible and focused and this card is the active card |
| `kill` | `session: true\|false\|absent` | `forget = (session === undefined)` |

Server to client:

| t | Fields |
|---|---|
| `hello` | `new, resumed, replay?, stream, out, epoch, cwd?` |
| `out` | `d, out` |
| `fg` | `comm, cwd` |
| `exit` | `code, signal, reason` (sent right after `hello` when the reply carried `exit`) |
| `gone` | `epoch`, then close 1000 |
| `error` | `error, code?`. `code:"not_found"` makes the card show "No session: press Enter to start {cmd or a shell}". |

**Web mapping:**
- `open` with `spawn:true` becomes `pty.open{…, spawn:{argv, shell?, cwd, cwdFrom: parent, env:{CANVAS_NODE, …env}}}`:
  - a non-empty browser `shell` becomes `SpawnPty.shell` and also `argv[0]`. With no `shell`, `SpawnPty.shell` is absent and `argv[0]` is the `defaultShell` from that socket's hub `hello`;
  - `argv` is `[name]` when `cmd` is empty, else `[name, "-c", cmd]`;
  - the web does not validate the name. An unknown one gets `bad_request` from the hub, which reaches the browser as `error` and a close 1000 (see Failed open);
  - with `spawn` false, the `spawn` field is omitted.
- `resume` passes through.
- A second `open` on the same socket first detaches the previous sid.
- `input_overflow` becomes a local `out` notice, never `error`. An `internal` error ("session reloaded") for the attached sid closes the socket with 1011. Any other asynchronous hub error is logged and not shown.

**Frontend spawn rule.** `spawn:true` is sent only:
- on the first open of a card created in this page by a user action or a `wb create_node` call;
- on Enter on an ended or not-found card.

Every page-load open and every reconnect sends `spawn:false` with `resume`. The frontend clears its spawn flag as soon as an open is sent, so a reconnect never spawns: a card whose first open meets 1013 or a lost hub reconnects with `spawn:false`, gets `not_found`, and asks for Enter again.

**Failed open.** A failed open sends `error{error, code}` and then closes 1000 (§3.5.4). The frontend does not auto-reconnect after a 1000 close: the card shows ended or not found, and Enter re-opens with `spawn: true`.

#### 3.5.2 `/acp`, one socket per `acp` card

Client to server. An optional `rid` (any non-null JSON value) is echoed verbatim on `error`. `open` MUST be first and appear only once.

| t | Fields | Becomes |
|---|---|---|
| `open` | `id, since, epoch?, agent?, cwd?, config?: ConfigOption[], policy?: Policy` | `acp.open{sid, since, epoch, spawn: agent && cwd ? {agent, cwd, config, policy} : absent}`. `config` is the same ordered string-or-boolean array as `SpawnAcp.config`, not the API's object. Policy is validated before forwarding the spawning open. |
| `prompt` | `blocks` | `acp.prompt` |
| `cancel` | – | `acp.cancel` |
| `permission` | `req, epoch, outcome` | `acp.permission` |
| `elicitation` | `req, epoch, response` | `acp.elicitation` |
| `set_mode` | `modeId` | `acp.set_mode` |
| `set_config_option` | `epoch, configId, value: string\|boolean` | `acp.set_config_option` |
| `seen` | `seq` | `acp.seen` |
| `revive` | – | `acp.revive` |
| `authenticate` | `methodId` | `acp.authenticate` |
| `kill` | `forget` | `acp.kill`. With `forget`, the web closes 1000 after the (late) `ok`. |

Server to client:

| t | Fields |
|---|---|
| `hello` | `status: "new"\|"attached", info: AcpInfo, head, from, reset, configErrors?: ConfigError[]`. Opener-only errors are top-level, omitted when empty, not part of `info`. |
| `ev` | `ev: JournalEvent` |
| `replayed` | `head, truncated` |
| `info` | `info: AcpInfo`. `info.session` is **omitted when unchanged** since the last one sent on this socket. |
| `error` | `error, code, rid?` |
| `gone` | `epoch`, then close 1000 |

`AcpInfo = Summary + {state, session?}`.

The relay carries config options in `info` and journal `ev` messages and accepts `set_config_option` for a future page. A configured open receives its `hello` only after the hub's initial batch ends or terminates; its `info` already contains the resulting full option list. F-A49 adds no page controls or other `web/` changes.

A non-empty `open.config` requires the connected hub's `acpConfig:true`. Otherwise the relay sends `error{code:"bad_request", message:"hub does not support session configuration"}` and closes 1008 without forwarding the open. Missing or empty config remains usable with an older hub.
**Errors and closes:**
- **Before `open`:** a malformed message, a message that is not `open`, or an id that sanitises to empty gets `error{code:"bad_request"}`, then close 1008. No `open` within `CARD_OPEN_DEADLINE` also closes 1008.
- **After `open`:** a malformed message gets `error{code:"bad_request"}` and is not relayed; a second `open` gets `error` "open was already sent". In both cases the socket stays.
- **Commands are relayed as soon as `open` is sent**, without waiting for its `ok`. The hub rejects blocked actions with `busy` throughout a non-empty initial batch, rather than retaining them for later. The web closes 1011 if the hub has not answered an ordinary open within 10 s; for a non-empty config array the outer reply wait is `40 s × (1 + number of options)`, covering setup and each sequential option with grace. This is a web reply deadline, not a replacement for the hub's setup idle timeout.
- **A failed open** sends `error` with the `rid` echoed, then closes 1000.
- **`kill` with `forget`:** on `ok` the web closes 1000, with no message before it; on `err` it sends `error` and the socket stays.
- **`gone`** is sent as `{t:"gone", epoch}`, then close 1000.
- **A hub `err` for this sid with code `internal`** ("session reloaded") closes 1011, so the card reconnects and opens again from its cursor. Any other asynchronous error for this sid is sent as `error` without a `rid`. Errors for other sids are only logged.
- **Journal events of an unknown kind** are not relayed. Events are re-serialised from typed journal events with their payloads verbatim.
- **An oversized request** is refused locally. The web encodes each hub request once. Re-encoding can make a request longer than the browser's message (a number such as `1e15` is written as `1000000000000000.0`), so if the line would exceed `MAX_LINE` + 1 bytes the web answers `error{error:"message too large", code:"bad_request", rid}`, forwards nothing, and keeps the socket. The hub connection is never ended by a browser message.

**Card rules:**
- **Cursor:** skip an `ev` with `seq <= this.seq`, otherwise apply it and set `this.seq = ev.seq`.
- **Reset:** `hello.reset:true` clears the transcript, the pending map **and `this.seq = 0`** before the replay.
- **Epoch:** the card's epoch is `info.createdAt` from `hello`. It is sent on `open` (reconnects), `permission` and `elicitation`.
- **Spawn fields:** `agent`/`cwd` are sent only for a card created in this page, or after **Start new session**. On a page load the card opens without them. `not_found` shows "No session" with Start new session.
- **Start new session:**
  1. Send `kill{forget:true}` and show "ending…".
  2. On close 1000 after `ok`, open a new socket with `since:0, agent, cwd`.
  3. The `gone` for the old epoch is ignored.
- **Duck typing:**
  - `dead = !info.alive`;
  - `input(d)` with a trailing `\r` → `prompt`;
  - `kill()` → `kill{forget:true}`;
  - `end()` → `kill{forget:false}`.
- **Node fields persisted:** only `{agent, cwd}`.

#### 3.5.3 `/rpc`
**Kept:** `sample`, `limits`, `tool_result`, `tool_error`, `cancel`, `cmd_result`, and on the server side `text`, `tool`, `done`, `error`, `ok`, `cmd`. wb-web does not run `sample` itself: it forwards `sample`, `tool_result`, `tool_error` and `cancel` to edwind over its `edit.sock` connection as `sample{sid, tab, …}` and the like, with `sid` a stream id unique in the web process and `tab` the socket's id, and maps edwind's `sample.text`, `sample.tool`, `sample.done` and `sample.error` back to the tab's `id` (edwind spec §12.2). `limits` is `call sample-limits`. A `sample` while edwind is down or reports no model backend is answered `error{id, code: "sampling_disabled"}`, and `limits` with `value: null`. When a socket closes with streams open, wb-web sends `cancel{sid}` for each (R12.8).

**Changed:** `cmd` goes to the leader only (§3.3).

**New, client to server:** `active{ago}`, where `ago` is ms since this tab was last visible and focused (0 when it is now). It is sent on every (re)open, on `focus`, and on `visibilitychange` to visible.

**New, server to client:**
- `hub{status: "up"|"down"|"incompatible", version?, build?, startedAt?, stale?}`. Only an `up` hub adds the other fields;
- `sessions{sessions}` on connect while the hub is up, and again each time the hub comes up;
- `session{session}`;
- `gone{sid, epoch}`;
- `board{etag}` on connect, with the board's current tag (`"empty"` when there is none) right after `hub`, and after every successful board PUT, to all clients. The connect one covers a save between a tab's `GET /api/board` and its subscription, and one made while the tab was disconnected; the frontend handles both alike (F-A7);
- `notes{gen}` whenever edwind reports an index change (edwind spec R11.7), to all clients;
- with `api` in `web.json` (§3.8): `observed{sessions}` last on connect, with every record of the registry as `GET /v1/observed` lists them (§3.8.3), then `observed_put{session}` and `observed_gone{oid, key}` as records change (`oid` is the record's `id`: a top-level `id` on this socket names a call's reply), at most every `OBS_PUSH_EVERY`. A client that fell behind gets the connect messages again. Without `api` none of the three is sent.

**Frontend rules:**
- `OBS[id]` is replaced whole by `observed`, upserted by `observed_put` and deleted by `observed_gone{oid}` (F-A47).
- `SESS[sid]` is upserted from `/rpc` and `/acp`.
- `gone{sid, epoch}` deletes `SESS[sid]` only when `epoch` equals the entry's `createdAt`, and records a tombstone `(sid, epoch)`.
- Later upserts carrying a tombstoned `(sid, createdAt)` are ignored.

#### 3.5.4 WebSocket close codes

| Code | Meaning | Frontend |
|---|---|---|
| 1000 | Final: failed open (`error` sent), kill-forget done, or `gone` | no reconnect; keep the card's state |
| 1001 | No frame from the browser for `WS_DEAD` (the web pings every `WS_PING`) | reconnect with backoff |
| 1003 | `/edit` only: a binary frame, or a text frame holding a newline (edwind spec R9.17) | no reconnect; show the error |
| 1008 | Protocol violation (a bad first message or id) or open deadline | no reconnect; show the error |
| 1009 | Message too big | no reconnect; show the error |
| 1011 | Hub connection lost, no hub reply to `open` within 10 s, or "session reloaded"; on `/edit`, edwind closed its end | reconnect with backoff |
| 1012 | wb-web restarting | reconnect with backoff |
| 1013 | Hub unavailable; on `/edit`, no `editSocket` configured or edwind not accepting | wait for `/rpc` `hub{up}`, then reconnect; on `/edit`, the frame runtime's own backoff (edwind spec R7.16) |
| other / abnormal | network | reconnect with backoff: 500 ms doubling to 30 s, equal jitter |

#### 3.5.5 `/api` endpoints (v1)

**Behaviour that applies to every endpoint:**
- Every `/api` response is JSON with `Cache-Control: no-store`. Errors are `{"error":…}`, except the artifact 409 and board 412.
- Body cap: 32 MiB for board, artifact and db PUT and for `POST /api/blob`, 1 MiB elsewhere.
- No mutation uses GET.
- `?token=` and `X-Token` are accepted and ignored.

| Endpoint | Contract |
|---|---|
| `GET /api/info` | `{host, home, edit, mesh, editUp, sample, models, notes, notesExists, state, dist, tmux:false, artifactOrigin:null, agents:[{name,label}], shells:[name], defaultShell, media:[{name, api, models, ops}], hub:{status, version, build, proto, startedAt, stale}}`. `edit` is `true` when `web.json` has `frames: true` and an `editSocket` (frames on, edwind spec R9.20: app.js then renders pages through Edwin frames over `/edit`); `editUp` is whether wb-web's own edwind connection is up right now (not cached). `mesh` is `true` when `web.json` has `api` (§3.8): `/rpc` then carries the observed sessions and the page shows them (F-A47). `shells` and `defaultShell` come from the hub's `hello`. While the hub is not up, `agents` and `shells` are `[]`, `defaultShell` is `null` (as it is when the hub reports an empty one), and `hub` carries `status` alone, plus `proto` for an incompatible hub (`version`, `build`, `startedAt` and `stale` are `null`). `sample`, `models` and `notesExists` come from edwind's `status` command (cached for 5 s); while edwind is not configured or not up they are `false`, `{}` and `false`. `dist` is `null` until the build artefact arrives. Drops `port`, `artifactPort`, `bind`. |
| `GET /api/sessions` | `{host, sessions: Summary+state}`; 503 when the hub is down or incompatible |
| `GET /api/status` | `{host, time, load, mem:{total, available}, uptime, disk:{total, free}, sessions:{alive, tmux:0, byState}, units, edit}`. Each host figure is `null` if it cannot be read, and `sessions` is all `null` while the hub is not up. `units` is all zeros until M5. `edit` is `{up:true, version, build, clients, buffers, journalBytes, imageGen, loopLagP95Ms, ackP95Ms}` from edwind's `status` command, and `null` while edwind is not configured or not up (edwind spec R15.11). |
| `GET /api/pty/{id}/capture?lines=` | `{id, tmux:false, text}`. `lines` defaults to 200 and is clamped to 1..=1000; a non-integer gives 400 "bad query", and an id that sanitises to empty gives 400 "bad id". Hub `not_found` or `kind_mismatch` → 404; hub down → 503; no hub reply within 10 s → 504; any other hub error → 502. |
| `GET /api/board` | body is the board or `null`. `ETag: "<size>-<mtime_ns>-<ino>"`, or `"empty"` when no file exists. |
| `PUT /api/board` | A body that is not valid JSON → 400 `{error:"invalid JSON: …"}`, before any `If-Match` check. `If-Match` required:<br>- missing → 428 `{error:"If-Match required"}`;<br>- anything but exactly one value equal to the current tag → 412 `{error:"board changed elsewhere", etag}`, with the current tag in the body only. Weak tags, `*`, comma lists and repeated headers are compared as plain strings and never match;<br>- `"empty"` with no file → 204;<br>- `"empty"` with a file → 412.<br>On success: 204 with the new ETag, an atomic write, and `board{etag}` on `/rpc`. Check and write happen under one mutex.<br>**Migration guard (edwind spec R8.20), under the same mutex, whatever the flags say:** when the body is an object whose `nodes` is an object keyed by id, every incoming node whose stored version has `buf` keeps that `buf`, and `text` and `anchors` are stripped from every node that ends up with `buf`; the amended body is what is written and what GET returns. Any other body shape (`{"v":0}`, `null`, an array `nodes`) is written as sent. **First `buf` (R8.19):** when a PUT brings `buf` to a node whose stored version had none and `<boardsDir>/<host>.pre-edwind.json` does not exist, the stored board is copied there (0600) before the write; the copy is never overwritten. |
| `GET /api/ls`, `GET /api/stat` | same shapes. A path is `~`, `~/…` or absolute (anything else is 400), with `.` and `..` resolved lexically. `ls` lists directories first, then by lowercased name, at most 2000 entries: `{path, host, entries:[{name, dir, size, mtime, dev, ino, nlink?, mount?, link?}]}`. |
| `GET /api/cat` | `{path, text, size}`. `limit` default 64000, clamped to 1..=8 MiB. Regular files only, opened non-blocking (a FIFO is refused); a NUL in the first 4000 bytes gives `"(binary file)"` as the text. |
| `GET /api/raw?path=` | PDF cards (F-A40). The bytes of a regular file (same path rules and non-blocking open as `cat`) whose first bytes are `%PDF-`; anything else is 400 `{error:"only PDF files are served raw"}`. `application/pdf`, `Accept-Ranges: bytes`, `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`; one `Range: bytes=a-b` (or `a-`, `-n`) answers 206 with `Content-Range`, a range past the end 416 with `Content-Range: bytes */size`, several ranges or a malformed header the whole file. Streamed in 64 KiB chunks, no size cap. |
| `POST /api/media` | Media cards (F-A41). `{provider, model?, op:"imagine"\|"edit", prompt, n? (1–4), size? ("WxH"), image? (a blob hash, required for edit)}` → 200 `{images:[{hash, type, size}]}`, each image stored as by `POST /api/blob`. The provider is one of `web.json`'s `media.providers`; its key file is read per request and sent as a Bearer token. 400 for a bad request (unknown provider or model, empty prompt, a blob not on this server), 502 with the provider's message (at most 400 characters) when it refuses or answers something that is not an image, 503 when the key file cannot be read. Redirects are not followed; a request has 240 s. |
| `POST /api/mv` | `{src, dst}`, both absolute or `~/…`. No-clobber via `renameat2(NOREPLACE)`; `src` is not resolved, and a `dst` that is an existing directory receives the source's base name. **Refuses** with 400 a `dst` in, on or above each entry of `web.json`'s `refusePaths` (the list Nix also writes into `edit.json`, edwind spec R14.8), or without that key `~/.ssh`, `~/.config/systemd` and `~/.local/share/systemd`, as written and with symlinks resolved. The check runs on the path and again on the real path of an `O_PATH` descriptor of the destination's parent, and the rename is made relative to that descriptor, so swapping a path component for a symlink cannot redirect it. Success: `{ok:true, src, dst}`. An existing `dst` → 400 "destination exists"; any other failure (`EROFS`, `EXDEV`, …) → 400 with the OS message. With `editSocket` set the move is edwind's `rename-file` instead (edwind spec R4.49, R6.1), with the paths expanded as above: both ends must be inside edwind's writable paths and out of the refusal list (a source in or above it is refused too), edwind's own directories never move, no-clobber holds by claiming the destination before the rename, and the buffers visiting the file follow it. Success then adds `from` and `to`, the buffer ids of both ends (and `dir: true` for a directory). Refusals stay 400; while edwind is down the answer is 503 and nothing moves. |
| `GET /api/nodes?limit=`, `/api/links`, `/api/cards`, `GET/POST /api/reviews`, `GET /api/tasks`, `GET/POST /api/task/{id}`, `POST /api/journal` (`day` required), `POST /api/notes/append` (`path` and `text` required; `by` defaults to `{kind:"web"}`) | prototype shapes, produced by edwind: each is a `call` over `edit.sock` (`notes-nodes [{limit}]`, `notes-links []`, `notes-cards []`, `notes-reviews []`, `notes-reviews-append [{reviews}]`, `notes-tasks []`, `notes-task [{id}]`, `notes-task-set [{id, kw, set, by:{kind:"frame"}}]`, `notes-journal [{day}]`, `notes-append [{path, text, by}]`) whose `value` is the body. A `result.error` or `error` from edwind maps by code: `bad_request` 400, `no_buffer` 404, `refused_path` 403, anything else 502, with edwind's message; no answer in 10 s is 504. Every one of them is 503 `{error:"edwind is not running"}` while edwind is unreachable (edwind spec R11.8). Without `editSocket` in `web.json` the GET routes keep the empty-`notesDir` stubs and the POST routes are 503. |
| `GET/PUT /api/db/{node}` | The page's document store (M5-W3), `<stateDir>/artifacts/<node>/db.json`. GET is the stored object, `{}` for a node that never wrote one. PUT takes a JSON object (else 400) and answers 204; the frontend PUTs `{docs}` 400 ms after a write and also keeps it in the board node, and a node whose board copy has no docs takes the server's on mount. A `node` that is not `[A-Za-z0-9_-]{1,64}` is 400 "bad id". |
| `GET /api/proc`, `GET /api/units`, `GET /api/unit/{n}` | Read only (M5-W3). `proc`: `{host, procs:[{pid, ppid, comm, state, cwd, cmd, start, rss, unit, node?}]}` from `/proc` (at most 4000, by pid): `start` in epoch seconds, `rss` in bytes, `cwd` `null` where it cannot be read, `unit` the innermost `.service`/`.scope` of the v2 cgroup path, `node` the card whose live PTY session has that pid. `units`: `{host, units:[{unit, load, active, sub, description}], error}` from `systemctl list-units --output=json` on the service's `PATH` (no shell), reused for 10 s; `error` is the reason when it fails, with `units:[]`. `unit/{n}`: `{unit, props, status, error, procs}`, `status` from `systemctl status --full --lines=30 -- N`, `props` from `systemctl show`, `procs` the unit's processes. A name with characters systemd does not allow, or a leading `-` or `.`, never reaches `systemctl`: `error:"bad unit name"`. Each `systemctl` call is cut at 5 s. `/api/status.units` counts the same listing (`total`, `active`, `failed`, `failedNames`, plus `error`). |
| `GET/PUT /api/artifact/{node}` | srcdoc versions (M5-W3), in `<stateDir>/artifacts/<node>/`: `meta.json` `{head, versions:[{sha, at}], capabilities}` and `v/<sha>.json`, the content `{kind:"page", html}` or `{kind:"files", files:{path:{text}}}`. A version's `sha` is the first 16 hex digits of the sha256 of its content's JSON; `at` is UTC `YYYY-MM-DDTHH:MM:SS`. GET is `{meta, content, url:null}` for the head, or for `?v=SHA` (unknown → 404); no artifact is `{meta:{head:null, versions:[], capabilities:{}}, content:null, url:null}`. PUT `{html?, files?, capabilities?, ifMatch?}`: `html` is a page; `files` patches the head (a page counts as its `index.html`; a string or `{text}` sets a file, `null` or `{delete:true}` removes it; a path is relative, without empty, `.` or `..` segments, at most 256 bytes); `capabilities` alone changes no version and needs a head. An `ifMatch` that is present (`null` meaning none) and is not the head → 409 `{error:{code:'conflict', message, head}}`; without `ifMatch` the PUT is unconditional (`wb`, agents). Content equal to the head is `changed:false`; a version published again moves to the end. 200 `{version, changed, meta, url:null}`. The last 30 versions are kept, older files removed. Check and write happen under one lock. `url` is always `null`: there is no artifact origin, the frontend runs the head in an opaque `srcdoc` frame (fix 6); for a files artifact each quoted relative `src`/`href` that names one of its files becomes a `data:` URL of it. |
| `POST /api/blob` | Images (F-A32) and PDFs (F-A40) on the canvas. The body is the raw bytes of one image or PDF; its first bytes must say PNG, JPEG, GIF, WebP, AVIF or `%PDF-` (the request's `Content-Type` is not read), else 415 `{error:"not an image or a PDF: PNG, JPEG, GIF, WebP, AVIF or PDF"}`; an empty body is 400. The bytes are written once (0600, atomic) to `<stateDir>/blobs/<sha256 hex>`; the same bytes again write nothing. 200 `{hash, type, size}`. |
| `POST /api/unit/{n}/{start,stop,restart}` | 403 "unit control is disabled in Workbench; use ssh" |
| `/api/tmux*`, `/api/hosts`, `POST /api/cmd`, `/api/backlinks`, `POST /api/index/rescan`, `POST /api/tasks`, `POST /api/task/{id}/dispatch`, `DELETE /api/artifact/{n}`, `GET /api/journal`, `/mcp` | 404 |
| `OPTIONS`, wrong methods | 405, no CORS headers |

**Without edwind:** the notes, task and review endpoints answer 503 `{error}` when `web.json` has no `editSocket`, as they do while edwind is down, and `/api/info` reports `notesExists:false, sample:false`. (Until 2026-11-11 they answered the shapes of an empty `notesDir` then; every deploy runs edwind.)

**Images:** `GET /blob/{hash}` (outside `/api`) serves `<stateDir>/blobs/{hash}` when `hash` is 64 lowercase hex digits and the file's first bytes are one of the five image types or a PDF (then with `Content-Disposition: attachment`), with that type, `Cache-Control: private, max-age=31536000, immutable`, `ETag: "<hash>"` and `Content-Security-Policy: default-src 'none'; sandbox`; anything else is 404. Nothing deletes a blob: an image card removed, cut or undone may still be named by another board, a copy on the clipboard or a backup, so the files stay (a sweep against every board is future work).

**Static files:** `/`, `index.html`, `app.js`, `style.css`, `bridge.js`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `vendor/*`, `fonts/*`, and the Edwin console and frame runtime under `edwin/` (`edwin/index.html`, `edwin/src/*.js`, `edwin/scm/*.scm`, copied by `nix/web.nix`; edwind spec R9.19).
- They sit behind the same floor and are served from memory with sha256 ETags and `Cache-Control: no-cache`.
- Every directory that holds an `index.html` is served at `<dir>/` as well (`/` and `/edwin/`); `<dir>` without the slash and a directory without an index are 404.
- MIME types include `woff2 → font/woff2`, `woff → font/woff`, `ttf → font/ttf`, `otf → font/otf` and `scm → text/plain` (the frame runtime fetches the Scheme sources).

**Security headers on every response:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and on HTML `Content-Security-Policy: object-src 'none'; base-uri 'none'`.

### 3.6 Auth floor (wb-web TCP listener; every request and upgrade, static files and 404s included)

The middleware is added last, so it wraps every route and the fallback. Checks run in this order, and any failure is 403 `{"error":"forbidden"}` with the reason logged:
1. **Source:** the TCP peer IP (`to_canonical()`) equals `trustedProxy`. `X-Forwarded-For` is never read.
2. **Target:** the request target is origin-form.
3. **Secret:** there is exactly one `X-Workbench-Proxy-Secret` header, it is 64 lowercase hex characters, and it matches by `subtle::ConstantTimeEq`.
4. **Host:** exactly one `Host`, equal to the authority of `publicOrigin`.
5. **Origin:**
   - required on any request with an `Upgrade` header and on every method other than GET/HEAD, and must equal `publicOrigin`;
   - optional on GET/HEAD, but must match when present.

Only after the floor passes can a request get 404 (unknown upgrade path; only `/pty`, `/acp`, `/rpc` and `/edit` upgrade) or 405.

**Secret file:** `proxySecretFile`, 0400, delivered through `LoadCredential`, read once at startup. A missing file or bad format, or a missing `trustedProxy`/`publicOrigin`/`listen`, makes the web exit non-zero before listening.

**Caddy:** `header_up X-Workbench-Proxy-Secret {env.CADDY_UPSTREAM_SECRET_WORKBENCH}` sets the header, overwriting any client value. Never use `{$VAR}`, which is adapt-time and leaks into `GET /config/`.

**No test bypass.** Tests run Caddy as the proxy with `trustedProxy=127.0.0.1`.

### 3.7 Configuration, child environment, `wb` discovery

#### 3.7.1 `/etc/workbench/web.json` (`deny_unknown_fields`)
```json
{
  "listen": "198.51.100.2:8090",
  "publicOrigin": "https://wb.example.org",
  "trustedProxy": "198.51.100.1",
  "proxySecretFile": "/run/credentials/workbench-web.service/proxy-secret",
  "socket": "/run/workbench-web/web.sock",
  "hubSocket": "/run/workbench-hub/hub.sock",
  "stateDir": "/home/alice/.local/state/workbench/web",
  "webRoot": "/nix/store/…-workbench-web",
  "boardsDir": "/home/alice/work/boards",
  "notesDir": "/home/alice/work/notes",
  "host": "devbox",
  "attachCommand": "/run/current-system/sw/bin/attach-agent",
  "editSocket": "/run/edwind/edit.sock",
  "edwinWebRoot": "/nix/store/…-edwin-web",
  "refusePaths": ["/home/alice/.ssh", "/home/alice/.config/systemd", "/home/alice/.local/share/systemd"],
  "media": { "providers": { "openai": { "api": "openai", "baseUrl": "https://api.openai.com/v1", "keyFile": "/run/credentials/workbench-web.service/media-openai", "models": ["gpt-image-1"] } } }
}
```
- `listen`, `publicOrigin`, `trustedProxy`, `proxySecretFile`, `stateDir`, `webRoot`, `boardsDir`, `notesDir` and `host` are required. `socket` and `hubSocket` default to the values shown.
- **Validation** refuses to start the web when:
  - any path is not absolute, or `socket` or `hubSocket` is 108 bytes or longer;
  - `host` does not match `[A-Za-z0-9][A-Za-z0-9._-]*` (it names the board file);
  - `publicOrigin` is not `scheme://host[:port]` with an http or https scheme, no path, query or user, and no default port (browsers never send it);
  - `editSocket` is present and not absolute, or 108 bytes or longer;
  - `edwinWebRoot` is present and not absolute, or it is present and `webRoot` has an `edwin/` of its own;
  - a `refusePaths` entry is neither absolute nor `~` or `~/…`;
  - `attachCommand` is present, non-null and does not match `^/[A-Za-z0-9._/+-]+$`.
- `editSocket` absent or `null` means no edwind: the notes endpoints stay stubs, `sample` stays off and `/edit` closes with 1013 (edwind spec R15.5). With it, wb-web keeps one connection to edwind open (`kind: "web"`, reconnecting with backoff) for the notes endpoints, `sample`, `/api/status`'s `edit` block and `/api/info`'s `editUp`, and opens one more per `/edit` WebSocket (§3.3.1).
- `edwinWebRoot` (optional; Nix writes `services.workbench.edit.webRoot`) is edwin-web, loaded like `webRoot` and served under `/edwin/`: the console page, the frame runtime and its Scheme. It is the edwin-web of the Edwin whose edwind is on `editSocket`, so frames and daemon come from one build; `workbench-web` carries no Edwin of its own.
- There is no `frames` key (gone with F-A39, edwind spec R9.21), and an old `web.json` that has one is refused as an unknown key: `/api/info` reports `edit: true` whenever `editSocket` is set, and `/edit` relays whenever it is set.
- `media` (optional; Nix writes `services.workbench.media.providers`, the key files as `LoadCredential`) names the image providers of media cards (F-A41). Each provider has `api` (`openai`: the OpenAI image API, `/images/generations` and `/images/edits`, which xAI, LocalAI and other compatible servers speak; `huggingface`: Inference API, `POST /models/<model>`), `baseUrl` (https, or http to a loopback address), optional absolute `keyFile` and a non-empty `models` list; names match `[A-Za-z0-9_-]+`. Keys never leave the server; `/api/info` lists names, protocols and models only.
- `api` (optional; Nix writes `services.workbench.api`, the token files as `LoadCredential`) is the mesh API's listener and clients: §3.8.1. A wb-web that predates it refuses the key as unknown, so a host gets the new binary before the new config.
- `attachCommand` (optional, absent or `null` disables it; Nix writes `services.workbench.attachCommand`, a null-or-path option) opens an observed agent's existing terminal (§3.8.3). `/api/info` exposes only `attach: boolean`, never the command path.
- `refusePaths` is the destination list `POST /api/mv` refuses, written by Nix from the list edwind refuses too (edwind spec R14.8); absent means the built-in three.
- There is no `sample` key: the model backend and its key file are edwind's (`services.edwind.models`, edwind spec R15.6). A config that still carries `sample` fails to load, as any unknown key does.
- Subprocesses the web runs (`systemctl show`) get `env_clear()` plus `PATH`, `HOME` and `LANG`.
- The web never spawns long-lived children.
- There is **no `tmuxSocket`**.

#### 3.7.2 `/etc/workbench/hub.json` (read at startup only; the hub never re-reads it)
```json
{
  "socket": "/run/workbench-hub/hub.sock",
  "stateDir": "/home/alice/.local/state/workbench/hub",
  "host": "devbox",
  "shells": [
    {"name": "bash", "paths": ["/etc/profiles/per-user/alice/bin/bash", "/run/current-system/sw/bin/bash"], "args": ["-i"]},
    {"name": "fish", "paths": ["/etc/profiles/per-user/alice/bin/fish", "/run/current-system/sw/bin/fish"], "args": ["-i"]},
    {"name": "nu",   "paths": ["/etc/profiles/per-user/alice/bin/nu",   "/run/current-system/sw/bin/nu"],   "args": ["-i"]},
    {"name": "zsh",  "paths": ["/etc/profiles/per-user/alice/bin/zsh",  "/run/current-system/sw/bin/zsh"],  "args": ["-i"]}
  ],
  "defaultShell": "bash",
  "child": {
    "passEnv": ["EDITOR","LANG","PAGER"],
    "setEnv": {
      "__NIXOS_SET_ENVIRONMENT_DONE": "1",
      "PATH": "/run/wrappers/bin:/home/alice/.nix-profile/bin:/home/alice/.local/state/nix/profile/bin:/etc/profiles/per-user/alice/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin",
      "NIX_PROFILES": "/run/current-system/sw /nix/var/nix/profiles/default /etc/profiles/per-user/alice /home/alice/.local/state/nix/profile /home/alice/.nix-profile",
      "TERMINFO_DIRS": "/home/alice/.nix-profile/share/terminfo:/home/alice/.local/state/nix/profile/share/terminfo:/etc/profiles/per-user/alice/share/terminfo:/nix/var/nix/profiles/default/share/terminfo:/run/current-system/sw/share/terminfo",
      "XDG_CONFIG_DIRS": "/etc/xdg:/home/alice/.nix-profile/etc/xdg:/home/alice/.local/state/nix/profile/etc/xdg:/etc/profiles/per-user/alice/etc/xdg:/nix/var/nix/profiles/default/etc/xdg:/run/current-system/sw/etc/xdg",
      "XDG_DATA_DIRS": "/home/alice/.nix-profile/share:/home/alice/.local/state/nix/profile/share:/etc/profiles/per-user/alice/share:/nix/var/nix/profiles/default/share:/run/current-system/sw/share",
      "LOCALE_ARCHIVE": "/run/current-system/sw/lib/locale/locale-archive",
      "TZDIR": "/etc/zoneinfo",
      "NIX_PATH": "nixpkgs=/nix/var/nix/profiles/per-user/root/channels/nixos",
      "WB_SOCKET": "/run/workbench-web/web.sock"
    }
  },
  "agents": {
    "claude": {"label": "Claude",   "argv": ["/etc/workbench/agents/claude/bin/claude-agent-acp"], "env": {}},
    "codex":  {"label": "Codex",    "argv": ["/etc/workbench/agents/codex/bin/codex-acp"], "env": {"RUST_LOG": "error"}},
    "omp":    {"label": "oh-my-pi", "argv": ["/etc/profiles/per-user/alice/bin/omp", "acp"], "env": {}}
  }
}
```
- **Shells.** `shells` is an ordered list of `{name, paths, args}`, and `defaultShell` names the default (`"bash"`). For each spawn the hub uses the first entry of `paths` that is an executable regular file, re-checked at every spawn. `args` start the shell interactive when a spawn's `argv` has a single item (§3.2.7). There is no single-shell key.
- **Stable paths only.** No `/nix/store` path for anything the hub execs, shells included. The module writes `/etc/workbench/agents/<name>` → package. It links `/etc/workbench/bin/wb` and appends that directory to `PATH` once `wb` ships (M4).
- **Every shell is interactive and non-login.** The env scrub of §3.7.3 plus `__NIXOS_SET_ENVIRONMENT_DONE=1` applies unchanged to all of them. NixOS's `/etc/profile` and zshenv honour that guard, and plain nushell never reads set-environment.
- **`XDG_RUNTIME_DIR` is not set.** `/run/user` is inaccessible to the hub unit.
- **Hub unit environment:** the unit sets `LANG` (the system's default locale) and every variable of the module's `environment` option by value, and `child.passEnv` names exactly these. Everything else a login would provide is literal in `child.setEnv`, built from stable paths (`LOCALE_ARCHIVE=/run/current-system/sw/lib/locale/locale-archive`, `TZDIR=/etc/zoneinfo`, the profile lists). The unit never sources `/etc/set-environment` or `/etc/profile`.
- **Required keys:** `stateDir`, `host`, `shells`, `defaultShell` and `child`. `socket` defaults to the value shown, and `agents` to empty. Unknown keys are refused at every level (`deny_unknown_fields`).
- **Validation** refuses to start the hub when:
  - `socket` is not absolute or is 108 bytes or longer, or `stateDir` is not absolute;
  - `worktreeRoot`, when set, is not absolute, contains NUL, or has a component named `.`, `..` or `.git`;
  - a shell name does not match `^[a-z0-9-]{1,32}$` or is listed twice, a shell's `paths` is empty or holds a relative path, or its `args` contain NUL;
  - `defaultShell` is not in `shells`;
  - an environment variable name (in `passEnv`, `setEnv` or an agent's `env`) does not match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`;
  - `passEnv` or `setEnv` names a variable the hub sets itself: `HOME`, `USER`, `LOGNAME`, `SHELL`, `WB_SESSION`, `TERM` or `COLORTERM`;
  - an agent name does not match `^[a-z0-9-]{1,32}$`, or an agent's `argv[0]` is not absolute.

  The hub also refuses to start without `HOME`, `USER` and `LOGNAME` in its environment.
- **`hosts`** (optional; Nix writes `services.workbench.hosts`) names the other hosts the hub starts agents on: §3.8.5. Absent, `hub.json` is byte for byte what it was, so adding the option restarts no hub.
- **`git`** (optional) is the absolute path to the executable used only for managed local ACP worktrees.
  `services.workbench.gitPackage` defaults to `pkgs.git`; the module links its executable at `/etc/workbench/bin/git` and writes that stable path in `hub.json`.
  Set the option to `null` to omit `git` and disable the capability.
  The hub executes argv directly with no stdin, disables hooks with `-c core.hooksPath=/dev/null`, uses an end-of-options marker before request-derived operands, and bounds command output and runtime.
  Its cleared git environment carries only the hub's own `HOME`, `XDG_CONFIG_HOME` and `PATH` if set, plus `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`.
  This is not confinement: the agent retains its ordinary filesystem access, and git uses repository and user configuration, including filters that run on checkout.
  A checkout filter must be resolvable on that `PATH` or named by absolute path; a required filter that cannot run fails the request.
- **`worktreeRoot`** (optional) sets the directory under which the hub mirrors each main checkout's absolute path for new managed worktrees (§3.2.7).
  `services.workbench.worktreeRoot` defaults to `null`, so the module omits the key and the hub keeps the sibling layout.
  The hub user needs write access; a root inside a checkout is allowed, but the destination must be outside the repository's common git directory.
  With `worktreeRoot` set to `/`, the worktree is placed directly in the main checkout at `<main-root>/<flattened-branch>`; an occupied name returns 409.
  Use a root outside any checkout or ignore it in the containing checkout to keep it out of `git status`.
- **Test configs:** take the shell path from `$BASH`, because the sandbox has no `/run/current-system`. The harness also configures `sh` as a second shell (§7, N-6).

#### 3.7.3 Child environment (built from scratch)
1. **Fixed:**
   - `HOME`, `USER`, `LOGNAME` from the hub's environment;
   - `SHELL`: for PTYs, the chosen shell's resolved path; for ACP agents, the resolved path of the configured shell named `bash`, because agent tool runners expect a POSIX shell;
   - `WB_SESSION=<sid>`;
   - PTYs also get `TERM=xterm-256color` and `COLORTERM=truecolor`.
2. `child.passEnv`, copied from the hub's own environment.
3. `child.setEnv`, which overrides step 2.
4. ACP only: `agents.<name>.env`, which overrides steps 2 and 3.
5. PTY only: the client `env` from `SpawnPty`. It cannot override anything the hub sets, and it is only ever present on an explicit spawn.

The fixed variables always win. The config refuses them in `passEnv` and `setEnv`, and for an ACP agent they are applied last, over `agents.<name>.env`. A client `env` never replaces any variable the hub has set.

Nothing else is inherited: no `NOTIFY_SOCKET`, `INVOCATION_ID`, `JOURNAL_STREAM`, `CREDENTIALS_DIRECTORY`, `LISTEN_*` or `XDG_RUNTIME_DIR`. The hub unit holds no secrets.

**Host caveat (NixOS).** `/etc/set-environment` can export secrets, such as API keys, to every shell that sources it. NixOS's `/etc/bashrc` sources `/etc/profile` even for non-login shells, so the protection is `__NIXOS_SET_ENVIRONMENT_DONE=1` in `child.setEnv`, which makes `/etc/profile` skip set-environment (VM step 5 proves it). Child shells still run the rest of the system's profile init (`environment.shellInit`, `interactiveShellInit`, `programs.bash.*`); only set-environment is skipped. The module's option description documents this. Shells stay interactive non-login.

#### 3.7.4 `wb` discovery
- **Socket:** `--socket`, then `$WB_SOCKET`, then `/run/workbench-web/web.sock`.
- **Protocol:** one `hello` and one `cmd` per invocation. `--url` and `--token` are usage errors.
- **Exit codes:** 0 ok, 1 err, 2 usage, 7 no page (`no_page`; edwind spec §13.1).
- **Messages:** `wb: cannot reach wb-web at <path> (<errno>)` and `wb: no Workbench page is open`.
- **Commands:** there are no commands for `hosts`, `host`, `unit start|stop|restart`, `tmux` or `adopt`, and `create_node` does not accept `kind=agent`.
- **Desks** (§10.8 D3): `wb desk ls`, `wb desk go N` and `wb desk send N [PATH]... [--keep] [--follow]` are the tools `list_desks`, `go_to_desk` and `send_to_desk`, sent as one `cmd` like `wb TOOL`; N is one digit 0-9. `wb desk query [N] WORD...` is `query_desk` (F-A38): the words, joined with spaces, are the query, and a lone digit 1-8 first is the desk.
- **Open a file** (F-A27, F-A39): `open_file {file, line?}` opens a host file as an Edwin page card in the leader tab, or focuses its existing card. `file` is absolute or uses `~` for the home directory. An explicit `line` is a positive integer, clamped to the last line; omitting it leaves point where a click would. The result is `{file, line}` with the supplied path and the effective line. The tool uses the click opener and returns its refusals as tool errors. Call it with `wb open_file --json '{"file":"~/notes.md","line":12}'`.

### 3.8 The mesh: API, observed sessions, remote hosts

**Decisions (the owner, 2026-11-16 and 2026-11-17).**
- Workbench is the place to see and steer every coding-agent session on a private mesh of hosts. There is one hub, on one host.
- Every agent on every host is configured to report to that hub while it works, however it was started.
- The hub's capability is offered as an HTTP API on the mesh, so that other interfaces (an orchestrating agent, an editor, a script) can be built on it. Which client may do what is a matter of its token.
- The hub can start agents on the other hosts of the mesh.

Three parts follow from that, and each stands alone: the API listener (§3.8.1, §3.8.2), the registry of observed sessions that the reports feed (§3.8.3, §3.8.4), and remote hosts in the hub (§3.8.5).

**In the page** (F-A47, F-A48). Agents is an always-available main view, next to Canvas, with one list and a detail pane for the hub's sessions and, when `api` is configured, the observed sessions. It shares the existing ACP and PTY backends without creating canvas cards: hub agents can be prompted here; reachable terminals can be viewed and typed into. An observed session outside the hub is read-only unless its validated `attach` capability and the server's `attachCommand` allow opening its existing terminal (§3.8.3). Otherwise the pane explains why it is read-only and how to enable attachment. The status line, Attention list and graph retain the mesh overview. Merely viewing, deselecting or closing a session this page did not start never kills it; an explicit kill is a separate, confirmed action.

**Not yet, in the canvas.** It knows nothing of remote hosts: it starts agents on the hub's host only, and a card adopted for a session on another host shows and steers that session, but "Start new session" and a branch from it send `agent` and `cwd` without a host, so they start a local agent, or fail when that agent or directory is not on the hub's host. Until the canvas carries the host, sessions on other hosts are started, and started again, through the API.

#### 3.8.1 The API listener (wb-web)

`web.json` takes an optional `api` object. Without it nothing of §3.8.1 to §3.8.4 exists: no listener, no registry.

```json
"api": {
  "listen": "198.51.100.2:8091",
  "clients": {
    "devbox-agents": {"tokenFile": "/run/credentials/workbench-web.service/api-devbox-agents", "scopes": ["events"], "host": "devbox", "address": "198.51.100.2"},
    "laptop-agents": {"tokenFile": "/run/credentials/workbench-web.service/api-laptop-agents", "scopes": ["events"], "host": "laptop", "address": "198.51.100.7"},
    "owner":         {"tokenFile": "/run/credentials/workbench-web.service/api-owner", "scopes": ["read", "control"]}
  }
}
```

- **The listener** is a second TCP listener of wb-web, apart from the browser's: the auth floor of §3.6 does not apply to it, and it serves nothing but `/v1`. It speaks plain HTTP/1.1 and is meant for an address on the mesh interface, whose transport encrypts and authenticates the peer's address. It holds at most `API_CONNS_MAX` connections, an event stream being one; a further connection waits to be accepted. So a peer that leaves connections idle can hold up the API, and not the browser's listener or the hub connections.
- **A client** has a name, a token, a set of scopes, and optionally a `host` and an `address`.
  - `scopes` is a non-empty subset of `events` (send session events), `read` (every `GET`) and `control` (start, prompt, configure, answer and end sessions).
  - `host` is the host name this client's events are filed under. It is required with the `events` scope and comes from nowhere else: a host named inside a request is ignored.
  - `address`, when present, is the only peer address the token is accepted from.
  - The token file holds 64 lowercase hex characters; trailing whitespace is ignored. It is read at startup.
- **Validation** refuses to start the web when `api.listen` is a wildcard address or equals `listen`; a client name does not match `^[a-z0-9-]{1,32}$`; `clients` is empty; a `tokenFile` is not absolute, unreadable or malformed; two clients hold the same token; `scopes` is empty or names an unknown scope; `events` is listed without `host`; or `host` does not match the rule of the top-level `host`. Errors never include a token.
- **Every request** is checked in this order, before the path is looked at:
  1. Exactly one `Authorization` header, of the form `Bearer <token>`. The token is compared with every client's in constant time, without stopping at a match.
  2. When the matched client has an `address`, the peer's address (an IPv4-mapped one as IPv4) must equal it.

  A request that fails either gets 401 `{"error":"unauthorized"}` with `WWW-Authenticate: Bearer`; the two are not told apart. `X-Forwarded-For` is never read.
  3. The route's scope must be among the client's, else 403 `{"error":"forbidden"}`. An unknown path is 404 and a wrong method 405, both only after steps 1 and 2.
- A refusal is logged with the peer's address, the method and the path without its query; no header value is logged. After `REFUSALS_LOGGED` in one minute, one line says that the rest of that minute's are not logged.
- Every response is JSON with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, except the event stream (`text/event-stream`). There are no CORS headers. A request body is at most `API_BODY_MAX`; a larger one is 413.
- Errors are `{"error": message}`. An error the hub gave also carries the hub's `code`: `{"error": message, "code": "busy"}`.

**Hub errors as statuses:** `bad_request`, `bad_option`, `unknown_agent` → 400; `not_found` → 404; `kind_mismatch`, `busy`, `conflict`, `not_alive`, `already_resolved`, `stale`, `not_revivable`, `faulted` → 409; `timeout` → 504; anything else → 502.
The hub down or incompatible is 503; no reply within 10 s (40 s for `mode` and `config`, which wait for the agent) is 504.
A create with non-empty config instead allows `40 s × (1 + number of options)` for its delayed hub open reply (§3.8.2); worktree creation and removal also allow for the applicable git deadlines.

#### 3.8.2 `/v1` endpoints

A sid in a path that does not match `^[A-Za-z0-9_-]{1,64}$` is 400 "bad id". Requests that reach the hub use a hub connection of their own for the one request, except those the control connection already answers.

| Endpoint | Scope | Contract |
|---|---|---|
| `GET /v1/info` | read | `{host, version, hub:{status, version, build, proto, startedAt, stale}, agents:[{name,label}], hosts:[{name, agents:[{name,label}]}]}`. `hub` as in `/api/info`; `agents` and `hosts` are `[]` while the hub is not up. |
| `GET /v1/sessions` | read | `{host, sessions:[Summary+state]}`, the hub's sessions as in `/api/sessions`; 503 when the hub is down or incompatible. |
| `GET /v1/sessions/{sid}` | read | One `Summary+state`; 404 for a sid the hub does not know. |
| `GET /v1/sessions/{sid}/events?since=N` | read | An ACP session's journal after seq `N` (default 0): `{sid, epoch, head, from, reset, truncated, events:[JournalEvent]}`. It is `acp.open` without `spawn`, read up to `acp.replayed`, then the connection is closed; nothing runs. An event of a kind this version does not know is left out, as `/acp` leaves it out. `since` that is not an integer is 400 "bad query". |
| `GET /v1/sessions/{sid}/capture?lines=N` | read | A PTY session's text, `{sid, text}`: the last `N` lines (default 200, clamped to 1..=`CAPTURE_MAX`). A sid that is not a PTY is the hub's error under the status map of §3.8.1. |
| `GET /v1/observed` | read | `{sessions:[ObservedSession]}` (§3.8.3), live first, then by `lastAt`, newest first. |
| `GET /v1/observed/{id}` | read | One `ObservedSession` by its `id`; 404. |
| `GET /v1/stream` | read | Server-sent events (§3.8.4). |
| `POST /v1/sessions` | control | Starts an ACP agent. Body `{agent, cwd, host?, sid?, config?: {optionId: string\|boolean}, task?: string, policy?: Policy, worktree?: {branch, base?}}`. `sid` defaults to `api_` and 16 random hex digits. `host` absent, or the hub's own, starts it on the hub's host; another name must be one of the hub's `hosts` as its hello lists them, else 400 "no host H" (so a hub that predates §3.8.5 is never asked). 201 `{sid, session: Summary+state, configErrors:[{id, value, code, error}]}`; configuration and worktree rules below. A sid that an agent session has is 409 "session exists", and one that a shell has is 409 with the hub's `kind_mismatch`; that session is left as it is. Policy validation, including all regex compilation and limits, precedes spawn; invalid policy is 400 "bad body". |
| `POST /v1/sessions/{sid}/prompt` | control | Body `{text, epoch?}` or `{blocks:[ContentBlock], epoch?}`, exactly one of `text` and `blocks`; `text` becomes one text block. `acp.prompt`. 200 `{}`. |
| `POST /v1/sessions/{sid}/cancel` | control | `acp.cancel` without an incarnation precondition. 200 `{}`. |
| `POST /v1/sessions/{sid}/epochs/{epoch}/cancel` | control | `acp.cancel` only for the named incarnation. 200 `{}`. |
| `POST /v1/sessions/{sid}/permission` | control | Body `{req, epoch, outcome}`: `acp.permission`. 200 `{}`. |
| `POST /v1/sessions/{sid}/elicitation` | control | Body `{req, epoch, response}`: `acp.elicitation`. 200 `{}`. |
| `POST /v1/sessions/{sid}/mode` | control | Body `{modeId, epoch?}`: `acp.set_mode`. 200 `{}`. |
| `POST /v1/sessions/{sid}/config` | control | Body `{id, value: string\|boolean, epoch?}`: `acp.set_config_option` with the supplied epoch, or the current cached `Summary.createdAt` if omitted. 200 `{}` only after the agent result is journaled; hub timeout 30 s, API reply wait 40 s. |
| `POST /v1/sessions/{sid}/task` | control | Body `{"task": string\|null}`, with the member required. Sends `acp.set_task`; 200 `{}` after the replacement or clear is journaled. |
| `POST /v1/sessions/{sid}/policy` | control | Body `{policy: Policy}`: `acp.set_policy{sid, epoch: current Summary.createdAt, policy}`. No request-body epoch is accepted. 200 `{}` after journaling; `{policy:{rules:[]}}` removes it. Strict unknown-field/shape/limit/regex validation gives 400 "bad body". Read via session details' `acp.policy`; pending requests remain unchanged. |
| `POST /v1/sessions/{sid}/revive` | control | `acp.revive`. 200 `{}`. |
| `DELETE /v1/sessions/{sid}?forget=true\|false` | control | `acp.kill` or `pty.kill` by the session's kind, without an incarnation precondition; `forget` defaults to `false`. 200 `{}`; 404 for an unknown sid. |
| `DELETE /v1/sessions/{sid}/epochs/{epoch}?forget=true\|false` | control | `session.kill` only for the named incarnation, independent of the web's watch cache; `forget` defaults to `false`. 200 `{}`; 404 for an unknown sid. |
| `DELETE /v1/sessions/{sid}/worktree` | control | `acp.remove_worktree`; 200 `{}` after deletion, 409 while the agent runs, a worktree operation is in progress or git refuses non-forced removal, 404 for an unknown sid or absent record. A missing or replaced checkout gives a distinct 404 after clearing the record (§3.2.7). |
| `POST /v1/events` | events | One session event (§3.8.3). 204. |

A body that is not the JSON the endpoint takes, an unknown key included, is 400 "bad body".
A sid the control connection has not heard of is 404 "no session S" for `GET /v1/sessions/{sid}`, `POST /v1/sessions/{sid}/config` without a caller-supplied epoch, and `POST /v1/sessions/{sid}/policy`; DELETE asks the hub because a sid may have a creation in progress before its first Summary.
The other endpoints ask the hub and answer with its error.
The API starts no PTY and sends no PTY input: a shell on the mesh is what ssh is for.

**Binding an action to the session the client saw.**
Pass the observed `createdAt` as `epoch` (unsigned integer); a mismatch is HTTP 409 with `code:"stale"`, and nothing is sent to or changed in the replacement session.
If a guarded action's own connection to the hub does not advertise `sessionActionEpoch:true`, the API returns 400 without forwarding the request.
Omission retains the old behavior and does not require a hub upgrade.
For guarded cancel and DELETE, use the `/epochs/{epoch}` paths: a previous web router returns 404 rather than matching the unguarded route.
Never pass `?epoch=` on the unguarded paths: this web rejects it, but older web versions can ignore it and perform the action.
For permission and elicitation answers, the already-required `epoch` and `req` identify the published question.
A later answer for a resolved or withdrawn question in that incarnation and journal history is HTTP 409 `already_resolved`, even if there is a new pending question of the same kind.

**Configuration on create.** `config`, when present, is a JSON object with at most **16 distinct option ids**, each value a string or boolean. A non-object, another value type, duplicate id or a seventeenth option is 400 "bad body", before any spawn. The web retains the input object's member order and passes it as the hub's ordered `SpawnAcp.config` array `[{id, value}]`; it does not wait for setup events and issue its own configuration RPCs. With no config or `{}`, create keeps its immediate post-open behaviour and does not wait for ACP setup. With non-empty config, the hub delays the initiating `acp.open` reply until setup and the ordered batch end or terminate (§3.4.5), blocking prompts and the other listed live actions from every client in the meantime. The API waits up to `40 s × (1 + number of options)` for that reply, then returns its resulting session and opener `configErrors` verbatim. This outer HTTP wait is not a total setup timeout: the hub still uses `SETUP_IDLE_TIMEOUT`, which can be extended by agent messages or paused for pending requests. Individual configuration failures and setup failure do not turn accepted creation into a failed start: the response remains 201, with every unapplied option accounted for and `configErrors:[]` when all succeeded. Later option validation uses the latest authoritative full list. Create never sends a prompt, with or without configuration.

Non-empty `config` requires `acpConfig:true` in the connected hub's hello. Otherwise creation is 400 "hub does not support session configuration", before any open or spawn is sent; a missing capability on an older hub is not success. Missing config or `{}` keeps the old behaviour.

**Worktree on create.** `worktree` accepts only a required `branch` string and an optional `base` string (§3.2.7); there is no path argument.
The hub chooses the destination at creation: for main checkout `/home/u/proj/app` and branch `feat/x`, the default is `/home/u/proj/app-wt/feat-x`; with `worktreeRoot` set to `/srv/wt` it is `/srv/wt/home/u/proj/app/feat-x`.
A remote `host`, an invalid name, a `cwd` outside a checkout, in a bare repository or in a submodule, or a hub that does not advertise `acpWorktree:true` is 400.
On success the returned session has the new `cwd` and `acp.managedWorktree`.
Changing or unsetting the hub's root does not move existing worktrees or change which checkout a session's removal request can delete.
Removal refuses modified files and non-ignored untracked files, but deletes **everything git ignores**, including local configuration such as `.env` and ignored nested repositories with their unpushed commits.
A killed removal can leave tracked files partially deleted; the record stays, and retrying may refuse until the operator inspects and restores the checkout.
The branch is never deleted.
Killing or forgetting an accepted session never removes its worktree: forgetting discards the record and leaves the checkout on disk.
Revive uses the recorded local `cwd`, even after removal; it now refuses with 409 `not_revivable` if that directory no longer exists, rather than attempting to start the agent there.

**Task reference.** Both endpoints validate the reference as for `SpawnAcp.task` (§3.2.7). Creating with a non-empty normalized task, or setting or clearing a task later, requires `acpTask:true` on the connection that would send the request; otherwise the API returns 400 without forwarding it. The task, when present, is returned in `session.acp.task` on create and in `acp.task` in session summaries.

**Policy on create and replacement.** Both endpoints use the same `Policy` from §3.4.5, including roots and optional execute-only `programs`/`command` conditions; rules carrying either do not match read/edit, so use separate rules. Regexes compare raw and canonical command texts with action-dependent conservative precedence; canonical words precede each simple command's redirections. Absent conditions are unrestricted; explicit `null`, invalid entries, unknown fields, policies over 256 KiB serialized, roots over 4096 bytes and regexes exceeding the 64 KiB compiled-size limit are rejected before installation/spawn. Oversized-pattern errors recommend ASCII classes or scoped `(?-u:…)` instead of large Unicode classes. Program paths and `"$cwd"` roots are anchored to the session cwd at installation; an execute request's optional plain `rawInput.cwd` changes its starting directory, not those anchors. Known agent-expanded cwd spellings ask, including any cwd or dequoted `cd` operand containing `:`. Only configured agent `omp` is known to reset cwd per command; every other agent's execute requests always take the ordinary pending path, while other kinds are unaffected. Empty execute locations are valid; other kinds still require locations. At a reached regex rule, raw commands over 8 KiB or a passed 100 ms decision deadline make the whole decision ask without fallthrough. Policy only answers during active uncancelled prompt turns. The ordinary policy fields survive journaling/replay; invalid journal replacements clear policy until a later valid event. Replacement changes only future requests, never existing pending requests. Omitting a create policy installs no default.

**Who answers permission requests.** `control` includes `permission`, `elicitation` and `policy`: a client that holds it can approve what an agent asks or set a hub-owned permission policy (§3.4.5). Policy applies with any client or none connected. Every request left to ask appears pending in Workbench; automatic decisions instead appear in the journal as `permission_auto`. Elicitations always require an ordinary answer.

#### 3.8.3 Observed sessions

An observed session is what the harnesses report about one agent session: a record in wb-web's memory, built from the events the hosts send, for sessions the hub does not own as much as for those it does.

**The event** (`POST /v1/events`):

```json
{
  "harness": "claude",
  "at": 1763300000123,
  "wbSession": "n_k3m9x2",
  "attach": { "kind": "claude", "id": "deadbeef" },
  "pid": 4242, "pidStart": 98765432,
  "projectRoot": "/home/alice/proj/x",
  "repoRoot": "/home/alice/proj/x", "repo": "alice/x",
  "worktree": null, "branch": "main",
  "payload": { }
}
```

- `harness` matches `^[a-z0-9-]{1,32}$`. Every other field but `payload` is optional and may be `null`; unknown fields are ignored.
- `at` is the sender's wall clock in ms; absent, or later than the server's, it is the server's.
- `wbSession` is the sender's `$WB_SESSION`, kept only when it is a sid (`^[A-Za-z0-9_-]{1,64}$`): the agent runs under the hub as that session.
- `task` is an optional task reference with the same validation as `SpawnAcp.task` and the envelope's 2,048-byte string limit before trimming.
  A valid string replaces the previous task; an empty trimmed string clears it.
  An absent, null or invalid value leaves the task unchanged; the rest of the report is processed.
- `attach` is `{kind:"claude", id}` with `id` matching `^[0-9a-f]{8}$`, or `{kind:"tmux", socket, pane}` with `socket` matching `^/[A-Za-z0-9._/-]{1,200}$`, containing no `..`, and integer `pane` in `0..999999`. No extra fields. Malformed values count as absent; like `wbSession`, an absent, null or malformed value leaves the previous valid value intact, and a later valid value replaces it. For example, `{"kind":"tmux","socket":"/tmp/tmux-1000/default","pane":7}`.
- `pid` and `pidStart` name the harness process: its pid and field 22 of its `/proc/<pid>/stat`. `projectRoot` is the nearest directory at or above the session's cwd that holds `.git`.
- `repoRoot`, `repo`, `worktree` and `branch` are optional strings or `null`, derived by the reporter **on the session's host** by the rule below, never typed by the user. The four fields are one replacement set: an event containing **any** of these keys, with any value including `null`, MUST replace all four stored fields. A string of at most 2,048 UTF-8 bytes is stored; a null, absent, wrong-type or oversized value becomes null. An event containing **none** of these keys MUST leave all four unchanged, so reporters that have not been updated retain the old behavior. `projectRoot` keeps its existing retain-when-absent semantics. They are display metadata, not paths for the server to open or addresses from which to fetch.
- `payload` is an object with a `session_id` matching `^[A-Za-z0-9._:-]{1,128}$`:
  - for `claude` and `codex`, the JSON their hook wrote to its stdin, unchanged;
  - for any other harness, a **neutral event**: `{session_id, kind, cwd?, transcript_path?, model?, permission_mode?, agent_id?, agent_type?, text?, tool?: {name, input?}, reason?}`, with `kind` an `ObsKind`. `text` is the prompt of a `prompt`, the last assistant message of a `turn_end`, and the message of a `permission`, `question` or `note`. That is the whole contract a new harness has to meet: an extension that posts neutral events.
- **Refused with 400**, the registry unchanged: a body that is not such an object, a bad `harness`, `session_id` or `agent_id`, an unknown `kind` in a neutral event.
- The host is the client's `host` (§3.8.1).

```ts
type ObsKind = 'start'|'prompt'|'tool_start'|'tool_end'|'tool_fail'|'permission'|'permission_done'
             |'question'|'turn_end'|'subagent_start'|'subagent_end'|'note'|'end';
interface ObservedSession {
  id: string;            // "o_" + the first 16 hex digits of sha256(key)
  key: string;           // `${host}/${harness}/${sessionId}`, or `…/${sessionId}/${agentId}` for a subagent
  host: string; harness: string; sessionId: string;
  parent: string|null;   // the id of the session that started this one; presently reported for subagents
  agentType: string|null;
  wbSession: string|null; pid: number|null; transcriptPath: string|null;
  attach: null|{kind:'claude'; id:string}|{kind:'tmux'; socket:string; pane:number};
  cwd: string|null; projectRoot: string|null;
  repoRoot: string|null; repo: string|null; worktree: string|null; branch: string|null;
  task?: string;         // persisted task reference; absent when not set
  project: string;       // basename(projectRoot ?? cwd), else "(no cwd)"
  model: string|null; permissionMode: string|null;
  title: string;         // the first line of the first prompt (≤ 120 bytes), else agentType, else `${harness} · ${project}`
  state: State;          // the vocabulary of §3.4.6
  startedAt: number; lastAt: number; endedAt: number|null;
  endReason: null|'session_end'|'process_gone'|'silent'|'replaced'|'parent_ended';
  tool: {name: string; input: string|null}|null;
  pending: {kind: 'permission'|'question'; tool: string|null; input: string|null; message: string|null; at: number}|null;
  lastPrompt: string|null; lastMessage: string|null;
  counts: {events: number; prompts: number; tools: number; toolFailures: number; subagents: number};
  tail: {at: number; kind: ObsKind; text: string}[];   // newest last, at most OBS_TAIL
}
```

Agents determines observed attach eligibility from the registry's validated `attach` and `endedAt`, not the joined row's liveness (a joined ACP session may still be running). It uses `harness` and `attach.kind` to identify Claude Code (F-A48).

Texts are excerpts: cut to `OBS_TEXT_MAX` (a tail line to 240 bytes) at a character boundary, with `…`. A tool's `input` is the first present of `command`, `file_path`, `path`, `pattern`, `url`, `description` of the tool input, else its compact JSON.

**Repository derivation (normative).** A reporter MUST derive these facts from the session's files on its host, without executing `git`. `wb-web` MUST derive the same facts for a hub agent or shell session only when its `host` equals wb-web's configured host; it MUST NOT inspect a local path on behalf of another host. Hub summaries exposed by wb-web, including `/rpc`, carry the four nullable fields without extending the hub protocol. For a hub-only session, first find `projectRoot`, the nearest directory at or above its absolute cwd holding `.git`; its existing project fallback remains available when derivation fails.

1. When `projectRoot/.git` is a directory, that is the git directory and `projectRoot` is the repository root.
2. Otherwise `.git` MUST be a file containing `gitdir: PATH`. Resolve a relative PATH against `projectRoot` to obtain the worktree's git directory. Its `commondir` file, when present, names the common git directory (relative to the worktree's git directory); without that file, use the worktree's git directory itself. If the common directory is named `.git`, the repository root is its parent; otherwise the common directory itself is the repository root (a bare repository). Resolve relative path components before comparing roots.
3. `repoRoot` is that repository root. Read only the common directory's `config` for remote `origin`. For `https://host/owner/name`, `ssh://git@host/owner/name` and `user@host:owner/name` (any non-empty user without `/`, `@` or `:`, and a non-empty host without `/` or `:`), take the last two non-empty path segments and strip the final `.git` to obtain `owner/name`. Without an origin, `repo` is the basename of the repository root. `repo` is only a display name and grouping key: nothing is fetched from it.
4. `worktree` is the basename of `projectRoot` if that root differs from `repoRoot`, otherwise `null`.
5. Read `HEAD` in the **worktree's** git directory. `ref: refs/heads/X` gives branch `X`; otherwise a hexadecimal value gives its first seven characters, and anything else gives `null`.

All files are untrusted UTF-8 text. Each read MUST be bounded to 8 KiB and limited to the small `.git`, `commondir`, `config` and `HEAD` files; special files MUST NOT be read. There is no index, object, include-file or directory-tree scan. An I/O, size, encoding or malformed-path failure leaves all four repository fields null and the session grouped as before. Missing optional `commondir` and `config` are not failures. A malformed/non-branch HEAD yields a null branch as specified above. wb-web request paths MUST only read the cwd cache and MUST NOT perform filesystem I/O for repository derivation. Before a cwd's first result, summaries have all four repository fields null and use the prior project fallback. A process-wide refresh derives facts with `spawn_blocking`, without holding the cache mutex during I/O; each cwd has at most one derivation in flight, even if it hangs. The cache holds at most 256 entries, including in-flight entries, which MUST NOT be evicted. Completed successes and failures are refreshed after three seconds; the old result remains readable during refresh. Completion publishes the session update for the first non-null facts as well as later changes; an initial failed derivation with no facts does not resend an identical null-metadata summary, so `/rpc` shows new facts and branch changes within a few seconds without hub activity.

These hand-written filesystem fixtures are normative (paths are absolute unless shown as relative):

| Fixture | Small files | `repoRoot`, `repo`, `worktree`, `branch` |
|---|---|---|
| Plain checkout | `/r/x/.git/` directory; `HEAD` = `ref: refs/heads/main`; origin = `https://host/alice/x.git` | `/r/x`, `alice/x`, null, `main` |
| Linked worktree outside repository | `/r/x-wt/topic/.git` = `gitdir: /r/x/.git/worktrees/topic`; that git directory's `commondir` = `../..`, `HEAD` = `ref: refs/heads/topic`; common origin as above | `/r/x`, `alice/x`, `topic`, `topic` |
| Worktree under `.claude/worktrees` | `/r/x/.claude/worktrees/task/.git` = `gitdir: ../../../.git/worktrees/task`; `commondir` = `../..`, `HEAD` = `ref: refs/heads/fix/task` | `/r/x`, `alice/x`, `task`, `fix/task` |
| Detached HEAD | Plain checkout with `HEAD` = `0123456789abcdef0123456789abcdef01234567` | `/r/x`, `alice/x`, null, `0123456` |
| No origin | Plain checkout with no config, or config with no origin | `/r/x`, `x`, null, `main` |
| HTTPS origin | origin = `https://host/team/x.git` | `/r/x`, `team/x`, null, `main` |
| SSH URL origin | origin = `ssh://git@host/team/x.git` | `/r/x`, `team/x`, null, `main` |
| SCP-style origin | origin = `git@host:team/x.git` | `/r/x`, `team/x`, null, `main` |
| SCP-style origin with another user | origin = `alice@example.org:team/app.git` | `/r/x`, `team/app`, null, `main` |
| Bare repository's worktree | `/r/checkout/.git` = `gitdir: /r/bare/worktrees/checkout`; `commondir` = `../..`, `HEAD` = `ref: refs/heads/main`; `/r/bare/config` has no origin | `/r/bare`, `bare`, `checkout`, `main` |
| Unreadable `.git` | `.git` cannot be opened (or is malformed, oversized or a special file) | null, null, null, null; existing project grouping |

**The fold.** Each event becomes one `ObsKind` and changes the record so:

| Kind | claude `hook_event_name` | codex `hook_event_name` | Change |
|---|---|---|---|
| `start` | `SessionStart` | `SessionStart` | `model`; the record is live again |
| `prompt` | `UserPromptSubmit` | `UserPromptSubmit` | in a turn; `lastPrompt`; `title` if none |
| `tool_start` | `PreToolUse` | `PreToolUse` | `tool`; in a turn |
| `tool_end` / `tool_fail` | `PostToolUse` / `PostToolUseFailure` | `PostToolUse` | `tool` cleared; counts |
| `permission` | `PermissionRequest`; `Notification` of type `permission_prompt` when nothing is pending | `PermissionRequest` | `pending` |
| `permission_done` | `PermissionDenied` | – | `pending` cleared |
| `question` | `Notification` of type `elicitation_dialog` or `elicitation_url_dialog` | – | `pending{question}` |
| `turn_end` | `Stop`; `StopFailure` (the tail line names the error) | `Stop` | the turn is over; `lastMessage` |
| `subagent_start` / `subagent_end` | `SubagentStart` / `SubagentStop` | `SubagentStart` / `SubagentStop` | the subagent's record |
| `note` | `PreCompact`, other `Notification`s, any other name | `PreCompact`, `PostCompact`, any other name | the tail only |
| `end` | `SessionEnd` | – | ended `session_end` |

The names in the codex column are those of the codex release the fixtures were taken from; the fixtures are normative, and each one names the source it was taken from. Every event also sets `lastAt`, adds to `counts.events` and to the tail, and takes `cwd`, `transcriptPath`, `model`, `permissionMode`, `wbSession`, `attach`, `pid` and `projectRoot` when it carries valid values. The four repository fields follow the replacement-set rule above. `pending` is cleared by any later event of the same record except `note` and `permission`. An event with an `agent_id` goes to the subagent's record, keyed `sessionId/agentId` with `parent` set, and also sets the parent's `lastAt`.

**State**, first match wins; the table tests are normative. `error` and `detached` are never produced.

```
1. ended                      -> exited
2. pending.kind = permission  -> waiting_permission
3. pending.kind = question    -> waiting_input
4. in a turn                  -> running
5. the turn ended             -> done     (until the next prompt)
6. otherwise                  -> idle
```

**Ending.** A sweep runs every `OBS_SWEEP`:
- on the registry's own host, a record with a `pid` whose `/proc/<pid>/stat` is gone or has another start time ends `process_gone`;
- a record silent for `OBS_SILENT_END` ends `silent`;
- a `start` from the same host, harness, pid and start time as another live top-level record ends that one `replaced`;
- a parent's end ends its subagents `parent_ended`;
- any event other than `end` makes an ended record live again;
- an ended record is dropped `OBS_ENDED_KEEP` after `endedAt`. A host has at most `OBS_SESSIONS_MAX` records: at that many, its oldest ended one goes first, else its live one with the oldest `lastAt`. A host never makes room among another's records, so one that sends a flood of sessions loses only its own.

**Persistence.** `<stateDir>/observed.json` (0600, atomic), `{"v":1,"sessions":[…]}`, written at most every `OBS_SAVE_EVERY` while something changed, when a shutdown begins, and once more after the last request has ended; that last save is missed when connections outlive the shutdown grace. So prompt excerpts are on disk. A file that does not parse, or has another `v`, is renamed `observed.json.bad-<ms>` with a warning, and the registry starts empty. A sweep runs right after loading.
Old stored records without `attach` or the four repository fields load those fields as null; responses always serialize them. Events without repository fields and old records group by `project`, unchanged.

**Opening the existing terminal.** A spawning browser `/pty` `open` can name `attach:<ObservedSession.id>` instead of `cmd`; the presence of both fields, even `cmd:""` or `cmd:null`, is refused. The web looks the record up; it refuses an unset `attachCommand`, an unknown or ended record, a record without `attach`, and any unsafe address. It revalidates the command path, attach fields and host (`^[A-Za-z0-9.-]{1,64}$`, containing no `..`) at the command boundary, including records loaded from disk. The hub's default shell runs `<attachCommand> <host>:claude:<id>` or `<attachCommand> <host>:tmux:<pane>:<socket>`; a browser shell override is ignored for attachment. For example, `/run/current-system/sw/bin/attach-agent devbox:claude:deadbeef` or `/run/current-system/sw/bin/attach-agent devbox:tmux:7:/tmp/tmux-1000/default`. Every address matches `^[A-Za-z0-9.-]+:[a-z]+:[A-Za-z0-9._/:-]+$` and contains no `..`; the latter prevents nushell's multi-dot path expansion. Both shell words are unquoted and contain no shell syntax. The command receives exactly **one argument**, the address, and carries the terminal over **stdio**; it chooses how to reach that host. Closing the terminal detaches the viewer and must leave the agent running. Without `spawn:true`, `attach` is ignored and the existing no-spawn rule holds.
An implementation can run `claude attach ID` or `tmux -S SOCKET attach-session -t %PANE`, locally or over ssh to HOST. It must detach on close rather than end that underlying session.

**Limits** (wb-web, `api` and `observed`): `API_CONNS_MAX` 256, `REFUSALS_LOGGED` 60, `API_BODY_MAX` 1 MiB, `OBS_SESSIONS_MAX` 256 a host, `OBS_TEXT_MAX` 2 KiB, `OBS_TAIL` 20, `OBS_SWEEP` 10 s, `OBS_SAVE_EVERY` 5 s, `OBS_SILENT_END` 12 h, `OBS_ENDED_KEEP` 6 h, `OBS_PUSH_EVERY` 500 ms.

#### 3.8.4 `GET /v1/stream`

Server-sent events, each `event: <name>` with one line of JSON as `data`:

| Event | Data | When |
|---|---|---|
| `hub` | `{status}` | first, and on every change. A client drops the hub sessions it holds when one arrives |
| `session` | `Summary+state` | one per session after every `hub` whose status is `up`, then on every change |
| `gone` | `{sid, epoch}` | the hub forgot a session |
| `observed` | `ObservedSession` | one per record after the sessions, then on every change, at most one per record per `OBS_PUSH_EVERY` |
| `observed_gone` | `{id, key}` | a record was dropped that a stream or a listing had shown |
| `ready` | `{}` | once, after the snapshot |

A comment line goes out every 15 s.
A client that falls so far behind that events were lost is disconnected and takes a new snapshot when it reconnects.
On an `up` notification, the stream takes the current hub status and snapshot and starts a new subscription at the same point, dropping any queued hub deltas that the snapshot supersedes.
An observed-session change that lands between the subscription and the initial snapshot may be sent twice.
The stream ends when wb-web shuts down.

#### 3.8.5 Remote hosts (hub)

`hub.json` takes an optional `hosts` object:

```json
"hosts": {
  "laptop": {
    "argv": ["/run/current-system/sw/bin/ssh", "-T", "-oBatchMode=yes", "alice@198.51.100.7", "workbench-agent"],
    "agents": {"claude": {"label": "Claude"}, "pi": {"label": "pi"}}
  }
}
```

- **A host** is a name, the command that reaches its launcher, and the agents the launcher knows. The hub knows nothing of ssh: `argv` is any command whose standard input and output are an agent's.
- **Starting agent `A` of host `H`** for session `S` in directory `C`: the hub runs `hosts.H.argv` followed by three more arguments, `A`, the lowercase hex of `C`'s bytes, and `S`. All three match `^[A-Za-z0-9_-]+$`, so no shell between the hub and the launcher can read them as anything else. The process runs in the hub's `$HOME`, with the environment of §3.7.3 steps 1 to 3 (`agents.<name>.env` is for local agents).
- **The launcher** is the remote host's own: it maps `A` to a command, changes to `C`, sets `WB_SESSION=S` and runs it, and exits non-zero with one line on stderr when it cannot. It is not in this repository's binaries; a host is free in how it provides one.
- **`SpawnAcp`** gains `host?`. Absent, or the hub's own `host`, means local, as before. Otherwise: an unknown host is `bad_request` "no host H"; an agent not in that host's table is `unknown_agent`; `cwd` must be an absolute path without NUL of at most 4096 bytes, and is not looked up on the hub's host.
- **The session** remembers its host (`acp/<sid>.json`, absent meaning local), so a revive goes the same way, and its `Summary.host` is that host's name.
- **`hello`** gains `hosts: [{name, agents:[{name,label}]}]`, empty from a hub without `hosts`.
- **Ending** is as for a local agent: the signals go to the local process group of the command. The launcher's side ends when its standard input closes.
- **Validation** refuses to start the hub when a host name does not match `[A-Za-z0-9][A-Za-z0-9._-]*` or equals `host`; `argv` is empty, `argv[0]` is not absolute or an argument holds NUL; or an agent name does not match `^[a-z0-9-]{1,32}$`.
- ACP gives the hub no file or terminal duties (`clientCapabilities` has none, §3.4.5), so an agent on another host reads, writes and runs there.

---

## 4. Hub (`crates/wb-hub`)

**Module tree.** `main`, `config`, `env`, `procfs`, `store`, `outq`, `conn`, `registry`, `shutdown`; `pty/{mod,spawn,io,vt,out}`; `acp/{mod,rpc,lines,agent,journal,facts,replay}`.
- `pty/out.rs` holds `OutStream`, the UTF-8 and escape-tail holdback, and `Ring`, the `PTY_RING` byte ring with `stream`/`out` offsets.

`wb-fake-acp` is the `[[bin]]` `crates/wb-hub/src/bin/wb-fake-acp.rs`.

**Size budget:** about 4,300 lines including unit tests. An ACP actor above 1,000 lines is a review flag.

| # | Design point | Where |
|---|---|---|
| H-1 | A request without `spawn` never starts a process. A dead PTY respawns only on `pty.open` with `spawn`. | `registry.rs`, `pty/mod.rs`, `acp/mod.rs` |
| H-2 | `createdAt` is persisted per session and serves as `epoch`. `stale` on a mismatched `acp.permission`/`acp.elicitation`. `acp.open{epoch}` mismatch means reset. `gone{sid, epoch}` goes to watchers **and** attached connections, which are then detached. | `registry.rs`, `acp/mod.rs`, `pty/mod.rs` |
| H-3 | `kill{forget:true}` replies `ok` only after the exit, the file deletion and the registry removal, so an immediate re-open with `spawn` creates a fresh incarnation. `forget:false` replies at the start. | `pty/mod.rs`, `acp/mod.rs`, `registry.rs` |
| H-4 | Byte ring plus `stream`/`out` offsets, `resume` on `pty.open`. A resumed attach sends the ring tail instead of a snapshot. | `pty/out.rs`, `pty/mod.rs` |
| H-5 | VT shrink rule (§3.4.3) applied before `set_size`. | `pty/vt.rs` |
| H-6 | Escape-tail holdback ≤ 4 KiB. The next read releases it; after 20 ms idle it is released as is, while an incomplete UTF-8 character waits for the next read. Parser, ring and fan-out see identical chunks. | `pty/out.rs` |
| H-7 | The nudge restores the *currently desired* size, and a `pty.resize` during the nudge cancels the restore. Attach size is applied only for a sole viewer. | `pty/mod.rs` |
| H-8 | Replay is pinned ∪ kept in **one ascending-seq stream** (§3.4.4). | `acp/replay.rs` |
| H-9 | Journal is fail-closed: write first (one `pwrite` at the tracked end), then fold. On a short write: ftruncate, `fault{journal_write}`, teardown, `faulted`, and a recovery probe. | `acp/journal.rs`, `acp/mod.rs`, `acp/facts.rs` |
| H-10 | Per-session load under `catch_unwind` plus error handling. Failure means quarantine (rename) plus a dead `fault{load_failed}` Summary. A quarantined PTY also carries a `hub_restart` exit, so its card attaches as a corpse and a respawn clears the fault. A supervisor reload uses the same path, never on the main task. | `registry.rs`, `main.rs` |
| H-11 | After **any** agent exit, the leftover process group is terminated: TERM, then KILL after 2 s. `setsid` descendants survive. `seenSeq = headSeq` after finalising a user kill only. | `acp/agent.rs`, `acp/mod.rs` |
| H-12 | `revivable` is false after `setup_error{revive_failed}` until the next `session`. | `acp/facts.rs` |
| H-13 | Every `std::sync::Mutex` uses `lock().unwrap_or_else(PoisonError::into_inner)`, with panic-free critical sections. A session-actor panic is reloaded and attached connections get `err{internal,"session reloaded"}`. | all |
| H-14 | `hello.build = option_env!("WB_HUB_BUILD")`, set by nix to the hub fileset hash. | `conn.rs` |
| H-15 | The `mode` event, `permission_resolved.by:"agent"` and `update.sessionId` (only when it differs) are journaled. | `acp/mod.rs`, `wb-proto` |
| H-16 | Test fixtures take the shell from `$BASH`. | `tests/common/mod.rs` |
| H-17 | ACP conformance is a round trip: build → deserialize into the `=1.11.0` schema type → serialize → compare. Only schema defaults may differ: a key whose value is `null`, `false`, an empty array, or a non-empty object made only of those may be missing from the result. An empty object is **not** a default, because `{}` means "supported" in ACP capabilities. It also asserts that `clientCapabilities.elicitation.{form,url}` is present. | `acp/rpc.rs` tests |
| H-18 | `config.rs` parses the full §3.7.2 from M0 on, including `agents`, which is unused before M3, so that the module's config never changes shape. | `config.rs` |
| H-19 | Exec failure. ACP: `setup_error{spawn_failed}` with no `spawn` or `exit` line; the session stays dead, and `acp.open` still replies `ok` while a failed `acp.revive` replies `spawn_failed`. PTY: a corpse with `exit{reason:"spawn_failed"}`, persisted and published before the `spawn_failed` reply, for a fresh sid as well; the next `pty.open` with `spawn` retries. | `acp/agent.rs`, `pty/spawn.rs`, `pty/mod.rs` |

**Hub test inventory** (cargo, real binary where noted).
- **Unit tests** per module, including:
  - `out.rs`: holdback across reads, ring wrap, offsets of U+FFFD;
  - `vt.rs`: shrink keeps the newest rows in scrollback; the snapshot of a held escape tail never splits a sequence;
  - `facts.rs`: `revive_failed` makes revivable false; a fault folds;
  - `replay.rs`: ascending order with a pinned event below the truncation point.
- **`tests/pty.rs`:**
  - spawn/echo/exit;
  - no spawn without `spawn` (unknown → `not_found`, dead → corpse attach, nothing runs);
  - resume from the ring; a resume after `stream` changed gets a snapshot;
  - kill-forget `ok` after deletion, then an immediate spawn gets a new `createdAt`;
  - `gone` reaches a second attached connection;
  - resize while two viewers are attached;
  - nudge cancel;
  - `hub_restart` exit on reload;
  - quarantine of a corrupt `pty/x.json` while a healthy session loads;
  - peer-cred reject via `unshare -U` (skipped when unavailable);
  - env scrub canaries;
  - spawn with `shell:"sh"` (a test entry): `echo $0` shows it; an unknown name gives `bad_request`; `SHELL` in the child equals the resolved path; a respawn keeps the shell.
- **`tests/acp.rs`** (against `wb-fake-acp`):
  - every scenario of §9.2, including replay ordering with a pending request at seq 120 of 200;
  - `stale` epoch;
  - kill-forget `ok` after about 6 s on the `kill-stubborn` scenario, then an immediate spawn;
  - group kill after `crash-leave-child`;
  - `setsid` survivor;
  - `revive_failed` makes the session not revivable;
  - journal fault injection: `WB_HUB_TEST_FAIL_WRITE_AT=N`, a `cfg(debug_assertions)`-only hook, gives `faulted`, a successful probe clears it, and no seq is reused. The hook affects only the first journal the process opens, writes half a line at seq N and fires once. The release-profile test run does not run this test;
  - quarantine of a garbage `.jsonl`: the garbage must include a complete line, because a torn tail is truncated rather than quarantined.

---

## 5. Web front (`crates/wb-web`, `crates/wb-cli`)

**Module tree.** `main`, `config`, `auth`, `static_files`, `http`, `util`, `routes`, `hub`, `info`, `git_metadata` (bounded local repository derivation and cwd cache), `relay_pty`, `relay_acp`, `rpc`, `board`, `fsapi`, `host`, `artifacts`, `sample`, `notes/`, and for the mesh (§3.8) `api/` (the gate, `sessions`, `observed`, `stream`) and `observed/` (the registry).
- `routes.rs` is the one place that merges each module's `pub fn routes() -> Router<AppState>`;
- `info.rs` holds `/api/info`, `/api/sessions`, `/api/status` and capture;
- there is no tmux module.

| # | Design point | Where |
|---|---|---|
| W-1 | `routes.rs` merges each module's `routes()`. M0 creates stubs for every module, so parallel work packages never edit a shared router file. `AppState.feed: broadcast::Sender<FeedMsg>` (Hub, Session, Gone, Board) is the only cross-module channel. | `routes.rs`, `main.rs` |
| W-2 | `/pty`: the `spawn` flag gates `cmd`/`env`/`cwd`/`parent`. Only the JSON value `true` spawns; absent means false from M1 on, and in M0 absent means true. `resume` is passed through, `out` offsets are relayed, and `gone{epoch}` → close 1000. | `relay_pty.rs` |
| W-3 | `/acp`: spawn fields only when both `agent` and `cwd` are non-empty. `epoch` is passed through. `info.session` is omitted when unchanged per socket. Close codes: 1000 after a kill-forget `ok`, a failed open and `gone`; 1008 for a bad first message or id; 1011 for a lost hub connection and "session reloaded"; 1012 on wb-web shutdown; 1001 for a dead keepalive. The full rules are in §3.5.2. | `relay_acp.rs` |
| W-4 | Leader = max `lastActive` from `active{ago}`; clients that never sent `active` rank last; ties go to the newest connection (§3.3). | `rpc.rs` |
| W-5 | `PUT /api/board` broadcasts `board{etag}`. The proxy site never compresses responses, and T-S23 asserts that the ETag round-trips through Caddy unchanged. | `board.rs`, `rpc.rs` |
| W-6 | `/api/mv` destination denylist: in, on or above `~/.ssh`, `~/.config/systemd` or `~/.local/share/systemd`, as written and symlink-resolved, checked on the normalised path and again on the real path of an `O_PATH` descriptor of the parent, with the rename made relative to that descriptor. `EROFS`/`EXDEV` → 400. This complements the unit's `ReadOnlyPaths` (§7). With `editSocket` set the move is edwind's `rename-file`, which checks the same list on both ends (edwind R16.14). | `fsapi.rs` |
| W-7 | `/api/info` adds `home`, `agents`, `shells`, `defaultShell` and `hub{status, version, build, proto, startedAt, stale}`; `tmux` is always false. While the hub is down, `agents` and `shells` are `[]` and `defaultShell` is `null`. | `info.rs` |
| W-8 | There is no tmux code and no `tmuxSocket` option. The tmux endpoints return 404. | – |
| W-9 | Per-route WebSocket caps: `/pty` 2 MiB, `/acp` 9 MiB, `/rpc` 32 MiB; close 1009. Re-encoding can make an `/acp` request longer than the browser's message, so the web measures the hub line and refuses one longer than `MAX_LINE` + 1 with `error{"message too large", bad_request}`; the socket stays and the hub connection is never ended by a browser message. | `relay_*.rs`, `rpc.rs` |
| W-10 | Unit control (`POST /api/unit/…`) gives 403 (§3.5.5). | `host.rs` |
| W-11 | Fixtures take the shell from `$BASH`; the harness falls back to `/run/current-system/sw/bin/bash` if that exists, then to `PATH`. The harness env names are `WB_HARNESS` and `WB_PLAYWRIGHT`. | tests |
| W-12 | Without `editSocket` the notes routes are 503, as while edwind is down, with `notesExists:false` (the empty-shape stubs went 2026-11-11). | `notes/mod.rs` |
| W-13 | `/rpc` sends `hub{…}`, `board{etag}` and `sessions` on connect, then `session`, `gone{sid, epoch}`, `hub{…}` and `board{etag}`. With `api`, connect ends with `observed{sessions}`, and `observed_put` and `observed_gone` follow (§3.5.3). | `rpc.rs`, `hub.rs` |
| W-14 | `wb` drops `hosts`, `host`, `unit start\|stop\|restart`, `tmux`, `adopt` and `create_node kind=agent`. | `wb-cli` |
| W-15 | Shutdown: axum stops tracking a connection once it is upgraded, so each WebSocket holds a guard (`App::socket()`) and `run()` waits for the count to reach 0 inside a 5 s grace. That is what lets the 1012 close frames go out. | `main.rs` |

**Web test inventory.**
- **Unit tests** per module, including:
  - the leader table with `ago`;
  - ETag strings;
  - the `mv` denylist: a symlinked parent into `~/.ssh` is refused;
  - spawn-flag mapping for `/pty` and `/acp`;
  - `info.session` omission.
- **Integration (fake hub):**
  - `board{etag}` broadcast to two `/rpc` clients;
  - close 1000 after a kill-forget `ok`;
  - 1009 per route;
  - a reconnect without `spawn` produces no `SpawnPty`;
  - `shell` passes through on an explicit spawn only, and `/api/info.shells` comes from the hub.
- **Black box:** `tests/test_daemon.py` and `tests/test_security.py` (§9.3).

---

## 6. Frontend (`web/`)

The frontend is the existing single-page app with six fixes and the amendments below. `app.js` is large (about 480 KB), so read it with grep and sed, not whole. There is no `acp.js` split: one frontend work package per milestone owns `app.js`.

**Fixes.**
1. the `acp` node kind;
2. expired login;
3. reconnect, backoff and hub restarts;
4. the leader tab;
5. no token;
6. srcdoc artifacts and self-hosted fonts.

### 6.1 Amendments

Each binding amendment has its own file in [docs/amendments/](amendments/).
The file is named by its amendment number.

- New UI checks are documented as described in §9.5.

### 6.2 Look and typography

The look is modelled on an Emacs setup: Modus tinted themes, a monospaced default face, a proportional face only for prose, and flat chrome.

1. **Palettes.** Light is **Modus Operandi Tinted** and dark is **Modus Vivendi Tinted** (Protesilaos Stavrou's modus-themes), using the exact named colours from the upstream source (`modus-operandi-tinted-theme.el` and `modus-vivendi-tinted-theme.el`; the light `bg-main` is `#fbf7f0`). Every existing CSS token is mapped semantically, following Modus's own semantic mappings, for example:
   - `--panel` = `bg-main`; `--bg` and `--panel-2` = `bg-dim`; `--fg` = `fg-main`; `--muted` = `fg-dim`; `--line` = `border`;
   - `--modeline-*` = `bg-mode-line-active` / `fg-mode-line-active` / `border-mode-line-active`;
   - `--active-line` = `bg-hl-line`; `--sel` = `bg-region`; `--link` = the colour of Modus `fg-link`; `--accent` = the `blue-warmer` family, used as the prompt and accent colour;
   - status colours (attention, card state, errors) use the Modus semantic colours (`err` red, `warning` yellow-warmer, `info`/running blue or cyan, `success` green) and their `bg-*-subtle` backgrounds for chips.

   The light/dark mechanism is `prefers-color-scheme` plus the `data-theme` override. There are no other themes.
2. **Terminals and editors.** The xterm.js theme uses `bg-main` and `fg-main`, `cursor`, `bg-region` for selection, and Modus's terminal colours for the 16 ANSI slots. Page text is drawn by Edwin frames (F-A39), whose faces come from Edwin's own light and dark palettes (`edwin/src/display.ts`), overridable with `set-face-color!`.
3. **Geometry.**
   - `--radius: 0` is used for every `border-radius`. Only real circles keep `50%`: status dots and round handles.
   - There are no soft drop shadows. Chrome uses 1px `border` lines. Floating layers (menus, popovers, dialogs, toasts) get a 1px `border` and at most a hard 1px offset, never a blur.
   - Layouts are not restructured.
4. **Typography.**
   - `--mono: "JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, monospace` is the default face for chrome (toolbar, status line, card titles, labels, buttons, menus), terminals and editors. The Nerd Font is there so that prompt and TUI glyphs render in terminal cards.
   - `--ui: "Noto Sans", system-ui, sans-serif` is used only for prose: rendered notes and markdown, agent message bodies, help text. `--hand` is an alias of `var(--ui)`.
   - The base size is 13px. Paddings and margins are reduced wherever they are already tokenised, so the result is dense.
   - Fonts are self-hosted. The nix build converts them to woff2 from nixpkgs (`nerd-fonts.jetbrains-mono`: Regular and Bold; `noto-fonts`: Noto Sans, a variable font with weights 100-900, in normal and italic) and writes them into the web output together with a generated `fonts.css` (N-3). No font binaries are committed to the repo. The service worker caches every file `fonts.css` names, and `index.html` preloads the Regular mono face.
5. **Tests.** N43-N47 (§9.5) check radius, background, xterm theme, fonts and shadows in both schemes.

### 6.3 Shell choice

Shells are always explicit (never taken from `$SHELL`). The user picks one from the allow-list configured in the hub (§3.7.2).
- The new-terminal action offers the available shells (`/api/info.shells`). The default is the last one picked on this device (`localStorage`, guarded by try/catch), falling back to `defaultShell`.
- The shell name (never a path) is stored on the board node and shown in the card header. A stored value that is not a valid shell name (`^[a-z0-9-]{1,32}$`) is ignored, as if the node named no shell.
- Respawn ("press Enter") reuses the node's shell. If that shell is no longer available, the card says so and offers the default.
- `wb` commands that type text into a shell (`cd`, `run_in_shell`) are unchanged.

### 6.4 Keys

Decided by the user on 2026-10-14 from the exploration page "Keyboard navigation and keybinding conflicts" (https://claude.ai/artifact/E2GwAfkNZrrM4pPE9nfWTX). The rule is the user's: one key may mean different things in different contexts, never two things in one context, and everything is reachable from the keyboard.

**Layers.** A key walks the active layers from the top and stops at the first one that answers:

| Layer | What it is | Keymap |
|---|---|---|
| leader | after the leader (Ctrl-Space by default; Ctrl-Alt-Space or F1) | `leader`, prefixes such as `leader-v` |
| transient | the palette, a dialog, hints, arrange mode | `palette`, `dialog`, `hints`, `arrange`; hints and arrange swallow every key they do not bind |
| interior | the card or field that has the keyboard: `term`, `page`, `text`, `control` (a focused button), `frame` (web card, artifact), `edwin` (an Edwin frame, `.edwin-frame`, in frames mode: F-A24) | none: an interior declares the keys it needs, and those end the walk there |
| view | the main view | `canvas`, `graph`, `agents` (maps; Agents: Up/Down or j/k select, Enter enters the live control, Escape returns to the list); `ranger`, `tasks`, `review` (functions with key sequences, tried first, declining what they do not handle) |
| place | board, workspace, focus tab | `board`, `workspace`, `tab` (empty; desks bind here, §10.8) |
| global | everywhere | `global` |

**Rules.** The checker (`WBKeys.check()`, run by `tests/keys.test.mts` and the flake check `web-keys`) walks every context stack over every key (about 230 stacks and 146,000 lookups) and fails on any of these:
- **K1.** A keymap binds a key once. Behaviour that depends on state is one command that branches (`esc` steps out of the tool, the selection, the focus tab, the workspace, the tag filter, in that order).
- **K2.** A key an interior needs never reaches an outer layer, and a key a shell, page or text field gives up is bound in `global` (else the card lost it for nothing).
- **K3.** Leader Esc is bound to `leave`: one way out of every card. It extends the edwind spec's R9.7 ("Leader then Esc … leaves the card") from Edwin frames to every card.
- No keymap binds a leader choice, and none binds a key the browser keeps (C-w C-t C-n C-S-w C-S-t C-S-n C-TAB C-S-TAB C-<prior> C-<next> C-q and the s- forms).
- With the page's command table: every bound command exists (`KC` in `app.js`; a missing one is also a console error at load, which the ui suite counts).

A fourth rule is a convention, not checked: **K4**, reuse a key across layers when the meanings rhyme (h j k l select a neighbour on the canvas and in the graph, move in arrange mode; `.` is "actions of this" on a card and a graph node).

**Notation.** Edwin's key names, so the same tables can become Edwin keymaps (K4 of §10.9): `C-` `M-` `s-` (Cmd/Super) and `C-S-p` for a shifted Ctrl letter; `RET TAB SPC ESC DEL <left> <f1>`. A shifted digit with a modifier is its symbol (`M-%` is Alt-Shift-5) and a shifted letter is the capital (`M-B`).

**Where keys live.** `web/keys.ts` is a module with no DOM: keymaps, interiors, transients, `resolve(ctx, key)`, `leaderResolve`, `whereIs` (the palette's labels), `rows` (which-key) and `check()`. `app.js` keeps one capture keydown listener that computes the context (`keyContext()`), walks `resolve` and runs the command in `KC`. A `cmd()` entry whose keys begin with `@` shows the keys bound to that command, so the palette, which-key and the bindings cannot disagree. New keys (desks included) are rows in `keys.js`; a pull request that adds one runs the checker.

Agents is reached by Alt-8 or the palette's Agents view command. Its list keys apply only while the keyboard is outside a composer, terminal or Edwin frame: Enter focuses the selected live control, the composer for ACP. Shift-Tab from the composer (past any request controls) can reach the transcript frame in the browser's tab order. Escape from the composer returns to the list; leader then Escape leaves the transcript frame for the list, while plain `j`/`k`, Enter and Escape inside the frame belong to Edwin. When Edwin is ready, the composer button or `C-c C-e` in either the composer or transcript frame opens a local unsaved prompt buffer; `C-c C-c` sends and `C-c C-k` restores its current text unsent, without a page file or canvas card.
The Agents transcript projects semantic journal items as literal text: one heading per submitted turn, labelled message blocks, tool headings with their evidence underneath, compact plan/settings status, and request headings updated by sequence.
Replay yields between batches, streamed text patches its own item, and a reader parked away from the tail by motion, wheel or touch keeps its place and focus.
The transcript-local `C-c n`/`C-c p` jump between turns, `C-c ]`/`C-c [` between tools, `C-c TAB` toggles the section at point, `C-c a` toggles all folds, and `C-c f` resumes following the tail.
Phone actions invoke the same commands without a keyboard.
With owner-supplied Edwin folds, thoughts and tool details start collapsed; transcript-local `za`/Tab toggle at point, `zc` closes, `zo`/`zO` open, and `zM`/`zR` close or open all.
A tool jump opens its enclosing turn and lands on the tool header; fold-all and unfold-all apply to all items received so far, including those still queued for paint.
Fold choices survive appends, reset replay and reattaching to the same journal incarnation, but a different prompt at a reused sequence does not inherit a choice (F-A53).
A replay starting inside a thought resets that thought's fold because its first journal record is missing.
In the Agents list, `g` toggles grouping of root rows between repository (default) and task, keeping descendants with their parent and roots without a task in one last group in task mode (F-A51).
In task groups, each root row shows its repository, and a nested row shows its repository when it differs from its parent's.
Like the Details disclosure, grouping is local to this page and resets on reload.

---

## 7. Nix and deploy

The flake builds the workspace with `buildRustPackage` (`cargoLock.lockFile`), builds the JavaScript vendor bundle with `importNpmLock`, and ships a NixOS module with two units (hub and web). The points below are binding.

| # | Design point | File |
|---|---|---|
| N-1 | Slice: `MemoryMax=20G`, `CPUWeight=100`, `TasksMax=8192`, all `mkDefault` so a host overrides them with a plain value, and **no `MemoryHigh`**. The VM test sets `MemoryMax` to a plain `"400M"` (a plain value beats the module's default) and its specialisation uses `mkForce "500M"`; `mkForce` on both is rejected by the unit option type. It also sets `vm.panic_on_oom = 0`, because the test instrumentation's default of 2 would panic the VM at the cgroup OOM step. | `nix/module.nix`, `nix/vm.nix` |
| N-2 | Both units seal `~/.ssh`, `~/.config/systemd` and `~/.local/share/systemd` with `ReadOnlyPaths`, **without** the `-` prefix, so a unit whose sealed path is missing fails to start instead of running unsealed. The module's tmpfiles rules create the three directories (mode 0700) and make sure their writable parents `~/.config`, `~/.local` and `~/.local/share` exist (mode `-`, so an existing mode is kept). Both units also `BindPaths` each of those parents onto itself: a mount point cannot be renamed (EBUSY), so a card cannot move `~/.config` aside and create a fresh `~/.config/systemd`. This assumes the parents are real directories, not symlinks. Paths are derived from the user's home, never hard-coded. | `nix/module.nix` |
| N-3 | `web.nix` converts the fonts of §6.2 to woff2 at build time from nixpkgs (`nerd-fonts.jetbrains-mono` Regular and Bold; `noto-fonts` Noto Sans, variable, normal and italic) into the web output, with a generated `fonts.css`. No font binaries are committed. The MIME table covers `woff2`, `woff`, `ttf` and `otf`. | `nix/web.nix`, `web/fonts/fonts.css` |
| N-4 | `package.nix`: `outputs = ["out" "fake"]`, and `postInstall` moves `wb-fake-acp` to `$fake/bin`. The flake exposes `packages.fake-acp = workbench.fake`. `WB_HUB_BUILD` = the hash part of the store path of the hub's source fileset (`lib.fileset` over `crates/wb-hub`, `crates/wb-proto`, `Cargo.lock`), so a web-only change does not mark the hub stale. | `nix/package.nix`, `flake.nix` |
| N-5 | There is no `tests/fake_acp.py`: the VM, ui and conformance checks use `wb-fake-acp`; the agent key is `stub`. Scenarios = the hub scenarios and the prompt keywords of §9.2. | `nix/vm.nix`, `nix/checks.nix` |
| N-6 | `harness.py` prints one JSON line: `{web, caddy, caddySocket, hubSocket, webSocket, caddyAdmin, stateDir, boardsDir, notesDir}`. `stateDir` is the hub's. `caddy` is `http://127.0.0.1:18443`, the `publicOrigin`, but the test Caddy listens **only** on `caddySocket`, a 0600 unix socket in the harness's 0700 temporary directory (`bind unix/caddy.sock\|0600`), because a TCP listener would hand the injected secret to every local user. The Caddyfiles use relative `admin unix/caddy-admin.sock` and `bind` paths, and Caddy runs with the temporary directory as its working directory. `tests/caddy/{live,expired,loginpage}.Caddyfile` are swapped with `caddy reload --address unix/<caddyAdmin> --config tests/caddy/<mode>.Caddyfile --adapter caddyfile`. The `expired` and `loginpage` modes gate only `/api/*`, `/pty`, `/acp` and `/rpc`; `/oauth2/*` and the static files work in every mode. All three modes set `stream_close_delay 5m`. `WB_HARNESS_TCP=1` also forwards TCP 127.0.0.1:18443 to `caddySocket` for a browser in the same network namespace, and the harness refuses unless `/proc/net/dev` lists only `lo`. In test mode the harness reads the stdin lines `stop hub` and `start hub` (acknowledged on stderr), restarts wb-web only on SIGHUP, and stops everything on stdin EOF. Test mode registers the agents `stub`, `stuck` (`wb-fake-acp --scenario kill-stubborn`) and `reconnect` (`--scenario permission-reconnect`) and refuses to start without `wb-fake-acp`; `--dogfood` registers no agent. The harness resolves bash from `$BASH`, then `/run/current-system/sw/bin/bash` when it exists, then `PATH`, and also configures `sh` as a second shell for tests. | `tests/harness.py`, `tests/caddy/*` |
| N-7 | There is no `tmuxSocket` option. `XDG_RUNTIME_DIR` is not set. Agent paths are `/etc/workbench/agents/<name>/<exe>`, omp via `/etc/profiles/per-user/<user>/bin/omp acp`. Stable `LOCALE_ARCHIVE`/`TZDIR`. | `nix/module.nix` |
| N-8 | VM test additions:<br>- peer-cred chmods the socket to 0666 as well as the directory;<br>- T-S7 asserts `list` filtered by `kind=="pty"` is empty;<br>- the module-owned tmpfiles and `BindPaths` rules show in `mountinfo` of both units: the three sealed paths read-only, the three parents writable;<br>- `/api/mv` into `~/.ssh` gives 400;<br>- kill-forget then an immediate reopen spawns. | `nix/vm.nix` |
| N-9 | `lib.adapterCheck { pkgs, agents }` (a `runCommand` running `tests/adapter_probe.py` against a real `wb-hub` with the given agents, initialize-only and offline) is exported for downstream deployments and lives in `nix/adapter-check.nix`. `agents` has the shape of `services.workbench.agents`, `{label, package, exe, args ? [], env ? {}}`, except that `package` is required, because the build sandbox has no `/etc/profiles`. The probe's `hub.json` has bash from `$BASH` as its only shell, `passEnv = ["PATH"]` and `setEnv = {NO_BROWSER = "1"}`; the sandbox exports `HOME`, `USER=nixbld` and `LOGNAME=nixbld`, since `wb-hub` refuses to start without them. For each agent the probe passes when setup ends in `session`, or in `setup_error` with `auth_required` or `agent_error` (a logged-out agent offline); the initialize result has `protocolVersion == 1`; `loadSession` or `sessionCapabilities.resume` is advertised, and `revivable` holds when setup reached `session`; `stderr.log` has no `[stdout]` line; `acp.kill{forget}` succeeds; and the hub is still running without a panic. `checks.adapters` runs it against the stub, so the probe and its plumbing are tested here; the real adapters run in the consumer's flake. The workbench flake stays nixpkgs-only. | `nix/adapter-check.nix`, `nix/checks.nix`, `flake.nix`, `tests/adapter_probe.py` |
| N-10 | Shell choice: `services.workbench.shells` is an attrset `name -> { paths; args ? [ "-i" ]; }`, plus `services.workbench.defaultShell` (default `"bash"`). The default offers `bash`, `fish`, `nu` and `zsh`, each with `paths = [ "/etc/profiles/per-user/<user>/bin/<x>" "/run/current-system/sw/bin/<x>" ]`. The `hub.json` list is rendered in attrset (alphabetical) order. Stable paths only, never `/nix/store`. The option description documents that child shells still run the system's profile init (§3.7.3). | `nix/module.nix` |
| N-11 | The module's assertions refuse what `wb-hub` would refuse at its next start, so a bad value fails the evaluation instead of the first hub restart after a deploy:<br>- `networking.nftables` is disabled (the source restriction uses iptables `extraCommands`);<br>- `listenAddress` is a non-wildcard IPv4 literal, and with `firewall.enable` there is a `firewall.interface` and an IPv4 `trustedProxy`;<br>- shell and agent names match `^[a-z0-9-]{1,32}$`, and variable names in `environment` and `agents.<name>.env` match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`;<br>- an agent's `exe` is absolute when its `package` is null;<br>- the child environment is literal (no `/nix/store`, no `$`), `defaultShell` is in `shells`, and shell paths are absolute and stable;<br>- `environment` names none of the module's own `setEnv` keys and none of the seven variables the hub sets itself.<br>`checks.module` evaluates one valid configuration and four bad ones. Other options: `host` (default: the system host name), `boardsDir`, `notesDir`, `environment` (non-secret variables set on the hub unit and passed to every child) and `logLevel` (`RUST_LOG` for both units, never passed to children). | `nix/module.nix`, `nix/checks.nix` |
| N-12 | Release profile: `packages.release` links the package's `bin` and the web output as `web`, and records the source `rev` and `lastModified`. With `services.workbench.releaseProfile` set, wb-web and edwind run from `<profile>/bin` and serve `<profile>/web`; the hub keeps running `package`. A release then reaches the front by switching the profile and restarting those two units, and no session ends. `workbench-release-profile` (oneshot, ordered before both) resets the profile to the flake's own release whenever the profile's `lastModified` is older, so after a reboot the web is never older than the hub. Building, gating and switching releases is the deployment's job, not the module's. | `flake.nix`, `nix/module.nix` |

**Unit summary** (with N-1 and N-2):
- **Hub:**
  - `Type=exec`, `restartIfChanged=false`, `KillMode=mixed`, `OOMPolicy=continue`, `OOMScoreAdjust=100`, `Restart=on-failure`, `NoNewPrivileges=yes`;
  - no `ProtectSystem`: cards need the filesystem view an ssh shell has. `InaccessiblePaths=-/run/user`;
  - `ReadOnlyPaths` for `~/.ssh`, `~/.config/systemd` and `~/.local/share/systemd`, and `BindPaths` for their writable parents (N-2);
  - the kernel and cgroup `Protect*` settings, `RestrictSUIDSGID`, `CapabilityBoundingSet=""`;
  - `RuntimeDirectory=workbench-hub` (0700), `TimeoutStopSec=15`;
  - `Slice=workbench.slice`;
  - no `PrivateDevices`, `ProtectClock` or device policy, because PTYs need `/dev/ptmx`;
  - the environment per §3.7.2.
- **Web:**
  - `Type=exec`, `Restart=always`, `stopIfChanged=false`, no start rate limit, `UMask=0077`, `OOMScoreAdjust=100`, `Wants`/`After` the hub;
  - `Wants` and `After` `network-online.target`, which only makes a first-boot failure on a missing listen address less likely: `Restart=always` with no start limit is the guarantee;
  - `ProtectSystem=strict`, `PrivateDevices`, `MemoryDenyWriteExecute`, `SystemCallFilter=@system-service`;
  - `LoadCredential=proxy-secret:…`, plus `media-NAME:…` for each media provider key file; `sample` needs none of wb-web's: the model backend and its key are edwind's (`services.edwind.models`);
  - `RuntimeDirectory=workbench-web` (0700);
  - `ReadWritePaths = [ home ]` (boards, notes, state, `/api/mv`), with the deeper N-2 `ReadOnlyPaths` taking precedence inside it, and the same `BindPaths` as the hub.
- **Firewall:** the module admits only the trusted proxy's address to the listen port (iptables-nft `extraCommands`).

**Reverse proxy.** The reference proxy is Caddy, with an authenticating `forward_auth` in front of the upstream:
- `header_up X-Workbench-Proxy-Secret {env.CADDY_UPSTREAM_SECRET_WORKBENCH}` sets the shared secret on every upstream request (§3.6);
- `stream_close_delay 5m` keeps WebSockets open across proxy reloads;
- the site never compresses responses, so that the board ETag round-trips unchanged.

**Runbook.**
- **After every deploy:** check `hub.stale` in `/api/info`.
  - If the bump contained a **hub security fix** (the changelog of `crates/wb-hub` or `crates/wb-proto` says so), restart the hub now.
  - Otherwise restart it at a convenient moment.

  The stale banner text says: "hub restart pending: ends all sessions; do it now if this deploy fixed a hub security issue".

---

## 8. Security model

### 8.1 Assets and boundary
- Workbench is a **shell-equivalent surface for the service user on the host**. Every authenticated browser, and every process running as the service user, can run anything that user can.
- The design therefore protects three things:
  1. **the edge:** only users authenticated by the reverse proxy reach wb-web;
  2. **escalation out of the service user's shell:** cards run under `NoNewPrivileges` and cannot reach the user manager;
  3. **availability and integrity** of sessions and of the host's other workloads.

### 8.2 Controls

| Threat | Control |
|---|---|
| Internet → wb-web | An authenticating reverse proxy (OIDC) sits in front and sets a shared secret header, which wb-web compares in constant time (`subtle`). The source IP must be the proxy's address. Host and Origin checks. The host firewall admits only the proxy's address to the listen port (§3.6). |
| Other local users → wb-web | The source-IP check (loopback is rejected) plus the secret. hub.sock and web.sock are 0600 with SO_PEERCRED. |
| Cross-site → public origin | `SameSite=Lax` cookie; Origin required on upgrades and mutations; no CORS |
| Stored XSS from board, notes or agents | F-A8 sinks fixed; `web` nodes restricted to http(s) and lose `allow-same-origin`; artifacts are opaque-origin `srcdoc` frames with a restrictive CSP. The main page keeps no `script-src` (inline handlers), so F-A8 and N31-N33 are the regression guard. |
| Synced board → command execution | Nothing auto-runs (§3.4.1): `cmd`/`env` are honoured only on explicit spawn actions in this page (T-S17, N30) |
| Card → root | `NoNewPrivileges` (sudo and setuid wrappers fail); `/run/user` inaccessible (no `systemctl --user` or D-Bus escapes); `~/.ssh` and the systemd user-unit dirs read-only in both units |
| Card → other sessions or workloads | Child `oom_score_adj` 800; slice `MemoryMax=20G` without `MemoryHigh`; `OOMPolicy=continue`; group kill on agent exit |
| Secrets | The hub env holds no secrets, and the child env is built from scratch (§3.7.3, T-S14). The web's secrets come from `LoadCredential`. The proxy secret is a per-request `{env.*}`, never an adapt-time `{$VAR}`. |
| Malformed peers (agents, browsers, hub clients) | Line caps, tolerant agent reader, per-route WebSocket caps, byte-capped queues, per-session panic isolation, quarantine, fail-closed journal |

---

## 9. Test strategy and acceptance criteria

### 9.1 Layers

| Layer | Runs in | Owner (file) | Gate |
|---|---|---|---|
| Rust unit tests, including the `derive` table, the floor `check()` table, VT fixtures, fold/replay/journal, parsers (golden files from the Python prototype) | `nix flake check` → `package` | each crate's work package | every merge |
| Hub integration (`crates/wb-hub/tests/{pty,acp}.rs`, real binary, `wb-fake-acp`) | `package` | hub work packages | every merge |
| Web integration (`crates/wb-web/tests/*`, real binary, fake hub) | `package` | web work packages | every merge |
| `clippy -D warnings`, `fmt --check` | `clippy`, `fmt` | – | every merge |
| Black-box conformance (`tests/test_daemon.py`, real hub + web via `harness.py`) | `conformance` | web work packages | every merge |
| Security regressions (`tests/test_security.py`, Caddy in the loop) | `security` | nix/test work packages | every merge |
| Frontend (`tests/ui.mts`, headless Chromium, stub agent) | `ui` | frontend work packages | every merge from M1 |
| Module assertions (one valid and four bad configurations, N-11) | `module` | nix work packages | every merge |
| NixOS VM (`nix/vm.nix`) | `vm` (needs kvm) | nix work packages | deploying host's release gate |
| Adapter probe against the stub (`lib.adapterCheck`, N-9) | `adapters` | M3-N | every merge |
| Real adapters, offline (`lib.adapterCheck`) | a downstream flake check | M3-N | every adapter or workbench bump |
| Credentialed adapter smoke | manual on the deployment host, `#[ignore]` | operator | M3 deploy and each adapter bump |

**Rules.**
- The VM check passes on a fresh home and belongs in a deploying host's explicit list of gated checks.
- No sleeps in tests except the `hang` scenario and the 20 ms holdback; wait on events.
- Sockets live under `$TMPDIR`, and shells come from `$BASH`.
- Tests never hard-code `/run/current-system`.
- Conformance's `session_config` uses the real `/acp` relay, hub and explicit `config` fake-agent scenario: no-config initial options in both info forms, stale-before-bad-option checks, rejected values, grouped/dependent selects, booleans, authoritative whole-list results, hub list and journal replay. `configured_open` proves the initial hello is already configured, dependent options follow input order, opener errors do not fail accepted creation or prevent later entries, and no implicit prompt is journaled.

### 9.2 `wb-fake-acp` scenarios (one Rust stub for every layer, registered as agent `stub`)
- **Hub scenarios** (`basic`, `noise`, `permission`, `permission-reconnect`, `agent-cancels`, `elicitation`, `cancel`, `crash-midturn`, `auth`, `auth-terminal`, `revive-resume`, `revive-load`, `unknown`, `version`, `hang`, `set-mode`, `kill-stubborn`, `replay-large`):
  - `replay-large` and `permission-reconnect` assert **ascending seq order**: the pending event appears at its seq position, followed by every later event.
  - `replay-large` is generated live, not pre-seeded, because its pending request has to be answerable: 200 messages of 20 chunks of 5 KiB (about 20 MiB), a permission after the tenth message, then a thought chunk every 50 ms until it is answered. `permission-reconnect` streams 116 chunks, asks, then streams 80 more, so a fresh session has the request at seq 120 of 200.
  - `auth-terminal`: `session/new` always needs authentication and the only method is `type:"terminal"`, so `acp.authenticate` answers `bad_option` (§3.2.7).
  - `crash-leave-child`: the fake forks `sleep 1000` into its process group and exits. The group is empty after 2 s.
  - `setsid-child`: the fake starts `sleep 1000` in a process group of its own, with no stdio, and exits. That process survives, because the hub kills by process group. The test reaps it.
  - `revive-fail`: both resume and load fail. The result is `setup_error{revive_failed}` and `revivable:false`.
  - Configuration scenarios: `config` handles prompt keywords and sends a `config_option_update` and the full result; `config-result` sends the result alone; `config-error`, `config-malformed`, `config-hang` and `config-exit` exercise agent error, malformed result, timeout and exit handling.
  - These configuration scenarios offer grouped `model` choices `small`/`large`, `effort` choices `low`/`high` (`max` additionally with `large`), and boolean `thinking`. Model changes reset effort to `low`; requesting effort `high` returns `low`, so callers must use the authoritative result.
- **Prompt keywords for ui and VM**, checked in this order: `ask-permission` (permission, then `PONG`), `perm`, `form`, `url`, `tool`, `slow`, `stream`; anything else echoes. Two modes, `loadSession`, `sessionCapabilities.resume`. The first prompt also titles the session (its first line, up to 60 characters), and `session/set_mode` is followed by a `current_mode_update` (the `set-mode` scenario omits it, so the hub's journalling of the mode from the RPC result alone is tested).
  - Policy probe keywords precede the ordinary keywords and send execute requests with empty locations and omp's `{command, timeout, pty, async}` input. `omp-permission cwd` supplies a relative cwd; `omp-permission cd` changes directory, while `omp-permission same-cwd` uses a lexical no-op. `omp-after-cancel` waits for `session/cancel` before asking. `omp-outside-turn` sends its permission after the prompt response; `omp-after-cancel outside` does so after a cancelled prompt response. These provide deterministic in-turn, post-cancel and outside-turn coverage.
  - Default session metadata stays `model: "stub-model"` and select `thinking: "high"` with category `thinking`, as consumed by N78.
- **Harness agents:** `stub` (keyword mode), `omp` (the same fake under the configured key required for execute-policy conformance), `stuck` (`--scenario kill-stubborn`, which ignores SIGTERM and EOF and whose prompts never end), `reconnect` (`--scenario permission-reconnect`) and `config` (`--scenario config`). `stuck` has its own name so that the picker's fuzzy filter still picks `stub`.
- **Mode selection:** `--scenario` comes from argv for cargo tests. Without it, the fake dispatches on prompt keywords. `--record` stays optional.

### 9.3 Security regression list (`tests/test_security.py` unless noted)

| Case | Expectation |
|---|---|
| T-S1-T-S6, T-S8-T-S15 | The baseline regression cases of `tests/test_security.py` (auth floor, peer-cred, env scrub and related cases) |
| T-S7 | An unauthenticated command-execution request → 403; no `pwned` file; hub `list` filtered `kind=="pty"` is empty |
| T-S16 | `POST /api/mv` with dst `~/.ssh/authorized_keys`, `~/.config/systemd/user/x.service` or `~/.local/share/systemd/x`, directly and via a symlinked parent → 400 and no file. VM: the web's `/proc/<pid>/mountinfo` shows `~/.ssh` read-only. |
| T-S17 | `/pty open{id:"ghost", cmd:"touch $TMPDIR/pwned2", env:{BASH_ENV:"$TMPDIR/x"}}` with `spawn` absent or false → `error{code:"not_found"}` with no `hello`, then close 1000; no file; hub `list` has no `ghost`. `/acp open{id:"ghost2", since:0}` without `agent`/`cwd` → exactly one `error{code:"not_found"}`, no `hello`, close 1000; no session in `list`. Both halves also assert that no new child process of the hub exists (read from `/proc`); the control is that T-S22's live agent does show up as a hub child. |
| T-S18 | ui N31: a heading containing `<img src=x onerror=…>` in a notes file renders as text; no script runs |
| T-S19 | ui N32: a `web` node with `javascript:` or `data:` is refused; an http node's iframe has no `allow-same-origin` |
| T-S20 | ui N33: artifact frames are opaque-origin (`origin === 'null'`) and cannot read `document.cookie` of the parent |
| T-S21 | ui N30: a board containing a node with `cmd` and `env`, loaded in a fresh page, spawns nothing (hub `list` unchanged) |
| T-S22 | Incarnation 1 of a session is created and killed with forget; incarnation 2 prompts `ask-permission`. An answer carrying the old epoch → `error{code:"stale"}`. The request is still pending in the hub's `list` (the hub resolves and sends in one step, so this shows the agent got nothing), and only one `permission_resolved` ever appears. The answer with the current epoch ends the turn with `PONG` and exactly one `permission_resolved`, `by:"user"`. |
| T-S23 | Through Caddy: the `ETag` of `GET /api/board` equals the one wb-web sends directly, and a PUT with it gives 204 |
| T-S24 | Direct to wb-web with the floor headers: an `/acp` first message (a valid `open` padded past 9 MiB) and an `/rpc` message past 32 MiB → close 1009, or a reset or EOF as T-S12 accepts, within 15 s (an HTTP status or a still-open socket fails). wb-hub and wb-web keep running, `/api/info` gives 200 and the hub `list` works. |

### 9.4 VM restart-survival test (`nix/vm.nix`)

The test runs numbered steps. The steps this design pins down:
- **Agent:** `stub` from `packages.fake-acp`.
- **Fresh home:** The VM's tmpfiles rules declare the user-owned `~/.local/state/edwin` parent until the Edwin input includes [yathxyz/edwin#9](https://github.com/yathxyz/edwin/pull/9). Without an explicit rule, tmpfiles creates the parent as root and rejects the unsafe ownership transition before creating `edwind/`; an existing user-owned parent on a deployed host masks the bug. The VM provisions its notes tree because it is host data, and checks that edwind starts at boot, both state directories belong to the test user, and the daemon's state directory has mode `0700`.
- **Memory limit:** the base configuration sets `MemoryMax = "400M"` as a plain value (a plain value beats the module's `mkDefault`), and the specialisation uses `mkForce "500M"`; `mkForce` on both is rejected by the unit option type. There is no `MemoryHigh`. The node sets `vm.panic_on_oom = 0`, because the test instrumentation's default of 2 would panic the whole VM at the cgroup OOM step.
- **Step 3:** `wbctl pty-open s1 --spawn`; `wbctl acp-new a1 --agent stub` sends `ask-permission` and waits for the pending permission, recording its `req` and `createdAt`.
- **Step 4 (web restart):** the shell PID is unchanged, and `wbctl pty-attach s1 --resume <stream,out>` gets `resumed:true` and a ring tail without the snapshot prefix. `acp-attach a1` shows the same `createdAt` and exactly the same pending `req`; answering it ends the turn with `PONG` and leaves nothing pending.
- **Step 5 (confinement and environment):** `sudo -n true` fails with "no new privileges", and `systemd-run --user` and `ls /run/user` fail. The web and hub units' mountinfo shows `~/.ssh`, `~/.config/systemd` and `~/.local/share/systemd` with `ro` and `~/.config`, `~/.local` and `~/.local/share` with `rw`; the three writable parents cannot be moved aside (`mv` gives "busy"). The card's environment has none of the canaries (set-environment exports and a variable set only on the hub unit), `CREDENTIALS_DIRECTORY`, `NOTIFY_SOCKET`, `INVOCATION_ID`, `JOURNAL_STREAM` or `XDG_RUNTIME_DIR`. The controls: a login shell as the service user does see the set-environment canaries, and the hub's `/proc/<pid>/environ` holds its own. `oom_score_adj` is 800 for the shell and 100 for the hub. `wbctl api-mv /home/alice/mv-key /home/alice/.ssh/authorized_keys` gives 400 and the source stays put (T-S16).
- **Step 5b (nothing auto-runs):** `wbctl pty-open ghost --cmd …` without `--spawn` gives `not_found` with no `hello` and close 1000, `list` has no `ghost`, and the command did not run.
- **Step 5c (kill-forget, then reopen):**
  - PTY: after `pty-kill k1`, an immediate `pty-open k1 --spawn` gets `new:true` and a different `epoch`.
  - ACP: `wbctl acp-new a2 --agent stub` and one prompt; then `wbctl acp-kill a2 --forget` returns only after the session is gone (no entry in `list`, no `a2.*` files), and an immediate `acp-new a2` gets `status:"new"`, a new `createdAt` and no `prompt` event in its transcript.
- **Step 5d (shell choice):** with `nushell` installed in the VM, `hello.shells` is `["bash","nu"]` with `defaultShell:"bash"`. A card spawned with `shell:"nu"` has `SHELL` set to the resolved nushell path and `WB_SESSION`, and its environment lacks the canaries and `CREDENTIALS_DIRECTORY`.
- **Step 6 (switch to a specialisation):** the hub PID is unchanged. The hub unit now says `RUST_LOG=debug` while the running hub keeps `info` (a switch skips it), and the web was restarted and runs with `debug`. `memory.max` of the slice reads 524288000. The shell is alive, `a1` still answers a permission with the same `createdAt`, and the web's `/api/info` reports `hub.stale:false`, because the specialisation does not change the hub build.
- **Step 7 (OOM):** a card that allocates 1 GiB is killed (`exit.signal == 9`) while the hub stays active with `NRestarts` 0 and the same PID.
- **Step 8 (peer-cred):** chmod the directory to 0755 **and** the socket to 0666; a different user gets zero bytes and the service user gets a hello; restore.
- **Step 9 (hub stop/start):** a third session, `a3`, is left mid-turn with a pending permission. After the stop the unit cgroup is empty and the shell PID is gone. `a1` was idle, so its journal ends with `exit{reason:"hub_restart"}`; `a3`'s last three lines are `permission_resolved{by:"hub"}`, `turn_error{code:"interrupted"}` and `exit{reason:"hub_restart"}`. After the start, a PTY corpse attach shows `MARK1` with `exit.reason=="hub_restart"`, `/api/sessions` shows `a1` as `detached` and `a3` as `error` (until seen), and `a1` revives via `session/resume`.

**Pass criterion for "sessions survive":** steps 4, 6 and 9 all pass in one run. The hub PID is unchanged across 4 and 6, and revive succeeds in 9.

### 9.5 UI checks

Each documented UI check has its own file in [docs/ui-checks/](ui-checks/), named by its check number.
N1-N26 are the baseline checks of the UI suite run by `tests/ui.mts`.
N12-N15 were written anew for M5-F.

### 9.6 v1 acceptance
1. `nix flake check` is green on a kvm-capable host: package, clippy, fmt, conformance, security, ui, adapters, module and vm.
2. The offline adapter check (`lib.adapterCheck`) is green for the configured agents.
3. A deployed instance behind the reverse proxy passes its smoke checks, including:
   - a web restart keeps the shell PID;
   - a Caddy reload keeps the cards connected (`stream_close_delay`);
   - `sudo -n true` fails in a card.
4. The credentialed smoke test on the deployed instance passes for claude, codex and omp, including the claude form elicitation and revive after `systemctl restart workbench-hub`.
5. **Performance budgets**, recorded. The first two are measured on the target host with `wbctl bench` (M1-N), which reaches the instance through the harness's Caddy (`--unix <caddySocket>`) or directly with `--secret-file`; it carries no browser login cookie, so it cannot go through an OIDC-authenticating proxy, and the echo budget needs `--ssh-rtt-ms`:
   - keystroke echo through Caddy is p50 below 1.5× the ssh round-trip time;
   - `yes | head -c 200M` in one card does not raise another card's echo latency above 50 ms p99;
   - opening a board with 30 cards (20 PTY, 10 ACP) reaches all-connected in under 3 s;
   - hub RSS with 30 idle sessions is below 150 MiB.

---

## 10. Build plan

v1 was built in milestones M0 to M5 between 2026-10-11 and 2026-10-19. Their work packages (`Mn-X` in this document: file ownership, interfaces, exit criteria) are history now; they are in `git show 03cad1e:docs/DESIGN.md`, §10.1 to §10.7. The dogfood period that M5's exit started was dropped on 2026-10-16. §10.8 and §10.9 keep their numbers.

### 10.8 Desks: the canvas as a multi-desktop (frontend only, after v1's fixes)
**Goal:** temporary arrangements of cards, switched from the keyboard as desktops are in KDE or i3, without moving anything on the board. Decided by the user on 2026-10-14 from the exploration page "Canvas Desks" (https://claude.ai/artifact/HmeEVCYMGFriqeRT3YTmrh).

**Model.**
- A **desk** is a named arrangement of some cards with a slot (1-8), its own rectangle per member and a layout policy (`free`, `tile`, `columns`). A card can be on several desks. Members are cards or folders; a folder brings its subtree.
- **Desk 0 is the Board**: every card at its node position. Board `nodes` keep only the Board's geometry; desks are records in the board (`desks`, `sticky`).
- **Slot 9 is the attention desk**, a smart desk (`state:bad`, tiled). Other smart desks are queries (`tag:`, `host:`, `kind:`, `board:`); a perspective is a place beside the Board (D3), and the Board stays as made.
- The current desk, the previous desk, the recent-places ring and a camera per desk are per device (F-A22's storage), with a per-window override in `sessionStorage`.

**Decisions (2026-10-14).**
1. The new layer is called **desk**. "Workspace" stays for an entered folder until D2 makes it "open folder as desk".
2. Leader `0`-`9` and `Alt-Shift-0`-`9` go to desks. Top-level folders lose their positional numbers.
3. A new desk is **scratch** (this device only, removed when empty and left) until it is pinned into the board. Pinned desks keep a saved state that revert returns to.
4. On a desk other than the Board, non-members are **hidden**, not dimmed (as a deck's cards are: `visibility: hidden`, so a hidden terminal keeps its size).

**Phases.** Each starts after the previous one's PR is merged.

| Phase | Content |
|---|---|
| D0 | F-A22: per-device view state; a perspective saves the manual layout (N51) |
| D1 | F-A24 (N56): desk records in the board; a desk swap on a Board snapshot, with the serializer writing Board geometry; non-members hidden; the pager in the mode line; leader digits, `` ` ``, `m`/`M` send (and follow), the `d` submap (new, rename, pin, take off, also on, which desks, delete); scratch and pinned lifetimes; new cards join the desk, spawned cards their parent's desks |
| D2 | Promote a card to the Board's place it has on the desk; sticky cards on every desk; the `tile` layout. The overview (leader `g`: arrows move, letters search, digits jump) on far-zoom snapshots; the recent-places ring (leader `w`) over desks, focus tabs and views; the attention desk and pager badges, with the F-A15 key (leader `!`) crossing desks; the scratch overlay on leader `x`. F-A28 (N58); leader `d b` promote, `d s` sticky, `d t` tile, `d o` open a folder as a desk. Perspectives as smart desks moved to D3: it needs the perspective engine to build on a copy instead of the Board's folders |
| D3 | Perspectives as smart desks (they stop rewriting the Board); the `columns` layout; revert; one desk per window (`BroadcastChannel`); `wb desk ls`, `go` and `send` over `web.sock`; the agent tools `list_desks` and `send_to_desk`. F-A29 (N60). A perspective is a place beside the Board rather than a numbered desk, and its engine still builds in the page, only while it is shown; `go_to_desk` was added for `wb desk go`. The query desks of the Model (`tag:`, `host:`, `kind:`, `board:`) were not built here |
| Query desks | F-A38 (N70): the Model's query desks, with `state:` and `name:` too; leader `d q`, the agent tool `query_desk`, `wb desk query`. Board cards only: tasks and notes are brain's |

**Keys** (settled with §6.4; D1 and D2 add them as rows in `web/keys.ts`, and the checker gates them):
- Leader `0`-`9` and Alt-Shift-`0`-`9` replaced the workspace rows (`ws.N`) in D1; Alt-Shift-0 is `M-)`, in `global` and in `TEXT_LEAVES`.
- D1 took leader `` ` ``, `m`, `M` and the `d` prefix (`leader-m`, `leader-M`, `leader-d`, `leader-da`). D2 took leader `g` (overview), `w` (recent places), `x` (scratch overlay), `!`, `m x`, and `d b`, `d s`, `d t`, `d o`; the overview and the ring are transients in `web/keys.ts` that keep every key while open. D3 took `d u` (revert) and `d w` (keep as the saved state); `d t` cycles free, tile, columns. Query desks took `d q`.
- The scratch overlay does not take ``Ctrl-` ``: that key is the dock, and the only key a shell gives up (K2), so it must stay one toggle that works inside a terminal. The overlay goes on leader `x`.
- The F-A15 key (next item that needs attention) is leader `!`; on the canvas `!` stays "fit everything", which is a different context.

### 10.9 Keys: one context per key (frontend only)
**Goal:** every place reachable from the keyboard, and no key with two meanings in one context (§6.4). Decided by the user on 2026-10-14: the leader stays Ctrl-Space; C-k and C-j go to the program in a shell; hints on `f` on the board and leader `;` anywhere; the canvas digits stay free for desks.

| Phase | Content |
|---|---|
| K0 | The measured bugs: board keys taken from a shell (C-k, C-j, C-S-p) or fired twice (Alt-B, Alt-V, Alt-digits, Alt-arrows reached the PTY and the board); the palette's C-j/C-k toggling the dock instead of moving; no key leaving a shell or a page; the leader twice sending nothing to a shell |
| K1 | `web/keys.ts`: the keymaps, the layer walk and one dispatcher in `app.js`; the palette and which-key read their labels from it |
| K2 | The checker: `tests/keys.test.mts`, the flake check `web-keys` (N54 runs it in the page as well) |
| K3 | Coverage: hints (`f`, leader `;`, with the selected card's buttons, and a pipe mode), card actions (`.`), arrange mode (`m`), pan and zoom keys, h j k l and Enter in the graph, the leader through artifacts (N52-N55) |
| K4 | After E2: the board keymaps become Edwin keymaps, so a user's Scheme can rebind them and Edwin frames take the leader the same way (edwind spec R9.7) |

K0-K3 are one pull request. K4 waits for E2 and does not reorder the E phases. K4 is built: F-A37 (N69).
