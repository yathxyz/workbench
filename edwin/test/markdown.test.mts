// markdown-mode (spec §10.1 parity table, R10.1-R10.5) in the headless runtime: faces at positions, the
// ((reference)) overlays, folding, every command of the table, the task keyword table shared with Org,
// journal-today's file name and the font-lock budget (a keystroke in a 10,000-line page re-fontifies in
// 2 ms, never over the whole buffer). One Edwin per process, so the cases run in order on fresh buffers.
// Run: node --test edwin/test/markdown.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { startEdwin, FILES } from './headless.mts';

const ed = await startEdwin();
const ev = src => ed.eval(src);
// The dabbrev popup would take RET after three word characters; the wiki-capf case turns it back on.
ev('(set! corfu-auto #f)');
const EC = globalThis.EvilCore, MK = globalThis.Markdown;
let n = 0;
/* A fresh Markdown page named NAME (the page name is the file name without its extension) holding TEXT, point at its start, Normal state. */
async function page(text = '', name) {
  const file = (name || `page${++n}`) + '.md';
  if (EC.stateOf(ed.E.current) !== 'normal') await ed.keys('ESC');
  await ed.type(`:e ${file}\n`);
  assert.equal(ed.text(), '');
  if (text) ev(`(insert ${JSON.stringify(text)})`);
  ev('(goto-char 1)');
  assert.equal(ed.E.current.mode, 'markdown-mode');
  return ed.E.current;
}
const face = pos => { const f = ev(`(markdown-face-at ${pos})`); return f === false ? null : f.name; };
/* The face at the first character of NEEDLE in the buffer (plus OFF), 1-based positions for the Scheme side. */
const faceOf = (needle, off = 0) => { const i = ed.text().indexOf(needle); assert.ok(i >= 0, needle); return face(i + 1 + off); };
const posOf = (needle, off = 0) => { const i = ed.text().indexOf(needle); assert.ok(i >= 0, needle); return i + off; };
const line = () => { const t = ed.text(), p = ed.point(); return t.slice(t.lastIndexOf('\n', p - 1) + 1, t.indexOf('\n', p) < 0 ? t.length : t.indexOf('\n', p)); };

test('the shipped Scheme in scm/ is what index.html carries, markdown.js loads after org.js in both hosts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const name of ['emacs', 'evil', 'org', 'ai', 'init', 'notes-syntax', 'address', 'markdown']) {
    const m = new RegExp(`<script type="text/x-scheme" id="${name}-scm">\\n([\\s\\S]*?)</script>`).exec(html);
    assert.ok(m, name);
    assert.equal(m[1], readFileSync(new URL(`../scm/${name}.scm`, import.meta.url), 'utf8'), name + '.scm');
  }
  const tags = [...html.matchAll(/<script src="src\/([\w-]+)\.js"><\/script>/g)].map(m => m[1]);
  assert.equal(tags.indexOf('markdown'), tags.indexOf('org') + 1);
  assert.equal(FILES.indexOf('markdown'), FILES.indexOf('org') + 1);
});

test('boot: markdown.scm, notes-syntax.scm and address.scm are loaded through require with no error', () => {
  const feats = ev('(features)');
  const names = globalThis.L.arr(feats).map(s => s.name);
  for (const f of ['markdown', 'notes-syntax', 'address', 'org']) assert.ok(names.includes(f), f);
  assert.doesNotMatch(ed.Ed.getBuffer('*Messages*').text, /Error in/);
  for (const c of ['markdown-mode', 'markdown-outline-enter', 'markdown-demote', 'markdown-promote', 'markdown-todo-cycle', 'markdown-todo-cycle-backward',
    'wiki-follow', 'wiki-copy-ref', 'wiki-capf', 'journal-today', 'markdown-unlinked-mentions', 'markdown-ret', 'markdown-tab', 'markdown-follow-ref', 'consult-imenu'])
    assert.ok(ed.L.isCommand(ed.L.intern(c)), c);
  assert.equal(ev('(command-where \'markdown-unlinked-mentions)').name, 'server');
  assert.equal(ev('(command-where \'markdown-todo-cycle)').name, 'frame');
});

test('R10.1 .md files open in markdown-mode through auto-mode-alist; the mode derives from text-mode', async () => {
  await ed.type(':e notes/a.markdown\n');
  assert.equal(ed.E.current.mode, 'markdown-mode');
  await ed.type(':e notes/b.md\n');
  assert.equal(ed.E.current.mode, 'markdown-mode');
  assert.equal(ev('(derived-mode-p \'text-mode)').name, 'text-mode');
  assert.equal(ed.Ed.MODE_NAMES['markdown-mode'], 'Markdown');
  await ed.type(':e notes/c.org\n');
  assert.equal(ed.E.current.mode, 'org-mode');
  await ed.type(':e notes/d.txt\n');
  assert.notEqual(ed.E.current.mode, 'markdown-mode');
});

test('R10.1 faces: headings (ATX and Setext), lists, tasks, emphasis, code, links, images, tables, front matter', async () => {
  await page([
    '---', 'title: A page', 'tags: [x]', '---', '# Heading one', '## Heading two ^h2', '### Three', 'Setext one', '=====', 'Setext two', '---',
    '- plain item', '1. numbered', '- [ ] open box', '- [x] done box', '- TODO write **bold** and *italic* and ~~gone~~ and `code`',
    '- DONE finished thing', '- NEXT [#A] urgent', '- WAITING on #tag', 'key:: value', '- field:: in item', 'SCHEDULED: <2026-10-11 Sat>',
    'See [label](https://example.org/x) and <https://example.org/y> and https://example.org/z', '![alt text](img.png)',
    '> a quote', '| a | b |', '|---|:-:|', '| 1 | 2 |', '***', '```js', '# not a heading', 'code();', '```', 'after the fence',
  ].join('\n') + '\n');
  assert.equal(faceOf('---'), 'markdown-front-matter');
  assert.equal(faceOf('title:'), 'markdown-front-matter');
  assert.equal(faceOf('# Heading one'), 'markdown-markup');
  assert.equal(faceOf('Heading one'), 'markdown-heading-1');
  assert.equal(faceOf('Heading two'), 'markdown-heading-2');
  assert.equal(faceOf('^h2'), 'markdown-anchor');
  assert.equal(faceOf('Three'), 'markdown-heading-3');
  assert.equal(faceOf('Setext one'), 'markdown-heading-1');
  assert.equal(faceOf('====='), 'markdown-markup');
  assert.equal(faceOf('Setext two'), 'markdown-heading-2');
  assert.equal(face(posOf('Setext two') + 'Setext two\n'.length + 1), 'markdown-markup');
  assert.equal(faceOf('- plain item'), 'markdown-list');
  assert.equal(faceOf('plain item'), null);
  assert.equal(faceOf('1. numbered'), 'markdown-list');
  assert.equal(faceOf('[ ] open'), 'markdown-checkbox');
  assert.equal(faceOf('[x] done'), 'markdown-checkbox-done');
  assert.equal(faceOf('TODO write'), 'markdown-task-todo');
  assert.equal(faceOf('write **bold**'), null);
  assert.equal(faceOf('**bold**'), 'markdown-markup');
  assert.equal(faceOf('bold**'), 'markdown-bold');
  assert.equal(faceOf('italic*'), 'markdown-italic');
  assert.equal(faceOf('gone~~'), 'markdown-strike');
  assert.equal(faceOf('code`'), 'markdown-code');
  assert.equal(faceOf('DONE finished'), 'markdown-task-done');
  assert.equal(faceOf('finished thing'), 'markdown-task-done-text');
  assert.equal(faceOf('NEXT [#A]'), 'markdown-task-next');
  assert.equal(faceOf('[#A]'), 'markdown-priority');
  assert.equal(faceOf('WAITING on'), 'markdown-task-waiting');
  assert.equal(faceOf('#tag'), 'markdown-tag');
  assert.equal(faceOf('key:: value'), 'markdown-field-key');
  assert.equal(faceOf(':: value'), 'markdown-markup');
  assert.equal(faceOf('value'), null);
  assert.equal(faceOf('field:: in item'), 'markdown-field-key');
  assert.equal(faceOf('SCHEDULED:'), 'markdown-planning');
  assert.equal(faceOf('<2026-10-11 Sat>'), 'markdown-date');
  assert.equal(faceOf('label](https'), 'markdown-link');
  assert.equal(faceOf('https://example.org/x'), 'markdown-url');
  assert.equal(faceOf('<https://example.org/y>'), 'markdown-url');
  assert.equal(faceOf('https://example.org/z'), 'markdown-url');
  assert.equal(faceOf('![alt text]'), 'markdown-image');
  assert.equal(faceOf('a quote'), 'markdown-quote');
  assert.equal(faceOf('| a | b |', 2), 'markdown-table');
  assert.equal(faceOf('|---|:-:|'), 'markdown-table-delimiter');
  assert.equal(faceOf('***'), 'markdown-hr');
  assert.equal(faceOf('```js'), 'markdown-fence');
  assert.equal(faceOf('# not a heading'), 'markdown-code-block');
  assert.equal(faceOf('code();'), 'markdown-code-block');
  assert.equal(faceOf('after the fence'), null);
  const faces = globalThis.L.arr(ev('(markdown-faces)')).map(s => s.name);
  for (const f of ['markdown-heading-1', 'markdown-heading-6', 'markdown-bold', 'markdown-italic', 'markdown-code', 'markdown-link', 'markdown-wiki-link', 'markdown-block-ref',
    'markdown-task-todo', 'markdown-task-done', 'markdown-field-key', 'markdown-priority', 'markdown-anchor']) assert.ok(faces.includes(f), f);
  assert.ok(faces.every(f => f.startsWith('markdown-')));
});

test('R10.2 wiki links and block references: faces, raw on the point\'s line, display text elsewhere', async () => {
  await page('# Other\n\n## Plan\n\nfirst para of the plan\n- item one ^blk1\n- item two\n', 'Other');
  const other = ed.E.current;
  await page('# Page\n\nSee [[Other]] and [[Other|the label]] here.\n((Other › Plan ¶1)) is shown\nAnd ((Other#blk1)) and ((^blk1)) and ((Nowhere › Here))\n', 'Page');
  assert.equal(faceOf('[[Other]]'), 'markdown-markup');
  assert.equal(faceOf('Other]] and'), 'markdown-wiki-link');
  assert.equal(faceOf('|the label'), 'markdown-markup');
  assert.equal(faceOf('the label]]'), 'markdown-wiki-link');
  assert.equal(faceOf(' here.'), null);
  // Point is on line 1: every reference on another line is shown as its text.
  assert.equal(faceOf('((Other › Plan ¶1))'), 'markdown-block-ref-display');
  assert.equal(ev('(markdown-resolve-ref "Other › Plan ¶1")'), 'first para of the plan');
  assert.equal(ev('(markdown-resolve-ref "Other › Plan")'), 'Plan');
  assert.equal(ev('(markdown-resolve-ref "Other#blk1")'), 'item one ^blk1');
  assert.equal(ev('(markdown-resolve-ref "^blk1")'), 'item one ^blk1');
  assert.equal(ev('(markdown-resolve-ref "Other")'), 'Other');
  assert.equal(ev('(markdown-resolve-ref "Nowhere › Here")'), false);
  const ov = globalThis.L.arr(ev('(markdown-ref-overlays)'));
  assert.equal(ov.length, 4);
  assert.deepEqual(ov.map(v => v[2]), ['first para of the plan', 'item one ^blk1', 'item one ^blk1', 'Nowhere › Here · not found']);
  assert.equal(ed.text().slice(ov[0][0] - 1, ov[0][1] - 1), '((Other › Plan ¶1))');
  // On the point's line the reference is raw text, and no overlay covers it.
  ev(`(goto-char ${posOf('((Other › Plan ¶1))') + 3})`);
  assert.equal(faceOf('((Other › Plan ¶1))'), 'markdown-block-ref');
  assert.equal(globalThis.L.arr(ev('(markdown-ref-overlays)')).length, 3);
  // The resolution follows edits of the other page.
  const save = ed.E.current;
  ed.Ed.setWindowBuffer(other); ed.E.current = other;
  ev('(goto-char (point-max)) (insert "- item three ^blk1\\n")');
  ed.Ed.setWindowBuffer(save); ed.E.current = save;
  assert.equal(ev('(markdown-resolve-ref "Other#blk1")'), 'item one ^blk1');
  ed.Ed.setWindowBuffer(other); ed.E.current = other;
  ev(`(goto-char 1) (search-forward "item one ^blk1") (replace-match "item one")`);
  ed.Ed.setWindowBuffer(save); ed.E.current = save;
  assert.equal(ev('(markdown-resolve-ref "Other#blk1")'), 'item three ^blk1');
  // Pages that are not open resolve through resolve-ref-function (the frame runtime binds it).
  ev('(set! resolve-ref-function (lambda (a) (and (equal? a "Nowhere › Here") "from the index")))');
  assert.equal(ev('(markdown-resolve-ref "Nowhere › Here")'), 'from the index');
  ev('(set! resolve-ref-function #f)');
  // The link at point.
  ev(`(goto-char ${posOf('Other|the label') + 1})`);
  const lk = ev('(markdown-link-at)');
  assert.equal(lk[0].name, 'wiki'); assert.equal(lk[1], 'Other');
  ev(`(goto-char ${posOf('((Other#blk1))') + 4})`);
  assert.equal(ev('(markdown-link-at)')[0].name, 'ref');
  ev(`(goto-char ${posOf('here.') + 1})`);
  assert.equal(ev('(markdown-link-at)'), false);
});

test('wiki-follow: RET on a link calls wiki-follow-function; the default switches to an open page; a reference jumps to its block', async () => {
  ev('(define wiki-follow-log \'())');
  ev('(set! wiki-follow-function (lambda (t) (set! wiki-follow-log (cons t wiki-follow-log))))');
  await page('# Follow\n\nGo to [[Other|the other page]] now.\nThen ((Other › Plan ¶1)) here.\nplain line\n', 'Follow');
  ev(`(goto-char ${posOf('the other page') + 1})`);
  await ed.keys('RET');
  assert.deepEqual(globalThis.L.arr(ev('wiki-follow-log')), ['Other']);
  assert.equal(ed.E.current.name, 'Follow.md');
  // RET elsewhere is Vim's RET: the next line.
  ev(`(goto-char ${posOf('Then') + 1})`);
  await ed.keys('RET');
  assert.equal(line(), 'plain line');
  // A reference jumps into the other page, at the block.
  ev(`(goto-char ${posOf('((Other › Plan ¶1))') + 3})`);
  await ed.keys('RET');
  assert.equal(ed.E.current.name, 'Other.md');
  assert.equal(line(), 'first para of the plan');
  // The default follower switches to an open page of that name.
  ev('(set! wiki-follow-function #f)');
  await ed.type(':b Follow.md\n');
  ev(`(goto-char ${posOf('the other page') + 1})`);
  await ed.keys('RET');
  assert.equal(ed.E.current.name, 'Other.md');
  await ed.type(':b Follow.md\n');
  ev('(goto-char 1) (insert "[[Nobody]] ") (goto-char 3)');
  await ed.keys('RET');
  assert.equal(ed.E.current.name, 'Follow.md');
  assert.match(ed.Ed.getBuffer('*Messages*').text, /No page opener for \[\[Nobody\]\]/);
});

test('markdown-outline-enter: RET in Insert state makes a sibling bullet, counts numbers, keeps [ ], outdents or ends an empty item', async () => {
  await page();
  await ed.type('i- one\n'); assert.equal(ed.text(), '- one\n- ');
  await ed.type('two\n\n'); assert.equal(ed.text(), '- one\n- two\n');
  await ed.type('1. a\nb\n'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n3. ');
  await ed.type('\n'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n');
  await ed.type('- [ ] task\n'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n- [ ] task\n- [ ] ');
  await ed.type('\n'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n- [ ] task\n');
  await ed.type('  - nested\n'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n- [ ] task\n  - nested\n  - ');
  await ed.type('\n'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n- [ ] task\n  - nested\n- ');
  // The ended item's line is emptied and typing goes on there, as in app.js.
  await ed.type('\nplain text\nmore'); assert.equal(ed.text(), '- one\n- two\n1. a\n2. b\n- [ ] task\n  - nested\nplain text\nmore');
  await ed.keys('ESC');
  // Enter in the middle of an item splits it into two items.
  await page('- alpha beta\n');
  ev('(goto-char 9)'); await ed.type('i\n'); await ed.keys('ESC');
  assert.equal(ed.text(), '- alpha \n- beta\n');   // the first half keeps its trailing space, as app.js leaves it
  // Emacs state has the same RET.
  await page('- x\n');
  await ed.keys('C-z'); assert.equal(EC.stateOf(ed.E.current), 'emacs');
  ev('(goto-char 4)'); await ed.keys('RET');
  assert.equal(ed.text(), '- x\n- \n');
  await ed.keys('RET'); assert.equal(ed.text(), '- x\n\n');
  await ed.keys('C-z');
});

test('markdown-demote and markdown-promote: TAB and S-TAB indent list items by two, in Insert, Visual and Normal state', async () => {
  await page('- one\n- two\n- three\nparagraph\n');
  await ed.type('A'); await ed.keys('TAB'); assert.equal(ed.text(), '  - one\n- two\n- three\nparagraph\n');
  await ed.keys('TAB'); assert.equal(ed.text(), '    - one\n- two\n- three\nparagraph\n');
  await ed.keys('S-TAB'); assert.equal(ed.text(), '  - one\n- two\n- three\nparagraph\n');
  await ed.keys('S-TAB'); await ed.keys('S-TAB'); assert.equal(ed.text(), '- one\n- two\n- three\nparagraph\n');
  await ed.keys('ESC');
  await ed.type('jVj'); await ed.keys('TAB'); assert.equal(ed.text(), '- one\n  - two\n  - three\nparagraph\n');
  assert.equal(EC.stateOf(ed.E.current), 'normal');
  await ed.type('Vj'); await ed.keys('S-TAB'); assert.equal(ed.text(), '- one\n- two\n- three\nparagraph\n');
  // Normal state TAB on a list item indents it too (headings fold instead, below).
  await ed.type('gg'); await ed.keys('TAB'); assert.equal(ed.text(), '  - one\n- two\n- three\nparagraph\n');
  await ed.keys('S-TAB'); assert.equal(ed.text(), '  - one\n- two\n- three\nparagraph\n');   // S-TAB in Normal state cycles the outline
  await ed.type('A'); await ed.keys('S-TAB'); assert.equal(ed.text(), '- one\n- two\n- three\nparagraph\n');
  await ed.keys('ESC');
  ev(`(goto-char ${posOf('paragraph') + 1})`);
  assert.equal(ev('(%markdown-shift-lines 1)'), false);  // not a list item: the paragraph line
  ev('(goto-char (point-max))');
  assert.equal(ev('(%markdown-shift-lines 1)'), false);
});

test('markdown-todo-cycle: C-c C-t and S-<right>/S-<left> step TODO, NEXT, WAITING, DONE; aliases join their column', async () => {
  await page('- TODO write\n- plain item\n- DOING now\n# HOLD heading\nSOMEDAY text\n');
  await ed.keys('C-c C-t'); assert.equal(line(), '- NEXT write');
  await ed.keys('S-<right>'); assert.equal(line(), '- WAITING write');
  await ed.keys('S-<right>'); assert.equal(line(), '- DONE write');
  await ed.keys('S-<right>'); assert.equal(line(), '- TODO write');
  await ed.keys('S-<left>'); assert.equal(line(), '- DONE write');
  assert.match(ed.Ed.getBuffer('*Messages*').text, /TODO state: DONE/);
  await ed.type('j'); await ed.keys('C-c C-t'); assert.equal(line(), '- TODO plain item');
  await ed.keys('S-<left>'); await ed.keys('S-<left>'); assert.equal(line(), '- WAITING plain item');
  await ed.type('j'); await ed.keys('C-c C-t'); assert.equal(line(), '- WAITING now');
  await ed.type('j'); await ed.keys('C-c C-t'); assert.equal(line(), '# DONE heading');
  await ed.type('j'); await ed.keys('C-c C-t'); assert.equal(line(), 'NEXT text');
  ev('(goto-char (point-max))'); assert.throws(() => ev('(%markdown-todo-cycle #f)'), /Not on a task line/);
  ev('(define todo-hook-ran 0) (add-hook! \'markdown-after-todo-state-change-hook (lambda () (set! todo-hook-ran (+ todo-hook-ran 1))))');
  await ed.type('gg'); await ed.keys('C-c C-t');
  assert.equal(ev('todo-hook-ran'), 1);
});

test('R10.3 folding by heading: TAB on a heading folds, S-TAB cycles the buffer, zc zo za fold (the Org overlay code)', async () => {
  await page('# One\n\nbody one\n\n## Two\n\nbody two\n\n# Three\n\nbody three\n');
  const b = ed.E.current;
  await ed.keys('TAB');
  assert.ok(b.folds && b.folds.length === 1, 'folded');
  assert.equal(ev(`(org-fold-hidden-p ${posOf('body one') + 1})`), true);
  assert.equal(ev(`(org-fold-hidden-p ${posOf('body three') + 1})`), false);
  await ed.keys('TAB');   // children
  assert.equal(ev(`(org-fold-hidden-p ${posOf('body one') + 1})`), false);
  assert.equal(ev(`(org-fold-hidden-p ${posOf('body two') + 1})`), true);
  await ed.keys('TAB');   // subtree
  assert.equal(b.folds.length, 0);
  await ed.keys('S-TAB'); // overview
  assert.equal(b.folds.length, 2);
  assert.equal(ev(`(org-fold-hidden-p ${posOf('body three') + 1})`), true);
  await ed.keys('S-TAB'); // contents
  assert.equal(ev(`(org-fold-hidden-p ${posOf('## Two') + 1})`), false);
  assert.equal(ev(`(org-fold-hidden-p ${posOf('body two') + 1})`), true);
  await ed.keys('S-TAB'); // show all
  assert.equal(b.folds.length, 0);
  await ed.type('zc'); assert.equal(ev(`(org-fold-hidden-p ${posOf('body one') + 1})`), true);
  await ed.type('zo'); assert.equal(ev(`(org-fold-hidden-p ${posOf('body one') + 1})`), false);
  await ed.type('za'); assert.equal(ev(`(org-fold-hidden-p ${posOf('body one') + 1})`), true);
  await ed.type('za'); assert.equal(ev(`(org-fold-hidden-p ${posOf('body one') + 1})`), false);
  // Folded lines are skipped by the lexer: the shown segment has no classes for hidden text.
  await ed.type('zc');
  const faces = MK.facesOf(b, 0, b.rope.length);
  assert.equal(faces[posOf('body one')], '');
});

test('R10.4 motions: ]] and [[ move by heading, gj and gk by visual line', async () => {
  await page('# One\nline a\nline b\n## Two\nline c\n# Three\n');
  await ed.type(']]'); assert.equal(line(), '## Two');
  await ed.type(']]'); assert.equal(line(), '# Three');
  await ed.type('[['); assert.equal(line(), '## Two');
  await ed.type('[['); assert.equal(line(), '# One');
  await ed.type('gj'); assert.equal(line(), 'line a');
  await ed.type('gj'); assert.equal(line(), 'line b');
  await ed.type('gk'); assert.equal(line(), 'line a');
});

test('R10.2 one task keyword table: notes-syntax.scm feeds both Org and markdown-mode, and a change reaches both', async () => {
  assert.deepEqual(globalThis.L.arr(ev('notes-task-keywords')), ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED', 'DOING', 'NOW', 'LATER']);
  assert.deepEqual(globalThis.L.arr(ev('notes-done-keywords')), ['DONE', 'CANCELLED']);
  assert.deepEqual(globalThis.L.arr(globalThis.L.arr(ev('org-todo-keywords'))[0]).map(x => x.name || x),
    ['sequence', 'TODO(t)', 'NEXT(n)', 'WAITING(w@/!)', 'HOLD(h@/!)', 'SOMEDAY(s)', '|', 'DONE(d!)', 'CANCELLED(c@/!)']);
  assert.equal(ev('(notes-task-keyword-base "DOING")'), 'NEXT');
  const saved = ev('notes-task-keyword-table');
  try {
    ev('(notes-set-task-keywords! \'(("TODO" "t" #f #f) ("BLOCKED" "b" #f #f) ("DONE" "d" #t #f) ("SHIPPED" "s" #t #f) ("NOW" #f #f "TODO")))');
    assert.deepEqual(globalThis.L.arr(ev('notes-task-keywords')), ['TODO', 'BLOCKED', 'DONE', 'SHIPPED', 'NOW']);
    assert.deepEqual(globalThis.L.arr(ev('notes-done-keywords')), ['DONE', 'SHIPPED']);
    assert.deepEqual(globalThis.L.arr(globalThis.L.arr(ev('org-todo-keywords'))[0]).map(x => x.name || x), ['sequence', 'TODO(t)', 'BLOCKED(b)', '|', 'DONE(d)', 'SHIPPED(s)']);
    // Markdown reads the new set at once.
    await page('- BLOCKED by x\n- SHIPPED done\n- WAITING gone\n');
    assert.equal(faceOf('BLOCKED'), 'markdown-task-other');
    assert.equal(faceOf('SHIPPED'), 'markdown-task-other-done');
    assert.equal(faceOf('done'), 'markdown-task-done-text');
    assert.equal(faceOf('WAITING'), null);
    // Org cycles through the new set in an .org buffer.
    await ed.type(':e kw.org\n');
    ev('(insert "* TODO task\\n") (goto-char 1)');
    ev('(org-todo)'); assert.match(ed.text(), /^\* BLOCKED task/);
    ev('(org-todo)'); assert.match(ed.text(), /^\* DONE task/);
    ev('(org-todo)'); assert.match(ed.text(), /^\* SHIPPED task/);
  } finally {
    globalThis.L.set('saved-task-table', saved);
    ev('(notes-set-task-keywords! saved-task-table)');
  }
  assert.deepEqual(globalThis.L.arr(ev('notes-task-keywords')), ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED', 'DOING', 'NOW', 'LATER']);
  assert.ok(globalThis.L.arr(globalThis.L.arr(ev('org-todo-keywords'))[0]).includes('WAITING(w@/!)'));
  const g = Object.fromEntries(globalThis.L.arr(ev('(notes-grammar)')).map(p => [p.car.name, p.cdr]));
  assert.deepEqual(globalThis.L.arr(g['task-keywords']), ['TODO', 'NEXT', 'WAITING', 'HOLD', 'SOMEDAY', 'DONE', 'CANCELLED', 'DOING', 'NOW', 'LATER']);
  assert.equal(g['task-keyword-table'], undefined);   // the grammar keeps the index's keys; the table is notes-task-keyword-table
  assert.equal(globalThis.L.arr(ev('notes-task-keyword-table')).length, 10);
});

test('wiki-copy-ref puts ((Name › Heading ¶N "quote")) on the kill ring and the clipboard', async () => {
  await page('# Notes\n\n## Plan\n\nfirst para\n- item "one"\n- item two\n', 'Notes');
  ev(`(goto-char ${posOf('item two') + 1})`);
  assert.equal(ev('(markdown-page-name)'), 'Notes');
  await ed.keys('C-c C-w');
  assert.equal(ed.E.killRing[0], '((Notes › Plan ¶3 "item two"))');
  assert.equal(ed.host.clipboard, '((Notes › Plan ¶3 "item two"))');
  assert.equal(ev('(format-address (block-address "Notes" (buffer-string) (- (point) 1)))'), 'Notes › Plan ¶3 "item two"');
  // The copied reference resolves back to its line.
  assert.equal(ev('(markdown-resolve-ref "Notes › Plan ¶3 \\"item two\\"")'), 'item two');
  // A buffer-local page name wins over the file name (the board binds the card's name).
  ev('(setq-local page-name "The Board Card")');
  assert.equal(ev('(markdown-page-name)'), 'The Board Card');
  assert.equal(ev('(markdown-block-ref-at-point)'), '((The Board Card › Plan ¶3 "item two"))');
  ev('(setq-local page-name #f)');
  assert.equal(ev('(markdown-page-name)'), 'Notes');
});

test('wiki-capf: candidates from wiki-candidates and the open pages after [[, closed with ]], also by itself while typing', async () => {
  ev('(set! wiki-candidates \'("Alpha" "Alps" "Beta"))');
  ev('(set! corfu-auto #t) (set! electric-pair-enabled #f)');
  await page();
  await ed.type('iSee [[Al');
  assert.ok(ed.E.corfu && ed.E.corfu.wiki, 'the popup opened by itself after [[Al');
  assert.deepEqual(ed.E.corfu.cands.map(c => c.text), ['Alpha]]', 'Alps]]']);
  await ed.keys('RET');
  assert.equal(ed.text(), 'See [[Alpha]]');
  assert.equal(ed.E.corfu, null);
  // With electric pairs (the default) the brackets are already closed, so the name alone is inserted.
  ev('(set! electric-pair-enabled #t)');
  await ed.type(' and [[');
  assert.equal(ed.text(), 'See [[Alpha]] and [[]]');
  assert.ok(ed.E.corfu && ed.E.corfu.wiki);
  assert.ok(ed.E.corfu.cands.some(c => c.text === 'Notes' && c.ann === 'page'), 'open pages are offered');
  await ed.type('be'); assert.deepEqual(ed.E.corfu.cands.map(c => c.text), ['Beta']);
  await ed.keys('TAB'); assert.equal(ed.text(), 'See [[Alpha]] and [[Beta]]');
  // The command itself, with the automatic popup off.
  ev('(set! corfu-auto #f)');
  await ed.keys('<right>'); await ed.keys('<right>');
  await ed.type(' [[alp'); assert.equal(ed.E.corfu, null);
  ev('(wiki-capf)');
  assert.deepEqual(ed.E.corfu.cands.map(c => c.text), ['Alpha', 'Alps']);
  await ed.keys('RET'); assert.equal(ed.text(), 'See [[Alpha]] and [[Beta]] [[Alpha]]');
  await ed.keys('ESC');
  ev('(goto-char 1)');
  assert.throws(() => ev('(wiki-capf)'), /No \[\[link to complete/);
  ev('(set! wiki-candidates \'()) (set! corfu-auto #f)');
});

test('journal-today opens notes-directory/journal/YYYY-MM-DD.md, or .org when journal-format is org', async () => {
  const today = ev('(journal-day-string)');
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date(); assert.equal(today, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  assert.equal(ev('(journal-day-string 0)'), new Date(0).getFullYear() + '-01-01');
  assert.equal(ev('(journal-file-name "2026-10-14")'), 'journal/2026-10-14.md');
  ev('(set! notes-directory "/home/u/roam")');
  assert.equal(ev('(journal-file-name "2026-10-14")'), '/home/u/roam/journal/2026-10-14.md');
  ev('(set! notes-directory "/home/u/roam/")');
  assert.equal(ev('(journal-file-name "2026-10-14")'), '/home/u/roam/journal/2026-10-14.md');
  ev('(set! journal-format \'org)');
  assert.equal(ev('(journal-file-name "2026-10-14")'), '/home/u/roam/journal/2026-10-14.org');
  ev('(set! journal-format "org")');
  assert.equal(ev('(journal-file-name "2026-10-14")'), '/home/u/roam/journal/2026-10-14.org');
  ev('(set! journal-format "md") (set! notes-directory "")');
  await ed.keys('C-c C-j');
  assert.equal(ed.E.current.file, `journal/${today}.md`);
  assert.equal(ed.E.current.mode, 'markdown-mode');
  assert.equal(ed.text(), '');
});

test('imenu lists the headings (not those inside fences); consult-imenu uses them in Markdown buffers', async () => {
  await page('# One\ntext\n## Two\n```\n# not this\n```\n### Three\n');
  const items = globalThis.L.arr(ev('(markdown-imenu-items)')).map(p => [p.car, p.cdr.car.name, p.cdr.cdr]);
  assert.deepEqual(items, [['One', 'heading', 1], ['  Two', 'heading', 12], ['    Three', 'heading', 38]]);
  assert.ok(ed.L.isCommand(ed.L.intern('consult-imenu')));
  await ed.keys('M-g i');            // consult-imenu (SPC i in Normal state); the prompt lists the headings
  assert.ok(ed.E.mini, 'the heading prompt is open');
  await ed.type('Three\n');
  assert.equal(ed.E.mini, null);
  assert.equal(line(), '### Three');
});

test('markdown-unlinked-mentions runs on the server (:where server); in a frame runtime it says so', () => {
  assert.equal(ev('(command-where \'markdown-unlinked-mentions)').name, 'server');
  assert.throws(() => ev('(markdown-unlinked-mentions)'), /needs the notes index of the server/);
});

test('R10.5 font-lock is incremental: a keystroke in a 10,000-line page re-fontifies in 2 ms (median of 50) and lexes only the shown lines', async () => {
  const lines = [];
  for (let i = 0; i < 10000; i++) {
    if (i % 50 === 0) lines.push(`# Section ${i / 50}`);
    else if (i % 97 === 1) lines.push('```js');
    else if (i % 97 === 6) lines.push('```');
    else lines.push(`- TODO item ${i} with **bold** text, [[Page ${i % 40}]] and ((Other › Plan ¶1)) key:: v${i} ^a${i}`);
  }
  const b = await page(lines.join('\n') + '\n', 'big');
  assert.ok(b.rope.length > 500000);
  // Fences open at lines 1, 98, 195... and close five lines later, so line 150 (Section 3) is outside one.
  const r0 = b.rope, mid = r0.indexOf('item 5001'); assert.ok(mid > 0);
  const from = Ed_bol(b, mid - 2000), to = Ed_eol(b, mid + 2000) + 1;
  ev(`(goto-char ${mid + 1})`);
  await ed.type('A');   // Insert state at the end of the line of point
  // Warm up: the first lex of the segment builds the fence index once.
  ev('(markdown-reset-stats)');
  globalThis.Ed.hooks.lexSeg(b, from, to, b.rope.slice(from, to));
  let st = stats(); assert.equal(st['fence-scans'], 1); assert.ok(st.lexed <= to - from);
  ev('(markdown-reset-stats)');
  const times = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    await ed.type(i % 10 === 9 ? '`' : 'x');          // backticks too: the fence index must not be rebuilt
    const seg = b.rope.slice(from, to);
    const lx = globalThis.Ed.hooks.lexSeg(b, from, to, seg);
    times.push(performance.now() - t0);
    assert.equal(lx.cls.length, seg.length);
  }
  st = stats();
  times.sort((a, c) => a - c);
  const median = times[25];
  console.log(`markdown font-lock: median ${median.toFixed(3)} ms per keystroke over ${(to - from)} shown chars, max ${times[49].toFixed(3)} ms; lexed ${st.lexed} chars in ${st['lex-calls']} calls, fence scans ${st['fence-scans']}, fence updates ${st['fence-updates']}`);
  assert.ok(median <= 2, `median ${median} ms`);
  assert.equal(st['fence-scans'], 0, 'the fence index was updated from the edits, never rebuilt');
  assert.equal(st['lex-calls'], 50);
  assert.ok(st.lexed <= 50 * (to - from + 60), 'only the shown segment is lexed per keystroke, not the buffer');
  assert.ok(st.lexed < b.rope.length, 'fifty keystrokes lexed less than one pass over the buffer');
  await ed.keys('ESC');
  // The fence index stays right after incremental updates: a heading after the edited fence lines is still a heading.
  const full = MK.fenceIndex(b), fresh = []; for (let k = b.rope.indexOf('```'); k >= 0; k = b.rope.indexOf('```', k + 1)) { const ls = Ed_bol(b, k); if (/^\s*$/.test(b.rope.slice(ls, k)) && !fresh.includes(ls)) fresh.push(ls); }
  assert.deepEqual(full, fresh.sort((x, y) => x - y));
  // An edit that opens a fence changes the context of the lines after it, from the changed line on.
  ev(`(goto-char ${b.rope.indexOf('# Section 3') + 1})`);
  await ed.type('O```'); await ed.keys('ESC');
  assert.equal(faceOf('# Section 3'), 'markdown-code-block');
  assert.equal(stats()['fence-scans'], 0);
  await ed.type('dd');
  assert.equal(faceOf('# Section 3', 2), 'markdown-heading-1');   // the # marker itself is markup
});
const Ed_bol = (b, p) => globalThis.Ed.bol(b.rope, p), Ed_eol = (b, p) => globalThis.Ed.eol(b.rope, p);
const stats = () => Object.fromEntries(globalThis.L.arr(ev('(markdown-stats)')).map(p => [p.car.name, p.cdr]));
