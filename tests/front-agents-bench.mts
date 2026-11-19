// bash tests/run-front-bench.sh front-agents-bench.mts [phone|desktop]
// Fresh harness, real /v1/events -> /rpc -> Agents DOM. WB_BENCH_ROOT selects an alternate web root.
// The runner enters a private netns; harness.py rejects WB_HARNESS_TCP on a shared network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { metrics, stats, withBoard } from './front-browser.mts';

const roots = 240, rows = roots + roots / 5, waves = 8, burst = 24;
const devices = process.argv[2] ? [process.argv[2]] : ['phone', 'desktop'];
const round = (n: number) => Math.round(n * 10) / 10;
const timings = (values: number[]) => Object.fromEntries(Object.entries(stats(values)).map(([k, v]) => [k, round(v)]));

for (const device of devices) {
  assert.ok(['phone', 'desktop'].includes(device));
  const phone = device === 'phone', viewport = phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  await withBoard(async (browser, info) => {
    const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1, serviceWorkers: 'block' });
    const tokens = [info.apiTokenFiles.near, info.apiTokenFiles.far].map(f => fs.readFileSync(f, 'utf8').trim());
    const sid = (i: number) => `agents-bench-${i}`;
    const report = async (i: number, payload: Record<string, unknown>) => {
      const repo = `project-${i % 12}`;
      const res = await fetch(info.api + '/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[i % 2], 'Content-Type': 'application/json' },
        body: JSON.stringify({ harness: 'pi', repo, worktree: 'wt-' + i, branch: 'topic/' + i, payload: { session_id: sid(i), cwd: '/src/' + repo, ...payload } }) });
      assert.equal(res.status, 204, await res.text());
    };
    for (let i = 0; i < roots; ++i) {
      await report(i, { kind: 'prompt', text: `Inspect ${i}` });
      if (!(i % 5)) await report(i, { kind: 'subagent_start', agent_id: 'scout', agent_type: 'explorer' });
    }
    const p = await ctx.newPage(), cdp = await ctx.newCDPSession(p), errors: string[] = [];
    p.on('pageerror', e => errors.push(e.message));
    let rpcBytes = 0, rpcFrames = 0;
    p.on('websocket', ws => { if (ws.url().endsWith('/rpc')) ws.on('framereceived', f => { rpcBytes += Buffer.byteLength(f.payload); rpcFrames++; }); });
    const cpuRate = phone ? 4 : 1;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    await cdp.send('Performance.enable', { timeDomain: 'threadTicks' }); await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await p.goto(info.caddy); await p.waitForFunction(n => window.__canvas?.BOOTED && Object.keys(window.__canvas.OBS).length === n, rows);
    await p.evaluate(() => document.fonts.ready.then(() => true));
    await p.waitForFunction(n => document.querySelector('#st-host')!.textContent!.includes('mesh ' + n) && !window.__canvas.unsaved(), rows);
    // Let the initial RPC snapshot's 250ms coalesced render finish outside the first view switch.
    await p.waitForTimeout(500);
    const probe = await p.evaluateHandle(() => {
      const list = document.querySelector('#mesh-list')!;
      let frames: number[] = [], attrs = 0, childLists = 0, adds = 0, drops = 0, last = 0, raf = 0;
      let longTasks: number[] = [];
      const tasks = new PerformanceObserver(entries => { for (const e of entries.getEntries()) longTasks.push(e.duration); });
      const tick = (t: number) => { if (last) frames.push(t - last); last = t; raf = requestAnimationFrame(tick); };
      const obs = new MutationObserver(records => {
        for (const r of records) {
          if (r.type === 'attributes') attrs++;
          else { childLists++; adds += r.addedNodes.length; drops += r.removedNodes.length; }
        }
      });
      return {
        start() {
          last = 0; frames = []; longTasks = []; tasks.observe({ type: 'longtask' });
          return new Promise<void>(r => requestAnimationFrame(t => { tick(t); r(); }));
        },
        stop() {
          cancelAnimationFrame(raf); longTasks.push(...tasks.takeRecords().map(e => e.duration)); tasks.disconnect();
          return { frames, longTasks };
        },
        watchDom() { attrs = childLists = adds = drops = 0; obs.observe(list, { attributes: true, childList: true, subtree: true }); },
        dom() { obs.disconnect(); return { attrs, childLists, adds, drops }; },
      };
    });
    const painted = () => p.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const measure = async (phase: string, fn: () => Promise<void>) => {
      await cdp.send('Profiler.start'); await probe.evaluate(o => o.start()); const before = await metrics(cdp), t = performance.now();
      const bytes = rpcBytes, messages = rpcFrames;
      await fn(); await painted();
      const wallMs = round(performance.now() - t), after = await metrics(cdp);
      const { frames, longTasks } = await probe.evaluate(o => o.stop());
      const { profile } = await cdp.send('Profiler.stop');
      const funcs = new Map(profile.nodes.map(n => [n.id, n.callFrame])), self = new Map<string, number>();
      profile.samples?.forEach((s, i) => { const f = funcs.get(s)!; if (f.url.endsWith('/app.js')) { const name = (f.functionName || '(anonymous)') + ':' + (f.lineNumber + 1); self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000); } });
      const cpuMs = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(k => [k, round(1000 * (after[k] - before[k]))]));
      console.log(JSON.stringify({ device, viewport, cpuRate, phase, rows, wallMs, cpuMs, frameGapMs: timings(frames),
        longTasks: longTasks.length, longTaskMs: round(longTasks.reduce((a, b) => a + b, 0)), heapUsedBytes: after.JSHeapUsedSize,
        rpcBytes: rpcBytes - bytes, rpcFrames: rpcFrames - messages,
        topAppSelfMs: [...self].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, round(v)]) }));
    };
    const open = () => p.evaluate(() => window.__canvas.meshOpen());
    await measure('cold-open', open);
    assert.equal(await p.locator('#mesh-list .mesh-row').count(), rows);
    assert.equal(await p.locator('#mesh-list .mesh-row[data-depth="1"]').count(), roots / 5);
    assert.equal(await p.locator('#mesh-list .mesh-group').count(), 12);
    await p.evaluate(() => window.__canvas.setView('canvas')); await painted();
    await measure('warm-open', open);
    const selected = await p.locator('#mesh-list .mesh-row.on').elementHandle();
    const ids = await p.evaluate(() => Object.fromEntries(Object.values<ObservedSession>(window.__canvas.OBS).filter(o => !o.parent).map(o => [o.sessionId, o.id])));
    const wave = async (w: number) => {
      const t = performance.now(), marker = `wave-${w}/`, first = burst * w;
      for (let j = first; j < first + burst; ++j) await report(j, { kind: 'tool_start', tool: { name: 'read', input: { path: marker + j } } });
      const last = first + burst - 1;
      await p.waitForFunction(({ id, text }) => document.querySelector(`#mesh-list [data-id="${id}"] .mesh-doing`)!.textContent!.endsWith(text), { id: ids[sid(last)], text: marker + last });
      await painted(); return performance.now() - t;
    };
    const latencies: number[] = [];
    await measure('live-updates', async () => {
      for (let w = 0; w < waves; w++) latencies.push(await wave(w));
    });
    assert.ok(await selected!.evaluate(e => e === document.querySelector('#mesh-list .mesh-row.on')));
    const changed = await p.locator('#mesh-list .mesh-doing').allTextContents();
    for (let i = 0; i < waves * burst; i++) assert.ok(changed.some(s => s.endsWith('wave-' + Math.floor(i / burst) + '/' + i)));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ device, phase: 'report-to-frame', waves, reportsPerWave: burst, latencyMs: timings(latencies) }));
    // Count writes in separate warm-open and report samples: recording thousands of MutationRecords
    // on the old page would inflate the CPU and frame-time savings measured above.
    await p.evaluate(() => window.__canvas.setView('canvas')); await painted();
    await probe.evaluate(o => o.watchDom()); await open(); await painted();
    const warmOpen = await probe.evaluate(o => o.dom());
    await probe.evaluate(o => o.watchDom()); await wave(waves);
    console.log(JSON.stringify({ device, phase: 'dom-work', rows, reportsPerWave: burst, warmOpen, oneWave: await probe.evaluate(o => o.dom()) }));
    await ctx.close();
  }, ['--api']);
}
