# Edwin

Edwin is an Emacs-like editor with Evil keys and Org, scripted in its own Scheme. It runs in a web page. It is
becoming **edwind**, Workbench's text daemon: one Node service that owns every text buffer on the host. Workbench
page cards then attach to it as Edwin frames, as `emacsclient` frames attach to `emacs --daemon`.

The design and the decisions are in the doc "Edwin as Workbench's text daemon" (decided 2026-10-12): edwind
replaces the notes index and `sample` of M5 (M5-W1, M5-W2), pages are files in `notesDir`, markdown-mode comes
first, undo undoes your own edits, and the runtime is Node.

## TypeScript

edwind (`server/*.mts`) and the suites (`test/*.mts`) are TypeScript that Node 24 runs as it is: Node strips
the types at load, and `tsc -p edwin` (flake check `typecheck`, `--strict`) checks them. The rules that keep
that working:
- **Erasable syntax only** (`erasableSyntaxOnly`): no `enum`, `namespace`, parameter properties or `import =`.
  Stripping then leaves every line and column where it was, so stack traces and `defAt` locations match the source.
- **Class fields are `declare`d** (`declare x: T;`). A plain `x: T;` defines the field at construction and changes
  behaviour.
- **Relative imports name the `.mts` file** (`allowImportingTsExtensions`); type-only imports use `import type`.
- **`any` is marked**: every one carries `// any: <reason>`. Most are the aliases in `main.mts` (`Ed`, `Lisp`,
  `EdBuffer`, `SchemeValue`) for the core in `edwin/src`, which is still JavaScript loaded through `vm`.
- The unit sets `NODE_COMPILE_CACHE` (`CacheDirectory=workbench-edit`), so only the first start after a deploy
  pays for stripping (about 240 ms).

`edwin/src` and `web/` follow in later steps: classic scripts as `NAME.ts`, stripped at build time into `NAME.js`
at the same path.

## Layout

| Path | What |
| --- | --- |
| `src/*.js` | the editor, in the order `index.html` loads it: `scheme` `runtime` `text` `editor-core` `editor-prims` `evil-core` `pool` `complete` `extras` `stack` `ai` `evil-ex` `org` `markdown` `ot` `sync` `display` |
| `scm/*.scm` | the shipped Scheme configuration (`emacs`, `evil`, `org`, `ai`, `init`), also inlined in `index.html` |
| `index.html` | the page: styles, the Scheme blocks and the script tags. It loads `src/*.js` relative to itself, so serving this directory runs it, and a published copy keeps the `src/` paths |
| `src/host-browser.js`, `src/host-node.js` | the host layer (R4.1): storage, the shipped Scheme, page attributes, suspend, clipboard, scheduling. The core reaches the page only through it and through frame objects |
| `test/headless.mts` | loads and boots the editor in Node on `host-node.js` (no page objects exist in the process) and drives it with keys |
| `test/headless.test.mts` | the headless suite: `node --test edwin/test/headless.test.mts`, or `nix build .#checks.x86_64-linux.edwin-headless` |
| `test/scheme.test.mts`, `test/scheme-editor.test.mts` | the Scheme suite: the language, and the editor-level forms. `nix build .#checks.x86_64-linux.edwin-scheme` runs both and the benchmark |
| `test/scheme-bench.mts` | evaluator benchmarks; fails when the shadow stack costs more than 10% (R4.34) |
| `src/ot.js` | the OT library (ops, transform, rebase, undo, markers, hash) shared by edwind and its clients (E1) |
| `server/*.mts` | edwind, the text daemon (E1; see "Step E1" below) |
| `test/ot.test.mts`, `test/ot-sim.mts` | the OT properties with fast-check (`edwin-ot`; needs `NODE_PATH` at `tools/node_modules`) |
| `test/conformance.test.mts`, `test/crash.test.mts`, `test/disk.test.mts`, `test/edit-client.mts` | the edwind gate suites (`edit-conformance`, `edit-crash`, `edit-disk`) and their client |
| `src/display.js`, `test/display.test.mts` | the display seam (DT0, see below): frames with no page, drawn on a cell grid for a terminal or native backend (`edwin-display`) |
| `native/` | `edwin`, the desktop program (DT1 and DT2, see below): a Rust crate with its own Cargo workspace that embeds V8 and these files; `native/js/` is its JavaScript (prelude, host, terminal, window, startup), `native/src/gui/` the window, `native/tests/` its pseudo-terminal and virtual-display suites (`cargo test`) |
| `test/term.test.mts`, `test/native.test.mts` | the terminal encoder and decoder, and the core's seams for the program: files on a disk, exit statuses, input events (`edwin-native`) |

These files came from the published Edwin artifact (version 1791768765, 2026-10-12). From now on this directory is
the source.

## Step E0: the core without a browser (done)

The E0 gate of the edwind spec (§17) passes: `edwin-scheme`, `edwin-headless` with no stubs, and the other checks.

- **Host layer and boot (R4.1, R4.11, R9.1).** `index.html` loads `host-browser.js` first and calls
  `Ed.boot({host, frame})` after all 13 files. Under Node, `require('./src/host-node.js')` gives `createHost` and
  `loadEdwin`; then `Ed.boot({host})`. Boot loads `emacs`, `evil`, `org`, `ai`, `init`, then the user's
  `~/.config/edwin/init.scm` when the host has one. Each shipped file is a feature, so `(require 'org)` does not load it again.
- **Frames (R9.2, headless part).** Page elements are parts of a frame made by `Ed.makeFrame(root, parts)` and read
  with `frame.el(name)`. `selected-frame` is `#f` with no page. Per-frame window trees and minibuffers come with E3.
- **Language (R4.3–R4.10, R4.31–R4.34).** BigInt exact integers, R7RS ports and buffer ports
  (`open-buffer-output-port`), first-class environments, source locations, weak tables, record printers,
  `provide`/`require` over `load-path`, handlers before unwinding, a condition hierarchy, restarts, and a shadow
  stack capped at 10,000 frames.
- **Markers (R6.11, R6.12).** One routine, `shiftMarkers`, moves point and the other windows' points (after
  markers), the mark, Evil's marks and jumps and the temps (before markers) through every change, and undo
  puts back markers a deletion moved. `copy-marker`, `set-marker`, `marker-insertion-type` and the rest work as in Emacs.
- **Hooks (R4.22, R4.23).** `before-change-functions` and `after-change-functions` run for every change, undo
  included; `(edit-origin)` says `local`, `remote`, `server`, `disk` or `agent` (`Ed.withOrigin` sets it). A
  function that signals is reported and removed. Pre-command, find-file, save, kill-buffer, buffer-list-update,
  window-configuration-change and focus hooks are Scheme hook variables.
- **Advice, modes, buffer-locals (R4.24–R4.26).** `advice-add` with all six kinds; `define-minor-mode`,
  `define-derived-mode`; `make-local-variable`, `setq-local`, `defvar-local`, `buffer-local-value`,
  `kill-local-variable`, `default-value`, `put` and `get`.

Choices E0 made where the spec left one open:
- A minor mode's state is in `NAME-enabled` (without `-mode`), not in `NAME`: Edwin Scheme is a Lisp-1, so the
  variable cannot share the command's name. `define-minor-mode` takes `:variable` to name another.
- Called from Lisp with no argument, a mode command turns the mode on; as a command it toggles (as in Emacs).
- Shadow-stack entries are pushed when a compound procedure is entered, not at each call site, to stay under 10%.
- No rationals: `(exact 2.5)` is 2.5. `guard` tests its clauses before unwinding. The watchdog and `quit` are not
  under `error`, so `error?` is false for them and `guard` with `error?` does not catch them.
- `(newline)` stays the editor command from `emacs.scm`, as in Emacs; write a line break to a port with `write-string`.
- Retiring the localStorage stores and the importer (R4.12) wait for served mode (E3); the core already reaches
  storage only through the host.

## Step E1: edwind, the text daemon (done)

`edwin/server/` is edwind: a Node process that loads the core headless, keeps every shared buffer as an Edwin
buffer, sequences edits from any number of clients over `edit.sock`, journals them, saves atomically and watches
the files on disk. `crates/wb-cli` is `wb buf`, `wb eval`, `wb edit` and `wb repl` over the same socket.
`nix/package.nix` installs `share/edwin/{src,scm,server}` and `bin/edwind`; `nix/module.nix` has
`services.workbench.edit.*` and `workbench-edit.service`; `nix/checks.nix` has `edwin-ot`, `edit-conformance`,
`edit-crash` (about thirteen minutes: 1,000 kills) and `edit-disk`; `nix/vm.nix` step 10 covers R16.18's E1 part.

Layout of `edwin/server/`: `main.mts` (config, start, listen, `--check`, `--export`, evaluation, the E1 server
commands), `session.mts` (one client: §7 messages), `sequencer.mts` (rebase, apply, journal, ack, replay, undo),
`buffers.mts` (open, save, revert, disk changes, compaction, index), `journal.mts` (group commit, snapshots, the
image log), `files.mts` (text files, CRLF, atomic save), `paths.mts` (ids and the file authority of R14.8),
`watch.mts` (inotify, the line-then-character diff, the three-way merge), `proto.mts` (constants and field
checks). `edwin/src/ot.js` is the OT library both ends share; `edwin/test/edit-client.mts` is the test client.

Running edwind by hand: `edwind --config edit.json` where `edit.json` has at least `notesDir` (see
`loadConfig` in `main.mts` for the fields of R15.4); the socket's directory must be yours and 0700.

Choices E1 made where the spec left one open, and where it had to deviate:
- **No `--permission` (R14.12).** Node 22 and 24 disable `fsync` and `fdatasync` under the permission model, and the
  journal and atomic save need both (R8.3, R8.7). `bin/edwind` runs with `--disallow-code-generation-from-strings`
  and `--max-old-space-size` (the intrinsics lockdown is in-process, next item); `main.mts` replaces every function of
  `child_process` before anything else runs (`guardProcesses`, R4.45), and the Authority in `paths.mts` is the
  one check on file writes, with the unit's `ProtectSystem=strict` and `ReadWritePaths` behind it. The
  conformance suite checks the flags in effect and the guard (R16.16).
- **No `--frozen-intrinsics` (R14.11), since 2026-10-16.** The flag made the Scheme evaluator 2.3 times slower
  (gen mode, geometric mean of the server bench: 131 ms against 59): V8 leaves its fast paths for every
  object once any property of `Array.prototype` or `Object.prototype` is read-only. `server/lockdown.mts`
  does the flag's work with Node's own lists, in every thread of edwind (`main()`, `worker.mts`, the notes
  thread), except that those two prototypes are sealed, not frozen: they take no new keys and lose none (the
  prototype-pollution case), but an assignment over one of their existing methods is no longer refused. The
  functions they hold are frozen. Iterator and generator prototypes keep read-only data properties instead
  of the flag's override accessors, which cost every for-of loop and generator step. The server thread logs
  `"lockdown":"locked"` on its `listen` line; `test/lockdown.test.mts` is the suite.
- **Stack size.** The Scheme cap of 10,000 frames (R4.34) needs about 7 MiB of JS stack in direct mode (about
  8.4 MiB in E2's generator mode); Node's default reaches about 1,500. E1 sized `--stack-size` from `ulimit -s`;
  since E2 `main.mts` runs the server on a worker thread whose stack it sizes itself (`runInThread`, 32 MiB,
  `EDWIND_STACK_MIB`), so neither `bin/edwind` nor the unit depends on the soft limit. `guard` catches the JS
  stack running out as the `recursion-depth` condition when the stack is smaller than the cap. Browser frames
  keep the browser's depth.
- **Resend acks wait for the disk.** A batch's `(cid, seq)` is recorded when it is applied, but a resend arriving
  before its `fdatasync` returns gets the ack only after it (R7.15 with R8.3). Edits for a batch go to the clients
  attached when it was applied; a client that opens in between gets it from the `open{since}` replay, never twice.
- **Journal `ENOSPC`.** An append that fails rolls the batch back (text, history, version) and refuses the edit
  with `read_only` naming the error; the buffer stays read-only until a save or a restart. A save needs no
  append and clears it. Nothing acked is lost (R16.7). `EDWIND_FAULT=enospc-save|enospc-journal` injects the
  failure for the crash suite; the container has no quota filesystem.
- **A whole last journal line without its newline counts;** a torn one is dropped and logged (R16.6).
- **The watchdog interrupt reports as the `timeout` condition** (R14.13), with the deadline 2 s for frames and
  web, 30 s for `wb`; `server-edit` calls have none.
- **`server-edit-done` and `server-edit-abort`** are E1 server commands that finish a `wb edit --wait` (exit 0,
  saving if modified; exit 1) until frames exist (E3); a kill of the buffer also ends it with 1.
- **`name:` ids** attach to Edwin's own buffers; the server's special ones (`*Messages*`, `*scratch*` and the
  like) open read-only with the reason `server special buffer`. Files outside the writable paths open
  read-only with the reason `outside the writable paths` (R14.9); files over 32 MiB open read-only and
  unjournaled; non-UTF-8 files are `not_text`.
- **Undo.** Undoing one's own batch after a later batch of someone else is done by `OT.undoOps`: the inverse,
  transformed through everything after it, with complete undo pairs cancelled (`undo.of`, `undo.ofCid`), so
  a redo after an undo returns the text. A partial undo says so in `msg` (R6.17). Server undo batches are
  `undo: {g: "undo-…", of, ofCid}`.
- **Markers under concurrency (R16.3).** Markers that no deletion reached agree between every replica and the
  server. A marker at the boundary of a deleted range can legitimately differ by the length of a concurrent
  insert landing at that point: both sides apply Edwin's `shiftMarkers` rule, but see the operations in a
  different order. `ot.test.mts` states the property that holds; the frames' point stays where the user expects.
- **Edwin's key-value store** (`storage`) lives in `stateDir/storage.json`; compaction snapshots the text at the
  start of the retained history; journals compact at 4 MiB or 20,000 lines and after a save.
- **`web.json`** is untouched in E1 (`editSocket`, `refusePaths` and the notes forwarding came with E2, R15.5; the
  `/edit` relay is E3); the module writes `refusePaths` into `edit.json` only. `/api/status`'s `edit` block
  (R15.11) came with E2 as well.
- **VM steps left for later phases:** `wb edit --wait` finished from a frame (E3) and the A7 migration dry run
  (E4). The other R16.18 steps run in `nix/vm.nix` step 10. The security suite's socket cases of R16.12 are in
  `edit-conformance` (start refusal) and the VM (another uid).
- **`CRASH_ROUNDS`** sets the kill count of the crash suite (default 1,000); `OT_RUNS` the fast-check runs
  (default 10,000); `EDWIND_LOG=1` streams edwind's log in the test harness.

## Step E2: the Lisp machine (done)

E2 makes the server image a Lisp machine (spec §4 after E0, §5 sessions, §11, §12, R15.6): the evaluator runs
in generator mode so threads can block, be preempted, time out and stop in a debugger; every `call{form}` and
every `(:where 'server)` command is a thread; the image log replicates definitions to frames; the notes index,
the model layer and processes through the hub are server modules with Scheme primitives. `nix/checks.nix` has
the gates `edit-image`, `edit-notes`, `edit-address`, `edwin-bench` (the evaluator budgets), `edit-lisp`,
`edit-process`, `edwin-pool` and `edit-security`; wb-web forwards the notes endpoints and `sample` over `edit.sock`.

Layout added in E2 (`edwin/server/` unless said): `threads.mts` (the scheduler, held buffers, ask, timers,
blocking primitives; `scm/threads.scm`), `debug.mts` (the debugger, the inspector, apropos, find-definition,
room, list-threads, list-clients, the primitive registry; `scm/debug.scm`), `image.mts` (the image log and its
replication, `*image-log*`), `notes.mts` and `notes-parse.mts` (the notes index on a worker thread;
`scm/notes-syntax.scm` is the grammar), `worker.mts` and `jobs.mts` (the worker pool's Node host, with
`src/pool.js`), `scm/address.scm` (block addresses, R6.14), `process.mts` and `hub.mts` (processes through the
hub; `scm/process.scm`), `wb.mts` (§5 sessions and events; `scm/wb.scm`), `models.mts` (backends,
`http-request`, credentials, `sample`, usage; `scm/models.scm`). Modules install through the extension points
of `main.mts` (`MODULES`, `defineCommand`, `onMessage`, `statusProviders`, `buffers.on`).

The evaluator in generator mode (R4.38, `src/scheme.js`): the same compiler produces generator closures, run
with `yield*`, except for nodes that can call no compound procedure (constants, variable references, lambda,
calls to primitives with such arguments), which stay plain closures marked `.d`; a compound procedure keeps a
`gbody` for the generator path and a plain entry that drives it (`driveSync`), so JS callers (hooks, sort
predicates) still call procedures as functions. A thread yields `Block(promise)` (sleep, ask, join, I/O),
`PREEMPT` (its slice is over) or `Suspend(condition)` (the debugger); `ThreadState` and `switchTo` swap the
shadow stack, the handlers, the restarts and the parameter bindings. `loadEdwin(host, {mode: 'gen'})` selects
it; frames and workers stay in direct mode. Budget: the gen/direct geomean of `scheme-bench.mts` is 1.2x
(limit 3x); the shadow stack costs 8.4% (limit 10%). Both suites of `scheme.test.mts` run in both modes.

Choices E2 made where the spec left one open, and where it had to deviate:
- **Command threads are not preempted but do break.** A command thread (one `call{form}`, one server command)
  runs until it finishes, blocks or passes its deadline (R4.39), letting the event loop run every 20 ms so
  messages are read (interrupt, answer, edits to buffers it does not hold); nothing else runs in those breaks,
  since the thread is queued first again. Background threads get 5 ms slices round robin (R4.40). Deadlines
  count runnable time only: a blocked thread does not spend its 2 s (frames) or 30 s (cli).
- **Held buffers (R4.41).** A thread holds a shared buffer from the moment it edits it or makes it current
  (`set-buffer`, `with-current-buffer`, the call's `buf`) until its next blocking point or its end. Its edits
  (Edwin's edit log entries with origin `local`) are then sequenced as one batch in normal form, attributed to
  the caller (`by` with `via: "server"`, the frame's `cid`, R4.28); client edits to a held buffer wait in the
  sequencer and are rebased after it. A hold longer than 250 ms of runnable time ends the thread with the
  `timeout` condition; what it edited is still sequenced. A server batch (`replaceText`, undo, a second
  thread) on a held buffer first flushes the holder's pending edits, so history stays in rope order; the
  holder may then find its positions moved (recorded choice: holds do not block the server itself).
- **Handlers in direct nodes run in place and cannot block.** A primitive error raised from a `.d` node with
  handlers installed runs the handlers synchronously (R4.31 holds), but a handler that blocks there gets
  `cannot-block`; the generator path has no such limit.
- **The server runs on a worker thread** (`runInThread` in `main.mts`) with `resourceLimits.stackSizeMb` 32, so
  the 10,000-frame cap holds whatever `ulimit -s` is; the main thread relays SIGTERM and SIGINT. Logs are
  written synchronously (`fs.writeSync(2, …)`) because a worker's `process.stderr` is an asynchronous relay.
  `--stack-size` left `bin/edwind` and the test flags; `EDWIND_NO_THREAD=1` runs on the main thread.
- **`timeout` and `thread-cancelled` never enter the debugger**; `quit` and `scheme-interrupt` are passive
  as before. `debug-on-error` defaults to true but applies to commands run for frames only: cli calls
  (R13.10) and background threads report. A thread suspended in the debugger is resumed by `interrupt`
  (`quit`) or `thread-kill` as any other; the debugger drops its session.
- **The abort restart ends a thread with the `aborted` condition** in the call's result (R4.37); `thread-join`
  sees `thread-cancelled`. A mutex a finished thread still holds is released.
- **Tail calls shape the backtrace.** `(define (f x) (car x))` shows only `car` at the signal: `f`'s frame is
  gone, as proper tail calls require. Locals by parameter name are those of live frames.
- **`define-command` accepts `(:where w)` after the interactive clause** (`set-command-where!`, both runtimes).
  `Server.command()` tries the JS server commands, then Scheme commands declared `server` or `both`; an
  interactive spec reads its arguments through `ask` when the call carries none. The image's six `image-*`
  commands are declared `server`. Frames send `call{cmd}` for them in E3 (R4.27); until then a frame that
  invokes one locally gets the E1 behaviour.
- **`ask` kinds** are `string`, `completing` (with `table`), `y-or-n`, `yes-or-no`, `number`, `char`; a cli
  caller gets `user-error` from `read-string` and friends (no minibuffer to ask).
- **Timers (R4.46)** accept seconds, `"N sec|min|hour"` and `"HH:MM"`; idle means no input from any client
  (`server.onInput`); each firing is a background thread named after the function.
- **`make-thread` from a thread run for a frame keeps that frame's `by`,** so a background thread's edits count
  as the frame's; timers' threads are the server's.
- **The primitive registry (R4.48)** is built at runtime: `def` captures each primitive's definer in the server
  image (frames skip it), and the registry reports name, arity, documentation, `where` (`server` for module
  primitives and marked ones, else `both`; no primitive is marked `frame` yet, a deviation to fill as frames
  grow), whether it blocks and its source line. `edwind --config … --primitives` prints it; `describe-function`
  says where a procedure runs. Named server commands and the Scheme commands of `debug.scm` are kept apart
  (`thread-list`/`list-threads`, `apropos-list`/`apropos`, `definition-of`/`find-definition`, `room-info`/`room`).
- **The debugger's keys are server commands** (`debug.scm`: `backtrace-mode`, `inspector-mode`); a frame that
  shows `*Backtrace*` runs them through `call{cmd}` with its point (E3 loads `debug.scm` in frames for the
  modes). `wb` reaches the same through `debugger-state`, `debugger-frames`, `debugger-eval`, `debugger-restart`,
  `debugger-continue`, `debugger-abort`, `inspect`.
- **R4.15 amendment (decided 2026-10-14 in the hypernotes thread, for E3 and later):** forms evaluated in a
  note's environment are not definitional for the image log (not appended, not broadcast). `image.record`
  inspects only the heads of top-level `call{form}` forms, so nothing in E2 conflicts; H1 implements it.
- **The notes index parser runs on a dedicated `worker_threads` worker** (not the pool): `notes-grep` and
  `unlinked-mentions` block the calling thread while it searches (the sync channel remains for callers outside
  a thread). The pool's Node host compiles the lexer from a source string inside the worker and duplicates the
  built-in jobs (deviations recorded in `jobs.mts`).
- **The hub client (`hub.mts`, `server.hub`)** connects to `hubSocket` (default `/run/workbench-hub/hub.sock`,
  DESIGN §3.2.1), answers the hello as `edwind/<build>`, sends one `watch` (R5.7) and keeps the session
  summaries current; it reconnects with the backoff of wb-web (250 ms to 5 s, jitter) and re-attaches live
  processes with `pty.open {resume}` (no spawn). An unreachable hub is logged at debug level only. Conditions
  `hub-error`, `process-error`, `stale-object`, `no-leader` sit under `error`; status gains `hub`, `hubVersion`,
  `hubSessions`.
- **Processes (R4.43–R4.45, `process.mts`, `scm/process.scm`)** are hub PTY sessions with ids `ed-` + 16 base32
  chars; `make-process` takes `:name :command :shell :cwd :env :size :buffer :filter :sentinel :card :noquery`
  (default shell bash if the hub offers it, size 120x40). Output and exit run filters and sentinels on background
  threads, queued per process so chunks stay ordered; insertion at the process mark ignores read-only (as Emacs
  binds `inhibit-read-only`), with `by {kind: "server", thread: "process NAME"}`. `call-process` and
  `shell-command-to-string` use a card-less PTY with `TERM=dumb NO_COLOR=1` (bash, sh, zsh only), strip ANSI and
  CR, and forget the corpse (`pty.kill forget:true`); `:timeout` signals `timeout`. `accept-process-output`
  returns at once when output arrived since the last call (Emacs). `M-x list-processes` is a server command
  rendering `name:*Process List*`. `:card t` is only recorded until EW-M4 (such sessions stay hidden `ed-`
  sessions, R9.22; `server.processes.onCard` is the hook for the board module). `pty.resize` is not sent.
- **The §5 session API (`wb.mts`, `scm/wb.scm`, feature `wb-hub`)**: interned session handles (`eq?`),
  `session-list`, `session-get` (one argument gives the handle, two a field), `card-session` (session or
  process), `card-send`, `card-read` (`pty.capture`, or the Org transcript of an `acp.open` replay),
  `card-interrupt`, `card-kill` (`:force` or `y-or-n-p`), `acp-prompt` and `acp-prompt-async` (mailbox),
  `shell-run` (done when `fg.leader` is seen true after the send, `:timeout` 600 s, returns the output since
  the send). Hooks: `wb-session-exit-functions`, `wb-session-output-functions` (attached only while non-empty
  and viewed, coalesced per 100 ms), `wb-acp-turn-end-functions`, `wb-page-saved-functions`,
  `wb-card-created/deleted/moved-functions` from diffing saves of `<boardsDir>/<host>.json`; card hooks pass
  `(id node-alist)` since card handles need the board family (EW-M4). The primitives live in `edwin/server`,
  not `edwin/src/wb.js` as the spec names, because server-only code lives there. R13.2 (classifying `wb`'s
  session from the hub summary) is not done; `server.hub.sessions` is ready for it. Both suites run against the
  fake hub `test/fake-hub.mts`.
- **The model layer (§12, R14.4–R14.7)** is `models.mts` with `scm/models.scm`. Backends are objects of two
  kinds, the ones the spec names (`anthropic`: Messages API, `x-api-key`; `openai`: chat completions, bearer);
  the default backend `workbench` is `models.anthropic` of `edit.json`, its models the tier values; a backend
  without a credential is usable only on a loopback origin (a local model server). The key is read from
  `$CREDENTIALS_DIRECTORY/NAME` at request time and never stored on the handle; `http-request` takes `:method
  :headers :body :credential :credential-header :timeout :on-chunk`, retries 429/503/529 three times
  (`retry-after`, else 1 s doubling) under a 10 min deadline covering the tool rounds (at most 8). `sample`
  runs on a background thread per stream (`by {kind: "web", cid, device, tab}`), `cancel` interrupts it with
  the `cancelled` condition; four requests run at once and the rest queue (R12.13). One usage line per request,
  success or failure, goes to the log and `stateDir/usage.jsonl`; `model-usage` sums them. The server rebinds
  `gptel-make-anthropic`, `gptel-make-openai`, `gptel-backends` and `gptel-send` that `ai.js` defines for
  frames, since those use `fetch` and browser-stored keys (R14.4). Not in E2: Edwin's built-in tools for gptel
  and the confirmation flow (R12.10–R12.12), `gptel`, `gptel-rewrite` and presets (R12.9) on the server; a
  backend defined in `init.scm` runs before the module loads (define it after, or on feature `models`).
  Thread batches carry an undo group (`undo: {g: "thread-…"}`) so gptel output undoes like any writer's.

## Step E3: frames in the browser (done)

E3 puts Edwin into the page cards (spec §9, §10, R8.16–R8.20, R13.7): with `edit.frames` on, every page card
is an Edwin frame on a shared buffer served by edwind, the buffer the agent tools, the notes index and the
`wb` CLI already share. Nothing moves until the flag is on; with it off the CodeMirror page is as before and
the whole browser suite passes in both modes (`node tests/ui.mjs <root>` and `WB_FRAMES=1 node tests/ui.mjs
<root>`). `nix/checks.nix` gains `edit-anchors`, `edwin-markdown` and `edit-frame`; `ui` and `ui-frames` run the
browser suite in each mode, and the VM test turns `edit.frames` on.

Layout added in E3: `src/sync.js` (the replica client: `Ed.sync`, `Ed.bootServed`), frames in
`src/editor-core.js` (`Frame`, `Ed.makeFrame`, one text-change path `applyOps`) and `src/editor-prims.js`
(frame commands, `Ed.setLeaderKey`, served boot), `src/markdown.js` and `scm/markdown.scm` (markdown-mode),
`server/anchors.mts` (shared anchors and the frame commands), `console/index.html` (the `/edwin/` console),
`web/app.js`'s frames block (lazy frames, keys, migration, R13.7 tools), and in wb-web `relay_edit.rs` (the
`/edit` relay), the `frames` key, `/api/info` `edit`/`editUp`, `/edwin/` static files and the board guard.

The wire (§7, R9.16–R9.17): each tab opens one WebSocket to `/edit`; wb-web opens one Unix connection to
`edit.sock` per tab and copies text frames to lines and lines to frames, parsing nothing. Close codes: 1003 for
a binary frame or a frame holding a newline, 1009 over 16 MiB either way, 1011 when edwind closes, 1012 when
wb-web stops, 1013 with no edwind. The browser sends its own `hello` with `kind: "frame"`.

Frames (R9.1–R9.15): a `Frame` owns its window tree, minibuffer, echo area, input textarea and popups; `E.root`,
`E.sel`, `E.mini`, `E.echo` are accessors onto the selected frame, so a frame-less runtime (edwind, the tests)
keeps one implicit tree. `Ed.makeFrame(el, {buffer, kind: "card"|"console", fontSize})` builds the DOM
(`.edwin-frame > .ed-windows + .ed-echo + .ed-presence + textarea.ed-input`, a menubar for the console) and
injects one stylesheet mapping Edwin's faces and markdown-mode's `--md-*` variables onto the board's tokens,
re-rendering on `data-theme` changes; geometry is read through `getBoundingClientRect` so a frame under the
canvas transform places point and popups correctly. The page keeps a frame only for cards in or within one
viewport of the view at zoom ≥ 0.45, at most 24 (LRU), and shows the first 12 raw lines otherwise; a replica
off-screen for 5 min is closed. Enter on a selected card focuses its frame; inside it every key is Edwin's
except the board leader; leader then Esc leaves (`Ed.hooks.leaveFrame`); Esc alone is Evil's. The mode line
shows `•` (unacked), `⚠ offline`, `⚠ disk` and `⟳` (a pending server call); presence from other writers'
`sel` is drawn with a colour per writer, an agent's cursor fading 5 s after its last edit.

The replica (R6.3–R6.23, §7): every text change goes through `applyOps(b, ops, origin)` (rope, markers, log,
change hooks with `(edit-origin)`, redisplay); local edits are grouped per command (an Evil insert session or a
run of self-inserts shares a group) and sent as one unacked batch with a queue behind it, composed while
waiting; incoming batches are transformed against inflight and queue with `ot.js`, as the `ot-sim` model;
undo on a shared buffer is by group, inverse-transformed through history (`undo: {g, of}`), with the server's
`undo` command as the fallback for groups before the kept history, while local buffers keep snapshot undo.
Hash checks every 50 versions, `bad_edit`, `stale_base`, `read_only`, `slow_client`, `shutting_down` and a
reconnect follow §7; a divergence or a stale base puts the local text in `<name>~offline-<time>`; an image
epoch change hands the unsent batches to the page, which reloads the runtime with them.

Served boot (R4.11–R4.12): `Ed.bootServed({sources, transport, device, cid, pending})` boots from the eight
Scheme files edwind ships (`/edwin/scm/`), never from browser storage (an in-memory store replaces it),
connects, evaluates the user's `init.scm` from the `user-init` command, replays the image (`image?{from: 0}`;
`on-server` forms skipped), defines the server-only primitives as stubs that signal `server-only`, and binds
`wiki-candidates` (`capf-candidates`), `notes-directory`, `wiki-follow-function` and `resolve-ref-function`.
A `(:where 'server)` command runs on the server without blocking the command loop; `M-:` and friends evaluate
on the server in served mode, `M-x eval-in-frame` locally.

Anchors (R9.12): edwind holds a page's anchors as shared `after` markers (an insert at the anchor advances it,
as CodeMirror's `mapPos` did), moved by every sequenced edit, journaled as one `{"t":"a"}` line per change and
after disk batches, relocated after a disk revert by the prefix+quote rule the page used, sent in `meta` with
`ver`. Commands `anchor-add` (returns the id, which may differ from the requested one), `anchor-remove`,
`anchors`; primitives `anchor-add!`, `anchor-remove!`, `buffer-anchors`. Ink strokes are anchored as
`ink-<stroke>`; the page draws chips and ink at `frame.lineTop(pos)`.

markdown-mode (§10): faces `markdown-*` for the parity table, wiki links and block refs (the resolved text
shown except on the point's line), anchors, `key:: value` fields, priorities; task keywords come from ONE
table in `scm/notes-syntax.scm` shared with Org (`notes-set-task-keywords!` changes both); commands
`markdown-outline-enter` (the first RET on an empty item outdents; at level 0 it ends the list),
`markdown-demote`/`promote`, `markdown-todo-cycle` (`C-c C-t`, `S-<right>`/`S-<left>`), folding, `]] [[ gj gk`,
`wiki-follow`, `wiki-copy-ref`, `wiki-capf`, `journal-today`, imenu, `markdown-unlinked-mentions` (server).
Font-lock is incremental: 0.6 ms median per keystroke on a 10,000-line page (budget 2 ms).

Migration (R8.16–R8.20, Q3): with the flag on, a page node without `buf` is migrated once on load to
`notes/<slug>.md` under notesDir (`-2`, `-3`… on a clash), its anchors re-created at their relocated
positions, then `buf` is set and `text`/`anchors` dropped; wb-web's PUT guard keeps `buf` and strips `text`
when an older tab writes the board, and copies the board to `<host>.pre-edwind.json` once before the first
`buf` arrives. The page is held (no frame, no edit) until the board PUT carrying its `buf` is
answered 204, so the file never differs from the text of a board that lost that save; a 412 shows the conflict
bar rather than restarting the migration as R8.17 says.

Choices E3 made where the spec left one open, and where it had to deviate:
- **The focus tab is the enlarged card with its live frame**, not a second frame; the Editor view (Alt-4) is
  the second frame on the same buffer. Font size in cards is fixed at 13 px (no per-card size setting exists).
- **OT undo applies to shared buffers only**; `*scratch*`, `*Messages*` and config buffers keep the snapshot
  undo, so the standalone page and the headless suites are unchanged. Redo is a new plain group with the
  inverse ops transformed through later batches. A thread's edits made for a frame come back as a synthetic
  group `server-<ver>`.
- **A snapshot that arrives while batches are pending is not a loss when its text equals the acknowledged
  text** (edwind restarted without history): the pending batches are resent.
- **The `/edit` relay does not gate on wb-web's control connection**: it connects to `editSocket` and closes
  1013 on failure, so frames are not refused while the control connection backs off.
- **Anchors are `after` markers** (the contract text said `before`; CodeMirror's `mapPos(pos, 1)` behaves as
  `after`). An id already in use yields a server-chosen id; the caller reads it from the result.
- **The board guard treats `buf: null` as absent** and protects only nodes the PUT carries (a deletion stays a
  deletion); the pre-edwind copy is also made when a new node first carries `buf`.
- **`meta` carries `ver`** (not in the §7.3 table) so a frame can map anchor positions through its unacked
  edits. `sel` is sent from the post-command hook, throttled to 50 ms.
- **markdown.scm loads through org.scm's trailing `(require 'markdown)`**, after Org and before `init.scm`;
  Setext headings fold as paragraphs; emphasis markers stay visible as `markdown-markup`.
- **The `(image-server?)` predicate is `#f` in a frame**; `edwin-import-local-config` (importing the old
  browser-stored configuration into `~/.config/edwin/`) is not written: served mode simply never reads it.
- **Notes and files open as pages (decided 2026-10-15, reversing the spec's NG5/D6 as the default opener).** With
  frames on, `noteOpen` (the navigator, tasks, the journal, note ghosts) and `ghostOpen` (file ghosts of this host)
  open an Edwin page card on the file. edwind decides through the server command `visit-id`: the id it would visit
  the file under, or a refusal (the refusal list, not UTF-8, missing), or read-only (outside the writable paths,
  over 32 MiB). A refusal, a read-only answer, a ghost of another host and an edwind that is down keep the Emacs
  card; `open_in_emacs` and the Emacs button still make Emacs cards. A page with a file has an `fsIdent`, so the
  fs perspective shows it under its directory and a drag moves its file.
- **`rename-file` (R4.49, R6.1, R8.1, §7 moved)** is a server command, `[{src, dst}]` as POST /api/mv sends it;
  wb-web's `/api/mv` forwards to it whenever `editSocket` is set (refusals 400, 503 while edwind is down: nothing
  moves behind its back). Both ends pass `checkWrite`, so `/api/mv` is narrower than wb-web's own rule: the source
  may not be in or above the refusal list either, both ends must be in the writable paths, and edwind's own
  directories stay put. Node has no `renameat2`, so the destination is claimed first (an exclusive create, or
  `mkdir` for a directory) and the rename replaces only the claim. Buffers under the source keep their SBuf, jid
  and history and are updated before the first await, so the watcher never sees their files missing (R8.15 for
  renames). The moved records (old id, new id, time, `dir`) live in `index.json`, not only in the `mv` journal
  lines, so they outlive a kill, a compaction and a restart for their 24 h; a directory's record covers the ids
  under it, and an old id is sent on only while nothing is at the old path again. The answer adds `from` and `to`
  (the ids of both ends) for pages whose replicas are closed. No Scheme primitive yet: `rename-file` in a frame is
  still the browser store's.
- **Not in E3**: K4 (Edwin keymaps in the board's conflict checker) waits for the keymaps PR; a display-text
  mechanism in the renderer (block-ref text is a DOM post-pass) and an `imenuItems` hook are left for later.

## Step DT2: `edwin --gui`, a window (in review)

`edwin -g FILE` (or `--gui`) opens Edwin in a window of its own on the Linux desktop. It is the same program, the
same core and the same model frame as `edwin -nw`; only the backend differs. The terminal stays the default, so
`$EDITOR=edwin` in a terminal is unchanged; `EDITOR="edwin -g"` gives a window that blocks until it closes, as
`gvim -f` does. Without a display, or without the system libraries the window needs, `edwin -g` says why and runs
in the terminal; with no terminal either it exits with status 1.

- **The window.** Rust opens it (winit 0.30, X11 and Wayland) before V8 starts. Each redisplay `native/js/gui.js`
  hands the model (DT0's format) to Rust as JSON; `src/gui/` draws it with wgpu (Vulkan, else GL) as one instanced
  pass of rectangles and glyphs from an atlas, the glyphs shaped and rasterized by cosmic-text. Text sits on the
  model's cell grid: the cell is the font's advance wide and 1.5 times its size high (the page's line height,
  `EDWIN_LINE_HEIGHT`). The font is `EDWIN_FONT` ("Iosevka 12", "Iosevka" or "12"), else the first of JetBrains Mono
  (the page's), its Nerd Font build, DejaVu Sans Mono and Liberation Mono, at 10.5 points; characters the font lacks
  fall back to the system's fonts (CJK, emoji in colour). `--geometry=COLSxROWS` sets the first size (100x36).
- **Events.** Keys arrive as the page's keydown does (key, code, modifiers) and are named by the core's own
  `Ed.keyName`, so a key means in the window what it means on the page. An input method's preedit is drawn at the
  cursor and its commit inserted as typed text. Mouse, wheel, focus and resize are `Ed.display.input` events, as in
  the terminal. Kills and yanks go to the system clipboard; `C-S-v` pastes from it. The close button runs
  `save-buffers-kill-terminal` (it asks about changed files); a file dropped on the window is visited. The title is
  the buffer's name; the bell asks for attention when the window is not focused; `C-z` iconifies.
- **One loop.** The window's events, edwind's socket and signals share one thread: winit's loop is pumped with the
  next timer as its timeout, and a helper thread wakes it when a descriptor becomes readable.

The parity checklist against the browser frame (DT2's gate), each item with how it was checked:

| Browser frame | Window | Checked by |
|---|---|---|
| Faces: fg, bg, bold, italic, underline, strike, box | yes | `a_model_draws_its_faces_text_and_cursor` (offscreen render of a model dumped from the core) |
| Wide characters, combining marks, emoji | yes | `wide_characters_and_combining_marks_take_their_cells`; screenshot |
| Splits, dividers, a modeline per window, active and inactive | yes | the dumped model (a vertical split); screenshot of `C-x 2` |
| Minibuffer, echo area, multi-line prompts | yes | screenshot of the close button's save prompt |
| Vertico (`M-x`), Corfu (completion at point) | yes | screenshots |
| Cursor per Evil state (box, bar, hbar, half); hollow when unfocused and in other windows | yes | offscreen render (bar); screenshots |
| Region and Visual selection | yes | screenshot of a mouse drag |
| Presence cursors with the writer's name (edwind) | yes | `another_writer_is_a_bar_and_a_name_tag` |
| Keys named as on the page, `C-`, `M-`, Shift | yes | `native.test.mts` (gui.js); `keys_and_clicks_edit_and_wq_leaves_zero` (xdotool on Xvfb) |
| Mouse: click, drag, wheel | yes | the same test (click); by hand (drag, wheel) |
| Clipboard both ways | yes | by hand, with xclip |
| Resize; HiDPI | yes | by hand (`xdotool windowsize`; `WINIT_X11_SCALE_FACTOR=2`) |
| Leaving: `:wq`, `:q!`, the close button asks about changes | yes | `keys_and_clicks_edit_and_wq_leaves_zero`, `the_close_button_asks_about_changes` |
| Input methods | drawn and inserted | not checked against a real input method (none in the test machine) |
| Wayland | built | only X11 was run (Xvfb) |

The latency budget, fixed for DT2: from a key's arrival in the window to the frame's present, on a 200x50 window of
source text, **p50 at most 10 ms and p99 at most 25 ms** on Mesa's software renderer (lavapipe), the slowest GPU
the window will meet. `cargo test --release -- --ignored latency` measures it (`EDWIN_GUI_LATENCY_LOG=FILE` logs
each key in microseconds). Measured on 2026-10-17 (121 keys: moving, typing, `C-d`): p50 8.3 ms, p99 17.4 ms. Of
one key: the command, redisplay and the model as JSON 2 to 4 ms; parsing 0.1 ms; building the scene 1 to 2 ms; the
software renderer's present 3 to 4 ms (a hardware GPU removes most of that). The compositor's frame comes after.

Build and test: `cargo build --release` builds the window in (the `gui` feature; `--no-default-features` builds the
terminal program alone). It needs, at run time, libxkbcommon, and on X11 libX11, libX11-xcb and libxkbcommon-x11
(winit loads them; `edwin -g` checks for them first), a Vulkan or GL driver, and fontconfig's fonts. `cargo test
--release` runs the window's tests on their own Xvfb when `Xvfb` and `xdotool` are installed, and skips them
otherwise. The binary is 48.6 MB (37.6 without the window). The window opens in about 100 ms on the software
renderer before the snapshot restores, so the first frame is drawn at about 146 ms (40 ms in a terminal).

Not in DT2: ligatures (each cell is shaped alone, as the grid needs), proportional fonts, the pulse animation,
images, a menubar, smooth scrolling, opening the window while the snapshot restores, and Nix packaging (DT4).

## Step DT1: `edwin` in a terminal (done)

`edwin [-nw] [-R] [--standalone | --socket PATH] [+LINE] [FILE]...` is Edwin as a terminal program, meant to stand
in for Vim or Neovim, `$EDITOR` included. `edwin/native` is a Rust crate (its own Cargo workspace, so V8 stays out
of the Workbench crates and their Nix build) that embeds V8 (the `v8` crate, 130.0.1, prebuilt) and carries every
source it runs: the unchanged core in `src/`, the shipped Scheme in `scm/`, and `native/js/`. Rust is only the
floor: files, `/dev/tty` in raw mode, signals through a self-pipe, edwind's socket and one `poll(2)` loop. Edwin is
a model frame (DT0) drawn by `native/js/term.js`.

Build and run (the prebuilt V8 is downloaded by the `v8` crate's build script, or named by `RUSTY_V8_ARCHIVE`):

    cd edwin/native && cargo build --release && ./target/release/edwin FILE
    cargo test --release        # the pseudo-terminal suite (the edwind case needs node)

- **Vim's contract.** `:q` on the last window ends the program, refusing with E37 or E162 while a file has unsaved
  changes; `:q!`, `ZQ` and `:qa!` drop them. `:wq`, `:x`, `ZZ`, `:wqa` save first. `:cq` exits with status 1 (or
  its argument) and saves nothing, so `git commit` aborts. `C-x C-c` asks about each changed file (y, n, !, q),
  then confirms leaving with changes. In a split, `:q` closes the window, as before. The program blocks until it
  ends, so `git`, `sudoedit` and anything else that runs `$EDITOR` work. `+LINE` starts on a line (`+` alone: the
  last); `-` edits standard input (`git diff | edwin -`), the terminal being `/dev/tty`. Files the editor is handed by git (`COMMIT_EDITMSG`, `git-rebase-todo`...) start at the top
  (`save-place-ignore-files-regexp`).
- **Files are the disk's.** The host has a file system (`host.files`): the core's `Store` reads and writes paths,
  relative to the directory `edwin` started in, `~` expanded. A buffer's file is the absolute path; it is shown and
  completed by its label (relative under the working directory, `~/...` under home). Saves are atomic (a temporary
  file beside it, the old mode, fsync, rename), except a symlink, a file with other hard links, or one in a
  directory we cannot create files in, which are written in place. CRLF line ends and a byte order mark are kept.
  A saved file ends in a newline (`require-final-newline`, which the program sets and `init.scm` may unset). A file
  that is not UTF-8 is refused. recentf, savehist, save-place and prescient are one JSON file in
  `~/.local/state/edwin/`; the user's Scheme is `~/.config/edwin/init.scm` and `~/.config/edwin/lisp/`.
- **The terminal.** The alternate screen, no autowrap, synchronized output, rows redrawn only when they changed.
  Truecolor when `COLORTERM` or `TERM` says so, else the nearest of the 256 colours, else of the 16
  (`EDWIN_COLOR=truecolor|256|16` overrides). The cursor is the terminal's own, its shape per Evil state (DECSCUSR:
  block, bar, underline) and its colour by OSC 12. The theme follows the background colour the terminal reports
  (OSC 11), else `COLORFGBG`, else dark (`EDWIN_THEME=dark|light` overrides); `EDWIN_DEFAULT_COLORS=1` draws the
  default face in the terminal's own colours. Kills and yanks go to the system clipboard by OSC 52, which reaches it
  over SSH too (`EDWIN_OSC52=0` stops it). Mouse (SGR 1006): a click sets point and selects a window, a drag marks
  a region, the wheel scrolls three lines. Bracketed paste arrives as one insertion; focus events change the cursor.
  The kitty keyboard protocol's first level is asked for, so ESC, `C-i` and `M-` keys are unambiguous where the
  terminal has it; elsewhere a lone ESC waits 25 ms for the rest of a sequence (`EDWIN_ESC_MS`).
- **Signals.** `C-z` suspends in Vim's states (Normal, Motion, Visual, Insert) and `C-x C-z` in every state; `fg`
  resumes and redraws. A resize redraws. On `SIGHUP` (the SSH connection dropped) or `SIGTERM`, changed files are
  copied into `~/.local/state/edwin/rescue/` before the program exits.
- **Startup.** `build.rs` runs `native/js/boot.js` (the host, the core, `Ed.boot` with the shipped Scheme, the
  terminal key settings) in a V8 snapshot creator and the binary carries the heap; a start restores it and runs
  `main.js` for the process (arguments, terminal, directories, storage, then the user's `init.scm`). First draw of a
  200×50 terminal: 155 ms without the snapshot (75 compiling the core, 77 evaluating the Scheme), 40 ms with it
  (`EDWIN_TRACE=1` logs the steps, `EDWIN_NO_SNAPSHOT=1` starts cold). The binary is 37.6 MB: V8, the 5.2 MB
  snapshot and ICU's data (for `\p{...}` in regular expressions).
- **edwind.** When an edwind answers (`--socket PATH`, else `$EDWIN_SOCKET`, else the service's
  `/run/workbench-edit/edit.sock`; `--standalone` or `EDWIN_NO_ATTACH=1` never attach), `edwin` boots served
  (`Ed.bootServed`), so its image, commands and user init are edwind's. Notes under edwind's notes directory are
  opened through edwind, shared with the browser's frames; every other file stays the program's own, so a commit
  message never needs edwind's write permission. Quitting waits (up to 5 s) until edwind has acknowledged every
  edit. An attached start is cold (the snapshot holds a standalone boot).

Core changes for DT1: `host.files` behind `Store` (and shipped config never read from the working directory);
`kill-emacs`, `suspend-frame`, `can-kill-emacs?`, `display-graphic-p`, `modified-file-buffers` and a JS
`save-buffers-kill-terminal` (the page's still say how to leave); `Ed.display.input(f, ev)`, the input half of the
display seam (keys, paste, focus, mouse, resize in cell terms, as the page's frame wiring does it); `Ed.boot({
deferUserInit})` with `Ed.loadUserInit()` and `hooks.beforeUserInit`; `Ed.reloadPersistent()` (stack.js's tables,
read again once the program's storage is open); `require-final-newline`; and in `evil.scm` `:cq`, `:wqa`/`:xa`
saving before they quit, and `:q`/`:qa` ending the program where the host can.

Not in DT1: worker threads (jobs run on the main thread, as on a page without workers), the AI commands (no
`fetch` in the program yet), editing files that are not UTF-8, Vim's swap files, the
GUI (DT2), and Nix packaging of the binary (DT4: the prebuilt V8 must come from a fixed-output fetch).

## Step DT0: the display seam (done)

DT0 is the first step of desktop Edwin (the doc "Edwin on the Linux desktop", decided 2026-10-16: build through the
GUI, DT0 then DT1 `edwin -nw` then DT2). A Rust shell will embed V8, run these same files and draw a terminal or a
native window. For that the core must be able to draw a frame that is not a page. DT0 adds that and changes nothing
on the page.

- **Model frames.** `Ed.makeFrame(null, {backend, buffer, kind, theme})` makes a frame with no root element. The
  backend has `size()` → `{cols, rows}`, `draw(model)` and optionally `bell()`. Each redisplay `src/display.js`
  lays the frame out on that cell grid and calls `draw` with plain data (rows of styled segments, a face table, the
  cursor and its shape, the window rectangles; the header of `display.js` has the format). `Ed.display.posAt(f, x, y)`
  maps a cell back to a buffer position, the modeline or the echo area, for mouse input. `Ed.display.setTheme` and
  `Ed.display.redraw` are for the backend's theme and size changes.
- **Styled runs.** `renderBuffer(b, {runs: true, html: false})` gives each line its text and its spans as data
  (`{s, e, cls}`, plus the cursor, avy labels, fold ellipsis and end-of-line region). The html of the page is byte
  for byte what it was (a golden corpus of 54 renders was compared before and after, and the suite checks runs against html).
- **Shared logic.** The page and the model now share `windowState`, `scrollStart`, `modelineFields`, `miniView`
  and `echoView` in `editor-core.js`, so scrolling, the modeline, the minibuffer and the echo area cannot drift
  apart. `evil-ex.js` gives the which-key bindings as data (`prefixItems`) besides the html, and `stack.js` says
  when they wait (`prefixWait`).
- **Faces as data.** `FACES` maps every class the renderer, Org and markdown-mode emit, and the modeline and echo
  parts, to a spec in palette tokens with the page's fallback chains. `PALETTE` holds `index.html`'s light and dark
  values. A token set with `set-face-color!` wins, as on the page. `display.test.mts` parses `index.html`, the
  markdown-mode and the Org stylesheets and fails when a face and its rule disagree, or when a class has no face.

Choices made in DT0:

- The cursor is not painted into the cells. The model reports it with its shape (box, bar, hbar, half, hollow) and
  the Evil state's colour, so a terminal can use its own cursor.
- Lines wrap as the page wraps them (after the last space that fits, else anywhere), tabs stop every 8 columns,
  control characters show as `^X`, and East Asian wide characters and emoji take two cells. Truncated lines scroll
  the whole window sideways, as the page's view does.
- Windows share the room equally, as the page's flex layout does. Side-by-side windows get a one-cell divider. The
  echo area takes at most half the rows. The line-number gutter is the widest number plus one cell.
- The completion popup has a border on the page; in cells it has the menu background instead.
- Fixed on the page too: with two or more terms in the minibuffer, only the last term was marked in the candidates
  and the label was escaped twice. Every term is marked now.

Not in DT0 (each is a later step or a known gap): the menubar of a console frame, the pulse animation, markdown block
references drawn as their resolved text (a DOM pass in `markdown.js`), screen-line motion (`gj`/`gk` in
visual-line-mode falls back to buffer lines in a model frame), and per-character pixel metrics for proportional
fonts (DT2 decides).
