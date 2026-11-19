import type { Page } from 'playwright-core';
import { check } from './shared.mts';

// Deliver journal records to the disposable viewer, with input between two real projection batches.
export async function foldRegressions(page: Page) {
  const results = await page.evaluate(async () => {
    const b = window.__canvas.live.$agents.backend, r = b.transcript, buf: EdwinBuffer = r.buf, ed = window.Ed;
    const get = () => ed.getBufferFolds!(buf), set = (ranges: { s: number; e: number }[]) => ed.setBufferFolds!(buf, ranges);
    const text = (s: string) => ({ type: 'text', text: s });
    let seq = b.seq;
    type Body<E> = E extends JournalEvent ? Omit<E, 'ts' | 'seq'> : never;
    const send = (body: Body<JournalEvent>) => b.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ev', ev: { ...body, seq: ++seq, ts: seq } }) }));
    const prompt = (s: string) => send({ e: 'prompt', prompt: [text(s)] });
    const msg = (s: string, id = 'probe-tail') => send({ e: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: id, content: text(s) } });
    const tool = (s: string) => send({ e: 'update', update: { sessionUpdate: 'tool_call', title: s, toolCallId: s, rawOutput: s + '\noutput' } });
    const fill = (id: string) => {
      for (let i = 0; i < 150; i++) {
        prompt(id + i); tool(id + i);
        send({ e: 'update', update: { sessionUpdate: 'agent_thought_chunk', messageId: 'think', content: text('thinking') } });
      }
    };
    const drain = async () => { while (b.changed.size || r.painting) await new Promise(requestAnimationFrame); };
    const headers = () => { const t = buf.text; return get().map(({ s }) => t.slice(t.lastIndexOf('\n', s - 1) + 1, s)); };
    fill('bulk-close-'); b.render(); const queued = b.changed.size > 0;
    r.navigate('fold-all', true); prompt('later-open'); tool('later-tool'); await drain();
    const closed = headers();
    fill('bulk-open-'); b.render(); const queuedOpen = b.changed.size > 0;
    r.navigate('fold-all', false); tool('later-default'); await drain();
    const opened = headers();
    // Foreign pairs are valid editor folds but not journal sections. Exercise both dimensions of equality.
    msg('\nforeign header\nforeign body\nend foreign', 'foreign'); tool('exact-A'); tool('exact-B'); await drain();
    const t = buf.text, foreign = { s: t.indexOf('\n  foreign body'), e: t.indexOf('\n  end foreign') };
    const a = get().find(f => t.slice(0, f.s).endsWith('exact-A'))!, z = get().find(f => t.slice(0, f.s).endsWith('exact-B'))!;
    const reset = () => { for (const f of [a, z]) { r.frame.setPoint(f.s); r.navigate('fold', true); } };
    const afterCommand = () => ed.hooks.postCommand!('n81-fold-command', buf, false);
    const test = async (ranges: typeof a[], delayed = false) => {
      reset(); set(ranges);
      // A command may update Edwin before its promise completes and its post-command hook runs.
      const command = Promise.resolve().then(afterCommand);
      if (!delayed) await command;
      msg('.'); b.render();
      await command;
      return get().filter(f => f.s === a.s || f.s === z.s).map(f => f.s === a.s ? 'A' : 'B').join('');
    };
    // Keep the unrelated earlier fold in each list so removing/replacing one semantic pair can preserve the count.
    const earlier = get().filter(f => f.s < foreign.s);
    const extra = await test([...earlier, foreign, a, z]), substitute = await test([...earlier, foreign, z]);
    const short = { s: a.s, e: t.indexOf('\n', a.s + 1) };
    const changedEnd = await test([...earlier, short, z]), pending = await test([...earlier, z], true);
    reset();
    const setter = ed.setBufferFolds!, warn = console.warn; let warnings = 0;
    try {
      ed.setBufferFolds = (buffer, folds) => { if (buffer === buf && folds.length) throw new RangeError('N81 rejected fold list'); setter(buffer, folds); };
      console.warn = (...args) => { warnings++; warn(...args); };
      msg('first rejected'); b.render(); msg('second rejected'); b.render();
    } finally { ed.setBufferFolds = setter; console.warn = warn; }
    const survived = b.transcript === r && buf.text.includes('second rejected') && !get().length;
    msg('next paint'); b.render();
    return { close: queued && closed.filter(s => s.startsWith('Prompt: bulk-close-')).length === 150 && !closed.includes('Prompt: later-open') && closed.some(s => s.endsWith('later-tool')),
      open: queuedOpen && !opened.some(s => s.includes('bulk-open-') || s === 'Thinking:') && opened.some(s => s.endsWith('later-default')),
      extra, substitute, changedEnd, pending, recovered: survived && warnings === 1 && b.transcript === r && headers().some(s => s.endsWith('exact-A')) };
  });
  check('N81: close all includes received but unpainted turns and excludes future turns', results.close);
  check('N81: open all includes received but unpainted tools and thoughts and excludes future tools', results.open);
  check('N81: a foreign range before two installed ranges opens neither', results.extra === 'AB', results.extra);
  check('N81: an equal-count substitution opens only the missing journal fold', results.substitute === 'B', results.substitute);
  check('N81: a range with the right header but a different end is not the journal fold', results.changedEnd === 'B', results.changedEnd);
  check('N81: a native open before an async command completes survives an intervening paint', results.pending === 'B', results.pending);
  check('N81: rejected fold publications warn once, preserve the reader and retry on the next paint', results.recovered);
}
