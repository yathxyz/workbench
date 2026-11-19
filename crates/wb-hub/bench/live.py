"""End-to-end ACP workloads over the private hub socket and real agent pipes."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from threading import Barrier
from time import monotonic_ns

import agent
from metrics import quantiles


class Session:
    """One attached viewer. Keep reading events even while a request is in flight."""

    def __init__(self, h, client, sid):
        self.client = client
        self.sid = sid
        opened = client.call({"t": "acp.open", "sid": sid, "since": 0,
                              "spawn": {"agent": "bench", "cwd": str(h.root)}})
        assert opened["new"] and not opened.get("configErrors"), opened
        self.epoch = opened["summary"]["createdAt"]
        self.head = 0
        self.messages = Counter()
        self.replies = set()
        self.journal = h.root / "state" / "acp" / f"{sid}.jsonl"
        # session/new can complete either side of the initial replay cutoff.
        replayed = ready = False
        while not (replayed and ready):
            m = client.recv()
            assert m.get("sid") == sid, m
            if m["t"] == "acp.replayed":
                assert not m["truncated"]
                replayed = True
            elif m["t"] == "acp.ev":
                ev = m["ev"]
                assert ev["seq"] == self.head + 1 and ev["e"] in ("spawn", "session"), ev
                self.head = ev["seq"]
                if ev["e"] == "session":
                    assert ev["configOptions"] == agent.config_options()
                    ready = True
            else:
                assert m["t"] == "acp.info", m
        # Consume any setup info already enqueued; don't count it as workload traffic.
        self.rid = client.call({"t": "list"})["rid"]
        self.start_bytes = self.journal.stat().st_size

    def request(self, **request):
        self.rid += 1
        self.replies.add(self.rid)
        request.update(sid=self.sid, rid=self.rid)
        sent = monotonic_ns()
        self.client.send(request)
        return sent

    def answer(self, req):
        return self.request(t="acp.permission", req=req, epoch=self.epoch, outcome=agent.ALLOW)

    def turn(self, scenario):
        """Yield live payloads until turn_end, its summary and all replies have arrived."""
        prompt = [{"type": "text", "text": scenario}]
        start_head = self.head
        self.request(t="acp.prompt", prompt=prompt)
        end = final_info = None
        while end is None or final_info != end or self.replies:
            m = self.client.recv()
            received = monotonic_ns()  # After delivery and JSON decoding, before examining the event.
            kind = m["t"]
            self.messages[kind] += 1
            if kind == "ok":
                self.replies.remove(m["rid"])
                continue
            assert m.get("sid") == self.sid, m
            if kind == "acp.info":
                acp = m["summary"]["acp"]
                if acp["activity"] == "none":
                    final_info = acp["headSeq"]
                continue
            assert kind == "acp.ev", m
            ev = m["ev"]
            self.head += 1
            assert ev["seq"] == self.head, (ev["seq"], self.head)
            if self.head == start_head + 1:
                assert ev["e"] == "prompt" and ev["prompt"] == prompt, ev
            elif ev["e"] == "turn_end":
                assert ev["stopReason"] == "end_turn"
                end = ev["seq"]
            else:
                yield ev, received


def delay_ms(start, end):
    assert end >= start, (start, end)
    return (end - start) / 1_000_000


def stream_reader(session, gate):
    chunks = []
    answers = []
    sent = {}
    resolved = set()
    started_tools = 0
    gate.wait()
    for ev, received in session.turn("stream"):
        kind = ev["e"]
        if kind == "permission":
            tool = ev["toolCall"]["toolCallId"]
            assert tool not in sent
            sent[tool] = session.answer(ev["seq"])
        elif kind == "permission_resolved":
            assert ev["by"] == "user" and ev["outcome"] == agent.ALLOW and ev["req"] not in resolved
            resolved.add(ev["req"])
        else:
            assert kind == "update", ev
            u = ev["update"]
            meta = u["_meta"]
            if u["sessionUpdate"] == "agent_message_chunk":
                assert meta["index"] == len(chunks) and u["content"]["text"] == agent.CHUNK
                chunks.append(delay_ms(meta["sentNs"], received))
            elif u["sessionUpdate"] == "tool_call":
                assert meta["index"] == started_tools and u["status"] == "pending"
                started_tools += 1
            else:
                assert u["sessionUpdate"] == "tool_call_update" and u["status"] == "completed", u
                assert meta["index"] == len(answers)
                # Agent echoes the time it read the actual selection from stdin. The
                # path back to this viewer is *not* part of answer delivery latency.
                answers.append(delay_ms(sent.pop(u["toolCallId"]), meta["answerReceivedNs"]))
    assert len(chunks) == agent.CHUNKS
    assert not sent and started_tools == len(answers) == len(resolved) == agent.CHUNKS // agent.PERMISSION_EVERY
    return chunks, answers


def watch_reader(client, targets, gate):
    finished, turning, pending = set(), set(), set()
    count = 0
    gate.wait()
    while len(finished) != len(targets):
        m = client.recv()
        assert m["t"] == "session", m
        summary = m["session"]
        sid, acp = summary["sid"], summary["acp"]
        count += 1
        if acp["activity"] == "turn":
            turning.add(sid)
        if acp["pending"]:
            pending.add(sid)
        if acp["headSeq"] == targets[sid]:
            assert acp["activity"] == "none" and acp["last"]["outcome"] == "end_turn"
            finished.add(sid)
    assert pending == turning == finished == set(targets)
    return count


def totals(sessions, elapsed, watch_messages, logical_bytes):
    counts = sum((s.messages for s in sessions), Counter())
    return {"sessions": len(sessions), "seconds": elapsed,
            "journal_events": counts["acp.ev"], "journal_events_per_s": counts["acp.ev"] / elapsed,
            "journal_bytes": sum(s.journal.stat().st_size - s.start_bytes for s in sessions),
            "watch_messages": watch_messages, "attached_info_messages": counts["acp.info"],
            "client_messages": sum(counts.values()) + watch_messages,
            "logical_output_bytes": logical_bytes, "logical_mib_per_s": logical_bytes / (2**20 * elapsed)}


def stream(h):
    """Eight simultaneous streams with intervening permissions and two board watchers."""
    h.start()
    with ExitStack() as stack:
        sessions = [Session(h, stack.enter_context(h.connect()), f"stream-{i}") for i in range(8)]
        events = 2 + agent.CHUNKS + 4 * (agent.CHUNKS // agent.PERMISSION_EVERY)
        targets = {s.sid: s.head + events for s in sessions}
        watchers = [stack.enter_context(h.connect()) for _ in range(2)]
        for client in watchers:
            initial = client.call({"t": "watch"})
            assert {s["sid"] for s in initial["sessions"]} == targets.keys()
        readers = len(sessions) + len(watchers)
        with ThreadPoolExecutor(max_workers=readers) as pool:
            gate = Barrier(readers + 1, timeout=30)
            boards = [pool.submit(watch_reader, c, targets, gate) for c in watchers]
            cards = [pool.submit(stream_reader, s, gate) for s in sessions]
            h.mark()
            gate.wait()
            chunks, answers = [], []
            for card in cards:
                latencies, permissions = card.result()
                chunks.extend(latencies)
                answers.extend(permissions)
            watch_messages = sum(f.result() for f in boards)
            elapsed = h.elapsed()
        assert all(s.head == targets[s.sid] and s.messages["acp.ev"] == events for s in sessions)
        return {**totals(sessions, elapsed, watch_messages, len(chunks) * len(agent.CHUNK)),
                "watchers": len(watchers), "chunks_per_s": len(chunks) / elapsed,
                **quantiles("agent_chunk_to_client", chunks), **quantiles("answer_to_agent", answers)}


def large(h):
    """Single attached session, two 768 KiB tool results per turn, 32 consecutive turns."""
    h.start()
    with h.connect() as c:
        session = Session(h, c, "large")
        expected = agent.tool_output()
        latency = []
        logical_bytes = 0
        turns = 32
        h.mark()
        for turn in range(turns):
            started, completed = [], []
            for ev, received in session.turn("large"):
                assert ev["e"] == "update", ev["e"]
                update = ev["update"]
                meta = update["_meta"]
                tool = update["toolCallId"]
                if update["sessionUpdate"] == "tool_call":
                    assert meta["index"] == len(started) and update["status"] == "pending"
                    started.append(tool)
                else:
                    assert update["sessionUpdate"] == "tool_call_update" and update["status"] == "completed"
                    assert meta["index"] == len(completed)
                    text = update["content"][0]["content"]["text"]
                    assert text == expected, "truncated or corrupt tool output"
                    completed.append(tool)
                    latency.append(delay_ms(meta["sentNs"], received))
                    logical_bytes += len(text)  # ASCII, excluding JSON escaping/framing.
            assert started == completed == [f"log-{turn}-{i}" for i in range(agent.TOOLS_PER_TURN)]
        elapsed = h.elapsed()
        assert session.messages["acp.ev"] == turns * (2 + 2 * agent.TOOLS_PER_TURN)
        assert logical_bytes == turns * agent.TOOLS_PER_TURN * agent.TOOL_BYTES
        return {**totals([session], elapsed, 0, logical_bytes), "turns": turns,
                "tool_outputs_per_s": len(latency) / elapsed,
                **quantiles("agent_output_to_client", latency)}
