// End-to-end walk with event timing (the frontend's profile, next to ui.mts's correctness checks).
//
//   WB_PLAYWRIGHT=<playwright>/index.mjs WB_HARNESS=tests/harness.py node tests/perf.mts <web-root> [--json FILE] [--profiles DIR] [--cards N] [--pages M]
//
// --profiles DIR writes each scenario's CPU profile as DIR/<n>-<scenario>.cpuprofile (open it in DevTools' Performance panel).
// --cards N adds N cards to the board (default 120); --pages M makes M of them pages and the rest cheap cards (scripted
// terminals and sketches), so `--cards 133 --pages 33` with the seed's 6 pages and perf-page is the 140-card, 40-page
// board of the budgets (spec §16.5). Without --pages every added card is a page, as before.
//
// It starts the harness (wb-hub, edwind, wb-web, Caddy), joins the browser to Caddy's unix socket through a forwarder on
// 127.0.0.1:18443 that only this uid may use (as ui.mts does), and walks the scenarios a working day has: load the
// board, pan and zoom, drag a card, type into a shell, flood a shell with output, type into a page, search the
// palette, switch views, and the same pan and zoom again on a board with many cards. Each scenario records:
//   - wall time;
//   - every input event Chromium's Event Timing API reports at 16 ms or more (name, processing, target);
//   - long animation frames (blocking time, and the scripts in them with their source function);
//   - a CPU profile (CDP Profiler), reduced to the functions with the most self time in app.js and the vendor bundle;
//   - frames painted (requestAnimationFrame ticks) and the longest gap between two.
// It also asserts the behaviours the walk passes through (ok/FAIL lines, as ui.mts prints them): no toast and no
// console error at load without a model, Enter on an active shell puts the keyboard in that shell, Shift-Enter opens
// it full screen. The exit status is 0 only when every check passed; timings never fail the run, they are reported,
// except the frames budgets below.
//
// WB_FRAMES=1 runs the same walk with pages as Edwin frames (harness --frames) and adds the `frames` scenario on the
// many-card board: the frame runtime's boot time (performance measure fr-boot), the live frame count against the cap
// (at most 24, R9.5), and keystroke latency in a focused frame with at least 10 frames live (20 keystrokes: keydown
// to the character in the frame's DOM, asserted against the §16.5 budget p95 <= 16 ms, and keydown to the animation
// frame that paints it, recorded). The JSON output carries them under `frames`; the budgets without a number in the
// spec (boot against the CodeMirror baseline) are recorded, not asserted: compare two JSON files.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// What the init script below collects in the page (window.__perf), and app.ts's frame counters beside it.
interface PerfEventRec { t: number; name: string; dur: number; proc: number; delay: number; target: string }
interface PerfLoafScriptRec { dur: number; fn: string; url: string | undefined; char: number; invoker: string }
interface PerfLoafRec { t: number; dur: number; block: number; scripts: PerfLoafScriptRec[] }
interface PerfProbe {
  events: PerfEventRec[]; loafs: PerfLoafRec[]; toasts: { t: number; text: string }[]; frames: number[];
  frame?: { samples: number[]; count: number; median: number | null; live: number; cap: number; ready: boolean; online: boolean };
}
/* Chromium's Long Animation Frames API, which lib.dom does not declare. */
interface PerfLoafScriptTiming { duration: number; sourceFunctionName: string; sourceURL: string; sourceCharPosition: number; invoker: string }
interface PerfLoafTiming extends PerformanceEntry { blockingDuration: number; scripts?: PerfLoafScriptTiming[] }
/* The part of a CDP Profiler.Profile that hot() reads (Profiler.stop always fills samples and timeDeltas). */
interface PerfCpuProfile { nodes: { id: number; callFrame: { url: string; functionName: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] }
interface PerfCpuHot { total: number; js: number; gc: number; browser: number; top: [string, number][] }
interface PerfScenarioResult {
  name: string; wall: number; note: string; frames: number; maxFrameGap: number;
  slowEvents: number; eventP95: number; eventMax: number; handlerP95: number; handlerMax: number; slowestEvents: string[];
  longFrames: number; blocking: number; loafScripts: [string, number][]; cpu: PerfCpuHot;
}
interface PerfLatencyStats { samples: number; median: number; p95: number; max: number; lat: (number | null)[] }
interface PerfFramesReport {
  boot: { booted: number; ready: number; frBoot: number | null } | null; live: number | null; cap: number | null;
  keystroke: { dom: PerfLatencyStats; paint: PerfLatencyStats } | null;
}
/* Keystroke times by character (window.__keys in the frames scenario): keydown, in the frame's DOM, painted. */
interface PerfKeyTimes { down: Record<string, number>; dom: Record<string, number>; paint: Record<string, number> }
type PerfKeysWindow = typeof window & { __keys: PerfKeyTimes };

const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright') as typeof import('playwright-core');
const args = process.argv.slice(2);
const opt = <D,>(k: string, d: D): string | D => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const JSON_OUT = opt('--json', null), PROFILES = opt('--profiles', null), CARDS = +opt('--cards', 120), PAGES = Math.min(CARDS, +opt('--pages', CARDS));
const ROOT = args[0] || process.env.WB_WEB_ROOT, HARNESS = process.env.WB_HARNESS;
if (!ROOT || !HARNESS) { console.error('usage: WB_PLAYWRIGHT=… WB_HARNESS=tests/harness.py node tests/perf.mts <web-root> [--json FILE] [--profiles DIR] [--cards N] [--pages M]'); process.exit(2); }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const until = async <T,>(f: () => T | Promise<T>, ms = 10000, step = 100): Promise<T | undefined> => { const end = Date.now() + ms; for (;;) { let v: T | undefined; try { v = await f(); } catch {} if (v || Date.now() > end) return v; await sleep(step); } };
const fails: string[] = [];
const check = (name: string, ok: boolean, info = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name, ok ? '' : info); if (!ok) fails.push(name); };

// ---------------- the harness and the forwarder (ui.mts's daemon phase)
const PORT = 18443, ORIGIN = `http://127.0.0.1:${PORT}`;
const { WB_HARNESS_TCP, ...harnessEnv } = process.env;
const FRAMES = process.env.WB_FRAMES === '1';   // pages as Edwin frames (web.json frames: true)
const harness = spawn('python3', ['-I', HARNESS, '--web-root', ROOT, ...(FRAMES ? ['--frames'] : [])], { stdio: ['pipe', 'pipe', 'pipe'], env: harnessEnv });
let hlog = ''; harness.stderr.on('data', d => { hlog += d; });
const H = await new Promise<{ caddySocket: string }>((res, rej) => {
  let out = ''; harness.stdout.on('data', d => { out += d; const i = out.indexOf('\n'); if (i >= 0) try { res(JSON.parse(out.slice(0, i))); } catch (e) { rej(e); } });
  harness.on('exit', c => rej(new Error(`harness exited with ${c}\n${hlog}`)));
});
const hexPort = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
function peerUid(c: net.Socket) {
  const local = '0100007F:' + hexPort(c.remotePort!), remote = '0100007F:' + hexPort(PORT);
  for (const l of fs.readFileSync('/proc/net/tcp', 'utf8').split('\n')) { const f = l.trim().split(/\s+/); if (f[1] === local && f[2] === remote) return Number(f[7]); }
  return -1;
}
const fwd = net.createServer(c => {
  if (c.remoteAddress !== '127.0.0.1' || peerUid(c) !== process.getuid!()) return c.destroy();
  const u = net.connect(H.caddySocket);
  const end = () => { c.destroy(); u.destroy(); };
  for (const s of [c, u]) { s.on('error', end); s.on('close', end); }
  c.pipe(u); u.pipe(c);
});
await new Promise<void>((res, rej) => { fwd.once('error', rej); fwd.listen(PORT, '127.0.0.1', res); });

// ---------------- the page, its probes and the profiler
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
const errors: string[] = [], http: string[] = [];
p.on('pageerror', e => errors.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
ctx.on('response', r => { if (r.status() >= 400) http.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
await p.addInitScript(() => {
  const P: PerfProbe = window.__perf = { events: [], loafs: [], toasts: [], frames: [] };
  const sel = (n: Element | null) => !n || !n.tagName ? '' : n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList?.length ? '.' + [...n.classList].slice(0, 2).join('.') : '');
  try { new PerformanceObserver(l => { for (const e of l.getEntries() as PerformanceEventTiming[]) P.events.push({ t: e.startTime, name: e.name, dur: e.duration, proc: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime, target: sel(e.target as Element | null) }); }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries() as PerfLoafTiming[]) P.loafs.push({ t: e.startTime, dur: e.duration, block: e.blockingDuration, scripts: (e.scripts || []).map(s => ({ dur: s.duration, fn: s.sourceFunctionName, url: (s.sourceURL || '').split('/').pop(), char: s.sourceCharPosition, invoker: s.invoker })) }); }).observe({ type: 'long-animation-frame', buffered: true }); } catch {}
  const tick = (t: number) => { P.frames.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  new MutationObserver(() => { const t = document.querySelector('#toast'); if (t?.classList.contains('show') && P.toasts.at(-1)?.text !== t.textContent) P.toasts.push({ t: performance.now(), text: t.textContent! }); })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true });
});
const cdp = await ctx.newCDPSession(p);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

// Self time per function from a CDP profile, for the page's own scripts.
function hot(profile: PerfCpuProfile, n = 8): PerfCpuHot {
  const self = new Map<string, number>(), byId = new Map(profile.nodes.map(x => [x.id, x] as const));
  const dt = profile.timeDeltas; let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i])!, d = (dt[i + 1] ?? dt[i] ?? 0) / 1000; total += d;
    const f = node.callFrame, file = f.url.split('/').pop()!, fn = f.functionName || '(anonymous)';
    const key = file.endsWith('.js') ? `${fn} ${file}:${f.lineNumber + 1}` : fn.startsWith('(') ? fn : `(${fn})`;   // (idle), (program), (garbage collector), natives
    self.set(key, (self.get(key) || 0) + d);
  }
  const g = (k: string) => self.get(k) || 0, js = total - g('(idle)') - g('(program)') - g('(garbage collector)');
  // (program) is the browser's own work outside JavaScript: style, layout, paint and raster on the main thread.
  return { total: +total.toFixed(1), js: +js.toFixed(1), gc: +g('(garbage collector)').toFixed(1), browser: +g('(program)').toFixed(1),
    top: [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(1)]) };
}
const pct = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
const results: PerfScenarioResult[] = [];
async function scenario(name: string, run: () => Promise<string | undefined>) {
  const t0 = await p.evaluate(() => window.__perf ? performance.now() : 0);   // 0: before the first load
  await cdp.send('Profiler.start');
  const w0 = Date.now(); let note: string | undefined;
  try { note = await run(); } catch (e) { note = 'error: ' + e.message; check(`${name}: runs`, false, e.stack); }
  const wall = Date.now() - w0;
  await sleep(300);   // let late frames and observers report
  const { profile } = await cdp.send('Profiler.stop');
  if (PROFILES) { fs.mkdirSync(PROFILES, { recursive: true }); fs.writeFileSync(path.join(PROFILES, `${String(results.length + 1).padStart(2, '0')}-${name.replace(/[^\w]+/g, '-')}.cpuprofile`), JSON.stringify(profile)); }
  const P = await p.evaluate(t0 => { const P = window.__perf as PerfProbe; const f = P.frames.filter(t => t >= t0); return { events: P.events.filter(e => e.t >= t0), loafs: P.loafs.filter(e => e.t >= t0), frames: f.length, gap: f.reduce((m, t, i) => i ? Math.max(m, t - f[i - 1]) : m, 0) }; }, t0);
  const scripts = new Map();
  for (const l of P.loafs) for (const s of l.scripts) { const k = `${s.fn || '(anonymous)'} ${s.url}${s.char >= 0 ? '@' + s.char : ''} [${s.invoker}]`; scripts.set(k, (scripts.get(k) || 0) + s.dur); }
  // An event's duration runs to the next paint, so in a software-rendered headless browser it is mostly paint; the
  // time in its handlers is what the page's code costs.
  const evDur = P.events.map(e => e.dur), evProc = P.events.map(e => e.proc);
  const r: PerfScenarioResult = {
    name, wall, note: note ?? '', frames: P.frames, maxFrameGap: +P.gap.toFixed(1),
    slowEvents: P.events.length, eventP95: pct(evDur, 0.95), eventMax: pct(evDur, 1), handlerP95: pct(evProc, 0.95), handlerMax: pct(evProc, 1),
    slowestEvents: [...P.events].sort((a, b) => b.proc - a.proc || b.dur - a.dur).slice(0, 3).map(e => `${e.name} handlers ${e.proc.toFixed(0)}ms of ${e.dur.toFixed(0)}ms on ${e.target}`),
    longFrames: P.loafs.length, blocking: +P.loafs.reduce((s, l) => s + l.block, 0).toFixed(0),
    loafScripts: [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, +v.toFixed(0)]),
    cpu: hot(profile as PerfCpuProfile),
  };
  results.push(r);
  console.log(`\n== ${name}: ${wall} ms wall · JS ${r.cpu.js} ms, GC ${r.cpu.gc} ms, browser ${r.cpu.browser} ms · ${r.frames} frames, longest gap ${r.maxFrameGap} ms · ${r.slowEvents} events ≥16 ms, handlers p95 ${r.handlerP95} max ${r.handlerMax} ms · ${r.longFrames} long frames blocking ${r.blocking} ms${note ? ' · ' + note : ''}`);
  for (const e of r.slowestEvents) console.log('   event  ' + e);
  for (const [k, v] of r.loafScripts) console.log(`   loaf   ${v} ms  ${k}`);
  for (const [k, v] of r.cpu.top) console.log(`   cpu    ${v} ms  ${k}`);
  return r;
}
const C = <R, A>(f: (a: A) => R | Promise<R>, a?: A): Promise<R> => p.evaluate(f as (a: unknown) => R | Promise<R>, a);
// The keyboard at the end of a page's text, inserting: the CodeMirror view's selection, or the page's Edwin frame
// (frFocus makes the frame whatever the viewport says) and Evil's G then A.
async function pageEnd(id: string) {
  if (FRAMES) {
    await C(id => { const C_ = window.__canvas; (document.activeElement as HTMLElement | null)?.blur(); C_.frFocus(C_.S.nodes[id]); }, id);
    await until(() => C(id => !!window.__canvas.live[id]?.frame?.focused, id), 15000);
    await p.keyboard.press('Escape'); await p.keyboard.press('Shift+G'); await p.keyboard.press('Shift+A');
  } else {
    await C(id => { const v = window.__canvas.live[id].view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); }, id);
    await p.keyboard.press('Escape'); await p.keyboard.press('A');   // vim: append at the end of the line
  }
}
const frames: PerfFramesReport | null = FRAMES ? { boot: null, live: null, cap: null, keystroke: null } : null;
const termText = (id: string) => C(id => { const b = window.__canvas.live[id]?.term?.buffer.active; if (!b) return ''; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\n'); }, id);
const addTerm = (name: string, x = 200, y = 200): Promise<string> => C(([name, x, y]) => window.__canvas.addNode({ kind: 'term', backend: 'pty', name, x, y, w: 640, h: 320, env: {} }).id, [name, x, y]);

try {
  // ---- load
  await scenario('load the board', async () => {
    const t = Date.now(); await p.goto(ORIGIN + '/'); await until(() => C(() => window.__canvas?.BOOTED), 20000);
    const booted = Date.now() - t;
    let fr = '';
    if (FRAMES) {   // the frame runtime boots beside the board; replicas open once /edit is online
      await until(() => C(() => window.__perf?.frame?.ready && window.__perf.frame.online), 30000);
      const ready = Date.now() - t, m = await C(() => performance.getEntriesByName('fr-boot')[0]?.duration ?? null);
      frames!.boot = { booted, ready, frBoot: m == null ? null : +m.toFixed(0) };
      fr = ` · frame runtime ready after ${ready} ms (fr-boot ${frames!.boot.frBoot} ms)`;
    }
    await sleep(2500);   // the startup toasts fire within 1.5 s of boot
    return `BOOTED after ${booted} ms${fr}`;
  });
  const toasts = await C(() => (window.__perf as PerfProbe).toasts.map(t => t.text));
  check('load: no toast about a model or an API key when the server has none', !toasts.some(t => /claude|api.?key|anthropic|model/i.test(t)), JSON.stringify(toasts));
  check('load: no console error and no failed request', !errors.length && !http.length, JSON.stringify({ errors, http }));

  // ---- the canvas
  const box = (await p.locator('#viewport').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await scenario('pan and zoom (wheel)', async () => {
    await p.mouse.move(cx, cy);
    for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, i % 20 < 10 ? 60 : -60); await sleep(16); }
    await p.keyboard.down('Control'); for (let i = 0; i < 30; i++) { await p.mouse.wheel(0, i < 15 ? -80 : 80); await sleep(16); } await p.keyboard.up('Control');
  });
  const sh = await addTerm('perf-sh', 300, 260);
  await until(async () => /[$#] *$/m.test(await termText(sh)), 10000);
  await C(id => window.__canvas.jumpNode(window.__canvas.S.nodes[id]), sh); await sleep(700);
  await scenario('drag a card by its header', async () => {
    const h = (await p.locator(`.node[data-id="${sh}"] .hdr`).boundingBox())!;
    await p.mouse.move(h.x + 60, h.y + h.height / 2); await p.mouse.down();
    for (let i = 0; i < 60; i++) await p.mouse.move(h.x + 60 + i * 4, h.y + h.height / 2 + Math.sin(i / 6) * 40);
    await p.mouse.up();
  });

  // ---- Enter on the active card: the keyboard goes into the shell, in place; Shift-Enter opens it full screen
  await scenario('Enter on the active shell', async () => {
    await C(id => { (document.activeElement as HTMLElement | null)?.blur(); window.__canvas.jumpNode(window.__canvas.S.nodes[id]); }, sh); await sleep(700);
    await C(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.keyboard.press('Enter'); await sleep(500);
    const st = await C(id => ({ inTerm: !!document.activeElement?.closest(`.node[data-id="${id}"]`) && document.activeElement.classList.contains('xterm-helper-textarea'), focus: window.__canvas.FOCUS.cur }), sh);
    check('Enter on an active shell card puts the keyboard in that shell and keeps the canvas', st.inTerm && !st.focus, JSON.stringify(st));
    await p.keyboard.type('echo enter-went-in\r'); await until(async () => (await termText(sh)).includes('\nenter-went-in'), 5000);
    check('the keys typed after Enter reach the shell', (await termText(sh)).includes('\nenter-went-in'));
    await C(() => (document.activeElement as HTMLElement | null)?.blur()); await p.keyboard.press('Shift+Enter'); await sleep(500);
    const fs_ = await C(() => window.__canvas.FOCUS.cur);
    check('Shift-Enter on the active card opens it as a focus tab', fs_ === sh, String(fs_));
    await C(() => window.__canvas.focusHide()); await sleep(300);
  });

  // ---- a shell: keystrokes, then a flood of output
  await C(id => window.__canvas.live[id].term.focus(), sh);
  await scenario('type 200 characters into a shell', async () => {
    await p.keyboard.type('echo ' + 'abcdefghij'.repeat(19) + '\r', { delay: 8 });
    await until(async () => (await termText(sh)).includes('abcdefghij'.repeat(19) + '\n'), 5000);
  });
  await scenario('a shell prints 200k lines', async () => {
    await p.keyboard.type('seq 1 200000; echo flood-done\r');
    const done = await until(async () => (await termText(sh)).includes('\nflood-done'), 60000, 200);
    check('the flood reaches its end marker', !!done);
  });

  // ---- a page (a CodeMirror buffer, or an Edwin frame)
  const pg: string = await C(() => window.__canvas.addNode({ kind: 'buffer', name: 'perf-page', x: 1000, y: 260, w: 520, h: 420, text: '# perf\n' + Array.from({ length: 400 }, (_, i) => `- line ${i} with a [[link ${i % 20}]] and words`).join('\n') }).id);
  await C(id => { const C_ = window.__canvas; C_.jumpNode(C_.S.nodes[id]); }, pg); await sleep(700);
  await pageEnd(pg);
  await scenario('type 200 characters into a page', async () => { await p.keyboard.type(' typing in a page, word after word '.repeat(6).slice(0, 200), { delay: 8 }); });
  await p.keyboard.press('Escape'); await C(() => (document.activeElement as HTMLElement | null)?.blur());

  // ---- the palette and the views
  await scenario('palette: fuzzy search as you type', async () => {
    await p.keyboard.press('Control+k'); await sleep(200);
    await p.keyboard.type('perfpage', { delay: 40 }); await sleep(200);
    await p.keyboard.press('Escape');
  });
  await scenario('switch views Alt-1 … Alt-7', async () => {
    for (let i = 1; i <= 7; i++) { await p.keyboard.press(`Alt+Digit${i}`); await sleep(250); }
    await p.keyboard.press('Alt+Digit1'); await sleep(300);
  });

  // ---- many cards
  await scenario(PAGES === CARDS ? `add ${CARDS} pages` : `add ${CARDS} cards (${PAGES} pages)`, async () => {
    await C(([N, M]) => {
      const C_ = window.__canvas;
      for (let i = 0; i < N; i++) {
        const at = { name: 'bulk' + i, x: 2000 + (i % 12) * 440, y: 200 + Math.floor(i / 12) * 340, w: 400, h: 300 };
        if (i < M) C_.addNode({ kind: 'buffer', ...at, text: `# bulk ${i}\n- see [[bulk${(i + 1) % M}]]\n` + 'filler text '.repeat(40) });
        else if (i % 2) C_.addNode({ kind: 'sketch', ...at });
        else C_.addNode({ kind: 'term', backend: 'fake', env: {}, ...at });
      }
    }, [CARDS, PAGES]);
  });
  await C(() => window.__canvas.fitAll()); await sleep(800);
  await scenario(`pan and zoom with ${CARDS} more cards`, async () => {
    await p.mouse.move(cx, cy);
    for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, i % 20 < 10 ? 60 : -60); await sleep(16); }
    await p.keyboard.down('Control'); for (let i = 0; i < 30; i++) { await p.mouse.wheel(0, i < 15 ? -80 : 80); await sleep(16); } await p.keyboard.up('Control');
  });
  await scenario(`idle 3 s zoomed out over ${CARDS + 20} cards`, async () => { await sleep(3000); });
  await C(id => window.__canvas.jumpNode(window.__canvas.S.nodes[id]), pg); await sleep(800);
  await scenario(`idle 3 s at reading zoom over ${CARDS + 20} cards`, async () => { await sleep(3000); });
  await scenario(`type into a page with ${CARDS} more cards`, async () => {
    await pageEnd(pg);
    await p.keyboard.type(' more typing on a big board '.repeat(4).slice(0, 100), { delay: 8 });
  });
  // At a person's pace the keys pause long enough for the board's cross-page refresh (backlinks, refs) between them.
  await scenario(`type 30 characters at 150 ms a key with ${CARDS} more cards`, async () => {
    await p.keyboard.type(' at a human pace, key by key.'.slice(0, 30), { delay: 150 });
    await p.keyboard.press('Escape');
  });
  if (FRAMES) {
    // ---- frames (§16.5): the live frame cap with the bulk pages in view, then keystroke to paint in one of them
    await scenario(`frames: ${Math.min(PAGES, 20)} pages in view, keystroke to paint`, async () => {
      // the bulk grid has 12 columns of 440 x 340 cards; at z = 0.6 the viewport holds 6 columns of 5 rows of them
      await C(() => { const C_ = window.__canvas, z = 0.6; C_.S.cam.z = z; C_.S.cam.x = 3250 - (innerWidth / 2) / z; C_.S.cam.y = 920 - (innerHeight / 2) / z; C_.applyCam(); C_.frSchedule(); });
      const live = await until(() => C(() => { const f = (window.__perf as PerfProbe).frame!; return f.live >= Math.min(10, f.cap) ? f.live : null; }), 20000);
      await sleep(800);
      frames!.live = await C(() => (window.__perf as PerfProbe).frame!.live); frames!.cap = await C(() => (window.__perf as PerfProbe).frame!.cap);
      check('frames: at most 24 frames are live with the bulk pages in view (R9.5)', frames!.live <= frames!.cap && frames!.cap === 24, JSON.stringify({ live: frames!.live, cap: frames!.cap }));
      check('frames: at least 10 frames are live for the keystroke budget (§16.5)', frames!.live >= 10, JSON.stringify({ live, now: frames!.live }));
      const bulk0 = await C(() => Object.values(window.__canvas.S.nodes as Record<string, BoardNode>).find(n => n.name === 'bulk0')!.id);
      await pageEnd(bulk0);
      // Every keystroke's time from keydown to the animation frame after the character is in the frame's lines: the
      // mutation observer sees the DOM change, the next requestAnimationFrame callback runs just before the paint of it
      // (performance.now() there, not the callback's timestamp, which is the frame's start and can precede the key).
      await C(id => {
        const K: PerfKeyTimes = (window as PerfKeysWindow).__keys = { down: {}, dom: {}, paint: {} };
        document.addEventListener('keydown', e => { if (e.key.length === 1 && !(e.key in K.down)) K.down[e.key] = performance.now(); }, true);
        const host = document.querySelector(`.node[data-id="${id}"] .fr-host`)!;
        new MutationObserver(() => { const t = performance.now(), text = host.textContent; for (const ch of Object.keys(K.down)) if (!(ch in K.dom) && text.includes('~' + ch)) { K.dom[ch] = t; requestAnimationFrame(() => { K.paint[ch] = performance.now(); }); } }).observe(host, { subtree: true, childList: true, characterData: true });
      }, bulk0);
      await p.keyboard.type(' ~'); await sleep(200);
      const chars = 'ABCDEFGHIJKLMNOPQRST';
      for (const ch of chars) { await p.keyboard.type(ch); await sleep(60); await p.keyboard.press('Backspace'); await sleep(40); }
      await sleep(300);
      const K = await C(() => (window as PerfKeysWindow).__keys);
      // Two numbers per key: to the frame's DOM (the runtime's render work) and to the next animation frame callback
      // (the paint, which waits for the frame boundary: at 60 Hz that wait alone is up to 16.7 ms, so the budget
      // "keystroke to pixels p95 <= 16 ms" is held to the render work fitting in one frame: DOM p95 <= 16 ms; the
      // paint-inclusive figure is recorded).
      const stats = (xs: (number | null)[]) => { const got = xs.filter(x => x != null); return { samples: got.length, median: pct(got, 0.5), p95: pct(got, 0.95), max: pct(got, 1) }; };
      const dom = [...chars].map(ch => K.dom[ch] != null && K.down[ch] != null ? +(K.dom[ch] - K.down[ch]).toFixed(1) : null);
      const paint = [...chars].map(ch => K.paint[ch] != null && K.down[ch] != null ? +(K.paint[ch] - K.down[ch]).toFixed(1) : null);
      frames!.keystroke = { dom: { ...stats(dom), lat: dom }, paint: { ...stats(paint), lat: paint } };
      check('frames: every one of the 20 measured keystrokes reached the frame\'s lines and was painted', frames!.keystroke.dom.samples === chars.length && frames!.keystroke.paint.samples === chars.length, JSON.stringify(frames!.keystroke));
      check('frames: keystroke to the frame\'s DOM p95 <= 16 ms in a focused frame on the many-card board (§16.5, A8: the render work fits one frame)', frames!.keystroke.dom.samples === chars.length && frames!.keystroke.dom.p95 <= 16, JSON.stringify(frames!.keystroke));
      await p.keyboard.press('Escape'); await C(() => (document.activeElement as HTMLElement | null)?.blur());
      return `${frames!.live} live frames (cap ${frames!.cap}) · keystroke to DOM median ${frames!.keystroke.dom.median} p95 ${frames!.keystroke.dom.p95} ms · to paint median ${frames!.keystroke.paint.median} p95 ${frames!.keystroke.paint.p95} max ${frames!.keystroke.paint.max} ms`;
    });
  }
  await sleep(1500);   // the board save settles
  await scenario(`reload the board with ${CARDS + 20} cards`, async () => {
    const t = Date.now(); await p.reload(); await until(() => C(() => window.__canvas?.BOOTED), 30000);
    const booted = Date.now() - t;
    if (FRAMES) await until(() => C(() => window.__perf?.frame?.ready && window.__perf.frame.online), 30000);
    await sleep(1500); return `BOOTED after ${booted} ms`;
  });
  check('the reload keeps every card', await C(N => Object.values(window.__canvas.S.nodes as Record<string, BoardNode>).filter(n => /^bulk\d+$/.test(n.name)).length === N, CARDS));
  check('no page error during the walk', !errors.length, JSON.stringify(errors.slice(0, 5)));
} finally {
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), cards: CARDS, pages: PAGES, frames, results, errors, http }, null, 1));
  await browser.close(); harness.stdin.end(); fwd.close();
}
console.log(`\nFAILS: ${JSON.stringify(fails)}`);
process.exit(fails.length ? 1 : 0);
