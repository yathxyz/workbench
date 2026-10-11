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

Caddy modes: tests/caddy/{live,expired,loginpage}.Caddyfile. Caddy starts in live mode; swap
with
  caddy reload --address unix/<caddyAdmin> --config tests/caddy/<mode>.Caddyfile --adapter caddyfile
from any directory and with no extra environment (Harness.caddy_mode does this).

WB_HARNESS_TCP=1 also forwards TCP 127.0.0.1:18443 to caddySocket, so a browser in the same
network namespace can open `caddy`. It is refused unless the network namespace has no
interface but lo (the nix build sandbox, `unshare -rn`), where no other user can connect.

Shells: bash from $BASH, else /run/current-system/sw/bin/bash when it exists, else PATH; and
sh (/bin/sh) as a second shell for tests.

Test mode (the default) gives the hub a temporary HOME and environment canaries, and exits
when stdin closes. The stdin lines "stop hub" and "start hub" stop wb-hub (SIGTERM) and start
it again, acknowledged on stderr with "harness: wb-hub stopped" / "harness: wb-hub started". --dogfood uses the real HOME, no canaries, ignores stdin, and still uses a
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
CADDY_TCP = ("127.0.0.1", 18443)
PUBLIC_ORIGIN = "http://127.0.0.1:18443"
CADDY_DIR = Path(__file__).resolve().parent / "caddy"
SYSTEM_BASH = "/run/current-system/sw/bin/bash"

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


def resolve_bash():
    """$BASH, else the NixOS system bash when it exists, else bash from PATH (DELTA-1 C.4)."""
    bash = os.environ.get("BASH") or (SYSTEM_BASH if os.path.exists(SYSTEM_BASH) else shutil.which("bash"))
    if not bash or not os.path.isabs(bash):
        raise RuntimeError("no absolute bash: set $BASH")
    return bash


def private_netns():
    """True when this network namespace has no interface but lo."""
    with open("/proc/net/dev") as f:
        names = [line.split(":", 1)[0].strip() for line in f.readlines()[2:]]
    return names == ["lo"]


def relay(client, path):
    """Copy bytes both ways between a TCP client and the unix socket at `path`."""
    with client, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as upstream:
        try:
            upstream.connect(path)
        except OSError:
            return

        def copy(src, dst):
            try:
                while data := src.recv(1 << 16):
                    dst.sendall(data)
            except OSError:
                pass
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass

        back = threading.Thread(target=copy, args=(upstream, client), daemon=True)
        back.start()
        copy(client, upstream)
        back.join()


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
    def __init__(self, web_root, bin_dir=None, dogfood=False, tcp=False):
        self.web_root = str(Path(web_root).resolve())
        self.bin_dir = bin_dir
        self.dogfood = dogfood
        self.tcp = tcp
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
        self.bash = resolve_bash()
        self.hub = self.web = self.caddy = self.tcp_server = None

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
            "shells": [
                {"name": "bash", "paths": [self.bash], "args": ["-i"]},
                {"name": "sh", "paths": ["/bin/sh"], "args": ["-i"]},
            ],
            "defaultShell": "bash",
            "child": {
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

    def spawn(self, name, argv, env, cwd=None):
        with self.log(name) as log:
            return subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=log)

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

    def caddy_env(self):
        env = self.base_env()
        env.update({"XDG_CONFIG_HOME": str(self.root / "caddy"), "XDG_DATA_HOME": str(self.root / "caddy")})
        return env

    def start_caddy(self):
        env = self.caddy_env()
        env["CADDY_UPSTREAM_SECRET_WORKBENCH"] = self.secret
        argv = [self.bin("caddy"), "run", "--config", str(CADDY_DIR / "live.Caddyfile"), "--adapter", "caddyfile"]
        # The Caddyfiles name their sockets relative to the working directory: self.root.
        self.caddy = self.spawn("caddy", argv, env, cwd=self.root)
        wait_until(lambda: can_connect_unix(self.caddy_sock), "caddy", self.caddy)

    def caddy_mode(self, mode):
        """Swap the test Caddy to tests/caddy/<mode>.Caddyfile through its admin socket."""
        argv = [self.bin("caddy"), "reload", "--address", f"unix/{self.caddy_admin}",
                "--config", str(CADDY_DIR / f"{mode}.Caddyfile"), "--adapter", "caddyfile"]
        r = subprocess.run(argv, env=self.caddy_env(), stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, timeout=30)
        if r.returncode != 0:
            raise RuntimeError(f"caddy reload {mode} failed:\n{r.stderr[-2000:]}")

    def start_tcp(self):
        self.tcp_server = socket.create_server(CADDY_TCP)

        def serve():
            while True:
                try:
                    client, _ = self.tcp_server.accept()
                except OSError:
                    return
                threading.Thread(target=relay, args=(client, self.caddy_sock), daemon=True).start()

        threading.Thread(target=serve, daemon=True).start()

    def start(self):
        if self.tcp and not private_netns():
            raise RuntimeError("WB_HARNESS_TCP needs a network namespace with only lo (the nix sandbox, "
                               "unshare -rn): elsewhere other users could reach the secret-injecting proxy")
        # A stale listener would pass the readiness check and answer for the new wb-web.
        if can_connect_tcp(WEB_ADDR):
            raise RuntimeError(f"{WEB_ADDR[0]}:{WEB_ADDR[1]} is already in use")
        for name, step in (("hub", self.start_hub), ("web", self.start_web), ("caddy", self.start_caddy)):
            try:
                step()
            except RuntimeError as e:
                raise RuntimeError(f"{e}\n--- {name}.log ---\n{self.log_tail(name)}") from None
        if self.tcp:
            self.start_tcp()
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
        if self.tcp_server is not None:
            try:
                self.tcp_server.shutdown(socket.SHUT_RDWR)  # wakes the accept() thread
            except OSError:
                pass
            self.tcp_server.close()
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
            "stateDir": self.hub_config["stateDir"],
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

    h = Harness(a.web_root, a.bin_dir, a.dogfood, tcp=os.environ.get("WB_HARNESS_TCP") == "1")
    try:
        h.start()
    except (RuntimeError, OSError) as e:
        print(f"harness: {e}", file=sys.stderr)
        h.stop()
        return 1
    print(json.dumps(h.info()), flush=True)
    if a.dogfood:
        print(f"harness: ssh -L 18443:{h.caddy_sock} <this host>, then open {PUBLIC_ORIGIN}; "
              f"logs in {h.root}; kill -HUP {os.getpid()} restarts wb-web", file=sys.stderr)
    else:
        def watch_stdin():
            # Unbuffered: a daemon thread blocked in sys.stdin.buffer holds its lock, and the
            # interpreter then aborts at exit after a SIGTERM.
            for line in open(sys.stdin.fileno(), "rb", buffering=0, closefd=False):
                if line.strip() in (b"stop hub", b"start hub"):
                    events.append(line.strip().decode())
                    wake.set()
            events.append(signal.SIGTERM)
            wake.set()

        threading.Thread(target=watch_stdin, daemon=True).start()

    status = 0
    hub_stopped = False
    try:
        while True:
            wake.wait(0.5)
            wake.clear()
            while events:
                event = events.pop(0)
                if event == "stop hub":
                    h.stop_proc(h.hub)
                    hub_stopped = True
                    print("harness: wb-hub stopped", file=sys.stderr, flush=True)
                    continue
                if event == "start hub":
                    try:
                        h.start_hub()
                    except RuntimeError as e:
                        print(f"harness: {e}\n{h.log_tail('hub')}", file=sys.stderr)
                        status = 1
                        return status
                    hub_stopped = False
                    print("harness: wb-hub started", file=sys.stderr, flush=True)
                    continue
                if event != signal.SIGHUP:
                    return status
                try:
                    h.restart_web()
                    print("harness: wb-web restarted", file=sys.stderr)
                except RuntimeError as e:
                    print(f"harness: {e}\n{h.log_tail('web')}", file=sys.stderr)
                    status = 1
                    return status
            for name, proc in (("wb-hub", h.hub), ("wb-web", h.web), ("caddy", h.caddy)):
                if name == "wb-hub" and hub_stopped:
                    continue
                if proc.poll() is not None:
                    print(f"harness: {name} exited with {proc.returncode}", file=sys.stderr)
                    status = 1
                    return status
    finally:
        h.stop()


if __name__ == "__main__":
    sys.exit(main())
