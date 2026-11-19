import fs from 'node:fs';
import path from 'node:path';
import { TMP, check, section, skip, state, until } from '../shared.mts';
import { H, dpage, record, settled } from '../daemon.mts';
import { acpEvs, acpIdle, acpView } from '../acp.mts';

const { STUB } = state;

await section('N78 config revive', async () => {
  if (!STUB) return skip('N78 config revive', 'no `stub` agent (wb-fake-acp) in /api/info.agents');
  const P = await dpage(), sid = 'n78_config_revive', cwd = fs.mkdtempSync(path.join(TMP, 'n78-config-'));
  record(P);
  const api = (url: string, method: string, body?: Record<string, unknown>) => fetch(H.api + '/v1/sessions' + url, {
    method, headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const info = () => P.evaluate(() => Object.fromEntries([...document.querySelectorAll('#mesh-detail .mesh-info .mesh-kv')].map(e => [e.querySelector('span')!.textContent!, e.querySelector('code')!.textContent!])));
  try {
    const started = await api('', 'POST', { sid, agent: 'config-revive-malformed', cwd });
    if (started.status !== 201) throw new Error('N78 config spawn: ' + started.status + ' ' + await started.text());
    await P.waitForFunction((sid: string) => !!window.__canvas.SESS[sid], sid);
    await P.waitForFunction(() => !window.__canvas.FR.on || window.__canvas.FR.ready && window.__canvas.FR.online);
    await P.evaluate((sid: string) => window.__canvas.meshOpen(sid), sid);
    if (!await acpIdle(P, '$agents')) throw new Error('N78 config viewer did not finish replay');
    const edwin = await P.evaluate(() => window.__canvas.FR.on), reader = edwin ? await P.locator('#mesh-detail .ag-reader').elementHandle() : null;
    await P.locator('#mesh-detail .mesh-disclose').click();
    const before = await until(async () => { const i = await info(); return i.model === 'stub-model' && i.reasoning === 'high' ? i : null; });
    const stopped = await api('/' + sid, 'DELETE');
    if (!stopped.ok) throw new Error('N78 config kill: ' + stopped.status);
    const dead = await until(async () => { const v = await acpView(P, '$agents'); return v && !v.alive; });
    if (!dead) throw new Error('N78 config session did not stop');
    const revived = await api('/' + sid + '/revive', 'POST');
    if (!revived.ok) throw new Error('N78 config revive: ' + revived.status);
    const ready = await acpIdle(P, '$agents');
    const cleared = await until(async () => {
      const i = await info(), meta = await P.locator('#mesh-detail .mesh-meta').textContent();
      return !i.model && !i.reasoning && !meta?.includes('stub-model') ? i : null;
    });
    const session = acpEvs(P, sid, 'session').at(-1);
    await P.fill('#mesh-detail .ag-in textarea', 'after malformed revive'); await P.press('#mesh-detail .ag-in textarea', 'Enter');
    const reply = await until(() => P.evaluate(() => {
      const b = window.__canvas.live.$agents.backend;
      return (b.transcript?.buf.text ?? document.querySelector('#mesh-detail .ag-log')?.textContent)?.includes('Streaming three chunks.');
    }));
    check('N78: a malformed revive offering clears the previous model and reasoning in detail and header while the transcript remains usable',
      !!before && !!ready && !!cleared && session?.via === 'load' && session.configOptions == null && !!reply
      && (!edwin || !!reader && await reader.evaluate(e => e === document.querySelector('#mesh-detail .ag-reader'))),
      { before, cleared, session, ready: !!ready, reply, edwin });
  } finally {
    await api('/' + sid + '?forget=true', 'DELETE');
    await settled(P); await P.close();
  }
});
