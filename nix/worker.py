"""One socket-activated worker. PID 1 monitors the connection, not the ACP traffic."""

import ctypes
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import sys
import time

# python -I deliberately excludes even the script directory. Both modules are installed
# together in the immutable store, never imported from the worker's HOME or checkout.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import worker_checkout

HEADER_MAX = 16 * 1024


def unique_fields(pairs):
    obj = dict(pairs)
    if len(obj) != len(pairs):
        raise ValueError("duplicate worker header field")
    return obj


def read_header(sock):
    """Consume exactly the first line, even if binary checkout data has already arrived."""
    deadline = time.monotonic() + 10
    line = bytearray()
    try:
        while len(line) < HEADER_MAX:
            sock.settimeout(max(0, deadline - time.monotonic()))
            peek = sock.recv(min(4096, HEADER_MAX - len(line)), socket.MSG_PEEK)
            if not peek:
                break
            end = peek.find(b"\n")
            line.extend(sock.recv(len(peek) if end < 0 else end + 1))
            if line.endswith(b"\n"):
                header = json.loads(line.decode("utf-8"), object_pairs_hook=unique_fields)
                if not isinstance(header, dict):
                    raise ValueError("expected an object")
                return header
    finally:
        sock.setblocking(True)
    raise ValueError("incomplete or oversized worker header")


def agent_command(cfg, header):
    if header.keys() != {"op", "agent", "sid", "cwd", "env"} or header["op"] != "agent":
        raise ValueError("invalid agent header fields")
    name, sid, cwd, names = (header[k] for k in ("agent", "sid", "cwd", "env"))
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]{1,32}", name) or name not in cfg["agents"]:
        raise ValueError("unconfigured agent")
    if not isinstance(sid, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", sid):
        raise ValueError("invalid session id")
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or "\0" in cwd:
        raise ValueError("invalid working directory")
    allowed = cfg["env"] | cfg["agents"][name]["env"]
    fixed = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME")}
    fixed.update(SHELL=cfg["shell"], WB_SESSION=sid)
    if not isinstance(names, list) or not all(
        isinstance(n, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", n)
        and (n in allowed or n in fixed) for n in names
    ) or len(set(names)) != len(names):
        raise ValueError("invalid environment name list")
    # No value from the hub or an unlisted service variable reaches the agent.
    env = {n: allowed[n] for n in names if n in allowed} | fixed
    argv = cfg["agents"][name]["argv"]
    if not os.path.isabs(argv[0]) or not os.path.isfile(argv[0]) or not os.access(argv[0], os.X_OK):
        raise ValueError("configured agent executable is not available")
    return argv, env, open_cwd(cfg["root"], cwd)


def open_cwd(root, cwd):
    # Resolve legitimate in-tree symlinks, then walk the resulting names WITHOUT
    # following symlinks a second time. In particular, the root's parent is worker-writable.
    root = Path(root)
    relative = Path(cwd).resolve(strict=True).relative_to(root)
    if not relative.parts:
        raise ValueError("working directory must be a checkout below the worker root")
    fd = worker_checkout.open_root(str(root))
    try:
        for part in relative.parts:
            child = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def reply(sock, obj):
    sock.sendall(json.dumps(obj).encode("ascii") + b"\n")


def run_child(cfg, header, sock):
    op = header.get("op")
    if op in ("create", "export", "remove"):
        worker_checkout.handle(cfg, header, sock)
        return
    if op != "agent":
        raise ValueError("unknown worker operation")
    try:
        argv, env, cwd = agent_command(cfg, header)
        os.fchdir(cwd)
        os.close(cwd)
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as e:
        reply(sock, {"error": str(e)[:512]})
        raise
    # Acknowledge in the child BEFORE exec: an adapter may write to stdout immediately.
    # Its pid is informational, in this unit's namespace, never a hub signal target.
    reply(sock, {"pid": os.getpid()})
    # Python ignores SIGPIPE; exec should have ordinary command-line semantics.
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    os.execve(argv[0], argv, env)


def serve(cfg, sock):
    try:
        header = read_header(sock)
    except (ValueError, OSError, RecursionError) as e:
        reply(sock, {"error": str(e)[:512]})
        return
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    pid = os.fork()
    if pid == 0:
        try:
            run_child(cfg, header, sock)
        except (ValueError, OSError, RuntimeError, KeyError, TypeError) as e:
            print(f"worker: {e}", file=sys.stderr, flush=True)
            os._exit(1)
        os._exit(0)
    # Open while the child is still ours (possibly a zombie), then auto-reap
    # orphan descendants adopted as namespace init. Don't steal any ACP bytes:
    # RDHUP wakes even with unread data and even if the adapter ignores stdin.
    leader = os.pidfd_open(pid)
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    try:
        poll = select.poll()
        poll.register(leader, select.POLLIN)
        poll.register(sock, select.POLLRDHUP | select.POLLHUP | select.POLLERR)
        poll.poll()
    finally:
        os.close(leader)
        sock.shutdown(socket.SHUT_RDWR)
    # Returning from PID 1 kills the entire namespace, even setsid descendants.


def main():
    if os.getpid() != 1:
        raise RuntimeError("worker requires a private PID namespace")
    # No same-uid ptrace, process_vm_writev, or /proc/1/mem access to the supervisor.
    # Descendants cannot SIGSTOP/SIGKILL their namespace init (pid_namespaces(7)).
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE)")
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)
    with socket.socket(fileno=0) as sock:
        serve(cfg, sock)


if __name__ == "__main__":
    main()
