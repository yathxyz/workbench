import fs from 'node:fs';
import path from 'node:path';
import { TMP, until } from '../../shared.mts';
import { H, dpage, ptyOf, record, sessions, settled, termText } from '../../daemon.mts';
import { acpIdle, acpView, gatedPage, type TailPage } from '../../acp.mts';

// Only acquired resources need mutable slots: the outer finally must also see partially completed steps.
export interface N78Resources {
  externalPty?: string;
  owned?: string;
  ownedPty?: string;
  unloadPage?: TailPage;
}

export async function openFixture() {
  const { P: D, g } = await gatedPage(), owner = await dpage(), sid = 'attach_n78_api';
  record(D);
  const model = 'claude-opus-4-1-20250805', cwd = fs.mkdtempSync(path.join(TMP, 'n78-project-'));
  const meshApi = (url: string, method = 'GET', body?: Record<string, unknown>) => fetch(H.api + '/v1' + url, {
    method, headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const startPty = (id: string) => owner.evaluate((id: string) => new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/pty');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'open', id, spawn: true, cols: 80, rows: 24 }));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'hello') { ws.close(); resolve(); } else if (m.t === 'error') { ws.close(); reject(new Error(m.error)); } };
    ws.onerror = () => reject(new Error('external PTY open failed'));
  }), id);
  const report = async (who: 'near' | 'far', session: string, more: Record<string, unknown> = {}, kind = 'prompt', text = 'n78 observed prompt') =>
    (await fetch(H.api + '/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles[who], 'utf8').trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: 'pi', payload: { session_id: session, kind, cwd, model, permission_mode: 'default', text }, ...more }) })).status;
  const reportClaude = (session: string, more: Record<string, unknown> = {}, hook = 'UserPromptSubmit') =>
    report('near', session, { harness: 'claude', payload: { session_id: session, hook_event_name: hook, cwd, model, prompt: 'n78 Claude prompt', tool_name: 'Edit' }, ...more });
  const row = (id: string) => D.locator(`#mesh-list .mesh-row[data-id="${id}"]`);
  const info = () => D.evaluate(() => Object.fromEntries([...document.querySelectorAll('#mesh-detail .mesh-info .mesh-kv')].map(e => [e.querySelector('span')!.textContent!, e.querySelector('code')!.textContent!])));
  const nodes = () => D.evaluate(() => Object.keys(window.__canvas.S.nodes).sort().join());
  const attachSid = (P = D) => P.evaluate((): string => window.__canvas.live.$agentsAttach?.backend.n.id || '');
  const attachText = (P = D) => termText(P, '$agentsAttach');
  const attachOpens = () => ptyOf(D).filter(w => w.open?.spawn && w.open.attach);
  const forgot = (sid: string) => until(async () => !(await sessions()).some(s => s.sid === sid), 15000);
  const switchButton = (name: 'Transcript' | 'Terminal') => D.getByRole('button', { name, exact: true });
  const composer = '#mesh-detail .mesh-live .ag-in textarea';
  const reader = '#mesh-detail .ag-reader', log = '#mesh-detail .ag-log';
  const readerText = () => D.evaluate(() => window.__canvas.live.$agents?.backend.transcript?.buf.text as string | undefined);
  const readerState = () => D.evaluate(async () => {
    await new Promise<void>(r => requestAnimationFrame(() => r()));
    const { buf, frame } = window.__canvas.live.$agents.backend.transcript as { buf: EdwinBuffer; frame: EdwinFrame };
    return { point: frame.point(), mark: buf.mark, end: buf.rope.length, undo: buf.undo.length,
      first: frame.root.querySelector('.ln')?.textContent, focused: frame.root.contains(document.activeElement) };
  });
  const readUntil = (text: string) => D.waitForFunction(text => window.__canvas.live.$agents?.backend.transcript?.buf.text.includes(text), text);
  const liveView = () => acpView(D, '$agents');
  const liveIdle = () => acpIdle(D, '$agents');
  const isAlive = async (id: string) => (await sessions()).some(s => s.sid === id && s.alive);
  const open = async (id: string) => { await D.evaluate((id: string) => window.__canvas.meshOpen(id), id); };
  const syncBoard = async (from: TailPage, to: TailPage) => {
    if (!await settled(from) || !await until(async () => await from.evaluate(() => window.__canvas.BOARD_ETAG) === await to.evaluate(() => window.__canvas.BOARD_ETAG), 15000))
      throw new Error('N78 board save did not reach the other page');
  };
  const showCard = async (id: string, P = D) => {
    await P.bringToFront();
    await P.evaluate((id: string) => { const C = window.__canvas; C.setView('canvas'); C.focusOpen(C.S.nodes[id]); }, id);
  };
  const closeCard = async (id: string, P = D) => {
    await showCard(id, P);
    const close = P.locator(`.node[data-id="${id}"] .hdel`);
    await close.click(); const armed = await close.evaluate(e => e.classList.contains('armed'));
    const kept = await P.evaluate((id: string) => !!window.__canvas.S.nodes[id], id);
    await close.click(); return { armed, kept, removed: !await P.locator(`.node[data-id="${id}"]`).count() };
  };
  const remoteCard = async (add: boolean) => {
    await settled(owner); await syncBoard(D, owner);
    if (add) { await owner.evaluate((sid: string) => window.__canvas.meshOpen(sid), sid); await owner.getByRole('button', { name: 'Add its card', exact: true }).click(); }
    else await owner.evaluate((sid: string) => window.__canvas.removeNode(sid), sid);
    await syncBoard(owner, D);
    return until(async () => await D.evaluate(({ sid, add }) => !!window.__canvas.S.nodes[sid] === add, { sid, add })
      && await D.getByRole('button', { name: add ? 'Show on canvas' : 'Add its card', exact: true }).count() === 1, 15000);
  };
  const reload = async () => { if (!await settled(D)) throw new Error('N78 board did not settle before reload'); await D.reload(); await D.waitForFunction(() => window.__canvas?.BOOTED); };
  return {
    D, g, owner, sid, model, cwd, meshApi, startPty, report, reportClaude, row, info, nodes, attachSid,
    attachText, attachOpens, forgot, switchButton, composer, reader, log, readerText, readerState, readUntil,
    liveView, liveIdle, isAlive, open, syncBoard, showCard, closeCard, remoteCard, reload,
  } as const;
}

export type N78Fixture = Awaited<ReturnType<typeof openFixture>> & {
  readonly before: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly edwin: boolean;
  readonly externalPty: string;
  readonly hasTerminal: () => Promise<boolean>;
};
