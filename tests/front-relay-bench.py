#!/usr/bin/env python3
"""bash tests/run-front-bench.sh front-relay-bench.py [--web-bin BASE --web-bin CANDIDATE]

Linux, in the UI check's private loopback namespace. One real PTY, reached by
independent /pty WebSockets through the harness's authenticating Caddy. Only
viewer 0 sends input. Each timed sample ends when *all* viewers have received
and checked the whole response. This is bounded-burst application throughput,
not raw socket throughput. Rows are JSON; repetitions reverse binary order.
"""

import argparse
from contextlib import ExitStack
import json
import math
import os
from pathlib import Path
import shlex
import shutil
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Harness, PUBLIC_ORIGIN, private_netns
from wbctl import Endpoint, open_frame, ws_connect

# Include terminal escapes, JSON escaping and multibyte text. The child loads
# this batch once; each '!' prints it with a single bash builtin, no fork/exec.
LINE = '\x1b[32mPASS\x1b[0m path="src/a\\b.rs"  café  12 tests completed\r\n'.encode()
BURST = LINE * (65536 // len(LINE))


class RelayHarness(Harness):
    def __init__(self, web_bin):
        self.web_bin = web_bin
        super().__init__(os.environ['WB_WEB_ROOT'])

    def bin(self, name):
        return self.web_bin if name == 'wb-web' else super().bin(name)


def sample_process(pid):
    # For these short phases use the ns of actual runtime accounted by the
    # scheduler across the process's Tokio workers, rather than 10-ms ticks.
    proc = Path('/proc') / str(pid)
    cpu_ns = runqueue_ns = 0
    for task in (proc / 'task').iterdir():
        try:
            cpu, wait, _ = map(int, (task / 'schedstat').read_text().split())
        except FileNotFoundError:  # a temporary worker exited
            continue
        cpu_ns += cpu
        runqueue_ns += wait
    rss_kib = next(int(s.split()[1]) for s in (proc / 'smaps_rollup').read_text().splitlines()
                   if s.startswith('Rss:'))
    hwm_kib = next(int(s.split()[1]) for s in (proc / 'status').read_text().splitlines()
                   if s.startswith('VmHWM:'))
    io = {k.rstrip(':'): int(v) for k, v in (s.split() for s in (proc / 'io').read_text().splitlines())
          if k in ('syscr:', 'syscw:', 'rchar:', 'wchar:')}
    return {'cpu': cpu_ns, 'wait': runqueue_ns, 'rss': rss_kib, 'peak': hwm_kib, 'io': io}


class Viewer:
    def __init__(self, stack, ep, spawn, cmd):
        status, _, self.ws = ws_connect(ep.addr, '/pty', ep.headers())
        if status != 101:
            raise RuntimeError(f'/pty upgrade returned HTTP {status}')
        stack.callback(self.ws.close)
        self.ws.send_json(open_frame('bench-relay', cmd if spawn else '', spawn=spawn))
        hello = self.ws.recv_json()
        if hello.get('t') != 'hello' or hello['new'] != spawn:
            raise RuntimeError(f'unexpected attachment: {hello}')
        self.offset = hello['out']
        if spawn and not self.offset:
            self.receive(b'~')  # raw mode is active; keystrokes will not echo twice

    def receive(self, expected):
        pos = frames = json_bytes = 0
        deadline = time.monotonic() + 10
        while pos < len(expected):
            text = self.ws.recv_text(deadline - time.monotonic())
            msg = json.loads(text)
            if msg['t'] == 'fg':
                continue
            if msg['t'] != 'out':
                raise RuntimeError(f'unexpected PTY event: {msg}')
            data = msg['d'].encode()
            self.offset += len(data)
            if msg['out'] != self.offset or not expected.startswith(data, pos):
                raise RuntimeError(f'incorrect output or offset at {self.offset}')
            pos += len(data)
            frames += 1
            json_bytes += len(text.encode())
        return frames, json_bytes


def measure(h, viewers, samples, burst):
    elapsed = []
    frames = json_bytes = 0
    before = sample_process(h.web.pid)
    for i in range(samples):
        key = '!' if burst else chr(65 + i % 26)
        expected = BURST if burst else key.encode()
        start = time.perf_counter_ns()
        viewers[0].ws.send_json({'t': 'in', 'd': key})
        for viewer in viewers:
            n, size = viewer.receive(expected)
            frames += n
            json_bytes += size
        elapsed.append(time.perf_counter_ns() - start)
    after = sample_process(h.web.pid)
    seconds = sum(elapsed) / 1e9
    elapsed.sort()
    cpu_ms = (after['cpu'] - before['cpu']) / 1e6
    source_bytes = samples * len(expected)
    return {
        'samples': samples,
        **{f'p{q}Ms': round(elapsed[math.ceil(samples * q / 100) - 1] / 1e6, 3) for q in (50, 95, 99)},
        'sourceBytes': source_bytes, 'deliveredMiBPerSec': round(source_bytes * len(viewers) / (2**20 * seconds), 2),
        'outFrames': frames, 'outJsonBytes': json_bytes,
        'webCpuMs': round(cpu_ms, 2), 'webCpuMsPerViewer': round(cpu_ms / len(viewers), 2),
        'webRunqueueMs': round((after['wait'] - before['wait']) / 1e6, 2),
        'webRssKiB': after['rss'], 'webVmHWMKiB': after['peak'],
        # proc/io counts read/write-like syscalls; not all socket send/recv variants.
        'webProcIoDelta': {k: v - before['io'][k] for k, v in after['io'].items()},
    }


def run(binary, count, keys, bursts):
    with RelayHarness(binary) as h, ExitStack() as stack:
        # The proxy's 0600 Unix socket carries the real public Host and Origin;
        # no listener forwarding the proxy's credential is needed.
        ep = Endpoint(PUBLIC_ORIGIN, unix=h.caddy_sock)
        corpus = h.home / 'burst'
        corpus.write_bytes(BURST)
        cmd = (f'IFS= read -r -d "" chunk < {shlex.quote(str(corpus))}; '
               'stty raw -echo || exit; printf "~"; while IFS= read -r -n1 key; do '
               'if [[ $key == ! ]]; then printf %s "$chunk"; else printf %s "$key"; fi; done')
        idle = sample_process(h.web.pid)['rss']
        viewers = [Viewer(stack, ep, i == 0, cmd) for i in range(count)]
        measure(h, viewers, 10, False)
        measure(h, viewers, 4, True)
        echo = measure(h, viewers, keys, False)
        flood = measure(h, viewers, bursts, True)
        return {'viewers': count, 'binary': binary, 'webIdleRssKiB': idle,
                'webRssGainKiBPerViewer': round((flood['webRssKiB'] - idle) / count, 1),
                'echo': echo, 'burst': flood}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--web-bin', action='append', type=lambda path: str(Path(path).resolve()),
                   help='wb-web binary; repeat to interleave variants (other daemons stay fixed)')
    p.add_argument('--viewers', type=int, nargs='+', default=[1, 6])
    p.add_argument('--keys', type=int, default=400)
    p.add_argument('--bursts', type=int, default=192)
    p.add_argument('--repeat', type=int, default=3)
    a = p.parse_args()
    if not private_netns():
        p.error('requires a private network namespace with only lo; use run-front-bench.sh')
    if min(a.viewers + [a.keys, a.bursts, a.repeat]) < 1:
        p.error('counts must be positive')
    binaries = a.web_bin or [shutil.which('wb-web')]
    if any(not b or not os.access(b, os.X_OK) for b in binaries):
        p.error('wb-web binary not found')
    for repeat in range(a.repeat):
        for count in a.viewers:
            for binary in binaries[::(-1 if repeat % 2 else 1)]:
                print(json.dumps({'repeat': repeat + 1, **run(binary, count, a.keys, a.bursts)}), flush=True)


if __name__ == '__main__':
    main()
