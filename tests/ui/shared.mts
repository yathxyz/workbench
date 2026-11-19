import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright-core';

// Types only: the globals the checks set in the page, and the artifact runtime's `wb` inside artifact frames.
declare global { interface Window { __got: number; __cm: boolean[]; __rcCam: Cam; __pastes: number; __xss?: number; __n56: Element | null; __n62menus: number; __n32?: number; __xss31?: number } }
declare global { const wb: { use(name: string): Promise<any> }; }   // any: each capability's namespace has its own shape (web/bridge.ts)

export const ROOT = process.argv[2] || process.env.WB_WEB_ROOT, HARNESS = process.env.WB_HARNESS!;
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ui-'));

// Values passed from earlier sections, in filename order. The demo and daemon share one browser.
class UiState {
  browser!: Browser;
  DAY!: string;
  A!: Page;
  T!: Page;
  tid!: string | null;
  pid0: number | undefined;
  AP: Page = null!;
  AID: string = null!;
  STUB = false;
  STUCK = false;
  RECONNECT = false;
}
export const state = new UiState();

export const fails: string[] = [], skips: string[] = [];
export const check = (name: string, ok: unknown, info: unknown = ''): void => { console.log((ok ? 'ok   ' : 'FAIL ') + name, ok ? '' : info); if (!ok) fails.push(name); };
export const skip = (name: string, why: string): void => { console.log('skip ' + name + ': ' + why); skips.push(name); };
export const sleep = (ms: number): Promise<void> => new Promise<void>(r => setTimeout(r, ms));
export const until = async <T,>(f: () => T | PromiseLike<T>, ms = 10000, step = 100): Promise<T | undefined> => { const end = Date.now() + ms; for (;;) { let v: T | undefined; try { v = await f(); } catch {} if (v || Date.now() > end) return v; await sleep(step); } };

export const errors: string[] = [];
export const watchErrors = (p: import('playwright-core').Page): void => {
  p.on('pageerror', e => errors.push(String(e.stack || e)));
  p.on('console', m => { if (m.type() === 'error') { const loc = m.location(); errors.push(`console: ${m.text()}\n    at ${loc.url || p.url()}:${loc.lineNumber + 1}:${loc.columnNumber + 1}`); } });
};

// One failing step must not hide the checks after it (30 §10.1).
export async function section<T>(name: string, f: () => T) { try { return await f(); } catch (e) { check(name + ' (threw)', false, String(e?.message || e).split('\n')[0]); } }

export function sectionFiles(directory: URL): URL[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const sections = new Set(entries.filter(e => e.isFile() && /^\d{4}-.+\.mts$/.test(e.name)).map(e => e.name));
  for (const entry of entries) {
    const { name } = entry;
    if (sections.has(name) || /~$|^\.#|^\..*\.swp$/.test(name)) continue;
    if (entry.isFile() && name === 'fixtures.mts') continue;
    if (entry.isDirectory() && sections.has(name + '.mts')) continue; // steps beside their section module
    check(`unexpected section entry: ${name}`, false);
  }
  const names = [...sections].sort();
  for (let i = 1; i < names.length; i++) {
    const prefix = names[i].slice(0, 4);
    if (names[i - 1].startsWith(prefix)) check(`duplicate section prefix ${prefix}: ${names[i - 1]}, ${names[i]}`, false);
  }
  return names.map(name => new URL(encodeURIComponent(name), directory));
}

export function loadSection(file: URL) {
  return section(path.basename(fileURLToPath(file)), () => import(file.href));
}

export function shot(page: Page, name: string) {
  return page.screenshot({ path: path.join(process.env.WB_UI_SHOTS || TMP, name + '.png') });
}
