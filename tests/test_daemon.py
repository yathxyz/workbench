#!/usr/bin/env python3
"""Black-box conformance over real wb-hub, wb-web and Caddy (20-web §11.4).

  python3 -I tests/test_daemon.py --web-root DIR [--bin-dir DIR]

Sections: board (through Caddy, so ETags round-trip through the proxy), fs (direct, with the proxy
secret), session configuration and session permission policy (through /acp, the hub and the fake
ACP agent). Each section is a function of (suite, harness) listed in SECTIONS. In test mode the
harness gives wb-web a temporary HOME, so `~` and the mv denylist act on throwaway directories.
Prints one line per check and exits 1 if any failed.
"""

import argparse
import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import harness  # noqa: E402
import wbctl  # noqa: E402

WEB = harness.WEB_ADDR
ORIGIN = harness.PUBLIC_ORIGIN
HOST = ORIGIN.split("://", 1)[1]
EMPTY = '"empty"'
REFUSED = "refused: the destination is in or above ~/.ssh or a systemd user-unit directory"


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


def body_json(body):
    try:
        return json.loads(body)
    except ValueError:
        return None


def quote(value):
    return "".join(c if c.isalnum() or c in "-._/~" else "".join(f"%{b:02X}" for b in c.encode()) for c in value)


def board(t, h):
    caddy = h.caddy_sock
    board_file = h.boards_dir / f"{h.web_config['host']}.json"

    def get():
        st, hd, body = wbctl.http_request(caddy, "GET", "/api/board", [("Host", HOST)])
        return st, hd, body

    def put(body, *if_match):
        headers = [("Host", HOST), ("Origin", ORIGIN)] + [("If-Match", v) for v in if_match]
        st, hd, raw = wbctl.http_request(caddy, "PUT", "/api/board", headers, body=body)
        return st, hd, body_json(raw)

    status, _, rpc = wbctl.ws_connect(caddy, "/rpc", [("Host", HOST), ("Origin", ORIGIN)])
    t.check("board: /rpc opens through Caddy", status == 101, repr(status))

    def next_board():
        while True:
            msg = rpc.recv_json()
            if msg.get("t") == "board":
                return msg

    note = next_board()
    t.check("board: /rpc names the board's tag on connect, \"empty\" on a fresh install",
            note == {"t": "board", "etag": EMPTY}, repr(note))

    st, hd, body = get()
    t.check("board: a fresh boardsDir gives null with ETag \"empty\"",
            (st, body, hd.get("etag"), hd.get("cache-control")) == (200, b"null", EMPTY, "no-store"),
            repr((st, body[:80], hd.get("etag"), hd.get("cache-control"))))

    first = json.dumps({"nodes": [{"id": "a1"}], "edges": []}).encode()
    st, _, body = put(first)
    t.check("board: PUT without If-Match is 428 and writes nothing",
            (st, body) == (428, {"error": "If-Match required"}) and not board_file.exists(), repr((st, body)))

    st, hd, _ = put(first, EMPTY)
    tag1 = hd.get("etag")
    t.check("board: PUT with If-Match \"empty\" on a fresh install is 204 with a new ETag",
            st == 204 and tag1 not in (None, EMPTY), repr((st, tag1)))
    note = next_board()
    t.check("board: the write is announced on /rpc as board{etag}", note == {"t": "board", "etag": tag1}, repr(note))
    st, hd, body = get()
    t.check("board: GET returns the bytes written and the same ETag through Caddy",
            (st, body, hd.get("etag")) == (200, first, tag1), repr((st, body[:80], hd.get("etag"))))
    t.check("board: the file is 0600", board_file.exists() and board_file.stat().st_mode & 0o777 == 0o600,
            oct(board_file.stat().st_mode) if board_file.exists() else "missing")

    second = json.dumps({"nodes": [{"id": "b2"}], "edges": []}).encode()
    refusals = {label: put(second, tag) for label, tag in (
        ('"empty" with a board', EMPTY), ("stale", '"1-2-3"'), ("weak", f"W/{tag1}"), ("*", "*"))}
    bad = {k: (st, body) for k, (st, _, body) in refusals.items()
           if (st, body) != (412, {"error": "board changed elsewhere", "etag": tag1})}
    t.check("board: a mismatched If-Match is 412 naming the current ETag", not bad, repr(bad))
    t.check("board: refused writes leave the file alone", board_file.read_bytes() == first)

    st, hd, _ = put(second, tag1)
    tag2 = hd.get("etag")
    t.check("board: PUT with the current ETag is 204 and the ETag changes", st == 204 and tag2 not in (None, tag1),
            repr((st, tag2)))
    note = next_board()
    t.check("board: refusals sent no notice; the next one is this write's", note.get("etag") == tag2, repr(note))

    # Ten writers holding the same ETag: one wins, nine see the winner's ETag.
    results = [None] * 10
    gate = threading.Barrier(10)

    def writer(i):
        gate.wait()
        results[i] = put(json.dumps({"writer": i}).encode(), tag2)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(10)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    won = [i for i, (st, _, _) in enumerate(results) if st == 204]
    winner_tag = results[won[0]][1].get("etag") if len(won) == 1 else None
    losers_ok = all(st == 412 and body.get("etag") == winner_tag
                    for i, (st, _, body) in enumerate(results) if i not in won)
    t.check("board: ten concurrent PUTs with one ETag give one 204 and nine 412",
            len(won) == 1 and losers_ok, repr([r[0] for r in results]))
    t.check("board: the file holds the winner's body",
            len(won) == 1 and json.loads(board_file.read_bytes()) == {"writer": won[0]})
    note = next_board()
    t.check("board: the winner's write is announced", note.get("etag") == winner_tag, repr(note))

    # As Syncthing does: a new file renamed over the board.
    tmp = board_file.with_name(".syncthing.tmp")
    tmp.write_bytes(b'{"remote":true}')
    os.replace(tmp, board_file)
    st, _, body = put(b"{}", winner_tag)
    _, hd, current = get()
    t.check("board: after an outside replace the old ETag is 412 with the new one",
            st == 412 and (body or {}).get("etag") == hd.get("etag") and current == b'{"remote":true}',
            repr((st, body, hd.get("etag"))))

    st, _, body = put(b'{"nodes":', hd.get("etag"))
    t.check("board: invalid JSON is 400", st == 400 and str((body or {}).get("error", "")).startswith("invalid JSON"),
            repr((st, body)))
    rpc.close()


def fs(t, h):
    home = h.home.resolve()
    root = h.root.resolve()

    def call(method, target, body=None):
        headers = [("Host", HOST), (wbctl.SECRET_HEADER, h.secret)]
        if method != "GET":
            headers.append(("Origin", ORIGIN))
        st, hd, raw = wbctl.http_request(WEB, method, target, headers, body=body)
        return st, body_json(raw), hd

    def get(endpoint, path, extra=""):
        st, body, _ = call("GET", f"/api/{endpoint}?path={quote(str(path))}{extra}")
        return st, body

    def mv(src, dst):
        st, body, _ = call("POST", "/api/mv", json.dumps({"src": str(src), "dst": str(dst)}).encode())
        return st, body

    notes = home / "notes"
    notes.mkdir()
    (notes / "fsrs.md").write_text("---\ntitle: FSRS notes\n---\nIntro paragraph.\n")
    os.symlink(notes / "fsrs.md", home / "fsrs-link.md")
    os.link(notes / "fsrs.md", home / "fsrs-hard.md")
    (home / "Docs").mkdir()

    st, ls = get("ls", "~")
    entries = {e["name"]: e for e in (ls or {}).get("entries", [])}
    t.check("fs: ls ~ lists wb-web's HOME with the host", st == 200 and ls["path"] == str(home.resolve())
            and ls["host"] == h.web_config["host"], repr((st, ls and ls.get("path"))))
    mine = ["Docs", "notes", "fsrs-hard.md", "fsrs-link.md"]
    names = [e["name"] for e in ls["entries"] if e["name"] in mine] if st == 200 else []
    t.check("fs: ls puts directories first, then names without case", names == mine, repr(names))
    link = entries.get("fsrs-link.md", {})
    t.check("fs: ls reports symlink targets", link.get("link") == str(notes / "fsrs.md"), repr(link))
    hard = entries.get("fsrs-hard.md", {})
    t.check("fs: ls reports inode identity and hard-link counts",
            hard.get("nlink") == 2 and hard.get("ino") == os.stat(notes / "fsrs.md").st_ino and "nlink" not in link,
            repr((hard, link)))
    st, ls_root = get("ls", "/")
    proc = {e["name"]: e for e in (ls_root or {}).get("entries", [])}.get("proc", {})
    t.check("fs: ls marks mount points", st == 200 and proc.get("mount") is True, repr(proc))
    st, body = get("ls", "~/missing")
    t.check("fs: ls of a missing directory is 400 JSON", st == 400 and "error" in (body or {}), repr((st, body)))

    st, s = get("stat", "~/fsrs-link.md")
    t.check("fs: stat follows the link and reports size and a float mtime",
            st == 200 and s["path"] == str(notes / "fsrs.md") and s["exists"] is True and s["dir"] is False
            and s["size"] == (notes / "fsrs.md").stat().st_size and isinstance(s["mtime"], float), repr(s))
    st, s = get("stat", "~/nope")
    t.check("fs: stat of a missing path is exists:false", (st, s) == (200, {"path": str(home / "nope"), "exists": False}),
            repr((st, s)))

    st, c = get("cat", "~/notes/fsrs.md")
    t.check("fs: cat returns text and size", st == 200 and c["text"].startswith("---\ntitle: FSRS")
            and c["size"] == (notes / "fsrs.md").stat().st_size, repr((st, c)))
    st, c = get("cat", "~/notes/fsrs.md", "&limit=3")
    t.check("fs: cat honours limit", (st, c and c["text"]) == (200, "---"), repr((st, c)))
    (home / "blob").write_bytes(b"\x00\x01binary")
    st, c = get("cat", "~/blob")
    t.check("fs: cat reports binary files", (st, c and c["text"]) == (200, "(binary file)"), repr((st, c)))
    st, c = get("cat", "~/notes")
    t.check("fs: cat of a directory is 400", (st, c) == (400, {"error": "not a regular file"}), repr((st, c)))

    (home / "a.txt").write_text("A")
    (home / "b.txt").write_text("B")
    # The harness runs edwind, so a move is its rename-file (edwind spec R4.49): the answer also names the buffer
    # ids of both ends (R6.1).
    st, body = mv("~/a.txt", "~/c.txt")
    t.check("fs: mv renames", (st, body) == (200, {"ok": True, "src": str(home / "a.txt"), "dst": str(home / "c.txt"),
                                                    "from": "~/a.txt", "to": "~/c.txt"})
            and (home / "c.txt").read_text() == "A", repr((st, body)))
    st, body = mv("~/c.txt", "~/b.txt")
    t.check("fs: mv never replaces", (st, body) == (400, {"error": "destination exists"})
            and (home / "b.txt").read_text() == "B" and (home / "c.txt").exists(), repr((st, body)))
    st, body = mv("~/c.txt", "~/Docs")
    t.check("fs: mv into a directory", st == 200 and (home / "Docs" / "c.txt").exists(), repr((st, body)))

    # T-S16's shapes, plus a symlinked parent outside HOME pointing into ~/.ssh.
    for d in (".ssh", ".config/systemd/user", ".local/share/systemd"):
        (home / d).mkdir(parents=True)
    evil = root / "evil_ak"
    evil.write_text("ssh-ed25519 AAAA attacker\n")
    os.symlink(home / ".ssh", root / "to-ssh")
    denied = {}
    for dst in ("~/.ssh/authorized_keys", "~/.config/systemd/user/x.service", "~/.local/share/systemd/x",
                str(root / "to-ssh" / "authorized_keys"), str(root / "to-ssh")):
        st, body = mv(evil, dst)
        if (st, body) != (400, {"error": REFUSED}):
            denied[dst] = (st, body)
    created = [str(p) for d in (".ssh", ".config/systemd", ".local/share/systemd") for p in (home / d).rglob("*")
               if not p.is_dir()]
    t.check("fs: mv refuses ~/.ssh and the systemd user-unit directories, also through a symlinked parent",
            not denied, repr(denied))
    t.check("fs: refused moves leave the source and create nothing", evil.exists() and not created, repr(created))

    # edwind's authority covers the source too (R14.8): moving ~/.config aside moves ~/.config/systemd and is
    # refused. With ~/.config gone (moved here directly), a directory that carries systemd/user may not take its
    # place either.
    planted = root / "planted"
    (planted / "systemd" / "user").mkdir(parents=True)
    (planted / "systemd" / "user" / "x.service").write_text("[Service]\n")
    st, _ = mv("~/.config", "~/config-old")
    aside = (home / ".config").is_dir()
    os.rename(home / ".config", home / "config-old")
    st2, body = mv(planted, "~/.config")
    t.check("fs: mv refuses a source or destination above a protected directory",
            st == 400 and aside and (st2, body) == (400, {"error": REFUSED}) and planted.is_dir()
            and not (home / ".config").exists(), repr((st, aside, st2, body)))

    # Both ends must be in edwind's writable paths (the harness gives it the home): a move out of it moves nothing.
    src = home / "out.txt"
    src.write_text("X")
    st, body = mv(src, root / "out.txt")
    t.check("fs: mv outside edwind's writable paths is 400 and moves nothing",
            st == 400 and "outside the writable paths" in str((body or {}).get("error", ""))
            and src.exists() and not (root / "out.txt").exists(), repr((st, body)))


def session_config(t, h):
    ep = wbctl.Endpoint(ORIGIN, unix=h.caddy_sock)
    sid = "conformance_config"
    card = wbctl.AcpCard(ep, sid)

    def options():
        return (card.result["info"] or {}).get("acp", {}).get("configOptions")

    def values():
        return {o["id"]: o["currentValue"] for o in options() or []}

    def refused(config_id, value, code, epoch=None):
        mark = card.cursor()
        rid = card.send("set_config_option", configId=config_id, value=value,
                        epoch=card.epoch() if epoch is None else epoch)
        arrived = card.wait(lambda: card.error_for(rid) is not None)
        error = card.error_for(rid) or {}
        return arrived and error.get("code") == code and not card.since(mark, ("config",))

    try:
        opened = card.open(agent="config", cwd=str(h.home.resolve()))
        ready = opened and card.wait(
            lambda: card.since(0, wbctl.SETUP_END) and options() is not None)
        if not t.check("config: /acp offers the agent's initial full options in Summary and session info",
                       ready and values() == {"model": "small", "effort": "low", "thinking": False}
                       and (card.result["info"] or {}).get("session", {}).get("configOptions") == options(),
                       repr(card.result)):
            return

        t.check("config: stale epoch wins over an unoffered id",
                refused("missing", "bad", "stale", epoch=card.epoch() + 1), repr(card.result["errors"]))
        t.check("config: an unoffered select value is rejected",
                refused("effort", "max", "bad_option"), repr(card.result["errors"]))
        t.check("config: a boolean option rejects a string",
                refused("thinking", "true", "bad_option"), repr(card.result["errors"]))

        applied = card.set_config("model", "large")
        applied = applied and card.set_config("effort", "max")
        applied = applied and card.set_config("thinking", True)
        t.check("config: grouped select, dependent choices and booleans round-trip through the agent",
                applied and values() == {"model": "large", "effort": "max", "thinking": True},
                repr(card.result))
        canonicalized = card.set_config("effort", "high") if applied else False
        t.check("config: the agent's whole result, not the requested value, replaces the offering",
                canonicalized and values() == {"model": "large", "effort": "low", "thinking": True},
                repr(card.result))

        live = [e for e in card.result["events"] if e.get("e") == "config"]
        summaries = wbctl.hub_sessions(h.hub_sock)
        summary = next((s for s in summaries if s.get("sid") == sid), {})
        t.check("config: hub list exposes the same materialised full option list",
                bool(live) and summary.get("acp", {}).get("configOptions") == options(), repr(summary))

        replay = wbctl.AcpCard(ep, sid)
        try:
            replayed = replay.open()
            events = [e for e in replay.result["events"] if e.get("e") == "config"]
            t.check("config: journal replay retains every successful full-list result without a prompt",
                    replayed and len(events) == 4 and events == live
                    and (replay.result["info"] or {}).get("acp", {}).get("configOptions") == options()
                    and not any(e.get("e") == "prompt" for e in replay.result["events"]),
                    repr(replay.result))
        finally:
            replay.close()
    finally:
        card.close()
        wbctl.acp_session(ep, sid, kill=True)


def configured_open(t, h):
    ep = wbctl.Endpoint(ORIGIN, unix=h.caddy_sock)

    def values(options):
        return {o["id"]: o["currentValue"] for o in options or []}

    cases = (
        ("ready", [
            {"id": "model", "value": "large"},
            {"id": "effort", "value": "max"},
            {"id": "thinking", "value": True},
        ], [], [
            {"model": "large", "effort": "low", "thinking": False},
            {"model": "large", "effort": "max", "thinking": False},
            {"model": "large", "effort": "max", "thinking": True},
        ]),
        ("errors", [
            {"id": "missing", "value": True},
            {"id": "effort", "value": "max"},
            {"id": "model", "value": "large"},
            {"id": "thinking", "value": True},
        ], [("missing", True, "bad_option"), ("effort", "max", "bad_option")], [
            {"model": "large", "effort": "low", "thinking": False},
            {"model": "large", "effort": "low", "thinking": True},
        ]),
    )
    for name, config, expected_errors, expected_results in cases:
        sid = "conformance_config_open_" + name
        card = wbctl.AcpCard(ep, sid)
        try:
            opened = card.open(agent="config", cwd=str(h.home.resolve()), config=config)
            hello = card.result["hello"] or {}
            info = hello.get("info") or {}
            acp = info.get("acp") or {}
            options = acp.get("configOptions")
            events = card.result["events"]
            applied = [e for e in events if e.get("e") == "config"]
            session_events = [e for e in events if e.get("e") == "session"]
            t.check(f"configured open ({name}): hello already carries the ready configured full list",
                    opened and hello.get("status") == "new" and info.get("alive") is True
                    and acp.get("activity") == "none" and bool(acp.get("agentSessionId"))
                    and values(options) == expected_results[-1]
                    and (info.get("session") or {}).get("configOptions") == options,
                    repr(card.result))

            errors = hello.get("configErrors") or []
            actual_errors = [(e.get("id"), e.get("value"), e.get("code")) for e in errors]
            t.check(f"configured open ({name}): ordered opener errors retain values and required codes",
                    actual_errors == expected_errors
                    and all(isinstance(e.get("error"), str) and e["error"] for e in errors)
                    and bool("configErrors" in hello) == bool(expected_errors)
                    and "configErrors" not in info and not card.result["errors"],
                    repr(hello))
            notices = [e for e in events if e.get("e") == "notice"]
            t.check(f"configured open ({name}): each failure is journaled before later successful options",
                    opened and bool(applied) and len(notices) == len(expected_errors)
                    and all(e.get("level") == "warn" and error[0] in e.get("text", "")
                            for e, error in zip(notices, expected_errors))
                    and all(e["seq"] < applied[0]["seq"] for e in notices),
                    repr(events))
            t.check(f"configured open ({name}): dependent options run in input order and journal full results",
                    opened and [values(e.get("configOptions")) for e in applied] == expected_results
                    and all(len(e.get("configOptions") or []) == 3 for e in applied)
                    and len(session_events) == 1 and bool(applied)
                    and session_events[0]["seq"] < applied[0]["seq"],
                    repr(events))
            t.check(f"configured open ({name}): creation sends no implicit prompt",
                    opened and not any(e.get("e") == "prompt" for e in events), repr(events))

            summary = next((s for s in wbctl.hub_sessions(h.hub_sock) if s.get("sid") == sid), {})
            t.check(f"configured open ({name}): hub list agrees with the initial hello",
                    opened and summary.get("acp", {}).get("configOptions") == options,
                    repr(summary))

            replay = wbctl.AcpCard(ep, sid)
            try:
                attached = replay.open()
                replay_hello = replay.result["hello"] or {}
                t.check(f"configured open ({name}): attach replays results but not opener-only errors",
                        attached and replay_hello.get("status") == "attached"
                        and "configErrors" not in replay_hello
                        and [e for e in replay.result["events"] if e.get("e") == "config"] == applied
                        and (replay_hello.get("info") or {}).get("acp", {}).get("configOptions") == options
                        and not any(e.get("e") == "prompt" for e in replay.result["events"]),
                        repr(replay.result))
            finally:
                replay.close()
        finally:
            card.close()
            wbctl.acp_session(ep, sid, kill=True)


def session_task(t, h):
    sid = "conformance_task"
    hub = wbctl.HubClient(h.hub_sock)
    card = wbctl.AcpCard(wbctl.Endpoint(ORIGIN, unix=h.caddy_sock), sid)
    try:
        reply, _ = hub.request({"t": "acp.open", "rid": 1, "sid": sid, "since": 0,
                                "spawn": {"agent": "stub", "cwd": str(h.home.resolve()), "task": "issue 44"}})
        if not t.check("task: attached page receives the initial reference and its journal event",
                       reply.get("new") and card.open()
                       and card.result["hello"]["info"]["acp"].get("task") == "issue 44"
                       and [e["task"] for e in card.since(0, ("task",))] == ["issue 44"],
                       repr((reply, card.result))):
            return

        cursor = card.cursor()
        reply, _ = hub.request({"t": "acp.set_task", "rid": 2, "sid": sid, "task": None})
        t.check("task: clearing updates an attached page without reconnecting",
                reply.get("t") == "ok" and card.wait(lambda:
                    "task" not in card.result["info"]["acp"]
                    and [e["task"] for e in card.since(cursor, ("task",))] == [None]),
                repr((reply, card.result)))
    finally:
        card.close()
        hub.request({"t": "acp.kill", "rid": 3, "sid": sid, "forget": True})
        hub.close()


def session_policy(t, h):
    ep = wbctl.Endpoint(ORIGIN, unix=h.caddy_sock)
    cwd = str(h.home.resolve())
    empty = {"rules": []}
    allow = {"rules": [{"action": "allow", "kinds": ["execute"], "roots": ["$cwd"],
                        "programs": ["rm"],
                        "command": {"matches": ["rm -rf build"], "notMatches": ["sudo"]}}]}
    reject = {"rules": [{"action": "reject", "kinds": ["execute"], "roots": ["$cwd"],
                         "programs": ["rm"]}]}
    ask = {"rules": [{"action": "ask"}, {"action": "allow"}]}
    fallback = {"rules": [{"action": "allow", "roots": [cwd + "/elsewhere"]}]}
    programs_fallback = {"rules": [{"action": "allow", "kinds": ["execute"], "roots": ["$cwd"],
                                    "programs": ["git"],
                                    "command": {"matches": ["rm -rf build"]}}]}

    class PolicyCard(wbctl.AcpCard):
        def __init__(self, sid):
            self.snapshots = []
            super().__init__(ep, sid, timeout=60.0)

        def handle(self, message):
            if message.get("t") in ("hello", "info"):
                self.snapshots.append(message.get("info") or {})
            super().handle(message)

        def wait_for_published(self, mark, kinds):
            def published():
                events = self.since(mark, kinds)
                head = (self.result["info"] or {}).get("acp", {}).get("headSeq", 0)
                return events and head >= events[-1]["seq"]

            return self.wait(published)

    def request(kind, **fields):
        hub = wbctl.HubClient(h.hub_sock)
        try:
            return hub.request({"t": kind, "rid": 1, **fields})[0]
        finally:
            hub.close()

    def summary(sid):
        return next((s for s in wbctl.hub_sessions(h.hub_sock) if s.get("sid") == sid), {})

    def set_policy(card, policy, epoch=None):
        return request("acp.set_policy", sid=card.sid, policy=policy,
                       epoch=card.epoch() if epoch is None else epoch)

    def start_turn(card):
        mark = card.cursor()
        card.send("prompt", blocks=[{"type": "text", "text": "perm"}])
        return mark

    def auto_turn(card, action):
        mark = start_turn(card)
        ended = card.wait_for_published(mark, wbctl.TURN_END)
        automatic = card.since(mark, ("permission_auto",))
        expected = {"rule": 0, "action": action}
        kind = "allow_once" if action == "allow" else "reject_once"
        option = next((o.get("optionId") for p in automatic for o in p.get("options", [])
                       if o.get("kind") == kind), None)
        status = "completed" if action == "allow" else "failed"
        updates = [e.get("update", {}) for e in card.since(mark, ("update",))]
        t.check(f"policy ({card.sid}): {action} selects only {kind} and the agent finishes",
                ended and len(automatic) == 1 and option is not None
                and automatic[0].get("outcome") == {"outcome": "selected", "optionId": option}
                and any(u.get("sessionUpdate") == "tool_call_update" and u.get("status") == status
                        for u in updates),
                repr(card.since(mark, ("permission_auto", "update", "turn_end"))))
        t.check(f"policy ({card.sid}): one atomic auto event journals the matching rule and answer",
                len(automatic) == 1 and automatic[0].get("policy") == expected
                and automatic[0].get("toolCall", {}).get("rawInput", {}).get("command") == "rm -rf build"
                and not card.since(mark, ("permission", "permission_resolved")),
                repr(card.since(mark, ("permission_auto", "permission", "permission_resolved"))))
        current = summary(card.sid)
        t.check(f"policy ({card.sid}): auto answers never appear in a pending snapshot",
                ended and not card.pending_permissions() and current.get("acp", {}).get("pending") == []
                and all(not s.get("acp", {}).get("pending") for s in card.snapshots),
                repr((card.snapshots, current)))
        if automatic:
            late = request("acp.permission", sid=card.sid, req=automatic[0]["seq"], epoch=card.epoch(),
                           outcome={"outcome": "selected", "optionId": option})
            t.check(f"policy ({card.sid}): a viewer cannot answer an automatically resolved request",
                    late.get("code") == "already_resolved", repr(late))

    def pending_turn(card):
        mark = start_turn(card)
        waiting = card.wait_for_published(mark, ("permission",))
        permissions = card.since(mark, ("permission",))
        permission = permissions[0] if permissions else None
        current = summary(card.sid)
        t.check(f"policy ({card.sid}): ask fallback leaves an unannotated user-answerable request",
                waiting and permission is not None and "policy" not in permission
                and not card.since(mark, ("permission_resolved",))
                and [p.get("req") for p in current.get("acp", {}).get("pending", [])]
                == [permission["seq"]],
                repr((permissions, current)))
        return mark, permission

    def answer_turn(card, mark, permission):
        if permission is None:
            return False
        card.answer(permission, "allow_once")
        ended = card.wait(lambda: card.since(mark, wbctl.TURN_END))
        resolved = card.since(mark, ("permission_resolved",))
        return (ended and len(resolved) == 1 and resolved[0].get("req") == permission["seq"]
                and resolved[0].get("by") == "user" and "policy" not in resolved[0]
                and not card.pending_permissions())

    def replay_policy(card, expected):
        replay = PolicyCard(card.sid)
        try:
            opened = replay.open()
            kinds = ("policy", "permission_auto", "permission", "permission_resolved")
            journal = [e for e in card.result["events"] if e.get("e") in kinds]
            replayed = [e for e in replay.result["events"] if e.get("e") in kinds]
            facts = (replay.result["hello"] or {}).get("info", {}).get("acp", {})
            t.check(f"policy ({card.sid}): replay preserves policy changes and decision evidence",
                    opened and replayed == journal and bool(journal)
                    and facts.get("policy") == expected and facts.get("pending") == [],
                    repr((replayed, facts)))
        finally:
            replay.close()

    invalid_programs = [None, "rm", [1], [""], ["rm -rf"], ["rm\tbuild"], ["rm\nbuild"],
                        ["rm\u00a0build"], ["rm\u2003build"], ["r\0m"], ["x" * 257],
                        ["é" * 129], ["rm"] * 65]
    for programs in invalid_programs:
        invalid = {"rules": [{"action": "allow", "programs": programs}]}
        refused = request("acp.open", sid="conformance_policy_invalid", since=0,
                          spawn={"agent": "stub", "cwd": cwd, "policy": invalid})
        t.check(f"policy: invalid programs {programs!r} is rejected before spawn",
                refused.get("code") == "bad_request" and not summary("conformance_policy_invalid"),
                repr(refused))

    for name, policy in (("allow", allow), ("reject", reject), ("fallback", fallback),
                         ("programs_fallback", programs_fallback), ("ask", ask),
                         ("unexamined_agent", allow)):
        sid = "conformance_policy_" + name
        card = PolicyCard(sid)
        agent = "stub" if name == "unexamined_agent" else "omp"
        try:
            opened = request("acp.open", sid=sid, since=0,
                             spawn={"agent": agent, "cwd": cwd, "policy": policy})
            attached = card.open()
            ready = attached and card.wait(lambda: card.since(0, wbctl.SETUP_END))
            t.check(f"policy ({name}): hub spawn installs and journals policy before requests",
                    opened.get("t") == "ok" and opened.get("new") is True and ready
                    and opened.get("summary", {}).get("acp", {}).get("policy") == policy
                    and [e.get("policy") for e in card.since(0, ("policy",))] == [policy]
                    and summary(sid).get("acp", {}).get("policy") == policy,
                    repr((opened, card.result)))
            if not ready:
                continue
            if name in ("allow", "reject"):
                if name == "allow":
                    mark = card.cursor()
                    ignored = request("acp.open", sid=sid, since=mark,
                                      spawn={"agent": "stub", "cwd": cwd, "policy": reject})
                    t.check("policy: spawn policy on an existing attach is ignored",
                            ignored.get("t") == "ok" and ignored.get("new") is False
                            and ignored.get("summary", {}).get("acp", {}).get("policy") == allow
                            and summary(sid).get("acp", {}).get("policy") == allow,
                            repr(ignored))
                auto_turn(card, name)
                t.check(f"policy ({name}): attaches and turns do not silently replace the spawn policy",
                        [e.get("policy") for e in card.since(0, ("policy",))] == [policy],
                        repr(card.since(0, ("policy",))))
                replay_policy(card, policy)
                continue

            mark, permission = pending_turn(card)
            if name in ("fallback", "programs_fallback", "unexamined_agent"):
                reason = {"fallback": "unmatched roots", "programs_fallback": "unlisted program",
                          "unexamined_agent": "unexamined agent execution"}[name]
                t.check(f"policy: {reason} retains ordinary user resolution",
                        answer_turn(card, mark, permission), repr(card.result))
                replay_policy(card, policy)
                continue

            old_pending = summary(sid).get("acp", {}).get("pending")
            replacement_mark = card.cursor()
            replacement = set_policy(card, allow)
            replaced = card.wait(lambda: card.since(replacement_mark, ("policy",)))
            current = summary(sid)
            t.check("policy: epoch-checked replacement is journaled without answering existing pending",
                    replacement.get("t") == "ok" and replaced
                    and [e.get("policy") for e in card.since(replacement_mark, ("policy",))] == [allow]
                    and current.get("acp", {}).get("policy") == allow
                    and current.get("acp", {}).get("pending") == old_pending and bool(old_pending)
                    and not card.since(mark, ("permission_resolved",)),
                    repr((replacement, current, card.result)))
            t.check("policy: a request pending across replacement still accepts a user answer",
                    answer_turn(card, mark, permission), repr(card.result))
            # Earlier snapshots correctly contain the manually pending request; only subsequent
            # snapshots must remain empty for automatically answered requests.
            card.snapshots.clear()
            auto_turn(card, "allow")

            stale_mark = card.cursor()
            stale = set_policy(card, reject, epoch=card.epoch() + 1)
            t.check("policy: stale replacement is refused and does not change current policy",
                    stale.get("code") == "stale" and summary(sid).get("acp", {}).get("policy") == allow,
                    repr(stale))
            replacement = set_policy(card, reject)
            replaced = card.wait(lambda: card.since(stale_mark, ("policy",)))
            t.check("policy: replacement affects future requests and stale writes add no policy event",
                    replacement.get("t") == "ok" and replaced
                    and [e.get("policy") for e in card.since(stale_mark, ("policy",))] == [reject],
                    repr((stale, replacement, card.since(stale_mark, ("policy",)))))
            card.snapshots.clear()
            auto_turn(card, "reject")

            remove_mark = card.cursor()
            removed = set_policy(card, empty)
            removal_seen = card.wait(lambda: card.since(remove_mark, ("policy",)))
            t.check("policy: an empty replacement removes policy and journals its explicit empty value",
                    removed.get("t") == "ok" and removal_seen
                    and [e.get("policy") for e in card.since(remove_mark, ("policy",))] == [empty]
                    and "policy" not in summary(sid).get("acp", {}),
                    repr((removed, summary(sid))))
            mark, permission = pending_turn(card)
            t.check("policy: removal restores ordinary manual permission handling",
                    answer_turn(card, mark, permission), repr(card.result))
            replay_policy(card, None)

            old_epoch = card.epoch()
            forgotten = request("acp.kill", sid=sid, forget=True)
            reborn = request("acp.open", sid=sid, since=0,
                             spawn={"agent": "omp", "cwd": cwd, "policy": allow})
            stale = set_policy(card, reject, epoch=old_epoch)
            t.check("policy: a prior incarnation cannot replace a recreated session's policy",
                    forgotten.get("t") == "ok" and reborn.get("t") == "ok"
                    and reborn.get("summary", {}).get("createdAt") != old_epoch
                    and stale.get("code") == "stale"
                    and summary(sid).get("acp", {}).get("policy") == allow,
                    repr((forgotten, reborn, stale)))
        finally:
            card.close()
            wbctl.acp_session(ep, sid, kill=True)

    sid = "conformance_policy_relay"
    card = PolicyCard(sid)
    try:
        card.send("open", id=sid, since=0, agent="omp", cwd=cwd, policy=allow)
        opened = card.wait(lambda: card.result["replayed"] is not None)
        ready = opened and card.wait(lambda: card.since(0, wbctl.SETUP_END))
        t.check("policy: /acp spawning open forwards policy to the hub",
                ready and (card.result["hello"] or {}).get("status") == "new"
                and (card.result["info"] or {}).get("acp", {}).get("policy") == allow,
                repr(card.result))
        if ready:
            auto_turn(card, "allow")
            replay_policy(card, allow)
    finally:
        card.close()
        wbctl.acp_session(ep, sid, kill=True)


SECTIONS = [board, fs, session_config, configured_open, session_task, session_policy]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--web-root", default=os.environ.get("WB_WEB_ROOT"), required=not os.environ.get("WB_WEB_ROOT"))
    p.add_argument("--bin-dir")
    a = p.parse_args()

    t = Suite()
    with harness.Harness(a.web_root, a.bin_dir) as h:
        for section in SECTIONS:
            section(t, h)

    print(f"{len(t.failed)} failed" if t.failed else "all passed")
    return 1 if t.failed else 0


if __name__ == "__main__":
    sys.exit(main())
