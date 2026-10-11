#!/usr/bin/env python3
"""Small Workbench client for tests (stdlib only).

Web commands speak the browser's /pty WebSocket through the proxy, sending Host and Origin
from --url (and the proxy secret only when --secret-file is given, for direct access):

  wbctl.py [--url URL] pty-open SID [--spawn] [--cmd CMD] [--send TEXT] [--expect REGEX]
  wbctl.py [--url URL] pty-attach SID [--resume STREAM,OUT] [--send TEXT] [--expect REGEX]

Hub commands speak NDJSON on hub.sock directly (run them as the hub's user):

  wbctl.py [--hub PATH] sessions          prints {"sessions": [...]} from `list`
  wbctl.py [--hub PATH] raw JSON          sends one request; prints every line up to its reply

pty-* and sessions print one JSON object on stdout; raw prints one line per message. --send types
TEXT plus Enter; --expect waits until the live output (after the hello) matches REGEX.
Exit status: 0 ok, 1 failed, 2 usage.
"""

import argparse
import base64
import http.client
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.parse

DEFAULT_URL = "http://127.0.0.1:18443"
DEFAULT_HUB = "/run/workbench-hub/hub.sock"
SECRET_HEADER = "X-Workbench-Proxy-Secret"


class WsClosed(Exception):
    """The peer sent a close frame (code may be None) or the TCP stream ended."""

    def __init__(self, code):
        super().__init__(f"websocket closed ({code})")
        self.code = code


class WebSocket:
    """A minimal RFC 6455 client: text frames out (masked), text/close/ping in."""

    def __init__(self, sock, buf):
        self.sock = sock
        self.buf = buf

    def send_text(self, text):
        self._send_frame(0x1, text.encode())

    def send_json(self, obj):
        self.send_text(json.dumps(obj))

    def close(self, code=1000):
        try:
            self._send_frame(0x8, struct.pack("!H", code))
        except OSError:
            pass
        self.sock.close()

    def _send_frame(self, opcode, payload):
        self.sock.sendall(encode_frame(opcode, payload))

    def _read(self, n, deadline):
        while len(self.buf) < n:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("websocket read timed out")
            self.sock.settimeout(left)
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise WsClosed(None)
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_text(self, timeout=10.0):
        """Next complete text message. Answers pings; raises WsClosed on close or EOF."""
        deadline = time.monotonic() + timeout
        parts = []
        while True:
            b0, b1 = self._read(2, deadline)
            n = b1 & 0x7F
            if n == 126:
                (n,) = struct.unpack("!H", self._read(2, deadline))
            elif n == 127:
                (n,) = struct.unpack("!Q", self._read(8, deadline))
            mask = self._read(4, deadline) if b1 & 0x80 else None
            payload = self._read(n, deadline)
            if mask:
                payload = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            opcode = b0 & 0x0F
            if opcode == 0x8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                raise WsClosed(code)
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            parts.append(payload)
            if b0 & 0x80:
                return b"".join(parts).decode()

    def recv_json(self, timeout=10.0):
        return json.loads(self.recv_text(timeout))


def encode_frame(opcode, payload):
    """One final, masked client frame."""
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
    elif n < 1 << 16:
        head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
    mask = os.urandom(4)
    key = int.from_bytes(mask * ((n + 3) // 4), "big") >> (8 * (-n % 4))
    return head + mask + (int.from_bytes(payload, "big") ^ key).to_bytes(n, "big")


def ws_connect(addr, target, headers, source=None, timeout=10.0):
    """Send an upgrade request with exactly `headers` (plus the WebSocket handshake fields).

    Returns (status, response_headers, body_or_websocket): a WebSocket on 101, else the body bytes.
    """
    sock = socket.create_connection(addr, timeout=timeout, source_address=source)
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [f"GET {target} HTTP/1.1"]
    lines += [f"{k}: {v}" for k, v in headers]
    lines += ["Upgrade: websocket", "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13"]
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    buf = b""
    deadline = time.monotonic() + timeout
    while b"\r\n\r\n" not in buf:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("no upgrade response")
        sock.settimeout(left)
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode("latin-1").split("\r\n")
    status = int(status_line.split()[1]) if len(status_line.split()) > 1 else 0
    resp = {}
    for line in header_lines:
        k, _, v = line.partition(":")
        resp.setdefault(k.strip().lower(), []).append(v.strip())
    if status == 101:
        return status, resp, WebSocket(sock, rest)
    want = int(resp["content-length"][0]) if "content-length" in resp else None
    sock.settimeout(1.0)
    try:
        while want is None or len(rest) < want:
            chunk = sock.recv(65536)
            if not chunk:
                break
            rest += chunk
    except OSError:
        pass
    sock.close()
    return status, resp, rest


def http_request(addr, method, target, headers, body=None, source=None, timeout=10.0):
    """One HTTP request with exactly `headers` (duplicates allowed). Returns (status, headers, body)."""
    conn = http.client.HTTPConnection(addr[0], addr[1], timeout=timeout, source_address=source)
    try:
        conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
        for k, v in headers:
            conn.putheader(k, v)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        conn.close()


class Endpoint:
    """Where a web client connects, and the headers that pass the floor through that path."""

    def __init__(self, url, origin=None, secret=None):
        u = urllib.parse.urlsplit(url)
        self.addr = (u.hostname, u.port or 80)
        self.host = u.netloc
        self.origin = origin or f"{u.scheme}://{u.netloc}"
        self.secret = secret

    def headers(self, origin=True):
        h = [("Host", self.host)]
        if origin:
            h.append(("Origin", self.origin))
        if self.secret:
            h.append((SECRET_HEADER, self.secret))
        return h


def pty_session(ep, sid, spawn, cmd="", resume=None, send=None, expect=None, timeout=20.0, cols=80, rows=24):
    """Open /pty, send `open`, wait for hello; optionally type a line and wait for live output.

    The result keeps the hello's `replay` apart from `output`, the live `out` text after it.
    """
    result = {"status": None, "hello": None, "replay": None, "output": "", "matched": None,
              "exit": None, "gone": None, "error": None, "close": None}
    status, _, ws = ws_connect(ep.addr, "/pty", ep.headers(), timeout=timeout)
    result["status"] = status
    if status != 101:
        return result
    msg = {"t": "open", "id": sid, "cmd": cmd, "parent": "", "cwd": "", "cols": cols, "rows": rows, "env": {}, "spawn": spawn}
    if resume is not None:
        msg["resume"] = resume
    deadline = time.monotonic() + timeout

    def next_msg():
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("deadline passed")
        return ws.recv_json(left)

    try:
        ws.send_json(msg)
        while result["hello"] is None:
            m = next_msg()
            if m.get("t") == "hello":
                result["hello"] = m
                result["replay"] = m.get("replay")
            elif m.get("t") == "error":
                result["error"] = m
                return result
        if send is not None:
            ws.send_json({"t": "in", "d": send + "\r"})
        while expect is not None:
            found = re.search(expect, result["output"])
            if found:
                result["matched"] = found.group(0)
                break
            m = next_msg()
            t = m.get("t")
            if t == "out":
                result["output"] += m.get("d", "")
            elif t in ("exit", "gone", "error"):
                result[t] = m
                if t != "exit":
                    break
    except WsClosed as e:
        result["close"] = e.code
    except TimeoutError:
        pass
    finally:
        ws.close()
    return result


class HubClient:
    """NDJSON client for hub.sock: reads the server hello, answers with ours."""

    def __init__(self, path, timeout=10.0):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(path)
        self.file = self.sock.makefile("rb")
        self.hello = self.recv()
        self.send({"t": "hello", "proto": 1, "client": "wbctl/0.1.0"})

    def send(self, obj):
        self.sock.sendall(json.dumps(obj, separators=(",", ":")).encode() + b"\n")

    def recv(self):
        line = self.file.readline()
        if not line:
            raise EOFError("hub closed the connection")
        return json.loads(line)

    def request(self, obj):
        """Send a request; return (reply, events received before it)."""
        self.send(obj)
        events = []
        while True:
            m = self.recv()
            if m.get("rid") == obj.get("rid") and m.get("t") in ("ok", "err"):
                return m, events
            events.append(m)

    def close(self):
        self.sock.close()


def hub_sessions(path):
    hub = HubClient(path)
    try:
        reply, _ = hub.request({"t": "list", "rid": 1})
    finally:
        hub.close()
    if reply.get("t") != "ok":
        raise RuntimeError(f"list failed: {reply}")
    return reply["sessions"]


def parse_resume(s):
    stream, _, out = s.partition(",")
    return {"stream": int(stream), "out": int(out)}


def main():
    p = argparse.ArgumentParser(prog="wbctl.py", description=__doc__.splitlines()[0])
    p.add_argument("--url", default=os.environ.get("WB_URL", DEFAULT_URL), help="proxy (or wb-web) base URL")
    p.add_argument("--origin", help="Origin header (default: the origin of --url)")
    p.add_argument("--secret-file", help="send the proxy secret from this file (direct access only)")
    p.add_argument("--hub", default=DEFAULT_HUB, help="hub socket for sessions/raw")
    p.add_argument("--timeout", type=float, default=20.0)
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("pty-open", "pty-attach"):
        s = sub.add_parser(name)
        s.add_argument("sid")
        s.add_argument("--send", help="type this line (plus Enter) after the hello")
        s.add_argument("--expect", help="wait until the live output matches this regex")
        s.add_argument("--cols", type=int, default=80)
        s.add_argument("--rows", type=int, default=24)
        if name == "pty-open":
            s.add_argument("--spawn", action="store_true", help="send spawn:true (start a process if none runs)")
            s.add_argument("--cmd", default="", help="command for a spawn; empty means a shell")
        else:
            s.add_argument("--resume", type=parse_resume, metavar="STREAM,OUT")
    sub.add_parser("sessions")
    r = sub.add_parser("raw")
    r.add_argument("json", help="one hub request, e.g. '{\"t\":\"list\",\"rid\":1}'")
    a = p.parse_args()

    if a.command in ("pty-open", "pty-attach"):
        secret = open(a.secret_file).read().strip() if a.secret_file else None
        ep = Endpoint(a.url, a.origin, secret)
        res = pty_session(
            ep,
            a.sid,
            spawn=a.command == "pty-open" and a.spawn,
            cmd=a.cmd if a.command == "pty-open" else "",
            resume=getattr(a, "resume", None),
            send=a.send,
            expect=a.expect,
            timeout=a.timeout,
            cols=a.cols,
            rows=a.rows,
        )
        print(json.dumps(res))
        ok = res["hello"] is not None and (a.expect is None or res["matched"] is not None)
        return 0 if ok else 1
    if a.command == "sessions":
        print(json.dumps({"sessions": hub_sessions(a.hub)}))
        return 0
    req = json.loads(a.json)
    hub = HubClient(a.hub, timeout=a.timeout)
    try:
        print(json.dumps(hub.hello))
        if "rid" in req:
            reply, events = hub.request(req)
            for m in events + [reply]:
                print(json.dumps(m))
            return 0 if reply.get("t") == "ok" else 1
        hub.send(req)
        return 0
    finally:
        hub.close()


if __name__ == "__main__":
    sys.exit(main())
