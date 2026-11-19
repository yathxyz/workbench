import { check, section } from '../shared.mts';
import { REQ, WSL, dpage } from '../daemon.mts';

// N11: over the whole daemon phase's request log

await section('N11', async () => {
  const st: any = { token: REQ.filter(e => /[?&#]token=/.test(e.url)).map(e => e.url), xtoken: REQ.filter(e => 'x-token' in e.h).map(e => e.url), ws: [...new Set(WSL.map(w => w.url))] };
  const P = await dpage(false); st.manifest = await P.evaluate(() => document.querySelector('link[rel=manifest]')?.getAttribute('crossorigin')); await P.close();
  check('N11: no token in any URL or header; WebSocket URLs have no query; the manifest goes with credentials', !st.token.length && !st.xtoken.length && st.ws.length > 0 && st.ws.every((u: string) => /^ws:\/\/127\.0\.0\.1:18443\/(rpc|pty|acp|edit)$/.test(u)) && st.manifest === 'use-credentials', JSON.stringify(st));
});
