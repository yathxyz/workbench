// End-to-end walk with event timing (the frontend's profile, next to ui.mjs's correctness checks).
//
//   WB_PLAYWRIGHT=<playwright>/index.mjs WB_HARNESS=tests/harness.py node tests/perf.mjs <web-root> [--json FILE] [--profiles DIR] [--cards N]
//
// --profiles DIR writes each scenario's CPU profile as DIR/<n>-<scenario>.cpuprofile (open it in DevTools' Performance panel).
//
// It starts the harness (wb-hub, wb-web, Caddy), joins the browser to Caddy's unix socket through a forwarder on
// 127.0.0.1:18443 that only this uid may use (as ui.mjs does), and walks the scenarios a working day has: load the
// board, pan and zoom, drag a card, type into a shell, flood a shell with output, type into a page, search the
// palette, switch views, and the same pan and zoom again on a board with many cards. Each scenario records:
//   - wall time;
//   - every input event Chromium's Event Timing API reports at 16 ms or more (name, processing, target);
//   - long animation frames (blocking time, and the scripts in them with their source function);
//   - a CPU profile (CDP Profiler), reduced to the functions with the most self time in app.js and the vendor bundle;
//   - frames painted (requestAnimationFrame ticks) and the longest gap between two.
// It also asserts the behaviours the walk passes through (ok/FAIL lines, as ui.mjs prints them): no toast and no
// console error at load without a model, Enter on an active shell puts the keyboard in that shell, Shift-Enter opens
// it full screen. The exit status is 0 only when every check passed; timings never fail the run, they are reported.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const JSON_OUT = opt('--json', null), PROFILES = opt('--profiles', null), CARDS = +opt('--cards', 120);
const ROOT = args[0] || process.env.WB_WEB_ROOT, HARNESS = process.env.WB_HARNESS;
if (!ROOT || !HARNESS) { console.error('usage: WB_PLAYWRIGHT=… WB_HARNESS=tests/harness.py node tests/perf.mjs <web-root> [--json FILE] [--profiles DIR] [--cards N]'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 10000, step = 100) => { const end = Date.now() + ms; for (;;) { let v; try { v = await f(); } catch {} if (v || Date.now() > end) return v; await sleep(step); } };
const fails = [];
const check = (name, ok, info = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name, ok ? '' : info); if (!ok) fails.push(name); };

// ---------------- the harness and the forwarder (ui.mjs's daemon phase)
const PORT = 18443, ORIGIN = `http://127.0.0.1:${PORT}`;
const { WB_HARNESS_TCP, ...harnessEnv } = process.env;
const harness = spawn('python3', ['-I', HARNESS, '--web-root', ROOT], { stdio: ['pipe', 'pipe', 'pipe'], env: harnessEnv });
let hlog = ''; harness.stderr.on('data', d => { hlog += d; });
const H = await new Promise((res, rej) => {
  let out = ''; harness.stdout.on('data', d => { out += d; const i = out.indexOf('\n'); if (i >= 0) try { res(JSON.parse(out.slice(0, i))); } catch (e) { rej(e); } });
  harness.on('exit', c => rej(new Error(`harness exited with ${c}\n${hlog}`)));
});
const hexPort = n => n.toString(16).toUpperCase().padStart(4, '0');
function peerUid(c) {
  const local = '0100007F:' + hexPort(c.remotePort), remote = '0100007F:' + hexPort(PORT);
  for (const l of fs.readFileSync('/proc/net/tcp', 'utf8').split('\n')) { const f = l.trim().split(/\s+/); if (f[1] === local && f[2] === remote) return Number(f[7]); }
  return -1;
}
const fwd = net.createServer(c => {
  if (c.remoteAddress !== '127.0.0.1' || peerUid(c) !== process.getuid()) return c.destroy();
  const u = net.connect(H.caddySocket);
  const end = () => { c.destroy(); u.destroy(); };
  for (const s of [c, u]) { s.on('error', end); s.on('close', end); }
  c.pipe(u); u.pipe(c);
});
await new Promise((res, rej) => { fwd.once('error', rej); fwd.listen(PORT, '127.0.0.1', res); });

// ---------------- the page, its probes and the profiler
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
const errors = [], http = [];
p.on('pageerror', e => errors.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
ctx.on('response', r => { if (r.status() >= 400) http.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
await p.addInitScript(() => {
  const P = window.__perf = { events: [], loafs: [], toasts: [], frames: [] };
  const sel = n => !n || !n.tagName ? '' : n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList?.length ? '.' + [...n.classList].slice(0, 2).join('.') : '');
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.events.push({ t: e.startTime, name: e.name, dur: e.duration, proc: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime, target: sel(e.target) }); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.loafs.push({ t: e.startTime, dur: e.duration, block: e.blockingDuration, scripts: (e.scripts || []).map(s => ({ dur: s.duration, fn: s.sourceFunctionName, url: (s.sourceURL || '').split('/').pop(), char: s.sourceCharPosition, invoker: s.invoker })) }); }).observe({ type: 'long-animation-frame', buffered: true }); } catch {}
  const tick = t => { P.frames.push(t); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  new MutationObserver(() => { const t = document.querySelector('#toast'); if (t?.classList.contains('show') && P.toasts.at(-1)?.text !== t.textContent) P.toasts.push({ t: performance.now(), text: t.textContent }); })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true });
});
const cdp = await ctx.newCDPSession(p);
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

// Self time per function from a CDP profile, for the page's own scripts.
function hot(profile, n = 8) {
  const self = new Map(), byId = new Map(profile.nodes.map(x => [x.id, x]));
  const dt = profile.timeDeltas; let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]), d = (dt[i + 1] ?? dt[i] ?? 0) / 1000; total += d;
    const f = node.callFrame, file = f.url.split('/').pop(), fn = f.functionName || '(anonymous)';
    const key = file.endsWith('.js') ? `${fn} ${file}:${f.lineNumber + 1}` : fn.startsWith('(') ? fn : `(${fn})`;   // (idle), (program), (garbage collector), natives
    self.set(key, (self.get(key) || 0) + d);
  }
  const g = k => self.get(k) || 0, js = total - g('(idle)') - g('(program)') - g('(garbage collector)');
  // (program) is the browser's own work outside JavaScript: style, layout, paint and raster on the main thread.
  return { total: +total.toFixed(1), js: +js.toFixed(1), gc: +g('(garbage collector)').toFixed(1), browser: +g('(program)').toFixed(1),
    top: [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)$/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +v.toFixed(1)]) };
}
const pct = (xs, q) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1); };
const results = [];
async function scenario(name, run) {
  const t0 = await p.evaluate(() => window.__perf ? performance.now() : 0);   // 0: before the first load
  await cdp.send('Profiler.start');
  const w0 = Date.now(); let note;
  try { note = await run(); } catch (e) { note = 'error: ' + e.message; check(`${name}: runs`, false, e.stack); }
  const wall = Date.now() - w0;
  await sleep(300);   // let late frames and observers report
  const { profile } = await cdp.send('Profiler.stop');
  if (PROFILES) { fs.mkdirSync(PROFILES, { recursive: true }); fs.writeFileSync(path.join(PROFILES, `${String(results.length + 1).padStart(2, '0')}-${name.replace(/[^\w]+/g, '-')}.cpuprofile`), JSON.stringify(profile)); }
  const P = await p.evaluate(t0 => { const P = window.__perf; const f = P.frames.filter(t => t >= t0); return { events: P.events.filter(e => e.t >= t0), loafs: P.loafs.filter(e => e.t >= t0), frames: f.length, gap: f.reduce((m, t, i) => i ? Math.max(m, t - f[i - 1]) : m, 0) }; }, t0);
  const scripts = new Map();
  for (const l of P.loafs) for (const s of l.scripts) { const k = `${s.fn || '(anonymous)'} ${s.url}${s.char >= 0 ? '@' + s.char : ''} [${s.invoker}]`; scripts.set(k, (scripts.get(k) || 0) + s.dur); }
  // An event's duration runs to the next paint, so in a software-rendered headless browser it is mostly paint; the
  // time in its handlers is what the page's code costs.
  const evDur = P.events.map(e => e.dur), evProc = P.events.map(e => e.proc);
  const r = {
    name, wall, note: note ?? '', frames: P.frames, maxFrameGap: +P.gap.toFixed(1),
    slowEvents: P.events.length, eventP95: pct(evDur, 0.95), eventMax: pct(evDur, 1), handlerP95: pct(evProc, 0.95), handlerMax: pct(evProc, 1),
    slowestEvents: [...P.events].sort((a, b) => b.proc - a.proc || b.dur - a.dur).slice(0, 3).map(e => `${e.name} handlers ${e.proc.toFixed(0)}ms of ${e.dur.toFixed(0)}ms on ${e.target}`),
    longFrames: P.loafs.length, blocking: +P.loafs.reduce((s, l) => s + l.block, 0).toFixed(0),
    loafScripts: [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => [k, +v.toFixed(0)]),
    cpu: hot(profile),
  };
  results.push(r);
  console.log(`\n== ${name}: ${wall} ms wall · JS ${r.cpu.js} ms, GC ${r.cpu.gc} ms, browser ${r.cpu.browser} ms · ${r.frames} frames, longest gap ${r.maxFrameGap} ms · ${r.slowEvents} events ≥16 ms, handlers p95 ${r.handlerP95} max ${r.handlerMax} ms · ${r.longFrames} long frames blocking ${r.blocking} ms${note ? ' · ' + note : ''}`);
  for (const e of r.slowestEvents) console.log('   event  ' + e);
  for (const [k, v] of r.loafScripts) console.log(`   loaf   ${v} ms  ${k}`);
  for (const [k, v] of r.cpu.top) console.log(`   cpu    ${v} ms  ${k}`);
  return r;
}
const C = (f, a) => p.evaluate(f, a);
const termText = id => C(id => { const b = window.__canvas.live[id]?.term?.buffer.active; if (!b) return ''; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\n'); }, id);
const addTerm = (name, x = 200, y = 200) => C(([name, x, y]) => window.__canvas.addNode({ kind: 'term', backend: 'pty', name, x, y, w: 640, h: 320, env: {} }).id, [name, x, y]);

try {
  // ---- load
  await scenario('load the board', async () => {
    const t = Date.now(); await p.goto(ORIGIN + '/'); await until(() => C(() => window.__canvas?.BOOTED), 20000);
    const booted = Date.now() - t; await sleep(2500);   // the startup toasts fire within 1.5 s of boot
    return `BOOTED after ${booted} ms`;
  });
  const toasts = await C(() => window.__perf.toasts.map(t => t.text));
  check('load: no toast about a model or an API key when the server has none', !toasts.some(t => /claude|api.?key|anthropic|model/i.test(t)), JSON.stringify(toasts));
  check('load: no console error and no failed request', !errors.length && !http.length, JSON.stringify({ errors, http }));

  // ---- the canvas
  const box = await p.locator('#viewport').boundingBox();
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
    const h = await p.locator(`.node[data-id="${sh}"] .hdr`).boundingBox();
    await p.mouse.move(h.x + 60, h.y + h.height / 2); await p.mouse.down();
    for (let i = 0; i < 60; i++) await p.mouse.move(h.x + 60 + i * 4, h.y + h.height / 2 + Math.sin(i / 6) * 40);
    await p.mouse.up();
  });

  // ---- Enter on the active card: the keyboard goes into the shell, in place; Shift-Enter opens it full screen
  await scenario('Enter on the active shell', async () => {
    await C(id => { document.activeElement?.blur(); window.__canvas.jumpNode(window.__canvas.S.nodes[id]); }, sh); await sleep(700);
    await C(() => document.activeElement?.blur());
    await p.keyboard.press('Enter'); await sleep(500);
    const st = await C(id => ({ inTerm: !!document.activeElement?.closest(`.node[data-id="${id}"]`) && document.activeElement.classList.contains('xterm-helper-textarea'), focus: window.__canvas.FOCUS.cur }), sh);
    check('Enter on an active shell card puts the keyboard in that shell and keeps the canvas', st.inTerm && !st.focus, JSON.stringify(st));
    await p.keyboard.type('echo enter-went-in\r'); await until(async () => (await termText(sh)).includes('\nenter-went-in'), 5000);
    check('the keys typed after Enter reach the shell', (await termText(sh)).includes('\nenter-went-in'));
    await C(() => document.activeElement?.blur()); await p.keyboard.press('Shift+Enter'); await sleep(500);
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

  // ---- a page (CodeMirror buffer)
  const pg = await C(() => window.__canvas.addNode({ kind: 'buffer', name: 'perf-page', x: 1000, y: 260, w: 520, h: 420, text: '# perf\n' + Array.from({ length: 400 }, (_, i) => `- line ${i} with a [[link ${i % 20}]] and words`).join('\n') }).id);
  await C(id => { const C_ = window.__canvas; C_.jumpNode(C_.S.nodes[id]); }, pg); await sleep(700);
  await C(id => { const v = window.__canvas.live[id].view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); }, pg);
  await p.keyboard.press('Escape'); await p.keyboard.press('A');   // vim: append at the end of the line
  await scenario('type 200 characters into a page', async () => { await p.keyboard.type(' typing in a page, word after word '.repeat(6).slice(0, 200), { delay: 8 }); });
  await p.keyboard.press('Escape'); await C(() => document.activeElement?.blur());

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
  await scenario(`add ${CARDS} pages`, async () => {
    await C(N => { const C_ = window.__canvas; for (let i = 0; i < N; i++) C_.addNode({ kind: 'buffer', name: 'bulk' + i, x: 2000 + (i % 12) * 440, y: 200 + Math.floor(i / 12) * 340, w: 400, h: 300, text: `# bulk ${i}\n- see [[bulk${(i + 1) % N}]]\n` + 'filler text '.repeat(40) }); }, CARDS);
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
    await C(id => { const v = window.__canvas.live[id].view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); }, pg);
    await p.keyboard.press('Escape'); await p.keyboard.press('A');
    await p.keyboard.type(' more typing on a big board '.repeat(4).slice(0, 100), { delay: 8 });
  });
  // At a person's pace the keys pause long enough for the board's cross-page refresh (backlinks, refs) between them.
  await scenario(`type 30 characters at 150 ms a key with ${CARDS} more cards`, async () => {
    await p.keyboard.type(' at a human pace, key by key.'.slice(0, 30), { delay: 150 });
    await p.keyboard.press('Escape');
  });
  await sleep(1500);   // the board save settles
  await scenario(`reload the board with ${CARDS + 20} cards`, async () => {
    const t = Date.now(); await p.reload(); await until(() => C(() => window.__canvas?.BOOTED), 30000);
    const booted = Date.now() - t; await sleep(1500); return `BOOTED after ${booted} ms`;
  });
  check('the reload keeps every card', await C(N => Object.values(window.__canvas.S.nodes).filter(n => /^bulk\d+$/.test(n.name)).length === N, CARDS));
  check('no page error during the walk', !errors.length, JSON.stringify(errors.slice(0, 5)));
} finally {
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), cards: CARDS, results, errors, http }, null, 1));
  await browser.close(); harness.stdin.end(); fwd.close();
}
console.log(`\nFAILS: ${JSON.stringify(fails)}`);
process.exit(fails.length ? 1 : 0);
