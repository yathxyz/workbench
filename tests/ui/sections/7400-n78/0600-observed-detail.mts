import { check, until } from '../../shared.mts';
import { H } from '../../daemon.mts';
import { acpSent } from '../../acp.mts';
import type { N78Fixture } from './fixtures.mts';

export default async function run({
  D, sid, model, cwd, ids, edwin, before, row, info, nodes, composer, reader, liveIdle, isAlive,
  open,
}: N78Fixture) {
  const transcriptName = await D.evaluate(() => window.__canvas.live.$agents.backend.transcript?.buf.name as string | undefined);
  await row(ids['n78-readonly']).click();
  const detached = await until(async () => !await D.locator(composer).count() && await isAlive(sid), 10000);
  if (edwin) check('N78: selecting another row destroys the transcript frame and kills its local buffer', !!transcriptName
    && !await D.locator(reader).count() && await D.evaluate(name => !window.Ed.E.buffers.some(b => b.name === name), transcriptName));
  await open(sid); await liveIdle();
  await D.evaluate(() => window.__canvas.setView('canvas'));
  const leftHub = await until(async () => !await D.locator(composer).count() && await isAlive(sid), 10000);
  check('N78: deselecting a non-owned hub ACP session and leaving Agents dispose only the viewer, never the session',
    !!detached && !!leftHub && acpSent(D, sid, 'kill').length === 0 && await nodes() === before, JSON.stringify({ detached, leftHub, kills: acpSent(D, sid, 'kill') }));

  await open(ids['n78-readonly']);
  const ro = await D.locator('#mesh-detail').textContent(), roInfo = await info();
  const metadata = await row(ids['n78-readonly']).evaluate(e => ({
    harness: e.querySelector('.mesh-harness')?.textContent, harnessTitle: e.querySelector('.mesh-harness')?.getAttribute('title'),
    model: e.querySelector('.mesh-model')?.textContent, modelTitle: e.querySelector('.mesh-model')?.getAttribute('title'),
  }));
  check('N78: an observed row has full harness/model titles; read-only detail explains setup, displays known metadata and omits unknown reasoning',
    metadata.harness === 'pi' && metadata.harnessTitle === 'pi' && !!metadata.model && metadata.modelTitle === model && roInfo.harness === 'pi' && roInfo.model === model && roInfo.host === H.host && roInfo.folder === cwd && roInfo.mode === 'default' && !('reasoning' in roInfo) && !!roInfo.started && !!roInfo['last active']
    && /Started in a terminal the hub cannot reach/.test(ro || '') && /Claude background session/.test(ro || '') && /tmux/.test(ro || '') && !await D.locator('#mesh-detail .ag-in textarea, #mesh-detail .xterm').count()
    && !await D.getByRole('button', { name: 'Open terminal', exact: true }).count(), JSON.stringify({ metadata, roInfo, ro }));
}
