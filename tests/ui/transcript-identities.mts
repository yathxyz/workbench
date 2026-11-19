import type { Page, WebSocketRoute } from 'playwright-core';
import { check } from './shared.mts';

// A separate page: the fixture replaces only its /acp journal and the session feed on its local /rpc.
// No fixture session, prompt, or key is sent to the hub; read closed ranges from Edwin itself.
export async function transcriptIdentities(parent: Page) {
  const p = await parent.context().newPage();
  const sessions: SessionSummary[] = Array.from({ length: 19 }, (_, i) => ({
    sid: 'n81_ids_' + i, kind: 'acp', host: 'local', createdAt: 1000 + i, updatedAt: 1000 + i,
    alive: true, viewers: 0, cwd: '/', fault: null, state: 'idle', acp: { agent: 'stub', agentSessionId: 'id' + i,
      revivable: true, activity: 'none', pending: [], last: null, headSeq: 0, seenSeq: 0, title: null, modeId: null },
  }));
  const prompt = (seq: number, text: string): JournalEvent => ({ seq, ts: 2000 + seq, e: 'prompt', prompt: [{ type: 'text', text }] });
  const thought = (seq: number, text: string, messageId = 'repeated-id'): JournalEvent => ({ seq, ts: 2000 + seq, e: 'update',
    update: { sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } } });
  const late: JournalEvent = { seq: 5, ts: 2005, e: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'late-tool',
    title: 'late tool', rawOutput: 'late output', status: 'completed' } };
  const journal = [prompt(1, 'original'), thought(2, 'survives'), prompt(3, 'discarded'), thought(4, 'other turn'), late];
  let rpc: WebSocketRoute, acp: WebSocketRoute, current: SessionSummary;
  const send = (msg: AcpServerMsg) => acp.send(JSON.stringify(msg));
  const replay = (evs: JournalEvent[], reset: boolean, done = true, head = evs.at(-1)!.seq, from = evs[0].seq) => {
    send({ t: 'hello', info: current, status: 'attached', reset, head, from });
    for (const ev of evs) send({ t: 'ev', ev });
    if (done) send({ t: 'replayed', truncated: from > 1, head });
  };
  const drain = (last: string) => p.waitForFunction(({ last, sid }) => {
    const b = window.__canvas.live.$agents?.backend;
    return b?.n.id === sid && b.transcript && !b.changed.size && !b.transcript.painting && b.transcript.buf.text.includes(last);
  }, { last, sid: current.sid });
  const open = async (i: number) => {
    current = sessions[i]; await p.evaluate(id => window.__canvas.meshOpen(id), current.sid);
    await drain('late output');
  };
  const headers = () => p.evaluate(() => {
    const buf: EdwinBuffer = window.__canvas.live.$agents.backend.transcript.buf, t = buf.text;
    return window.Ed.getBufferFolds!(buf).map(({ s }) => t.slice(t.lastIndexOf('\n', s - 1) + 1, t.indexOf('\n', s + 1)));
  });
  const setPoint = (text: string) => p.evaluate(text => {
    const { buf, frame } = window.__canvas.live.$agents.backend.transcript, at = buf.text.indexOf(text);
    if (at < 0) throw new Error('Missing journal heading ' + text);
    frame.setPoint(at); frame.focus();
  }, text);
  const toggle = async (text: string) => {
    await setPoint(text);
    await p.keyboard.press('Control+c'); await p.keyboard.press('Tab');
  };
  try {
    await p.routeWebSocket(/\/rpc$/, ws => {
      rpc = ws; const s = ws.connectToServer();
      s.onMessage(m => { const f: HubMsg = JSON.parse(String(m)); ws.send(f.t === 'sessions' ? JSON.stringify({ ...f, sessions }) : m); });
    });
    await p.routeWebSocket(/\/acp$/, ws => ws.onMessage(m => {
      const f: AcpClientMsg = JSON.parse(String(m));
      if (f.t === 'open' && f.id === current?.sid) { acp = ws; replay(journal, false); }
    }));
    await p.goto(parent.url());
    await p.waitForFunction(sid => window.__canvas?.BOOTED && window.__canvas.FR.online && window.__canvas.SESS[sid], sessions[0].sid);
    await open(0);

    await toggle('Thinking:\n  survives'); await toggle('Tool:'); await toggle('Prompt: discarded');
    const before = await headers();
    if (before.some(s => s.includes('survives')) || !before.some(s => s.startsWith('Prompt: discarded\n'))) throw new Error('Identity fixture did not set native choices');

    // Same bytes/timestamps from the retained journal, except a replacement prompt at the discarded seq.
    // First allow the truncation note and the thought to paint; arrival of replayed, not this paint, is authoritative.
    replay([journal[1]], true, false, 5); await drain('replay truncated');
    const truncated = await headers();
    check('N81: a retained thought with a messageId stays open when replay omits its prompt', !truncated.some(s => s.includes('survives')), truncated);
    send({ t: 'ev', ev: prompt(3, 'replacement') }); send({ t: 'ev', ev: journal[3] });
    send({ t: 'ev', ev: late }); send({ t: 'replayed', head: 5, truncated: true }); await drain('late output');
    const replaced = await headers();
    check('N81: a different prompt at reused seq and timestamp does not inherit the old turn fold', !replaced.some(s => s.startsWith('Prompt: replacement\n')) && replaced.some(s => s.includes('other turn')), replaced);
    check('N81: an override not yet seen on the first reset paint survives for the late tool', !replaced.some(s => s.startsWith('Tool:')), replaced);
    // After a completed replacement replay, discarded choices are gone even if a later reset restores those records.
    replay(journal, true); await drain('Prompt: discarded');
    const restored = await headers();
    check('N81: completed reset prunes the discarded choice, not the retained sibling', !restored.some(s => s.startsWith('Prompt: discarded\n') || s.includes('survives')), restored);

    // Live chunks arrive individually. The hub's bounded replay may coalesce the same run into one
    // event with the last seq and ts, and describe its first covered seq only in hello.from.
    send({ t: 'ev', ev: thought(6, 'joined ', 'live') }); await drain('joined '); await toggle('Thinking:\n  joined ');
    send({ t: 'ev', ev: thought(7, 'chunks', 'live') }); await drain('joined chunks');
    replay([thought(7, 'joined chunks', 'live')], true, true, 7, 6); await drain('replay truncated');
    const coalesced = await headers();
    check('N81: a coalesced retained thought matches the same individually received live chunks', !coalesced.some(s => s.includes('joined chunks')), coalesced);
    replay([thought(7, 'different body', 'live')], true, true, 7, 6); await drain('different body');
    // Explicitly open this new thought too, then reuse *all* its identifiers, including its covered
    // sequence interval and terminal timestamp. Only the journal payload distinguishes the replacement.
    await toggle('Thinking:\n  different body');
    replay([thought(7, 'reused identity', 'live')], true, true, 7, 6); await drain('reused identity');
    const reused = await headers();
    check('N81: the same thought id and journal position do not transfer a fold to a different payload', reused.some(s => s.includes('reused identity')), reused);

    // Seq 8 was seen live, but the replay does not expose the timestamp of its first covered
    // chunk. A common prefix alone is not evidence that the replacement contains that event.
    send({ t: 'ev', ev: thought(8, 'draft', 'prefix') }); await drain('Thinking:\n  draft\n');
    await toggle('Thinking:\n  draft');
    replay([{ ...thought(9, 'draft replacement', 'prefix'), ts: 9009 }], true, true, 9, 8);
    await drain('draft replacement');
    const prefix = await headers();
    check('N81: an unrelated coalesced thought sharing only the live prefix starts folded',
      prefix.some(s => s.includes('draft replacement')), prefix);

    // Matching all known live bytes also needs the timestamp of the *last* covered event:
    // both sides can actually prove that timestamp, unlike the coalesced run's start time.
    send({ t: 'ev', ev: thought(10, 'same ', 'stamps') }); send({ t: 'ev', ev: thought(11, 'bytes', 'stamps') });
    await drain('same bytes'); await toggle('Thinking:\n  same bytes');
    replay([{ ...thought(11, 'same bytes', 'stamps'), ts: 9011 }, { seq: 12, ts: 9012, e: 'notice', level: 'info', text: 'after changed stamp' }], true, true, 12, 10);
    await drain('after changed stamp');
    const stamp = await headers();
    check('N81: equal live and coalesced payloads with different terminal timestamps do not share a choice',
      stamp.some(s => s.includes('same bytes')), stamp);

    // messageId alone cannot tell a retained continuation from a different thought in a
    // discarded turn. A truncation inside the thought, rather than before it, starts folded.
    const continuation = thought(4, 'retained suffix', 'split');
    replay([prompt(1, 'split run'), thought(2, 'missing prefix / ', 'split'), { seq: 3, ts: 2003, e: 'notice', level: 'info', text: 'gap' }, continuation], true);
    await drain('missing prefix / retained suffix'); await toggle('Thinking:\n  missing prefix');
    replay([continuation], true); await drain('Thinking:\n  retained suffix');
    const split = await headers();
    check('N81: truncating inside an open thought resets the retained continuation to folded',
      split.some(s => s.includes('retained suffix')), split);

    for (let i = 1; i <= 16; ++i) { await open(i); await toggle('Prompt: discarded'); }
    const closedTurn = async (i: number) => { await open(i); return (await headers()).some(s => s.startsWith('Prompt: discarded\n')); };
    await open(17); await open(18);
    check('N81: untouched visits do not evict the least recently visited override', await closedTurn(1));
    await open(17); await toggle('Prompt: discarded');
    const oldest = await closedTurn(2), next = await closedTurn(3);
    check('N81: the seventeenth override evicts the oldest untouched choice, not its successor', !oldest && next, { oldest, next });
    await p.evaluate(() => window.__canvas.setView('canvas'));
    rpc!.send(JSON.stringify({ t: 'sessions', sessions: [sessions[3]] }));
    await p.waitForFunction(id => !window.__canvas.SESS[id], sessions[4].sid);
    rpc!.send(JSON.stringify({ t: 'sessions', sessions }));
    await p.waitForFunction(id => !!window.__canvas.SESS[id], sessions[4].sid);
    const reintroduced = await closedTurn(4), kept = await closedTurn(3);
    check('N81: an authoritative snapshot without gone drops only absent sessions, even if the same sid/epoch returns',
      !reintroduced && kept, { reintroduced, kept });

    // Keep the reader mounted across omission and same-epoch return. A choice made while
    // the session is absent belongs to a fresh cache entry, not the evicted map.
    await open(18); await toggle('Thinking:\n  survives');
    rpc!.send(JSON.stringify({ t: 'sessions', sessions: [] }));
    await p.waitForFunction(id => !window.__canvas.SESS[id], sessions[18].sid);
    await toggle('Tool:');
    rpc!.send(JSON.stringify({ t: 'sessions', sessions }));
    await p.waitForFunction(id => !!window.__canvas.SESS[id], sessions[18].sid);
    await open(17); await open(18);
    const fresh = await headers();
    check('N81: pruning a mounted reader drops its old choices and retains a fresh choice made before the sid returns',
      !fresh.some(s => s.startsWith('Tool:')) && fresh.some(s => s.includes('survives')), fresh);
  } finally { await p.close(); }
}
