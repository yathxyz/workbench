import fs from 'node:fs';
import { TMP, check, section, shot, skip, state, until } from '../shared.mts';
import { H, dpage, settled } from '../daemon.mts';

await section('N80', async () => {
  const P = await dpage(), sid = 'n80_task_acp', url = 'https://example.test/issues/' + 'a'.repeat(210);
  const headers = { Authorization: 'Bearer ' + fs.readFileSync(H.apiTokenFiles.near, 'utf8').trim(), 'Content-Type': 'application/json' };
  const api = async (path: string, method: string, body?: Record<string, unknown>) => {
    const res = await fetch(H.api + '/v1' + path, { method, headers, body: body && JSON.stringify(body) });
    if (!res.ok) throw new Error(`N80 ${method} ${path}: ${res.status} ${await res.text()}`);
  };
  const reports = new Set<string>();
  const report = async (name: string, metadata: Record<string, unknown> = {}, kind = 'prompt', child?: string) => {
    await api('/events', 'POST', { harness: 'pi', payload: { session_id: 'n80-' + name, agent_id: child, kind, text: 'N80 ' + (child ?? name), cwd: TMP }, ...metadata });
    reports.add(name);
  };
  const row = (name: string) => P.locator('#mesh-list .mesh-row').filter({ has: P.getByText('N80 ' + name, { exact: true }) });
  const group = (name: string) => row(name).evaluate(el => {
    let e = el.previousElementSibling; while (e && !e.classList.contains('mesh-group')) e = e.previousElementSibling; return e?.textContent;
  });
  const headings = P.locator('#mesh-list .mesh-group');
  const inLastGroup = (name: string) => row(name).evaluate(e => !e.matches(':has(~ .mesh-group)'));
  const repoLabel = (name: string) => row(name).locator('.mesh-repo').innerText();
  const taskValue = P.locator('#mesh-info .mesh-kv').filter({ has: P.getByText('task', { exact: true }) }).locator('code');
  const toggle = () => P.locator('#mesh-list').press('g');
  let created = false;
  try {
    await report('link', { repo: 'n80/one', task: url });
    await report('other', { repo: 'n80/two', task: url });
    await report('link', { repo: 'n80/one' }, 'prompt', 'same-child');
    await report('link', { repo: 'n80/two' }, 'prompt', 'cross-child');
    await report('literal', { repo: 'No task', task: 'No task' });
    await report('empty', { repo: '', projectRoot: '' });
    await report('none', { repo: 'n80/one' });
    await report('none', {}, 'permission');   // even a waiting session belongs in the last taskless group
    await P.evaluate(() => window.__canvas.meshOpen());
    await row('none').click();
    check('N80: the default groups by repository and a session without a task adds no detail line',
      await group('link') === 'n80/one' && await group('none') === 'n80/one' && await group('other') === 'n80/two' && !await taskValue.count());
    check('N80: repository headers supply the root labels, including an empty repository name',
      !await repoLabel('link') && !await repoLabel('other') && await group('empty') === '' && await group('literal') === 'No task');
    const literalRepo = await headings.filter({ hasText: /^No task$/ }).elementHandle();
    await row('link').click();
    const short = await row('link').locator('.mesh-task').evaluate(e => ({ text: e.textContent, clipped: e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis' }));
    const link = await taskValue.locator('a').evaluate(a => ({ text: a.textContent, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }));
    check('N80: the long reference ellipsises in the row; Details links the whole HTTPS URL in a separate tab',
      short.text === url && short.clipped && link.text === url && link.href === url && link.target === '_blank' && link.rel === 'noopener noreferrer', { short, link });
    await toggle();
    const heads = await headings.allTextContents();
    check('N80: g groups the same task across repositories and labels both roots',
      await group('link') === url && await group('other') === url && heads.filter(h => h === url).length === 1
      && (await repoLabel('link')).includes('n80/one') && (await repoLabel('other')).includes('n80/two'), heads);
    check('N80: descendants stay in the root task group and only the cross-repository child repeats a repository label',
      await group('same-child') === url && await group('cross-child') === url
      && await row('same-child').getAttribute('data-depth') === '1' && await row('cross-child').getAttribute('data-depth') === '1'
      && !await repoLabel('same-child') && (await repoLabel('cross-child')).includes('n80/two'));
    check('N80: literal "No task" and the last taskless group have distinct headings, neither reused from repository mode',
      await group('literal') === 'No task' && !await inLastGroup('literal') && heads.filter(h => h === 'No task').length === 2
      && heads.at(-1) === 'No task' && await inLastGroup('none') && await inLastGroup('empty')
      && !await literalRepo!.evaluate(e => e.isConnected), heads);
    await shot(P, 'n80-task-groups');
    await toggle();
    check('N80: g restores repository groups, labels and nesting',
      await group('link') === 'n80/one' && await group('other') === 'n80/two' && await group('empty') === ''
      && !await repoLabel('link') && !await repoLabel('other') && !await repoLabel('same-child')
      && await group('cross-child') === 'n80/one' && (await repoLabel('cross-child')).includes('n80/two'));

    for (const text of ['javascript:alert(1)', '<b>not markup</b>', 'https://example.test/ followed by words']) {
      await report('link', { task: text }, 'note');
      const literal = await until(async () => await taskValue.evaluate(e => !e.childElementCount && e.textContent) === text
        && await row('link').locator('.mesh-task').evaluate(e => !e.childElementCount && e.textContent) === text);
      check('N80: free text stays literal in the row and in Details: ' + text, literal);
    }

    if (state.STUB) {
      const hub = 'http://example.test/issues/44', observed = 'observed fallback';
      await api('/sessions', 'POST', { sid, agent: 'stub', cwd: TMP, task: hub }); created = true;
      const hubRow = P.locator(`#mesh-list .mesh-row[data-id="${sid}"]`);
      await hubRow.waitFor();
      check('N80: a hub-only ACP row shows its task', await hubRow.locator('.mesh-task').textContent() === hub);
      await report('joined', { wbSession: sid, task: observed });
      await row('joined').click(); await P.getByRole('button', { name: 'Details', exact: true }).click();
      check('N80: the joined row and detail prefer the hub task to the observed task',
        !await hubRow.count() && await row('joined').locator('.mesh-task').textContent() === hub && await taskValue.locator('a').getAttribute('href') === hub);
      await toggle();
      await api('/sessions/' + sid + '/task', 'POST', { task: null });
      const fallback = await until(async () => await row('joined').locator('.mesh-task').textContent() === observed && await group('joined') === observed
        && await taskValue.evaluate(e => !e.childElementCount && e.textContent) === observed);
      check('N80: clearing the hub task reveals the observed reference in the joined row, detail and group', fallback);
    } else skip('N80 joined ACP', 'no `stub` agent in /api/info.agents');
  } finally {
    await P.evaluate(() => window.__canvas.setView('canvas'));
    if (created) await api('/sessions/' + sid + '?forget=true', 'DELETE');
    for (const name of reports) await report(name, {}, 'end');
    await settled(P); await P.close();
  }
});
