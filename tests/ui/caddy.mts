import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS, skip } from './shared.mts';
import { H } from './daemon.mts';

// N1-N3: the login page and expired sign-ins, by swapping the test Caddy's config through its admin socket (N-6)
const CADDY = path.join(path.dirname(HARNESS), 'caddy');
export function caddyMode(mode: string) {
  const r = spawnSync('caddy', ['reload', '--config', path.join(CADDY, mode + '.Caddyfile'), '--adapter', 'caddyfile', '--address', 'unix/' + H.caddyAdmin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`caddy reload ${mode}: ${r.stderr}`);
}
export const hasCaddyModes = ['expired', 'loginpage'].every(m => fs.existsSync(path.join(CADDY, m + '.Caddyfile')));
export const skipCaddy = (n: string) => skip(n, `no expired/loginpage Caddyfile in ${CADDY}`);
