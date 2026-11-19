// bash tests/run-front-bench.sh front-page-bench.mts [desktop|phone] [load|input|navigator]
import { withBoard, metrics, stats } from './front-browser.mts';
import { writeFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import type { Page } from 'playwright-core';

const [device = 'desktop', workload = 'load'] = process.argv.slice(2);
if (!['desktop', 'phone'].includes(device) || !['load', 'input', 'navigator'].includes(workload)) throw Error('expected desktop|phone load|input|navigator');
const phone = device === 'phone', repeats = Number(process.env.WB_BENCH_REPEATS || 5);
const viewport = phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
interface Probe { frames: number[]; long: number[]; boot: number; heap: number; key: number; paints: number[] }
declare global { interface Window { frontProbe: Probe } }

async function probe(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const p: Probe = window.frontProbe = { frames: [], long: [], boot: 0, heap: 0, key: 0, paints: [] };
    new PerformanceObserver(l => p.long.push(...l.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true });
    function frame(t: number) {
      p.frames.push(t);
      if (!p.boot && window.__canvas?.BOOTED) p.boot = performance.now();
      p.heap = Math.max(p.heap, (performance as Performance & { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    window.addEventListener('keydown', () => { p.key = performance.now(); }, true);
  });
}

await withBoard(async (browser, info) => {
  // First visit writes the seed. All measured contexts then open the same persisted board.
  const seed = await browser.newPage({ viewport });
  await seed.goto(info.caddy);
  await seed.waitForFunction(() => window.__canvas?.BOOTED && window.__canvas.SAVE.lastJson);
  const board: Board = JSON.parse(await seed.evaluate(() => window.__canvas.SAVE.lastJson));
  await seed.close();
  const r = await browser.newContext();
  try {
    const res = await r.request.get(`${info.caddy}/api/board`);
    assert.ok(res.ok());
    if (workload === 'navigator') {
      // A populated navigator, in scrambled insertion order.
      for (let i = 0; i < 180; ++i) {
        const j = i * 97 % 180, id = `quote-${j}`;
        board.nodes[id] = { kind: 'ref', id, name: `quote ${j}`, x: 12000 + 440 * (i % 12), y: Math.floor(i / 12) * 260,
          w: 400, h: 220, text: `Excerpt ${j}`, srcLabel: 'notes', src: { node: 'notes' } };
      }
    }
    const save = await r.request.put(`${info.caddy}/api/board`, { headers: { 'If-Match': res.headers().etag, Origin: info.caddy }, data: board });
    assert.equal(save.status(), 204, await save.text());
  } finally { await r.close(); }
  for (let i = 0; i < (workload === 'load' ? repeats : 1); i++) {
    const ctx = await browser.newContext({ viewport });
    try {
      const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page);
      if (process.env.WB_BENCH_TRACE && i === 0) await ctx.tracing.start({ screenshots: true, snapshots: false });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: phone ? 4 : 1 });
      await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
      await probe(page);
      for (const cache of workload === 'load' ? ['cold', 'controlled'] : ['cold']) {
        if (process.env.WB_BENCH_PROFILE && i === 0) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
        if (cache === 'cold') await page.goto(info.caddy, { waitUntil: 'commit' });
        else await page.reload({ waitUntil: 'commit' });
        await page.waitForFunction(() => !!window.frontProbe?.boot);
        const end = await metrics(cdp);
        if (process.env.WB_BENCH_PROFILE && i === 0) writeFileSync(`${process.env.WB_BENCH_PROFILE}-${cache}.cpuprofile`, JSON.stringify((await cdp.send('Profiler.stop')).profile));
        const result = await page.evaluate(() => {
          const r = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          const scripts = r.filter(x => /\.m?js$/.test(x.name));
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          return { bootMs: window.frontProbe.boot, controlled: nav.workerStart > 0,
            resources: r.length, transferBytes: r.reduce((a, b) => a + b.transferSize, 0),
            scripts: scripts.map(({ name, encodedBodySize, decodedBodySize }) => [new URL(name).pathname, encodedBodySize, decodedBodySize]),
            longTasks: window.frontProbe.long, heapHighBytes: window.frontProbe.heap };
        });
        if (result.controlled !== (cache === 'controlled')) throw Error('unexpected service worker controller');
        // Performance domain counters start anew on navigation.
        console.log(JSON.stringify({ device, cache, repeat: i, ...result, threadMs: end.TaskDuration * 1000, layouts: end.LayoutCount, styleUpdates: end.RecalcStyleCount, compileMs: end.V8CompileDuration * 1000 }));
        if (cache === 'cold') await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 60000 });
      }
      if (workload === 'input') {
        await page.waitForFunction(() => window.__perf?.frame?.online);
        await page.keyboard.press('Alt+Digit1');
        await page.waitForFunction(() => document.body.dataset.view === 'canvas');
        const ids = await page.evaluate(() => {
          const C = window.__canvas;
          return [0, 1, 2].map(i => C.addNode({ kind: 'term', backend: 'pty', name: `print${i}`, x: i * 410, y: 0, w: 405, h: 240, env: {} }).id as string);
        });
        await page.waitForFunction(ids => ids.every(id => {
          const b = window.__canvas.live[id]?.term?.buffer.active;
          return b && /[$#] +$/.test(b.getLine(b.baseY + b.cursorY).translateToString());
        }), ids);
        const measure = async (name: string, run: () => Promise<void>) => {
          await page.evaluate(() => { const p = window.frontProbe; p.frames = []; p.long = []; p.paints = []; p.heap = 0; });
          if (process.env.WB_BENCH_PROFILE) await cdp.send('Profiler.start');
          const a = await metrics(cdp), t = performance.now();
          await run();
          const wallMs = performance.now() - t, b = await metrics(cdp);
          if (process.env.WB_BENCH_PROFILE) writeFileSync(`${process.env.WB_BENCH_PROFILE}-${name}.cpuprofile`, JSON.stringify((await cdp.send('Profiler.stop')).profile));
          const p = await page.evaluate(() => window.frontProbe);
          console.log(JSON.stringify({ device, name, wallMs, frameMs: p.frames.length > 1 ? stats(p.frames.slice(1).map((v, j) => v - p.frames[j])) : null,
            keyMs: p.paints.length ? stats(p.paints) : null, longTasks: p.long, threadMs: (b.TaskDuration - a.TaskDuration) * 1000,
            layouts: b.LayoutCount - a.LayoutCount, styleUpdates: b.RecalcStyleCount - a.RecalcStyleCount, heapHighBytes: p.heap }));
        };
        // Probe the first display opportunity AFTER the transform or echoed xterm cell changes.
        // This includes one rAF of slack and isn't a compositor presentation timestamp.
        for (const terminal of [false, true]) {
          if (terminal) {
            await page.evaluate(id => { const C = window.__canvas; C.jumpNode(C.S.nodes[id]); }, ids[0]);
            await page.waitForTimeout(450);
            await page.evaluate(id => window.__canvas.live[id].term.focus(), ids[0]);
          } else await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
          await measure(terminal ? 'pty-key' : 'canvas-pan-key', async () => {
            for (let k = 0; k < 30; k++) {
              const key = terminal ? String.fromCharCode(97 + k % 26) : k % 2 ? 'ArrowRight' : 'ArrowLeft';
              await page.evaluate(({ terminal, id }) => {
                const world = document.getElementById('world')!, before = world.style.transform;
                const term = window.__canvas.live[id].term;
                window.addEventListener('keydown', function onKey(e) {
                  const tick = () => {
                    const b = term.buffer.active, row = b.getLine(b.baseY + b.cursorY);
                    if (terminal ? b.cursorX > 0 && row?.translateToString(false, b.cursorX - 1, b.cursorX) === e.key : world.style.transform !== before) {
                      requestAnimationFrame(() => window.frontProbe.paints.push(performance.now() - window.frontProbe.key));
                    } else requestAnimationFrame(tick);
                  };
                  requestAnimationFrame(tick);
                }, { once: true, capture: true });
              }, { terminal, id: ids[0] });
              await page.keyboard.press(key);
              try { await page.waitForFunction(k => window.frontProbe.paints.length === k + 1, k, { timeout: 5000 }); }
              catch (e) {
                const state = await page.evaluate(id => { const b = window.__canvas.live[id].term.buffer.active; return { focus: document.activeElement?.className, cursor: b.cursorX, line: b.getLine(b.baseY + b.cursorY)?.translateToString(true) }; }, ids[0]);
                throw Error(`${key} (${k}): ${JSON.stringify(state)}`, { cause: e });
              }
            }
          });
        }
        await page.keyboard.press('Control+c');
        await measure('three-pty-flood', async () => {
          await page.evaluate(ids => ids.forEach(id => window.__canvas.live[id].backend.input("seq 1 50000; printf 'end-%d\\n' 50000\r")), ids);
          await page.waitForFunction(ids => ids.every(id => {
            const b = window.__canvas.live[id].term.buffer.active;
            for (let j = Math.max(0, b.baseY + b.cursorY - 4); j <= b.baseY + b.cursorY; j++) if (b.getLine(j)?.translateToString(true) === 'end-50000') return true;
            return false;
          }), ids, { timeout: 60000 });
        });
      }
      if (workload === 'navigator') {
        await page.evaluate(() => window.__canvas.setView('ranger'));
        const rows = page.locator('#rg-cur .rg-row[data-key^="quote-"]');
        assert.deepEqual(await rows.locator('.nm').allTextContents(), Array.from({ length: 180 }, (_, j) => `quote ${j}`));
        await rows.first().click();
        if (process.env.WB_BENCH_PROFILE) await cdp.send('Profiler.start');
        const a = await metrics(cdp);
        const times: number[] = [];
        for (let k = 1; k <= 24; k++) {
          await page.keyboard.press('j');
          await page.waitForFunction(k => document.querySelector<HTMLElement>('#rg-cur .on')?.dataset.key === `quote-${k}`, k);
          times.push(await page.evaluate(() => new Promise<number>(r => requestAnimationFrame(() => r(performance.now() - window.frontProbe.key)))));
        }
        const b = await metrics(cdp);
        if (process.env.WB_BENCH_PROFILE) writeFileSync(`${process.env.WB_BENCH_PROFILE}-navigator.cpuprofile`, JSON.stringify((await cdp.send('Profiler.stop')).profile));
        console.log(JSON.stringify({ device, name: 'navigator-key', keyMs: stats(times), threadMs: (b.TaskDuration - a.TaskDuration) * 1000,
          layoutMs: (b.LayoutDuration - a.LayoutDuration) * 1000, styleMs: (b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000 }));
      }
      if (process.env.WB_BENCH_TRACE && i === 0) await ctx.tracing.stop({ path: process.env.WB_BENCH_TRACE });
    } finally { await ctx.close(); }
  }
});
