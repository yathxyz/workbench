# Edwin

Edwin is an Emacs-like editor with Evil keys and Org, scripted in its own Scheme. It runs in a web page. It is
becoming **edwind**, Workbench's text daemon: one Node service that owns every text buffer on the host. Workbench
page cards then attach to it as Edwin frames, as `emacsclient` frames attach to `emacs --daemon`.

The design and the decisions are in the doc "Edwin as Workbench's text daemon" (decided 2026-10-12): edwind
replaces the notes index and `sample` of M5 (M5-W1, M5-W2), pages are files in `notesDir`, markdown-mode comes
first, undo undoes your own edits, and the runtime is Node.

## Layout

| Path | What |
| --- | --- |
| `src/*.js` | the editor, in the order `index.html` loads it: `scheme` `runtime` `text` `editor-core` `editor-prims` `evil-core` `pool` `complete` `extras` `stack` `ai` `evil-ex` `org` |
| `scm/*.scm` | the shipped Scheme configuration (`emacs`, `evil`, `org`, `ai`, `init`), also inlined in `index.html` |
| `index.html` | the page: styles, the Scheme blocks and the script tags. It loads `src/*.js` relative to itself, so serving this directory runs it, and a published copy keeps the `src/` paths |
| `src/host-browser.js`, `src/host-node.js` | the host layer (R4.1): storage, the shipped Scheme, page attributes, suspend, clipboard, scheduling. The core reaches the page only through it and through frame objects |
| `test/headless.mjs` | loads and boots the editor in Node on `host-node.js` (no page objects exist in the process) and drives it with keys |
| `test/headless.test.mjs` | the headless suite: `node --test edwin/test/headless.test.mjs`, or `nix build .#checks.x86_64-linux.edwin-headless` |
| `test/scheme.test.mjs`, `test/scheme-editor.test.mjs` | the Scheme suite: the language, and the editor-level forms. `nix build .#checks.x86_64-linux.edwin-scheme` runs both and the benchmark |
| `test/scheme-bench.mjs` | evaluator benchmarks; fails when the shadow stack costs more than 10% (R4.34) |
| `src/ot.js` | the OT library (ops, transform, rebase, undo, markers, hash) shared by edwind and its clients (E1) |
| `server/*.mjs` | edwind, the text daemon (E1; see "Step E1" below) |
| `test/ot.test.mjs`, `test/ot-sim.mjs` | the OT properties with fast-check (`edwin-ot`; needs `NODE_PATH` at `tools/node_modules`) |
| `test/conformance.test.mjs`, `test/crash.test.mjs`, `test/disk.test.mjs`, `test/edit-client.mjs` | the edwind gate suites (`edit-conformance`, `edit-crash`, `edit-disk`) and their client |

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

## Step E1: edwind, the text daemon (in review)

`edwin/server/` is edwind: a Node process that loads the core headless, keeps every shared buffer as an Edwin
buffer, sequences edits from any number of clients over `edit.sock`, journals them, saves atomically and watches
the files on disk. `crates/wb-cli` is `wb buf`, `wb eval`, `wb edit` and `wb repl` over the same socket.
`nix/package.nix` installs `share/edwin/{src,scm,server}` and `bin/edwind`; `nix/module.nix` has
`services.workbench.edit.*` and `workbench-edit.service`; `nix/checks.nix` has `edwin-ot`, `edit-conformance`,
`edit-crash` (about thirteen minutes: 1,000 kills) and `edit-disk`; `nix/vm.nix` step 10 covers R16.18's E1 part.

Layout of `edwin/server/`: `main.mjs` (config, start, listen, `--check`, `--export`, evaluation, the E1 server
commands), `session.mjs` (one client: §7 messages), `sequencer.mjs` (rebase, apply, journal, ack, replay, undo),
`buffers.mjs` (open, save, revert, disk changes, compaction, index), `journal.mjs` (group commit, snapshots, the
image log), `files.mjs` (text files, CRLF, atomic save), `paths.mjs` (ids and the file authority of R14.8),
`watch.mjs` (inotify, the line-then-character diff, the three-way merge), `proto.mjs` (constants and field
checks). `edwin/src/ot.js` is the OT library both ends share; `edwin/test/edit-client.mjs` is the test client.

Running edwind by hand: `edwind --config edit.json` where `edit.json` has at least `notesDir` (see
`loadConfig` in `main.mjs` for the fields of R15.4); the socket's directory must be yours and 0700.

Choices E1 made where the spec left one open, and where it had to deviate:
- **No `--permission` (R14.12).** Node 22 and 24 disable `fsync` and `fdatasync` under the permission model, and the
  journal and atomic save need both (R8.3, R8.7). `bin/edwind` runs with `--disallow-code-generation-from-strings`,
  `--frozen-intrinsics`, `--max-old-space-size` and `--stack-size`; `main.mjs` replaces every function of
  `child_process` before anything else runs (`guardProcesses`, R4.45), and the Authority in `paths.mjs` is the
  one check on file writes, with the unit's `ProtectSystem=strict` and `ReadWritePaths` behind it. The
  conformance suite checks the flags in effect and the guard (R16.16).
- **Stack size.** The Scheme cap of 10,000 frames (R4.34) needs about 7 MiB of JS stack; Node's default reaches
  about 1,500. `bin/edwind` sizes `--stack-size` from `ulimit -s` minus headroom (at most 32000 KiB) and the unit
  sets `LimitSTACK=64M`. `guard` catches the JS stack running out as the `recursion-depth` condition when the
  stack is smaller than the cap. Browser frames keep the browser's depth.
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
  different order. `ot.test.mjs` states the property that holds; the frames' point stays where the user expects.
- **Edwin's key-value store** (`storage`) lives in `stateDir/storage.json`; compaction snapshots the text at the
  start of the retained history; journals compact at 4 MiB or 20,000 lines and after a save.
- **`web.json`** is untouched in E1 (`editSocket`, `refusePaths`, `/edit` and the notes forwarding are E2, R15.5);
  the module writes `refusePaths` into `edit.json` only. `/api/status`'s `edit` block (R15.11) is E2 as well.
- **VM steps left for later phases:** `wb edit --wait` finished from a frame (E3) and the A7 migration dry run
  (E4). The other R16.18 steps run in `nix/vm.nix` step 10. The security suite's socket cases of R16.12 are in
  `edit-conformance` (start refusal) and the VM (another uid).
- **`CRASH_ROUNDS`** sets the kill count of the crash suite (default 1,000); `OT_RUNS` the fast-check runs
  (default 10,000); `EDWIND_LOG=1` streams edwind's log in the test harness.
