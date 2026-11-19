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
Never pick a number yourself. Ask the orchestrator if you need a number the brief did not assign.

## Flake checks

Run a check with `nix build .#checks.x86_64-linux.<name>`.
Names from `flake.nix` and `nix/checks.nix`: `package`, `clippy`, `fmt`, `web-keys`, `typecheck`, `edit-address`, `conformance`, `security`, `ui`, `adapters`, `vm`, `module`.
`vm` requires KVM. If the sandbox cannot fetch a flake input, record the blocked check and move on; do not work around it.

## Git

Commit on the task's branch. Do not push or rebase. Merge `origin/main` only when asked.
