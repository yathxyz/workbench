import { check, until } from '../../shared.mts';
import { newTerm, ptyOf, typeIn } from '../../daemon.mts';
import { acpIdle, acpNew, acpSent } from '../../acp.mts';
import type { N78Fixture, N78Resources } from './fixtures.mts';

export default async function run({
  D, sid, ids, externalPty, before, meshApi, nodes, liveIdle, isAlive, open, showCard, closeCard,
  reload,
}: N78Fixture, resources: N78Resources) {
  // Borrowed ownership is part of the saved board, not the backend's lifetime in this page.
  await open(sid); await D.getByRole('button', { name: 'Add its card', exact: true }).click();
  await acpIdle(D, sid);
  await open(ids['n78-hubpty']); await D.getByRole('button', { name: 'Add its card', exact: true }).click();
  await until(() => ptyOf(D, externalPty).some(w => w.hello && !w.closed));
  await reload(); await acpIdle(D, sid);
  await until(() => ptyOf(D, externalPty).some(w => w.hello && !w.closed));
  const borrowed = await D.evaluate((ids: string[]) => ids.every(id => window.__canvas.S.nodes[id]?.adopted === true), [sid, externalPty]);
  const adopted = await closeCard(sid), adoptedPty = await closeCard(externalPty);
  check('N78: after reload, closing adopted ACP and PTY cards removes only their cards and leaves their sessions running',
    borrowed && adopted.armed && adopted.kept && adopted.removed && adoptedPty.armed && adoptedPty.kept && adoptedPty.removed && await isAlive(sid) && await isAlive(externalPty)
    && acpSent(D, sid, 'kill').length === 0 && await nodes() === before, JSON.stringify({ borrowed, adopted, adoptedPty, kills: acpSent(D, sid, 'kill') }));
  await open(sid); await liveIdle();
  await D.locator('#mesh-detail .mesh-kill').click();
  const confirmation = await D.locator('#pal-in').getAttribute('placeholder');
  const beforeConfirm = await isAlive(sid);
  await D.keyboard.press('Escape');
  const cancelled = await isAlive(sid), noKill = acpSent(D, sid, 'kill').length === 0;
  await D.locator('#mesh-detail .mesh-kill').click();
  await D.locator('#pal-list .pi').filter({ has: D.locator('.l', { hasText: /^Kill session$/ }) }).click();
  const killed = await until(async () => !await isAlive(sid), 15000);
  check('N78: explicit Kill session is separate from close, cancelled confirmation preserves it, and confirmation ends it',
    /Kill session/.test(confirmation || '') && beforeConfirm && cancelled && noKill && !!killed && acpSent(D, sid, 'kill').some(m => m.forget === false), JSON.stringify({ confirmation, beforeConfirm, cancelled, noKill, killed, kills: acpSent(D, sid, 'kill') }));
  await open(sid); await D.getByRole('button', { name: 'Add its card', exact: true }).click();
  await meshApi('/sessions/' + sid + '?forget=true', 'DELETE');
  await showCard(sid);
  await D.locator(`.node[data-id="${sid}"] .ag-state`).getByRole('button', { name: 'Start new session', exact: true }).click();
  const freshAgent = await acpIdle(D, sid);
  const agentClaimed = await D.evaluate((id: string) => !window.__canvas.S.nodes[id].adopted, sid);
  const replacedAgent = await closeCard(sid), replacedAgentEnded = await until(async () => !await isAlive(sid), 15000);
  check('N78: starting a replacement session from an adopted agent card clears its borrowed mark and restores kill-on-close',
    !!freshAgent && agentClaimed && replacedAgent.removed && !!replacedAgentEnded, JSON.stringify({ freshAgent: !!freshAgent, agentClaimed, replacedAgent, replacedAgentEnded }));
  await open(ids['n78-hubpty']); await D.getByRole('button', { name: 'Add its card', exact: true }).click();
  await until(() => ptyOf(D, externalPty).some(w => w.hello && !w.closed));
  await showCard(externalPty);
  const shellKill = D.locator(`.node[data-id="${externalPty}"] .session-kill`);
  await shellKill.click();
  const shellBeforeConfirm = await isAlive(externalPty);
  await D.keyboard.press('Escape');
  const shellCancelled = await isAlive(externalPty);
  await shellKill.click();
  await D.locator('#pal-list .pi').filter({ has: D.locator('.l', { hasText: /^Kill session$/ }) }).click();
  const shellKilled = await until(async () => !await isAlive(externalPty!), 15000);
  const shellCardKept = await D.evaluate((id: string) => !!window.__canvas.S.nodes[id], externalPty);
  check('N78: an adopted shell has a separate confirmed Kill session action; cancel preserves it and killing does not delete the card',
    shellBeforeConfirm && shellCancelled && !!shellKilled && shellCardKept, JSON.stringify({ shellBeforeConfirm, shellCancelled, shellKilled, shellCardKept }));
  await until(() => D.evaluate((id: string) => !!window.__canvas.live[id].backend.dead, externalPty!));
  await typeIn(D, externalPty, '\r');
  const freshShell = await until(async () => await isAlive(externalPty!) && await D.evaluate((id: string) => !window.__canvas.S.nodes[id].adopted, externalPty!), 15000);
  const shellClaimed = await D.evaluate((id: string) => !window.__canvas.S.nodes[id].adopted, externalPty);
  const replacedShell = await closeCard(externalPty), replacedShellEnded = await until(async () => !await isAlive(externalPty!), 15000);
  check('N78: starting a replacement session from an adopted shell card clears its borrowed mark and restores kill-on-close',
    !!freshShell && shellClaimed && replacedShell.removed && !!replacedShellEnded, JSON.stringify({ freshShell, shellClaimed, replacedShell, replacedShellEnded }));
  await D.evaluate(() => window.__canvas.setView('canvas'));
  const owned = resources.owned = await acpNew(D); if (!owned) throw new Error('N78 page-started canvas agent did not appear');
  await acpIdle(D, owned);
  const ownedPty = resources.ownedPty = await newTerm(D, 'n78-owned');
  await reload(); await acpIdle(D, owned);
  await until(() => ptyOf(D, ownedPty).some(w => w.hello && !w.closed));
  const started = await isAlive(owned) && await isAlive(ownedPty);
  const ownedAfterReload = await D.evaluate((ids: string[]) => ids.every(id => !window.__canvas.S.nodes[id].adopted), [owned, ownedPty]);
  const closedOwned = await closeCard(owned), closedOwnedPty = await closeCard(ownedPty);
  const endedOwned = await until(async () => !await isAlive(owned!) && !await isAlive(ownedPty!), 15000);
  check('N78: after reload, closing ACP and PTY cards created by this page still ends their sessions',
    started && ownedAfterReload && closedOwned.armed && closedOwned.kept && closedOwned.removed && closedOwnedPty.armed && closedOwnedPty.kept && closedOwnedPty.removed
    && !!endedOwned && acpSent(D, owned, 'kill').length > 0, JSON.stringify({ started, ownedAfterReload, closedOwned, closedOwnedPty, endedOwned, kills: acpSent(D, owned, 'kill') }));
}
