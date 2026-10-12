# Workbench

A browser canvas of terminal and agent cards for one user on one host.

- **wb-hub** owns the PTYs and the ACP agent processes. It runs as the user, holds no secrets
  and is never restarted by a deploy, so sessions outlive the web front.
- **wb-web** serves the single-page app and relays browser WebSockets to the hub. It accepts
  requests only from one trusted reverse proxy that adds a shared secret header, and it checks
  Host and Origin on every request. Restarting it never ends a session.
- **wb** is the CLI that agents inside cards use to drive the board.

The proxy in front (for example Caddy with an OIDC gate) authenticates the human; wb-web
authenticates the proxy.

[docs/DESIGN.md](docs/DESIGN.md) is the full design: protocol, threat model, units and tests.

## Build

Requires Nix with flakes, on x86_64-linux.

```sh
nix build .#workbench       # wb-hub, wb-web, wb
nix build .#workbench-web   # the web root (SPA plus the vendored editor and terminal bundle)
nix develop                 # cargo, clippy, rustfmt, esbuild, python3, caddy
```

## Test

```sh
cargo test --workspace
nix flake check -L          # package, clippy, fmt, security (end to end), vm (needs KVM)
```

`tests/harness.py` starts wb-hub, wb-web and a test Caddy with temporary configuration and
prints their addresses as one JSON line:

```sh
python3 -I tests/harness.py --bin-dir target/debug --web-root "$(nix build --no-link --print-out-paths .#workbench-web)"
```

`tests/perf.mjs` walks the app end to end in headless Chromium against the same harness (load, pan and zoom,
drag, type into a shell and a page, flood a shell, the palette, the views, a board of 140 cards) and prints, per
scenario, the JavaScript and browser time, the slowest input events with their handler time, long animation frames
with the scripts in them, and the functions with the most self time. It also checks the behaviour it walks through;
timings never fail it. `--profiles DIR` keeps each scenario's CPU profile for DevTools:

```sh
WB_PLAYWRIGHT=<playwright>/index.mjs WB_HARNESS=tests/harness.py node tests/perf.mjs "$(nix build --no-link --print-out-paths .#workbench-web)"
```

The test Caddy adds the proxy secret to every request it forwards, so it listens only on a unix
socket in the harness's private temporary directory (`caddySocket` in the JSON line), never on
TCP. Add `--dogfood` to use your real home directory for shells, forward the socket from the
machine your browser runs on with `ssh -L 18443:<caddySocket> <host>`, then open
`http://127.0.0.1:18443`. `kill -HUP <harness pid>` restarts wb-web while the shells keep running.

## Deploy

The flake exports `nixosModules.workbench`. A minimal configuration:

```nix
{
  imports = [ workbench.nixosModules.workbench ];
  services.workbench = {
    enable = true;
    user = "alice";
    listenAddress = "192.0.2.2";              # the interface the proxy reaches
    trustedProxy = "192.0.2.1";               # the only accepted source address
    publicOrigin = "https://wb.example.org";  # what the browser sees
    proxySecretFile = "/run/secrets/workbench-proxy-secret";  # 64 lowercase hex characters
    firewall.interface = "wg0";
  };
}
```

The proxy must set (not append) the header `X-Workbench-Proxy-Secret` on every upstream
request. With Caddy, read the value from the process environment at request time:

```
reverse_proxy 192.0.2.2:8090 {
	header_up X-Workbench-Proxy-Secret {env.CADDY_UPSTREAM_SECRET_WORKBENCH}
}
```

Cards are interactive non-login shells of the configured user. They run with
`NoNewPrivileges`, without access to `/run/user`, and with `~/.ssh` and the user's systemd unit
directories read-only. These are guard-rails, not a sandbox: a card can do what the user can.
