// Load Edwin's core in Node with no browser, feed it keys, and read the buffers back.
//
// The core runs on the Node host (src/host-node.cts), the same one edwind uses: no document, window or
// localStorage exists in this process, so any page access left in the core fails here (R4.1).
import { createRequire } from 'node:module';

export type Edwin = any; // any: Edwin's core (Ed, E, L) is outside this program's types (edwin/src)

/* The host's key-value store (memoryStorage, or edwind's file store). */
export interface HostStorage { get(k: string): string | null; set(k: string, v: unknown): boolean; remove(k: string): void; keys(): string[] }
export interface HostOptions { scmDir?: string; configDir?: string | null; storage?: HostStorage; workers?: boolean }
/* The page stand-ins of the Node host: attributes and CSS variables in maps, no styles, no events. */
export interface HostPage {
  getAttr(name: string): unknown;
  setAttr(name: string, v: unknown): void;
  getVar(name: string): string;
  setVar(name: string, v: unknown): void;
  prefersDark(): boolean;
  addStyle(id: string, css: string): void;
  onResize(f: () => void): void;
  onMedia(f: () => void): void;
  onFontsLoaded(f: () => void): void;
}
/* The named jobs of server/jobs.mts for the main thread. */
export interface HostJobs { fns: Map<string, (...args: any[]) => unknown>; localOnly: Set<string> } // any: a job's arguments are whatever the pool passes it
/* What src/host-node.cts createHost gives back (R4.1). */
export interface NodeHost {
  kind: 'node';
  headless: true;
  storage: HostStorage;
  config(name: string): string | null;
  userConfig(name: string): string | null;
  readFile(p: string): string | null;
  loadPath: string[];
  page: HostPage;
  onSuspend(f: () => void): void;
  suspend(): void;
  whenLoaded(f: () => void): void;
  clipboard: string;
  setClipboard(s: string): void;
  openUrl(url?: string): boolean;
  onCspViolation(f?: unknown): void;
  idle(f: () => void): unknown;
  nextFrame(f: () => void): unknown;
  workers: boolean;
  workersUnavailable: string | null;
  workerCount: number;
  jobs: HostJobs | null;
  makeWorker(data: unknown): unknown;
}
interface HostNode {
  FILES: string[];
  createHost(opts?: HostOptions): NodeHost;
  loadEdwin(host?: NodeHost, opts?: { mode?: 'direct' | 'gen' }): Edwin;
  memoryStorage(map?: Map<string, string>): HostStorage;
  coreSource(f: string, dir?: string): { text: string; filename: string };
}
/* The driver startEdwin gives back. */
export interface HeadlessEdwin {
  Ed: Edwin;
  E: Edwin;
  host: NodeHost;
  L: Edwin;
  keys(s: string): Promise<void>;
  type(s: string): Promise<void>;
  eval(src: string): Edwin;
  text(): string;
  point(): number;
}
interface EdwinGlobals { L: Edwin }

const require = createRequire(import.meta.url);
export const { FILES, createHost, loadEdwin, memoryStorage, coreSource } = require('../src/host-node.cts') as HostNode;

// Load and boot Edwin (once per process: it keeps its state in globals) and give back a driver.
export async function startEdwin(opts: HostOptions = {}): Promise<HeadlessEdwin> {
  const host = createHost(opts);
  const Ed = loadEdwin(host);
  Ed.boot({ host });
  await Ed.whenIdle();
  const feed = async (keys: string[]) => { for (const k of keys) Ed.feedKey(k); await Ed.whenIdle(); };
  return {
    Ed, E: Ed.E, host, L: (globalThis as unknown as EdwinGlobals).L,
    keys: (s: string) => feed(Ed.kbd(s).split(' ')),
    type: (s: string) => feed([...s].map(ch => (ch === ' ' ? 'SPC' : ch === '\n' ? 'RET' : ch))),
    // Evaluate Scheme source in the image and give back the last value.
    eval: (src: string) => { (globalThis as unknown as EdwinGlobals).L.resetOps(); return (globalThis as unknown as EdwinGlobals).L.evalText(src); },
    text: () => Ed.E.current.text,
    point: () => Ed.E.current.pt,
  };
}
