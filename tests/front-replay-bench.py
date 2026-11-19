#!/usr/bin/env python3
"""Compare builds of BOTH senders on the real ACP replay and isolated PTY echo paths.

From the worktree, with release wb-hub + wb-web in each --bin-dir:

  mkdir -p target
  nix --offline develop .#checks.x86_64-linux.ui -c env TMPDIR="$PWD/target" \
    bash tests/run-front-bench.sh front-replay-bench.py \
    --bin-dir target/relay-bench/base/bin --bin-dir target/release --repeat 5

Repeat with --trace --repeat 1 for socket-specific write counts, NOT timing.
Counts include the attach's trailing viewer-count info (after replayed), so both
links can be fenced against the receiver's wire bytes. The launcher brings up
private loopback; only the disposable harness Caddy injects
its test credential. The client uses Caddy's Unix socket, Caddy connects to
wb-web over TCP, and wb-web opens a dedicated Unix connection to wb-hub.

One JSON row per fresh daemon pair; alternating AB/BA order. A warm full attach
precedes the measured one. Wall is from sending open on an upgraded /acp socket
through receipt of the untruncated replayed marker. The client reads buffered
WS frames; full journal payload and sequence checks happen outside the timed
interval. CPU is the sum of Linux per-thread scheduler runtime deltas for each
daemon. Echo is one byte in flight at a time, 10 ms between probes; the echo
phase wall (not an individual RTT) includes the pauses. The host's real HOME,
proxy and API credentials are not used.
"""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
sys.path[:0] = [str(TESTS), str(ROOT / 'crates/wb-hub/bench')]
from fleet import EPOCH, seed
from harness import Harness, PUBLIC_ORIGIN, WEB_ADDR, private_netns, wait_until
from metrics import counters, quantiles
from wbctl import EchoCard, Endpoint, hub_sessions, ws_connect

SID = 'bench-acp-replay'
TURNS = 1000  # fleet.history: 5 nonmergeable events per turn, 4 lifecycle events


class ReplayHarness(Harness):
    def __init__(self, binaries, trace):
        self.binaries = binaries
        self.trace = trace
        super().__init__(os.environ['WB_WEB_ROOT'])

    def bin(self, name):
        if name in ('wb-hub', 'wb-web'):
            return str(self.binaries / name)
        return super().bin(name)

    def start(self):
        # Don't let wb-web's cwd metadata lookup climb into the real checkout.
        git = self.root / '.git'
        git.mkdir()
        (git / 'HEAD').write_text('ref: refs/heads/bench\n')
        # Use the canonical private hub benchmark's fixture and state layout.
        self.hub_config['stateDir'] = str(self.root / 'state')
        self.hub_config['agents']['bench'] = self.agents['stub']
        self.write_json('hub.json', self.hub_config)
        sizes = seed(self, SID, TURNS, 'Deterministic tool output.', [])
        self.head = len(sizes)
        self.journal = self.root / 'state' / 'acp' / f'{SID}.jsonl'
        if self.trace:
            from front_replay_counts import ReplayCounts
            self.counts = ReplayCounts(self.root)
        # Refuse to contact any pre-existing listener, even in this private ns.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(WEB_ADDR)
        return super().start()

    def spawn(self, name, argv, env, cwd=None):
        if name in ('hub', 'web'):
            env['TOKIO_WORKER_THREADS'] = '4'
            env['RUST_LOG'] = 'warn'
            if self.trace:
                argv = self.counts.command(name, argv)
        return super().spawn(name, argv, env, cwd)

    def cpu(self):
        return {name: counters(proc.pid)['cpu_ms'] for name, proc in [('hub', self.hub), ('web', self.web)]}

    def phase_time(self, started, before):
        wall_ms = (time.perf_counter_ns() - started) / 1e6
        return {'wallMs': round(wall_ms, 3), **{f'{name}CpuMs': round(v - before[name], 3)
                                                for name, v in self.cpu().items()}}


def check_replay(h, texts):
    hello = json.loads(texts[0])
    if not (hello['t'] == 'hello' and hello['status'] == 'attached' and not hello['reset']
            and hello['from'] == 1 and hello['head'] == h.head):
        raise RuntimeError(f'bad attach hello: {hello}')
    with h.journal.open('rb') as journal:
        for seq, (line, text) in enumerate(zip(journal, texts[1:-1], strict=True), 1):
            expected = json.loads(line)
            if expected['seq'] != seq or json.loads(text) != {'t': 'ev', 'ev': expected}:
                raise RuntimeError(f'bad replay payload or sequence at {seq}: {text[:256]}')
    marker = json.loads(texts[-1])
    if marker != {'t': 'replayed', 'head': h.head, 'truncated': False}:
        raise RuntimeError(f'bad final marker: {marker}')


def replay(h, ep, diagnose=False):
    phase = h.counts.prepare(h.hub.pid, h.web.pid) if diagnose else None
    status, _, ws = ws_connect(ep.addr, '/acp', ep.headers())
    if status != 101:
        raise RuntimeError(f'/acp upgrade returned HTTP {status}')
    with closing(ws):
        if phase:
            phase.begin()
        before = h.cpu()
        started = time.perf_counter_ns()
        ws.send_json({'t': 'open', 'id': SID, 'since': 0, 'epoch': EPOCH})
        # wbctl buffers 64 KiB at a time. Keep each message boundary, but don't
        # parse thousands of JSON objects while the senders are being timed.
        deadline = time.monotonic() + 60
        texts = [ws.recv_text(deadline - time.monotonic()) for _ in range(h.head + 2)]
        timing = h.phase_time(started, before)
        if phase:
            info = ws.recv_text(deadline - time.monotonic())
            if json.loads(info).get('t') != 'info':
                raise RuntimeError(f'expected attach viewer-count info after replayed: {info[:256]}')
            # Unmasked server text frames, one FIN per message, including the
            # one info that open holds back until the replay has drained.
            lengths = [len(text.encode()) for text in texts]
            lengths.append(len(info.encode()))
            wire_bytes = sum(n + (2 if n < 126 else 4 if n <= 65535 else 10) for n in lengths)
            result = {'socketCounts': phase.finish(wire_bytes)}
        else:
            result = timing
        check_replay(h, texts)
        return result


def echo(h, ep, samples):
    card = EchoCard(ep, 'bench-isolated-echo', 15)
    with closing(card.ws):
        before = h.cpu()
        started = time.perf_counter_ns()
        rtts = card.measure(samples)
        timing = h.phase_time(started, before)
    return {**timing, **quantiles('rtt', [dt * 1000 for dt in rtts])}


def run(binaries, trace, samples):
    with ReplayHarness(binaries, trace) as h:
        ep = Endpoint(PUBLIC_ORIGIN, unix=h.caddy_sock)
        replay(h, ep)  # establish a warm, verified journal and relay before sampling
        # Caddy and the hub detach asynchronously. Do not let that connection's
        # viewer-count change or a recycled fd bleed into the next attach.
        wait_until(lambda: any(s['sid'] == SID and s['viewers'] == 0 for s in hub_sessions(h.hub_sock)),
                   'warm replay detach', h.hub)
        result = {'binDir': str(binaries), 'mode': 'trace' if trace else 'timing',
                  'journalBytes': h.journal.stat().st_size, 'events': h.head,
                  'replay': replay(h, ep, diagnose=trace)}
        if not trace:
            result['echo'] = echo(h, ep, samples)
        return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--bin-dir', action='append', required=True, type=Path,
                   help='directory containing a matched wb-hub/wb-web pair; repeat for AB/BA')
    p.add_argument('--repeat', type=int, default=3)
    p.add_argument('--keys', type=int, default=200, help='isolated PTY echo RTT samples per timing run')
    p.add_argument('--trace', action='store_true', help='separate replay socket-write diagnostic, no timings')
    args = p.parse_args()
    if not private_netns():
        p.error('requires a private namespace with only loopback; use tests/run-front-bench.sh')
    if min(args.repeat, args.keys) < 1:
        p.error('counts must be positive')
    bins = [d.resolve() for d in args.bin_dir]
    for directory in bins:
        for name in ('wb-hub', 'wb-web'):
            if not (directory / name).is_file() or not os.access(directory / name, os.X_OK):
                p.error(f'no executable {directory / name}')
    # Keep state private to this checkout and AF_UNIX paths short even when the
    # launcher nests its own temporary HOME and TMPDIR under target/.
    scratch = ROOT / 'target'
    scratch.mkdir(exist_ok=True)
    tempfile.tempdir = str(scratch)
    for repeat in range(args.repeat):
        for directory in (reversed(bins) if repeat % 2 else bins):
            print(json.dumps({'repeat': repeat + 1, **run(directory, args.trace, args.keys)}), flush=True)


if __name__ == '__main__':
    main()
