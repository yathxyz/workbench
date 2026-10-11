#!/usr/bin/env python3
"""Start wb-hub, wb-web and a test Caddy on loopback with temporary configs.

  python3 -I tests/harness.py --web-root DIR [--bin-dir DIR] [--dogfood]

Prints one JSON line on stdout once everything listens:
  {web, caddy, caddySocket, hubSocket, webSocket, caddyAdmin, stateDir, boardsDir, notesDir}

wb-web listens on 127.0.0.1:18090 and trusts 127.0.0.1. Caddy injects the proxy secret and
listens only on caddySocket, a 0600 unix socket in the 0700 temporary directory, for the site
http://127.0.0.1:18443 (caddy, the publicOrigin): a TCP listener would hand the secret to every
local user. A browser reaches it through `ssh -L 18443:<caddySocket> <host>`. SIGHUP restarts
wb-web only, so shells keep running in the hub. SIGTERM or SIGINT stops everything and deletes
the temporary directory.

Test mode (the default) gives the hub a temporary HOME and environment canaries, and exits
when stdin closes. --dogfood uses the real HOME, no canaries, ignores stdin, and still uses a
temporary state directory and a fresh, empty boards directory.

Binaries come from --bin-dir, else from PATH. The web root comes from --web-root or
$WB_WEB_ROOT (for example the output of `nix build .#workbench-web`).
"""

import argparse
import json
import os
import pwd
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

WEB_ADDR = ("127.0.0.1", 18090)
PUBLIC_ORIGIN = "http://127.0.0.1:18443"
CADDYFILE = Path(__file__).resolve().parent / "caddy" / "live.Caddyfile"

# Copied by value into the hub's environment when set, and listed in child.passEnv.
PASS_ENV = ["PATH", "LANG", "LOCALE_ARCHIVE", "TZDIR", "TERMINFO_DIRS", "NIX_PATH", "NIX_PROFILES",
            "XDG_CONFIG_DIRS", "XDG_DATA_DIRS", "EDITOR", "PAGER"]
# Set on wb-hub in test mode; none of them may reach a card (T-S14).
CANARIES = {"ANTHROPIC_API_KEY": "leak-canary", "NOTIFY_SOCKET": "/x", "CREDENTIALS_DIRECTORY": "/y"}


def wait_until(check, what, proc, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"{what}: process exited with {proc.returncode}")
        if check():
            return
        time.sleep(0.05)
    raise RuntimeError(f"{what}: not ready after {timeout:.0f} s")


def can_connect_tcp(addr):
    try:
        socket.create_connection(addr, timeout=0.5).close()
        return True
    except OSError:
        return False


def can_connect_unix(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(0.5)
        s.connect(path)
        return True
    except OSError:
        return False
    finally:
        s.close()


class Harness:
    def __init__(self, web_root, bin_dir=None, dogfood=False):
        self.web_root = str(Path(web_root).resolve())
        self.bin_dir = bin_dir
        self.dogfood = dogfood
        self.root = Path(tempfile.mkdtemp(prefix="wb-"))
        self.secret = secrets.token_hex(32)
        self.secret_file = self.root / "proxy-secret"
        self.hub_sock = str(self.root / "run" / "hub" / "hub.sock")
        self.web_sock = str(self.root / "run" / "web" / "web.sock")
        self.caddy_admin = str(self.root / "caddy-admin.sock")
        self.caddy_sock = str(self.root / "caddy.sock")
        self.boards_dir = self.root / "boards"
        self.notes_dir = self.root / "notes"
        self.home = Path(pwd.getpwuid(os.getuid()).pw_dir) if dogfood else self.root / "home"
        self.shell = os.environ.get("BASH") or shutil.which("bash")
        if not self.shell or not os.path.isabs(self.shell):
            raise RuntimeError("no absolute bash: set $BASH")
        self.hub = self.web = self.caddy = None

        for d in ("run/hub", "run/web", "state", "caddy"):
            (self.root / d).mkdir(mode=0o700, parents=True)
        for d in (self.boards_dir, self.notes_dir) + (() if dogfood else (self.home,)):
            d.mkdir(mode=0o700)
        fd = os.open(self.secret_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        with os.fdopen(fd, "w") as f:
            f.write(self.secret + "\n")

        host = os.uname().nodename
        self.hub_config = {
            "socket": self.hub_sock,
            "stateDir": str(self.root / "state" / "hub"),
            "host": host,
            "child": {
                "shell": self.shell,
                "passEnv": PASS_ENV,
                "setEnv": {"__NIXOS_SET_ENVIRONMENT_DONE": "1", "WB_SOCKET": self.web_sock},
            },
            "agents": {},
        }
        self.web_config = {
            "listen": f"{WEB_ADDR[0]}:{WEB_ADDR[1]}",
            "publicOrigin": PUBLIC_ORIGIN,
            "trustedProxy": WEB_ADDR[0],
            "proxySecretFile": str(self.secret_file),
            "socket": self.web_sock,
            "hubSocket": self.hub_sock,
            "stateDir": str(self.root / "state" / "web"),
            "webRoot": self.web_root,
            "boardsDir": str(self.boards_dir),
            "notesDir": str(self.notes_dir),
            "host": host,
            "shell": self.shell,
            "sample": None,
        }
        self.hub_json = self.write_json("hub.json", self.hub_config)
        self.web_json = self.write_json("web.json", self.web_config)

    def write_json(self, name, obj):
        path = self.root / name
        path.write_text(json.dumps(obj, indent=2))
        return str(path)

    def bin(self, name):
        """wb-hub and wb-web from --bin-dir when given; everything else from PATH."""
        path = os.path.join(self.bin_dir, name) if self.bin_dir and name.startswith("wb-") else shutil.which(name)
        if not path or not os.access(path, os.X_OK):
            raise RuntimeError(f"{name} not found (use --bin-dir or PATH)")
        return path

    def base_env(self):
        user = pwd.getpwuid(os.getuid()).pw_name
        env = {"HOME": str(self.home), "USER": user, "LOGNAME": user}
        for k in PASS_ENV + ["RUST_LOG"]:
            if k in os.environ:
                env[k] = os.environ[k]
        return env

    def log(self, name):
        return open(self.root / f"{name}.log", "ab")

    def spawn(self, name, argv, env):
        with self.log(name) as log:
            return subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)

    def log_tail(self, name, n=20):
        try:
            return "\n".join((self.root / f"{name}.log").read_text(errors="replace").splitlines()[-n:])
        except OSError:
            return ""

    def start_hub(self):
        env = self.base_env()
        if not self.dogfood:
            env.update(CANARIES)
        self.hub = self.spawn("hub", [self.bin("wb-hub"), "--config", self.hub_json], env)
        wait_until(lambda: can_connect_unix(self.hub_sock), "wb-hub", self.hub)

    def start_web(self):
        self.web = self.spawn("web", [self.bin("wb-web"), "--config", self.web_json], self.base_env())
        wait_until(lambda: can_connect_tcp(WEB_ADDR), "wb-web", self.web)

    def start_caddy(self):
        env = self.base_env()
        env.update({
            "CADDY_UPSTREAM_SECRET_WORKBENCH": self.secret,
            "WB_CADDY_ADMIN": self.caddy_admin,
            "WB_CADDY_SOCKET": self.caddy_sock,
            "XDG_CONFIG_HOME": str(self.root / "caddy"),
            "XDG_DATA_HOME": str(self.root / "caddy"),
        })
        argv = [self.bin("caddy"), "run", "--config", str(CADDYFILE), "--adapter", "caddyfile"]
        self.caddy = self.spawn("caddy", argv, env)
        wait_until(lambda: can_connect_unix(self.caddy_sock), "caddy", self.caddy)

    def start(self):
        # A stale listener would pass the readiness check and answer for the new wb-web.
        if can_connect_tcp(WEB_ADDR):
            raise RuntimeError(f"{WEB_ADDR[0]}:{WEB_ADDR[1]} is already in use")
        for name, step in (("hub", self.start_hub), ("web", self.start_web), ("caddy", self.start_caddy)):
            try:
                step()
            except RuntimeError as e:
                raise RuntimeError(f"{e}\n--- {name}.log ---\n{self.log_tail(name)}") from None
        return self

    @staticmethod
    def stop_proc(proc, timeout=10.0):
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    def restart_web(self):
        self.stop_proc(self.web)
        self.start_web()

    def stop(self):
        for proc in (self.caddy, self.web, self.hub):
            self.stop_proc(proc)
        shutil.rmtree(self.root, ignore_errors=True)

    def info(self):
        return {
            "web": f"http://{WEB_ADDR[0]}:{WEB_ADDR[1]}",
            "caddy": PUBLIC_ORIGIN,
            "caddySocket": self.caddy_sock,
            "hubSocket": self.hub_sock,
            "webSocket": self.web_sock,
            "caddyAdmin": self.caddy_admin,
            "stateDir": str(self.root),
            "boardsDir": str(self.boards_dir),
            "notesDir": str(self.notes_dir),
        }

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            self.stop()
            raise

    def __exit__(self, *exc):
        self.stop()


def main():
    p = argparse.ArgumentParser(description="Run wb-hub, wb-web and Caddy on loopback.")
    p.add_argument("--web-root", default=os.environ.get("WB_WEB_ROOT"))
    p.add_argument("--bin-dir", help="directory holding wb-hub and wb-web (default: PATH)")
    p.add_argument("--dogfood", action="store_true", help="real HOME, no canaries, ignore stdin")
    a = p.parse_args()
    if not a.web_root:
        p.error("--web-root or $WB_WEB_ROOT is required")

    events = []
    wake = threading.Event()

    def on_signal(signum, _frame):
        events.append(signum)
        wake.set()

    for s in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(s, on_signal)

    h = Harness(a.web_root, a.bin_dir, a.dogfood)
    try:
        h.start()
    except RuntimeError as e:
        print(f"harness: {e}", file=sys.stderr)
        h.stop()
        return 1
    print(json.dumps(h.info()), flush=True)
    if a.dogfood:
        print(f"harness: ssh -L 18443:{h.caddy_sock} <this host>, then open {PUBLIC_ORIGIN}; "
              f"logs in {h.root}; kill -HUP {os.getpid()} restarts wb-web", file=sys.stderr)
    else:
        def watch_stdin():
            while sys.stdin.buffer.read(4096):
                pass
            events.append(signal.SIGTERM)
            wake.set()

        threading.Thread(target=watch_stdin, daemon=True).start()

    status = 0
    try:
        while True:
            wake.wait(0.5)
            wake.clear()
            while events:
                if events.pop(0) != signal.SIGHUP:
                    return status
                try:
                    h.restart_web()
                    print("harness: wb-web restarted", file=sys.stderr)
                except RuntimeError as e:
                    print(f"harness: {e}\n{h.log_tail('web')}", file=sys.stderr)
                    status = 1
                    return status
            for name, proc in (("wb-hub", h.hub), ("wb-web", h.web), ("caddy", h.caddy)):
                if proc.poll() is not None:
                    print(f"harness: {name} exited with {proc.returncode}", file=sys.stderr)
                    status = 1
                    return status
    finally:
        h.stop()


if __name__ == "__main__":
    sys.exit(main())
