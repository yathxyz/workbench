#!/usr/bin/env python3
"""Compare builds of BOTH senders on the real ACP replay and isolated PTY echo paths.

From the worktree, with release wb-hub + wb-web in each --bin-dir:

  nix --offline develop .#checks.x86_64-linux.ui -c \
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

--loaded-echo times an independent PTY connection inside full ACP replays, with
separate client processes. --loaded-hub-workers 1 puts both connections on one
hub executor worker to stress cooperative scheduling (web stays at four).
"""

import argparse
from contextlib import closing
import json
import multiprocessing
import os
from pathlib import Path
import socket
import struct
import sys
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
    def __init__(self, binaries, trace, turns=TURNS, hub_workers=4):
        self.binaries = binaries
        self.trace = trace
        self.turns = turns
        self.hub_workers = hub_workers
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
        sizes = seed(self, SID, self.turns, 'Deterministic tool output.', [])
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
            env['TOKIO_WORKER_THREADS'] = str(self.hub_workers if name == 'hub' else 4)
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


def check_hello(hello, head):
    if not (hello['t'] == 'hello' and hello['status'] == 'attached' and not hello['reset']
            and hello['from'] == 1 and hello['head'] == head):
        raise RuntimeError(f'bad attach hello: {hello}')


def check_replay(h, texts):
    check_hello(json.loads(texts[0]), h.head)
    with h.journal.open('rb') as journal:
        for seq, (line, text) in enumerate(zip(journal, texts[1:-1], strict=True), 1):
            expected = json.loads(line)
            if expected['seq'] != seq or json.loads(text) != {'t': 'ev', 'ev': expected}:
                raise RuntimeError(f'bad replay payload or sequence at {seq}: {text[:256]}')
    marker = json.loads(texts[-1])
    if marker != {'t': 'replayed', 'head': h.head, 'truncated': False}:
        raise RuntimeError(f'bad final marker: {marker}')


def acp_socket(ep):
    status, _, ws = ws_connect(ep.addr, '/acp', ep.headers())
    if status != 101:
        raise RuntimeError(f'/acp upgrade returned HTTP {status}')
    return ws


def replay(h, ep, diagnose=False, capture=False):
    phase = h.counts.prepare(h.hub.pid, h.web.pid) if diagnose else None
    ws = acp_socket(ep)
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
        return texts[1:] if capture else result


def echo(h, ep, samples):
    card = EchoCard(ep, 'bench-isolated-echo', 15)
    with closing(card.ws):
        before = h.cpu()
        started = time.perf_counter_ns()
        rtts = card.measure(samples)
        timing = h.phase_time(started, before)
    return {**timing, **quantiles('rtt', [dt * 1000 for dt in rtts])}


def server_text_frame(text):
    """Unmasked FIN text framing used by the two builds; no WS extensions negotiated."""
    data = text.encode()
    n = len(data)
    if n < 126:
        return bytes((0x81, n)) + data
    if n <= 65535:
        return struct.pack('!BBH', 0x81, 126, n) + data
    return struct.pack('!BBQ', 0x81, 127, n) + data


def receive(pipe, what):
    if not pipe.poll(60):
        raise TimeoutError(f'timed out waiting for {what}')
    return pipe.recv()


def echo_client(ep, pipe):
    # A separate interpreter: draining a replay cannot hold the echo client's GIL.
    card = EchoCard(ep, 'bench-loaded-echo', 15)
    with closing(pipe), closing(card.ws):
        pipe.send('ready')
        while (remaining := receive(pipe, 'replay start')) is not None:
            spans = []
            while len(spans) < remaining and not pipe.poll(0.01 if spans else 0):
                start = time.perf_counter_ns()
                card.rtt()  # one input byte, wait for that same byte from cat
                spans.append((start, time.perf_counter_ns()))
            if receive(pipe, 'end of launch window') != 'stop':
                raise RuntimeError('unexpected echo client command')
            pipe.send(spans)


def check_overlap(first, last, spans):
    for start, end in spans:
        if not first <= start <= end < last:
            raise RuntimeError(f'echo outside verified replay: {first=} {start=} {end=} {last=}; '
                               'refusing to censor the RTT or include an idle sample')


def sample_attach(ep, head, wire, first_size, buf, pipe, remaining):
    with closing(acp_socket(ep)) as ws:
        ws.send_json({'t': 'open', 'id': SID, 'since': 0, 'epoch': EPOCH})
        deadline = time.monotonic() + 60
        check_hello(ws.recv_json(), head)
        # Drain straight into a reusable buffer. No per-frame Python processing
        # lag to stretch the apparent replay window once the sender has finished.
        pos = len(ws.buf)
        buf[:pos] = ws.buf
        view = memoryview(buf)
        first = cutoff = None
        while True:
            now = time.perf_counter_ns()
            if first is None and pos >= first_size:
                first = now
                pipe.send(remaining)
            if cutoff is None and pos >= len(wire) // 4:
                cutoff = now
                pipe.send('stop')  # leave 3/4 of the replay for any outstanding echo
            if pos == len(wire):
                last = now
                break
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError('loaded replay timed out')
            ws.sock.settimeout(left)
            n = ws.sock.recv_into(view[pos:])
            if not n:
                raise EOFError('ACP socket closed before replayed')
            pos += n
        if buf != wire:
            raise RuntimeError('loaded replay frames differ from the journal-verified warm attach')
        spans = receive(pipe, 'echo measurements')
        if not spans:
            raise RuntimeError('echo client missed the entire launch window')
        check_overlap(first, last, spans)
        return spans, (last - first) / 1e6, (last - spans[-1][1]) / 1e6


def loaded_echo(h, ep, texts, samples):
    # The warm attach verified every JSON payload and sequence against the journal.
    # Comparing the following wire images also checks every individual frame boundary.
    frames = [server_text_frame(text) for text in texts]
    first_size = len(frames[0])
    wire = b''.join(frames)  # first event through the untruncated replayed marker
    buf = bytearray(len(wire))
    ctx = multiprocessing.get_context('spawn')
    pipe, child = ctx.Pipe()
    proc = ctx.Process(target=echo_client, args=(ep, child), daemon=True)
    proc.start()
    child.close()
    rtts, durations, margins = [], [], []
    try:
        if receive(pipe, 'warmed echo client') != 'ready':
            raise RuntimeError('echo client not ready')
        while len(rtts) < samples:
            spans, duration, margin = sample_attach(ep, h.head, wire, first_size, buf, pipe, samples - len(rtts))
            rtts.extend((end - start) / 1e6 for start, end in spans)
            durations.append(duration)
            margins.append(margin)
        pipe.send(None)
        proc.join(10)
        if proc.exitcode != 0:
            raise RuntimeError(f'echo client did not exit cleanly: {proc.exitcode}')
    finally:
        pipe.close()
        if proc.is_alive():
            proc.kill()
            proc.join(10)
    return {**quantiles('rtt', rtts), **quantiles('replayWindow', durations),
            'minEchoEndToMarkerMs': round(min(margins), 3), 'overlapVerified': len(rtts),
            'hubWorkers': h.hub_workers, 'webWorkers': 4}


def run(binaries, mode, samples, loaded_hub_workers):
    loaded = mode == 'loaded-echo'
    # Stay below the 4 MiB replay limit but sustain traffic well beyond a single
    # socket buffer. Keep the historical replay timing/trace fixture unchanged.
    with ReplayHarness(binaries, mode == 'trace', TURNS * 5 if loaded else TURNS, loaded_hub_workers) as h:
        ep = Endpoint(PUBLIC_ORIGIN, unix=h.caddy_sock)
        warm = replay(h, ep, capture=loaded)
        # Caddy and the hub detach asynchronously. Do not let that connection's
        # viewer-count change or a recycled fd bleed into the next attach.
        wait_until(lambda: any(s['sid'] == SID and s['viewers'] == 0 for s in hub_sessions(h.hub_sock)),
                   'warm replay detach', h.hub)
        result = {'binDir': str(binaries), 'mode': mode, 'journalBytes': h.journal.stat().st_size, 'events': h.head}
        if loaded:
            result['loadedEcho'] = loaded_echo(h, ep, warm, samples)
            return result
        result['replay'] = replay(h, ep, diagnose=mode == 'trace')
        if mode != 'trace':
            result['echo'] = echo(h, ep, samples)
        return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--bin-dir', action='append', required=True, type=Path,
                   help='directory containing a matched wb-hub/wb-web pair; repeat for AB/BA')
    p.add_argument('--repeat', type=int, default=3)
    p.add_argument('--keys', type=int, default=200, help='one-byte PTY echo RTT samples per timing run')
    modes = p.add_mutually_exclusive_group()
    modes.add_argument('--trace', dest='mode', action='store_const', const='trace',
                       help='separate replay socket-write diagnostic, no timings')
    modes.add_argument('--loaded-echo', dest='mode', action='store_const', const='loaded-echo',
                       help='measure only independent PTY echo RTTs during sustained ACP replay')
    p.set_defaults(mode='timing')
    p.add_argument('--loaded-hub-workers', type=int, default=4, help='hub executor threads for --loaded-echo')
    args = p.parse_args()
    if not private_netns():
        p.error('requires a private namespace with only loopback; use tests/run-front-bench.sh')
    if args.loaded_hub_workers != 4 and args.mode != 'loaded-echo':
        p.error('--loaded-hub-workers requires --loaded-echo')
    if min(args.repeat, args.keys, args.loaded_hub_workers) < 1:
        p.error('counts must be positive')
    bins = [d.resolve() for d in args.bin_dir]
    for directory in bins:
        for name in ('wb-hub', 'wb-web'):
            if not (directory / name).is_file() or not os.access(directory / name, os.X_OK):
                p.error(f'no executable {directory / name}')
    for repeat in range(args.repeat):
        for directory in (reversed(bins) if repeat % 2 else bins):
            result = run(directory, args.mode, args.keys, args.loaded_hub_workers)
            print(json.dumps({'repeat': repeat + 1, **result}), flush=True)


if __name__ == '__main__':
    main()
