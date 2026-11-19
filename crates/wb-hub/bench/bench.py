"""Linux private hub benchmark. Build: cargo build --release -p wb-hub --bin wb-hub.
Run: python3 crates/wb-hub/bench/bench.py {stream,large,replay,fleet,restore,pty,all}.
Compare: pass --hub OLD --hub NEW --repeat 5 (alternates AB/BA). One JSON record/run.
"""

import argparse
import contextlib
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

from metrics import counters, memory

DRIVERS = {'stream': 'live', 'large': 'live', 'replay': 'fleet', 'fleet': 'fleet', 'restore': 'restore', 'pty': 'terminal'}
HERE = Path(__file__).resolve().parent


class Client(contextlib.AbstractContextManager):
    def __init__(self, path):
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.settimeout(30)
        self.socket.connect(str(path))
        self.reader = self.socket.makefile('rb')
        self.hello = self.recv()
        assert self.hello['server'] == 'wb-hub' and self.hello['proto'] == 1
        self.send({'t': 'hello', 'proto': 1, 'client': 'hub-bench'})
        self.rid = 0

    def close(self):
        self.reader.close()
        self.socket.close()

    def __exit__(self, *_):
        self.close()

    def send(self, msg):
        self.socket.sendall(json.dumps(msg, separators=(',', ':')).encode() + b'\n')

    def recv(self):
        line = self.reader.readline(16 * 1024 * 1024 + 1)
        if not line.endswith(b'\n'):
            raise ValueError(f'incomplete hub frame ({len(line)} bytes)')
        return json.loads(line)

    def call(self, req):
        self.rid += 1
        self.send({**req, 'rid': self.rid})
        while True:
            msg = self.recv()
            if msg.get('rid') == self.rid:
                assert msg['t'] == 'ok', msg
                return msg


class Hub:
    def __init__(self, root, binary, args):
        self.root = root
        self.binary = binary
        self.args = args
        self.proc = self.pid = None

    def start(self):
        cfg = {'host': 'bench', 'socket': str(self.root / 'socket'), 'stateDir': str(self.root / 'state'),
               'shells': [{'name': 'bash', 'paths': [shutil.which('bash')], 'args': ['-i']}],
               'defaultShell': 'bash', 'child': {'passEnv': ['PATH'], 'setEnv': {}},
               'agents': {'bench': {'label': 'bench', 'argv': [sys.executable, str(HERE / 'agent.py')]}}}
        path = self.root / 'hub.json'
        path.write_text(json.dumps(cfg))
        env = {'HOME': str(self.root), 'USER': 'bench', 'LOGNAME': 'bench', 'PATH': os.environ['PATH'],
               'RUST_LOG': 'warn', 'TOKIO_WORKER_THREADS': '4'}
        if self.args.memusage:
            env['LD_PRELOAD'] = str(self.args.memusage.resolve())
        cmd = [self.binary, '--config', path]
        if self.args.trace:
            cmd = ['strace', '-f', '-qq', '-c', '-e', 'pwrite64,fsync,fdatasync,futex',
                   '-o', self.root / 'trace', *cmd]
        begin = time.monotonic()
        with (self.root / 'log').open('wb') as log:
            self.proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log)
        if not self.args.trace:
            self.pid = self.proc.pid
        while self.proc.poll() is None and time.monotonic() - begin < 60:
            try:
                with self.connect() as c:
                    self.pid = c.hello['pid']
                break
            except (ConnectionRefusedError, FileNotFoundError):
                time.sleep(.001)
        else:
            raise RuntimeError('hub failed to start: ' + (self.root / 'log').read_text())
        self.startup = {'ready_ms': (time.monotonic() - begin) * 1000, **counters(self.pid), **memory(self.pid)}
        self.mark()

    def connect(self):
        return Client(self.root / 'socket')

    def mark(self):
        self.before = counters(self.pid)
        self.begin = time.monotonic()

    def elapsed(self):
        return time.monotonic() - self.begin

    def rss_kib(self):
        return memory(self.pid)['rss_kib']

    def result(self):
        return {**{k: round(v - self.before[k], 3) for k, v in counters(self.pid).items()},
                **memory(self.pid), **{'startup_' + k: round(v, 3) for k, v in self.startup.items()}}

    def stop(self):
        if self.proc is None or self.proc.poll() is not None:
            return
        os.kill(self.pid or self.proc.pid, signal.SIGTERM)
        try:
            status = self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            os.kill(self.pid or self.proc.pid, signal.SIGKILL)
            self.proc.wait()
            raise
        if status:
            raise RuntimeError(f'hub exited with {status}: ' + (self.root / 'log').read_text())

    def profiles(self):
        out = {}
        if self.args.trace:
            for line in (self.root / 'trace').read_text().splitlines():
                parts = line.split()
                if parts and parts[-1] in ('pwrite64', 'fsync', 'fdatasync', 'futex'):
                    out['trace_' + parts[-1]] = int(parts[3])
        if self.args.memusage:
            log = re.sub(r'\x1b\[[;0-9]*m', '', (self.root / 'log').read_text())
            for name, calls, size in re.findall(r'^\s*(malloc|calloc|realloc)\|\s*(\d+)\s+(\d+)', log, re.M):
                out['alloc_calls'] = out.get('alloc_calls', 0) + int(calls)
                out['alloc_bytes'] = out.get('alloc_bytes', 0) + int(size)
            if not out.get('alloc_calls'):
                raise ValueError('no libmemusage allocation profile: ' + log[:1000])
        return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('workload', choices=[*DRIVERS, 'all'])
    p.add_argument('--hub', type=Path, action='append', help='wb-hub binary (repeat for interleaving)')
    p.add_argument('--repeat', type=int, default=3)
    p.add_argument('--memusage', type=Path, help='glibc libmemusage.so; whole-daemon allocation profile, not timings')
    p.add_argument('--trace', action='store_true', help='separate strace count run (includes children and shutdown)')
    args = p.parse_args()
    hubs = args.hub or [Path('target/release/wb-hub')]
    for i in range(args.repeat):
        for name in DRIVERS if args.workload == 'all' else [args.workload]:
            workload = getattr(importlib.import_module(DRIVERS[name]), name)
            for binary in hubs[::(-1 if i % 2 else 1)]:
                with tempfile.TemporaryDirectory(prefix='wbbench-') as tmp:
                    h = Hub(Path(tmp), binary.resolve(), args)
                    try:
                        result = {**workload(h), **h.result()}
                    finally:
                        h.stop()
                    print(json.dumps({'workload': name, 'hub': str(binary), 'run': i + 1,
                                      **result, **h.profiles()}), flush=True)


if __name__ == '__main__':
    main()
