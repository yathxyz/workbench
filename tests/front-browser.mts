import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Browser, CDPSession } from 'playwright-core';

interface BoardInfo { caddy: string; host: string; webPid: number }
interface MeshInfo extends BoardInfo { api: string; apiTokenFiles: { near: string; far: string } }
export function withBoard(run: (browser: Browser, info: MeshInfo) => Promise<void>, args: ['--api']): Promise<void>;
export function withBoard(run: (browser: Browser, info: BoardInfo) => Promise<void>): Promise<void>;
export async function withBoard(run: (browser: Browser, info: MeshInfo) => Promise<void>, args: string[] = []) {
  const { chromium } = await import(process.env.WB_PLAYWRIGHT!) as typeof import('playwright-core');
  const h = spawn('python3', ['-I', process.env.WB_HARNESS!, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exit = once(h, 'close');
  try {
    const [line] = await Promise.race([once(createInterface({ input: h.stdout }), 'line'), exit.then(([code]) => { throw Error(`harness exited (${code})`); })]);
    const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
    try { await run(browser, JSON.parse(line)); } finally { await browser.close(); }
  } finally { h.stdin.end(); await exit; }
}

export function stats(xs: number[]) {
  if (!xs.length) throw Error('no timing samples');
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.ceil(p * xs.length) - 1];
  return { n: xs.length, min: sorted[0], p50: q(.5), p95: q(.95), p99: q(.99), max: sorted.at(-1)! };
}
export async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
}
