// N81 cost probes: bash tests/run-front-bench.sh ui/transcript-cost.mts [--folds-only | --large-only]
// The timed inputs enter the real reader socket; no fixture journal or benchmark traffic goes to the hub.
import fs from 'node:fs';
import os from 'node:os';
import type { Page } from 'playwright-core';
import { stats, withBoard } from '../front-browser.mts';

async function foldCosts(page: Page) {
  const fixture = await page.evaluateHandle(() => {
    const b = window.__canvas.live.$agents.backend, r = b.transcript, buf: EdwinBuffer = r.buf;
    const folds = () => window.Ed.getBufferFolds!(buf);
    const raf = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    async function drain() {
      const until = performance.now() + 60000;
      do { await raf(); if (b.transcript !== r || performance.now() > until) throw Error('Fold fixture did not paint'); }
      while (b.raf || b.changed.size || r.painting);
    }
    type Body<E = JournalEvent> = E extends JournalEvent ? Omit<E, 'seq' | 'ts'> : never;
    function send(body: Body) {
      b.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ev', ev: { ...body, seq: b.seq + 1, ts: 1700000000000 } }) }));
    }
    const update = (u: JsonObject) => send({ e: 'update', update: u });
    const text = (s: string) => ({ type: 'text', text: s });
    const prompt = () => send({ e: 'prompt', prompt: [text('cost prompt')] });
    let i = 0;
    const tool = (s: string) => update({ sessionUpdate: 'tool_call', toolCallId: 'cost-' + i++, title: 'cost', kind: 'read', status: 'completed',
      content: [{ type: 'content', content: text(s) }] });
    const append = () => update({ sessionUpdate: 'agent_message_chunk', messageId: 'tail', content: text('x') });
    function counts(sections: number) {
      const closed = folds().length;
      if (closed !== sections / 2 || r.sections.length !== sections || !r.frame.root.querySelector('.ln'))
        throw Error(`Need ${sections} sections, half closed, in mounted Edwin; got ${r.sections.length}/${closed}`);
      return closed;
    }
    return {
      async grow(toPairs: number) {
        // Prompt/tool pairs really have half their sections closed. No invented ranges or preferences.
        for (; i < toPairs;) { prompt(); tool('short'); if (!(i % 128)) await raf(); }
        await drain(); r.frame.setPoint(0); await raf();
      },
      async costs(sections: number) {
        const closed = counts(sections), pub = r.publishFolds, publish: number[] = [], read: number[] = [];
        let ms = 0;
        r.publishFolds = function (...args: unknown[]) {
          const t = performance.now(); try { return Reflect.apply(pub, r, args); } finally { ms += performance.now() - t; }
        };
        try {
          for (let n = 0; n < 26; n++) {
            // Each publication follows an actual rope edit; a no-op setter on an unchanged buffer isn't an append.
            ms = 0; const before = buf.rope.length; append(); await drain();
            if (buf.rope.length <= before) throw Error('Append did not edit Edwin');
            const t = performance.now();
            for (let j = 0; j < 32; j++) r.readFolds(); // unchanged editor, as after movement; amortize timer resolution
            if (n >= 5) { publish.push(ms); read.push((performance.now() - t) / 32); }
          }
        } finally { delete r.publishFolds; }
        counts(sections); return { sections, closed, publish, read };
      },
      async lookback() {
        // At the 17th 64 KiB paint, exactly 1 MiB follows the last newline. The sentry at EOF is AFTER the splice.
        prompt(); await drain();
        const block = 65536, line = 1024 * 1024, base = buf.rope.length, rope = buf.rope;
        const head = 'Tool: read [completed] cost\n  Output:\n  ';
        const body = 'a'.repeat(block - head.length - 1) + '\n' + 'x'.repeat(line + 10);
        const boundary = base + block + line, newline = base - 1 + block - 1;
        const render = r.render, publish = r.publishFolds, find = rope.lastIndexOf;
        let inside = false, scanMs = 0, scanCalls = 0, scanDistance = 0, pubMs = 0;
        let partMs = 0, partCalls = 0, partChars = 0;
        type Sample = { renderMs: number; publishMs: number; scanMs: number; scanCalls: number; scanDistance: number; partMs: number; partCalls: number; partChars: number; appended: number; lastLine: number; closed: number };
        const samples: Sample[] = [];
        rope.lastIndexOf = function (s, at) {
          if (!inside || s !== '\n' || at === undefined) return find.call(this, s, at);
          const t = performance.now(), found = find.call(this, s, at);
          scanMs += performance.now() - t; scanCalls++; scanDistance = Math.max(scanDistance, at - found); return found;
        };
        r.publishFolds = function (...args: unknown[]) {
          const t = performance.now(); inside = true;
          try { return Reflect.apply(publish, r, args); } finally { inside = false; pubMs += performance.now() - t; }
        };
        r.render = function (...args: unknown[]) {
          scanMs = scanCalls = scanDistance = pubMs = 0;
          const before = rope.length, target = before + block === boundary, lastIndexOf = String.prototype.lastIndexOf;
          // The indexed path searches just the appended string before publishing; the old path
          // searches backwards in the rope during publication. Time the originals separately.
          if (target) String.prototype.lastIndexOf = function (s, at) {
            if (inside || s !== '\n' || at !== undefined || this.length > block || this[0] !== 'x' || this[this.length - 1] !== 'x') return lastIndexOf.call(this, s, at);
            const t = performance.now(), found = lastIndexOf.call(this, s);
            partMs += performance.now() - t; partCalls++; partChars += this.length; return found;
          };
          const t = performance.now(); let value;
          try { value = Reflect.apply(render, r, args); } finally { if (target) String.prototype.lastIndexOf = lastIndexOf; }
          const renderMs = performance.now() - t;
          if (rope.length === boundary && !samples.length) {
            const e = rope.length - 2;  // final projected code unit, not the editor's tail sentry
            if (find.call(rope, '\n', e) !== newline || e - newline !== line) throw Error('Wrong look-back distance');
            samples.push({ renderMs, publishMs: pubMs, scanMs, scanCalls, scanDistance, partMs, partCalls, partChars, appended: rope.length - before, lastLine: e - newline, closed: counts(12800) });
          }
          return value;
        };
        try { tool(body); await drain(); } finally { delete r.render; delete r.publishFolds; Reflect.deleteProperty(rope, 'lastIndexOf'); }
        if (samples.length !== 1) throw Error('Missing 1 MiB unterminated append');
        return samples[0];
      },
    };
  });
  try {
    const measure = async (n: number) => {
      const { sections, closed, publish, read } = await fixture.evaluate((f, n) => f.costs(n), n);
      return { sections, closed, publishMs: stats(publish), readMs: stats(read) };
    };
    await fixture.evaluate(f => f.grow(640)); const small = await measure(1280);
    await fixture.evaluate(f => f.grow(6399)); const lookback = await fixture.evaluate(f => f.lookback());
    return { small, large: await measure(12800), lookback };
  } finally { await fixture.dispose(); }
}

// Permanent check: one actual 4 MiB event per phase. Never gate on milliseconds; compare every
// projected code unit (outside the timed task), not just the rope length or the reducer's model.
// Standalone enables tracing to include JSON decode, projection, native editor and display tasks.
export async function largeReplacement(page: Page, trace = false) {
  const sid = await page.evaluate(() => window.__canvas.live.$agents.backend.n.id as string);
  await page.evaluate(() => window.__canvas.setView('canvas'));
  await page.evaluate(id => window.__canvas.meshOpen(id), sid);
  await page.waitForFunction(() => {
    const b = window.__canvas.live.$agents?.backend;
    return b?.replayed && b.transcript && !b.raf && !b.changed.size && !b.transcript.painting;
  });
  const fixture = await page.evaluateHandle(async trace => {
    const b = window.__canvas.live.$agents.backend, reader = b.transcript, buf: EdwinBuffer = reader.buf;
    // Keep both revisions reading the same visible prompt/header, rather than letting the old
    // editor scroll the empty EOF sentry to the top of the window with no output row in view.
    const raf = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    b.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ev', ev: { e: 'prompt', seq: b.seq + 1,
      ts: 1700000000000, prompt: [{ type: 'text', text: 'N81 large output' }] } }) }));
    await raf(); reader.frame.setPoint(0); await raf(); await raf();
    const lines = 32768, bytes = 4 * 1024 * 1024, base = buf.rope.length - 1;
    const head = 'Tool: read [completed] N81 replacement\n  Output:\n  ';
    const row = (ch: string) => ch.repeat(127) + '\n';
    const frames = ['A', 'B'].map((ch, i) => {
      const body = row(ch).repeat(lines);
      if (body.length !== bytes) throw Error('Expected exactly 4 MiB ASCII content');
      const update = { sessionUpdate: i ? 'tool_call_update' : 'tool_call', toolCallId: 'n81-large-body',
        ...(i ? {} : { kind: 'read', title: 'N81 replacement', status: 'completed' }), content: [{ type: 'content', content: { type: 'text', text: body } }] };
      return JSON.stringify({ t: 'ev', ev: { e: 'update', seq: b.seq + 1 + i, ts: 1700000000000 + i, update } });
    });
    return {
      async run(i: number) {
        let edits = 0, maxInsert = 0, maxRemove = 0, projectionFrames = 0, maxProjectionMs = 0;
        let renderStart = 0, firstBeforeOpsMs = 0;
        const Ed = window.Ed, apply = Ed.applyOps, render = reader.render;
        Ed.applyOps = function (edited, ops, origin) {
          if (edited === buf && !edits) firstBeforeOpsMs = performance.now() - renderStart;
          if (edited === buf) for (const [, remove, insert] of ops as [number, number, string][]) {
            edits++; maxInsert = Math.max(maxInsert, insert.length); maxRemove = Math.max(maxRemove, remove);
          }
          return apply.call(this, edited, ops, origin);
        };
        reader.render = function (...args: unknown[]) {
          if (trace) performance.mark(`n81-body-render-${i}-${projectionFrames + 1}`);
          renderStart = performance.now(); const before = edits, value = Reflect.apply(render, reader, args);
          if (edits !== before) { projectionFrames++; maxProjectionMs = Math.max(maxProjectionMs, performance.now() - renderStart); }
          return value;
        };
        try {
          performance.mark('n81-body-start-' + i);
          b.ws.dispatchEvent(new MessageEvent('message', { data: frames[i] }));
          const end = performance.now() + 60000;
          do {
            await raf();
            if (b.transcript !== reader || performance.now() > end) throw Error('Large tool did not paint in Edwin');
          } while (b.raf || b.changed.size || reader.painting);
          await raf(); await raf(); // include scheduled native display work, even when the edited body stays folded
          performance.mark('n81-body-done-' + i);
          return { bytes, edits, maxInsert, maxRemove, projectionFrames, firstBeforeOpsMs, maxProjectionMs };
        } finally { Ed.applyOps = apply; delete reader.render; }
      },
      verify(i: number) {
        const rope = buf.rope, ch = i ? 'B' : 'A', group = (row(ch) + '  ').repeat(256);
        let at = base + head.length;
        if (rope.slice(base, at) !== head) throw Error('Missing native tool header');
        for (let k = 0; k < lines; k += 256, at += group.length) {
          if (rope.slice(at, at + group.length) !== group) throw Error(`Wrong ${ch} bytes at output line ${k}`);
        }
        if (rope.slice(at, at + 2) !== '\n\n' || at + 2 !== rope.length) throw Error('Unexpected projected length');
        const rows: NodeListOf<HTMLElement> = reader.frame.root.querySelectorAll('.ln');
        if (![...rows].some(r => r.textContent?.includes('N81 replacement') || r.textContent?.includes(ch.repeat(64))))
          throw Error(`Tool not displayed: ${rows.length} rows, point ${reader.frame.point()}/${rope.length}, first/last row lengths ${rows[0]?.textContent?.length}/${rows[rows.length - 1]?.textContent?.length}`);
        return rope.length - base;
      },
    };
  }, trace);
  type Trace = { name: string; pid: number; tid: number; ts: number; dur: number; tdur: number };
  const events: Trace[] = [], cdp = trace ? await page.context().newCDPSession(page) : null;
  try {
    if (cdp) {
      cdp.on('Tracing.dataCollected', ({ value }) => {
        for (const e of value) if ((e.name === 'RunTask' || e.name === 'FireAnimationFrame' || /GC|^Layout$|^Paint$/.test(e.name)) && e.ph === 'X' || e.name.startsWith('n81-body-'))
          events.push({ name: e.name, pid: Number(e.pid), tid: Number(e.tid), ts: Number(e.ts), dur: Number(e.dur), tdur: Number(e.tdur) });
      });
      await cdp.send('Tracing.start', { categories: 'toplevel,devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing', transferMode: 'ReportEvents' });
    }
    const run = async (i: number) => ({
      ...await fixture.evaluate((f, i) => f.run(i), i), projected: await fixture.evaluate((f, i) => f.verify(i), i),
    });
    const onset = await run(0), update = await run(1);
    if (!onset.edits || !update.edits || onset.projected !== update.projected) throw Error('Expected an equal-length Edwin replacement');
    if (cdp) {
      const done = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()));
      await cdp.send('Tracing.end'); await done;
    }
    const longest = (i: number) => {
      if (!cdp) return null;
      const start = events.find(e => e.name === 'n81-body-start-' + i), end = events.find(e => e.name === 'n81-body-done-' + i);
      if (!start || !end) throw Error('Missing large-tool trace boundaries');
      const thread = events.filter(e => e.pid === start.pid && e.tid === start.tid);
      const tasks = thread.filter(e => e.name === 'RunTask' && e.ts < end.ts && e.ts + e.dur > start.ts);
      if (!tasks.length) throw Error('Missing renderer-main RunTask samples');
      const worst = tasks.reduce((a, b) => a.dur > b.dur ? a : b), stop = worst.ts + worst.dur;
      const inner = thread.filter(e => e !== worst && e.ts >= worst.ts && e.ts <= stop);
      return { longestTaskMs: worst.dur / 1000, threadMs: Number.isFinite(worst.tdur) ? worst.tdur / 1000 : null,
        render: inner.find(e => e.name.startsWith(`n81-body-render-${i}-`))?.name ?? null,
        inside: inner.filter(e => e.dur && e.ts + e.dur <= stop).sort((a, b) => b.dur - a.dur).slice(0, 3).map(e => [e.name, e.dur / 1000]) };
    };
    return { onset: { ...onset, ...longest(0) }, update: { ...update, ...longest(1) } };
  } finally { await cdp?.detach(); await fixture.dispose(); }
}

if (import.meta.main) {
  const devices = fs.readFileSync('/proc/self/net/dev', 'utf8').trimEnd().split('\n').slice(2);
  if (process.env.WB_HARNESS_TCP !== '1' || devices.length !== 1 || !/^\s*lo:/.test(devices[0])) throw Error('Use tests/run-front-bench.sh in private loopback');
  await withBoard(async (browser, info) => {
    const sid = 'n81_cost', resp = await fetch(info.api + '/v1/sessions', { method: 'POST', headers: {
      Authorization: 'Bearer ' + fs.readFileSync(info.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json',
    }, body: JSON.stringify({ sid, agent: 'stub', cwd: os.tmpdir() }) });
    if (!resp.ok) throw Error('Private stub session: HTTP ' + resp.status);
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
    await page.goto(info.caddy);
    await page.waitForFunction(id => window.__canvas?.FR.online && window.__canvas?.SESS[id]?.acp?.activity === 'none', sid);
    await page.evaluate(id => window.__canvas.meshOpen(id), sid);
    await page.waitForFunction(() => window.__canvas.live.$agents?.backend.replayed && window.__canvas.live.$agents.backend.transcript);
    if (!process.argv.includes('--large-only')) console.log(JSON.stringify({ chromium: browser.version(), folds: await foldCosts(page) }));
    if (!process.argv.includes('--folds-only')) console.log(JSON.stringify({ chromium: browser.version(), body: await largeReplacement(page, true) }));
  }, ['--api']);
}
