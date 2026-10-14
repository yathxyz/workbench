#!/usr/bin/env python3
"""Small Workbench client for tests (stdlib only).

Web commands speak the browser's /pty WebSocket through the proxy, sending Host and Origin
from --url (and the proxy secret only when --secret-file is given, for direct access). --unix
connects to a unix socket, such as the harness's Caddy, instead of the host and port of --url:

  wbctl.py [...] pty-open SID [--spawn] [--cmd CMD] [--shell NAME] [--send TEXT] [--expect REGEX] [--wait-exit]
  wbctl.py [...] pty-attach SID [--resume STREAM,OUT] [--send TEXT] [--expect REGEX] [--wait-exit]
  wbctl.py [...] pty-kill SID             kills and forgets the session; waits for the close
  wbctl.py [...] acp-new SID --agent NAME --cwd DIR [ACTION...]
  wbctl.py [...] acp-attach SID [--since N] [ACTION...]
  wbctl.py [...] acp-revive SID [ACTION...]
  wbctl.py [...] acp-kill SID [--forget]  without --forget waits for the exit, with it for the close
  wbctl.py [...] api-mv SRC DST           POST /api/mv; prints {status, body}
  wbctl.py [...] page [--text TEXT] [--seconds SECS] [--count N]
  wbctl.py [...] bench [--samples N] [--flood-bytes SIZE] [--ssh-rtt-ms MS]

Hub commands speak NDJSON on hub.sock directly (run them as the hub's user or root):

  wbctl.py [--hub PATH] sessions          prints {"sessions": [...]} from `list`
  wbctl.py [--hub PATH] raw JSON          prints the hub's hello, then every line up to the reply

The acp commands speak /acp: acp-new opens with the spawn fields (agent and cwd, a directory on
the hub's host) and waits for the setup to succeed, acp-revive revives a dead session and waits
for its new `session` event, acp-attach only attaches. ACTION is any of --prompt TEXT (sent as one
text block), --permission OPTION (answer the pending permission, or the one the prompt raises,
with that optionId or option kind), --until-permission (stop at a pending permission instead of
the turn's end) and --expect REGEX (matched against the agent text that arrives live). They wait
for the turn's end after a prompt or an answer. The result carries the hello, `info`, every
journal event, `createdAt` (the epoch), `pending` (unresolved permission requests), `text` and
`ok`.

Every command but raw prints one JSON object on stdout. pty-open sends spawn:true with --spawn
and leaves spawn out otherwise; pty-attach sends spawn:false. --send types TEXT plus Enter;
--expect waits until the live output (after the hello) matches REGEX; --wait-exit waits for the
exit message. The result carries the hello's stream and `lastOut`, the offset to resume from.

page keeps one /rpc client open as a Workbench tab would (DESIGN 3.3, 3.5.3), so that `wb` board
tools have a page to reach: it sends active{ago:0}, prints {"ready": true}, then answers every
`cmd`: read_node with TEXT, any other tool with app.js's error for a tool it does not have. It
prints {"cmd": {tool, input}} per answer and {"done": ...} at the end: after SECS seconds, after N
answers, or when the server closes the socket (exit 1 then, and on a refused upgrade).

bench measures keystroke echo: a card runs cat with the terminal's echo off, and each sample is
the time from sending one character to receiving it back. It then floods a second card with
`yes | head -c SIZE`, drained like a browser by a separate process, and measures echo again
while the flood drains. Budgets (DESIGN 9.6): echo p50 below 1.5x --ssh-rtt-ms (evaluated only
when given) and echo p99 during the flood below 50 ms.

Exit status: 0 ok (bench: every evaluated budget holds), 1 failed, 2 usage.
"""

import argparse
import base64
import http.client
import itertools
import json
import multiprocessing
import os
import re
import socket
import string
import struct
import sys
import time
import urllib.parse

DEFAULT_URL = "http://127.0.0.1:18443"
PAGE_TEXT = "wbctl page: read_node"
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


def connect(addr, timeout=10.0, source=None):
    """A connected stream socket: `addr` is (host, port), or the path of a unix socket."""
    if not isinstance(addr, str):
        return socket.create_connection(addr, timeout=timeout, source_address=source)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(addr)
    except OSError:
        sock.close()
        raise
    return sock


def ws_connect(addr, target, headers, source=None, timeout=10.0):
    """Send an upgrade request with exactly `headers` (plus the WebSocket handshake fields).

    `addr` is as for connect(). Returns (status, response_headers, body_or_websocket): a
    WebSocket on 101, else the body bytes.
    """
    sock = connect(addr, timeout, source)
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
    """One HTTP request with exactly `headers` (duplicates allowed); `addr` is as for connect().

    Returns (status, headers, body).
    """
    # The host argument is unused: the socket is already connected and Host comes from `headers`.
    conn = http.client.HTTPConnection("localhost", timeout=timeout)
    conn.sock = connect(addr, timeout, source)
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
    """Where a web client connects, and the headers that pass the floor through that path.

    Host and Origin come from `url`; the connection goes to `unix` when given, else to its host and port.
    """

    def __init__(self, url, origin=None, secret=None, unix=None):
        u = urllib.parse.urlsplit(url)
        self.addr = unix or (u.hostname, u.port or 80)
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


def pty_session(ep, sid, spawn=None, cmd="", shell=None, env=None, resume=None, send=None, expect=None,
                wait_exit=False, kill=False, timeout=20.0, cols=80, rows=24):
    """Open /pty and send `open`; after the hello, optionally type a line, then wait as asked.

    `spawn` None leaves the field out, which means false from M1 on. After the hello the session
    waits until `expect` matches the live output, `exit` arrived (`wait_exit`), or, with `kill`,
    sends a forgetting kill and waits for the close. `gone` and `error` end it after the close.
    Cursor position queries in the live output are answered as a terminal would (nushell waits
    for them). The result keeps the hello's `replay` apart from `output`, the live `out` text
    after it, and `lastOut`, the stream offset after the last text received.
    """
    result = {"status": None, "hello": None, "replay": None, "output": "", "lastOut": None, "matched": None,
              "exit": None, "gone": None, "error": None, "close": None, "timedOut": False}
    status, _, ws = ws_connect(ep.addr, "/pty", ep.headers(), timeout=timeout)
    result["status"] = status
    if status != 101:
        return result
    msg = {"t": "open", "id": sid, "cmd": cmd, "parent": "", "cwd": "", "cols": cols, "rows": rows, "env": env or {}}
    if spawn is not None:
        msg["spawn"] = spawn
    if shell is not None:
        msg["shell"] = shell
    if resume is not None:
        msg["resume"] = resume
    deadline = time.monotonic() + timeout

    def handle(m):
        t = m.get("t")
        if t == "hello":
            result["hello"] = m
            result["replay"] = m.get("replay")
            result["lastOut"] = m.get("out")
        elif t == "out":
            d = m.get("d", "")
            result["output"] += d
            result["lastOut"] = m.get("out", result["lastOut"])
            for _ in range(d.count("\x1b[6n")):
                ws.send_json({"t": "in", "d": "\x1b[1;1R"})
        elif t in ("exit", "gone", "error"):
            result[t] = m

    def done():
        if result["gone"] is not None or result["error"] is not None or kill:
            return False  # read on until the server closes
        if expect is not None and result["matched"] is None:
            found = re.search(expect, result["output"])
            if not found:
                return False
            result["matched"] = found.group(0)
        return not wait_exit or result["exit"] is not None

    try:
        ws.send_json(msg)
        while result["hello"] is None and result["error"] is None:
            handle(ws.recv_json(deadline - time.monotonic()))
        if result["hello"] is not None:
            if send is not None:
                ws.send_json({"t": "in", "d": send + "\r"})
            if kill:
                ws.send_json({"t": "kill"})
        while not done():
            handle(ws.recv_json(deadline - time.monotonic()))
    except WsClosed as e:
        result["close"] = e.code
    except TimeoutError:
        result["timedOut"] = True
    finally:
        ws.close()
    return result


SETUP_END = ("session", "setup_error", "exit")
TURN_END = ("turn_end", "turn_error")


class AcpCard:
    """One /acp socket (DESIGN 3.5.2). `result` collects what the server sent: the hello, `info`
    (an `info` without `session` keeps the previous session, as the server omits it when
    unchanged), every journal event in `events` (the replay, then live ones), `replayed`, `errors`,
    `gone` and the close code. Requests carry a rid, which the server echoes on `error`."""

    def __init__(self, ep, sid, timeout=20.0):
        self.sid = sid
        self.deadline = time.monotonic() + timeout
        self.rid = 0
        self.ws = None
        self.closed = False
        self.result = {"status": None, "hello": None, "info": None, "events": [], "replayed": None, "errors": [],
                       "gone": None, "close": None, "timedOut": False}
        status, _, ws = ws_connect(ep.addr, "/acp", ep.headers(), timeout=timeout)
        self.result["status"] = status
        if status == 101:
            self.ws = ws
        else:
            self.closed = True

    def send(self, t, **fields):
        self.rid += 1
        self.ws.send_json({"t": t, "rid": self.rid, **fields})
        return self.rid

    def handle(self, m):
        r = self.result
        t = m.get("t")
        if t == "hello":
            r["hello"] = m
            r["info"] = m.get("info")
        elif t == "ev":
            r["events"].append(m["ev"])
        elif t == "replayed":
            r["replayed"] = m
        elif t == "info":
            info = dict(m["info"])
            if "session" not in info and r["info"] and "session" in r["info"]:
                info["session"] = r["info"]["session"]
            r["info"] = info
        elif t == "error":
            r["errors"].append(m)
        elif t == "gone":
            r["gone"] = m

    def wait(self, done):
        """Read until done() holds, a new error arrives, or the socket closes or times out; returns done()."""
        r = self.result
        errors = len(r["errors"])
        try:
            while not self.closed and not done() and len(r["errors"]) == errors:
                self.handle(self.ws.recv_json(self.deadline - time.monotonic()))
        except WsClosed as e:
            self.closed, r["close"] = True, e.code
        except TimeoutError:
            self.closed, r["timedOut"] = True, True
        except OSError as e:
            self.closed, r["close"] = True, type(e).__name__
        return bool(done())

    def open(self, since=0, epoch=None, agent=None, cwd=None):
        """Send `open` and read the hello and the replay; True once `replayed` arrived."""
        if self.ws is None:
            return False
        fields = {"id": self.sid, "since": since}
        for k, v in (("epoch", epoch), ("agent", agent), ("cwd", cwd)):
            if v is not None:
                fields[k] = v
        self.send("open", **fields)
        return self.wait(lambda: self.result["replayed"] is not None)

    def cursor(self):
        """The highest seq this socket knows of."""
        head = (self.result["replayed"] or {}).get("head", 0)
        return max([head] + [e["seq"] for e in self.result["events"]])

    def since(self, seq, kinds):
        return [e for e in self.result["events"] if e["seq"] > seq and e.get("e") in kinds]

    def pending_permissions(self):
        resolved = {e.get("req") for e in self.result["events"] if e.get("e") == "permission_resolved"}
        return [e for e in self.result["events"] if e.get("e") == "permission" and e["seq"] not in resolved]

    def text(self, after=0):
        """The text of the agent's message chunks after seq `after`."""
        out = []
        for e in self.since(after, ("update",)):
            u = e.get("update") or {}
            c = u.get("content") or {}
            if u.get("sessionUpdate") == "agent_message_chunk" and c.get("type") == "text":
                out.append(c.get("text", ""))
        return "".join(out)

    def error_for(self, rid):
        return next((e for e in self.result["errors"] if e.get("rid") == rid), None)

    def epoch(self):
        return (self.result["info"] or {}).get("createdAt")

    def answer(self, perm, choice, epoch=None):
        """Answer the `permission` event `perm` with the option whose optionId, else whose kind, is
        `choice`; `epoch` defaults to this session's."""
        options = perm.get("options") or []
        option = next((o for o in options if o.get("optionId") == choice), None) or next(
            (o for o in options if o.get("kind") == choice), {"optionId": choice})
        return self.send("permission", req=perm["seq"], epoch=self.epoch() if epoch is None else epoch,
                         outcome={"outcome": "selected", "optionId": option["optionId"]})

    def close(self):
        if self.ws is not None:
            self.ws.close()


def acp_session(ep, sid, agent=None, cwd=None, since=0, revive=False, prompt=None, permission=None,
                until_permission=False, expect=None, kill=None, timeout=20.0):
    """Open /acp for `sid` (with spawn fields when `agent` is given) and run these steps in order,
    each only when asked for and only while the previous ones succeeded:

    1. with `agent`: wait for the setup's outcome, which must be a `session` event;
    2. `revive`: send revive and wait for a `session` event after it;
    3. `prompt`: send it as one text block;
    4. `permission`: wait for a pending permission (from before, or raised by the prompt) and
       answer it with that optionId or option kind;
    5. wait: for a pending permission with `until_permission`, else for the turn's end after a
       prompt or an answer; `expect` must then match the agent text that arrived live (with
       nothing else to wait for, wait for the match);
    6. `kill` True or False: send kill{forget}; with forget wait for the close (1000 after the
       late ok), else for the exit event.

    The result is the card's plus `ok`, `createdAt` (the epoch), `pending` (unresolved permission
    requests with their option ids), `text` (the live agent text) and `matched`.
    """
    card = AcpCard(ep, sid, timeout)
    r = card.result
    r.update(ok=False, createdAt=None, pending=[], text="", matched=None)
    if card.ws is None:
        return r
    mark = 0
    try:
        ok = card.open(since, agent=agent, cwd=cwd if agent is not None else None)
        mark = card.cursor()
        if ok and agent is not None:
            ok = card.wait(lambda: card.since(0, SETUP_END)) and card.since(0, SETUP_END)[-1]["e"] == "session"
        if ok and revive:
            card.send("revive")
            ok = card.wait(lambda: card.since(mark, SETUP_END)) and card.since(mark, SETUP_END)[-1]["e"] == "session"
        turn = card.cursor()
        if ok and prompt is not None:
            card.send("prompt", blocks=[{"type": "text", "text": prompt}])
        if ok and permission is not None:
            ok = card.wait(lambda: card.pending_permissions() or card.since(turn, TURN_END)) and bool(
                card.pending_permissions())
            if ok:
                card.answer(card.pending_permissions()[-1], permission)
        if ok and until_permission:
            ok = card.wait(card.pending_permissions)
        elif ok and (prompt is not None or permission is not None):
            ok = card.wait(lambda: card.since(turn, TURN_END))
        if ok and expect is not None:
            if prompt is None and permission is None and not until_permission:
                card.wait(lambda: re.search(expect, card.text(mark)))
            m = re.search(expect, card.text(mark))
            r["matched"] = m.group(0) if m else None
            ok = m is not None
        if ok and kill is not None:
            card.send("kill", forget=kill)
            if kill:
                card.wait(lambda: False)
                ok = r["close"] == 1000
            else:
                ok = card.wait(lambda: card.since(mark, ("exit",)))
        r["ok"] = ok and not r["errors"]
    finally:
        card.close()
    r["createdAt"] = card.epoch()
    r["pending"] = [{"req": e["seq"], "options": [o.get("optionId") for o in e.get("options") or []]}
                    for e in card.pending_permissions()]
    r["text"] = card.text(mark)
    return r


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


def api_mv(ep, src, dst, timeout=10.0):
    body = json.dumps({"src": src, "dst": dst}).encode()
    status, _, data = http_request(ep.addr, "POST", "/api/mv", ep.headers() + [("Content-Type", "application/json")],
                                   body, timeout=timeout)
    return {"status": status, "body": data.decode(errors="replace")}


def page(ep, text, seconds, count, timeout=10.0):
    """One /rpc client that acts as the page `wb` reaches; see the module text."""
    status, _, ws = ws_connect(ep.addr, "/rpc", ep.headers(), timeout=timeout)
    if status != 101:
        print(json.dumps({"done": True, "status": status}), flush=True)
        return 1
    answered, end, closed = 0, time.monotonic() + seconds, None
    try:
        ws.send_json({"t": "active", "ago": 0})
        print(json.dumps({"ready": True}), flush=True)
        while count is None or answered < count:
            # One read until the end: a read that times out mid-frame would lose the frame's start.
            m = ws.recv_json(end - time.monotonic())
            if m.get("t") != "cmd":
                continue
            tool = m.get("tool")
            if tool == "read_node":
                ws.send_json({"t": "cmd_result", "id": m.get("id"), "result": text})
            else:
                ws.send_json({"t": "cmd_result", "id": m.get("id"),
                              "error": f"unknown tool {tool} (wb tools lists them)"})
            answered += 1
            print(json.dumps({"cmd": {"tool": tool, "input": m.get("input")}}), flush=True)
    except TimeoutError:
        pass
    except WsClosed as e:
        closed = e.code if e.code is not None else "eof"
    except OSError as e:
        closed = type(e).__name__
    finally:
        ws.close()
    print(json.dumps({"done": True, "answered": answered, "closed": closed}), flush=True)
    return 0 if closed is None else 1


def open_frame(sid, cmd="", spawn=None):
    msg = {"t": "open", "id": sid, "cmd": cmd, "parent": "", "cwd": "", "cols": 80, "rows": 24, "env": {}}
    if spawn is not None:
        msg["spawn"] = spawn
    return msg


class EchoCard:
    """A card running cat with the terminal's echo off, so each typed byte comes back once, from cat."""

    def __init__(self, ep, sid, timeout):
        status, _, self.ws = ws_connect(ep.addr, "/pty", ep.headers(), timeout=timeout)
        if status != 101:
            raise RuntimeError(f"/pty upgrade for {sid}: HTTP {status}")
        cmd = "stty -echo -icanon min 1 time 0 && echo WB-BENCH-READY && exec cat"
        self.ws.send_json(open_frame(sid, cmd, spawn=True))
        text = ""
        deadline = time.monotonic() + timeout
        while "WB-BENCH-READY" not in text:
            m = self.ws.recv_json(deadline - time.monotonic())
            if m.get("t") in ("exit", "gone", "error"):
                raise RuntimeError(f"echo card {sid}: {m}")
            text += m.get("d", "") if m.get("t") == "out" else ""
        self.letters = itertools.cycle(string.ascii_letters)
        for _ in range(5):  # warm-up; also lets cat start reading
            self.rtt()

    def rtt(self, timeout=5.0):
        ch = next(self.letters)
        t0 = time.perf_counter()
        self.ws.send_json({"t": "in", "d": ch})
        deadline = time.monotonic() + timeout
        while True:
            m = self.ws.recv_json(deadline - time.monotonic())
            if m.get("t") == "out" and ch in m.get("d", ""):
                return time.perf_counter() - t0
            if m.get("t") in ("exit", "gone", "error"):
                raise RuntimeError(f"echo card: {m}")

    def measure(self, n, keep_going=lambda: True):
        samples = []
        while len(samples) < n and keep_going():
            samples.append(self.rtt())
            time.sleep(0.01)
        return samples


def stats(samples):
    s = sorted(samples)
    if not s:
        return {"n": 0}

    def ms(x):
        return round(x * 1000, 2)

    return {"n": len(s), "p50Ms": ms(s[len(s) // 2]), "p99Ms": ms(s[min(len(s) - 1, int(len(s) * 0.99))]),
            "maxMs": ms(s[-1])}


def drain(ep, sid, cmd, timeout, started, report):
    """Run `cmd` in a new card and read its output like a browser until it exits.

    A socket the server closes (a slow viewer) is reattached without spawning.
    """
    chars, spawn = 0, True
    t0 = time.monotonic()
    deadline = t0 + timeout
    while time.monotonic() < deadline:
        try:
            status, _, ws = ws_connect(ep.addr, "/pty", ep.headers())
            if status != 101:
                report.put({"error": f"/pty upgrade: HTTP {status}"})
                return
            try:
                ws.send_json(open_frame(sid, cmd, spawn=spawn))
                spawn = False
                while True:
                    m = ws.recv_json(deadline - time.monotonic())
                    t = m.get("t")
                    if t == "out":
                        chars += len(m.get("d", ""))
                        started.set()
                    elif t == "exit":
                        report.put({"chars": chars, "seconds": round(time.monotonic() - t0, 2), "exit": m})
                        return
                    elif t in ("gone", "error"):
                        report.put({"error": m})
                        return
            finally:
                ws.close()
        except (WsClosed, OSError):
            continue
    report.put({"error": "timed out", "chars": chars})


def bench(ep, samples, flood_bytes, ssh_rtt_ms, timeout):
    tag = os.getpid()
    echo_sid, flood_sid = f"bench-echo-{tag}", f"bench-flood-{tag}"
    try:
        echo = EchoCard(ep, echo_sid, timeout)
        try:
            base = echo.measure(samples)
            ctx = multiprocessing.get_context("fork")
            started, report = ctx.Event(), ctx.Queue()
            proc = ctx.Process(target=drain, args=(ep, flood_sid, f"yes | head -c {flood_bytes}", 600, started, report),
                               daemon=True)
            proc.start()
            during = echo.measure(samples, proc.is_alive) if started.wait(timeout) else []
            flood = report.get(timeout=600)
            proc.join()
        finally:
            echo.ws.close()
    finally:
        for sid in (echo_sid, flood_sid):
            pty_session(ep, sid, kill=True, timeout=10)
    base_s, during_s = stats(base), stats(during)
    budgets = {
        "echoP50Below1.5xSshRtt": base_s["p50Ms"] < 1.5 * ssh_rtt_ms if ssh_rtt_ms else None,
        "floodEchoP99Below50Ms": during_s["p99Ms"] < 50 if during else False,
    }
    return {"echo": base_s, "flood": dict(flood, bytes=flood_bytes, echo=during_s), "budgets": budgets}


def main():
    p = argparse.ArgumentParser(prog="wbctl.py", description=__doc__.splitlines()[0])
    p.add_argument("--url", default=os.environ.get("WB_URL", DEFAULT_URL), help="proxy (or wb-web) base URL")
    p.add_argument("--unix", help="connect to this unix socket instead of the host and port of --url")
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
        s.add_argument("--wait-exit", action="store_true", help="wait for the exit message")
        s.add_argument("--cols", type=int, default=80)
        s.add_argument("--rows", type=int, default=24)
        if name == "pty-open":
            s.add_argument("--spawn", action="store_true", help="send spawn:true (start a process if none runs)")
            s.add_argument("--cmd", default="", help="command for a spawn; empty means a shell")
            s.add_argument("--shell", help="shell name for a spawn (default: the hub's defaultShell)")
        else:
            s.add_argument("--resume", type=parse_resume, metavar="STREAM,OUT")
    sub.add_parser("pty-kill").add_argument("sid")
    for name in ("acp-new", "acp-attach", "acp-revive"):
        s = sub.add_parser(name)
        s.add_argument("sid")
        if name == "acp-new":
            s.add_argument("--agent", required=True)
            s.add_argument("--cwd", required=True, help="absolute directory on the hub's host")
        if name == "acp-attach":
            s.add_argument("--since", type=int, default=0)
        s.add_argument("--prompt", help="send this text as a prompt")
        s.add_argument("--permission", metavar="OPTION", help="answer the pending permission with this optionId or kind")
        s.add_argument("--until-permission", action="store_true", help="wait for a pending permission, not the turn's end")
        s.add_argument("--expect", help="the live agent text must match this regex")
    k = sub.add_parser("acp-kill")
    k.add_argument("sid")
    k.add_argument("--forget", action="store_true")
    g = sub.add_parser("page")
    g.add_argument("--text", default=PAGE_TEXT, help="the answer to read_node")
    g.add_argument("--seconds", type=float, default=300.0, help="stay open this long")
    g.add_argument("--count", type=int, help="end after this many answers")
    m = sub.add_parser("api-mv")
    m.add_argument("src")
    m.add_argument("dst")
    b = sub.add_parser("bench")
    b.add_argument("--samples", type=int, default=200)
    b.add_argument("--flood-bytes", default="200M", help="head -c SIZE for the flood card")
    b.add_argument("--ssh-rtt-ms", type=float, help="ssh round-trip time to compare echo p50 against")
    sub.add_parser("sessions")
    r = sub.add_parser("raw")
    r.add_argument("json", help="one hub request, e.g. '{\"t\":\"list\",\"rid\":1}'")
    a = p.parse_args()

    if a.command in ("sessions", "raw"):
        return hub_command(a)
    secret = open(a.secret_file).read().strip() if a.secret_file else None
    ep = Endpoint(a.url, a.origin, secret, a.unix)
    if a.command == "page":
        return page(ep, a.text, a.seconds, a.count, a.timeout)
    if a.command == "api-mv":
        print(json.dumps(api_mv(ep, a.src, a.dst, a.timeout)))
        return 0
    if a.command == "bench":
        res = bench(ep, a.samples, a.flood_bytes, a.ssh_rtt_ms, a.timeout)
        print(json.dumps(res))
        return 0 if all(v is not False for v in res["budgets"].values()) else 1
    if a.command.startswith("acp-"):
        if a.command == "acp-kill":
            res = acp_session(ep, a.sid, kill=a.forget, timeout=a.timeout)
        else:
            res = acp_session(ep, a.sid, agent=getattr(a, "agent", None), cwd=getattr(a, "cwd", None),
                              since=getattr(a, "since", 0), revive=a.command == "acp-revive", prompt=a.prompt,
                              permission=a.permission, until_permission=a.until_permission, expect=a.expect,
                              timeout=a.timeout)
        print(json.dumps(res))
        return 0 if res["ok"] else 1
    if a.command == "pty-kill":
        res = pty_session(ep, a.sid, kill=True, timeout=a.timeout)
        print(json.dumps(res))
        return 0 if res["close"] == 1000 and res["error"] is None else 1
    opening = a.command == "pty-open"
    res = pty_session(
        ep,
        a.sid,
        spawn=(True if a.spawn else None) if opening else False,
        cmd=a.cmd if opening else "",
        shell=a.shell if opening else None,
        resume=None if opening else a.resume,
        send=a.send,
        expect=a.expect,
        wait_exit=a.wait_exit,
        timeout=a.timeout,
        cols=a.cols,
        rows=a.rows,
    )
    print(json.dumps(res))
    ok = (res["hello"] is not None and (a.expect is None or res["matched"] is not None)
          and (not a.wait_exit or res["exit"] is not None))
    return 0 if ok else 1


def hub_command(a):
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
