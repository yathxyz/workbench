#!/usr/bin/env python3
"""Offline conformance of real ACP adapters against a real wb-hub (lib.adapterCheck, 10 §11.4).

  python3 -I tests/adapter_probe.py --agents FILE [--bin-dir DIR]

FILE holds hub.json's `agents` object ({name: {label, argv, env}}). The probe starts wb-hub
(from --bin-dir, else PATH) with a temporary state directory, bash from $BASH as its shell,
and NO_BROWSER=1 in every child's environment; run it with a throwaway HOME. Nothing here
needs credentials or network, and the probe never prompts.

For each agent it creates one session and waits for setup to end, then requires:
  - the initialize result was ACP v1 (`protocolVersion == 1`);
  - it advertised `loadSession` or `sessionCapabilities.resume`, and when setup got a session,
    the hub computed it `revivable`;
  - setup ended in `session`, or in `setup_error` `auth_required`/`agent_error` (the agent
    answered `session/new` with a JSON-RPC error, as a logged-out agent does offline);
  - stderr.log has no `[stdout]` line, which is what the hub writes for agent stdout it could
    not parse;
  - `acp.kill{forget}` succeeds, and wb-hub is still running without having panicked.
Prints stderr.log and one line per check; exits 1 if any check failed.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import wbctl  # noqa: E402

SETUP_END = ("session", "setup_error", "exit")
ACCEPTED_SETUP_ERRORS = ("auth_required", "agent_error")
# Longer than the hub's SETUP_IDLE_TIMEOUT (30 s), which ends a silent setup itself.
SETUP_WAIT = 60.0


def bin_path(bin_dir, name):
    path = os.path.join(bin_dir, name) if bin_dir else shutil.which(name)
    if not path or not os.access(path, os.X_OK):
        raise RuntimeError(f"{name} not found (use --bin-dir or PATH)")
    return os.path.abspath(path)


def start_hub(root, agents, bin_dir):
    bash = os.environ.get("BASH")
    if not bash or not os.path.isabs(bash):
        raise RuntimeError("no absolute bash: set $BASH")
    config = {
        "socket": str(root / "hub.sock"),
        "stateDir": str(root / "state"),
        "host": "adapter-probe",
        "shells": [{"name": "bash", "paths": [bash], "args": ["-i"]}],
        "defaultShell": "bash",
        "child": {"passEnv": ["PATH"], "setEnv": {"NO_BROWSER": "1"}},
        "agents": agents,
    }
    (root / "hub.json").write_text(json.dumps(config, indent=2))
    env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LOGNAME") if k in os.environ}
    with open(root / "hub.log", "ab") as log:
        hub = subprocess.Popen([bin_path(bin_dir, "wb-hub"), "--config", str(root / "hub.json")], env=env,
                               stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    deadline = time.monotonic() + 15
    while not (root / "hub.sock").exists():
        if hub.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError("wb-hub did not start:\n" + (root / "hub.log").read_text(errors="replace"))
        time.sleep(0.1)
    return hub, config


def setup(sock, sid, agent, cwd):
    """Create the session and read its events until setup ends; returns (events, error)."""
    hub = wbctl.HubClient(sock, timeout=SETUP_WAIT)
    try:
        reply, events = hub.request({"t": "acp.open", "rid": 1, "sid": sid, "since": 0,
                                     "spawn": {"agent": agent, "cwd": cwd}})
        if reply.get("t") != "ok":
            return [], f"acp.open: {reply}"
        evs = [m["ev"] for m in events if m.get("t") == "acp.ev"]
        while not any(e.get("e") in SETUP_END for e in evs):
            m = hub.recv()
            if m.get("t") == "acp.ev":
                evs.append(m["ev"])
        return evs, None
    except (OSError, EOFError, TimeoutError) as e:
        return [], f"{type(e).__name__}: {e}"
    finally:
        hub.close()


def facts(sock, sid):
    """The session's current Summary and AcpSessionInfo, from a fresh attach."""
    hub = wbctl.HubClient(sock)
    try:
        reply, _ = hub.request({"t": "acp.open", "rid": 1, "sid": sid, "since": 0})
        return reply.get("summary") or {}, reply.get("session") or {}
    finally:
        hub.close()


def kill(sock, sid):
    hub = wbctl.HubClient(sock, timeout=SETUP_WAIT)
    try:
        reply, _ = hub.request({"t": "acp.kill", "rid": 1, "sid": sid, "forget": True})
        return reply
    finally:
        hub.close()


def probe(name, sock, state, cwd, check):
    sid = f"probe-{name}"
    evs, err = setup(sock, sid, name, cwd)
    end = next((e for e in reversed(evs) if e.get("e") in SETUP_END), {})
    summary, session = facts(sock, sid) if err is None else ({}, {})
    caps = session.get("agentCapabilities") or {}
    advertised = caps.get("loadSession") is True or "resume" in (caps.get("sessionCapabilities") or {})
    revivable = (summary.get("acp") or {}).get("revivable")
    log = Path(state) / "acp" / f"{sid}.stderr.log"
    stderr = log.read_text(errors="replace") if log.exists() else ""
    print(f"--- {name}: setup ended with {json.dumps(end)}")
    print(f"--- {name}: stderr.log ({len(stderr)} bytes, last 40 lines)")
    print("\n".join(stderr.splitlines()[-40:]))
    print(f"--- {name}: notices {json.dumps([e for e in evs if e.get('e') == 'notice'])}", flush=True)

    check(f"{name}: setup reached an outcome", err is None and bool(end), err or repr(evs[-5:]))
    check(f"{name}: setup ended in session or {'/'.join(ACCEPTED_SETUP_ERRORS)}",
          end.get("e") == "session" or (end.get("e") == "setup_error" and end.get("code") in ACCEPTED_SETUP_ERRORS),
          json.dumps(end))
    check(f"{name}: initialize gave protocolVersion 1", session.get("protocolVersion") == 1,
          repr(session.get("protocolVersion")))
    check(f"{name}: initialize advertised loadSession or sessionCapabilities.resume", advertised, json.dumps(caps))
    if end.get("e") == "session":
        check(f"{name}: the hub computed the session revivable", revivable is True, repr(summary.get("acp")))
    check(f"{name}: stderr.log has no unparsed stdout line",
          not any(line.startswith("[stdout]") for line in stderr.splitlines()),
          repr([line for line in stderr.splitlines() if line.startswith("[stdout]")][:3]))
    reply = kill(sock, sid)
    check(f"{name}: acp.kill with forget", reply.get("t") == "ok", repr(reply))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--agents", required=True, help="JSON file with hub.json's agents object")
    ap.add_argument("--bin-dir")
    a = ap.parse_args()
    agents = json.loads(Path(a.agents).read_text())
    failed = []

    def check(label, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f": {detail}" if detail and not ok else ""), flush=True)
        if not ok:
            failed.append(label)

    root = Path(tempfile.mkdtemp(prefix="wb-probe-"))
    hub = None
    try:
        hub, config = start_hub(root, agents, a.bin_dir)
        cwd = root / "cwd"
        cwd.mkdir()
        for name in agents:
            try:
                probe(name, config["socket"], config["stateDir"], str(cwd), check)
            except (OSError, EOFError) as e:
                check(f"{name}: hub.sock conversation", False, f"{type(e).__name__}: {e}")
        log = (root / "hub.log").read_text(errors="replace")
        check("wb-hub still running and never panicked", hub.poll() is None and "panicked" not in log,
              "\n" + "\n".join(log.splitlines()[-20:]))
    except RuntimeError as e:
        print(f"adapter_probe: {e}", file=sys.stderr)
        return 1
    finally:
        if hub is not None:
            hub.terminate()
            try:
                hub.wait(10)
            except subprocess.TimeoutExpired:
                hub.kill()
                hub.wait()
        shutil.rmtree(root, ignore_errors=True)
    print(f"{len(failed)} failed" if failed else "all passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
