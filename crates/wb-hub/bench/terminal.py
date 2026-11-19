"""Burst output through a real PTY, parser, ring, OutQ and hub.sock."""

import time

from metrics import quantiles


def pty(h):
    h.start()
    line = '0123456789abcdef' * 4
    block = (line + '\n') * 4096
    (h.root / 'block').write_text(block)
    latencies = []
    frames = 0
    # Empty input line drives one burst. Keep the child alive until counters are sampled.
    with h.connect() as c:
        c.call({'t': 'pty.open', 'sid': 'term', 'rows': 24, 'cols': 80,
                'spawn': {'argv': ['bash', '-c', 'while read -r; do cat block; echo END; done'],
                          'cwd': str(h.root)}})
        h.mark()
        for _ in range(24):
            start = time.monotonic_ns()
            c.send({'t': 'pty.input', 'sid': 'term', 'd': '\n'})
            chunks = []
            while True:
                msg = c.recv()
                if msg['t'] != 'pty.out':
                    assert msg['t'] == 'pty.fg', msg
                    continue
                frames += 1
                chunks.append(msg['d'])
                if ''.join(chunks[-5:]).endswith('END\r\n'):
                    break
            latencies.append((time.monotonic_ns() - start) / 1e6)
            assert ''.join(chunks).removeprefix('\r\n') == block.replace('\n', '\r\n') + 'END\r\n'
        return {**quantiles('burst', latencies), 'pty_frames': frames,
                'source_mib_s': len(block) * len(latencies) / (2**20 * h.elapsed())}
