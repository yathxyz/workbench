#!/usr/bin/env python3
"""Black-box conformance over real wb-hub, wb-web and Caddy (20-web §11.4).

  python3 -I tests/test_daemon.py --web-root DIR [--bin-dir DIR]

Sections so far: board (through Caddy, so ETags round-trip through the proxy) and fs (direct,
with the proxy secret). Each section is a function of (suite, harness) listed in SECTIONS; later
work packages add theirs. In test mode the harness gives wb-web a temporary HOME, so `~` and the
mv denylist act on throwaway directories. Prints one line per check and exits 1 if any failed.
"""

import argparse
import errno
import json
import os
import sys
import tempfile
import threading
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
    st, body = mv("~/a.txt", "~/c.txt")
    t.check("fs: mv renames", (st, body) == (200, {"ok": True, "src": str(home / "a.txt"), "dst": str(home / "c.txt")})
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

    # Moving ~/.config aside is allowed; putting a directory that carries systemd/user in its place is not.
    planted = root / "planted"
    (planted / "systemd" / "user").mkdir(parents=True)
    (planted / "systemd" / "user" / "x.service").write_text("[Service]\n")
    st, _ = mv("~/.config", "~/config-old")
    st2, body = mv(planted, "~/.config")
    t.check("fs: mv refuses a destination above a protected directory",
            st == 200 and (st2, body) == (400, {"error": REFUSED}) and planted.is_dir()
            and not (home / ".config").exists(), repr((st, st2, body)))

    shm = Path("/dev/shm")
    if not shm.is_dir() or shm.stat().st_dev == root.stat().st_dev:
        t.skip("fs: mv across filesystems", "/dev/shm is missing or on the same filesystem")
    else:
        with tempfile.TemporaryDirectory(dir=shm) as other:
            src = root / "cross.txt"
            src.write_text("X")
            st, body = mv(src, Path(other) / "cross.txt")
            t.check("fs: mv across filesystems is 400 with the OS message",
                    st == 400 and str((body or {}).get("error", "")).startswith(os.strerror(errno.EXDEV))
                    and src.exists() and not (Path(other) / "cross.txt").exists(), repr((st, body)))


SECTIONS = [board, fs]


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
