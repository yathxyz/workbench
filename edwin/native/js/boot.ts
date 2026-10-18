/* The first half of edwin's startup (DT1): the native host, the core, and Ed.boot with the shipped Scheme,
   but nothing of this process (no arguments, terminal, directories, storage or user init). The build runs it
   once and keeps the heap as V8's startup snapshot, so a start restores this state instead of compiling the
   core and evaluating emacs.scm and evil.scm again; main.ts does the rest. Without the snapshot (or when
   edwin attaches to edwind, whose boot is Ed.bootServed) main.ts loads this file itself.

   EdBootAttach set: load the core without booting it. */
(function () {
'use strict';
const N = globalThis.__n;
/* The core files, in load order: host-node.cts's FILES (a test keeps the two equal). */
const FILES = ['scheme', 'runtime', 'text', 'editor-core', 'editor-prims', 'evil-core', 'pool', 'complete', 'extras', 'stack', 'ai', 'evil-ex', 'org', 'markdown', 'ot', 'sync', 'display'];

const host = globalThis.EdNativeHost.createHost();
globalThis.EdHost = host;
globalThis.SCHEME_MODE = 'direct';
for (const f of FILES) N.load(f);
const Ed = globalThis.Ed, L = globalThis.L;

/* A terminal's settings, after the shipped Scheme and before the user's init.scm, which may change them:
   C-z suspends in Vim's states, as in Vim, and C-x C-z in every state, as in Emacs; a saved file ends in a
   newline, as Vim writes it. */
Ed.hooks.beforeUserInit = () => L.evalText(`(begin
  (for-each (lambda (m) (define-key m "C-z" 'suspend-frame)) (list evil-normal-state-map evil-motion-state-map evil-visual-state-map evil-insert-state-map))
  (global-set-key "C-x C-z" 'suspend-frame)
  (set! require-final-newline #t))`);
if (!globalThis.EdBootAttach) Ed.boot({ deferUserInit: true });
globalThis.EdBooted = globalThis.EdBootAttach ? 'loaded' : 'booted';
globalThis.EdNativeFiles = FILES;
})();
