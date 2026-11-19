"""Startup with tool-heavy journals, including one much larger than the replay cap."""

from time import monotonic

from fleet import check_summary, seed


def restore(h):
    counts = {}
    total = 0
    payload = 'build diagnostic: abcdef0123456\n' * 1024
    for i in range(8):
        sid = f'ended-{i}'
        sizes = seed(h, sid, 2048 if i == 0 else 64, payload, [])
        counts[sid] = len(sizes)
        total += sum(sizes) + len(sizes)
    h.start()
    with h.connect() as c:
        summaries = c.call({'t': 'list'})['sessions']
        deadline = monotonic() + 30
        while len(summaries) < len(counts) and monotonic() < deadline:
            summaries = c.call({'t': 'list'})['sessions']
        assert len(summaries) == len(counts)
        for s in summaries:
            check_summary(s, s['sid'], counts[s['sid']], [])
    return {'journal_bytes': total, 'journal_events': sum(counts.values()),
            'startup_mib_s': (total / 2**20) / (h.startup['ready_ms'] / 1000)}
