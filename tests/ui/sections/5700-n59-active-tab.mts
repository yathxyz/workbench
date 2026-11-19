import net from 'node:net';
import { check, section, sleep, until, watchErrors } from '../shared.mts';
import { H, ORIGIN, ctx, record } from '../daemon.mts';
import { type TailPage } from '../acp.mts';

/* A tab of N59: its page, its marker, the active messages its /rpc sent, and the tool calls its page logged. */
interface N59Tab { p: TailPage; mark: string; sent: Extract<HubClientMsg, { t: 'active' }>[]; log: () => Promise<Window['__n58']> }

// N59 (fix 4, F-A11, §3.3): `wb` board tools reach the tab used last. Two tabs report active{ago} on /rpc; a client
// on the harness's web.sock, as `wb` speaks it, sends cmd lines; test tools pushed into each tab's AGENT_TOOLS answer
// with that tab's marker. Headless tabs are visible and focused (Playwright emulates focus), so a synthetic focus event
// is a tab being used. The suite's other open tabs never get these tools: a cmd sent to one of them comes back `tool`.
await section('N59', async () => {
  let st: any;   // Each snapshot has its own shape.
  // a tab and the active messages its /rpc sends
  const rpcTab = async (mark: string): Promise<N59Tab> => {
    const p = await ctx.newPage(); watchErrors(p); record(p);
    const sent: N59Tab['sent'] = [];
    p.on('websocket', w => { if (w.url().endsWith('/rpc')) w.on('framesent', f => { let m: HubClientMsg; try { m = JSON.parse(f.payload as string); } catch { return; } if (m.t === 'active') sent.push(m); }); });
    await p.goto(ORIGIN + '/'); await until(() => p.evaluate(() => window.__canvas?.BOOTED));
    await until(() => p.evaluate(() => window.__perf?.frame?.ready), 30000);
    await until(() => sent.length, 5000);
    await p.evaluate((mark: string) => {
      const log: Window['__n58'] = window.__n58 = [], schema = { type: 'object', properties: {} };
      window.__canvas.AGENT_TOOLS.push(
        { name: 'n58_mark', description: 'N59: answers with the tab marker', inputSchema: schema, run: async (input: AgentToolInput) => { log.push({ tool: 'n58_mark', input }); return mark; } },
        { name: 'n58_hang', description: 'N59: never answers', inputSchema: schema, run: (input: AgentToolInput) => { log.push({ tool: 'n58_hang', input }); return new Promise(() => {}); } });
    }, mark);
    return { p, mark, sent, log: () => p.evaluate(() => window.__n58) };
  };
  // focus a tab, then wait until its active message is out and has had time to reach wb-web
  const use = async (t: N59Tab) => { const n = t.sent.length; await t.p.evaluate(() => dispatchEvent(new Event('focus'))); const out = await until(() => t.sent.length > n, 5000); await sleep(300); return out ? t.sent[t.sent.length - 1] : null; };
  // the `wb` side: NDJSON on web.sock, the hello exchange, then cmd lines one at a time
  const lines: any[] = []; let buf = '', closed = false, ws: net.Socket | null = null, rid = 0, A: N59Tab | null = null, B: N59Tab | null = null; // any: web.sock's NDJSON lines, read field by field
  const next = (ms = 15000) => until(() => lines.shift() || (closed && { closed: true }), ms);
  const send = (tool: string, input: AgentToolInput, timeout?: number) => { const m: { t: 'cmd'; rid: number; tool: string; input: AgentToolInput; timeout?: number } = { t: 'cmd', rid: ++rid, tool, input }; if (timeout) m.timeout = timeout; ws!.write(JSON.stringify(m) + '\n'); return m.rid; };
  const call = async (tool: string, input: AgentToolInput, timeout?: number) => { const r = send(tool, input, timeout); return { rid: r, reply: (await next()) || { none: true } }; };
  try {
    A = await rpcTab('n58-A'); B = await rpcTab('n58-B');
    ws = net.connect(H.webSocket); ws.setEncoding('utf8');
    ws.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch { lines.push({ unparsable: l }); } } });
    ws.on('error', e => { lines.push({ error: String(e?.message || e) }); }); ws.on('close', () => { closed = true; });
    const hello = await next();
    ws.write(JSON.stringify({ t: 'hello', proto: 1, client: 'wb/0.1.0' }) + '\n');
    st = { hello, openA: A.sent[0], openB: B.sent[0] };
    check('N59: web.sock says hello (proto 1, wb-web); each tab sends active{ago:0} when its /rpc opens', hello?.t === 'hello' && hello.proto === 1 && hello.server === 'wb-web' && A.sent[0]?.ago === 0 && B.sent[0]?.ago === 0, JSON.stringify(st));
    // both orders: the tab focused last runs the cmd, with its input, and the other tab does not
    st = { focus: await use(A) }; st.r = await call('n58_mark', { n: 1 }); st.logA = await A.log(); st.logB = await B.log();
    check('N59: A focused last: the cmd runs in A (its marker, its input) and not in B', st.focus?.ago === 0 && st.r.reply.t === 'ok' && st.r.reply.rid === st.r.rid && st.r.reply.result === 'n58-A' && st.logA.length === 1 && st.logA[0].input?.n === 1 && st.logB.length === 0, JSON.stringify(st));
    st = { focus: await use(B) }; st.r = await call('n58_mark', { n: 2 }); st.logA = await A.log(); st.logB = await B.log();
    check('N59: then B focused last: the next cmd on the same connection runs in B and not in A', st.focus?.ago === 0 && st.r.reply.t === 'ok' && st.r.reply.rid === st.r.rid && st.r.reply.result === 'n58-B' && st.logA.length === 1 && st.logB.length === 1 && st.logB[0].input?.n === 2, JSON.stringify(st));
    // ago counts: A leaves (blur, no focus), B is used, then A becomes visible again unfocused. A's message is the latest
    // to arrive, but it says A was last used before B, so B stays the leader.
    await A.p.evaluate(() => { document.hasFocus = () => false; dispatchEvent(new Event('blur')); });
    await sleep(400); await use(B); await sleep(400);
    let n = A.sent.length; await A.p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await until(() => A!.sent.length > n, 5000); await sleep(300);
    st = { late: A.sent[A.sent.length - 1] }; st.r = await call('n58_mark', { n: 3 }); st.logA = (await A.log()).length;
    await A.p.evaluate(() => { delete (document as Partial<Document>).hasFocus; });
    check('N59: a tab visible again but unfocused sends the time since it was last used (ago > 0), and ranks by it, below the tab used since', n === A.sent.length - 1 && st.late?.ago >= 600 && st.late.ago < 10000 && st.r.reply.t === 'ok' && st.r.reply.result === 'n58-B' && st.logA === 1, JSON.stringify(st));
    // the leader closes before it answers: page_gone, and the cmd is never sent to B
    await use(A); const hang = send('n58_hang', { n: 4 }, 30), t0 = Date.now();
    st = { ran: await until(async () => (await A!.log()).some(e => e.tool === 'n58_hang'), 5000) };
    await A.p.close();
    st.reply = await next(); st.ms = Date.now() - t0; await sleep(1000); st.logB = await B.log();
    check('N59: the leader tab closes before answering: page_gone well before the timeout, and the other tab never runs the cmd', st.ran && st.reply?.t === 'err' && st.reply.rid === hang && st.reply.code === 'page_gone' && st.ms < 20000 && !st.logB.some((e: { tool: string }) => e.tool === 'n58_hang'), JSON.stringify(st));
    // a tool the page does not have: the page's error comes back as code tool
    await use(B); st = await call('n58_nope', {});
    check('N59: an unknown tool gives code tool with the page\'s message', st.reply.t === 'err' && st.reply.rid === st.rid && st.reply.code === 'tool' && /unknown tool n58_nope/.test(st.reply.message || ''), JSON.stringify(st));
  } finally {
    ws?.destroy();
    for (const t of [A, B]) if (t && !t.p.isClosed()) { await t.p.evaluate(() => { const T = window.__canvas.AGENT_TOOLS; for (let i = T.length - 1; i >= 0; i--) if (T[i].name.startsWith('n58_')) T.splice(i, 1); }).catch(() => {}); await t.p.close(); }
  }
});
