import type { Page } from 'playwright-core';

// A is still inserting when B arrives. B is still preparing its atomic replacement when C
// arrives. Observe every publication in the mounted Edwin rope, even two splices in one paint.
export async function transcriptToolVersions(page: Page) {
  await page.waitForFunction(() => {
    const b = window.__canvas.live.$agents?.backend;
    return b?.replayed && b.transcript && !b.raf && !b.changed.size && !b.transcript.painting;
  });
  return page.evaluate(async () => {
    const b = window.__canvas.live.$agents.backend, reader = b.transcript, buf: EdwinBuffer = reader.buf;
    const base = buf.rope.length - 1; // append immediately before the final empty line
    const versions = ['A', 'B', 'C'].map((v, i) => {
      // B's first field alone exceeds 128 generator steps of 64 KiB, even on a fast browser.
      const path = (v.repeat(1023) + '\n').repeat([128, 9 * 1024, 0][i]) + 'path-' + v;
      const status = ['pending', 'in_progress', 'completed'][i], rawInput = { input: v }, rawOutput = { result: v };
      const update = { sessionUpdate: i ? 'tool_call_update' : 'tool_call', toolCallId: 'n81-interleaved-tool',
        kind: 'kind-' + v, title: 'version-' + v, status, locations: [{ path, line: i + 1 }], rawInput,
        content: [{ type: 'content', content: { type: 'text', text: 'content-' + v } }], rawOutput };
      const expected = `Tool: kind-${v} [${status}] version-${v}\n  Location: ${path.replaceAll('\n', '\n  ')}:${i + 1}\n`
        + `  Input:\n  ${JSON.stringify(rawInput)}\n  Output:\n  content-${v}\n  Output:\n  ${JSON.stringify(rawOutput)}\n`;
      return { v, expected, update };
    });
    const send = (i: number) => b.ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ev',
      ev: { e: 'update', seq: b.seq + 1, ts: 1700000000000 + i, update: versions[i].update } }) }));
    const waitFor = async (what: string, ready: () => boolean) => {
      const until = performance.now() + 30000;
      while (!ready()) {
        if (performance.now() > until || b.transcript !== reader) throw Error('Did not reach ' + what);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    };
    const projection = () => buf.rope.slice(base, buf.rope.length - 1);
    const seen: string[] = [], ed = window.Ed, apply = ed.applyOps;
    ed.applyOps = function (target, ops, origin) {
      apply.call(this, target, ops, origin);
      if (target !== buf) return;
      const text = projection(), state = versions.find(x => x.expected === text)?.v
        ?? (versions[0].expected.startsWith(text) ? 'partial A' : `mixed (${text.slice(0, 36).trim()} … ${text.slice(-64).trim()})`);
      if (seen.at(-1) !== state) seen.push(state);
    };
    try {
      send(0);
      await waitFor('yielded insertion', () => seen[0] === 'partial A' && reader.painting);
      send(1);
      await waitFor('yielded replacement', () => !b.changed.size && reader.painting);
      send(2);
      await waitFor('final publication', () => !b.raf && !b.changed.size && !reader.painting);
      if (!reader.frame.root.isConnected || reader.frame.buffer !== buf || b.transcript !== reader
        || seen.join(',') !== 'partial A,A,B,C' || projection() !== versions[2].expected)
        throw Error('Expected a prefix of A, then complete tool versions A, B, C; saw ' + seen.join(' → '));
      return seen;
    } finally { ed.applyOps = apply; }
  });
}
