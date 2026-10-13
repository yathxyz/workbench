// Edwin Scheme by itself: `node --test edwin/test/scheme.test.mjs`.
// Loads only src/scheme.js (no editor, no page stand-ins). The suite runs once per evaluator mode
// in MODES (only 'direct' today; EDWIN_SCHEME_MODE picks one).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import v8 from 'node:v8';
import vm from 'node:vm';
import { loadScheme, MODE, SCHEME_FILE } from './scheme-load.mjs';

const S = loadScheme(MODE);
const run = (src, file) => S.evalString(src, file);
const ev = (src, file) => S.write(run(src, file));
const out = [];
S.hooks.output = s => out.push(s);
const files = new Map();
S.hooks.readFile = p => (files.has(p) ? files.get(p) : null);
const throwsKind = (src, kind) => assert.throws(() => run(src), e => e instanceof S.SchemeError && e.kind === kind, `${src} should signal ${kind}`);

describe(`Edwin Scheme (${MODE})`, () => {
  test('globalThis only: the module installs Scheme and schemeSource on globalThis', () => {
    assert.equal(typeof globalThis.Scheme, 'object');
    assert.match(globalThis.schemeSource, /^\(function schemeModule\(g\)/);
    assert.equal(globalThis.window, undefined);
  });

  test('R7RS-small subset', () => {
    const cases = [
      ['(define x 10) (define (sq n) (* n n)) (sq x)', '100'],
      ['(let ((a 1) (b 2)) (let* ((c (+ a b)) (d (* c 2))) (list a b c d)))', '(1 2 3 6)'],
      ['(letrec ((ev? (lambda (n) (if (= n 0) #t (od? (- n 1))))) (od? (lambda (n) (if (= n 0) #f (ev? (- n 1)))))) (ev? 1000))', '#t'],
      ['(let loop ((i 0) (acc \'())) (if (= i 5) (reverse acc) (loop (+ i 1) (cons i acc))))', '(0 1 2 3 4)'],
      ['(do ((i 0 (+ i 1)) (s 0 (+ s i))) ((= i 5) s))', '10'],
      ['(case (* 2 3) ((2 3 5 7) \'prime) ((1 4 6 8 9) \'composite) (else \'other))', 'composite'],
      ['(let ((n 3) (l \'(a b))) `(n ,n ,@l (nested ,(+ n 1)) . end))', '(n 3 a b (nested 4) . end)'],
      ['(define-syntax my-or (syntax-rules () ((_) #f) ((_ e) e) ((_ e r ...) (let ((t e)) (if t t (my-or r ...)))))) (let ((t 5)) (my-or #f t))', '5'],
      ['(define-record-type point (make-point x y) point? (x point-x set-point-x!) (y point-y)) (let ((p (make-point 1 2))) (set-point-x! p 10) (list (point? p) (point-x p) (point-y p) (point? 5)))', '(#t 10 2 #f)'],
      ['(let ((v (make-vector 3 0))) (vector-set! v 1 \'a) (list v (vector-length v) (vector->list #(1 2 3))))', '(#(0 a 0) 3 (1 2 3))'],
      ['(list (string-append "ab" "cd") (substring "hello" 1 3) (string->list "ab") (string-upcase "x") (string=? "a" "a"))', '("abcd" "el" (#\\a #\\b) "X" #t)'],
      ['(list (char->integer #\\A) (integer->char 97) (char-upcase #\\a) (char<? #\\a #\\b))', '(65 #\\a #\\A #t)'],
      ['(apply + 1 2 \'(3 4))', '10'],
      ['(map (lambda (a b) (* a b)) \'(1 2 3) \'(4 5 6))', '(4 10 18)'],
      ['(call-with-values (lambda () (values 1 2 3)) list)', '(1 2 3)'],
      ['(let ((log \'())) (dynamic-wind (lambda () (set! log (cons \'in log))) (lambda () (set! log (cons \'body log))) (lambda () (set! log (cons \'out log)))) (reverse log))', '(in body out)'],
      ['(+ 1 (call/ec (lambda (k) (+ 10 (k 5)))))', '6'],
      ['(define p (make-parameter 1)) (list (p) (parameterize ((p 2)) (p)) (p))', '(1 2 1)'],
      ['(guard (e ((symbol? e) (list \'sym e)) ((string? e) \'str)) (raise \'boom))', '(sym boom)'],
      ['(guard (e ((assq \'a e) => cdr) ((assq \'b e))) (raise (list (cons \'a 42))))', '42'],
      ['(guard (e (#t (error-object-message e))) (error "bad thing" 1 2))', '"bad thing"'],
      ['(let-values (((a b) (values 1 2)) ((c) (values 3))) (list a b c))', '(1 2 3)'],
      ['(string->symbol "abc")', 'abc'],
      ['(assoc 2.0 \'((1 one) (2 two)) =)', '(2 two)'],
      ['(let () (define a 1) (define (f) (+ a 1)) (f))', '2'],
      ['((case-lambda ((a) (list a)) ((a b) (list b a))) 1 2)', '(2 1)'],
      ['(force (delay (+ 1 2)))', '3'],
      ['(equal? (list 1 (vector 2 "x")) (list 1 (vector 2 "x")))', '#t'],
    ];
    for (const [src, want] of cases) assert.equal(ev(src), want, src);
  });

  test('R4.3 exact integers beyond 2^53 are BigInts, and come back to doubles', () => {
    assert.equal(ev('(* 99999999999 99999999999)'), '9999999999800000000001');
    assert.equal(ev('(expt 2 100)'), '1267650600228229401496703205376');
    assert.equal(typeof run('(expt 2 100)'), 'bigint');
    assert.equal(ev('(exact? (expt 2 100))'), '#t');
    assert.equal(ev('(+ 9007199254740991 1)'), '9007199254740992');
    assert.equal(typeof run('(+ 9007199254740991 1)'), 'bigint');
    assert.equal(ev('(- (+ 9007199254740991 1) 1)'), '9007199254740991');
    assert.equal(typeof run('(- (+ 9007199254740991 1) 1)'), 'number', 'back in the safe range: a double');
    assert.equal(ev('(- (expt 2 100) (expt 2 100))'), '0');
    assert.equal(ev('(eqv? 5 (quotient (expt 10 20) (* 2 (expt 10 19))))'), '#t');
    assert.equal(ev('(let ((h (make-equal-hash-table))) (hash-table-set! h 5 \'five) (hash-table-ref/default h (/ (expt 10 30) (* 2 (expt 10 29))) #f))'), 'five');
    assert.equal(ev('123456789012345678901234567890'), '123456789012345678901234567890');
    assert.equal(ev('-123456789012345678901234567890'), '-123456789012345678901234567890');
    // quotient / remainder / modulo signs, doubles and BigInts alike
    assert.equal(ev('(list (quotient 7 2) (quotient -7 2) (quotient 7 -2) (quotient -7 -2))'), '(3 -3 -3 3)');
    assert.equal(ev('(list (remainder 7 2) (remainder -7 2) (remainder 7 -2) (remainder -7 -2))'), '(1 -1 1 -1)');
    assert.equal(ev('(list (modulo 7 2) (modulo -7 2) (modulo 7 -2) (modulo -7 -2))'), '(1 1 -1 -1)');
    assert.equal(ev('(let ((b (expt 10 25))) (list (quotient (- (+ b 7)) 2) (remainder (- (+ b 7)) 2) (modulo (- (+ b 7)) 2) (modulo (+ b 7) -2)))'), '(-5000000000000000000000003 -1 1 -1)');
    assert.equal(ev('(quotient (expt 2 100) (expt 2 98))'), '4');
    assert.equal(ev('(exact->inexact (expt 2 100))'), '1.2676506002282294e+30');
    assert.equal(ev('(list (inexact 1/2) (exact 4.0) (exact? (exact 4.0)) (inexact? 0.5) (exact? 3))'), '(0.5 4 #t #t #t)');
    assert.equal(ev('(exact 1e20)'), '100000000000000000000');
    assert.equal(ev('(exact? (exact 1e20))'), '#t');
    assert.equal(ev('(inexact? (* 1.5 1e20))'), '#t');
    assert.equal(ev('(* 1.5 (expt 10 20))'), '150000000000000000000.');
    assert.equal(ev('(+ 0.5 (expt 2 80))'), '1.2089258196146292e+24');
    // number->string / string->number round trips
    for (const n of ['0', '-17', '9007199254740993', '-98765432109876543210987654321', '1.5', '1e+300']) {
      assert.equal(ev(`(number->string (string->number "${n}"))`), JSON.stringify(n), n);
    }
    assert.equal(ev('(number->string (expt 2 70) 16)'), '"400000000000000000"');
    assert.equal(ev('(string->number "400000000000000000" 16)'), '1180591620717411303424');
    assert.equal(ev('(equal? (string->number (number->string (expt 3 99))) (expt 3 99))'), '#t');
    assert.equal(ev('(string->number "abc")'), '#f');
    assert.equal(ev('#x-ff'), '-255');
    assert.equal(ev('#xffffffffffffffffff'), '4722366482869645213695');
    // the rest of the tower
    assert.equal(ev('(list (abs (- (expt 2 80))) (max 1 (expt 2 80)) (min 1 (expt 2 80)) (max 1.5 (expt 2 60)))'), '(1208925819614629174706176 1208925819614629174706176 1 1152921504606847000.)');
    assert.equal(ev('(list (< 1 (expt 2 80)) (> (expt 2 80) (expt 2 79)) (= (expt 2 60) (exact->inexact (expt 2 60))) (= (expt 2 80) 1))'), '(#t #t #t #f)');
    assert.equal(ev('(list (gcd (expt 2 80) (expt 6 20)) (lcm (expt 2 40) (expt 3 30)))'), '(1048576 226379693794030958489370624)');
    assert.equal(ev('(list (even? (expt 2 80)) (odd? (+ 1 (expt 2 80))) (zero? (- (expt 2 80) (expt 2 80))) (positive? (expt 2 80)) (negative? (- (expt 2 80))))'), '(#t #t #t #t #t)');
    assert.equal(ev('(list (number? (expt 2 80)) (integer? (expt 2 80)) (exact-integer? (expt 2 80)) (exact-integer? 1.5) (exact-integer? 1e300))'), '(#t #t #t #f #f)');
    assert.equal(ev('(list (square (expt 2 40)) (1+ 9007199254740991) (1- (- 9007199254740992)))'), '(1208925819614629174706176 9007199254740992 -9007199254740993)');
    assert.equal(ev('(list (floor (expt 2 80)) (round 2.5) (truncate -1.5) (ceiling 1.2))'), '(1208925819614629174706176 2 -1 2)');
    assert.equal(ev('(list (arithmetic-shift 1 100) (arithmetic-shift (expt 2 100) -98) (arithmetic-shift -5 -1))'), '(1267650600228229401496703205376 4 -3)');
    assert.equal(ev('(list (bitwise-and (expt 2 70) (- (expt 2 71) 1)) (bitwise-or (expt 2 40) 1) (bitwise-xor 5 3) (bitwise-and #xFFFFFFFFFF 255))'), '(1180591620717411303424 1099511627777 6 255)');
    assert.equal(ev('(/ (expt 2 100) (expt 2 99))'), '2');
    assert.equal(ev('(/ (expt 2 100) 3)'), '4.2255020007607644e+29');
    assert.equal(ev('(sqrt (expt 2 100))'), '1125899906842624');
    assert.equal(ev('(call-with-values (lambda () (exact-integer-sqrt (+ (expt 10 40) 5))) list)'), '(100000000000000000000 5)');
    assert.equal(ev('(expt 2.0 3)'), '8');
    assert.equal(ev('(expt 2 -1)'), '0.5');
    assert.equal(ev('(expt -3 41)'), '-36472996377170786403');
    assert.equal(ev('(format #f "~a %d" (expt 2 64) (expt 2 65))'), '"18446744073709551616 36893488147419103232"');
    throwsKind('(quotient (expt 2 80) 0)', 'divide-by-zero');
    throwsKind('(+ 1 "a")', 'wrong-type-argument');
    throwsKind('(vector-ref (vector 1) (expt 2 80))', 'range-error');
  });

  test('R4.4 ports: string ports, the current output port, custom ports', () => {
    assert.equal(ev('(let ((p (open-input-string "ab\\ncd\\n(x y) 42"))) (list (peek-char p) (read-char p) (read-line p) (read-line p) (read p) (read p) (eof-object? (read p)) (eof-object? (read-char p))))'), '(#\\a #\\a "b" "cd" (x y) 42 #t #t)');
    assert.equal(ev('(let ((p (open-output-string))) (write \'sym p) (display " " p) (write "s" p) (write-char #\\! p) (newline p) (write-string "xyz" p 1) (get-output-string p))'), '"sym \\"s\\"!\\nyz"');
    assert.equal(ev('(with-output-to-string (lambda () (display "a") (write "b") (newline) (format #t "~a-~s" 1 "x") (write-line 3)))'), '"a\\"b\\"\\n1-\\"x\\"3\\n"');
    assert.equal(ev('(call-with-output-string (lambda (port) (format port "~a+~a" 1 2) (pp \'(a b) port)))'), '"1+2(a b)\\n"');
    assert.equal(ev('(list (port? (current-output-port)) (output-port? (current-output-port)) (input-port? (open-input-string "")) (textual-port? (open-output-string)) (port? 5))'), '(#t #t #t #t #f)');
    // read-string counts characters: one outside the BMP is never split into surrogates.
    assert.equal(ev('(let ((p (open-input-string "\u{1F600}a\u{1F600}"))) (list (read-string 1 p) (read-char p) (read-string 5 p)))'), '("\u{1F600}" #\\a "\u{1F600}")');
    assert.equal(ev('(let ((p (open-input-string "x"))) (list (char-ready? p) (input-port-open? p) (begin (close-port p) (input-port-open? p))))'), '(#t #t #f)');
    assert.equal(ev('(eof-object? (eof-object))'), '#t');
    assert.equal(ev('(format #f "~a" 5)'), '"5"');
    assert.equal(ev('(with-input-from-string "1 2" (lambda () (list (read) (read))))'), '(1 2)');
    out.length = 0;
    run('(display "to-console") (newline) (write-string "ws") (format #t "f~a" 1)');
    assert.equal(out.join(''), 'to-console\nwsf1', 'the default output port writes through hooks.output');
    const got = [];
    const port = S.makeOutputPort(s => got.push(s), 'buffer');
    S.gdef('test-port', port);
    run('(display "hello" test-port) (write \'(1 "two") test-port) (parameterize ((current-output-port test-port)) (display "!"))');
    assert.equal(got.join(''), 'hello(1 "two")!');
    assert.equal(ev('test-port').startsWith('#<output-port buffer'), true);
    assert.throws(() => run('(let ((p (open-output-string))) (close-output-port p) (display 1 p))'), S.SchemeError);
    assert.equal(ev('(begin (define p (open-output-string)) (display (current-error-port) p) (output-port? (current-error-port)))'), '#t');
  });

  test('R4.5 environments: the-environment, make-environment, eval with an environment', () => {
    assert.equal(ev('(define (f x) (eval \'(* x 2) (the-environment))) (f 21)'), '42');
    assert.equal(ev('(eval \'(+ 1 2) system-global-environment)'), '3');
    assert.equal(ev('(eval \'(* 2 3) (interaction-environment))'), '6');
    assert.equal(ev('(eval \'(list 1 2))'), '(1 2)');
    run('(define env1 (make-environment))');
    assert.equal(ev('(eval \'(define env-only 5) env1) (eval \'(+ env-only 1) env1)'), '6');
    assert.equal(ev('(bound? \'env-only)'), '#f', 'define in eval in an environment binds there, not globally');
    assert.equal(ev('(list (environment-bound? env1 \'env-only) (environment-bound? env1 \'nope) (environment-bound? env1 \'car))'), '(#t #f #t)');
    assert.equal(ev('(define env2 (make-environment env1)) (eval \'(define more 1) env2) (list (eval \'(+ env-only more) env2) (environment-bound? env1 \'more))'), '(6 #f)');
    assert.equal(ev('(define (g) (eval \'(define z 1) (the-environment)) (eval \'(+ z 1) (the-environment))) (list (g) (bound? \'z))'), '(2 #f)');
    assert.equal(ev('(let ((a 1)) (let ((e (the-environment))) (eval \'(set! a 5) e) a))'), '5');
    assert.equal(ev('(list (environment? (the-environment)) (environment-lookup env1 \'env-only) (begin (environment-assign! env1 \'env-only 9) (eval \'env-only env1)))'), '(#t 5 9)');
    assert.equal(ev('(eval \'(define (h) (quote in-env)) env1) (list (eval \'(h) env1) (bound? \'h))'), '(in-env #f)');
  });

  test('R4.6 source locations on pairs read and on procedures', () => {
    const [form] = S.readAll('(define (twice x)\n  (* x\n     2))', 'twice.scm');
    assert.deepEqual(S.sourceLocation(form), { file: 'twice.scm', line: 1, col: 0 });
    const body = form.cdr.cdr.car;
    assert.deepEqual(S.sourceLocation(body), { file: 'twice.scm', line: 2, col: 2 });
    assert.deepEqual(S.sourceLocation(body.cdr.cdr), { file: 'twice.scm', line: 3, col: 5 }, 'every pair: the last cell points at its element');
    const r = S.reader("x 'q", { file: 'r.scm' }); r.form();
    assert.deepEqual(S.sourceLocation(r.form()), { file: 'r.scm', line: 1, col: 2 });
    S.evalForm(form);
    assert.deepEqual(S.sourceLocation(S.gref('twice')), { file: 'twice.scm', line: 1, col: 0 });
    assert.equal(S.gref('twice').loc.line, 1);
    run('\n\n   (define anon (lambda (y) y))', 'anon.scm');
    assert.deepEqual(S.sourceLocation(S.gref('anon')), { file: 'anon.scm', line: 3, col: 16 });
    assert.equal(ev('(source-location twice)'), '("twice.scm" 1 0)');
    assert.equal(ev('(source-location (read "(a b)"))'), '(#f 1 0)');
    assert.equal(S.sourceLocation(S.gref('car')), null);
  });

  test('R4.7 hash tables: chars are their own keys; weak tables', async () => {
    assert.equal(ev('(let ((h (make-hash-table))) (hash-table-set! h #\\a 1) (hash-table-set! h "c97" 2) (list (hash-table-ref/default h #\\a #f) (hash-table-ref/default h "c97" #f) (hash-table-count h) (char? (car (hash-table-keys h)))))'), '(1 2 2 #t)');
    assert.equal(ev('(let ((h (make-weak-hash-table)) (k (list 1))) (hash-table-set! h k \'obj) (hash-table-set! h 7 \'num) (hash-table-set! h "s" \'str) (list (hash-table-ref/default h k #f) (hash-table-ref/default h 7 #f) (hash-table-count h) (weak-hash-table? h) (hash-table? h) (begin (hash-table-delete! h k) (hash-table-count h))))'), '(obj num 3 #t #t 2)');
    // Weak keys go away once nothing refers to them.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const t = S.evalString('(define wt (make-weak-hash-table)) (hash-table-set! wt 1 \'one) wt');
    (() => { const key = S.list(1, 2); t.set(key, 'x'); assert.equal(t.size, 2); })();
    for (let i = 0; i < 5 && t.size > 1; i++) { await new Promise(r => setTimeout(r, 0)); gc(); }
    assert.equal(t.size, 1, 'the dead key is gone');
    assert.equal(ev('(hash-table->alist wt)'), '((1 . one))');
  });

  test('R4.8 printing: records as handles, record printers, host objects', () => {
    run('(define-record-type thing (make-thing a) thing? (a thing-a))');
    assert.match(ev('(make-thing 1)'), /^#<thing \d+>$/);
    assert.equal(ev('(let ((t (make-thing 1))) (equal? (object->string t) (object->string t)))'), '#t');
    run('(define-record-type (pt :printer (lambda (r port) (write-string "#<pt " port) (write (pt-x r) port) (write-string ">" port))) (make-pt x) pt? (x pt-x))');
    assert.equal(ev('(make-pt 3)'), '#<pt 3>');
    assert.equal(ev('(list (make-pt "s"))'), '(#<pt "s">)');
    assert.equal(ev('(with-output-to-string (lambda () (display (make-pt 4))))'), '"#<pt 4>"');
    run('(set-record-type-printer! thing (lambda (r port) (format port "[thing ~a]" (thing-a r))))');
    assert.equal(ev('(make-thing 9)'), '[thing 9]');
    run('(set-record-type-printer! thing #f)');
    assert.match(ev('(make-thing 9)'), /^#<thing \d+>$/);
    S.gdef('host-obj', new (class Widget {})());
    assert.match(ev('host-obj'), /^#<Widget \d+>$/);
    S.gdef('plain-obj', {});
    assert.match(ev('plain-obj'), /^#<object \d+>$/);
    assert.equal(ev('(list (object-hash plain-obj) (object-hash plain-obj))').split(' ').length, 2);
  });

  test('R4.10 provide, require and load over load-path through hooks.readFile', () => {
    files.set('lib/feat-a.scm', '(define feat-a-val 7)\n(define (feat-a-proc) feat-a-val)\n(provide \'feat-a)');
    files.set('lib/feat-b.scm', '(define feat-b-loaded #t)');
    files.set('other/x.scm', '(define loaded-x (+ 1 2))');
    files.set('inc.scm', '(define inc-1 1) (define inc-2 2)');
    assert.equal(ev('(featurep \'feat-a)'), '#f');
    throwsKind('(require \'feat-a)', 'file-error');
    run('(set! load-path \'("nowhere" "lib/"))');
    assert.equal(ev('(require \'feat-a)'), 'feat-a');
    assert.equal(ev('(list (featurep \'feat-a) feat-a-val (memq \'feat-a (features)))'), '(#t 7 (feat-a))');
    assert.deepEqual(S.sourceLocation(S.gref('feat-a-proc')), { file: 'lib/feat-a.scm', line: 2, col: 0 }, 'loaded forms carry their file');
    files.set('lib/feat-a.scm', '(provide \'feat-a) (define feat-a-val 8)');
    assert.equal(ev('(require \'feat-a) feat-a-val'), '7', 'a provided feature is not loaded again');
    assert.throws(() => run('(require \'feat-b)'), e => e instanceof S.SchemeError && /did not provide feature feat-b/.test(e.message));
    assert.equal(ev('feat-b-loaded'), '#t');
    assert.equal(ev('(load "other/x.scm") loaded-x'), '3');
    throwsKind('(load "missing.scm")', 'file-error');
    assert.equal(ev('(let () (include "inc.scm") (+ inc-1 inc-2))'), '3');
    assert.equal(ev('(bound? \'inc-1)'), '#f');
    const saved = S.hooks.readFile; S.hooks.readFile = null;
    try { throwsKind('(load "other/x.scm")', 'file-error'); } finally { S.hooks.readFile = saved; }
  });

  test('R4.31 handlers run before unwinding', () => {
    run('(define hp (make-parameter \'outer))');
    // A parameterize binding and a dynamic-wind after-thunk, seen from inside the handler.
    assert.equal(ev(`(let ((log '()))
      (call/ec (lambda (k)
        (with-exception-handler
          (lambda (c) (set! log (cons (list 'handler (hp)) log)) (k 'escaped))
          (lambda ()
            (dynamic-wind (lambda () #f)
                          (lambda () (parameterize ((hp 'inner)) (raise 'boom)))
                          (lambda () (set! log (cons 'after log))))))))
      (reverse log))`), '((handler inner) after)');
    assert.equal(ev('(with-exception-handler (lambda (c) 42) (lambda () (+ (raise-continuable \'oops) 1)))'), '43');
    assert.match(ev('(guard (e (#t (condition/report-string e))) (with-exception-handler (lambda (c) \'ignored) (lambda () (raise \'boom))))'), /handler returned from a non-continuable raise of boom/);
    assert.equal(ev('(call/ec (lambda (k) (with-exception-handler (lambda (c) (k \'outer)) (lambda () (guard (e (#t \'inner)) (raise \'x))))))'), 'inner');
    assert.equal(ev('(call/ec (lambda (k) (with-exception-handler (lambda (c) (k \'outer)) (lambda () (guard (e ((string? e) \'inner)) (raise \'x))))))'), 'outer', 'a guard with no matching clause passes it on');
    // Primitive errors reach handlers before any Scheme frame unwinds.
    assert.equal(ev(`(call/ec (lambda (k)
      (with-exception-handler
        (lambda (c) (k (list (hp) (condition/report-string c) (error? c) (wrong-type-argument? c))))
        (lambda () (parameterize ((hp 'inside)) (car 1))))))`), '(inside "car: expected pair, got 1" #t #t)');
    assert.equal(ev(`(let ((log '()))
      (call/ec (lambda (k)
        (with-exception-handler
          (lambda (c) (set! log (cons (list 'handler (hp)) log)) (k #f))
          (lambda () (dynamic-wind (lambda () #f) (lambda () (parameterize ((hp 'deep)) (vector-ref (vector 1 2) 99))) (lambda () (set! log (cons 'after log))))))))
      (reverse log))`), '((handler deep) after)');
    // Handlers run with the outer handlers installed.
    assert.equal(ev(`(call/ec (lambda (k)
      (with-exception-handler (lambda (c) (k (list 'outer c)))
        (lambda () (with-exception-handler (lambda (c) (raise (list 'wrapped c))) (lambda () (raise 'inner)))))))`), '(outer (wrapped inner))');
    // An error inside a handler is not handled by that handler again.
    assert.equal(ev(`(let ((n 0))
      (guard (e (#t (list n (error-object-message e))))
        (with-exception-handler (lambda (c) (set! n (+ n 1)) (error "in handler")) (lambda () (car 1)))))`), '(1 "in handler")');
    // A handler sees each condition once even through several call sites.
    assert.equal(ev(`(let ((n 0))
      (define (a) (+ 1 (b))) (define (b) (+ 1 (c))) (define (c) (+ 1 (car 'x)))
      (call/ec (lambda (k) (with-exception-handler (lambda (e) (set! n (+ n 1)) (k n)) a))))`), '1');
    // Quit passes through guard and Scheme handlers; JS handlers see it.
    const quit = new S.SchemeError('quit', 'Quit', []);
    S.def('%test-quit', () => { throw quit; });
    assert.throws(() => run('(guard (e (#t \'caught)) (with-exception-handler (lambda (c) \'h) (lambda () (%test-quit))))'), e => e === quit);
    const seen = [];
    assert.throws(() => S.withHandler(c => { seen.push(c); return S.DECLINE; }, () => run('(guard (e (#t \'caught)) (%test-quit))')), e => e === quit);
    assert.deepEqual(seen, [quit]);
    // Escapes and the guard's unwinding semantics are unchanged.
    assert.equal(ev('(guard (e ((error? e) (list \'caught (error-object-message e) (error-object-irritants e)))) (+ 1 (error "msg" 1 2)))'), '(caught "msg" (1 2))');
    assert.equal(ev('(let ((log \'())) (guard (e (#t (set! log (cons \'clause log)))) (dynamic-wind (lambda () #f) (lambda () (raise 1)) (lambda () (set! log (cons \'after log))))) (reverse log))'), '(after clause)');
    assert.equal(ev('(ignore-errors (car 1))'), '#f');
    assert.equal(ev('(condition-case e (vector-ref (vector) 1) (error (error-kind e)))'), 'range-error');
    // A JS handler can resume a raise-continuable.
    assert.equal(S.withHandler((c, continuable) => continuable ? 100 : S.DECLINE, () => run('(+ 1 (raise-continuable \'need-a-number))')), 101);
    // Errors not caught by anyone still reach the caller as they were.
    assert.throws(() => run('(car 1)'), e => e instanceof S.SchemeError && e.kind === 'wrong-type-argument');
    assert.throws(() => run('(raise \'plain)'), e => e instanceof S.Raise && e.obj === S.intern('plain'));
  });

  test('R4.32 condition types', () => {
    assert.equal(ev('(guard (e (#t (list (condition? e) (error? e) (user-error? e) (condition-type/error? (condition/type e)) (error-kind e)))) (user-error "nope ~a" 1))'), '(#t #t #t #t user-error)');
    assert.equal(ev('(let ((c (make-condition \'quit "Quit"))) (list (error? c) (condition? c) (quit? c)))'), '(#f #t #t)');
    assert.equal(ev('(list (condition-type/error? (condition-type \'quit)) (condition-type/error? (condition-type \'args-out-of-range)) (map condition-type/name (condition-type/generalizations (condition-type \'args-out-of-range))))'), '(#f #t (args-out-of-range range-error error))');
    assert.equal(ev('(guard (e (#t (list (unbound-variable? e) (access-condition e \'message) (access-condition e \'irritants)))) undefined-thing)'), '(#t "Unbound variable: undefined-thing" (undefined-thing))');
    assert.equal(ev('(guard (e ((divide-by-zero? e) \'dz)) (quotient 1 0))'), 'dz');
    assert.equal(ev('(guard (e ((file-error? e) \'fe)) (load "no/such/file.scm"))'), 'fe');
    assert.equal(ev('(guard (e ((read-error? e) (error-kind e))) (read "(a b"))'), 'end-of-file');
    assert.equal(ev('(guard (e ((wrong-number-of-arguments? e) \'wna)) ((lambda (a) a)))'), 'wna');
    assert.equal(ev('(guard (e ((assertion-failed? e) \'af)) (assert (= 1 2)))'), 'af');
    assert.equal(ev('(list (error? \'sym) (condition? "s") (timeout? 1))'), '(#f #f #f)');
    // define-condition-type
    run('(define-condition-type parse-problem error (lambda (c port) (format port "Parse problem: ~a" (access-condition c \'message))))');
    run('(define-condition-type bad-token parse-problem)');
    assert.equal(ev('(guard (e ((parse-problem? e) (list (bad-token? e) (error? e) (condition/report-string e)))) (raise (make-condition \'bad-token "unexpected )")))'), '(#t #t "Parse problem: unexpected )")');
    assert.equal(ev('(list (condition-type? condition-type:bad-token) (condition-type/name (condition-type/parent condition-type:bad-token)))'), '(#t parse-problem)');
    assert.equal(S.errorMessage(S.evalString('(make-condition \'bad-token "x")')), 'Parse problem: x');
    run('(define-condition-type my-signal #f)');
    assert.equal(ev('(error? (make-condition \'my-signal "s"))'), '#f');
    // The JS side
    const e = new S.SchemeError('args-out-of-range', 'Args out of range', []);
    assert.equal(S.conditionIs(e, 'range-error'), true);
    assert.equal(S.conditionIs(e, 'error'), true);
    assert.equal(S.conditionIs(new S.SchemeError('quit', 'Quit'), 'error'), false);
    assert.equal(S.conditionIs(new S.SchemeError('brand-new-kind', 'x'), 'error'), true, 'unknown kinds are errors');
    assert.equal(ev('(error-object-message (make-condition \'user-error "m" 1))'), '"m"');
  });

  test('R4.33 restarts', () => {
    assert.equal(ev('(with-exception-handler (lambda (c) (invoke-restart \'use-value 42)) (lambda () (+ 1 undefined-var)))'), '43');
    assert.equal(ev('(with-exception-handler (lambda (c) (invoke-restart \'store-value 10)) (lambda () (* 2 newly-stored)))'), '20');
    assert.equal(ev('newly-stored'), '10', 'store-value defined the global');
    assert.equal(ev('(with-exception-handler (lambda (c) (use-value 5)) (lambda () (list unbound-a)))'), '(5)');
    assert.equal(ev('(with-exception-handler (lambda (c) (invoke-restart \'store-value 3)) (lambda () (set! never-defined 1) never-defined))'), '3');
    assert.equal(ev(`(restart-case (with-exception-handler (lambda (c) (invoke-restart 'second 5)) (lambda () (error "x")))
      (first () 'one)
      (second (v) (list 'two v)))`), '(two 5)');
    assert.equal(ev(`(restart-case
      (restart-case (map restart/name (compute-restarts))
        (inner-a () 1) (inner-b () 2))
      (outer () 3))`), '(inner-a inner-b outer)');
    assert.equal(ev('(call-with-values (lambda () (with-simple-restart (skip "Skip ~a" \'it) (invoke-restart \'skip))) list)'), '(#f #t)');
    assert.equal(ev('(with-simple-restart (skip "Skip") (+ 1 2))'), '3');
    assert.equal(ev('(with-simple-restart (skip "Skip ~a" 7) (restart/report-string (find-restart \'skip)))'), '"Skip 7"');
    // A restart established between the handler and the raise is visible to the handler.
    assert.equal(ev(`(with-exception-handler
      (lambda (c) (invoke-restart (find-restart 'retry-with) 10))
      (lambda () (restart-case (raise 'x) (retry-with (n) (* n 2)))))`), '20');
    assert.equal(ev(`(restart-case (invoke-restart-interactively 'ask)
      (ask (a b) :report "Ask for two values" :interactive (lambda () (list 1 2)) (+ a b)))`), '3');
    assert.equal(ev('(restart-case (restart/report-string (car (compute-restarts))) (r () :report "Do it" #f))'), '"Do it"');
    assert.equal(ev('(list (restart? (restart-case (car (compute-restarts)) (r () 1))) (find-restart \'none))'), '(#t #f)');
    assert.equal(ev('(continue)'), '#f');
    throwsKind('(abort)', 'control-error');
    throwsKind('(invoke-restart \'nothing-like-it)', 'control-error');
    throwsKind('((restart-case (let ((r (car (compute-restarts)))) (lambda () (invoke-restart r))) (r () 1)))', 'control-error');
    // The JS API: the editor's abort restart around a command.
    assert.equal(S.withRestarts([{ name: 'abort', report: 'Return to the command loop', fn: () => 'aborted' }], () => run('(begin (abort) \'not-here)')), 'aborted');
    assert.equal(S.withRestarts([{ name: 'abort', fn: () => 'aborted' }], () => S.withHandler(c => S.invokeRestart('abort', []), () => run('(car 1)'))), 'aborted');
    assert.deepEqual(S.withRestarts([{ name: 'use-it', fn: (a, b) => [a, b], interactive: () => [1, 2] }], () => run('(invoke-restart-interactively \'use-it)')), [1, 2]);
    S.hooks.restartArgs = r => [r.name.name.length];
    try { assert.equal(ev('(with-exception-handler (lambda (c) (invoke-restart-interactively \'use-value)) (lambda () unbound-z))'), '9'); } finally { S.hooks.restartArgs = null; }
    // Restarts during a handler see the restarts of the raise point.
    assert.deepEqual(S.withRestarts([{ name: 'outer-r', fn: () => 0 }], () => S.withHandler(() => { const names = S.computeRestarts().map(r => r.name.name); throw new S.Escape('done', [names]); }, () => { try { return run('undefined-q'); } catch (e) { if (e instanceof S.Escape) return e.vals[0]; throw e; } })), ['use-value', 'store-value', 'outer-r']);
  });

  test('R4.34 the shadow stack: backtraces, the depth cap, consistency after escapes', () => {
    assert.equal(S.shadowStack, true);
    run(`(define (bt-inner) (let ((b (stack-backtrace))) b))
(define (bt-middle) (let ((r (bt-inner))) r))
(define (bt-outer) (car (list (bt-middle))))`, 'bt.scm');
    const frames = S.evalForm(S.readAll('(bt-outer)', 'call.scm')[0]);
    const fs = S.arr(frames);
    assert.deepEqual(fs.slice(0, 3).map(f => f.proc.procName), ['bt-inner', 'bt-middle', 'bt-outer']);
    assert.deepEqual(fs.slice(0, 3).map(f => f.loc && [f.loc.file, f.loc.line, f.loc.col]), [['bt.scm', 2, 29], ['bt.scm', 3, 30], ['call.scm', 1, 0]]);
    assert.equal(fs.length, 3);
    assert.ok(Array.isArray(fs[0].frame), 'the lexical frame of the application');
    assert.equal(ev('(map (lambda (f) (procedure-name (stack-frame/procedure f))) (bt-outer))'), '("bt-inner" "bt-middle" "bt-outer")');
    assert.equal(ev('(stack-frame/location (car (bt-outer)))'), '("bt.scm" 2 29)');
    assert.equal(ev('(let ((f (car (let ((x 41)) (define (peek y) (let ((b (stack-backtrace))) b)) (peek 1))))) (eval \'(+ y 1) (stack-frame/environment f)))'), '2');
    // From JS: innermost first.
    S.def('%js-backtrace', () => S.listOf(S.backtrace().map(f => f.proc.procName || false)));
    assert.equal(ev('(define (js-bt-a) (let ((r (%js-backtrace))) r)) (js-bt-a)'), '("%js-backtrace" "js-bt-a")');
    // A snapshot on the condition, taken before unwinding.
    run(`(define (err-c) (let ((x (car 'not-a-pair))) x))
(define (err-b) (let ((y (err-c))) y))`, 'err.scm');
    assert.equal(ev('(guard (e (#t (map (lambda (f) (procedure-name (stack-frame/procedure f))) (condition/backtrace e)))) (err-b))'), '("car" "err-c" "err-b")');
    try { run('(err-b)'); assert.fail('no error'); } catch (e) {
      assert.deepEqual(S.conditionBacktrace(e).map(f => f.proc.procName), ['car', 'err-c', 'err-b']);
      assert.deepEqual(S.conditionBacktrace(e)[1].loc, { file: 'err.scm', line: 2, col: 25 });
    }
    // The depth cap signals a catchable condition.
    const max = S.maxDepth;
    S.setMaxDepth(400);
    try {
      run('(define (deep n) (if (= n 0) 0 (+ 1 (deep (- n 1)))))');
      assert.equal(ev('(deep 300)'), '300');
      assert.equal(ev('(guard (e ((recursion-depth? e) (list \'caught (condition/report-string e) (> (length (condition/backtrace e)) 390)))) (deep 1000))'), '(caught "Recursion too deep" #t)');
      throwsKind('(deep 1000)', 'recursion-depth');
      assert.equal(ev('(with-exception-handler (lambda (c) (invoke-restart \'use-value 0)) (lambda () (restart-case (deep 1000) (use-value (v) v))))'), '0');
    } finally { S.setMaxDepth(max); }
    // Consistent after escapes.
    run('(define (probe) (length (stack-backtrace))) (define (dive n k) (if (= n 0) (k \'out) (+ 1 (dive (- n 1) k))))');
    assert.equal(ev(`(let ((d0 (probe)))
      (call/ec (lambda (k) (dive 50 k)))
      (guard (e (#t #f)) (dive 50 (lambda (x) (car x))))
      (restart-case (dive 50 (lambda (x) (invoke-restart 'r))) (r () #f))
      (with-exception-handler (lambda (c) (invoke-restart 'use-value 1)) (lambda () (dive 30 (lambda (x) unbound-in-dive))))
      (list d0 (probe)))`), '(1 1)');
    assert.equal(S.stackDepth(), 0);
    try { run('(dive 40 (lambda (x) (car x)))'); } catch (e) { /* expected */ }
    assert.equal(S.stackDepth(), 0, 'restored at the evaluation boundary');
    S.resetStack();
    assert.equal(S.stackDepth(), 0);
  });

  test('R4.34 on a stack too small for the cap, guard still catches a recursion-depth condition', async () => {
    // Node's default stack holds about 1,500 Scheme calls. The JavaScript RangeError is turned into a
    // recursion-depth condition at the guard, after unwinding; edwind runs with a stack sized for the cap.
    const src = `
const { parentPort, workerData } = require('node:worker_threads');
require('node:vm').runInThisContext(require('node:fs').readFileSync(workerData, 'utf8'));
const S = globalThis.Scheme;
S.evalString('(define (f n) (if (= n 0) 0 (+ 1 (f (- n 1)))))');
const caught = S.write(S.evalString('(guard (e ((recursion-depth? e) (list (quote caught) (condition/report-string e)))) (f 100000))'));
let plain = 'no error'; try { S.evalString('(f 100000)'); } catch (e) { plain = e.constructor.name; }
parentPort.postMessage([caught, plain, S.stackDepth(), S.write(S.evalString('(f 100)'))]);`;
    const res = await new Promise((resolve, reject) => {
      const w = new Worker(src, { eval: true, workerData: SCHEME_FILE, resourceLimits: { stackSizeMb: 1 } });
      w.once('message', resolve); w.once('error', reject);
    });
    assert.match(res[0], /^\(caught "Recursion too deep: the JavaScript stack ran out at depth \d+"\)$/);
    assert.equal(res[1], 'RangeError', 'without a guard the overflow surfaces as it did');
    assert.equal(res[2], 0);
    assert.equal(res[3], '100', 'the evaluator works after the overflow');
  });

  test('R4.34 the default cap of 10,000 frames (in a thread with a big stack)', async () => {
    const src = `
const { parentPort, workerData } = require('node:worker_threads');
require('node:vm').runInThisContext(require('node:fs').readFileSync(workerData, 'utf8'));
const S = globalThis.Scheme;
S.evalString('(define (f n) (if (= n 0) 0 (+ 1 (f (- n 1)))))');
parentPort.postMessage([S.write(S.evalString('(f 9900)')), S.write(S.evalString('(guard (e ((recursion-depth? e) (quote caught))) (f 20000))')), S.stackDepth()]);`;
    const res = await new Promise((resolve, reject) => {
      const w = new Worker(src, { eval: true, workerData: SCHEME_FILE, resourceLimits: { stackSizeMb: 64 } });
      w.once('message', resolve); w.once('error', reject);
    });
    assert.deepEqual(res, ['9900', 'caught', 0]);
  });

  test('call/ec, errors and the old entry points keep working', () => {
    assert.equal(ev('(call/ec (lambda (k) (dynamic-wind (lambda () #f) (lambda () (k 1)) (lambda () #f))))'), '1');
    const esc = S.callProc(S.evalString('(lambda (k) (k 5))'), [S.evalString('(lambda (x) (* x 2))')]);
    assert.equal(esc, 10);
    assert.equal(S.errorMessage(new S.SchemeError('error', 'Bad', [1, 'x'])), 'Bad 1 "x"');
    assert.equal(ev('(catch \'tag (+ 1 (throw \'tag 5)))'), '5');
    assert.equal(ev('(unwind-protect 1 2)'), '1');
    // A global read goes through its box at each reference (accessors on boxes work).
    const box = S.gbox('magic-var');
    let n = 0;
    Object.defineProperty(box, 'value', { get: () => ++n, set: () => {}, configurable: true });
    assert.equal(ev('(define (read-magic) magic-var) (list (read-magic) (read-magic))'), '(1 2)');
    // watchdog interrupts are not errors and pass through guard
    const limit = S.watchdog.limitMs; S.watchdog.limitMs = 30; S.watchdog.reset();
    try { assert.throws(() => run('(guard (e (#t \'caught)) (let loop () (loop)))'), e => e instanceof S.SchemeError && e.kind === 'scheme-interrupt'); }
    finally { S.watchdog.limitMs = limit; S.watchdog.reset(); }
  });
});
