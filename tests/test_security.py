#!/usr/bin/env python3
"""End-to-end security regressions T-S1..T-S17, T-S21 (server half) and T-S23 over real wb-hub,
wb-web and Caddy, plus the harness's own exposure and its Caddy modes.

  python3 -I tests/test_security.py --web-root DIR [--bin-dir DIR]

The cargo tests cover the floor logic itself; these cover what only the assembled system shows.
Prints one line per check and exits 1 if any check failed.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import harness  # noqa: E402
import wbctl  # noqa: E402

WEB = harness.WEB_ADDR
ORIGIN = harness.PUBLIC_ORIGIN
HOST = ORIGIN.split("://", 1)[1]
SECRET = wbctl.SECRET_HEADER
FOREIGN = "https://evil.example.org"
FORBIDDEN = {"error": "forbidden"}


class Suite:
    def __init__(self):
        self.failed = []

    def check(self, name, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f": {detail}" if detail and not ok else ""), flush=True)
        if not ok:
            self.failed.append(name)
        return ok

    def skip(self, name, why):
        print(f"SKIP {name}: {why}", flush=True)


def request(method, target, headers, body=None, addr=WEB, source=None):
    return wbctl.http_request(addr, method, target, headers, body=body, source=source)


def upgrade(target, headers, addr=WEB, source=None):
    """An upgrade attempt; any 101 socket is closed at once. Returns (status, body)."""
    status, _, rest = wbctl.ws_connect(addr, target, headers, source=source)
    if status == 101:
        rest.close()
        return status, b""
    return status, rest


def body_json(body):
    try:
        return json.loads(body)
    except ValueError:
        return None


def free_port_listening(port):
    return harness.can_connect_tcp(("127.0.0.1", port))


def tcp_listeners(pid):
    """The local addresses (hex, as in /proc/net/tcp*) of every TCP socket `pid` listens on."""
    inodes = set()
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            link = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if link.startswith("socket:["):
            inodes.add(link[len("socket:["):-1])
    found = []
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        with open(table) as f:
            next(f)
            for line in f:
                cols = line.split()
                if cols[3] == "0A" and cols[9] in inodes:
                    found.append(cols[1])
    return found


def pty_list(h):
    return [s for s in wbctl.hub_sessions(h.hub_sock) if s.get("kind") == "pty"]


def sids(h):
    return sorted(s["sid"] for s in wbctl.hub_sessions(h.hub_sock))


def read_until(ws, pattern, timeout=10.0):
    """Live /pty output until it contains `pattern`; returns the text, or None on close or timeout."""
    text = ""
    deadline = time.monotonic() + timeout
    try:
        while pattern not in text:
            m = ws.recv_json(deadline - time.monotonic())
            text += m.get("d", "") if m.get("t") == "out" else ""
    except (wbctl.WsClosed, OSError, TimeoutError):
        return None
    return text


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--web-root", default=os.environ.get("WB_WEB_ROOT"), required=not os.environ.get("WB_WEB_ROOT"))
    p.add_argument("--bin-dir")
    a = p.parse_args()

    t = Suite()
    with harness.Harness(a.web_root, a.bin_dir) as h:
        good = h.secret
        caddy = h.caddy_sock

        def mode(path):
            return os.stat(path).st_mode & 0o777

        # The harness's Caddy adds the secret to every request, so only the harness user may
        # reach it: a unix socket, and no TCP listener for other users or hosts.
        listeners = tcp_listeners(h.caddy.pid)
        t.check("harness Caddy: no TCP listener; caddy.sock 0600 in a 0700 directory",
                not listeners and (mode(caddy), mode(os.path.dirname(caddy))) == (0o600, 0o700),
                repr((listeners, oct(mode(caddy)), oct(mode(os.path.dirname(caddy))))))
        t.check("harness JSON: stateDir is the hub's state directory",
                h.info()["stateDir"] == str(h.root / "state" / "hub"), h.info()["stateDir"])

        def auth(origin=None, secret=good, host=HOST):
            hd = [("Host", host)]
            if secret is not None:
                hd.append((SECRET, secret))
            if origin is not None:
                hd.append(("Origin", origin))
            return hd

        def all_403(name, cases):
            bad = [(label, st) for label, (st, _) in cases if st != 403]
            return t.check(name, not bad, f"not 403: {bad}")

        # S1: direct, no secret. 403 with nothing but the fixed error body.
        cases = [
            ("GET /", request("GET", "/", auth(secret=None))[::2]),
            ("GET /api/info", request("GET", "/api/info", auth(secret=None))[::2]),
            ("PUT /api/board", request("PUT", "/api/board", auth(ORIGIN, secret=None), b"{}")[::2]),
            ("upgrade /pty", upgrade("/pty", auth(ORIGIN, secret=None))),
        ]
        all_403("T-S1 direct without the secret: 403", cases)
        t.check("T-S1 403 body is only {\"error\":\"forbidden\"}",
                all(body_json(b) == FORBIDDEN for _, (_, b) in cases), repr([b[:80] for _, (_, b) in cases]))

        # S2: wrong secret (same length, other lengths) and a duplicated header.
        flipped = ("0" if good[0] != "0" else "1") + good[1:]
        cases = []
        for label, s in (("same length", flipped), ("63 chars", good[:-1]), ("65 chars", good + "0"), ("empty", "")):
            cases.append((f"GET {label}", request("GET", "/api/info", auth(secret=s))[::2]))
            cases.append((f"upgrade {label}", upgrade("/pty", auth(ORIGIN, secret=s))))
        cases.append(("two headers right+wrong", request("GET", "/api/info", auth() + [(SECRET, flipped)])[::2]))
        cases.append(("two headers wrong+right", request("GET", "/api/info", auth(secret=flipped) + [(SECRET, good)])[::2]))
        cases.append(("two headers right+right", request("GET", "/api/info", auth() + [(SECRET, good)])[::2]))
        all_403("T-S2 wrong or duplicated secret: 403", cases)

        # S3: right secret, wrong Host or an absolute-form target.
        cases = [(f"Host {v}", request("GET", "/api/info", auth(host=v))[::2])
                 for v in ("127.0.0.1:18090", "127.0.0.1", "evil.example.org")]
        cases.append(("two Host", request("GET", "/api/info", auth() + [("Host", HOST)])[::2]))
        cases.append(("absolute-form", request("GET", f"{ORIGIN}/api/info", auth())[::2]))
        all_403("T-S3 Host mismatch or absolute-form target: 403", cases)

        # S4: right secret and Host; upgrades with a missing or wrong Origin.
        bad_origins = [None, FOREIGN, "null", ORIGIN.replace("http://", "https://"),
                       "http://127.0.0.1", "http://127.0.0.1:18444", ORIGIN + "/"]
        cases = [(f"/pty Origin {o}", upgrade("/pty", auth(o))) for o in bad_origins]
        cases += [(f"{path} no Origin", upgrade(path, auth())) for path in ("/acp", "/rpc")]
        cases.append(("/pty two Origin", upgrade("/pty", auth(ORIGIN) + [("Origin", ORIGIN)])))
        all_403("T-S4 upgrade without a matching Origin: 403", cases)

        # S5: mutations without a matching Origin.
        cases = []
        for method, path in (("POST", "/api/board"), ("PUT", "/api/board"), ("POST", "/api/mv"),
                             ("POST", "/api/notes/append")):
            for o in (None, FOREIGN, "null"):
                cases.append((f"{method} {path} Origin {o}", request(method, path, auth(o), b"{}")[::2]))
        cases.append(("GET /api/cat foreign", request("GET", "/api/cat?path=/etc/hostname", auth(FOREIGN))[::2]))
        all_403("T-S5 mutation without a matching Origin: 403", cases)

        # S6: everything right, but the TCP source is not the trusted proxy.
        src = ("127.0.0.2", 0)
        cases = [
            ("GET /api/info", request("GET", "/api/info", auth(), source=src)[::2]),
            ("PUT /api/board", request("PUT", "/api/board", auth(ORIGIN), b"{}", source=src)[::2]),
            ("upgrade /pty", upgrade("/pty", auth(ORIGIN), source=src)),
        ]
        all_403("T-S6 non-proxy source 127.0.0.2: 403", cases)

        # S7: the prototype RCE, byte for byte: the prototype's handshake (no Origin, no secret),
        # then its open frame whatever the answer was.
        pwned = h.root / "pwned"
        frame = wbctl.encode_frame(0x1, json.dumps({
            "t": "open", "id": "pwn", "cmd": f"touch {pwned}", "parent": "", "cwd": "",
            "cols": 80, "rows": 24, "env": {}}).encode())
        results = []
        for label, addr, host in (("direct", WEB, f"{WEB[0]}:{WEB[1]}"), ("via Caddy", caddy, HOST)):
            key = base64.b64encode(os.urandom(16)).decode()
            handshake = (f"GET /pty?token= HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
                         f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
            with wbctl.connect(addr, timeout=10) as s:
                s.sendall(handshake.encode())
                resp = b""
                try:
                    while b"\r\n\r\n" not in resp:
                        chunk = s.recv(4096)
                        if not chunk:
                            break
                        resp += chunk
                    s.sendall(frame)
                except OSError:
                    pass
            results.append((label, resp.split(b"\r\n", 1)[0].decode("latin-1")))
        time.sleep(1.0)
        t.check("T-S7 prototype RCE replay: 403 direct and via Caddy",
                all(" 403 " in line + " " for _, line in results), repr(results))
        t.check("T-S7 no pwned file", not pwned.exists())
        sessions = pty_list(h)
        t.check("T-S7 hub has no PTY session after every denied request (S1-S7)", sessions == [], repr(sessions))

        # S8: an upgrade to an unknown path with full auth: 404.
        cases = [(path, upgrade(path, auth(ORIGIN))) for path in ("/", "/api/info", "/ptyx", "/pty/", "/mcp")]
        bad = [(path, st) for path, (st, _) in cases if st != 404]
        t.check("T-S8 upgrade to an unknown path with full auth: 404", not bad, repr(bad))

        # S9: ?token= and X-Token are ignored; nothing token-shaped reaches wb-web's log.
        plain = request("GET", "/api/info", auth())[0]
        tok = request("GET", "/api/info?token=garbage", auth() + [("X-Token", "garbage")])[0]
        ws_plain = upgrade("/pty", auth(ORIGIN))[0]
        ws_tok = upgrade("/pty?token=garbage", auth(ORIGIN) + [("X-Token", "garbage")])[0]
        only_tok = request("GET", "/api/info?token=garbage", auth(secret=None) + [("X-Token", good)])[0]
        t.check("T-S9 token ignored: 200/101 with full auth, 403 without the secret",
                (plain, tok, ws_plain, ws_tok, only_tok) == (200, 200, 101, 101, 403),
                repr((plain, tok, ws_plain, ws_tok, only_tok)))
        mark2 = "ab" * 32
        request("GET", "/api/info?token=WBMARK1", auth(secret=mark2) + [("X-Token", "WBMARK3")])
        request("GET", "/api/info?token=WBMARK1", auth() + [("X-Token", "WBMARK3")])
        time.sleep(0.5)
        web_log = (h.root / "web.log").read_text(errors="replace")
        leaked = [m for m in ("WBMARK1", mark2, "WBMARK3", good) if m in web_log]
        t.check("T-S9 wb-web's log has no token, secret or X-Token value", not leaked, repr(leaked))

        # S10: Caddy overwrites a client-supplied secret header; the same header direct is refused.
        via = request("GET", "/api/info", auth(secret=flipped), addr=caddy)[0]
        direct = request("GET", "/api/info", auth(secret=flipped))[0]
        t.check("T-S10 wrong client secret: 200 via Caddy, 403 direct", (via, direct) == (200, 403), repr((via, direct)))

        # S11: a /pty session works through Caddy; cross-origin OPTIONS gets no CORS headers.
        caddy_ep = wbctl.Endpoint(ORIGIN, unix=caddy)
        r = wbctl.pty_session(caddy_ep, "t-s11", spawn=True, send="echo ECHO-$((6*7))", expect="ECHO-42")
        t.check("T-S11 /pty through Caddy: 101 and echo", r["status"] == 101 and r["matched"] == "ECHO-42",
                repr({k: r[k] for k in ("status", "error", "close", "matched")}))
        st_f, hd_f, _ = request("OPTIONS", "/api/board", auth(FOREIGN, secret=None) + [
            ("Access-Control-Request-Method", "PUT")], addr=caddy)
        st_m, hd_m, _ = request("OPTIONS", "/api/board", auth(ORIGIN, secret=None) + [
            ("Access-Control-Request-Method", "PUT")], addr=caddy)
        cors = [k for k in list(hd_f) + list(hd_m) if k.startswith("access-control-")]
        t.check("T-S11 OPTIONS via Caddy: foreign Origin 403, matching Origin 405, no Access-Control-*",
                (st_f, st_m) == (403, 405) and not cors, repr((st_f, st_m, cors)))

        # S12: a /pty message above 2 MiB closes that socket; the hub and the PTY carry on.
        r = wbctl.pty_session(caddy_ep, "t-s12", spawn=True, send="echo ALIVE-$((1+1))", expect="ALIVE-2")
        ok_open = r["matched"] == "ALIVE-2"
        status, _, ws = wbctl.ws_connect(caddy, "/pty", caddy_ep.headers())
        close = "no 101"
        if status == 101:
            close = "still open"
            try:
                ws.send_json({"t": "open", "id": "t-s12", "cmd": "", "parent": "", "cwd": "",
                              "cols": 80, "rows": 24, "env": {}, "spawn": False})
                ws.recv_json()
                ws.send_text(json.dumps({"t": "in", "d": "x" * (2 * 1024 * 1024)}))
                for _ in range(1000):
                    ws.recv_text(10)
            except wbctl.WsClosed as e:
                close = e.code
            except (OSError, TimeoutError) as e:
                close = f"{type(e).__name__}"
            ws.sock.close()
        r2 = wbctl.pty_session(caddy_ep, "t-s12", spawn=False, send="echo ALIVE-$((1+2))", expect="ALIVE-3")
        t.check("T-S12 message above 2 MiB: socket closed (1009 or reset)",
                close in (1009, None, "ConnectionResetError", "BrokenPipeError"), repr(close))
        t.check("T-S12 hub and PTY unaffected", ok_open and h.hub.poll() is None and r2["matched"] == "ALIVE-3",
                repr((ok_open, h.hub.poll(), r2["matched"], r2["error"])))

        # S13: socket and directory modes.
        t.check("T-S13 hub.sock 0600 in a 0700 directory",
                (mode(h.hub_sock), mode(os.path.dirname(h.hub_sock))) == (0o600, 0o700),
                oct(mode(h.hub_sock)))
        if os.path.exists(h.web_sock):
            t.check("T-S13 web.sock 0600 in a 0700 directory",
                    (mode(h.web_sock), mode(os.path.dirname(h.web_sock))) == (0o600, 0o700),
                    oct(mode(h.web_sock)))
        else:
            t.skip("T-S13 web.sock", "wb-web did not create web.sock (not part of this build)")

        # S14: none of the hub's canaries reach a card; the fixed variables do.
        r = wbctl.pty_session(caddy_ep, "t-s14", spawn=True, send="env; echo ENV-$((1+1))-DONE",
                              expect="ENV-2-DONE", cols=500)
        out = r["output"]
        leaked = [k for k in list(harness.CANARIES) + ["leak-canary"] if k in out]
        missing = [k for k in ("WB_SESSION=t-s14", "TERM=", "SHELL=") if k not in out]
        t.check("T-S14 env canaries absent from a card",
                r["matched"] is not None and not leaked, repr((r["matched"], leaked)))
        t.check("T-S14 WB_SESSION, TERM and SHELL present", r["matched"] is not None and not missing, repr(missing))

        # S16: /api/mv refuses a destination under the sealed paths, directly and through a symlinked
        # parent; the source stays where it was.
        home = h.home
        for d in (".ssh", ".config/systemd/user", ".local/share/systemd", "x", "mv-src"):
            (home / d).mkdir(parents=True, exist_ok=True)
        for link, target in (("sshlink", ".ssh"), ("cfglink", ".config"), ("sharelink", ".local/share")):
            (home / link).symlink_to(home / target)
        json_auth = auth(ORIGIN) + [("Content-Type", "application/json")]
        cases = [
            ("~/.ssh/authorized_keys", ".ssh/authorized_keys"),
            ("~/.config/systemd/user/x.service", ".config/systemd/user/x.service"),
            ("~/.local/share/systemd/x", ".local/share/systemd/x"),
            (f"{home}/.ssh/authorized_keys", ".ssh/authorized_keys"),
            ("~/.ssh", ".ssh/authorized_keys"),  # an existing directory: dst/<basename(src)>
            ("~/x/../.ssh/authorized_keys", ".ssh/authorized_keys"),
            ("~/sshlink/authorized_keys", ".ssh/authorized_keys"),
            ("~/cfglink/systemd/user/x.service", ".config/systemd/user/x.service"),
            ("~/sharelink/systemd/x", ".local/share/systemd/x"),
        ]
        bad = []
        for i, (dst, landed) in enumerate(cases):
            src = home / "mv-src" / str(i) / "authorized_keys"
            src.parent.mkdir()
            src.write_text("ssh-ed25519 AAAA test\n")
            st, _, body = request("POST", "/api/mv", json_auth, json.dumps({"src": str(src), "dst": dst}).encode())
            if st != 400 or (home / landed).exists() or not src.exists():
                bad.append((dst, st, body[:80], (home / landed).exists()))
                (home / landed).unlink(missing_ok=True)
        t.check("T-S16 /api/mv into ~/.ssh, ~/.config/systemd, ~/.local/share/systemd: 400, no file", not bad, repr(bad))
        ok_src, ok_dst = home / "mv-ok", home / "mv-ok-moved"
        ok_src.write_text("x")
        st, _, body = request("POST", "/api/mv", json_auth, json.dumps({"src": str(ok_src), "dst": str(ok_dst)}).encode())
        t.check("T-S16 control: an ordinary move gives 200", st == 200 and ok_dst.exists() and not ok_src.exists(),
                repr((st, body[:80])))

        # S17: an open without spawn:true never spawns, whatever its cmd and env say.
        pwned2, bash_env = h.root / "pwned2", h.root / "bash-env"
        bash_env.write_text(f"touch {h.root}/pwned3\n")
        ghost = {}
        for label, spawn in (("absent", None), ("false", False)):
            r = wbctl.pty_session(caddy_ep, "ghost", spawn=spawn, cmd=f"touch {pwned2}",
                                  env={"BASH_ENV": str(bash_env)}, timeout=10)
            ghost[label] = r
        time.sleep(0.5)
        t.check("T-S17 /pty open with spawn absent or false: error not_found, no hello",
                all((r["error"] or {}).get("code") == "not_found" and r["hello"] is None for r in ghost.values()),
                repr({k: (r["error"], r["hello"] is not None) for k, r in ghost.items()}))
        t.check("T-S17 the socket closes 1000 after that error",
                all(r["close"] == 1000 for r in ghost.values()), repr({k: r["close"] for k, r in ghost.items()}))
        t.check("T-S17 no file; hub list has no ghost",
                not pwned2.exists() and not (h.root / "pwned3").exists() and "ghost" not in sids(h), repr(sids(h)))
        st, _, ws = wbctl.ws_connect(WEB, "/acp", auth(ORIGIN))
        if st == 404:
            t.skip("T-S17 /acp open without agent and cwd", "/acp is 404 in this build (the relay lands in M3)")
        else:
            m = None
            if st == 101:
                try:
                    ws.send_json({"t": "open", "id": "ghost2", "since": 0})
                    m = ws.recv_json()
                except (wbctl.WsClosed, OSError, TimeoutError) as e:
                    m = repr(e)
                ws.close()
            t.check("T-S17 /acp open without agent and cwd: not_found; no session",
                    isinstance(m, dict) and m.get("code") == "not_found" and "ghost2" not in sids(h), repr((st, m)))

        # S21, server half (the browser half is ui N30): a board node carrying cmd and env is stored
        # as data and starts nothing, and opening its card without spawn finds no session.
        before = sids(h)
        pwned21 = h.root / "pwned21"
        node = {"id": "t-s21", "kind": "term", "backend": "pty", "name": "t-s21", "x": 0, "y": 0, "w": 400,
                "h": 300, "cmd": f"touch {pwned21}", "env": {"BASH_ENV": str(bash_env)}}
        board = {"v": 5, "nodes": {"t-s21": node}, "edges": [], "strokes": [], "shapes": [], "views": {},
                 "cam": {"x": 0, "y": 0, "z": 0.5}}
        etag = request("GET", "/api/board", auth())[1].get("etag", "")
        st_put = request("PUT", "/api/board", json_auth + [("If-Match", etag)], json.dumps(board).encode())[0]
        st_get, _, back = request("GET", "/api/board", auth())
        r = wbctl.pty_session(caddy_ep, "t-s21", spawn=False, timeout=10)
        time.sleep(0.5)
        t.check("T-S21 a board with a cmd/env node is stored as data (PUT 204, GET returns it)",
                (st_put, st_get) == (204, 200) and body_json(back) == board, repr((st_put, st_get, back[:80])))
        t.check("T-S21 nothing spawned; its card opens not_found",
                sids(h) == before and (r["error"] or {}).get("code") == "not_found" and not pwned21.exists(),
                repr((before, sids(h), r["error"])))

        # S23: the board ETag passes Caddy unchanged (the vhost never compresses), and a PUT through
        # Caddy with it succeeds.
        st_d, hd_d, _ = request("GET", "/api/board", auth())
        st_c, hd_c, body_c = request("GET", "/api/board", [("Host", HOST), ("Accept-Encoding", "gzip, zstd, br")],
                                     addr=caddy)
        etag = hd_c.get("etag")
        st_p = request("PUT", "/api/board", [("Host", HOST), ("Origin", ORIGIN), ("Content-Type", "application/json"),
                                             ("If-Match", etag or "")], body_c, addr=caddy)[0]
        t.check("T-S23 GET /api/board via Caddy: same ETag as direct, not compressed",
                (st_d, st_c) == (200, 200) and etag == hd_d.get("etag") and etag not in (None, '"empty"')
                and "content-encoding" not in hd_c, repr((st_d, st_c, etag, hd_d.get("etag"), hd_c.get("content-encoding"))))
        t.check("T-S23 PUT via Caddy with that ETag: 204", st_p == 204, repr(st_p))

        # The Caddy modes ui uses (N1-N3), swapped through the admin socket: expired answers API and
        # WebSocket paths with a 302 to /oauth2/sign_in, loginpage with a 200 HTML page; static
        # files and /oauth2/* work in every mode, and a socket opened before a swap keeps working.
        want = {
            "expired": (302, "/oauth2/sign_in", "", 200, 200, 302),
            "loginpage": (200, None, "text/html", 200, 200, 200),
            "live": (200, None, "application/json", 200, 200, 101),
        }
        got, survived = {}, None
        st, _, kept = wbctl.ws_connect(caddy, "/pty", caddy_ep.headers())
        assert st == 101, f"/pty upgrade via Caddy: {st}"
        try:
            kept.send_json({"t": "open", "id": "t-s11", "cmd": "", "parent": "", "cwd": "", "cols": 80, "rows": 24,
                            "env": {}, "spawn": False})
            kept.recv_json()
            for mode in want:
                h.caddy_mode(mode)
                st_b, hd_b, _ = request("GET", "/api/board", [("Host", HOST)], addr=caddy)
                got[mode] = (st_b, hd_b.get("location"), hd_b.get("content-type", "").split(";")[0],
                             request("GET", "/", [("Host", HOST)], addr=caddy)[0],
                             request("GET", "/oauth2/sign_in?rd=%2Ficon.svg", [("Host", HOST)], addr=caddy)[0],
                             upgrade("/pty", caddy_ep.headers(), addr=caddy)[0])
                if mode == "expired":
                    kept.send_json({"t": "in", "d": "echo KEPT-$((2+3))\r"})
                    survived = read_until(kept, "KEPT-5") is not None
        except (RuntimeError, OSError, wbctl.WsClosed, TimeoutError) as e:
            got["error"] = repr(e)[:500]
            h.caddy_mode("live")
        finally:
            kept.close()
        t.check("harness Caddy: live, expired and loginpage modes swap through the admin socket", got == want, repr(got))
        t.check("harness Caddy: a /pty socket opened before a reload keeps working", survived is True, repr(survived))

        # S15: wb-web fails closed on a bad secret or config and never listens.
        port = 18091

        def run_web(mutate=None, secret_text=None, argv_extra=()):
            d = Path(tempfile.mkdtemp(prefix="s15-", dir=h.root))
            cfg = dict(h.web_config, listen=f"127.0.0.1:{port}", stateDir=str(d / "state"),
                       socket=str(d / "web.sock"), proxySecretFile=str(d / "secret"))
            if secret_text is not None:
                (d / "secret").write_text(secret_text)
            if mutate:
                mutate(cfg)
            (d / "web.json").write_text(json.dumps(cfg))
            argv = [h.bin("wb-web"), *argv_extra, "--config", str(d / "web.json")]
            proc = subprocess.Popen(argv, env=h.base_env(), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            listened = False
            deadline = time.monotonic() + 5
            while proc.poll() is None and time.monotonic() < deadline:
                listened = listened or free_port_listening(port)
                time.sleep(0.05)
            harness.Harness.stop_proc(proc)
            return proc.returncode, listened

        rc, listened = run_web(secret_text=good + "\n")
        t.check("T-S15 control: a valid config listens", listened, f"rc={rc}")
        refusals = {
            "missing secret file": run_web(),
            "63-char secret": run_web(secret_text=good[:-1]),
            "uppercase secret": run_web(secret_text=good.upper()),
            "missing trustedProxy": run_web(lambda c: c.pop("trustedProxy"), good),
            "unknown key": run_web(lambda c: c.update(origins="*"), good),
        }
        bad = {k: v for k, v in refusals.items() if v[0] in (0, None) or v[1]}
        t.check("T-S15 bad secret or config: exits non-zero, never listens", not bad, repr(bad))
        rc, listened = run_web(secret_text=good, argv_extra=("--origins", "*"))
        t.check("T-S15 --origins is a usage error (exit 2)", rc == 2 and not listened, f"rc={rc} listened={listened}")

    print(f"{len(t.failed)} failed" if t.failed else "all passed")
    return 1 if t.failed else 0


if __name__ == "__main__":
    sys.exit(main())
