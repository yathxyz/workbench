"""Private, preseeded ACP workloads: bounded journal replay and a detached fleet."""

from concurrent.futures import ThreadPoolExecutor
from itertools import cycle
import json
from time import monotonic

from metrics import quantiles

# Compact UTF-8, newline excluded, like wb_proto::line. These fixtures are ASCII.
REPLAY_MAX = 4 << 20
MAX_LINE = 16 << 20
EPOCH = 1_750_000_000_000


def encoded(obj):
    return json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode()


def history(sid, turns, tool_output, options):
    yield {'e': 'spawn', 'pid': 1234, 'via': 'new'}
    yield {'e': 'session', 'via': 'new', 'sessionId': sid, 'configOptions': options}
    yield {'e': 'update', 'update': {'sessionUpdate': 'session_info_update', 'title': sid}}
    for i in range(turns):
        call = f'call-{i}'
        yield {'e': 'prompt', 'prompt': [{'type': 'text', 'text': f'Inspect record {i}'}]}
        yield {'e': 'update', 'update': {'sessionUpdate': 'tool_call', 'toolCallId': call,
                                        'title': 'Read record', 'kind': 'read', 'status': 'pending'}}
        yield {'e': 'update', 'update': {
            'sessionUpdate': 'tool_call_update', 'toolCallId': call, 'status': 'completed',
            'content': [{'type': 'content', 'content': {'type': 'text', 'text': tool_output}}]}}
        yield {'e': 'update', 'update': {'sessionUpdate': 'agent_message_chunk', 'messageId': f'msg-{i}',
                                        'content': {'type': 'text', 'text': f'Record {i} inspected.'}}}
        yield {'e': 'turn_end', 'stopReason': 'end_turn'}
    yield {'e': 'exit', 'code': 0, 'signal': None, 'reason': 'exited'}


def seed(h, sid, turns, tool_output, options, epoch=EPOCH):
    directory = h.root / 'state' / 'acp'
    directory.mkdir(parents=True, exist_ok=True)
    meta = {'sid': sid, 'agent': 'bench', 'cwd': str(h.root), 'createdAt': epoch,
            'agentSessionId': sid, 'seenSeq': 0,
            'init': {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}}
    (directory / f'{sid}.json').write_bytes(encoded(meta))
    # One size per event, used to check the precise bounded replay without paying
    # for a second serialization of every received event in the measured loop.
    sizes = []
    with (directory / f'{sid}.jsonl').open('wb') as f:
        for seq, event in enumerate(history(sid, turns, tool_output, options), 1):
            line = encoded({'seq': seq, 'ts': epoch + seq, **event})
            f.write(line + b'\n')
            sizes.append(len(line))
    return sizes


def check_summary(s, sid, head, options, epoch=EPOCH):
    assert s['sid'] == sid and s['createdAt'] == epoch and s['kind'] == 'acp'
    assert not s['alive'] and s['fault'] is None, sid
    a = s['acp']
    assert a['agentSessionId'] == sid and a['agent'] == 'bench' and a['revivable'], sid
    assert a['headSeq'] == head and a['title'] == sid and a['last']['outcome'] == 'end_turn', sid
    assert a['activity'] == 'none' and a['pending'] == [] and a['configOptions'] == options, sid


def replay(h):
    sid = 'long-history'
    sizes = seed(h, sid, 256, 'record: 1234567 ' * 2048, [])
    head = len(sizes)
    journal_bytes = sum(sizes) + head  # one newline per event on disk
    assert journal_bytes > 2 * REPLAY_MAX
    # This fixture has no pinned requests or coalescible adjacent text chunks.
    first = head + 1
    suffix_bytes = 0
    while first > 1 and suffix_bytes + sizes[first - 2] <= REPLAY_MAX:
        suffix_bytes += sizes[first - 2]
        first -= 1
    assert 1 < first <= head
    h.start()

    metrics = {'journal_events': head, 'journal_bytes': journal_bytes}
    h.mark()
    for label, since, start in [('full', 0, first), ('near_head', head - 8, head - 7)]:
        times, complete = [], []
        event_bytes = sum(sizes[start - 1:])
        for _ in range(20):
            with h.connect() as c:
                begin = monotonic()
                opened = c.call({'t': 'acp.open', 'sid': sid, 'since': since, 'epoch': EPOCH})
                msg = c.recv()
                times.append((monotonic() - begin) * 1000)
                assert opened['head'] == head and opened['from'] == start
                assert not opened['new'] and not opened['reset']
                for seq in range(start, head + 1):
                    assert msg['t'] == 'acp.ev' and msg['sid'] == sid and msg['ev']['seq'] == seq, seq
                    msg = c.recv()
                complete.append((monotonic() - begin) * 1000)
                assert msg['t'] == 'acp.replayed' and msg['sid'] == sid and msg['head'] == head
                assert msg['truncated'] == (since == 0)
                check_summary(opened['summary'], sid, head, [])
        metrics.update(quantiles(f'{label}_first_replay', times))
        metrics.update(quantiles(f'{label}_complete', complete))
        metrics[f'{label}_event_bytes_per_attach'] = event_bytes
        metrics[f'{label}_events_per_attach'] = head - start + 1
        mib = event_bytes * len(complete) / (1 << 20)
        metrics[f'{label}_event_mib_per_s'] = round(mib / (sum(complete) / 1000), 2)
    return metrics


def crossing(sizes):
    """First list too large at MAX_LINE, cycling *measured* summary widths."""
    nbytes = len(encoded({'t': 'ok', 'rid': 1, 'sessions': []}))
    for count, size in enumerate(cycle(sizes), 1):
        nbytes += size + (count > 1)  # commas only between entries
        if nbytes > MAX_LINE:
            return count


def read_snapshot(client, begin):
    msg = client.recv()
    elapsed_ms = (monotonic() - begin) * 1000
    assert msg['t'] == 'ok' and msg['rid'] == 1, msg.get('t')
    return {s['sid'] for s in msg['sessions']}, elapsed_ms


def fleet(h):
    sids = [f'card-{i:03}' for i in range(256)]
    large = sids[::32]
    small = [sid for sid in sids if sid not in large]
    # Hit the element bound and approach the 64 KiB compact JSON bound together.
    options = [{'id': f'setting-{n}', 'name': f'Setting {n}', 'type': 'boolean',
                'currentValue': False, 'description': 'x' * 900} for n in range(64)]
    option_bytes = len(encoded(options))
    assert 60 * 1024 < option_bytes <= 64 * 1024
    heads, journal_bytes = {}, 0
    for i, sid in enumerate(sids):
        sizes = seed(h, sid, 8 + i % 8, 'record: abcdefg ' * 64,
                     options if sid in large else [], EPOCH + i)
        heads[sid] = len(sizes)
        journal_bytes += sum(sizes) + len(sizes)

    begin = monotonic()
    h.start()
    detached_rss = h.rss_kib()  # before any snapshot request or viewer
    with h.connect() as watcher:
        # The socket can be ready just before the last restored actor publishes.
        # Startup-to-usable includes the first complete, decoded fleet snapshot.
        snapshot = watcher.call({'t': 'list'})
        while len(snapshot['sessions']) < len(sids) and monotonic() - begin < 30:
            snapshot = watcher.call({'t': 'list'})
        usable_ms = (monotonic() - begin) * 1000
        summaries = {s['sid']: s for s in snapshot['sessions']}
        assert summaries.keys() == heads.keys() and len(snapshot['sessions']) == len(sids)
        for i, sid in enumerate(sids):
            s = summaries[sid]
            assert s['viewers'] == 0 and s['cwd'] == str(h.root), sid
            check_summary(s, sid, heads[sid], options if sid in large else [], EPOCH + i)
        widths = {sid: len(encoded(s)) for sid, s in summaries.items()}
        metrics = {'detached_sessions': len(sids), 'detached_rss_kib': detached_rss,
                   'startup_to_list_ms': round(usable_ms, 3), 'large_sessions': len(large),
                   'journal_bytes': journal_bytes, 'journal_events': sum(heads.values()),
                   'config_option_bytes': option_bytes, 'list_bytes': len(encoded(snapshot)),
                   'mixed_list_crossing_sessions': crossing([widths[sid] for sid in sids]),
                   'large_only_list_crossing_sessions': crossing([widths[sid] for sid in large])}
        subscribed = watcher.call({'t': 'watch'})
        assert {s['sid'] for s in subscribed['sessions']} == heads.keys()

        latencies = {'watch': [], 'list': [], 'change_delivery': []}
        final_tasks = {}
        # Each four-write burst straddles a fresh watch or list request. Read its
        # reply independently: draining changes first would inflate snapshot RTT.
        with h.connect() as writer, ThreadPoolExecutor(max_workers=1) as reader:
            h.mark()
            for batch in range(32):
                kind = 'watch' if batch % 2 else 'list'
                burst = [large[batch % len(large)], *(small[(batch * 3 + j) % len(small)] for j in range(3))]
                with h.connect() as query:
                    sent = {}
                    for i, sid in enumerate(burst):
                        if i == 2:
                            start = monotonic()
                            query.send({'t': kind, 'rid': 1})
                            reply = reader.submit(read_snapshot, query, start)
                        rid = batch * len(burst) + i + 1
                        task = f'issue-{rid}'
                        final_tasks[sid] = task
                        sent[sid] = monotonic()
                        writer.send({'t': 'acp.set_task', 'rid': rid, 'sid': sid, 'task': task})
                    for _ in burst:
                        msg = watcher.recv()
                        arrival = monotonic()
                        assert msg['t'] == 'session', msg['t']
                        s = msg['session']
                        sid = s['sid']
                        latencies['change_delivery'].append((arrival - sent.pop(sid)) * 1000)
                        heads[sid] += 1
                        assert s['acp']['headSeq'] == heads[sid] and s['acp']['task'] == final_tasks[sid], sid
                    acks = [writer.recv() for _ in burst]
                    assert all(m['t'] == 'ok' for m in acks), acks
                    assert {m['rid'] for m in acks} == set(range(rid - len(burst) + 1, rid + 1))
                    received, elapsed_ms = reply.result()
                    assert received == heads.keys()
                    latencies[kind].append(elapsed_ms)
        metrics['changes_per_s'] = round(len(latencies['change_delivery']) / h.elapsed(), 2)
        for label, times in latencies.items():
            metrics.update(quantiles(label, times))
    return metrics
