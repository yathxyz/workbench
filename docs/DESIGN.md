# Workbench: design (v1)

Status: v1 design, 2026-10-11. Workbench runs terminal and AI-agent sessions on a server and presents them as cards on a browser canvas. A long-lived hub process owns the sessions. A restartable web process serves the UI and the API. This document is the binding design for v1: the wire contracts (§3), the component designs (§4-§7), the security model (§8), the test strategy (§9) and the build plan (§10). Where a detail is stated in §3, §3 wins.

References to "the prototype" mean the earlier Python daemon and its single-page frontend, which this design ports and replaces.

**Identifier conventions.**

| Prefix | Meaning |
|---|---|
| `H-n`, `W-n` | Hub (§4) and web (§5) design points |
| `F-An` | Frontend amendments (§6.1) |
| `N-n` | Nix and deploy design points (§7) |
| `T-Sn` | Security regression cases (§9.3) |
| `Nn` | Frontend `tests/ui.mjs` checks. N1-N26 are the baseline checks of that file; N27-N50 are listed in §9.5. |
| `Mn-X` | Build-plan work packages (§10) |

---

## 1. Goal and non-goals

**Goal.** Run one Workbench instance on a server that is good enough to use every day with many agent sessions and shells running at once.
- It answers "which session needs me now?" at a glance, including when the tab is not in front of the user.
- Sessions survive restarts of the web daemon without tmux.
- **Success test:** two weeks of daily dogfooding. Afterwards, any feature that went untouched is a candidate for removal.

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
- multi-host and federation (the protocol stays host-aware);
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
 │          LoadCredential: proxy-secret, anthropic-api-key      shell -i, claude-agent-acp, codex-acp, omp acp          │
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
web/              index.html app.js style.css bridge.js sw.js manifest.webmanifest icon.svg   (vendor/, the font files and fonts/fonts.css are generated by nix, never committed)
tools/            package.json package-lock.json vendor-entry.js build-artifact.py
tests/            harness.py wbctl.py mock_api.py test_daemon.py test_security.py ui.mjs perf.mjs adapter_probe.py caddy/{live,expired,loginpage}.Caddyfile
nix/              package.nix vendor.nix web.nix module.nix checks.nix vm.nix adapter-check.nix
flake.nix flake.lock
```

**wb-proto modules.** Every binary imports these exact names.

| Module | Contents |
|---|---|
| `line` | `encode<T: Serialize>(&T) -> Vec<u8>` (compact JSON + `\n`), `MAX_LINE`, blocking `read_line_capped` for the CLI |
| `hub` | `HubRequest`, `HubMessage`, `SpawnPty`, `SpawnAcp`, `Resume`, `Summary`, `PtyFacts`, `AcpFacts`, `Fault`, `Exit`, `Pending`, `Last`, `AcpSessionInfo`, `PROTO` |
| `journal` | `JournalEvent { seq, ts, body: EventBody }`, with `EventBody` tagged by `e` |
| `state` | `enum State`, `pub fn derive(&Summary) -> State`, and the table tests that define it |
| `websock` | `WbRequest`, `WbMessage` |
| `limits` | every constant in §3.2.9 |

**Serde rules (all wire types).**
- `#[serde(tag = "t")]`, an explicit `rename` per variant, and `rename_all_fields = "camelCase"`.
- Every receiving enum ends with `#[serde(other)] Unknown`.
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
| agent-client-protocol-schema | =1.11.0 | hub dev-dep | `default-features=false`, round-trip conformance |
| tokio-tungstenite, tempfile | 0.29, latest | web dev-deps | test clients |

**Not used:**
- `tower-http`: its mtime-based ETags break on nix store mtime 1;
- `rusqlite`/sqlite: the notes index is in memory;
- `clap`, `cmake`, `hyper`/`tungstenite` directly;
- the `agent-client-protocol` SDK 3.3.0, `portable-pty`, `alacritty_terminal`, `avt`;
- `sd-notify`, `chrono`, `rand`, `nix`, `libc`, `bytes`.

**Toolchain.**
- Nixpkgs `e7439b6b14ad`, with rustc/cargo 1.98.1. The highest MSRV in the tree is 1.89 (uuid).
- Release profile: `panic="unwind"`, `lto="thin"`.
- `#![forbid(unsafe_code)]` in every crate except the one hub module `pty/spawn.rs`. It holds the `pre_exec` closures and makes only async-signal-safe raw syscalls.

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
   `{"t":"hello","proto":1,"server":"wb-hub","version":"0.1.0","build":"<WB_HUB_BUILD>","host":"devbox","pid":1234,"startedAt":…,"agents":[{"name":"claude","label":"Claude"},…],"shells":["bash","nu"],"defaultShell":"bash"}`
   - `build` comes from `option_env!("WB_HUB_BUILD")`. It is absent in local cargo builds.
   - `shells` lists the names of the configured shells that have an existing, executable path when the connection opens (the hub re-checks at each spawn). `defaultShell` is the configured default (§3.7.2).
2. The client answers within `HELLO_TIMEOUT` with `{"t":"hello","proto":1,"client":"wb-web/0.1.0"}`, or it is closed.
3. A `proto` mismatch gives `err{code:"proto"}`, then close.
4. **Additive rule:** `proto` stays 1 while changes are additive. Receivers ignore unknown fields and unknown events. An unknown request gets `err{code:"unknown_type"}` and the connection stays open.
5. **Staleness, computed by the web:** if both sides have a `build`, `stale = hub.build != web.build`. Otherwise `stale = hub.version != web.version`.

#### 3.2.4 Envelope and error codes
- A request carries `rid` (u64, nonzero, unique per connection) and gets exactly one reply: `{"t":"ok","rid":N,…}` or `{"t":"err","rid":N,"code":…,"message":…}`.
- `pty.input` and `pty.resize` have no `rid` and get no reply.
- Events never carry `rid`. An asynchronous error is `{"t":"err","sid":…,"code":…,"message":…}`.

The error codes are a closed set:

| code | meaning |
|---|---|
| `bad_request` | malformed request or a limit exceeded |
| `not_found` | sid unknown, or a `*.open` without spawn fields for an unknown sid |
| `kind_mismatch` | sid exists with the other kind |
| `not_alive` | needs a live process |
| `busy` | an ACP turn is outstanding |
| `already_resolved` | permission or elicitation already answered |
| `bad_option` | `optionId`, `modeId` or `methodId` not offered |
| `not_revivable` | revive impossible |
| `spawn_failed` | spawn or exec failed |
| `agent_error` | the agent returned a JSON-RPC error |
| `timeout` | the agent did not answer `set_mode` within 30 s. (`authenticate` has no separate timer: it runs under the setup idle timeout, §3.2.9.) |
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
    "modeId": "default"
  }
}
```

- **`Exit.reason`:** `"exited"`, `"killed"`, `"hub_restart"` or `"spawn_failed"`. `code` and `signal` are null when unknown.
- **`Pending`:**
  - `kind` is `"permission"` or `"elicitation"`;
  - `req` is the journal seq of the announcing event;
  - `title` is the permission's `toolCall.title` or the elicitation's `message`, cut to 200 characters for both kinds. It is `""` when the request has none.
- **`AcpSessionInfo`:** `{protocolVersion, agentInfo, agentCapabilities, promptCapabilities, authMethods, modes, availableCommands, plan, usage}`, each nullable. It holds the latest materialised values.
- **Incarnation:** a sid can be forgotten and recreated, and `createdAt` distinguishes the incarnations.
  - It is persisted in `<kind>/<sid>.json` and survives hub restarts, revive and PTY respawn.
  - A new value is assigned only when a session is created.

#### 3.2.7 Requests (client to hub)

Every row except `pty.input` and `pty.resize` carries a `rid`.

| t | Fields | ok reply | Semantics |
|---|---|---|---|
| `list` | – | `{sessions: Summary[]}` | every known session |
| `watch` | – | `{sessions}` | then `session` on every Summary change and `gone` on forget |
| `pty.open` | `sid, cols, rows, spawn?: SpawnPty, resume?: {stream, out}` | `{new, pid?, cwd, exit?, epoch, stream, out, resumed, replay?}` | rules below |
| `pty.detach` | `sid` | `{}` | |
| `pty.input` | `sid, d` | – | `d` ≤ 1 MiB. Written completely and in order. If queued input would exceed 8 MiB, the whole message is dropped and the connection gets `err{sid, code:"input_overflow"}`. Input to a dead session is dropped silently. |
| `pty.resize` | `sid, cols, rows` | – | `TIOCSWINSZ` plus the VT resize (§3.4.3). Clamped to cols 2..=1000 and rows 1..=500. Last writer wins. |
| `pty.kill` | `sid, forget` | `{}` | SIGHUP to every member of the PTY's session (/proc stat field 6), SIGKILL survivors after 3 s, close the master. **`forget:false`:** ok when the kill starts. **`forget:true`:** ok only after the exit, the file deletion and the registry removal. Every attached connection, and every watcher, gets `gone`. |
| `pty.capture` | `sid, lines?` (default 200, max 1000) | `{text}` | plain text from the VT state, each row right-trimmed and blank rows after the last text left out; works on dead sessions |
| `acp.open` | `sid, since, epoch?, spawn?: SpawnAcp` | `{new, summary, session, head, from, reset}` | then the replay as `acp.ev`, then `acp.replayed`, then live events. Rules below. |
| `acp.detach` | `sid` | `{}` | |
| `acp.prompt` | `sid, prompt: ContentBlock[]` | `{}` once written | needs `alive` (`not_alive`), `activity=="none"` (`busy`) and no fault (`faulted`). Blocks non-empty, ≤ `PROMPT_MAX`. `image`, `audio` and `resource` need the matching `promptCapabilities`. Journals `prompt`, sets `seenSeq=headSeq`. |
| `acp.cancel` | `sid` | `{}` | sends the `session/cancel` notification when a turn is running, answers every pending request with cancelled (`by:"cancel"`), sets `seenSeq=headSeq`. With no turn and nothing pending it only sets `seenSeq`. |
| `acp.permission` | `sid, req, epoch, outcome` | `{}` | `epoch` mismatch → `stale`. First answer wins; later answers get `already_resolved`. An unknown `optionId` gets `bad_option`. |
| `acp.elicitation` | `sid, req, epoch, response` | `{}` | `epoch` mismatch → `stale`. First answer wins. `content` must be an object of string, number, boolean or string[]. |
| `acp.set_mode` | `sid, modeId` | `{}` after the agent answers (30 s) | `modeId` must be in `availableModes`. Journals `mode{modeId}`. |
| `acp.seen` | `sid, seq` | `{}` | `seenSeq = max(seenSeq, min(seq, headSeq))`, persisted |
| `acp.revive` | `sid` | `{}` once started | only when `!alive && revivable && fault == null`, else `not_revivable`/`faulted`. §3.4.5. |
| `acp.authenticate` | `sid, methodId` | `{}` after the agent answers | only during a failed setup, agent-handled methods only (`type:"terminal"` → `bad_option`) |
| `acp.kill` | `sid, forget` | `{}` | teardown stages in §3.4.5. **`forget:false`:** ok when the kill starts; the session stays revivable. **`forget:true`:** ok only after exit, deletion of `acp/<sid>.*` and registry removal. `gone` goes to attached connections and watchers. |

**Check order.** When a request fails several checks, the first in this list applies:
- `acp.prompt`: `faulted`, `not_alive`, `bad_request` (no ACP session yet), `busy`, then the content rules.
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

**`SpawnAcp`** = `{agent, cwd: absolute existing directory}`.

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
- **Unknown sid:** with `spawn`, create it (`new:true`, `activity:"setup"`; setup runs asynchronously). Without `spawn`: `not_found`.
  - If the agent cannot be executed, the reply is still `ok`. The journal gets only `setup_error{spawn_failed}`, with no `spawn` line, and the session stays dead. A failed `acp.revive` spawn writes the same line and replies `err{code:"spawn_failed"}`.
- **Existing sid:** attach, whether alive or dead. Nothing runs.
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

#### 3.2.10 Hub availability as seen from the web
- The control connection reconnects with backoff: 250 ms doubling to 5 s, with jitter.
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
- **Socket:** `/run/workbench-edit/edit.sock`, created by edwind (`edwin/server/main.mjs`) in the unit's `RuntimeDirectory`; directory 0700, socket 0600, no `SO_PEERCRED` (Node has none): the file permissions admit the same peers, `uid ∈ {geteuid(), 0}`, and edwind refuses to start unless the directory and socket are its own with those modes. NDJSON with the same `MAX_LINE` as hub.sock and web.sock; the messages are those of the edwind spec §7 (`hello`/`welcome`, `open`, `edit`/`ack`/`edits`, `save`, `call`/`result`, `image?`/`image`/`var`, and since E2 `ask`/`answer`, `interrupt`, `display`, `notes`, and the `sample` family wb-web forwards). Every `call` runs on a thread of the server image (edwind spec §4.8): a `call{form}` or a `(:where 'server)` command may block, ask its frame for input, time out (2 s for frames, 30 s for `wb`) or stop in the debugger; `edwin/README.md` Step E2 has the scheduler's rules.
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
pty/<sid>.json                            {sid, shell (name), argv (argv[0] = the resolved shell path), cwd, env (client-supplied only), createdAt, cols, rows, exit|null}
pty/<sid>.snap                            last VT snapshot (on exit, on SIGTERM, every 30 s while dirty)
acp/<sid>.json                            {sid, agent, cwd, createdAt, agentSessionId|null, init|null, seenSeq}
acp/<sid>.jsonl                           journal (§3.4.4)
acp/<sid>.stderr.log[.1]                  agent stderr, rotated at 1 MiB (one generation kept)
<kind>/<sid>.quarantine-<ms>.<ext>        files of a session that failed to load (kept for inspection, never loaded)
```
- The loader considers only `<sid>.json` files whose stem matches the sid regex. Quarantined names contain a dot, so they never match.
- `.json` and `.snap` are written atomically: tmp, fsync, rename, fsync the directory.
- The journal is appended with one `pwrite(2)` per event at the tracked end of its last complete line, never with `O_APPEND`. If a failed append cannot even be truncated away, what is left is a prefix of a line with no `\n`: the next append overwrites it, and the next open truncates it. `fdatasync` runs on `session`, `setup_error`, `turn_end`, `turn_error`, `exit` and SIGTERM.

**Web `stateDir`** (`…/workbench/web`): `web.lock`, `artifacts/<node>/…`, artifact `db.json`. **There is no `index.db`**: the notes index lives in memory.

**Board:** `<boardsDir>/<host>.json` (`~/work/boards/devbox.json`). **Notes:** `notesDir` (`~/work/notes`); reviews go in `<notesDir>/.reviews/<host>.jsonl`.

#### 3.4.3 PTY sessions
- **Spawn:**
  - `openpt(O_RDWR|O_NOCTTY|O_CLOEXEC)`, `grantpt`, `unlockpt`, slave via `ioctl_tiocgptpeer`;
  - tokio `Command` with stdio = slave, `env_clear()` + §3.7.3, and cwd;
  - `pre_exec`: restore the child umask, write `800` to `/proc/self/oom_score_adj`, `setsid()`, `TIOCSCTTY`;
  - argv is the request's `argv` with `argv[0]` replaced by the chosen shell's resolved path (§3.2.7): a single-item `argv` also gets the shell's configured `args` (an interactive, non-login start), and `[shell, "-c", cmd]` runs `cmd`;
  - the shell name is persisted in `pty/<sid>.json`. A respawn without `shell` uses it. A `shell` that names another shell wins and is persisted;
  - reaped by `Child::wait()` (pidfd).
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
| `elicitation` | `request` (verbatim params) | `elicitation/create` arrived; `req` = seq |
| `elicitation_resolved` | `req, response, by` | the answer was sent |
| `elicitation_complete` | `elicitationId` | `elicitation/complete` arrived (url mode) |
| `mode` | `modeId` | `session/set_mode` succeeded |
| `notice` | `level, text` | hub notes: the revive method, `agent stderr: <last line>` (≤ 500 characters) for an unclean exit, "agent stopped after failed setup", and the fault probe's `warn` |
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
   "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"elicitation":{"form":{},"url":{}}}}
  ```
  The response must have `protocolVersion == 1`, else `setup_error{agent_error}`.
- **Setup steps:** `session/new {cwd, mcpServers:[]}`. Each step runs under `SETUP_IDLE_TIMEOUT`.
  - A failed setup ends with `auth_required` and at least one agent-handled auth method (one without a `type`): the agent is kept and waits for `acp.authenticate`.
  - Any other failed setup journals `notice{warn, "agent stopped after failed setup"}` and kills the agent.
  - A setup response that arrives once teardown has started is ignored.
- **Revive:**
  1. `spawn{via:"revive"}` and initialize.
  2. `session/resume` if `sessionCapabilities.resume` is advertised.
  3. Otherwise, or if resume fails, `session/load` when `loadSession` is set. During a load the history-replay variants (`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`) are not journaled. State variants are.
  4. Success journals `session{via}` and a `notice`. If both fail: `setup_error{revive_failed}` and a kill.
  5. `seenSeq = headSeq` at the start.
- **Agent-to-client:**
  - `session/request_permission` and `elicitation/create` are held, with no timeout, until answered by any viewer, by cancel, by the agent's `$/cancel_request` (`by:"agent"`), or by the hub at death.
  - Any other method gets −32601. Unknown notifications are logged and dropped.
- **Facts:**
  - `activity`: `setup` from `spawn`/`authenticate` to `session`/`setup_error`; `turn` from `prompt` to `turn_end`/`turn_error`; otherwise `none`.
  - `pending` = unresolved requests.
  - `last` comes from `turn_end`, `turn_error` and `setup_error`.
  - `title` from `session_info_update`; `modeId` from `session`, `current_mode_update` and `mode`.
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
- **SIGTERM shutdown**, within `TimeoutStopSec=15`. Accepting has stopped first.
  1. Every session actor refuses later requests with `err{internal, "hub stopping"}`.
  2. PTY actors snapshot their screens and SIGHUP their sessions. Agent actors close stdin and, if the agent is still there, send SIGTERM to its group at 5 s and SIGKILL at 6 s.
  3. The hub waits up to 5 s (`HANGUP_WAIT`) for the children to exit. Each exit is recorded with `reason:"hub_restart"` and the real `code`/`signal`.
  4. It then SIGKILLs the PTY sessions that survive and waits up to 3 s (`KILL_WAIT`) for every record to be written. This covers an agent's SIGKILL at 6 s.
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
| `open` | `id, cmd, parent, cwd, cols, rows, env, shell?, spawn: bool, resume?: {stream, out}` | Only the JSON value `true` spawns: `false`, `null`, `"true"`, `1` and an absent `spawn` only attach (M0 treats absent as true, §10). The web ignores `cmd`/`env`/`cwd`/`parent`/`shell` unless `spawn` is true. `tmux` is ignored. A malformed `resume` is dropped. `cols` and `rows` default to 80 and 24. |
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
| `open` | `id, since, epoch?, agent?, cwd?` | `acp.open{sid, since, epoch, spawn: agent && cwd ? {agent, cwd} : absent}` |
| `prompt` | `blocks` | `acp.prompt` |
| `cancel` | – | `acp.cancel` |
| `permission` | `req, epoch, outcome` | `acp.permission` |
| `elicitation` | `req, epoch, response` | `acp.elicitation` |
| `set_mode` | `modeId` | `acp.set_mode` |
| `seen` | `seq` | `acp.seen` |
| `revive` | – | `acp.revive` |
| `authenticate` | `methodId` | `acp.authenticate` |
| `kill` | `forget` | `acp.kill`. With `forget`, the web closes 1000 after the (late) `ok`. |

Server to client:

| t | Fields |
|---|---|
| `hello` | `status: "new"\|"attached", info: AcpInfo, head, from, reset` |
| `ev` | `ev: JournalEvent` |
| `replayed` | `head, truncated` |
| `info` | `info: AcpInfo`. `info.session` is **omitted when unchanged** since the last one sent on this socket. |
| `error` | `error, code, rid?` |
| `gone` | `epoch`, then close 1000 |

`AcpInfo = Summary + {state, session?}`.

**Errors and closes:**
- **Before `open`:** a malformed message, a message that is not `open`, or an id that sanitises to empty gets `error{code:"bad_request"}`, then close 1008. No `open` within `CARD_OPEN_DEADLINE` also closes 1008.
- **After `open`:** a malformed message gets `error{code:"bad_request"}` and is not relayed; a second `open` gets `error` "open was already sent". In both cases the socket stays.
- **Commands are relayed as soon as `open` is sent**, without waiting for its `ok`. If the hub has not answered the open within 10 s, the web closes 1011.
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
- `notes{gen}` whenever edwind reports an index change (edwind spec R11.7), to all clients.

**Frontend rules:**
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
- Body cap: 32 MiB for board and artifact PUT, 1 MiB elsewhere.
- No mutation uses GET.
- `?token=` and `X-Token` are accepted and ignored.

| Endpoint | Contract |
|---|---|
| `GET /api/info` | `{host, home, edit, editUp, sample, models, notes, notesExists, state, dist, tmux:false, artifactOrigin:null, agents:[{name,label}], shells:[name], defaultShell, hub:{status, version, build, proto, startedAt, stale}}`. `edit` is `true` when `web.json` has `frames: true` and an `editSocket` (frames on, edwind spec R9.20: app.js then renders pages through Edwin frames over `/edit`); `editUp` is whether wb-web's own edwind connection is up right now (not cached). `shells` and `defaultShell` come from the hub's `hello`. While the hub is not up, `agents` and `shells` are `[]`, `defaultShell` is `null` (as it is when the hub reports an empty one), and `hub` carries `status` alone, plus `proto` for an incompatible hub (`version`, `build`, `startedAt` and `stale` are `null`). `sample`, `models` and `notesExists` come from edwind's `status` command (cached for 5 s); while edwind is not configured or not up they are `false`, `{}` and `false`. `dist` is `null` until the build artefact arrives. Drops `port`, `artifactPort`, `bind`. |
| `GET /api/sessions` | `{host, sessions: Summary+state}`; 503 when the hub is down or incompatible |
| `GET /api/status` | `{host, time, load, mem:{total, available}, uptime, disk:{total, free}, sessions:{alive, tmux:0, byState}, units, edit}`. Each host figure is `null` if it cannot be read, and `sessions` is all `null` while the hub is not up. `units` is all zeros until M5. `edit` is `{up:true, version, build, clients, buffers, journalBytes, imageGen, loopLagP95Ms, ackP95Ms}` from edwind's `status` command, and `null` while edwind is not configured or not up (edwind spec R15.11). |
| `GET /api/pty/{id}/capture?lines=` | `{id, tmux:false, text}`. `lines` defaults to 200 and is clamped to 1..=1000; a non-integer gives 400 "bad query", and an id that sanitises to empty gives 400 "bad id". Hub `not_found` or `kind_mismatch` → 404; hub down → 503; no hub reply within 10 s → 504; any other hub error → 502. |
| `GET /api/board` | body is the board or `null`. `ETag: "<size>-<mtime_ns>-<ino>"`, or `"empty"` when no file exists. |
| `PUT /api/board` | A body that is not valid JSON → 400 `{error:"invalid JSON: …"}`, before any `If-Match` check. `If-Match` required:<br>- missing → 428 `{error:"If-Match required"}`;<br>- anything but exactly one value equal to the current tag → 412 `{error:"board changed elsewhere", etag}`, with the current tag in the body only. Weak tags, `*`, comma lists and repeated headers are compared as plain strings and never match;<br>- `"empty"` with no file → 204;<br>- `"empty"` with a file → 412.<br>On success: 204 with the new ETag, an atomic write, and `board{etag}` on `/rpc`. Check and write happen under one mutex.<br>**Migration guard (edwind spec R8.20), under the same mutex, whatever the flags say:** when the body is an object whose `nodes` is an object keyed by id, every incoming node whose stored version has `buf` keeps that `buf`, and `text` and `anchors` are stripped from every node that ends up with `buf`; the amended body is what is written and what GET returns. Any other body shape (`{"v":0}`, `null`, an array `nodes`) is written as sent. **First `buf` (R8.19):** when a PUT brings `buf` to a node whose stored version had none and `<boardsDir>/<host>.pre-edwind.json` does not exist, the stored board is copied there (0600) before the write; the copy is never overwritten. |
| `GET /api/ls`, `GET /api/stat` | same shapes. A path is `~`, `~/…` or absolute (anything else is 400), with `.` and `..` resolved lexically. `ls` lists directories first, then by lowercased name, at most 2000 entries: `{path, host, entries:[{name, dir, size, mtime, dev, ino, nlink?, mount?, link?}]}`. |
| `GET /api/cat` | `{path, text, size}`. `limit` default 64000, clamped to 1..=8 MiB. Regular files only, opened non-blocking (a FIFO is refused); a NUL in the first 4000 bytes gives `"(binary file)"` as the text. |
| `POST /api/mv` | `{src, dst}`, both absolute or `~/…`. No-clobber via `renameat2(NOREPLACE)`; `src` is not resolved, and a `dst` that is an existing directory receives the source's base name. **Refuses** with 400 a `dst` in, on or above each entry of `web.json`'s `refusePaths` (the list Nix also writes into `edit.json`, edwind spec R14.8), or without that key `~/.ssh`, `~/.config/systemd` and `~/.local/share/systemd`, as written and with symlinks resolved. The check runs on the path and again on the real path of an `O_PATH` descriptor of the destination's parent, and the rename is made relative to that descriptor, so swapping a path component for a symlink cannot redirect it. Success: `{ok:true, src, dst}`. An existing `dst` → 400 "destination exists"; any other failure (`EROFS`, `EXDEV`, …) → 400 with the OS message. With `editSocket` set the move is edwind's `rename-file` instead (edwind spec R4.49, R6.1), with the paths expanded as above: both ends must be inside edwind's writable paths and out of the refusal list (a source in or above it is refused too), edwind's own directories never move, no-clobber holds by claiming the destination before the rename, and the buffers visiting the file follow it. Success then adds `from` and `to`, the buffer ids of both ends (and `dir: true` for a directory). Refusals stay 400; while edwind is down the answer is 503 and nothing moves. |
| `GET /api/nodes?limit=`, `/api/links`, `/api/cards`, `GET/POST /api/reviews`, `GET /api/tasks`, `GET/POST /api/task/{id}`, `POST /api/journal` (`day` required), `POST /api/notes/append` (`path` and `text` required; `by` defaults to `{kind:"web"}`) | prototype shapes, produced by edwind: each is a `call` over `edit.sock` (`notes-nodes [{limit}]`, `notes-links []`, `notes-cards []`, `notes-reviews []`, `notes-reviews-append [{reviews}]`, `notes-tasks []`, `notes-task [{id}]`, `notes-task-set [{id, kw, set, by:{kind:"frame"}}]`, `notes-journal [{day}]`, `notes-append [{path, text, by}]`) whose `value` is the body. A `result.error` or `error` from edwind maps by code: `bad_request` 400, `no_buffer` 404, `refused_path` 403, anything else 502, with edwind's message; no answer in 10 s is 504. Every one of them is 503 `{error:"workbench-edit is not running"}` while edwind is unreachable (edwind spec R11.8). Without `editSocket` in `web.json` the GET routes keep the empty-`notesDir` stubs and the POST routes are 503. |
| `GET/PUT /api/db/{node}` | prototype shapes |
| `GET /api/proc`, `GET /api/units`, `GET /api/unit/{n}` | read-only |
| `GET/PUT /api/artifact/{node}` | srcdoc versions; `url` always `null`; 409 `{error:{code:'conflict', message, head}}` |
| `POST /api/unit/{n}/{start,stop,restart}` | 403 "unit control is disabled in Workbench; use ssh" |
| `/api/tmux*`, `/api/hosts`, `POST /api/cmd`, `/api/backlinks`, `POST /api/index/rescan`, `POST /api/tasks`, `POST /api/task/{id}/dispatch`, `DELETE /api/artifact/{n}`, `GET /api/journal`, `/mcp` | 404 |
| `OPTIONS`, wrong methods | 405, no CORS headers |

**Stubs before M5:** the artifact, db, proc and unit endpoints return the shapes of no artifacts and an idle host; the notes, task and review endpoints do the same for an empty `notesDir` only while `web.json` has no `editSocket`, and `/api/info` then reports `notesExists:false, sample:false`.

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
  "editSocket": "/run/workbench-edit/edit.sock",
  "frames": false,
  "refusePaths": ["/home/alice/.ssh", "/home/alice/.config/systemd", "/home/alice/.local/share/systemd"]
}
```
- `listen`, `publicOrigin`, `trustedProxy`, `proxySecretFile`, `stateDir`, `webRoot`, `boardsDir`, `notesDir` and `host` are required. `socket` and `hubSocket` default to the values shown.
- **Validation** refuses to start the web when:
  - any path is not absolute, or `socket` or `hubSocket` is 108 bytes or longer;
  - `host` does not match `[A-Za-z0-9][A-Za-z0-9._-]*` (it names the board file);
  - `publicOrigin` is not `scheme://host[:port]` with an http or https scheme, no path, query or user, and no default port (browsers never send it);
  - `editSocket` is present and not absolute, or 108 bytes or longer;
  - a `refusePaths` entry is neither absolute nor `~` or `~/…`.
- `editSocket` absent or `null` means no edwind: the notes endpoints stay stubs, `sample` stays off and `/edit` closes with 1013 (edwind spec R15.5). With it, wb-web keeps one connection to edwind open (`kind: "web"`, reconnecting with backoff) for the notes endpoints, `sample`, `/api/status`'s `edit` block and `/api/info`'s `editUp`, and opens one more per `/edit` WebSocket (§3.3.1).
- `frames` (optional, default `false`; Nix writes `services.workbench.edit.frames`) switches the board's page editor to Edwin frames (edwind spec R9.20). `/api/info` reports `edit: true` only when it is `true` and `editSocket` is set; `/edit` itself relays whenever `editSocket` is set.
- `refusePaths` is the destination list `POST /api/mv` refuses, written by Nix from the same list as `edit.json` (edwind spec R14.8); absent means the built-in three.
- There is no `sample` key: the model backend and its key file are edwind's (`services.workbench.edit.models`, edwind spec R15.6). A config that still carries `sample` fails to load, as any unknown key does.
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
  - a shell name does not match `^[a-z0-9-]{1,32}$` or is listed twice, a shell's `paths` is empty or holds a relative path, or its `args` contain NUL;
  - `defaultShell` is not in `shells`;
  - an environment variable name (in `passEnv`, `setEnv` or an agent's `env`) does not match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`;
  - `passEnv` or `setEnv` names a variable the hub sets itself: `HOME`, `USER`, `LOGNAME`, `SHELL`, `WB_SESSION`, `TERM` or `COLORTERM`;
  - an agent name does not match `^[a-z0-9-]{1,32}$`, or an agent's `argv[0]` is not absolute.

  The hub also refuses to start without `HOME`, `USER` and `LOGNAME` in its environment.
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
- **Desks** (§10.8 D3): `wb desk ls`, `wb desk go N` and `wb desk send N [PATH]... [--keep] [--follow]` are the tools `list_desks`, `go_to_desk` and `send_to_desk`, sent as one `cmd` like `wb TOOL`; N is one digit 0-9.

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

**Module tree.** `main`, `config`, `auth`, `static_files`, `http`, `util`, `routes`, `hub`, `info`, `relay_pty`, `relay_acp`, `rpc`, `board`, `fsapi`, `host`, `artifacts`, `sample`, and `notes/`.
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
| W-12 | Stubs before M5 return the empty-`notesDir` shapes with `notesExists:false`. | `notes/mod.rs`, `artifacts.rs`, `host.rs` |
| W-13 | `/rpc` sends `hub{…}`, `board{etag}` and `sessions` on connect, then `session`, `gone{sid, epoch}`, `hub{…}` and `board{etag}`. | `rpc.rs`, `hub.rs` |
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

The amendments below are binding.

| # | Amendment |
|---|---|
| F-A1 | `hello.reset:true` clears the transcript, `pending` **and sets `this.seq = 0`** before the replay |
| F-A2 | Epoch tombstones in `SESS` (§3.5.3). No `rev` field. The card keeps `epoch` and sends it on `open`/`permission`/`elicitation`. |
| F-A3 | Start new session: `kill{forget:true}`, "ending…", wait for close 1000, then open with `since:0, agent, cwd`, ignoring the old epoch's `gone` |
| F-A4 | Close codes per §3.5.4. 1000 is terminal and keeps the card state. An `error` before this connection's `hello` sets a per-connection terminal flag. |
| F-A5 | The composer draft is kept until this tab's `prompt` echo arrives. If a reconnect's replay has no echo, it is restored. |
| F-A6 | PtyBackend: `spawn:true` only for explicit actions (§3.5.1). Reconnect and page-load opens send `spawn:false` with `resume{stream, out}`, and the spawn flag is cleared as soon as an open is sent. `not_found` shows "No session: press Enter to start …". Cards get `goneElsewhere` via `gone`. `resize` is sent only when visible, focused and active. On `resumed:true` the xterm is **not** reset. |
| F-A7 | Camera per device in `localStorage` (`wb-cam-<host>`, try/catch), never saved in the board, so pans don't dirty it. On `/rpc` `board{etag}`:<br>- an etag equal to our last save is ignored;<br>- with a save in flight, check again after it completes;<br>- a clean tab refetches silently and applies the nodes but not the camera;<br>- a tab with unsaved edits shows the conflict bar with counts ("this tab: N changes; server: newer").<br>Board v-field compatibility: the stored `cam` is left untouched on write-back. |
| F-A8 | XSS: the three `innerHTML` sinks reachable from board or notes data become `textContent`/DOM building. `web` nodes accept only `http:`/`https:` URLs, and their iframe loses `allow-same-origin`. |
| F-A9 | Self-hosted fonts per §6.2. The `sw.js` cache is `workbench-shell-v3`. Installing it caches the shell, then reads the cached `fonts.css` and caches every font file it names, so a launch after one visit renders in them offline. Font files are served cache-first, and `fonts.css` stays with the shell (network-first). `index.html` preloads the Regular mono face. Activating deletes every cache with another name. |
| F-A10 | `#add-host` hidden |
| F-A11 | `active{ago}` on every `/rpc` (re)open, on `focus` and on `visibilitychange` to visible |
| F-A12 | Out-of-page signal on the transition to a `bad` state while `document.hidden`:<br>- `document.title` prefix `(N) `;<br>- `navigator.setAppBadge(N)` where supported;<br>- service-worker `showNotification` with `tag: sid`, where `notificationclick` focuses or opens the page and calls `focusOpen(sid)`.<br>Notification permission is requested from a user gesture (first card creation, or the chip menu). Desktop only for v1. |
| F-A13 | Phone mode (`< 700 px`): Attention items and the chip use `focusOpen` (a full-screen card) instead of a canvas pan |
| F-A14 | "Revive all agents" in the hub-restarted toast, plus a `normal` Attention line "N agents detached" |
| F-A15 | The status chip and one key binding cycle through the `bad` items in Attention order, starting after the active card |
| F-A16 | `revivable:false` and dead: the card offers **Start new session** instead of ↻ |
| F-A17 | Prompt cap of 8 MiB of UTF-8 (`PROMPT_MAX`), replacing 30's 1.9M characters |
| F-A18 | `ui.mjs` reads `WB_PLAYWRIGHT` and `WB_HARNESS`. `harness.py` prints JSON (§7). The expired and login-page modes swap Caddyfiles through the Caddy admin socket. |
| F-A19 | URL elicitations show the full origin, never auto-open, and only `https:` is openable |
| F-A20 | No toast about a model at load. When `/api/info.sample` is false, the message is said where a model feature is used (assistant, handwriting, an artifact's `sample`), and it names no provider and no environment variable: the server's `sample` backend is configured on the server, its key kept there |
| F-A21 | Enter on the active card puts the keyboard in it where it stands (a shell's terminal, an agent's composer, a page's text, a web card's address), bringing it into view first when it is off screen, in a closed deck or at far zoom. Shift-Enter opens the card as a focus tab; Enter on a folder still enters it as a workspace |
| F-A22 | The view is per device, like the camera (F-A7): the entered workspace, the focus tabs and the perspective live in `localStorage` (`wb-view-<host>`, try/catch), never in the board. Inside a perspective, a save writes the manual layout (each node's manual folder, rectangle and order, the stashed folders, no derived folders or ghosts), so the board file always holds the manual perspective; a card shown in a focus tab is saved at its place on the canvas, not at the size of the screen. A clean tab inside a perspective that takes another tab's board goes back to manual, takes it, and builds its perspective again. A board saved inside a perspective before this amendment is turned back into its manual layout when it is loaded or taken, and lends its view to a device that has none yet |
| F-A23 | Keys are bindings in the keymaps of `web/keys.js` and nothing else (§6.4). A card that has the keyboard keeps the keys it needs: a shell gets every key but ``Ctrl-` `` (so C-k, C-j, Alt-B, Alt-digits and Alt-arrows reach the program and do nothing on the board), a page leaves only the palette, dock, tree, dictation and view keys. Leader Esc leaves any card with the card still selected, and the leader pressed twice reaches the card (NUL for Ctrl-Space in a shell). An artifact forwards the leader to the board through the bridge (`{t:'key', key:'leader'}`, the leader named in `hello.keys` and in a `{t:'keys'}` message when the user picks another). The palette's C-j/C-k move its selection |
| F-A24 | Desks, phase D1 of §10.8. A desk is a record `{slot, name, members}`: slot 1-8, and each member's rectangle (`[x, y, w, h]`, or null until it is first shown). Pinned desks are in the board (`desks`); scratch desks, the current and previous desk and a camera per desk are in F-A22's view state. On a desk, the Board's folder, rectangle and order of every node wait in a snapshot; members stand at their rectangles (a folder carries what it holds, a member whose folder is not on the desk stands loose) and every other item is hidden as a deck's cards are (`.stashed`: hit tests, layout, neighbours, fit and selection skip it), with its links, the Board's loose ink and the shapes outside the desk's folders (a shape goes with the member folder it lay in on the Board, as a folder drag finds it; a Board arrow shows only with both ends on the desk). An area selection skips hidden ink and shapes. A save writes the Board from the snapshot whichever desk is shown; an item made on the desk goes to the Board with its folder, the card it was spawned from, or the nearest member. Leaving a desk records its rectangles and restores the Board exactly; folder changes made on a desk to items that were on the Board are not kept. A new item joins the desk it is made on; a spawned card joins its parent's desks beside the parent. Desks and perspectives exclude each other: a perspective goes to the Board first, and a desk to the manual perspective. Revealing or focusing a hidden item goes to the Board. A clean tab on a desk that takes another tab's board leaves the desk, takes it, and stands the desk up again (a pinned desk as the board now has it). Leader and `Alt-Shift` `0`-`9` go to desks (9 is kept for D2's attention desk), leader `` ` `` to the previous desk, `m`/`M` send the selection (a move from a desk, a copy from the Board; `M` follows), and `d` opens new, rename, pin, take off, also on, which desks, delete. The keys are rows of `web/keys.js` (F-A23): `desk.N` in the global map (`M-)` … `M-(`, which pages and text fields leave to the board) and the leader, and the leader prefixes `leader-m`, `leader-M`, `leader-d` and `leader-da`. The mode line shows a pager; a scratch desk is in italics |
| F-A25 | Block cards (hypernotes H0, `docs/HYPERNOTES.md`): a ```` ```html {#id} ```` fence in a page can be torn out as an `artifact` node with `block: {page, id}` and a `ref` edge from the page. The node keeps no source or versions; it renders the block in an opaque-origin `srcdoc` frame (no `allow-same-origin`) in both modes, with `sample` and `db` declared, and reloads 400 ms after an edit changes the block. A block without an id gets one in its info string. A missing block or page shows a notice in the card. |
| F-A26 | Touch and the camera. Two fingers move the camera wherever they land, over cards too: the pinch zooms about its midpoint and both fingers pan; while they are down no card scrolls. The second finger takes the camera only when the first holds nothing (a finger that drags a card, a handle or ink keeps it). While a finger is on the canvas, framed cards (web, artifact) take no touches, so a second finger on one still counts; a first finger on a frame stays the frame's. One finger keeps its meaning: bare canvas pans, a card scrolls or drags its own content. A one-finger pan lifted while moving glides on with its last 100 ms speed, decaying with a 325 ms time constant; a finger that rests 50 ms before the lift does not glide. A camera flight follows van Wijk and Nuij's smooth zoom path (the zoom changes at an even rate; a long jump pulls back and comes in again) in 380 ms, and stops where it is at a finger down, a pan or a wheel, running its done step. `prefers-reduced-motion` is read live: no flight time, no glide, no settle. |
| F-A27 | **Edwin frames** (edwind spec §9, R8.16-R8.20, R13.7). `app.js` reads `/api/info.edit` once at boot: `false` keeps the CodeMirror page path unchanged; `true` loads the Edwin runtime from `/edwin/src/` (the 17 files in the order of `edwin/index.html`), fetches the eight shipped Scheme sources from `/edwin/scm/`, and calls `Ed.bootServed` over one `/edit` WebSocket per tab (`device` = `localStorage` `wb-device`, `cid` per tab in `sessionStorage`). A page node then carries `buf` (its file under `notesDir`) and no `text`: a card is an Edwin frame on the shared buffer, made lazily (within the viewport plus one viewport of margin at zoom ≥ 0.45, or focused; at most 24 per tab, least recently drawn unfocused first); otherwise the card shows the 12-line snapshot from the replica text (or the node's cached `snap`); a replica off screen for 5 min is closed. Pages without `buf` are migrated on load through the replica to `notes/<slug>.md` (`-2`, `-3` on a collision with other text; a file with the same text is linked), their anchors re-created as shared markers, one console line per page. Enter focuses the frame, Shift-Enter opens the focus tab, Edwin owns every key but the board leader, leader then Esc returns to the board. Anchors are `meta.anchors` (ink strokes use `ink-<stroke id>`), drawn as chips and ink lines from `frame.lineTop`. `read_node` and `write_page` go through the replica. Sessions `ed-*` are never offered as orphans. The Editor view is a second frame on the same buffer (no CodeMirror mirror). `/edwin/` serves the console (`edwin/console/index.html`); `sw.js` caches the runtime with the shell (`workbench-shell-v4`). `window.__canvas.pageText(id)` is the page text in either mode; `window.__perf.frame` the frame creation timing and live count. Block cards (F-A25) work on frames as on CodeMirror: the fence line carries the tear-out button as a chip, the palette command and `tear_out_block` read the page through the replica, a card's page keeps its replica open while the card is live, and an edit to the replica from any origin (this tab, a tool, another tab) reloads the cards. A page's `snap` is written by the tab that made the edit (by every tab for a disk, server or agent edit), and a tab whose only change is a `snap` takes another tab's board instead of showing the conflict bar |
| F-A28 | Desks, phase D2 of §10.8. **Tile**: a desk's `layout: 'tile'` (leader `d t`, again frees it) puts its top-level items in rows of cells over the screen at zoom 1 (88 % × 86 % of the fit area), the column count whose cells come nearest 3:2, the last row stretched, in reading order from the items' top-left; it retiles when the members change or the window resizes. **Promote** (leader `d b`): the Board's place of the selection, and of what a folder holds, becomes its place on the desk; it leaves its Board folder unless that folder is on the desk, and leaving the desk relays the folders it left and moves the Board's other items off it. **Sticky** (leader `d s`, cards only; `sticky` in the board): the card shows on every desk at its Board place and is in no desk's members; moving it on a desk moves it on the Board. **Open folder as a desk** (leader `d o`): a scratch desk holding just the folder, reused afterwards. **Attention desk** (slot 9): the cards Attention lists as `bad`, tiled, built when entered and kept in no record; new ones join while it is shown, except cards kept in the hidden scratch overlay; it cannot be named, pinned, deleted or sent to, and sending from it copies. The pager shows `9 !` while a card needs a look, and a badge on each desk counts its cards that do. **Leader `!`** (F-A15's key): the next `bad` card after the active one, on the shown desk if it is there, else on the first desk that holds it, else on the Board; items that are not cards stay in the Attention list. **Overview** (leader `g`): every desk (the Board, 1-8, 9 while it has cards) drawn far-zoomed, folders as frames and cards as named boxes; arrows move, letters search card names (matching boxes marked, the selection moves to a desk with a match), Backspace takes a letter back, a digit goes to that desk, Enter goes to the selected desk and, with a search, to its first match; Esc stays. **Recent places** (leader `w`): desks, focus tabs and views, most recent first (12, per device in F-A22's view state); it opens on the previous place; `w`, Tab, ↓, → step on, `W`, Shift-Tab, ↑, ← back, Enter or Space goes, a digit goes to that entry. **Scratch overlay** (leader `x`; leader `m x` puts the selected cards in, again takes them out; per device): its cards are hidden on every desk and the Board; shown, they are laid out in cells over the middle 72 % of the view at reading size (zoom 1 if the view was below 0.75) and raised; hidden, a desk switch, a perspective or another device's board puts them back, and a save writes their places from before. Perspectives stay as they are: making them smart desks moves to D3 |
| F-A29 | Desks, phase D3 of §10.8. **Perspectives as places**: a perspective (leader `v`) is a place beside the Board, `persp:NAME` in the view state. The Board (desk 0) always shows the manual layout: leader `0` from a perspective goes back to it, leader `` ` `` returns to the perspective, the pager shows it as `v NAME` (also while it is the place left last), the ring lists it, and it keeps its own camera. The engine still builds the derived folders in the page, but only while that place is shown: leaving it restores every item exactly (`perspClear`), and a save writes the Board. **Columns**: leader `d t` now steps a desk through free, `tile` and `columns`. On a columns desk the top-level items stand side by side in one row, left to right as they stood, at 86 % of the view's height at zoom 1 and their own width (a third of 88 % of the view up to all of it); selecting a card scrolls along the row just far enough to show its column (after the pointer is up, so a drag never slides); a drag or a width change lays the row out again in the new order. **Revert**: pinning a desk saves its state (`saved`: members, places, layout) in its record; leader `d u` returns the desk to it, leader `d w` makes the desk as it is now the saved state; unpinning drops it. **One desk per window**: a window keeps its desk and previous desk in `sessionStorage` (`wb-desk-<host>`) over the device's; windows of one host tell each other their desk on the `BroadcastChannel` `wb-desks-<host>`. Going to a desk another window shows swaps the two; when two windows come up on one desk, the one opened later goes to the Board; a send to a desk another window shows goes to that window; the scratch desks follow the window that changed them, each window keeping the one it shows. The Board and the perspectives may be in any number of windows; the pager underlines desks shown in another window. **Agents and `wb`**: the board tools `list_desks`, `go_to_desk` and `send_to_desk` (items are node or folder paths, default the selection; `keep`, `follow`), and `wb desk ls`, `wb desk go N`, `wb desk send N [PATH]... [--keep] [--follow]` over web.sock (§3.7.4) |
| F-A30 | Key hygiene. A held leader is one press: its auto-repeat is swallowed by the board's key dispatcher and not forwarded by an artifact's bridge, so holding Ctrl-Space neither passes the key through (F-A23's leader twice) nor reopens the leader. Space held to pan (`pan.hold`) is let go on a window `blur` and when the page is hidden (`visibilitychange`) as well as on its keyup, which never arrives when the key comes up in another window or inside a frame |
| F-A31 | **Right-click** opens the palette as a menu at the pointer (`openPicker(prompt, items, {x, y})`: clamped to the window, no scrim, a press outside closes it; it stays the `palette` transient for the keys) with the actions of what is under it: a card, a folder's tab or deck, a row of the folder tree or of a deck (all resolved through `S.nodes`, so ink strokes and shapes, which carry `data-id` too, are never cards) get `actionsFor(n)`, the list `.` shows too (the header buttons that are not hidden by the `hidden` attribute or by the folder's `.hdown`/`.d-fs` state, Pipe, Tag, Arrange, the card commands, and Delete, which takes a second pick as ✕ takes a second click, since nothing brings a removed card back); an edge label its other types and delete; a shape edit text and remove; anything in the selection the selection's commands (selected ink by the box around it, since strokes take no pointer events); the canvas, a folder's inside and the tree's loose row New page, shell, folder, sketch and browser window ("here": the existing creators with a one-shot place, top-left at the pointer and in the folder under it) and Fit. A shell adds Copy and Paste, an Edwin frame Copy the region and Paste at the click. A right-click selects its card or folder. The browser's menu stays for Shift+right-click, for text fields, selects, contenteditable and links outside Edwin frames, and wherever the menu would be empty (the side pane, the other views); inside a terminal whose program tracks the mouse the event is only prevented, so the program has the button. The menu key and Shift-F10 open it for what has the keys, anchored on it: a terminal or an Edwin frame (the dock's and the Editor view's too), else the selected card on the canvas; a menu key the terminal's program took opens nothing, and does not make the next right-click a keyboard one. Closing the menu gives the keys back to the terminal or frame that had them, unless the pick moved them. A pen's barrel button (button 2) opens it instead of inking; a touch long-press (the browser's own `contextmenu`) opens it when the one-finger pan it started has not moved, and ends that pan |

**ui check amendments.**
- **N8** expects "No session: press Enter" after a wiped `stateDir`, then Enter → `[new shell]` (H-1).
- **N10** uses `active{ago}` ranking.
- **N25** (orphan adopt) attaches without spawn.
- **N23:** a mid-turn hub restart shows `error` (interrupted) until seen, then `detached`.
- **N6** bounds the reconnect delay at **4×** the previous gap, not 2×: with the equal-jitter backoff of §3.5.4, a gap in [d/2, d] can be followed by one in [d, 2d]. It cuts a TCP forwarder that the check owns, in front of the harness's Caddy, because the harness cannot stop wb-web alone.
- New checks N27-N50 in §9.5.
- **Frames mode (F-A27):** the `pages` section of `tests/ui.mjs` runs on both page editors (`WB_FRAMES=1` → harness `--frames`); it reads the page's text through `window.__canvas.pageText(id)` only, and its DOM selectors name behaviour, not the editor (the frame draws `.edwin-frame .ln` lines, the CodeMirror path `.cm-line`).

### 6.2 Look and typography

The look is modelled on an Emacs setup: Modus tinted themes, a monospaced default face, a proportional face only for prose, and flat chrome.

1. **Palettes.** Light is **Modus Operandi Tinted** and dark is **Modus Vivendi Tinted** (Protesilaos Stavrou's modus-themes), using the exact named colours from the upstream source (`modus-operandi-tinted-theme.el` and `modus-vivendi-tinted-theme.el`; the light `bg-main` is `#fbf7f0`). Every existing CSS token is mapped semantically, following Modus's own semantic mappings, for example:
   - `--panel` = `bg-main`; `--bg` and `--panel-2` = `bg-dim`; `--fg` = `fg-main`; `--muted` = `fg-dim`; `--line` = `border`;
   - `--modeline-*` = `bg-mode-line-active` / `fg-mode-line-active` / `border-mode-line-active`;
   - `--active-line` = `bg-hl-line`; `--sel` = `bg-region`; `--link` = the colour of Modus `fg-link`; `--accent` = the `blue-warmer` family, used as the prompt and accent colour;
   - status colours (attention, card state, errors) use the Modus semantic colours (`err` red, `warning` yellow-warmer, `info`/running blue or cyan, `success` green) and their `bg-*-subtle` backgrounds for chips.

   The light/dark mechanism is `prefers-color-scheme` plus the `data-theme` override. There are no other themes.
2. **Terminals and editors.** The xterm.js theme uses `bg-main` and `fg-main`, `cursor`, `bg-region` for selection, and Modus's terminal colours for the 16 ANSI slots. The CodeMirror syntax colours follow Modus's mappings (keyword, string, comment, builtin, function name, variable, constant, type, docstring).
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
| view | the main view | `canvas`, `graph` (maps); `ranger`, `tasks`, `review` (functions with key sequences, tried first, declining what they do not handle) |
| place | board, workspace, focus tab | `board`, `workspace`, `tab` (empty; desks bind here, §10.8) |
| global | everywhere | `global` |

**Rules.** The checker (`WBKeys.check()`, run by `tests/keys.test.mjs` and the flake check `web-keys`) walks every context stack over every key (about 230 stacks and 146,000 lookups) and fails on any of these:
- **K1.** A keymap binds a key once. Behaviour that depends on state is one command that branches (`esc` steps out of the tool, the selection, the focus tab, the workspace, the tag filter, in that order).
- **K2.** A key an interior needs never reaches an outer layer, and a key a shell, page or text field gives up is bound in `global` (else the card lost it for nothing).
- **K3.** Leader Esc is bound to `leave`: one way out of every card. It extends the edwind spec's R9.7 ("Leader then Esc … leaves the card") from Edwin frames to every card.
- No keymap binds a leader choice, and none binds a key the browser keeps (C-w C-t C-n C-S-w C-S-t C-S-n C-TAB C-S-TAB C-<prior> C-<next> C-q and the s- forms).
- With the page's command table: every bound command exists (`KC` in `app.js`; a missing one is also a console error at load, which the ui suite counts).

A fourth rule is a convention, not checked: **K4**, reuse a key across layers when the meanings rhyme (h j k l select a neighbour on the canvas and in the graph, move in arrange mode; `.` is "actions of this" on a card and a graph node).

**Notation.** Edwin's key names, so the same tables can become Edwin keymaps (K4 of §10.9): `C-` `M-` `s-` (Cmd/Super) and `C-S-p` for a shifted Ctrl letter; `RET TAB SPC ESC DEL <left> <f1>`. A shifted digit with a modifier is its symbol (`M-%` is Alt-Shift-5) and a shifted letter is the capital (`M-B`).

**Where keys live.** `web/keys.js` is a module with no DOM: keymaps, interiors, transients, `resolve(ctx, key)`, `leaderResolve`, `whereIs` (the palette's labels), `rows` (which-key) and `check()`. `app.js` keeps one capture keydown listener that computes the context (`keyContext()`), walks `resolve` and runs the command in `KC`. A `cmd()` entry whose keys begin with `@` shows the keys bound to that command, so the palette, which-key and the bindings cannot disagree. New keys (desks included) are rows in `keys.js`; a pull request that adds one runs the checker.

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
  - `LoadCredential=proxy-secret:…`, plus `anthropic-api-key:…` once `sample` ships (M5);
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
| Frontend (`tests/ui.mjs`, headless Chromium, stub agent) | `ui` | frontend work packages | every merge from M1 |
| Module assertions (one valid and four bad configurations, N-11) | `module` | nix work packages | every merge |
| NixOS VM (`nix/vm.nix`) | `vm` (needs kvm) | nix work packages | every milestone |
| Adapter probe against the stub (`lib.adapterCheck`, N-9) | `adapters` | M3-N | every merge |
| Real adapters, offline (`lib.adapterCheck`) | a downstream flake check | M3-N | every adapter or workbench bump |
| Credentialed adapter smoke | manual on the deployment host, `#[ignore]` | operator | M3 deploy and each adapter bump |

**Rules.**
- No sleeps in tests except the `hang` scenario and the 20 ms holdback; wait on events.
- Sockets live under `$TMPDIR`, and shells come from `$BASH`.
- Tests never hard-code `/run/current-system`.

### 9.2 `wb-fake-acp` scenarios (one Rust stub for every layer, registered as agent `stub`)
- **Hub scenarios** (`basic`, `noise`, `permission`, `permission-reconnect`, `agent-cancels`, `elicitation`, `cancel`, `crash-midturn`, `auth`, `auth-terminal`, `revive-resume`, `revive-load`, `unknown`, `version`, `hang`, `set-mode`, `kill-stubborn`, `replay-large`):
  - `replay-large` and `permission-reconnect` assert **ascending seq order**: the pending event appears at its seq position, followed by every later event.
  - `replay-large` is generated live, not pre-seeded, because its pending request has to be answerable: 200 messages of 20 chunks of 5 KiB (about 20 MiB), a permission after the tenth message, then a thought chunk every 50 ms until it is answered. `permission-reconnect` streams 116 chunks, asks, then streams 80 more, so a fresh session has the request at seq 120 of 200.
  - `auth-terminal`: `session/new` always needs authentication and the only method is `type:"terminal"`, so `acp.authenticate` answers `bad_option` (§3.2.7).
  - `crash-leave-child`: the fake forks `sleep 1000` into its process group and exits. The group is empty after 2 s.
  - `setsid-child`: the fake starts `sleep 1000` in a process group of its own, with no stdio, and exits. That process survives, because the hub kills by process group. The test reaps it.
  - `revive-fail`: both resume and load fail. The result is `setup_error{revive_failed}` and `revivable:false`.
- **Prompt keywords for ui and VM**, checked in this order: `ask-permission` (permission, then `PONG`), `perm`, `form`, `url`, `tool`, `slow`, `stream`; anything else echoes. Two modes, `loadSession`, `sessionCapabilities.resume`. The first prompt also titles the session (its first line, up to 60 characters), and `session/set_mode` is followed by a `current_mode_update` (the `set-mode` scenario omits it, so the hub's journalling of the mode from the RPC result alone is tested).
- **Harness agents:** `stub` (keyword mode), `stuck` (`--scenario kill-stubborn`, which ignores SIGTERM and EOF and whose prompts never end) and `reconnect` (`--scenario permission-reconnect`). `stuck` has its own name so that the picker's fuzzy filter still picks `stub`.
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

### 9.5 UI checks (N27-N60; N1-N26 are the baseline checks of `tests/ui.mjs`, kept with the §6.1 amendments)

| # | Check |
|---|---|
| N27 | On a `reconnect` card, reload with the permission pending at seq 120 of 200 → exactly 200 items render, equal to those before the reload, with the tool item at index 119 (`before 1..116` ahead of it and `after 117..196` behind it); the permission panel is live, and Allow resolves it `by: user` |
| N28 | Force `hello.reset:true` (hub stateDir wipe + recreate) → the transcript repopulates from seq 1 |
| N29 | A stale tab answers a permission after Start new session in another tab → toast "this request belongs to an ended session"; the new session's agent got nothing |
| N30 | A board with a `cmd`/`env` node loaded in a fresh page → no spawn; the card shows "No session: press Enter" |
| N31 | Notes heading XSS renders as text |
| N32 | `web` node: a `javascript:` URL is rejected; the iframe has no `allow-same-origin` |
| N33 | Artifact frame origin is `null`; the bridge works |
| N34 | Hidden page plus a transition to `waiting_permission` → `document.title` starts with `(1)`, and the SW `showNotification` was called with `tag: sid` |
| N35 | Phone viewport 390×844: tapping the attention item opens the card full screen, and the permission buttons are clickable |
| N36 | Two pages: a pan in A does not dirty A. A moves a card, then B (clean) applies it without a conflict bar and keeps its own camera. B with an unsaved edit shows the conflict bar with counts. |
| N37 | Hub restart with two detached stub cards → "Revive all agents" revives both |
| N38 | Two waiting cards → successive chip clicks focus each in turn |
| N39 | Start new session on a `stuck` card (the `kill-stubborn` scenario) shows "ending…", then a fresh transcript, never "ended elsewhere" |
| N40 | wb-web restart with an open terminal → reconnect with `resumed:true`; the xterm scrollback above the viewport is preserved (H-4) |
| N41 | `/acp` open `not_found` → exactly one socket attempt in 10 s |
| N42 | Typing a prompt, then a wb-web restart before the echo → the draft is still in the composer after reconnect |
| N43 | In both colour schemes, the computed `border-radius` is `0px` on a card, a button, a menu and an input (§6.2) |
| N44 | In both colour schemes, `body`'s background equals the Modus value for that scheme |
| N45 | In both colour schemes, an xterm's theme background equals `bg-main` |
| N46 | `document.fonts.check('13px "JetBrainsMono Nerd Font Mono"')` is true after load |
| N47 | In both colour schemes, no element's computed `box-shadow` has a blur radius above 0 |
| N48 | The new-terminal shell picker lists what `/api/info.shells` lists, and a second terminal defaults to the last choice (§6.3) |
| N49 | With `/api/info.sample:false`, a load shows no toast about a model or an API key, and no `/api` request of the load is refused (the frontend does not call `/api/hosts`, which is 404) |
| N50 | Enter on the active shell card puts the keyboard in its terminal on the canvas; Shift-Enter opens the card as a focus tab |
| N51 | Two browser contexts (two devices). A card shown in a focus tab is saved at its canvas rectangle. A workspace and a focus tab entered in A are not in the board file and not in B, and are back in A after a reload. With A in the tag perspective the board file holds A's manual layout exactly, with no derived node and no view key. B moves a card: A takes it without a bar and stays in its perspective, and B never leaves manual (F-A22) |
| N52 | In a shell card, C-k, C-j, Alt-B, Alt-V, Alt-1, Alt-Shift-5, Alt-← and Esc reach the program and change nothing on the board (palette, tree, dock, view, workspace, leader); ``Ctrl-` `` still toggles the dock from inside it (F-A23) |
| N53 | Leader Esc leaves a shell and a page, with the card still selected and no interior in `keyContext()`; the leader twice sends NUL to the shell; C-k in a page opens the palette. In frames mode (F-A24) the page is an Edwin frame, the `edwin` interior: C-k is Edwin's and the palette stays shut, and leader Esc leaves the frame the same way |
| N54 | `WBKeys.check()` with the page's commands has no error; on the board `f` then a card's label selects it; `m`, `l`, `L` move and resize the card and Esc puts it back; `.` lists its actions; C-j/C-k move the palette selection and leave the dock alone |
| N55 | (demo) The leader pressed inside an artifact frame opens the board's leader and the frame no longer has the keyboard. After the leader is changed to F1 with the artifact open, F1 in it opens the leader, Ctrl-Space and Shift-F1 do not |
| N56 | Desks (F-A24). Leader `m 2` then leader `2` show desk 2 with only its items, a card loose out of its hidden folder, a non-member hidden; the pager reads `0 2*`; the board file keeps the Board's geometry exactly and no scratch desk; the view state holds desk 2 with the moved card's rectangle. `Alt-Shift-0` restores the Board exactly and leader `` ` `` returns to desk 2's rectangles. A card made on the desk joins it and shows on the Board; a card spawned on the Board joins its parent's desk at the same offset. A pinned desk is in the board file and on a second device; that device, on the desk, takes the first device's move without a bar and stays on the desk |
| N57 | A touch screen (demo page). Two fingers on a page zoom the camera; a one-finger pan lifted while moving glides on and one that rested does not; a finger down during a flight stops it short of its target; dragging a card keeps the drawn edges of other cards (the same elements) (F-A26) |
| N58 | Desks D2 (F-A28). Leader `m 3`, `3`, `d t` tile desk 3: its three cards sit in cells that do not overlap. Leader `d b` on one, then `0`: on the Board and in the board file it stands at its desk place, and no sibling lies under it. Leader `d s` makes a card sticky: it shows on desk 3 without being a member, and a move there reaches the Board and the board file (`sticky` lists it). Leader `g` shows the Board first and desk 3; → then Enter goes to desk 3; typed letters mark matching cards. After `Alt-2`, leader `w` lists desk 3 second and Enter returns to it on the canvas. Leader `m x` hides a card; leader `x` shows it inside the view while a save keeps its place; leader `x` again puts it back exactly. A shell that ended puts `9` with a badge in the pager; leader `9` shows it on the tiled attention desk; leader `!` from desk 3 goes to a card that needs a look, shown |
| N59 | `web.sock` (F-A11, W-4). Two tabs, a client on the harness's web.sock: the hello; each tab sends `active{ago:0}` when its `/rpc` opens; the tab focused last runs a `cmd` and the other does not, in both orders on one connection; a tab visible again but unfocused sends the time since it was last used and ranks below the tab used since; the leader closing before it answers gives `page_gone` well before the timeout and the other tab never runs the `cmd`; an unknown tool gives code `tool` |
| N60 | Desks D3 (F-A29). Leader `v t` then `0`: the pager shows `v tag`, the Board's geometry is as before, and leader `` ` `` returns to the perspective. Desk 3 with three cards, leader `d t` twice: columns of one height at zoom 1 that do not overlap, in one row; selecting the last card brings it whole into the view. Leader `d p`, a move, leader `d u`: the card is back at its pinned place. `list_desks` lists desk 3 with its cards; `send_to_desk` puts a card on desk 4; `wb desk ls` over the harness's web.sock prints the same listing. A second window that comes up on desk 3 shows the Board; going to desk 3 there swaps, and the first window shows the Board with desk 3 marked as shown elsewhere; from desk 4, going to desk 3 swaps the two desks |
| N61 | (demo) With the keyboard in a shell, Ctrl held and Space pressed then auto-repeated three times: the leader is open and the shell got no NUL. Space held on the board, then a window `blur`: Space is no longer held (F-A30) |
| N62 | (demo) A right-click on a card's name opens the palette at the pointer with Delete, Tag and Arrange and selects the card; on a folder's name, Free, Workspace and Delete the folder without the hidden reconnect and list buttons; on the canvas, New page/shell/folder here and Fit everything; inside a free folder, New page here makes a page in that folder with its top-left at the pointer. Shift+right-click on the canvas and a right-click in a text field are not prevented and open no palette. Delete from the menu removes the card on the second pick, not the first (F-A31) |
| N63 | (demo) Right-click fixes (F-A31). In a shell card, after a right-click the keys are back in its terminal when the menu is closed by Esc, by a press outside it, or by Copy. With a canvas shell card selected and the keys in the docked terminal, the menu key opens the Terminal menu for the dock (Copy sees the dock's selection), anchored on it. After a Shift-F10 the page did not get, a right-click on the canvas opens Canvas at the pointer. A right-click on selected ink opens Selection. A right-click on the status line is not prevented and opens nothing. In the graph view, `.` with no node selected opens no palette |
| N64 | A save between a page's `GET /api/board` and its `/rpc` subscription (the boot GET answered with the board from before another writer's PUT): the clean page takes the newer board and its tag from the connect snapshot's `board{etag}`, with no bar |

### 9.6 v1 acceptance (all must hold before the dogfood clock starts)
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

### 10.1 Rules for parallel work
- **Worktrees:** every work package (WP) is one git worktree and one branch off the milestone base. The **milestone base** is main after the previous milestone's integration plus that milestone's `-P` package, if it has one.
- **Exclusive file ownership.** Within a milestone, each file belongs to exactly one WP. A file no WP lists is **frozen** for that milestone. If a WP needs a frozen or foreign file changed, it records the request in its pull-request description and the integrator schedules it. It never edits the file itself.
- **Cargo manifests.**
  - M0-A writes every `Cargo.toml` with the **complete** v1 dependency set of §3.1 and commits `Cargo.lock`. Unused dependencies are harmless (`unused_crate_dependencies` is allow-by-default).
  - Afterwards, only a milestone's `-P` package may touch `Cargo.toml`/`Cargo.lock`.
- **Interface-first inside a milestone.** When two WPs share an internal Rust interface (M1-H1 → M1-H2, M3-H1 → M3-H2), the provider's **first commit** is the public signatures with `todo!()` bodies, exactly as listed here. The consumer branches after that commit.
- **Integration order per milestone:** `-P` → hub WPs → web WPs → `-N` → `-F` → the integrator runs the milestone acceptance. Frontend acceptance (ui checks) is evaluated at integration, because it needs the merged binaries.
- **The hub changes only in M0, M1 and M3.** M2 is deployment. M4 and M5 must not touch `crates/wb-hub/**` or `crates/wb-proto/**`, which are covered by `WB_HUB_BUILD`. After the first deployment the hub restarts exactly once, at the M3 deploy.
- **Done means** the WP's listed acceptance tests pass in its worktree (`cargo test -p …`, or the named check), `clippy -D warnings` and `fmt` are clean, and the pull-request description says what changed, which interfaces were touched and what requests are open.

### 10.2 M0: walking skeleton
**Goal:** repo, flake, a hub spawning PTYs, and the web serving the **unchanged** prototype SPA behind the full auth floor, all proven by a VM test.

**Dogfood:** on the target host, `python3 -I tests/harness.py --web-root <web output> --dogfood` (the real home directory and no canaries, but a temp `stateDir` and a fresh `boardsDir`, never the real boards directory) plus `ssh -L 18443:<caddySocket> <host>`, then open `http://127.0.0.1:18443`. The harness prints the socket path in its JSON line and the ssh command on stderr; its Caddy listens only on that 0600 unix socket, so no other local user can reach the injected secret. Terminal cards work, and `kill -HUP <harness>` restarts wb-web while the shells survive. The M0 web treats a missing `spawn` as true, because the unchanged SPA sends none. That is why dogfood uses a fresh board (the nothing-auto-runs rule of §3.4.1 takes effect in M1).

| WP | Owns | Inputs | Outputs | Acceptance |
|---|---|---|---|---|
| **M0-A** workspace + proto (lands first) | `Cargo.toml`, `Cargo.lock`, `.gitignore`, `crates/*/Cargo.toml`, `crates/wb-proto/**`, placeholder `src/main.rs` in wb-hub/wb-web/wb-cli and `crates/wb-hub/src/bin/wb-fake-acp.rs` (each placeholder passes to its crate's owner after merge) | §3.1-§3.3 | `line`, `limits` (all of §3.2.9), `hub` (handshake, `ok`/`err`, `list`, `watch`, `pty.*`, `Summary` with all fields incl. `acp` and `fault`, `SpawnPty`, `Resume`), `websock` (complete §3.3) | `cargo test -p wb-proto`: every JSON example of §3.2/§3.3 round-trips; an unknown `t` → `Unknown`; unknown fields are ignored |
| **M0-B** hub skeleton | `crates/wb-hub/src/**` (except `bin/`), `crates/wb-hub/tests/**` | M0-A | `wb-hub --config`:<br>- full `config.rs` (H-18), `env.rs`, `conn.rs` (hello with `build`, peer-cred, OutQ, 8 in flight);<br>- in-memory `registry.rs`;<br>- `pty/{mod,spawn,io,out}.rs` with the UTF-8 decoder and the ring;<br>- `list`, `pty.open` (spawn / attach with `replay` = whole ring), input, resize, kill (forget ok-after), `gone`;<br>- SIGTERM → SIGHUP the PTYs, exit.<br>No vt100, no persistence, no ACP. | `tests/pty.rs`: spawn+echo; second connection attaches and its replay contains `MARK`; kill-forget then reopen gives a new `createdAt`; env canaries absent; a different uid gets 0 bytes (`unshare -U`, skip if unavailable); a 16 MiB+1 line closes the connection |
| **M0-C** web skeleton | `crates/wb-web/src/**`, `crates/wb-web/tests/**` | M0-A | - full `auth.rs` (§3.6) and security headers, `static_files.rs` (in memory, sha256 ETag), `http.rs`, `config.rs` (§3.7.1);<br>- `routes.rs`, with every other module present as a stub exposing `routes()` (stubs return §3.5.5's empty shapes, unit control 403, tmux 404) plus `notes::exists()` and `sample::enabled()`;<br>- `hub.rs` (control connection, hub status), `relay_pty.rs` (absent `spawn` = true), `/rpc` sending `hub{…}`, `/acp` → 404;<br>- board GET/PUT last-writer-wins (returns an ETag, `If-Match` optional);<br>- minimal `/api/info`;<br>- per-route WebSocket caps. | unit: the floor `check()` table (every row of §3.6) and the static ETag; integration with a fake hub: `/pty` open/in/out/exit relay, 1013 when the hub is down, 1009 above 2 MiB |
| **M0-D** nix + test infra | `flake.nix`, `flake.lock`, `nix/**`, `tests/harness.py`, `tests/wbctl.py`, `tests/test_security.py`, `tests/caddy/live.Caddyfile`, `tools/**`, `web/**` (the prototype files imported unchanged), `README.md` | M0-A | - `package.nix` (`out` only), `vendor.nix`, `web.nix` (web + vendor), `module.nix` (both units with full hardening, N-1/N-2, `agents` option, no `tmuxSocket`), `checks.nix` (package, clippy, fmt, security, vm);<br>- `harness.py` (JSON line, `--dogfood`, SIGHUP restarts the web);<br>- `wbctl.py` (`pty-open [--spawn]`, `pty-attach [--resume]`, `sessions`, `raw`);<br>- VM subset. | at integration: `nix flake check` green on a kvm-capable host with security T-S1-T-S15 and VM steps 1, 2, 3/4 (PTY only: MARK1 in the replay, same shell PID after a web restart), 5, 8 (0666 socket), 9 (stop half only: the unit cgroup is empty, the shell PID is gone, and the restarted hub has an empty `list`; the corpse and snapshot assertions belong to M1-N) |

**M0 exit:** `nix flake check` is green on a kvm-capable host, and one hour of dogfooding terminals through the harness passes without a lost shell.

### 10.3 M1: terminals solid (this is the first hub that is deployed)
**Goal:** the PTY contract complete: snapshots, persistence, corpses, the ring resume, the resize rules, nothing auto-runs. Frontend fixes 2, 3 and 5, XSS and camera handling, the look and typography of §6.2 (with self-hosted fonts) and shell choice (§6.3). Board `If-Match`, the frontend's `If-Match` and the SW cache bump all ship together here.

**Dogfood:** the harness on the target host for all shell work for at least two working days.

| WP | Owns | Inputs | Outputs | Acceptance |
|---|---|---|---|---|
| **M1-P** proto | `crates/wb-proto/**`, `Cargo.toml`, `Cargo.lock` | M0 | the full PTY part of §3.2 (`resume`, `stream`/`out`, `epoch`, `exit.reason`, `stale`/`faulted` codes) and shell choice (`SpawnPty.shell`, `hello.shells`, `hello.defaultShell`); `state::derive` complete (PTY and ACP rules) with its table tests | `cargo test -p wb-proto`; the derive table covers every row of §3.4.6 including `fault`; the shell fields round-trip |
| **M1-H1** VT + output (pure) | `crates/wb-hub/src/pty/vt.rs`, `crates/wb-hub/src/pty/out.rs`, `crates/wb-hub/tests/fixtures/vt/**` | M1-P | First commit: `Vt::{new(cols,rows), feed(&str), resize(cols,rows), snapshot()->String, capture(lines)->String, to_snap()->Vec<u8>, from_snap(&[u8])->Result<Vt>}`, `OutStream::{new(), push(&[u8])->Option<String>, flush()->Option<String>}`, `Ring::{new(cap), push(&str)->u64, since(u64)->Option<String>, end()->u64}`. Then the implementations: snapshot per §3.4.3 (including focus reporting 1004), shrink rule (H-5), holdback (H-6), `catch_unwind` in `feed`. | unit: fixture round trips (SGR truecolor, wide CJK, a 3000-line scrollback, soft wraps, alt screen with the primary kept, mouse/paste modes); shrink keeps the newest rows; a held escape tail is never split; ring wrap and U+FFFD offsets; `SNAPSHOT_MAX` halving |
| **M1-H2** hub lifecycle | the rest of `crates/wb-hub/src/**` (`main, config, env, procfs, store, outq, conn, registry, shutdown, pty/{mod,spawn,io}.rs`), `crates/wb-hub/tests/pty.rs`, `crates/wb-hub/tests/common/**` | M1-P, M1-H1 signatures | - persistence (`.json`, `.snap`, 30 s timer), corpses, respawn, `resume`, `hub_restart` exits;<br>- quarantine (PTY), panic supervisor and reload with `err{internal}`, poison handling;<br>- sole-viewer size, nudge cancel, fg poll;<br>- SIGTERM sequence (§3.4.5);<br>- shell choice: `shells`/`defaultShell` config, the first existing executable path re-checked at every spawn, `bad_request` for an unknown name, child `SHELL` = the resolved path (ACP agents keep bash's), the shell name persisted in `pty/<sid>.json`;<br>- H-1, H-2, H-3, H-7, H-10, H-13, H-14, H-19 | `tests/pty.rs` inventory of §4 (PTY part), including SIGTERM then restart: the corpse snapshot contains the last output; `kill -9` then restart: snapshot ≤ 30 s stale; shell choice: spawn with `shell:"sh"` shows it in `echo $0`, an unknown name gives `bad_request`, `SHELL` in the child equals the resolved path, a respawn keeps the shell |
| **M1-W1** board + fs | `crates/wb-web/src/board.rs`, `crates/wb-web/src/fsapi.rs`, `crates/wb-web/tests/board.rs`, `crates/wb-web/tests/fsapi.rs`, `tests/test_daemon.py` | M1-P | `If-Match` (428/412/204, `"empty"`), atomic write, `FeedMsg::Board{etag}` on `AppState.feed`; `ls/stat/cat/mv` with the W-6 denylist | unit + integration: ETag rows, a concurrent PUT race (one 204, one 412), `mv` refusals incl. a symlinked parent, `EXDEV`→400; `test_daemon.py` board and fs sections against harness |
| **M1-W2** hub client, relays, feed | `crates/wb-web/src/{main,config,routes,hub,relay_pty,rpc,info,http,util}.rs`, `crates/wb-web/tests/{relay_pty,rpc}.rs`, `crates/wb-web/tests/common/**` | M1-P | - `/pty` per §3.5.1 (absent `spawn` = false, `resume`, `out`, `gone`→1000, `shell` passed through on an explicit spawn only);<br>- `/rpc` feed (`sessions`, `session` + `state`, `gone`, `hub`, `board`);<br>- `/api/info` full (W-7, with `shells` and `defaultShell` from the hub's `hello`), `/api/sessions`, `/api/status`, capture;<br>- `hub.stale` | fake-hub integration: no `SpawnPty` without `spawn`; `resume` passes through; `gone{epoch}`→1000; `board{etag}` reaches two `/rpc` clients; `/api/info.hub.stale` true on a build mismatch; `shell` passes through; `/api/info.shells` comes from the hub |
| **M1-F** frontend | `web/app.js`, `web/index.html`, `web/style.css`, `web/sw.js`, `tests/ui.mjs` | M1-P contract | fixes 2, 3 and 5, F-A4 (PTY), F-A6, F-A7, F-A8, F-A9, F-A10, F-A18; the look and typography of §6.2; the shell picker of §6.3 | at integration: ui baseline checks plus N1-N7, N8 (amended), N11, N16, N30-N32, N36, N40, N43-N48 (N9/N10 are fix 4, owned by M4-F) |
| **M1-N** nix + tests | `nix/**`, `flake.nix`, `tests/harness.py`, `tests/wbctl.py`, `tests/test_security.py`, `tests/caddy/**` | M1-P | - N-3 fonts (the build converts them and generates `fonts.css`; none is committed), N-6 harness JSON + Caddy admin socket + `expired`/`loginpage` Caddyfiles, bash resolution and the `sh` test shell;<br>- N-10 shell options (`services.workbench.shells`, `defaultShell`); `workbench-web` ordered after `network-online.target` (best effort, §7);<br>- `ui` check wiring (`WB_PLAYWRIGHT`, `WB_HARNESS`);<br>- VM: all PTY steps incl. 5b, the PTY kill-forget reopen (5c), resume, the OOM step and the `nu` shell-choice step (§9.4);<br>- T-S16, T-S17, T-S21 hook, T-S23;<br>- `wbctl bench` (echo latency, flood isolation; see §9.6) | at integration: `nix flake check` green incl. `ui` and `vm` |

**M1 exit:** green checks, two days of terminal dogfood without a lost session or a corrupted screen after reattach.

### 10.4 M2: first deployment (terminals)
**Goal:** serve M1 on the target host behind the authenticating reverse proxy, with the shared secret, the firewall rule and the proxy configuration in place (§3.6, §7). There are no workbench code changes. Deployment configuration lives with the deployer, so M2 has no work packages in this repository.

**Dogfood:** daily terminal use through the public origin from desktop and phone.

**M2 exit:** deployed, the performance budgets of §9.6 recorded, and terminals dogfooded for three days.

### 10.5 M3: agent cards end to end (the one planned hub restart)
**Goal:** ACP cards with permissions, elicitation, revive and a fail-closed journal. Frontend fix 1.

**Dogfood:** all agent work moves to Workbench cards.

| WP | Owns | Inputs | Outputs | Acceptance |
|---|---|---|---|---|
| **M3-P** proto | `crates/wb-proto/**`, Cargo files | M2 | the `journal` module (`EventBody`, every row of §3.4.4), the ACP requests and events of §3.2.7/§3.2.8, `AcpSessionInfo` | round-trip tests for every event kind; unknown `e` → `Unknown` |
| **M3-H1** journal, fold, replay | `crates/wb-hub/src/acp/{journal,facts,replay}.rs` | M3-P | First commit: `Journal::{open(path)->Result<(Journal, Vec<JournalEvent>)>, append(&EventBody, ts)->Result<JournalEvent, WriteFault>, sync(), len()}`, `Facts::{default(), apply(&JournalEvent)}`, `replay::scan(path, since, head, pending:&[u64], cap)->Result<Replay>` (a read error must reach the viewer as `err{internal}`, not as an empty transcript); `sync()` returns a `JoinHandle` so that the actor never blocks on the disk. Then: fail-closed append with ftruncate (H-9), torn-tail repair, `Journal::normalise` (startup normalisation, not fsynced: the caller awaits `sync()`), `Facts::revivable` (H-12), ascending pinned ∪ kept (H-8). | unit: journal, facts and replay tests, including write-fault truncation, no seq reuse, ascending order with a pinned event below `from`, `revive_failed` |
| **M3-H2** ACP actor | `crates/wb-hub/src/acp/{mod,rpc,lines,agent}.rs`, `crates/wb-hub/src/{registry,conn,main,shutdown}.rs`, `crates/wb-hub/src/pty/spawn.rs` | M3-P, M3-H1 signatures | setup, prompt, cancel, permission/elicitation (epoch), set_mode, seen, revive, authenticate, teardown (§3.4.5, H-11), fault and probe, quarantine (ACP), `acp.info` coalescing, SIGTERM integration | `cargo test -p wb-hub` unit: `rpc.rs` round-trip conformance (H-17), `lines.rs` |
| **M3-H3** fake agent + ACP tests | `crates/wb-hub/src/bin/wb-fake-acp.rs`, `crates/wb-hub/tests/acp.rs`, `crates/wb-hub/tests/common/**` | M3-P | every scenario of §9.2 plus the prompt keywords | `tests/acp.rs`: every scenario row, "fold == live", hub `kill -9` |
| **M3-W** ACP relay | `crates/wb-web/src/{relay_acp,hub,info,routes}.rs`, `crates/wb-web/tests/relay_acp.rs` | M3-P | `/acp` per §3.5.2 (W-3); agents in `/api/info` | fake-hub integration: spawn fields only with agent+cwd; `info.session` omitted when unchanged; 1000 after kill-forget `ok` and after `not_found`; 1009 above 9 MiB |
| **M3-F** frontend | `web/app.js`, `web/index.html`, `web/style.css`, `tests/ui.mjs` | M3-P contract | fix 1, F-A1, F-A2, F-A3, F-A4 (ACP), F-A5, F-A16, F-A17, F-A19 | at integration: N17-N29, N39, N41, N42 |
| **M3-N** nix + tests | `nix/**`, `flake.nix`, `tests/harness.py`, `tests/wbctl.py`, `tests/test_security.py`, `tests/adapter_probe.py` | M3-P | N-4 (`fake` output, `WB_HUB_BUILD`), N-5, N-9 (`lib.adapterCheck` in `nix/adapter-check.nix`, and `checks.adapters` against the stub); VM ACP steps (3, 4, 5c, 6, and 9 with its third session `a3`); `wbctl acp-*`; the `/acp` half of T-S17, T-S22, T-S24 | at integration: `nix flake check` green |


**M3 exit:** v1 acceptance items 1-4 of §9.6 hold.

### 10.6 M4: attention and multi-device (web, frontend and CLI only; no hub restart)
**Goal:** `wb` from cards via the leader tab, the out-of-page signal, phone routing, bulk revive and the chip cycle.

**Dogfood:** agents are driven from the phone and via `wb` from cards.

| WP | Owns | Inputs | Outputs | Acceptance |
|---|---|---|---|---|
| **M4-W** leader + web.sock | `crates/wb-web/src/{rpc,websock}.rs`, `crates/wb-web/tests/{rpc,websock}.rs` | M3 | leader by `lastActive` (W-4), `cmd` relay, `page_gone`, web.sock with peer-cred | integration: the leader table (A active at T1, B never → A; reconnect keeps the order); `page_gone` on leader loss, never re-sent; a different uid gets 0 bytes |
| **M4-C** CLI | `crates/wb-cli/src/**` | §3.3, §3.7.4 | `wb` per §3.3 and §3.7.4: the board tool commands, without the commands W-14 drops | unit: the argv grammar; integration against a fake web.sock: exit codes 0/1/2, both error messages |
| **M4-F** frontend | `web/app.js`, `web/sw.js`, `web/style.css`, `web/index.html`, `tests/ui.mjs` | M4 contract | fix 4, F-A11, F-A12, F-A13, F-A14, F-A15 | at integration: N9, N10, N34, N35, N37, N38 |
| **M4-N** nix | `nix/module.nix`, `nix/vm.nix`, `nix/checks.nix` | M4-C | `/etc/workbench/bin/wb`; a VM step where a card runs `wb read_node` with a page open (result) and without one (`no_page`, exit 1) | at integration: `nix flake check` green; a deploy shows `hub.stale:false` and an unchanged hub PID |

**M4 exit:** a deploy with no hub restart, and an agent card successfully drives `wb run_in_shell` in the focused tab.

**Built with edwind's EW-M4 (2026-10):** M4-W (`rpc.rs` leader registry, `websock.rs`), M4-C's board tool commands (`wb tools`, `wb TOOL [--json INPUT] [KEY=VALUE]… [KEY:=JSON]… [--timeout S]`; W-14 tools and `create_node kind=agent` are usage errors; no page exits 7), F-A11 and M4-N's VM step (`nix/vm.nix` step 11, with `wbctl page` as the page). F-A12 to F-A15 and their checks (N9, N10, N34, N35, N37, N38) are not part of it.

### 10.7 M5: notes, review, `sample`, artifacts (web and frontend only)
**Goal:** the remaining prototype surface ported. Fix 6 frames.

| WP | Owns | Inputs | Outputs | Acceptance |
|---|---|---|---|---|
| **M5-W1** notes | `crates/wb-web/src/notes/**`, `crates/wb-web/tests/notes.rs`, `crates/wb-web/tests/golden/**` | M4 | the notes surface of the prototype (in-memory index, incremental stat walk, tasks, journal, append, reviews, cards) | golden parser tests from the Python prototype; refresh after an external edit; the web's own writes re-parse |
| **M5-W2** sample | `crates/wb-web/src/sample.rs`, `crates/wb-web/tests/sample.rs`, `tests/mock_api.py` | M4 | the `sample` client (tool rounds, limits, cancel) | integration against `mock_api.py`: verbatim block replay over tool rounds, the enforced limits, cancel |
| **M5-W3** artifacts, db, host | `crates/wb-web/src/{artifacts,host}.rs`, `crates/wb-web/tests/{artifacts,host}.rs` | M4 | srcdoc artifact versions, the 409 shape, `db.json`, read-only proc and units | integration: version conflict 409; db get/put; unit control still 403 |
| **M5-F** frontend | `web/app.js`, `web/bridge.js`, `tools/build-artifact.py`, `tests/ui.mjs` | M4 | fix 6 (srcdoc artifact frames and the bridge) | at integration: N12-N15, N33 |
| **M5-T** conformance | `tests/test_daemon.py`, `crates/wb-web/examples/dump-index.rs` | M5-W1/W2/W3 | `test_daemon.py` complete; `dump-index` | `conformance` green; a one-off parity run of `dump-index` against the Python prototype on a real notes directory (read-only), with any differences recorded |
| **M5-N** nix | `nix/web.nix`, `nix/checks.nix`, `nix/module.nix` | M5-W2/F | `dist/canvas-workbench.html` built; `conformance` with `mock_api.py`; `anthropic-api-key` credential | at integration: `nix flake check` green; deploy without a hub restart |

**Superseded (2026-10-12):** M5-W1 and M5-W2 are not built in Rust. Edwin, run headless as the text daemon edwind, owns the notes index and the `sample` backend instead, with provider-agnostic model backends and keys on the server; pages become files in `notesDir`. The plan is in `edwin/README.md`. M5-W3, M5-F and the parts of M5-T and M5-N that do not depend on W1 and W2 stand.

**M5 exit:** all of §9.6 holds. The **two-week dogfood clock** starts, and it ends with the removal review: every feature untouched in two weeks is listed for deletion (§1).

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
| D3 | Perspectives as smart desks (they stop rewriting the Board); the `columns` layout; revert; one desk per window (`BroadcastChannel`); `wb desk ls`, `go` and `send` over `web.sock`; the agent tools `list_desks` and `send_to_desk`. F-A29 (N60). A perspective is a place beside the Board rather than a numbered desk, and its engine still builds in the page, only while it is shown; `go_to_desk` was added for `wb desk go`. The query desks of the Model (`tag:`, `host:`, `kind:`, `board:`) are not built |

**Keys** (settled with §6.4; D1 and D2 add them as rows in `web/keys.js`, and the checker gates them):
- Leader `0`-`9` and Alt-Shift-`0`-`9` replaced the workspace rows (`ws.N`) in D1; Alt-Shift-0 is `M-)`, in `global` and in `TEXT_LEAVES`.
- D1 took leader `` ` ``, `m`, `M` and the `d` prefix (`leader-m`, `leader-M`, `leader-d`, `leader-da`). D2 took leader `g` (overview), `w` (recent places), `x` (scratch overlay), `!`, `m x`, and `d b`, `d s`, `d t`, `d o`; the overview and the ring are transients in `web/keys.js` that keep every key while open. D3 took `d u` (revert) and `d w` (keep as the saved state); `d t` cycles free, tile, columns.
- The scratch overlay does not take ``Ctrl-` ``: that key is the dock, and the only key a shell gives up (K2), so it must stay one toggle that works inside a terminal. The overlay goes on leader `x`.
- The F-A15 key (next item that needs attention) is leader `!`; on the canvas `!` stays "fit everything", which is a different context.

### 10.9 Keys: one context per key (frontend only)
**Goal:** every place reachable from the keyboard, and no key with two meanings in one context (§6.4). Decided by the user on 2026-10-14: the leader stays Ctrl-Space; C-k and C-j go to the program in a shell; hints on `f` on the board and leader `;` anywhere; the canvas digits stay free for desks.

| Phase | Content |
|---|---|
| K0 | The measured bugs: board keys taken from a shell (C-k, C-j, C-S-p) or fired twice (Alt-B, Alt-V, Alt-digits, Alt-arrows reached the PTY and the board); the palette's C-j/C-k toggling the dock instead of moving; no key leaving a shell or a page; the leader twice sending nothing to a shell |
| K1 | `web/keys.js`: the keymaps, the layer walk and one dispatcher in `app.js`; the palette and which-key read their labels from it |
| K2 | The checker: `tests/keys.test.mjs`, the flake check `web-keys` (N54 runs it in the page as well) |
| K3 | Coverage: hints (`f`, leader `;`, with the selected card's buttons, and a pipe mode), card actions (`.`), arrange mode (`m`), pan and zoom keys, h j k l and Enter in the graph, the leader through artifacts (N52-N55) |
| K4 | After E2: the board keymaps become Edwin keymaps, so a user's Scheme can rebind them and Edwin frames take the leader the same way (edwind spec R9.7) |

K0-K3 are one pull request. K4 waits for E2 and does not reorder the E phases.
