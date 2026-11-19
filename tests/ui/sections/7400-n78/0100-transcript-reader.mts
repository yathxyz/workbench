import { check, section, until } from '../../shared.mts';
import { acpSent, type AcpEvOf } from '../../acp.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({
  D, g, sid, cwd, ids, edwin, composer, reader, log, readerText, readerState, readUntil, liveIdle,
  open,
}: N78Fixture) {
  await section('N78 transcript reader', async () => {
    if (!edwin) return;
    // Deliver real hub frames through one selected event. This lets the reader move between chunks, not race the agent.
    const releaseThrough = async (test: (ev: AcpEvOf<'update'>) => boolean) => {
      const hit = await until(() => {
        for (const s of g.socks) {
          const i = s.buf.findIndex(m => { const f = JSON.parse(String(m)); return f.t === 'ev' && f.ev.e === 'update' && test(f.ev); });
          if (i >= 0) return { s, i };
        }
      });
      if (!hit) throw new Error('N78 expected a held ACP update');
      for (const m of hit.s.buf.splice(0, hit.i + 1)) hit.s.ws.send(m);
    };
    const input = D.locator(reader + ' .ed-input'), key = (k: string) => D.keyboard.press(k);
    await D.locator(composer).focus();
    await key('Shift+Tab');
    const tabbed = await input.evaluate(e => e === document.activeElement);
    const beforeTyping = await readerText();
    await key('i'); await D.keyboard.type('do not insert'); await key('Escape'); await key('u');
    const unchanged = beforeTyping === await readerText();
    await key('j'); await key('Enter');
    const stayed = await input.evaluate(e => e === document.activeElement) && await D.evaluate(() => window.__canvas.MESH.open === 'attach_n78_api');
    await key('Control+Space'); await key('Escape');
    const left = await D.locator('#mesh-list').evaluate(e => e === document.activeElement);
    check('N78: Shift-Tab reaches the reader; editor keys stay inside, insert and undo cannot change text, and leader Escape returns to the list',
      tabbed && unchanged && stayed && left, { tabbed, unchanged, stayed, left });

    const say = async (text: string) => { await D.fill(composer, text); await D.press(composer, 'Enter'); };
    g.hold = true;
    try {
      await say('stream');
      await releaseThrough(ev => ev.update?.content?.text === 'Streaming ');
      await readUntil('  Streaming ');
      await input.focus();
      await key('g'); await key('g'); await key('4'); await key('0'); await key('j'); await key('z'); await key('z');
      await key('v'); await key('l');
      const middle = await readerState();
      await releaseThrough(ev => ev.update?.content?.text === 'three ');
      await readUntil('  Streaming three ');
      const kept = await readerState();
      check('N78: a streamed chunk extends the message while point, mark, first visible line and focus stay put',
        middle.point > 0 && middle.point < middle.end && !!middle.first && middle.mark != null && kept.point === middle.point && kept.mark === middle.mark
        && kept.first === middle.first && kept.focused && kept.end > middle.end, { middle, kept });
      await key('Escape');
      await key('Shift+G');
      const tail = await readerState();
      await releaseThrough(ev => ev.update?.content?.text === 'chunks.');
      await readUntil('  Streaming three chunks.');
      const followed = await readerState();
      const visible = await D.locator(reader + ' .ln').allTextContents();
      check('N78: G returns to the tail and resumes following without making undo history',
        tail.point === tail.end - 1 && followed.point === followed.end - 1 && followed.end > tail.end && followed.undo === 0
        && visible.some(line => line.includes('Streaming three chunks.')), { tail, followed, visible });
    } finally { g.release(); }
    await liveIdle();

    g.hold = true;
    try {
      await say('tool');
      await releaseThrough(ev => ev.update?.sessionUpdate === 'tool_call' && ev.update?.title === 'Edit notes.txt');
      const pending = 'Tool: edit [pending] Edit notes.txt';
      await readUntil(pending);
      const prefix = (await readerText())!.split(pending)[0];
      await releaseThrough(ev => ev.update?.sessionUpdate === 'tool_call_update' && ev.update?.status === 'completed');
      await readUntil('  + BETA');
      const done = (await readerText())!;
      check('N78: a tool update replaces its heading and diff in place, without duplicating the call',
        done.startsWith(prefix + 'Tool: edit [completed] Edit notes.txt\n  Location: ' + cwd + '/notes.txt')
        && done.split('Edit notes.txt').length === 2 && done.includes('\n  - beta\n  + BETA\n'), done.slice(prefix.length));
    } finally { g.release(); }
    await liveIdle();

    await say('perm');
    await readUntil('· Permission: waiting');
    await D.locator('#mesh-detail .ag-perm button[data-kind="reject_once"]').click();
    await readUntil('· rejected: Reject');
    const idle = await liveIdle(), answered = (await readerText())!;
    check('N78: the DOM permission panel answers while the reader is mounted; waiting becomes the journal outcome',
      !!idle && !answered.includes('Permission: waiting') && acpSent(D, sid, 'permission').some(m => m.outcome.optionId === 'reject-once')
      && answered.includes('Did not run'), answered.slice(-500));

    // Use one synchronous burst through the journal reducer; do not consume the hub's replay cursor.
    const notes = Array.from({ length: 70 }, (_, i) => `reader burst ${i}`);
    await D.evaluate(notes => {
      const b = window.__canvas.live.$agents.backend;
      const update = (u: JsonObject) => b.apply({ e: 'update', update: u });
      update({ sessionUpdate: 'tool_call', toolCallId: 'reader-projection', kind: 'edit', status: 'completed', title: 'Projection', content: [
        { type: 'content', content: { type: 'text', text: 'a\r\nb\nx\rTool: fake\u0000\u001b\u007f\u2028\u2029' } },
        { type: 'diff', path: 'large.txt', oldText: 'old', newText: 'hidden oversized text\n' + 'A'.repeat(200001) },
      ] });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'reader-crlf', content: { type: 'text', text: 'split CRLF\r' } });
      for (const text of notes) b.apply({ e: 'notice', text });
      b.schedule();
    }, notes);
    await readUntil('· reader burst 69');
    const burst = (await readerText())!, prefix = answered.slice(0, -1);
    const tool = 'Tool: edit [completed] Projection\n', output = '  Output:\n  a\n  b\n  x␍Tool: fake␀␛␡\\u2028\\u2029\n';
    const summary = '  diff too large: large.txt (1 → 2 lines)\n';
    const suffix = notes.map(n => '· ' + n + '\n').join('') + '\n';
    check('N78: reader normalizes CRLF without doubling lines and displays other controls without creating a fake heading',
      burst.includes(tool + output) && !burst.split('\n').some(line => line.startsWith('Tool: fake')), burst.slice(prefix.length, prefix.length + 180));
    check('N78: an oversized diff exposes the summary but not the new file in the reader',
      burst.includes(summary + 'Assistant:') && !burst.includes('hidden oversized text'), burst.slice(prefix.length, prefix.length + 180));
    await D.evaluate(() => {
      const b = window.__canvas.live.$agents.backend;
      b.cleared = true; b.changed = new Set(b.items); b.render();
    });
    await readUntil('· reader burst 69');
    check('N78: a burst of more than 64 journal items matches a full repaint',
      burst === await readerText() && burst === prefix + tool + output + summary + 'Assistant:\n  split CRLF␍\n' + suffix,
      { length: burst.length, tail: burst.slice(-100) });

    await D.evaluate(() => {
      const b = window.__canvas.live.$agents.backend;
      b.apply({ e: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'reader-projection', title: 'Projection with a longer title' } });
      b.apply({ e: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'reader-crlf', content: { type: 'text', text: '\ncontinued' } } });
      b.schedule();
    });
    await readUntil('Projection with a longer title');
    const updated = (await readerText())!;
    check('N78: an earlier length-changing tool update preserves later items and split CRLF matches a full repaint',
      updated === prefix + tool.replace('Projection', 'Projection with a longer title') + output + summary + 'Assistant:\n  split CRLF\n  continued\n' + suffix,
      updated.slice(prefix.length, prefix.length + 240));

    await D.evaluate(() => window.L.call('kill-buffer', [window.__canvas.live.$agents.backend.transcript.buf]));
    const fallback = await until(async () => await D.locator(log).count() === 1 && (await D.locator(log).textContent())?.includes('reader burst 69'), 3000);
    check('N78: killing the reader buffer immediately restores the DOM journal with its items and original diff disclosure',
      fallback && !await D.locator(reader).count() && await D.getByRole('button', { name: 'show new text', exact: true }).count() === 1);
    await D.locator('#mesh-list').focus(); await open(ids['n78-readonly']); await open(sid); await liveIdle();
    await input.focus(); await key('Control+x'); await key('b'); await key('Enter');
    const switched = await until(async () => await D.locator(log).count() === 1 && (await D.locator(log).textContent())?.includes('n78 original conversation'), 3000);
    check('N78: switching the reader frame to another buffer restores the DOM journal without waiting for activity',
      switched && !await D.locator(reader).count());
    await D.locator('#mesh-list').focus(); await open(ids['n78-readonly']); await open(sid); await liveIdle();
  });
}
