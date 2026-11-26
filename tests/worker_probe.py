"""Offline ACP agent for nix/vm.nix. Report what the running adapter can actually do."""

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys


def send(**fields):
    print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)


def access_error(op):
    try:
        op()
    except OSError as error:
        return error.errno
    return 0


def inspect(hooks):
    def git(*args, check=True):
        return subprocess.run(["git", *args], capture_output=True, text=True, check=check)

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(2)
        socket_error = access_error(lambda: peer.connect("/run/workbench-hub/hub.sock"))
    # Even an explicitly private clone can be exported; the owner cannot read its .git/config.
    Path.cwd().chmod(0o700)
    report = {
        "uid": os.geteuid(), "pid": os.getpid(), "cwd": os.getcwd(),
        "home": os.environ["HOME"], "sid": os.environ["WB_SESSION"],
        "ownerFile": access_error(Path("/run/worker-probe-owner-file").read_bytes),
        "socket": socket_error,
        "secret": access_error(Path("/run/secrets/worker-probe").read_bytes),
        "branch": git("symbolic-ref", "--short", "HEAD").stdout.strip(),
        "base": git("rev-parse", "HEAD").stdout.strip(),
    }
    Path("from-worker").write_text("committed by the isolated ACP adapter\n")
    git("add", "--", "from-worker")
    git("-c", "user.name=VM agent", "-c", "user.email=agent@example.invalid", "commit", "-m", "agent change")
    report["commit"] = git("rev-parse", "HEAD").stdout.strip()
    # The clone's ref-update policy must not reach the process updating the owner's branch.
    # This hook is just `false` in the Nix store, so its refusal does not depend on uid or cwd.
    git("config", "core.hooksPath", hooks)
    report["hookRefused"] = git("update-ref", "refs/heads/hook-control", "HEAD", check=False).returncode != 0
    return report


def main(hooks):
    for line in sys.stdin:
        req = json.loads(line)
        method = req.get("method")
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}
        elif method == "session/new":
            result = {"sessionId": "vm-probe"}
        elif method == "session/prompt":
            report = inspect(hooks)
            # A different process group, with no ACP descriptors. Closing the socket or just
            # killing the leader's process group cannot clean this up on its own.
            stray = subprocess.Popen(["sleep", "infinity"], start_new_session=True, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            report["stray"] = stray.pid
            send(method="session/update", params={"sessionId": "vm-probe", "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": json.dumps(report)},
            }})
            result = {"stopReason": "end_turn"}
        else:
            if "id" in req:
                send(id=req["id"], error={"code": -32601, "message": "method not found"})
            continue
        send(id=req["id"], result=result)

    # Stay alive on EOF: the unit, not a well-behaved adapter, guarantees cleanup.
    while True:
        signal.pause()


if __name__ == "__main__":
    main(sys.argv[1])
