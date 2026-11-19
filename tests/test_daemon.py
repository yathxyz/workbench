#!/usr/bin/env python3
"""Black-box conformance over real wb-hub, wb-web and Caddy (20-web §11.4).

  python3 -I tests/test_daemon.py --web-root DIR [--bin-dir DIR]

Sections cover the board (through Caddy), fs (direct, with the proxy secret), session configuration
(through /acp), and managed worktrees (through the mesh API, with real git and the fake ACP agent).
Each section is a function of (suite, harness) listed in SECTIONS. The hub and web have a temporary
HOME; all repositories, worktrees and session state live under the harness's temporary directory.
Prints one line per check and exits 1 if any failed.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
from contextlib import closing
from pathlib import Path

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


def worktrees(t, h):
    repo = h.home.resolve() / "checkout"
    repo.mkdir()
    git_bin = h.bin("git")

    def git(*args):
        # No inherited GIT_DIR, config, identity or cwd from the developer's checkout.
        return subprocess.run([git_bin, *args], cwd=repo, check=True, capture_output=True,
                              text=True, timeout=15, env={"HOME": str(h.home), "LC_ALL": "C",
                                                         "GIT_CONFIG_NOSYSTEM": "1"}).stdout.strip()

    git("init", "-b", "main")
    (repo / "seed").write_text("seed contents\n")
    (repo / ".gitattributes").write_text("seed filter=rollback-test\n")
    git("add", "--", "seed", ".gitattributes")
    git("-c", "user.name=Conformance", "-c", "user.email=test@example.invalid",
        "commit", "-m", "seed")
    head = git("rev-parse", "HEAD")
    sibling = repo.with_name(repo.name + "-wt")

    def registered(path):
        return f"worktree {path}" in git("worktree", "list", "--porcelain", "-z").split("\0")

    auth = Path(h.api_tokens["near"]).read_text().strip()
    headers = [("Host", f"{harness.API_ADDR[0]}:{harness.API_ADDR[1]}"),
               ("Authorization", "Bearer " + auth), ("Content-Type", "application/json")]

    def api(method, path, want, body=None):
        status, _, data = wbctl.http_request(harness.API_ADDR, method, "/v1/" + path, headers,
                                             json.dumps(body).encode() if body is not None else None)
        if status != want:
            raise AssertionError(f"{method} {path}: expected {want}, got {status}: {data!r}")
        return body_json(data)

    def restart_hub():
        h.stop_proc(h.hub)
        h.start_hub()
        with closing(wbctl.HubClient(h.hub_sock)) as hub:
            hello = hub.hello
        # Wait for the web's watch connection to *this incarnation*, not an old cached Summary.
        harness.wait_until(lambda: api("GET", "info", 200)["hub"]["startedAt"] == hello["startedAt"],
                           "web watch of restarted hub", h.web)
        return hello

    def refused(sid, **extra):
        spawn = dict(agent="stub", cwd=str(repo), worktree={"branch": sid}, **extra)
        api("POST", "sessions", 400, dict(sid=sid, **spawn))
        with closing(wbctl.HubClient(h.hub_sock)) as hub:
            result, _ = hub.request({"t": "acp.open", "rid": 1, "sid": sid, "since": 0, "spawn": spawn})
        t.check(f"worktree: {sid} refused by both API and hub without creating anything",
                result.get("code") == "bad_request" and not (sibling / sid).exists()
                and not git("branch", "--list", sid)
                and not any(s["sid"] == sid for s in wbctl.hub_sessions(h.hub_sock)), repr(result))

    with closing(wbctl.HubClient(h.hub_sock)) as hub:
        t.check("worktree: unconfigured hub has no capability", not hub.hello.get("acpWorktree"))
    refused("wt_disabled")
    remote = h.host + "-other"
    h.hub_config["git"] = git_bin
    h.agents["missing"] = {"label": "Missing executable", "argv": [str(h.root / "not-installed")]}
    h.hub_config["hosts"] = {remote: {"argv": [h.bin("false")], "agents": {"stub": {"label": "Stub"}}}}
    h.write_json("hub.json", h.hub_config)
    t.check("worktree: configured hub advertises capability", restart_hub().get("acpWorktree") is True)
    refused("wt_remote", host=remote)

    # Verify the HTTP status and error produced by git, not a simulated hub refusal.
    error = api("POST", "sessions", 409, {"agent": "stub", "sid": "wt_checked_out", "cwd": str(repo),
                                         "worktree": {"branch": "main"}})
    t.check("worktree: existing checkout refuses a second checkout of its branch",
            error.get("code") == "conflict" and error["error"].startswith("fatal:")
            and not (sibling / "main").exists(), repr(error))
    occupied = sibling / "occupied"
    occupied.mkdir()
    witness = occupied / "keep"
    witness.write_text("original")
    error = api("POST", "sessions", 409, {"agent": "stub", "sid": "wt_occupied", "cwd": str(repo),
                                         "worktree": {"branch": "occupied"}})
    t.check("worktree: an occupied path is untouched and the branch is not created",
            error.get("code") == "conflict" and witness.read_text() == "original"
            and not git("branch", "--list", "occupied"), repr(error))

    # An exec failure is accepted (the API returns 201 only for new:true), not an abandoned open.
    dead = "wt_exec_failed"
    path = sibling / dead
    created = api("POST", "sessions", 201, {"agent": "missing", "sid": dead, "cwd": str(repo),
                                            "worktree": {"branch": dead}})
    summary = created["session"]
    events = api("GET", "sessions/" + dead + "/events", 200)["events"]
    t.check("worktree: an accepted exec failure keeps its dead session, journal and worktree",
            summary["alive"] is False and summary["cwd"] == str(path) and registered(path)
            and summary["acp"].get("managedWorktree") == {"path": str(path), "mainRoot": str(repo), "branch": dead}
            and any(e["e"] == "setup_error" and e["code"] == "spawn_failed" for e in events)
            and not any(e["e"] in ("spawn", "exit") for e in events), repr((summary, events)))

    # Force a real refusal *after* git add by blocking the session's journal path with a directory
    # (even root cannot unlink it as a file).
    def refuse_session_files(sid):
        blocker = Path(h.hub_config["stateDir"]) / "acp" / (sid + ".jsonl")
        blocker.mkdir()
        try:
            return api("POST", "sessions", 502, {"sid": sid, "cwd": str(repo), "agent": "stub",
                                                 "worktree": {"branch": sid}})
        finally:
            blocker.rmdir()

    failed = "wt_rollback"
    error = refuse_session_files(failed)
    t.check("worktree: refused creation rolls back checkout and registration, not the new branch",
            error.get("code") == "internal" and not (sibling / failed).exists()
            and not registered(sibling / failed) and git("rev-parse", "refs/heads/" + failed) == head
            and not any(s["sid"] == failed for s in wbctl.hub_sessions(h.hub_sock)), repr(error))

    # A real checkout filter in this temporary repository makes rollback unsafe. No force, and
    # tell the caller exactly where the checkout and the untracked contents can be recovered.
    failed = "wt_rollback_dirty"
    path = sibling / failed
    git("config", "--local", "filter.rollback-test.smudge", h.bin("tee") + " rollback-witness")
    try:
        error = refuse_session_files(failed)
    finally:
        git("config", "--local", "--unset", "filter.rollback-test.smudge")
    t.check("worktree: failed rollback reports the path and keeps the dirty checkout without a session",
            str(path) in error["error"] and "left" in error["error"].lower() and registered(path)
            and (path / "rollback-witness").read_text() == "seed contents\n"
            and not any(s["sid"] == failed for s in wbctl.hub_sessions(h.hub_sock)), repr(error))

    sid, branch = "wt_managed", "feat/session"
    session = "sessions/" + sid
    wt = sibling / "feat-session"
    managed = {"mainRoot": str(repo), "branch": branch, "path": str(wt)}

    def wait_summary(path, condition, why):
        def ready():
            # A create reply may precede the session notification on the web's watch connection.
            status, _, data = wbctl.http_request(harness.API_ADDR, "GET", "/v1/" + path, headers)
            return status == 200 and condition(json.loads(data))

        harness.wait_until(ready, why, h.web)

    def check_agent(via):
        wait_summary(session, lambda s: s["alive"] and s["acp"]["activity"] == "none"
                     and s["acp"]["agentSessionId"], "ACP setup after " + via)
        events = api("GET", session + "/events", 200)["events"]
        spawn = next(e for e in reversed(events) if e["e"] == "spawn")
        actual = os.readlink(f"/proc/{spawn['pid']}/cwd")
        summary = api("GET", session, 200)
        t.check("worktree: " + via + " uses the managed root as the actual agent cwd",
                spawn["via"] == via and actual == str(wt) and summary["cwd"] == actual
                and summary["acp"].get("managedWorktree") == managed, repr((spawn, actual, summary)))

    created = api("POST", "sessions", 201, {"agent": "stub", "sid": sid, "cwd": str(repo),
                                            "worktree": {"branch": branch}})
    t.check("worktree: POST returns managed worktree facts under acp",
            created["session"]["acp"].get("managedWorktree") == managed and registered(wt), repr(created))
    check_agent("new")
    wait_summary(session, lambda s: s.get("branch") == branch and s.get("worktree") == wt.name,
                 "web's derived branch and worktree labels")
    api("DELETE", session + "/worktree", 409)
    t.check("worktree: removal while running leaves the registration", registered(wt) and wt.is_dir())

    restart_hub()
    recovered = api("GET", session, 200)
    t.check("worktree: restart keeps the dead, revivable session's cwd and record",
            recovered["alive"] is False and recovered["acp"]["revivable"]
            and recovered["cwd"] == str(wt) and recovered["acp"].get("managedWorktree") == managed,
            repr(recovered))
    api("POST", session + "/revive", 200)
    check_agent("revive")
    api("DELETE", session, 200)
    wait_summary(session, lambda s: not s["alive"], "ACP kill")

    # A second session in exactly the same cwd does not own this worktree.
    other = "sessions/wt_unmanaged"
    api("POST", "sessions", 201, {"agent": "stub", "sid": "wt_unmanaged", "cwd": str(wt)})
    wait_summary(other, lambda s: s["alive"], "unmanaged ACP session")
    api("DELETE", other, 200)
    wait_summary(other, lambda s: not s["alive"], "unmanaged ACP kill")
    api("DELETE", other + "/worktree", 404)
    t.check("worktree: a session in a linked checkout cannot remove one it did not make", registered(wt))

    untracked = wt / "untracked.txt"
    untracked.write_text("keep this\n")
    error = api("DELETE", session + "/worktree", 409)
    t.check("worktree: untracked file refuses removal, retaining contents, registration and record",
            error.get("code") == "conflict" and "untracked" in error["error"] and "\n" not in error["error"]
            and untracked.read_text() == "keep this\n" and registered(wt)
            and api("GET", session, 200)["acp"].get("managedWorktree") == managed, repr(error))
    untracked.unlink()
    api("DELETE", session + "/worktree", 200)
    wait_summary(session, lambda s: not s["alive"] and s["acp"].get("managedWorktree") is None,
                 "cleared managed worktree record")
    restart_hub()
    t.check("worktree: cleared record stays cleared on restart",
            api("GET", session, 200)["acp"].get("managedWorktree") is None)
    api("DELETE", session + "/worktree", 404)
    t.check("worktree: clean removal clears record and registration but retains branch",
            not wt.exists() and not registered(wt) and git("rev-parse", "refs/heads/" + branch) == head)

    forgotten = "wt_forget"
    path = sibling / forgotten
    api("POST", "sessions", 201, {"agent": "stub", "sid": forgotten, "cwd": str(repo),
                                  "worktree": {"branch": forgotten}})
    wait_summary("sessions/" + forgotten, lambda s: s["alive"], "session to forget")
    api("DELETE", "sessions/" + forgotten + "?forget=true", 200)
    t.check("worktree: forgetting a live session leaves its checkout and branch",
            (path / ".git").is_file() and registered(path) and git("rev-parse", "refs/heads/" + forgotten) == head
            and not any(s["sid"] == forgotten for s in wbctl.hub_sessions(h.hub_sock)))


SECTIONS = [board, fs, session_config, configured_open, worktrees]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--web-root", default=os.environ.get("WB_WEB_ROOT"), required=not os.environ.get("WB_WEB_ROOT"))
    p.add_argument("--bin-dir")
    a = p.parse_args()

    t = Suite()
    h = harness.Harness(a.web_root, a.bin_dir, api=True)
    h.web_config["api"]["clients"]["near"]["scopes"].append("read")
    h.write_json("web.json", h.web_config)
    with h:
        for section in SECTIONS:
            section(t, h)

    print(f"{len(t.failed)} failed" if t.failed else "all passed")
    return 1 if t.failed else 0


if __name__ == "__main__":
    sys.exit(main())
