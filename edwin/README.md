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
| `test/headless.mjs` | loads the editor in Node with no browser and drives it with keys |
| `test/headless.test.mjs` | the headless suite: `node --test edwin/test/headless.test.mjs`, or `nix build .#checks.x86_64-linux.edwin-headless` |

These files came from the published Edwin artifact (version 1791768765, 2026-10-12). From now on this directory is
the source.

## Step E0: the core without a browser

The goal of E0 is that Edwin's editing core runs under Node with no page at all.

Done so far:
- `E.headless` is set from `window.EDWIN_HEADLESS` before `editor-core.js` loads. Redisplay and the browser wiring
  are then skipped; buffers, keymaps, the command loop, Evil, ex, Org, Scheme and undo run unchanged.
- The headless suite boots Edwin in about 100 ms and covers Insert and Normal state, operators, counts, the dot
  command, macros, ex commands, Visual state, text objects, Scheme commands bound to keys, saving and Org. It also
  checks that replaying a buffer's delta log (`{v, pos, del, ins}`) rebuilds its text, since edwind's protocol
  sends that log.

Left for E0: the core still touches a few page objects at load, which `test/headless.mjs` stands in for and the
last test prints. They are the Scheme blocks read with `getElementById` (to be read from `scm/` when headless),
listeners for `resize`, `pagehide`, `visibilitychange` and the page's CSP violations, the theme on `document.documentElement`, and the style
tag `org.js` adds. After those, the frame objects: `#frame`, `#windows` and `#echo` become per-frame, so one page
can show many Edwin frames.
