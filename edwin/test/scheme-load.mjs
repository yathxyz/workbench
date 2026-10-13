// Load Edwin's Scheme (src/scheme.js) into Node by itself, with no page stand-ins.
//
// loadScheme() runs it in this context (vm.runInThisContext), as the editor does, and returns the
// Scheme object; loadSchemeIn(source, globals) runs a source text in a fresh context (the benchmark
// loads several evaluators side by side that way).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEME_FILE = join(ROOT, 'src', 'scheme.js');

// The evaluator modes a suite runs in: 'direct' (the closure compiler) today; E2 adds a generator mode.
export const MODES = ['direct'];
export const MODE = process.env.EDWIN_SCHEME_MODE || 'direct';

export function loadScheme(mode = MODE) {
  if (!MODES.includes(mode)) throw new Error('unknown Scheme evaluator mode: ' + mode);
  vm.runInThisContext(readFileSync(SCHEME_FILE, 'utf8'), { filename: 'scheme.js' });
  return globalThis.Scheme;
}

export function loadSchemeIn(source, globals = {}) {
  const sandbox = { performance, TextEncoder, console, ...globals };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'scheme.js' });
  return sandbox.Scheme;
}
