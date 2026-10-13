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
