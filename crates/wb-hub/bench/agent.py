"""Local ACP v1 agent used only by the hub benchmarks (one process per session)."""

import json
import os
import sys
from functools import cache
from time import monotonic_ns, sleep


CHUNKS = 1024
CHUNK = "The next step is to inspect the build output. "
PERMISSION_EVERY = 128
TOOLS_PER_TURN = 2
TOOL_BYTES = 768 * 1024
ALLOW = {"outcome": "selected", "optionId": "allow"}


def config_options():
    # Representative model catalog, not a near-limit blob. Nested choices are
    # carried by both session info and summary even on a pure text stream.
    groups = []
    for family in ("general", "code", "reasoning"):
        choices = [
            {"value": f"{family}-{size}-{context}", "name": f"{size.title()} {context}",
             "description": f"{family.title()} {size} model with a {context} context window"}
            for size in ("small", "medium", "large") for context in ("32k", "128k", "256k")
        ]
        groups.append({"group": family, "name": family.title(), "options": choices})
    return [
        {"id": "model", "name": "Model", "category": "model", "type": "select",
         "currentValue": "code-medium-128k", "options": groups},
        {"id": "effort", "name": "Reasoning effort", "type": "select", "currentValue": "medium",
         "options": [{"value": s, "name": s.title()} for s in ("low", "medium", "high")]},
        {"id": "thinking", "name": "Show reasoning", "type": "boolean", "currentValue": False},
    ]


@cache
def tool_output():
    line = 'src/reader.rs:39: note: expected "packet" while parsing frame\n'
    return (line * (TOOL_BYTES // len(line) + 1))[:TOOL_BYTES]


def encode(message):
    return json.dumps(message, separators=(",", ":")).encode()


def send(**message):
    sys.stdout.buffer.write(encode({"jsonrpc": "2.0", **message}) + b"\n")
    sys.stdout.buffer.flush()


def update(session, index, fields, **meta):
    # Stamp immediately before writing the first byte, not before encoding a
    # large tool result. The quoted marker occurs only in the benchmark metadata.
    fields["_meta"] = {"index": index, "sentNs": "@send-time@", **meta}
    frame = encode({"jsonrpc": "2.0", "method": "session/update",
                    "params": {"sessionId": session, "update": fields}})
    before, after = frame.split(b'"@send-time@"', 1)
    stamp = str(monotonic_ns()).encode()
    sys.stdout.buffer.writelines((before, stamp, after, b"\n"))
    sys.stdout.buffer.flush()


def stream_turn(session):
    for i in range(CHUNKS):
        update(session, i, {"sessionUpdate": "agent_message_chunk", "messageId": "reply",
                            "content": {"type": "text", "text": CHUNK}})
        # Small bursts, not an unbounded pipe flood; independent agents overlap.
        if (i + 1) % 8 == 0:
            sleep(0.006)
        if (i + 1) % PERMISSION_EVERY:
            continue
        n = (i + 1) // PERMISSION_EVERY - 1
        tool = {"toolCallId": f"read-{n}", "title": "Inspect build output", "kind": "read"}
        update(session, n, {"sessionUpdate": "tool_call", "status": "pending", **tool})
        send(id=n, method="session/request_permission", params={
            "sessionId": session, "toolCall": tool,
            "options": [{"optionId": "allow", "name": "Read once", "kind": "allow_once"}],
        })
        line = sys.stdin.buffer.readline()
        received = monotonic_ns()
        answer = json.loads(line)
        assert answer["id"] == n and answer["result"]["outcome"] == ALLOW, answer
        update(session, n, {"sessionUpdate": "tool_call_update", "toolCallId": tool["toolCallId"],
                            "status": "completed"}, answerReceivedNs=received)


def large_turn(session, turn):
    for i in range(TOOLS_PER_TURN):
        tool = f"log-{turn}-{i}"
        update(session, i, {"sessionUpdate": "tool_call", "toolCallId": tool,
                            "title": "Read compiler diagnostics", "kind": "read", "status": "pending"})
        update(session, i, {"sessionUpdate": "tool_call_update", "toolCallId": tool,
                            "status": "completed", "content": [{"type": "content", "content": {
                                "type": "text", "text": tool_output()}}]})


def main():
    session = f"bench-{os.getpid()}"
    turn = 0
    while line := sys.stdin.buffer.readline():
        req = json.loads(line)
        method = req["method"]
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
                      "agentInfo": {"name": "bench", "version": "1"}}
        elif method == "session/new":
            result = {"sessionId": session, "configOptions": config_options()}
        elif method == "session/prompt":
            assert req["params"]["sessionId"] == session
            scenario = req["params"]["prompt"][0]["text"]
            if scenario == "stream":
                stream_turn(session)
            elif scenario == "large":
                large_turn(session, turn)
            else:
                raise ValueError(f"unknown benchmark prompt {scenario!r}")
            turn += 1
            result = {"stopReason": "end_turn"}
        else:
            send(id=req["id"], error={"code": -32601, "message": "Method not found"})
            continue
        send(id=req["id"], result=result)


if __name__ == "__main__":
    main()
