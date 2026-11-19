// Frontend checks in headless Chromium (DESIGN §9.5, 30 §10, DELTA-1 §A.5 and §B.6).
//
//   WB_PLAYWRIGHT=<playwright>/index.mjs WB_HARNESS=tests/harness.py node tests/ui.mts <web-root>
//
// <web-root> (or $WB_WEB_ROOT) is the built web output (`nix build .#workbench-web`: web/ plus vendor/ and fonts/). The
// harness takes wb-hub, edwind, wb-web, wb-fake-acp and caddy from PATH (edwind falls back to $EDWIND_MAIN under
// node); the Caddy configs for the expired and login-page modes sit next to it in caddy/. Served pages are Edwin frames
// (edwind spec R9.21): the page's text is read through the board's pageText, the frame's DOM through the Q map, and the
// 'frames' section drives two tabs, presence, an edwind restart, the offline notice, board migration, the frame cap,
// the console page and agent tools (R16.9-R16.11). The demo has no edwind: its pages are read-only.
// Each check prints ok, FAIL or skip. The exit status is 0 only when every check ran and passed.
//
// Demo phase: the page with its scripts and styles inlined, opened from file://.
// Daemon phase: the harness's Caddy listens only on a unix socket. A forwarder on 127.0.0.1:18443 (the harness's
// publicOrigin) joins the browser to it and drops connections from every other local user, who would otherwise
// reach a shell through the proxy secret Caddy adds. The harness runs without WB_HARNESS_TCP, whose TCP entry would
// take that port; the forwarder stays because N6 cuts it.
// Add a UI check in ui/sections/ as NNNN-short-name.mts. Pick any unused four-digit
// prefix after its dependencies and before 9000; 9000 and up are for final checks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { HARNESS, ROOT, TMP, check, errors, fails, loadSection, sectionFiles, skips, state } from './ui/shared.mts';
import { MEDIA, ctx, hlog, startDaemon } from './ui/daemon.mts';

const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright') as typeof import('playwright-core');
if (!ROOT || !HARNESS) { console.error('usage: WB_PLAYWRIGHT=… WB_HARNESS=tests/harness.py node tests/ui.mts <web-root>'); process.exit(2); }
const browser = state.browser = await chromium.launch();
process.on('uncaughtException', e => { console.log('UNCAUGHT', e); process.exit(2); });   // the harness stops when our end of its stdin closes
await import('./ui/demo.mts');

// ---------------- daemon phase: wb-hub, wb-web and Caddy from the harness
// Without WB_HARNESS_TCP: the browser goes through the forwarder below, which N6 cuts, and the harness's own TCP
// entry would take its port.
const { WB_HARNESS_TCP, ...harnessEnv } = process.env;
// N74: an image provider on the OpenAI protocol (web.json media, harness --media). Each call answers solid PNGs, one
// colour per variation, so variations differ by hash; MEDIA keeps what each call asked for.
function solidPng(rgb: [number, number, number], w = 4, h = 4): Buffer {
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()]), raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const MEDIA_COLOURS: [number, number, number][] = [[200, 0, 40], [0, 90, 200], [0, 150, 60], [220, 160, 0]];
const media = http.createServer((req, res) => {
  let body = ''; req.setEncoding('latin1'); req.on('data', d => { body += d; });
  req.on('end', () => {
    MEDIA.push({ path: req.url || '', body });
    let n = 1; if (req.url === '/v1/images/generations') { try { n = JSON.parse(body).n || 1; } catch {} }
    else if (req.url !== '/v1/images/edits') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ b64_json: solidPng(MEDIA_COLOURS[(i + (req.url === '/v1/images/edits' ? 3 : 0)) % 4]).toString('base64') })) }));
  });
});
await new Promise<void>(r => media.listen(0, '127.0.0.1', () => r()));
const MEDIA_URL = `http://127.0.0.1:${(media.address() as net.AddressInfo).port}/v1`;
const harness = spawn('python3', ['-I', HARNESS, '--web-root', ROOT, '--api', '--media', MEDIA_URL], { stdio: ['pipe', 'pipe', 'pipe'], env: harnessEnv });
const fwd = await startDaemon(harness);

for (const file of sectionFiles(new URL('./ui/sections/', import.meta.url))) await loadSection(file);

await ctx.close(); await browser.close();
harness.stdin.end(); fwd.close(); media.close();
// serviceWorkers: 'block' is an init script that touches navigator.serviceWorker in every frame; in a sandboxed web or
// artifact frame without allow-same-origin that read throws. The error is Playwright's, not the page's.
const realErrors = errors.filter(e => !/favicon|net::ERR|Failed to load resource|WebSocket connection to|Refused to (connect|frame|load)|Content Security Policy|manifest|sw\.js|ERR_FILE_NOT_FOUND|Failed to read the 'serviceWorker' property from 'Navigator'/.test(e));
check('no page errors', realErrors.length === 0, realErrors.slice(0, 6).join('\n'));
console.log('FAILS:', fails); console.log('SKIPS:', skips);
if (fails.length) console.log(hlog.slice(-1500));
else if (!skips.length) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fails.length || skips.length ? 1 : 0);
