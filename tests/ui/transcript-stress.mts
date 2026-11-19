// N81: a warm Agents view, a newly mounted reader, and the shipped socket handler, reducer and Edwin display.
// Run alone: bash tests/run-front-bench.sh ui/transcript-stress.mts
// Outside Nix, use the same command with WB_WEB_ROOT, WB_EDWIN_WEB_ROOT and WB_PLAYWRIGHT (absolute index.mjs)
// set, Node 24+, python3, caddy, wb-{hub,web,fake-acp}, edwind, bash, unshare and ip on PATH, and the matching
// Playwright Chromium installed in PLAYWRIGHT_BROWSERS_PATH. The wrapper uses a temporary HOME and private loopback.
import type { Page } from 'playwright-core';

// Both the N81 check and the before/after benchmark use this fixture unchanged. The caller supplies a disposable,
// idle Agents session. No stress event is sent to the hub. Reopening times the real viewer creation and attach;
// deterministic batches enter its normal JSON socket handler after the small real journal has replayed.
export async function measureTranscript(page: Page, legacyEdwin = false) {
  const base: number = await page.evaluate(() => window.__canvas.live.$agents.backend.seq);
  const full = await measureReader(page, 640, base, legacyEdwin);
  // Start from another freshly attached reader. The identical first 250 turns yield 500 closed items (one
  // thought and one tool each), without injecting folds or changing the primary workload or its stream.
  const append250 = await measureReader(page, 250, base, legacyEdwin);
  return { ...full, append250 };
}

async function measureReader(page: Page, turns: number, base: number, legacyEdwin: boolean) {
  const fixture = await page.evaluateHandle(async ({ turns, base, legacyEdwin }) => {
    const C = window.__canvas, old = C.live.$agents.backend;
    if (!old.transcript || !old.replayed) throw new Error('N81 measurement needs a mounted, replayed Edwin transcript');
    const sid = old.n.id as string, chunks = 96;
    let seq = base;
    type Body<T> = T extends JournalEvent ? Omit<T, 'seq' | 'ts'> : never;
    const event = (body: Body<JournalEvent>) => JSON.stringify({ t: 'ev', ev: { ...body, seq: ++seq, ts: 1700000000000 + seq } });
    const text = (s: string) => ({ type: 'text', text: s });
    const update = (u: JsonObject) => event({ e: 'update', update: u });
    const message = (id: string, s: string) => update({ sessionUpdate: 'agent_message_chunk', messageId: id, content: text(s) });
    const line = 'N81: output ' + '0123456789abcdef'.repeat(3) + '\n';
    const short = line.repeat(8), long = line.repeat(2048), longEvery = 64, frames: string[] = [];
    for (let i = 0; i < turns; ++i) {
      const id = 'tool-' + i;
      frames.push(event({ e: 'prompt', prompt: [text('N81: prompt ' + i)] }),
        update({ sessionUpdate: 'agent_thought_chunk', messageId: 'thought-' + i, content: text('N81: thinking ' + i) }),
        message('reply-' + i, 'N81: opening '), message('reply-' + i, 'the file'),
        update({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'read', title: 'N81: read ' + i, status: 'in_progress' }),
        update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', locations: [{ path: 'input.txt', line: i }],
          content: [{ type: 'content', content: text(i % longEvery === 0 ? long : short) }] }),
        message('result-' + i, 'N81: result ' + i), event({ e: 'turn_end', stopReason: 'end_turn' }));
    }
    frames.push(message('live-tail', 'N81: replay-end'));
    const stream = Array.from({ length: chunks }, (_, i) => message('live-tail', '\nN81: chunk-' + i + '!'));
    const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    const mark = (suffix: string) => performance.mark('n81:' + suffix);
    // These are Edwin's virtualized display rows, not buf.text, a newly mounted blank frame or a scheduled rAF.
    function visible(root: HTMLElement, token: string) {
      for (const row of root.querySelectorAll('.ln')) if (row.textContent?.includes(token)) {
        const a = row.getBoundingClientRect(), b = root.getBoundingClientRect();
        if (a.width && a.height && a.bottom > Math.max(0, b.top) && a.top < Math.min(innerHeight, b.bottom)) return true;
      }
      return false;
    }
    function watch(root: HTMLElement, token: string, name: string) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { obs.disconnect(); reject(new Error('N81: no visible row containing ' + token)); }, 30000);
        const check = () => { if (visible(root, token)) { mark(name); obs.disconnect(); clearTimeout(timer); resolve(); } };
        const obs = new MutationObserver(check);
        obs.observe(root, { subtree: true, childList: true, characterData: true }); check();
      });
    }
    const send = (ws: WebSocket, data: string) => ws.dispatchEvent(new MessageEvent('message', { data }));
    C.setView('canvas'); await raf(); await raf();
    return {
      async replay() {
        mark('open'); C.meshOpen(sid);
        const b = C.live.$agents.backend;
        if (b === old || !b.transcript) throw new Error('N81: reopening did not mount a new reader');
        const root: HTMLElement = b.transcript.frame.root, ws: WebSocket = b.ws;
        const deadline = performance.now() + 15000;
        while (!b.replayed && performance.now() < deadline) await raf();
        if (!b.replayed || b.seq > base) throw new Error('N81: disposable session was not idle');
        const first = watch(root, 'N81:', 'first-dom'), last = watch(root, 'N81: replay-end', 'last-dom');
        const reader = b.transcript, render = reader.render;
        let projectionMs = 0, maxProjectionMs = 0, projectionFrames = 0, maxAddedChars = 0;
        // Time the original synchronous projection (including rope splices), separately from Edwin's later DOM paint.
        reader.render = function (...args: unknown[]) {
          const before = reader.buf.rope.length, t = performance.now();
          Reflect.apply(render, reader, args);
          const ms = performance.now() - t, added = reader.buf.rope.length - before;
          if (added) {
            projectionMs += ms; maxProjectionMs = Math.max(maxProjectionMs, ms);
            projectionFrames++; maxAddedChars = Math.max(maxAddedChars, added);
          }
        };
        // Bound the driver too: never fabricate a 5,121-event JavaScript task. This omits network throughput;
        // every message still goes through the production JSON parser and scheduler.
        const mc = new MessageChannel(); let i = 0;
        try {
          mc.port1.onmessage = () => {
            const stop = Math.min(frames.length, i + 32);
            while (i < stop) send(ws, frames[i++]);
            if (i < frames.length) mc.port2.postMessage(0);
          };
          mc.port2.postMessage(0);
          await Promise.all([first, last]); await raf(); await raf();
        } finally { delete reader.render; mc.port1.close(); mc.port2.close(); }
        return { events: frames.length, turns, longTools: Math.ceil(turns / longEvery), longOutputBytes: long.length, replayWireBytes: frames.reduce((n, s) => n + s.length, 0),
          projectionFrames, maxAddedChars, projectionMs: Number(projectionMs.toFixed(2)), maxProjectionMs: Number(maxProjectionMs.toFixed(2)) };
      },
      closedItems() {
        // Inspect the actual display's closed ranges, not the projection's intended targets or preferences.
        if (typeof window.Ed.getBufferFolds !== 'function') {
          if (legacyEdwin && typeof window.Ed.setBufferFolds !== 'function') return null;
          throw new Error('N81: Edwin omitted getBufferFolds; cannot measure a folded transcript');
        }
        if (legacyEdwin) throw new Error('N81: the legacy control unexpectedly has native folds');
        const buf: EdwinBuffer = C.live.$agents.backend.transcript.buf, folds = window.Ed.getBufferFolds(buf);
        if (folds.length !== 2 * turns) throw new Error(`N81: ${turns} turns, expected ${2 * turns} closed items, got ${folds.length}`);
        for (const [i, { s }] of folds.entries()) {
          const heading = i % 2 ? 'Tool: read [completed] N81: read ' + (i >> 1) : 'Thinking:';
          if (buf.rope.slice(s - heading.length, s + 1) !== heading + '\n') throw new Error(`N81: fold ${i} is not at ${heading}`);
        }
        return folds.length;
      },
      async stream() {
        const b = C.live.$agents.backend, root = b.transcript.frame.root as HTMLElement, ws = b.ws as WebSocket;
        let enqueueMs = 0;
        for (let i = 0; i < stream.length; ++i) {
          const dom = watch(root, 'N81: chunk-' + i + '!', 'chunk-dom-' + i);
          mark('chunk-' + i); const start = performance.now(); send(ws, stream[i]); enqueueMs += performance.now() - start;
          await dom; await raf(); // a rendering opportunity before dispatching the next chunk
        }
        await raf();
        return { chunks, enqueueMsPerChunk: enqueueMs / chunks };
      },
    };
  }, { turns, base, legacyEdwin });
  const cdp = await page.context().newCDPSession(page);
  type TraceEvent = { pid: number; tid: number; name: string; ts: number; dur?: number; tdur?: number; ph: string };
  const trace: TraceEvent[] = [];
  cdp.on('Tracing.dataCollected', ({ value }) => {
    for (const e of value) if (e.ph === 'X' || e.name.startsWith('n81:')) {
      trace.push({ name: e.name, ph: e.ph, pid: Number(e.pid), tid: Number(e.tid), ts: Number(e.ts),
        dur: e.dur === undefined ? undefined : Number(e.dur), tdur: e.tdur === undefined ? undefined : Number(e.tdur) });
    }
  });
  const threadMs = async () => {
    const m = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'ThreadTime');
    if (!m) throw new Error('Chromium did not expose renderer ThreadTime');
    return m.value * 1000;
  };
  try {
    await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
    await cdp.send('Tracing.start', { categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' });
    const workload = await fixture.evaluate(f => f.replay());
    const closedBefore = await fixture.evaluate(f => f.closedItems());
    const cpuStart = await threadMs(), stream = await fixture.evaluate(f => f.stream()), cpu = await threadMs() - cpuStart;
    const completed = new Promise<void>(r => cdp.once('Tracing.tracingComplete', () => r()));
    await cdp.send('Tracing.end'); await completed;
    const closedAfter = await fixture.evaluate(f => f.closedItems());
    const open = trace.find(e => e.name === 'n81:open');
    if (!open) throw new Error('Chromium did not trace the opening mark');
    const main = trace.filter(e => e.pid === open.pid && e.tid === open.tid).sort((a, b) => a.ts - b.ts);
    const marks = new Map(main.filter(e => e.name.startsWith('n81:')).map(e => [e.name.slice(4), e.ts]));
    const at = (name: string) => { const t = marks.get(name); if (t === undefined) throw new Error('Missing trace mark: ' + name); return t; };
    const paints = main.filter(e => e.name === 'Paint' && e.ph === 'X');
    const paint = (dom: string) => {
      const t = at(dom), p = paints.find(e => e.ts >= t);
      if (!p) throw new Error('Missing renderer Paint after ' + dom);
      return p.ts + (p.dur || 0);
    };
    const last = paint('last-dom');
    const tasks = main.filter(e => e.name === 'RunTask' && e.ph === 'X' && e.ts < last && e.ts + (e.dur || 0) > open.ts);
    if (!tasks.length) throw new Error('No renderer-main RunTask intervals (including sub-50ms tasks)');
    const worst = tasks.reduce((a, b) => a.dur! >= b.dur! ? a : b);
    const nested = main.filter(e => /^(FireAnimationFrame|EventDispatch|Layout|UpdateLayoutTree|Paint|FunctionCall|MinorGC|MajorGC|RunMicrotasks|V8\.GC)/.test(e.name) &&
      e.ph === 'X' && e.ts >= worst.ts && e.ts + (e.dur || 0) <= worst.ts + worst.dur!).sort((a, b) => b.dur! - a.dur!);
    const latencies = Array.from({ length: stream.chunks }, (_, i) => {
      const p = paint('chunk-dom-' + i);
      if (i + 1 < stream.chunks && p >= at('chunk-' + (i + 1))) throw new Error('Chunk ' + i + ' did not paint separately');
      return (p - at('chunk-' + i)) / 1000;
    }).sort((a, b) => a - b);
    const round = (n: number) => Number(n.toFixed(3));
    return { ...workload, closedBefore, closedAfter, chunks: stream.chunks, firstPaintMs: round((paint('first-dom') - open.ts) / 1000), replayPaintMs: round((last - open.ts) / 1000),
      longestReplayTaskMs: round(worst.dur! / 1000), longestTaskThreadMs: worst.tdur === undefined ? null : round(worst.tdur / 1000),
      longestTaskDetails: nested.slice(0, 3).map(e => [e.name, round(e.dur! / 1000)]),
      replayTasksOver50Ms: tasks.filter(e => e.dur! >= 50000).length,
      enqueueMsPerChunk: round(stream.enqueueMsPerChunk), mainCpuMsPerChunk: round(cpu / stream.chunks),
      chunkToPaintMeanMs: round(latencies.reduce((a, b) => a + b) / stream.chunks), chunkToPaintP95Ms: round(latencies[Math.ceil(stream.chunks * .95) - 1]) };
  } finally { await cdp.detach(); await fixture.dispose(); }
}

// The stand-alone run has no dependency on earlier UI check state and never opens an existing user's session.
if (import.meta.main) {
  const { spawn } = await import('node:child_process'), fs = await import('node:fs');
  // This entrypoint uses the UI suite's forwarder, not harness.py's WB_HARNESS_TCP guard.
  const devices = fs.readFileSync('/proc/self/net/dev', 'utf8').trimEnd().split('\n').slice(2);
  if (devices.length !== 1 || !/^\s*lo:/.test(devices[0])) throw new Error('Use tests/run-front-bench.sh (private loopback required)');
  const { HARNESS, ROOT, TMP, state } = await import('./shared.mts');
  const { startDaemon, dpage } = await import('./daemon.mts');
  if (!ROOT || !HARNESS) throw new Error('Set WB_HARNESS and pass a built web root');
  const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright') as typeof import('playwright-core');
  state.browser = await chromium.launch();
  const { WB_HARNESS_TCP, ...env } = process.env;
  const child = spawn('python3', ['-I', HARNESS, '--web-root', ROOT, '--api'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let fwd;
  try {
    fwd = await startDaemon(child);
    const { H } = await import('./daemon.mts'), sid = 'n81_stress';
    const response = await fetch(H.api + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim() }, body: JSON.stringify({ sid, agent: 'stub', cwd: TMP }) });
    if (!response.ok) throw new Error('Private ACP session: ' + response.status + ' ' + await response.text());
    const page = await dpage();
    await page.waitForFunction(id => {
      const acp = window.__canvas?.SESS[id]?.acp;
      return window.__canvas?.FR.online && acp?.agentSessionId && acp.activity === 'none';
    }, sid);
    await page.evaluate(id => window.__canvas.meshOpen(id), sid);
    await page.waitForFunction(() => window.__canvas.live.$agents?.backend.replayed && window.__canvas.live.$agents.backend.transcript);
    console.log(JSON.stringify({ chromium: state.browser.version(), ...await measureTranscript(page, process.argv.includes('--legacy-edwin')) }));
  } finally { await state.browser.close(); fwd?.close(); child.stdin.end(); fs.rmSync(TMP, { recursive: true, force: true }); }
}
