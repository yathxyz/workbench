// The editor-level Scheme of E0: markers, change hooks, advice, minor and derived modes, buffer-locals,
// and the user's own init file (R4.11, R4.22–R4.26, R6.11, R6.12). `node --test edwin/test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdwin } from './headless.mjs';

// A user config directory: init.scm runs after the shipped files (R4.11).
const configDir = mkdtempSync(join(tmpdir(), 'edwin-config-'));
mkdirSync(join(configDir, 'lisp'));
writeFileSync(join(configDir, 'init.scm'), `
(define user-init-saw-evil (procedure? evil-mode))
(define user-init-saw-org (command? 'org-todo))
(defvar user-init-loaded #t "Set by the user's init.scm.")
`);
writeFileSync(join(configDir, 'lisp', 'greet.scm'), `(define (greet who) (string-append "hello " who)) (provide 'greet)`);
const ed = await startEdwin({ configDir });
const ev = src => ed.eval(src);
const sym = v => (v && v.name !== undefined ? v.name : v);
let n = 0;
async function fresh(text = '') {
  await ed.type(`:e s${++n}.txt\n`);
  if (text) ev(`(insert ${JSON.stringify(text)})`);
  ev('(goto-char 1)');
}

test("the user's init.scm runs after every shipped file", () => {
  assert.equal(ev('user-init-loaded'), true);
  assert.equal(ev('user-init-saw-evil'), true);
  assert.equal(ev('user-init-saw-org'), true);
});

test('markers: before and after insertion types, point is an after marker (R6.11)', async () => {
  await fresh('abcdef');
  ev('(define m-before (copy-marker 3)) (define m-after (copy-marker 3 #t))');
  ev('(goto-char 3) (insert "XY")');
  assert.equal(ev('(marker-position m-before)'), 3);
  assert.equal(ev('(marker-position m-after)'), 5);
  assert.equal(ev('(point)'), 5);
  assert.equal(ev('(marker-insertion-type m-after)'), true);
  ev('(goto-char 1) (insert "Q")');
  assert.equal(ev('(marker-position m-before)'), 4);
  assert.equal(ev('(marker-position m-after)'), 6);
  ev('(set-marker-insertion-type m-before #t)');
  assert.equal(ev('(marker-insertion-type m-before)'), true);
  assert.equal(sym(ev('(marker-buffer m-before)').name), `s${n}.txt`);
});

test('markers: a deletion covering a marker moves it to the start; undo puts it back (R6.12)', async () => {
  await fresh('0123456789');
  ev('(define m (copy-marker 6)) (define m-end (copy-marker 8))');
  await ed.type('0lld4l');   // delete "2345" (positions 3..6), which covers m at 6
  assert.equal(ed.text(), '016789');
  assert.equal(ev('(marker-position m)'), 3);
  assert.equal(ev('(marker-position m-end)'), 4);
  await ed.type('u');
  assert.equal(ed.text(), '0123456789');
  assert.equal(ev('(marker-position m)'), 6);
  assert.equal(ev('(marker-position m-end)'), 8);
});

test('markers: a replacement keeps an after marker inside it at the end of the new text (R6.12)', async () => {
  await fresh('hello world');
  const b = ed.E.current;
  const after = b.marker(8, 'after'), before = b.marker(8);
  ed.Ed.shiftMarkers(b, 6, 5, 3, null);   // as one op: "world" (6..11) becomes 3 characters
  assert.equal(after.pos, 9);
  assert.equal(before.pos, 6);
  const atEnd = b.marker(11);
  ed.Ed.shiftMarkers(b, 6, 5, 2, null);
  assert.equal(atEnd.pos, 8);
});

test('markers: marks and jumps follow edits; positions accept markers', async () => {
  await fresh('one two three');
  ev('(goto-char 9) (evil-set-marker #\\a)');
  ev('(goto-char 1) (insert ">> ")');
  assert.equal(ev('(evil-get-marker #\\a)'), 12);
  ev('(goto-char (copy-marker 4))');
  assert.equal(ev('(point)'), 4);
  ev('(set-mark 5) (goto-char 1) (insert "__")');
  assert.equal(ev('(mark)'), 7);
  assert.equal(ev('(marker-position (mark-marker))'), 7);
});

test('change hooks get 1-based (beg end) and (beg end old-len), with the changed buffer current (R4.22)', async () => {
  await fresh('abc');
  ev(`(define changes '())
      (define (note-before b e) (set! changes (cons (list 'before b e (buffer-name (current-buffer))) changes)))
      (define (note-after b e len) (set! changes (cons (list 'after b e len (edit-origin)) changes)))
      (add-hook! 'before-change-functions note-before)
      (add-hook! 'after-change-functions note-after)`);
  ev('(goto-char 2) (insert "XY") (delete-region 1 2)');
  const got = ev('(reverse changes)');
  ev(`(remove-hook! 'before-change-functions note-before) (remove-hook! 'after-change-functions note-after)`);
  assert.equal(ed.L.write(got), `((before 2 2 "s${n}.txt") (after 2 4 0 local) (before 1 2 "s${n}.txt") (after 1 1 1 local))`);
});

test('change hooks run for undo, see edit-origin, and a failing one is removed (R4.22, R4.23)', async () => {
  await fresh('abc');
  ev(`(define seen '())
      (define (note b e len) (set! seen (cons (edit-origin) seen)))
      (define (broken b e len) (car '()))
      (add-hook! 'after-change-functions note)
      (add-hook! 'after-change-functions broken)`);
  await ed.type('x');
  assert.equal(ed.text(), 'bc');
  assert.ok(!ed.L.arr(ev('after-change-functions')).some(f => f.procName === 'broken'), 'broken was removed');
  await ed.type('u');
  assert.equal(ed.text(), 'abc');
  ed.Ed.withOrigin('remote', () => ev('(goto-char 1) (insert "r")'));
  assert.equal(ed.L.write(ev('(reverse seen)')), '(local local remote)');
  ev(`(remove-hook! 'after-change-functions note)`);
});

test('a change hook does not run for the edits it makes itself', async () => {
  await fresh('abc');
  ev(`(define depth 0)
      (define (echo b e len) (set! depth (+ depth 1)) (save-excursion (goto-char (point-max)) (insert "!")))
      (add-hook! 'after-change-functions echo)`);
  ev('(goto-char 1) (insert "z")');
  ev(`(remove-hook! 'after-change-functions echo)`);
  assert.equal(ed.text(), 'zabc!');
  assert.equal(ev('depth'), 1);
});

test('buffer-local hooks: #t in the local value runs the global functions too', async () => {
  await fresh();
  ev(`(define hits '())
      (define-command (local-cmd) (interactive) #t)
      (add-hook! 'post-command-hook (lambda () (set! hits (cons 'global hits))))
      (make-local-variable 'post-command-hook)
      (setq-local post-command-hook (list (lambda () (set! hits (cons 'local hits))) #t))`);
  await ed.keys('M-x'); await ed.type('local-cmd\n');
  const h = ed.L.write(ev('hits'));
  assert.ok(h.includes('local') && h.includes('global'), h);
  ev('(kill-local-variable (quote post-command-hook)) (set! post-command-hook (quote ()))');
});

test('other hook variables run: pre-command, find-file, kill-buffer, buffer-list-update, window change', async () => {
  ev(`(define fired '())
      (define (mark-fired name) (lambda args (unless (memq name fired) (set! fired (cons name fired)))))
      (for-each (lambda (h) (add-hook! h (mark-fired h)))
        '(pre-command-hook find-file-hook kill-buffer-hook buffer-list-update-hook window-configuration-change-hook))`);
  await ed.type(':e hooks.txt\n');
  await ed.keys('C-x 2'); await ed.keys('C-x 1');
  ev('(kill-buffer (get-buffer-create "doomed"))');
  const fired = ed.L.arr(ev('fired')).map(sym);
  for (const h of ['pre-command-hook', 'find-file-hook', 'kill-buffer-hook', 'buffer-list-update-hook', 'window-configuration-change-hook']) assert.ok(fired.includes(h), h);
  for (const h of ['pre-command-hook', 'find-file-hook', 'kill-buffer-hook', 'buffer-list-update-hook', 'window-configuration-change-hook']) ev(`(set! ${h} '())`);
});

test('advice: all six kinds, in the order Emacs runs them, and advice-remove (R4.24)', () => {
  ev(`(define (twice x) (* 2 x))
      (define log '())
      (define (adv-before x) (set! log (cons (list 'before x) log)))
      (define (adv-after x) (set! log (cons (list 'after x) log)))
      (define (adv-around orig x) (+ 1 (orig x)))
      (define (adv-args args) (list (+ 10 (car args))))
      (define (adv-ret r) (* r 100))`);
  ev(`(advice-add 'twice :before adv-before)`);
  assert.equal(ev('(twice 3)'), 6);
  ev(`(advice-add 'twice :around adv-around)`);
  assert.equal(ev('(twice 3)'), 7);
  ev(`(advice-add 'twice :filter-args adv-args)`);
  assert.equal(ev('(twice 3)'), 27);
  ev(`(advice-add 'twice :filter-return adv-ret)`);
  assert.equal(ev('(twice 3)'), 2700);
  ev(`(advice-add 'twice :after adv-after)`);
  assert.equal(ev('(twice 3)'), 2700);
  assert.equal(ed.L.write(ev('(reverse log)')), '((before 3) (before 3) (before 13) (before 13) (before 13) (after 3))');
  for (const f of ['adv-before', 'adv-around', 'adv-args', 'adv-ret', 'adv-after']) ev(`(advice-remove 'twice ${f})`);
  assert.equal(ev('(twice 3)'), 6);
  ev(`(advice-add 'twice :override (lambda (x) 'over))`);
  assert.equal(sym(ev('(twice 3)')), 'over');
});

test('advice survives redefinition, keeps a command interactive, and shows in describe-function', async () => {
  await fresh('abc');
  ev(`(define-command (shout-here) "Insert a shout." (interactive) (insert "!"))
      (define (louder orig) (orig) (insert "!"))
      (advice-add 'shout-here :around louder '((name . louder)))`);
  assert.equal(ev('(command? (quote shout-here))'), true);
  await ed.keys('M-x'); await ed.type('shout-here\n');
  assert.equal(ed.text(), '!!abc');
  ev(`(define-command (shout-here) "Insert a shout." (interactive) (insert "?"))`);
  ev('(shout-here)');
  assert.equal(ed.text(), '!!?!abc');
  ev(`(describe-function 'shout-here)`);
  assert.match(ed.Ed.getBuffer('*Help*').text, /:around louder/);
  ev(`(advice-remove 'shout-here 'louder)`);
  assert.equal(ev(`(advice-member-p 'louder 'shout-here)`), false);
});

test('buffer-local variables: make-local-variable, setq-local, defvar-local, default-value (R4.26)', async () => {
  ev('(defvar my-width 80)');
  await fresh();
  const a = ed.E.current;
  ev('(setq-local my-width 100)');
  assert.equal(ev('my-width'), 100);
  assert.equal(ev('(default-value (quote my-width))'), 80);
  await fresh();
  assert.equal(ev('my-width'), 80);
  ev('(set! my-width 90)');
  assert.equal(ev('(default-value (quote my-width))'), 90);
  assert.equal(ev(`(buffer-local-value 'my-width (get-buffer "${a.name}"))`), 100);
  ev('(defvar-local my-tag (quote none))');
  ev(`(set! my-tag 'here)`);
  assert.equal(sym(ev('(default-value (quote my-tag))')), 'none');
  assert.equal(ev(`(local-variable-p 'my-tag)`), true);
  ev(`(kill-local-variable 'my-tag)`);
  assert.equal(sym(ev('my-tag')), 'none');
  ev(`(with-current-buffer (get-buffer "${a.name}") (kill-local-variable 'my-width))`);
  assert.equal(ev(`(buffer-local-value 'my-width (get-buffer "${a.name}"))`), 90);
  ev(`(put 'my-tag 'shared-local #t)`);
  assert.equal(ev(`(get 'my-tag 'shared-local)`), true);
});

test('define-minor-mode: buffer-local by default, :global, :lighter, keymap between Evil and the major mode (R4.25)', async () => {
  await fresh('text');
  ev(`(define turned '())
      (define-minor-mode shout-mode "Shouting." :lighter " Shout"
        (set! turned (cons shout-enabled turned)))
      (define-command (shout-key) (interactive) (insert "SHOUT"))
      (define-command (major-key) (interactive) (insert "major"))
      (define-key shout-mode-map "C-c s" 'shout-key)
      (define-key text-mode-map "C-c s" 'major-key)
      (text-mode)`);
  await ed.keys('M-x'); await ed.type('shout-mode\n');
  assert.equal(ev('shout-enabled'), true);
  assert.equal(ev(`(minor-mode-active-p 'shout-mode)`), true);
  assert.equal(ed.Ed.lighters(ed.E.current), ' Shout');
  ev('(goto-char 1)');
  await ed.keys('C-c s');
  assert.equal(ed.text(), 'SHOUTtext');
  // An Evil state map binding comes before the minor mode's map.
  ev(`(define-command (evil-key) (interactive) (insert "evil")) (evil-define-key 'normal 'global "C-c s" 'evil-key)`);
  await ed.keys('C-c s');
  assert.match(ed.text(), /evil/);
  ev(`(evil-define-key 'normal 'global "C-c s" #f)`);
  await fresh();
  assert.equal(ev('shout-enabled'), false);
  ev('(shout-mode)');   // from Lisp with no argument: on
  ev('(shout-mode -1)');
  assert.equal(ev('shout-enabled'), false);
  assert.equal(ed.L.write(ev('(reverse turned)')), '(#t #t #f)');
  ev(`(define-minor-mode everywhere-mode "Global." :global #t :init-value #f)`);
  ev('(everywhere-mode 1)');
  await fresh();
  assert.equal(ev('everywhere-enabled'), true);
});

test('the five ad hoc toggles are minor modes now', async () => {
  const modes = ed.L.arr(ev('(minor-mode-list)')).map(sym);
  for (const m of ['auto-fill-mode', 'visual-line-mode', 'electric-pair-mode', 'centered-view-mode', 'rainbow-delimiters-mode']) assert.ok(modes.includes(m), m);
  await fresh();
  ev('(auto-fill-mode 1)');
  assert.equal(ev('auto-fill-enabled'), true);
  await fresh();
  assert.equal(ev('auto-fill-enabled'), false);
  assert.equal(ev('electric-pair-enabled'), true);
  ev('(electric-pair-mode -1)');
  assert.equal(ev('electric-pair-enabled'), false);
  ev('(electric-pair-mode 1)');
});

test('define-derived-mode: parent keymap, hooks parent first, derived-mode-p', async () => {
  await fresh();
  ev(`(define order '())
      (add-hook! 'text-mode-hook (lambda () (set! order (cons 'text order))))
      (define-derived-mode notes-mode text-mode "Notes"
        "Notes are text."
        (set! order (cons 'body order)))
      (add-hook! 'notes-mode-hook (lambda () (set! order (cons 'notes order))))
      (define-command (text-key) (interactive) (insert "from-text"))
      (define-key text-mode-map "C-c t" 'text-key)
      (notes-mode)`);
  assert.equal(ed.E.current.mode, 'notes-mode');
  assert.equal(ed.L.write(ev('(reverse order)')), '(body text notes)');
  assert.equal(sym(ev(`(derived-mode-p 'org-mode 'text-mode)`)), 'text-mode');
  await ed.keys('C-c t');
  assert.equal(ed.text(), 'from-text');
  assert.equal(ed.Ed.MODE_NAMES['notes-mode'], 'Notes');
});

test('frames: a headless runtime has none', () => {
  assert.equal(ev('(selected-frame)'), false);
  assert.equal(ev('(frame-list)'), ed.L.NIL);
});

test('require loads a feature from ~/.config/edwin/lisp; the shipped files are features (R4.10)', () => {
  assert.equal(ev(`(featurep 'org)`), true);
  assert.equal(ev(`(featurep 'greet)`), false);
  assert.equal(sym(ev(`(require 'greet)`)), 'greet');
  assert.equal(ev('(greet "edwin")'), 'hello edwin');
  assert.throws(() => ev(`(require 'no-such-feature)`), /Cannot open load file/);
});

test('a buffer output port inserts at its marker as edits (R4.4)', async () => {
  await fresh('[]');
  ev('(define m (copy-marker 2)) (define p (open-buffer-output-port (current-buffer) m))');
  // (newline) is the editor command in emacs.scm, as in Emacs; write-string writes the line break.
  ev(`(display "one " p) (write 'two p) (write-string "\\n" p)`);
  assert.equal(ed.text(), '[one two\n]');
  assert.equal(ev('(marker-position m)'), 10);
});
