"""Linux /proc counters. Clocks, memory and I/O refer to the hub PID, not its cgroup."""

import math
from pathlib import Path


def quantiles(label, milliseconds):
    v = sorted(milliseconds)
    return {label + '_n': len(v), **{
        f'{label}_{name}_ms': round(v[max(0, math.ceil(len(v) * q) - 1)], 3)
        for name, q in [('min', 0), ('p50', .5), ('p95', .95), ('p99', .99), ('max', 1)]}}


def counters(pid):
    p = Path('/proc') / str(pid)
    io = {k: int(v) for k, v in (line.split(':') for line in (p / 'io').read_text().splitlines())}
    # schedstat gives sub-tick resolution; the runtime pool lives for the entire run.
    cpu = delay = slices = 0
    for sched in p.glob('task/*/schedstat'):
        try:
            c, d, s = map(int, sched.read_text().split())
        except FileNotFoundError:
            continue
        cpu += c
        delay += d
        slices += s
    return {**io, 'cpu_ms': cpu / 1e6, 'runqueue_ms': delay / 1e6, 'timeslices': slices}


def memory(pid):
    fields = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines())
    return {'rss_kib': int(fields['VmRSS'].split()[0]), 'hwm_kib': int(fields['VmHWM'].split()[0])}
