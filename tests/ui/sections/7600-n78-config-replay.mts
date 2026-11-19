import fs from 'node:fs';
import path from 'node:path';
import { TMP, check, section, skip, state, until } from '../shared.mts';
import { H } from '../daemon.mts';
import { acpIdle, gatedPage } from '../acp.mts';

const { STUB } = state;

await section('N78 config replay', async () => {
  if (!STUB) return skip('N78 config replay', 'no `stub` agent (wb-fake-acp) in /api/info.agents');
  const { P, g } = await gatedPage(), sid = 'n78_config_replay', cwd = fs.mkdtempSync(path.join(TMP, 'n78-config-replay-'));
  const api = (url: string, method: string, body?: Record<string, unknown>) => fetch(H.api + '/v1/sessions' + url, {
    method, headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    // A result-only agent cannot repair the replay with a config_option_update.
    const started = await api('', 'POST', { sid, agent: 'config-result', cwd });
    if (started.status !== 201) throw new Error('N78 config replay spawn: ' + started.status + ' ' + await started.text());
    await P.waitForFunction((sid: string) => {
      const s = window.__canvas.SESS[sid]; return s?.acp?.agentSessionId && s.acp.activity === 'none';
    }, sid);
    const changed = await api('/' + sid + '/config', 'POST', { id: 'model', value: 'large' });
    if (!changed.ok) throw new Error('N78 config replay set: ' + changed.status + ' ' + await changed.text());
    g.hold = true;
    await P.evaluate((sid: string) => window.__canvas.meshOpen(sid), sid);
    const replay = await until(() => g.socks.find(s =>
      s.buf.some(m => { const f = JSON.parse(String(m)); return f.t === 'hello' && f.info.sid === sid; })
      && s.buf.some(m => JSON.parse(String(m)).t === 'replayed')));
    if (!replay) throw new Error('N78 config replay did not arrive');
    const delivered: AcpServerMsg[] = [];
    for (const m of replay.buf.splice(0)) {
      const frame = JSON.parse(String(m)) as AcpServerMsg;
      if (frame.t === 'info') replay.buf.push(m);
      else { delivered.push(frame); replay.ws.send(m); }
    }
    const idle = await acpIdle(P, '$agents');
    await P.locator('#mesh-detail .mesh-disclose').click();
    const detail = await until(() => P.evaluate(() => {
      const facts = Object.fromEntries([...document.querySelectorAll('#mesh-detail .mesh-info .mesh-kv')].map(e => [e.querySelector('span')!.textContent!, e.querySelector('code')!.textContent!]));
      return facts.model === 'large' ? facts : null;
    }));
    const header = await P.locator('#mesh-detail .mesh-meta').textContent();
    const configSeq = delivered.flatMap(m => m.t === 'ev' && m.ev.e === 'config' ? [m.ev.seq] : []).at(-1);
    check('N78: full journal replay applies a set-config result to detail and header before any later info',
      !!idle && configSeq != null && idle.seq >= configSeq && !!detail && !!header?.includes('large')
      && g.sent.some(m => m?.t === 'open' && m.id === sid && m.since === 0),
      { detail, header, configSeq, seq: idle?.seq });
  } finally {
    // Held frames may belong to viewers already closed; discard them by closing the page, not releasing the gate.
    await P.close();
    await api('/' + sid + '?forget=true', 'DELETE');
  }
});
