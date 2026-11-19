# Working on Workbench

## Repository layout

- `crates/wb-hub/`: the daemon that owns PTYs and ACP agent sessions.
- `crates/wb-web/`: the HTTP server and WebSocket relay to the hub.
- `crates/wb-proto/`: shared protocol types, journal records, and wire formats.
- `crates/wb-cli/`: the `wb` command for driving the board.
- `web/`: the browser canvas, card UI, key bindings, and service worker.
- `tests/`: test harness, browser and daemon suites, and regression checks.
- `nix/`: packages, flake checks, NixOS module, and VM test.
- `docs/`: the design specification and supporting design notes.

## Specification

Read `docs/DESIGN.md` with `docs/amendments/` and `docs/ui-checks/`.
Each amendment or UI check has its own Markdown file, named by its identifier.
Write one sentence per line in those files. Add a new file for a new amendment or check; do not add it to an index or extend a numbered range.

The orchestrator allocates numbers. The task brief names the `F-A` and `N` numbers the task may use.
Never pick an `F-A` or `N` number yourself. Ask the orchestrator if you need one the brief did not assign.

## UI checks

- Add a new check as `tests/ui/sections/NNNN-short-name.mts`. Section files run one at a time in filename order.
- Pick any unused four-digit prefix after the checks it depends on and below 9000. Prefixes 9000 and up are for checks that must run last.
- A duplicate prefix, a misnamed section file, or a section file that throws while loading fails the run.
- Put state shared between sections on the exported `state` object in `tests/ui/shared.mts`.
- Use `await shot(page, 'name')` to write `name.png` to the `ui` flake check's output.
- The check's specification is `docs/ui-checks/N<n>.md`, using the number assigned in the brief.

## Flake checks

Run a check with `nix build .#checks.x86_64-linux.<name>`.
Names from `flake.nix` and `nix/checks.nix`: `package`, `clippy`, `fmt`, `web-keys`, `typecheck`, `edit-address`, `conformance`, `security`, `ui`, `adapters`, `vm`, `module`.
`vm` requires KVM. If the sandbox cannot fetch a flake input, record the blocked check and move on; do not work around it.

## Git

Commit on the task's branch. Do not push or rebase. Merge `origin/main` only when asked.
