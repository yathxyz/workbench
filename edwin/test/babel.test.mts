// Babel, the block engine of notes (hypernotes H1, docs/HYPERNOTES.md; spec R10.8, R14.15, the R4.15
// amendment): the reader and writer of server/babel.mts as functions, then scm/babel.scm against a real
// edwind and the fake hub, for markdown and Org notes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, startEdwind, stopEdwind, EditClient } from './edit-client.mts';
import type { TestDir, EdwindChild, Msg } from './edit-client.mts';
import { FakeHub } from './fake-hub.mts';
import { parse, resultText, expand, tangleFiles, delimited, orgTable, markdownAttrs, orgArgs } from '../server/babel.mts';

const fence = '```';

/* ---------- the reader and the writer ---------- */
test('markdown: fences with attributes, data kinds, results by of= and by place, front matter env', () => {
  const text = [
    '---', 'title: T', 'env: demo', '---', '',
    `${fence}scheme {#files results=output noweb}`, '(define x 1)', fence, '',
    `${fence}result {of=files}`, '1', fence, '',
    `~~~sh`, 'echo hi', '~~~', '',
    `${fence}result`, 'hi', fence, '',
    `${fence}json {#cfg}`, '{"a": [1, 2]}', fence,
    `${fence}{.scheme #cls in=cfg,n=3}`, '(car x)', fence,
    `  ${fence}scheme {#ind}`, '  (indented)', '  ```',
    `${fence}result {of=ind error}`, 'car: expected pair', fence,
    `${fence}scheme {#open}`, 'unclosed',
  ].join('\n');
  const p = parse(text, 'markdown');
  assert.deepEqual(p.blocks.map(b => [b.kind, b.lang, b.id]), [['src', 'scheme', 'files'], ['src', 'sh', null], ['data', 'json', 'cfg'], ['src', 'scheme', 'cls'], ['src', 'scheme', 'ind'], ['src', 'scheme', 'open']]);
  const [files, sh, , cls, ind, open] = p.blocks;
  assert.equal(files.attrs.env, 'demo', 'front matter env: is a default of every block');
  assert.equal(files.attrs.results, 'output'); assert.equal(files.attrs.noweb, true);
  assert.equal(files.body, '(define x 1)');
  assert.equal(files.result!.text, '1'); assert.equal(text.slice(files.result!.begin, files.result!.end), `${fence}result {of=files}\n1\n${fence}\n`);
  assert.equal(sh.result!.text, 'hi', 'a result without of= belongs to the block right above it');
  assert.deepEqual(cls.vars, [['cfg', 'cfg'], ['n', '3']], 'in=a,b=c');
  assert.equal(ind.body, '(indented)', 'the opening fence\'s indentation comes off the body');
  assert.equal(ind.result!.error, true);
  assert.equal(open.body, 'unclosed'); assert.equal(open.end, text.length, 'an unclosed fence runs to the end');
  assert.equal(text.slice(files.begin, files.end), `${fence}scheme {#files results=output noweb}\n(define x 1)\n${fence}\n`);
  assert.equal(files.line, 6);
  assert.deepEqual(markdownAttrs('#a k="x y" flag in=p'), { id: 'a', classes: [], attrs: { k: 'x y', flag: true }, vars: [['p', 'p']] });
  /* A result after a paragraph is nobody's; a result for an unknown id is nobody's. */
  const q = parse(`${fence}scheme\n1\n${fence}\ntext\n${fence}result\n1\n${fence}\n${fence}result {of=zz}\n2\n${fence}\n`, 'markdown');
  assert.equal(q.blocks[0].result, null); assert.equal(q.results.length, 2);
});

test('Org: #+name, header arguments, #+PROPERTY defaults, escaped lines, named tables, every #+RESULTS form', () => {
  const text = [
    '#+PROPERTY: header-args :session shared', '#+property: header-args:sh :dir /tmp', '#+property: header-args:scheme :var w=4',
    '* Heading',
    '#+name: sum', '#+begin_src scheme :var x=data y=3 :results value', '  (+ (length x) y)', '  ,* not a heading', '#+end_src', '',
    '#+RESULTS: sum', ': 5', '',
    '#+name: data', '| a | b |', '|---+---|', '| 1 | x |', '',
    '#+begin_src sh :var z="q r"', 'echo $z', '#+END_SRC', '',
    '#+RESULTS:', '#+begin_example', 'q r', ',* line', '#+end_example', '',
    '#+begin_src scheme', '(car 1)', '#+end_src', '',
    '#+RESULTS:', '#+begin_error', 'car: expected pair', '#+end_error',
    '#+begin_src scheme :results table', "'((1 2))", '#+end_src', '#+RESULTS:', '| 1 | 2 |',
    '#+begin_src scheme', '(if #f #f)', '#+end_src', '', '#+RESULTS:', 'Text.',
    '#+begin_quote', '#+begin_src scheme', 'inside a quote', '#+end_src', '#+end_quote',
  ].join('\n');
  const p = parse(text, 'org');
  assert.deepEqual(p.blocks.map(b => [b.kind, b.lang, b.id]), [['src', 'scheme', 'sum'], ['table', 'table', 'data'], ['src', 'sh', null], ['src', 'scheme', null], ['src', 'scheme', null], ['src', 'scheme', null]], 'a block inside another block is not read');
  const [sum, data, sh, bad, table, empty] = p.blocks;
  assert.equal(text.slice(sum.begin, sum.begin + 10), '#+name: su', 'the #+name: line belongs to the block');
  assert.deepEqual(sum.vars, [['w', '4'], ['x', 'data'], ['y', '3']], 'header-args:scheme :var applies to scheme blocks');
  assert.equal(sum.attrs.env, 'shared', ':session from #+PROPERTY: header-args'); assert.equal(sum.attrs.results, 'value');
  assert.equal(sum.body, '(+ (length x) y)\n* not a heading', 'commas come off escaped lines, the shared indentation comes off');
  assert.equal(sum.result!.text, '5'); assert.equal(sum.result!.form, 'lines');
  assert.deepEqual(orgTable(data.body), [['a', 'b'], ['1', 'x']]);
  assert.equal(sh.attrs.dir, '/tmp', 'header-args:sh applies to sh blocks only'); assert.equal(sum.attrs.dir, undefined);
  assert.deepEqual(sh.vars, [['z', '"q r"']], 'and not to sh blocks');
  const plus = parse('#+property: header-args:scheme+ :results output\n#+begin_src scheme\n1\n#+end_src\n', 'org').blocks[0];
  assert.equal(plus.attrs.results, 'output', 'header-args:LANG+ is LANG');
  const two = parse('#+begin_src scheme\n1\n#+end_src\n#+RESULTS:\n#+begin_src scheme\n2\n#+end_src\n', 'org');
  assert.equal(two.blocks.length, 2, 'a #+begin_src below an empty #+RESULTS: is the next block');
  assert.equal(two.blocks[0].result!.form, 'empty');
  assert.equal(sh.result!.text, 'q r\n* line'); assert.equal(sh.result!.form, 'block');
  assert.equal(bad.result!.error, true);
  assert.equal(table.result!.form, 'table');
  assert.equal(empty.result!.form, 'empty'); assert.equal(text.slice(empty.result!.begin, empty.result!.end), '#+RESULTS:\n', 'a paragraph after #+RESULTS: is not the result');
  assert.deepEqual(orgArgs('-n :var a=1, b=c :noweb yes :tangle "x y.scm"'), { attrs: { noweb: 'yes', tangle: 'x y.scm' }, vars: [['a', '1'], ['b', 'c']] });
});

test('results as text: markdown fences grow past backticks inside; Org lines, examples, errors and tables', () => {
  assert.equal(resultText('markdown', 'a', '42', false), `${fence}result {of=a}\n42\n${fence}\n`);
  assert.equal(resultText('markdown', null, 'x\n', true), `${fence}result {error}\nx\n${fence}\n`);
  assert.equal(resultText('markdown', 'a', 'see\n````\nend', false), '`````result {of=a}\nsee\n````\nend\n`````\n');
  assert.equal(resultText('org', 'a', 'one\n\ntwo', false), '#+RESULTS: a\n: one\n:\n: two\n');
  const long = Array.from({ length: 10 }, (_, i) => (i === 3 ? '* star' : `l${i}`)).join('\n');
  assert.equal(resultText('org', null, long, false), '#+RESULTS:\n#+begin_example\nl0\nl1\nl2\n,* star\nl4\nl5\nl6\nl7\nl8\nl9\n#+end_example\n');
  assert.equal(resultText('org', 'e', 'bad', true), '#+RESULTS: e\n#+begin_error\nbad\n#+end_error\n');
  assert.equal(resultText('org', 't', [['1', 'abc'], ['22', 'x']], false), '#+RESULTS: t\n| 1  | abc |\n| 22 | x   |\n');
  /* What is written reads back as the same result. */
  for (const [syn, payload] of [['markdown', 'a ``` b\n```'], ['org', 'x\n#+end_example'], ['org', Array(12).fill('#+begin_src').join('\n')]] as const) {
    const body = syn === 'org' ? '#+begin_src scheme\n1\n#+end_src\n\n' : `${fence}scheme\n1\n${fence}\n\n`;
    const p = parse(body + resultText(syn, null, payload, false), syn);
    assert.equal(p.blocks[0].result!.text, payload, `${syn} round trip`);
  }
});

test('noweb: references expand with their line prefix, noweb-ref joins blocks, cycles and missing names are errors; tangle', () => {
  const text = [
    `${fence}scheme {#main noweb tangle=out/main.scm}`, '(define (f)', '  <<body>>)', fence,
    `${fence}scheme {#body}`, '(display 1)', '(display 2)', fence,
    `${fence}scheme {noweb-ref=body tangle=yes}`, '(display 3)', fence,
    `${fence}scheme {#loop noweb}`, '<<loop>>', fence,
    `${fence}scheme {#lost noweb}`, '<<nowhere>>', fence,
    `${fence}scheme {#one}`, '1', fence,
    `${fence}scheme {#pair noweb}`, '(+ <<one>> <<one>>)', '(list <<one>> <<body>>)', fence,
  ].join('\n');
  const p = parse(text, 'markdown');
  assert.equal(expand(p, p.blocks[0]), '(define (f)\n  (display 1)\n  (display 2)\n  (display 3))');
  assert.throws(() => expand(p, p.blocks[3]), /cycle/);
  assert.throws(() => expand(p, p.blocks[4]), /no block named nowhere/);
  const chain = Array.from({ length: 40 }, (_, k) => [`${fence}scheme {#n${k} noweb}`, k < 39 ? `<<n${k + 1}>> <<n${k + 1}>>` : 'x', fence]).flat().join('\n');
  assert.throws(() => expand(parse(chain, 'markdown'), parse(chain, 'markdown').blocks[0]), /expands past/, 'a doubling chain stops at the size cap, fast');
  assert.equal(expand(p, p.blocks[6]), '(+ 1 1)\n(list 1 (display 1)\n(list <<one>> (display 2)\n(list <<one>> (display 3))',
    'every reference on a line expands; a later one repeats the line as written before it');
  assert.deepEqual(tangleFiles(p, 'note'), [['out/main.scm', '(define (f)\n  (display 1)\n  (display 2)\n  (display 3))\n'], ['note.scm', '(display 3)\n']]);
});

test('CSV and TSV records: quotes, doubled quotes, separators and newlines inside quotes', () => {
  assert.deepEqual(delimited('a,"b,c"\n"say ""hi""",2\n"multi\nline",x\n', ','), [['a', 'b,c'], ['say "hi"', '2'], ['multi\nline', 'x']]);
  assert.deepEqual(delimited('a\tb\r\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
});

/* ---------- the engine in edwind ---------- */
let dir: TestDir, child: EdwindChild, hub: FakeHub;
before(async () => {
  dir = makeDir();
  const hubPath = path.join(dir.dirs.sock, 'hub.sock');
  fs.writeFileSync(dir.file, JSON.stringify({ ...dir.cfg, hubSocket: hubPath }));
  hub = await new FakeHub(hubPath).start();
  child = await startEdwind(dir);
});
after(async () => { await stopEdwind(child); await hub.stop(); fs.rmSync(dir.root, { recursive: true, force: true }); });
const client = async () => { const c = new EditClient(dir.cfg.socket); await c.connect(); const w = await c.hello(); assert.equal(w.t, 'welcome'); return c; };
const value = async (c: EditClient, form: string) => { const r = await c.form(form); assert.equal(r.error, undefined, JSON.stringify(r.error)); return r.value; };
const note = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir.dirs.notes, name)), { recursive: true }); fs.writeFileSync(path.join(dir.dirs.notes, name), text); return name; };
const textOf = async (c: EditClient, id: string) => JSON.parse(await value(c, `(with-current-buffer (%babel-note-buffer ${JSON.stringify(id)}) (buffer-string))`));
/* C-c C-c as a frame sends it: call{cmd} in the buffer with point (1-based) at NEEDLE. */
async function ctrlC(c: EditClient, id: string, needle: string, cmd = 'babel-execute-src-block'): Promise<Msg> {
  const text = await textOf(c, id), i = text.indexOf(needle);
  assert.ok(i >= 0, needle);
  return c.request({ t: 'call', cmd, args: [], buf: id, ctx: { point: i + 1 } });
}
const until = async (fn: () => unknown, what: string, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout waiting for ' + what); await new Promise(r => setTimeout(r, 25)); } };

test('R10.8 C-c C-c runs a scheme block in edwind and stores its result under it; a second run replaces it', async () => {
  const c = await client();
  const id = note('run.md', `# Run\n\n${fence}scheme {#n}\n(* 6 7)\n${fence}\nAfter.\n`);
  await value(c, `(%babel-note-buffer "run.md")`);
  const r = await ctrlC(c, id, '(* 6');
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.value, '#t'); assert.equal(r.msg, 'n: 42');
  assert.equal(await textOf(c, id), `# Run\n\n${fence}scheme {#n}\n(* 6 7)\n${fence}\n\n${fence}result {of=n}\n42\n${fence}\n\nAfter.\n`, 'a blank line before and after the result');
  await value(c, `(with-current-buffer (%babel-note-buffer "run.md") (goto-char 1) (search-forward "6 7") (replace-match "6 8"))`);
  assert.equal((await ctrlC(c, id, '```result')).msg, 'n: 48', 'C-c C-c on the result runs its block');
  const t = await textOf(c, id);
  assert.equal(t.split('```result').length, 2, 'one result, replaced'); assert.match(t, /\n48\n/);
  assert.equal((await ctrlC(c, id, 'After')).error!.report, 'No source block at point');
  c.close();
});

test('the R4.15 amendment: a note\'s definitions stay in its environment, out of the image log and the global one', async () => {
  const c = await client();
  const id = note('env.md', [`${fence}scheme {#a}`, '(define counter 0)', '(define-record-type pt (mk x) pt? (x px))', fence, `${fence}scheme {#b}`, '(set! counter (+ counter 1))', 'counter', fence, `${fence}scheme {#c env=other}`, '(environment-bound? (the-environment) (quote counter))', fence, ''].join('\n'));
  await value(c, `(%babel-note-buffer "env.md")`);
  const status = async () => (await c.request({ t: 'call', cmd: 'status', args: [] })).value as { imageGen: number };
  const before = (await status()).imageGen;
  assert.equal((await ctrlC(c, id, '(define counter')).msg, 'a: pt');
  assert.equal((await ctrlC(c, id, '(set!')).msg, 'b: 1');
  assert.equal((await ctrlC(c, id, '(set!')).msg, 'b: 2', 'the environment lasts between runs');
  assert.equal((await ctrlC(c, id, '(environment-bound?')).msg, 'c: #f', 'env= names another environment');
  assert.equal(await value(c, '(list (bound? (quote counter)) (bound? (quote mk)))'), '(#f #f)', 'nothing reached the global environment');
  assert.equal((await status()).imageGen, before, 'nothing entered the image log');
  /* Run all starts from a fresh environment: b counts 1 again. */
  const r = await c.form(`(babel-run "env.md")`);
  assert.equal(r.value, '3'); assert.equal(r.msg, 'Ran 3 blocks');
  assert.match(await textOf(c, id), /```result \{of=b\}\n1\n```/);
  c.close();
});

test('in= binds data fences, results, literals and tables; results=output and silent; an unspecified value leaves no result', async () => {
  const c = await client();
  const id = note('in.md', [
    `${fence}json {#cfg}`, '{"name": "w", "sizes": [1, 2, 3]}', fence,
    `${fence}csv {#rows}`, 'a,b', '1,"x,y"', fence,
    `${fence}sexp {#forms}`, '(1 2) sym', fence,
    `${fence}scheme {#total in=cfg,rows,forms,k=10,s="str"}`, "(list (cdr (assq 'name cfg)) (apply + (cdr (assq 'sizes cfg))) rows forms k s)", fence,
    `${fence}scheme {#uses in=t=total}`, '(length t)', fence,
    `${fence}scheme {#out results=output}`, '(display "printed") 99', fence,
    `${fence}scheme {#quiet results=silent}`, '(+ 1 1)', fence,
    `${fence}scheme {#none}`, '(if #f #f)', fence,
    `${fence}result {of=none}`, 'stale', fence,
    `${fence}scheme {#early in=x=later}`, 'x', fence,
    `${fence}scheme {#later}`, '1', fence, '',
  ].join('\n'));
  await value(c, `(%babel-note-buffer "in.md")`);
  assert.equal((await ctrlC(c, id, '(list (cdr')).msg, 'total: ("w" 6 (("a" "b") (1 "x,y")) ((1 2) sym) 10 "str")');
  assert.equal((await ctrlC(c, id, '(length t)')).msg, 'uses: 6', 'a stored result reads back as the value it wrote');
  assert.equal((await ctrlC(c, id, '(display "printed")')).msg, 'out: printed');
  assert.equal((await ctrlC(c, id, '(+ 1 1)')).msg, 'quiet: 2');
  assert.equal((await ctrlC(c, id, '(if #f #f)')).msg, 'none: no result');
  const r = await ctrlC(c, id, '\nx\n');
  assert.equal(r.msg, 'early failed: later has no result yet: run it first');
  const t = await textOf(c, id);
  assert.ok(!/of=quiet/.test(t), 'silent stores nothing'); assert.ok(!/stale/.test(t), 'no value removes a stale result');
  assert.match(t, /```result \{of=out\}\nprinted\n```/);
  assert.match(t, /```result \{of=early error\}\nlater has no result yet: run it first\n```/);
  c.close();
});

test('a failing block stores the condition as a failed result; run all stops there; quit is not a result', async () => {
  const c = await client();
  const id = note('fail.md', [`${fence}scheme {#one}`, '1', fence, `${fence}scheme {#two}`, '(car 1)', fence, `${fence}scheme {#three}`, '3', fence, `${fence}scheme {#raise}`, "(raise 'boom)", fence, `${fence}html {#card}`, '<b>x</b>', fence, ''].join('\n'));
  const r = await c.form('(babel-run "fail.md")');
  assert.equal(r.value, '1'); assert.equal(r.msg, 'Stopped at two: it failed (1 ran before it)');
  const t = await textOf(c, id);
  assert.match(t, /```result \{of=two error\}\ncar: expected pair, got 1\n```/); assert.ok(!/of=three/.test(t));
  assert.equal((await ctrlC(c, id, "(raise 'boom)")).msg, 'raise failed: raised boom');
  assert.equal((await ctrlC(c, id, '<b>')).error!.report, 'No executor for html blocks (babel-define-executor)');
  /* C-g (interrupt) ends the command with quit and stores nothing. */
  note('quit.md', `${fence}scheme {#slow}\n(sleep-for 30)\n${fence}\n`);
  await value(c, '(%babel-note-buffer "quit.md")');
  const rid = 'quit-1';
  c.send({ t: 'call', rid, cmd: 'babel-execute-src-block', args: [], buf: 'quit.md', ctx: { point: 20 } });
  await new Promise(r => setTimeout(r, 200));
  c.send({ t: 'interrupt', rid });
  const q = await c.next(m => m.rid === rid && m.t === 'result');
  assert.equal(q.error!.condition, 'quit');
  assert.ok(!/result/.test(await textOf(c, 'quit.md')), 'quit is not a result');
  c.close();
});

test('Org: C-c C-c writes #+RESULTS:, :var reads a named table, a list of lists becomes a table, :results output', async () => {
  const c = await client();
  const id = note('o.org', ['* Data', '#+name: t', '| x | y |', '|---+---|', '| 1 | 2 |', '| 3 | 4 |', '', '#+name: sums', '#+begin_src scheme :var t=t', '(map (lambda (r) (list (car r) (apply + r))) (cdr t))', '#+end_src', '', '#+begin_src scheme :results output', '(display "a\\n\\nb")', '#+end_src', '', 'Text.', ''].join('\n'));
  await value(c, '(%babel-note-buffer "o.org")');
  assert.equal((await ctrlC(c, id, '#+begin_src scheme :var')).msg, 'sums: a table');
  assert.equal((await ctrlC(c, id, '(display')).msg, 'the block at line 17: a', 'the first result moved it down');
  assert.equal(await textOf(c, id), ['* Data', '#+name: t', '| x | y |', '|---+---|', '| 1 | 2 |', '| 3 | 4 |', '', '#+name: sums', '#+begin_src scheme :var t=t', '(map (lambda (r) (list (car r) (apply + r))) (cdr t))', '#+end_src', '', '#+RESULTS: sums', '| 1 | 3 |', '| 3 | 7 |', '', '#+begin_src scheme :results output', '(display "a\\n\\nb")', '#+end_src', '', '#+RESULTS:', ': a', ':', ': b', '', 'Text.', ''].join('\n'));
  c.close();
});

test('R4.44 shell blocks run through the hub in the note\'s directory, with in= as shell variables; a failing status is a failed result', async () => {
  const c = await client();
  await until(async () => (await value(c, '(hub-status)')) === 'up', 'the hub');
  hub.programs.set("n=3\nprintf 'n=%s' \"$n\"", async io => { io.write('n=3\r\n'); return 0; });
  hub.programs.set('exit 2', async io => { io.write('oops\r\n'); return 2; });
  const id = note('sub/sh.md', [`${fence}sh {#count in=n=3}`, "printf 'n=%s' \"$n\"", fence, `${fence}bash {#bad}`, 'exit 2', fence, ''].join('\n'));
  await value(c, '(%babel-note-buffer "sub/sh.md")');
  assert.equal((await ctrlC(c, id, 'printf')).msg, 'count: n=3');
  const opens = await hub.waitFor(m => m.t === 'pty.open' && m.spawn && /printf/.test(m.spawn.argv[2]));
  assert.equal(opens[0].spawn.cwd, path.join(fs.realpathSync(dir.dirs.notes), 'sub'), 'the note\'s directory');
  assert.equal((await ctrlC(c, id, 'exit 2')).msg, 'bad failed: oops');
  const bash = await hub.waitFor(m => m.t === 'pty.open' && m.spawn && /exit 2/.test(m.spawn.argv[2]));
  assert.equal(bash[0].spawn.shell, 'bash');
  assert.match(await textOf(c, id), /```result \{of=bad error\}\noops\n\[exit 2\]\n```/);
  c.close();
});

test('babel-tangle writes the tangled files relative to the note through the buffers; a refused path is an error', async () => {
  const c = await client();
  const id = note('t/lit.md', [`${fence}scheme {#main noweb tangle=src/main.scm}`, '(define (main)', '  <<body>>)', fence, `${fence}scheme {#body}`, '(display "hi")', fence, `${fence}sh {tangle=yes}`, 'echo', fence, ''].join('\n'));
  await value(c, '(%babel-note-buffer "t/lit.md")');
  const r = await ctrlC(c, id, '(define (main)', 'babel-tangle');
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.value, '("t/src/main.scm" "t/lit.sh")');
  await until(() => fs.existsSync(path.join(dir.dirs.notes, 't/src/main.scm')), 'the tangled file');
  assert.equal(fs.readFileSync(path.join(dir.dirs.notes, 't/src/main.scm'), 'utf8'), '(define (main)\n  (display "hi"))\n');
  assert.equal(fs.readFileSync(path.join(dir.dirs.notes, 't/lit.sh'), 'utf8'), 'echo\n');
  assert.equal(JSON.parse(await value(c, '(babel--expand-path "~/a/b.scm" #f)')), path.join(dir.dirs.home, 'a/b.scm'), '~/ is the home of the user edwind runs as');
  fs.mkdirSync(path.join(dir.dirs.home, '.ssh'), { recursive: true });
  note('t/bad.md', `${fence}scheme {tangle=${path.join(dir.dirs.home, '.ssh/x.scm')}}\n1\n${fence}\n`);
  await value(c, '(%babel-note-buffer "t/bad.md")');
  const bad = await ctrlC(c, 't/bad.md', '1', 'babel-tangle');
  assert.equal(bad.error!.condition, 'file-error'); assert.match(bad.error!.report, /refused/);
  c.close();
});

test('a block removed while it runs leaves the result below it alone; tangle refuses the note itself and keeps name: as a file name; a plain call that cannot wait stores nothing', async () => {
  const c = await client(), c2 = await client();
  let release = () => {};
  const gate = new Promise<void>(r => { release = r; });
  hub.programs.set('sleep 5; echo A', async (io: any) => { await gate; io.write('A-OUTPUT\r\n'); return 0; });
  const A = `${fence}sh {#a}\nsleep 5; echo A\n${fence}\n`, B = `${fence}scheme {#b}\n(+ 1 1)\n${fence}\n\n${fence}result {of=b}\n2\n${fence}\n`;
  const race = note('race.md', A + B);
  await value(c, '(%babel-note-buffer "race.md")');
  const run = ctrlC(c, race, 'sleep 5');
  await new Promise(r => setTimeout(r, 300));
  await value(c2, `(with-current-buffer (%babel-note-buffer "race.md") (delete-region 1 ${A.length + 1}))`);
  release();
  assert.match((await run).error!.report, /a was removed while it ran/);
  assert.equal(await textOf(c, race), B, "a's output did not land on b");

  note('other.md', 'precious\n');
  await value(c, '(%babel-note-buffer "other.md")');
  const t = note('t.md', `${fence}scheme {tangle=name:other.md}\n(clobber)\n${fence}\n`);
  await value(c, '(%babel-note-buffer "t.md")');
  const r = await ctrlC(c, t, '(clobber', 'babel-tangle');
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(await textOf(c, 'other.md'), 'precious\n', 'the buffer named other.md is untouched');
  assert.equal(fs.readFileSync(path.join(dir.dirs.notes, 'name:other.md'), 'utf8'), '(clobber)\n', 'the file name:other.md got the text');

  const self = note('self.md', `# Prose\n\n${fence}md {tangle=yes}\nsnippet\n${fence}\n`);
  await value(c, '(%babel-note-buffer "self.md")');
  const s = await ctrlC(c, self, 'snippet', 'babel-tangle');
  assert.equal(s.error!.condition, 'file-error'); assert.match(s.error!.report, /cannot tangle onto itself/);
  assert.match(await textOf(c, self), /^# Prose/);

  const o = note('plain.org', '#+begin_src scheme\n(+ 1 2)\n#+end_src\n');
  const e = await c.form('(with-current-buffer (%babel-note-buffer "plain.org") (goto-char 20) (org-ctrl-c-ctrl-c))');
  assert.equal(e.error!.condition, 'cannot-block', JSON.stringify(e.error));
  assert.equal(await textOf(c, o), '#+begin_src scheme\n(+ 1 2)\n#+end_src\n', 'no result was stored');
  c.close(); c2.close();
});

test('R14.15 nothing runs on open', async () => {
  const c = await client();
  const id = note('open.md', `${fence}scheme {#x}\n(car 1)\n${fence}\n`);
  await c.open(id);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!/result/.test(await textOf(c, id)), 'opening the note ran nothing');
  assert.equal(await value(c, '(featurep (quote babel))'), '#t');
  c.close();
});
