// Load Edwin's core in Node with no browser, feed it keys, and read the buffers back.
//
// The core runs on the Node host (src/host-node.js), the same one edwind uses: no document, window or
// localStorage exists in this process, so any page access left in the core fails here (R4.1).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { FILES, createHost, loadEdwin, memoryStorage } = require('../src/host-node.js');

// Load and boot Edwin (once per process: it keeps its state in globals) and give back a driver.
export async function startEdwin(opts = {}) {
  const host = createHost(opts);
  const Ed = loadEdwin(host);
  Ed.boot({ host });
  await Ed.whenIdle();
  const feed = async keys => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
  return {
    Ed, E: Ed.E, host, L: globalThis.L,
    keys: s => feed(Ed.kbd(s).split(' ')),
    type: s => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch))),
    // Evaluate Scheme source in the image and give back the last value.
    eval: src => { globalThis.L.resetOps(); return globalThis.L.evalText(src); },
    text: () => Ed.E.current.text,
    point: () => Ed.E.current.pt,
  };
}
