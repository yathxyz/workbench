;;; babel.scm --- the block engine of notes (hypernotes H1, docs/HYPERNOTES.md; spec R10.8, R14.15)  -*- scheme -*-
;;
;; One engine for both syntaxes of a note: Org's #+begin_src LANG :k v with #+name: and #+RESULTS:, and
;; markdown's ```LANG {#id k=v} with ```result {of=id}. The reader and the result writer are primitives of
;; edwin/server/babel.mts (%babel-*); this file holds the engine: the executors, the note environments, where
;; a result goes, the commands and their keys. markdown.scm requires it, so it loads in every runtime: frames
;; need the commands to know that they run in edwind.
;;
;; A block runs only on an explicit command (C-c C-c, babel-execute-buffer, or babel-run from wb eval or an
;; agent), never on open, save, export or agenda build (R14.15). The commands are declared (:where 'server),
;; so a frame sends them to edwind (§4.6), and shell blocks run in a card-less hub PTY (R4.44).
;;
;; Note environments (decision 4 of HYPERNOTES.md, the R4.15 amendment): the forms of a scheme block are
;; evaluated with eval in the note's environment, a child of the global one. They are not the top-level forms
;; of a call, so they never enter the image log and never reach frames. An environment lasts until edwind
;; restarts; babel-execute-buffer runs the note from fresh environments.

;;;; Blocks

(define (babel--get alist key)
  "The value of KEY (a symbol) in ALIST, or #f."
  (let ((p (assq key alist))) (and p (cdr p))))

(define (babel-block-attr blk name)
  "The header argument NAME (a string) of BLK: a string, #t for a bare flag, or #f."
  (let ((p (assoc name (babel--get blk 'attrs)))) (and p (cdr p))))

(define (babel--attr-words blk name)
  "The words of BLK's header argument NAME (results=value, :results output silent)."
  (let ((v (babel-block-attr blk name)))
    (if (string? v) (filter (lambda (w) (not (string-null? w))) (string-split v #\space)) '())))

(define (babel-syntax)
  "The block syntax of the current buffer: org for Org files and org-mode, else markdown."
  (let ((f (buffer-file-name)))
    (if (or (derived-mode-p 'org-mode) (and f (string-suffix? ".org" f))) 'org 'markdown)))

(define (babel--check)
  (unless (and (bound? '%babel-blocks) (bound? '%image-server?) (%image-server?))
    (user-error "Blocks run in edwind; this Edwin has no server")))

(define (babel-blocks)
  "The blocks of the current buffer, in order, as alists: kind (src, data or table), lang, id, begin, end,
line, body, code (the body with noweb references expanded when the block asks for it), attrs, vars, result."
  (babel--check)
  (%babel-blocks (buffer-string) (babel-syntax)))

(define (babel--find blocks id)
  "The block of BLOCKS named ID, or #f."
  (let loop ((bs blocks))
    (cond ((null? bs) #f)
          ((equal? (babel--get (car bs) 'id) id) (car bs))
          (else (loop (cdr bs))))))

(define (babel--within? x pos)
  (and x (<= (babel--get x 'begin) pos) (< pos (babel--get x 'end))))

(define (babel-block-at-point)
  "The block at point: point is on its lines (the #+name: line included) or in its result. #f when none."
  (let ((p (point)))
    (let loop ((bs (babel-blocks)))
      (cond ((null? bs) #f)
            ((or (babel--within? (car bs) p) (babel--within? (babel--get (car bs) 'result) p)) (car bs))
            (else (loop (cdr bs)))))))

(define (babel--block-at blocks pos id)
  "The block of BLOCKS that begins at POS, else the one named ID (a marker may have moved off its line)."
  (let loop ((bs blocks))
    (cond ((null? bs) (and id (babel--find blocks id)))
          ((= (babel--get (car bs) 'begin) pos) (car bs))
          (else (loop (cdr bs))))))

(define (babel--name blk)
  (or (babel--get blk 'id) (format #f "the block at line ~a" (babel--get blk 'line))))

;;;; Note environments

;; Environment name -> environment. A note's blocks share one environment: env= (markdown, also env: in the
;; front matter) or :session (Org) names it, else the note's file name.
(define babel-environments (make-equal-hash-table))

(define (babel-environment-name blk)
  "The name of the environment BLK runs in."
  (let ((e (babel-block-attr blk "env")))
    (if (and (string? e) (not (string=? e "none"))) e (or (buffer-file-name) (buffer-name)))))

(define (babel-environment name)
  "The note environment NAME, made on first use as a child of the global environment."
  (or (hash-table-ref/default babel-environments name #f)
      (let ((env (make-environment system-global-environment)))
        (hash-table-set! babel-environments name env)
        env)))

(define (babel-forget-environment name)
  "Drop the note environment NAME; the next block that runs in it starts from an empty one."
  (hash-table-delete! babel-environments name))

;;;; Values: in= and :var

(define (babel--literal ref)
  "REF as a literal value when it is one (a number, a \"string\", a 'datum), else #f wrapped in a list."
  (cond ((string->number ref) => list)
        ((and (> (string-length ref) 1) (memv (string-ref ref 0) '(#\" #\')))
         (let ((x (read (open-input-string (if (char=? (string-ref ref 0) #\') (substring ref 1 (string-length ref)) ref)))))
           (list x)))
        (else #f)))

(define (babel--results-output? blk)
  (and (member "output" (babel--attr-words blk "results")) #t))

(define (babel-block-value blk)
  "The value BLK gives a block that names it in in= or :var: its data, its table, or its stored result."
  (let ((kind (babel--get blk 'kind)) (lang (babel--get blk 'lang)))
    (cond ((eq? kind 'data) (%babel-data (string->symbol lang) (babel--get blk 'body)))
          ((eq? kind 'table) (%babel-data 'table (babel--get blk 'body)))
          (else
           (let ((r (babel--get blk 'result)))
             (cond ((not r) (user-error "~a has no result yet: run it first" (babel--name blk)))
                   ((babel--get r 'error) (user-error "~a failed when it last ran" (babel--name blk)))
                   ((eq? (babel--get r 'form) 'table) (%babel-data 'table (babel--get r 'text)))
                   ((and (string=? lang "scheme") (not (babel--results-output? blk))) (%babel-data 'result (babel--get r 'text)))
                   (else (%babel-data 'text (babel--get r 'text)))))))))

(define (babel--bindings blk blocks)
  "BLK's in= or :var bindings as (name . value)."
  (map (lambda (v)
         (let ((lit (babel--literal (cdr v))))
           (cons (car v)
                 (if lit (car lit)
                     (let ((b (babel--find blocks (cdr v))))
                       (unless b (user-error "~a: no block named ~a" (babel--name blk) (cdr v)))
                       (babel-block-value b))))))
       (babel--get blk 'vars)))

;;;; Executors

;; Language -> (lambda (code blk bindings env) ...) returning (tag . payload): tag value (a Scheme value),
;; output (text) or error (text, stored as a failed result). A condition the executor signals is stored as a
;; failed result too. ENV is the note environment of BLK. babel-define-executor adds a language.
(define babel-executors '())

(define (babel-define-executor lang proc)
  "Run blocks of LANG (a string) with PROC: (PROC code blk bindings env) -> (value . v), (output . text) or (error . text)."
  (set! babel-executors (cons (cons lang proc) (filter (lambda (e) (not (string=? (car e) lang))) babel-executors)))
  lang)

(define (babel--read-all code)
  (let ((p (open-input-string code)))
    (let loop ((acc '()))
      (let ((x (read p)))
        (if (eof-object? x) (reverse acc) (loop (cons x acc)))))))

(define (babel-execute-scheme code blk bindings env)
  "Evaluate the forms of CODE in ENV, after defining BINDINGS there: the last value, or the output with
results=output."
  (for-each (lambda (b) (eval (list 'define (string->symbol (car b)) (list 'quote (cdr b))) env)) bindings)
  (let* ((forms (babel--read-all code))
         (value (if #f #f))
         (out (with-output-to-string
                (lambda () (for-each (lambda (f) (set! value (eval f env))) forms)))))
    (if (babel--results-output? blk) (cons 'output out) (cons 'value value))))

(define (babel--shell-text v)
  "V as text for a shell variable: rows as tab-separated lines, a list as lines."
  (cond ((string? v) v)
        ((number? v) (number->string v))
        ((and (list? v) (pair? v) (list? (car v)))
         (string-join (map (lambda (row) (string-join (map babel--shell-text row) "\t")) v) "\n"))
        ((list? v) (string-join (map babel--shell-text v) "\n"))
        (else (call-with-output-string (lambda (p) (write v p))))))

(define (babel--directory-of file)
  (let ((i (string-search-backward "/" file (string-length file))))
    (if i (substring file 0 (max 1 (- i 1))) #f)))

(define (babel--expand-path p dir)
  (cond ((or (string-prefix? "/" p) (string-prefix? "~/" p)) p)
        (dir (string-append dir "/" p))
        (else (user-error "~a is relative, and this buffer visits no file" p))))

(define (babel-block-directory blk)
  "The directory a shell block runs in: its dir= (:dir) relative to the note, else the note's directory."
  (let ((dir (and (buffer-file-name) (babel--directory-of (buffer-file-name))))
        (d (babel-block-attr blk "dir")))
    (if (string? d) (babel--expand-path d dir) dir)))

(define (babel-execute-shell code blk bindings env)
  "Run CODE to completion in a card-less hub PTY, in the note's directory, with BINDINGS as shell variables:
its output (stdout and stderr merged); a status other than 0 makes it a failed result."
  (let* ((lang (babel--get blk 'lang))
         (vars (apply string-append
                      (map (lambda (b)
                             (unless (regexp-match (regexp "^[A-Za-z_][A-Za-z0-9_]*$") (car b))
                               (user-error "~a: ~a is not a shell variable name" (babel--name blk) (car b)))
                             (string-append (car b) "=" (%shell-quote-argument (babel--shell-text (cdr b))) "\n"))
                           bindings)))
         (dir (babel-block-directory blk))
         (opts (append (if (member lang '("bash" "zsh")) (list ':shell lang) '())
                       (if (and dir (string-prefix? "/" dir)) (list ':cwd dir) '()))))
    (call-with-values (lambda () (apply call-process-to-string (string-append vars code) opts))
      (lambda (status out)
        (if (eqv? status 0)
            (cons 'output out)
            (cons 'error (string-append out (if (or (string-null? out) (string-suffix? "\n" out)) "" "\n")
                                        (format #f "[exit ~a]" status))))))))

(babel-define-executor "scheme" babel-execute-scheme)
(for-each (lambda (l) (babel-define-executor l babel-execute-shell)) '("sh" "bash" "zsh"))

(define (babel--executor blk)
  (let ((e (assoc (babel--get blk 'lang) babel-executors))) (and e (cdr e))))

(define (babel--runnable? blk)
  (and (eq? (babel--get blk 'kind) 'src)
       (babel--executor blk)
       (not (member (babel-block-attr blk "eval") '("no" "never")))))

;;;; Results

(define (babel--chomp s)
  (let loop ((n (string-length s)))
    (if (and (> n 0) (memv (string-ref s (- n 1)) '(#\newline #\return))) (loop (- n 1)) (substring s 0 n))))

(define (babel--rows? v)
  (and (list? v) (pair? v) (every (lambda (r) (and (list? r) (every (lambda (c) (not (pair? c))) r))) v)))

(define (babel--payload outcome)
  "What OUTCOME of an executor stores: a string, rows (an Org table) or #f for nothing."
  (let ((tag (car outcome)) (v (cdr outcome)))
    (cond ((eq? tag 'value)
           (cond ((eq? v (if #f #f)) #f)
                 ((and (eq? (babel-syntax) 'org) (babel--rows? v)) v)
                 (else (call-with-output-string (lambda (p) (write v p))))))
          (else (let ((s (babel--chomp v))) (if (and (string-null? s) (not (eq? tag 'error))) #f s))))))

(define (babel--condition-text c)
  (if (error-object? c)
      (condition/report-string c)
      (string-append "raised " (call-with-output-string (lambda (p) (write c p))))))

(define (babel--replace beg end text)
  (unless (string=? (buffer-substring beg end) text)
    (save-excursion (goto-char beg) (delete-region beg end) (insert text))))

(define (babel--store blk payload error?)
  "Write PAYLOAD as BLK's result (replacing its old one), or remove the old one when PAYLOAD is #f."
  (let ((r (babel--get blk 'result)) (end (babel--get blk 'end)))
    (cond ((not payload)
           (when r (babel--remove-result blk)))
          (r (babel--replace (babel--get r 'begin) (babel--get r 'end)
                             (%babel-result-text (babel-syntax) (babel--get blk 'id) payload error?)))
          (else
           (save-excursion
             (goto-char end)
             (insert (if (and (> end 1) (not (eqv? (char-before) #\newline))) "\n\n" "\n")
                     (%babel-result-text (babel-syntax) (babel--get blk 'id) payload error?)
                     (if (or (>= (point) (point-max)) (eqv? (char-after) #\newline)) "" "\n")))))))

(define (babel--remove-result blk)
  (let ((r (babel--get blk 'result)) (end (babel--get blk 'end)))
    (when r
      (let ((beg (if (string-null? (string-trim (buffer-substring end (babel--get r 'begin)))) end (babel--get r 'begin))))
        (delete-region beg (babel--get r 'end))))))

;;;; Running

(define (babel-execute-block blk)
  "Run BLK, a block of the current buffer as babel-blocks returns it, and store its result under it. #t
when it ran without a condition, #f when its result is a failure."
  (babel--check)
  (let ((exec (babel--executor blk)))
    (unless (eq? (babel--get blk 'kind) 'src)
      (user-error "~a is data: nothing runs it" (babel--name blk)))
    (unless exec
      (user-error "No executor for ~a blocks (babel-define-executor)" (babel--get blk 'lang)))
    (when (member (babel-block-attr blk "eval") '("no" "never"))
      (user-error "~a says eval=no" (babel--name blk)))
    (when (babel--get blk 'code-error) (user-error "~a" (babel--get blk 'code-error)))
    (let* ((id (babel--get blk 'id))
           (marker (copy-marker (babel--get blk 'begin) #t))
           (silent (member "silent" (babel--attr-words blk "results")))
           (outcome (guard (c (#t (cons 'error (babel--condition-text c))))
                      (let ((bindings (babel--bindings blk (babel-blocks)))
                            (env (babel-environment (babel-environment-name blk))))
                        ;; The block may take a while: let the edits that wait for this buffer in (R4.41).
                        ;; The marker and the block's id find it again afterwards.
                        (thread-yield)
                        (exec (babel--get blk 'code) blk bindings env))))
           (error? (eq? (car outcome) 'error))
           (payload (babel--payload outcome)))
      (unless silent
        (let ((now (babel--block-at (babel-blocks) (marker-position marker) id)))
          (set-marker marker #f)
          (unless now (user-error "~a was removed while it ran" (babel--name blk)))
          (babel--store now payload error?)))
      (set-marker marker #f)
      (message (if error? "~a failed: ~a" "~a: ~a") (babel--name blk)
               (let ((s (if (string? payload) payload (if payload "a table" "no result"))))
                 (car (string-split s #\newline))))
      (not error?))))

(define-command (babel-execute-src-block)
  "Run the source block at point in edwind and store its result under it (C-c C-c)."
  (interactive) (:where 'server)
  (let ((blk (babel-block-at-point)))
    (unless blk (user-error "No source block at point"))
    (babel-execute-block blk)))

(define-command (babel-execute-buffer)
  "Run every source block of the note in order from fresh note environments, storing each result; stop at
the first that fails (C-c C-v b)."
  (interactive) (:where 'server)
  (let* ((runnable (filter babel--runnable? (babel-blocks)))
         (marks (map (lambda (b) (cons (copy-marker (babel--get b 'begin) #t) (babel--get b 'id))) runnable)))
    (for-each (lambda (b) (babel-forget-environment (babel-environment-name b))) runnable)
    (let loop ((ms marks) (n 0))
      (if (null? ms)
          (begin (message "Ran ~a block~a" n (if (= n 1) "" "s")) n)
          (let ((b (babel--block-at (babel-blocks) (marker-position (caar ms)) (cdar ms))))
            (set-marker (caar ms) #f)
            (cond ((not b) (loop (cdr ms) n))
                  ((babel-execute-block b) (loop (cdr ms) (+ n 1)))
                  (else (for-each (lambda (m) (set-marker (car m) #f)) (cdr ms))
                        (message "Stopped at ~a: it failed (~a ran before it)" (babel--name b) n)
                        n)))))))

(define-command (babel-remove-result)
  "Remove the stored result of the block at point (C-c C-v k)."
  (interactive) (:where 'server)
  (let ((blk (babel-block-at-point)))
    (unless blk (user-error "No source block at point"))
    (unless (babel--get blk 'result) (user-error "~a has no result" (babel--name blk)))
    (babel--remove-result blk)
    #t))

(define-command (babel-reset-environment)
  "Forget the note environment of the block at point (or of the note), so its next run starts empty (C-c C-v r)."
  (interactive) (:where 'server)
  (babel--check)
  (let* ((blk (babel-block-at-point))
         (name (if blk (babel-environment-name blk) (or (buffer-file-name) (buffer-name)))))
    (babel-forget-environment name)
    (message "Environment ~a is empty now" name)
    name))

(define (babel--base-name file)
  (let* ((i (string-search-backward "/" file (string-length file)))
         (f (if i (substring file i (string-length file)) file))
         (j (string-search-backward "." f (string-length f))))
    (if (and j (> j 1)) (substring f 0 (- j 1)) f)))

(define-command (babel-tangle)
  "Write the blocks that have tangle= (:tangle) out to their files, relative to the note (C-c C-v t). The
files' paths."
  (interactive) (:where 'server)
  (babel--check)
  (let* ((file (or (buffer-file-name) (user-error "This buffer visits no file to tangle relative to")))
         (dir (babel--directory-of file))
         (files (%babel-tangle-files (buffer-string) (babel-syntax) (babel--base-name file))))
    (when (null? files) (user-error "No block of this note has tangle="))
    (thread-yield)
    (let ((ids (map (lambda (f) (%babel-write-file (babel--expand-path (car f) dir) (cdr f))) files)))
      (message "Tangled ~a" (string-join ids ", "))
      ids)))

(define (babel-run file . id)
  "Run the note FILE (a notes-relative, ~/ or absolute path) for wb eval or an agent: every block, or only
the block named ID. The results land in the note as C-c C-c leaves them."
  (babel--check)
  (with-current-buffer (%babel-note-buffer file)
    (if (and (pair? id) (car id))
        (let ((b (babel--find (babel-blocks) (car id))))
          (unless b (user-error "~a has no block named ~a" file (car id)))
          (babel-execute-block b))
        (babel-execute-buffer))))

;;;; Keys

(define-key markdown-mode-map "C-c C-c" 'babel-execute-src-block)
(for-each (lambda (m)
            (define-key m "C-c C-v e" 'babel-execute-src-block)
            (define-key m "C-c C-v b" 'babel-execute-buffer)
            (define-key m "C-c C-v t" 'babel-tangle)
            (define-key m "C-c C-v k" 'babel-remove-result)
            (define-key m "C-c C-v r" 'babel-reset-environment))
          (list markdown-mode-map org-mode-map))
(for-each (lambda (c) (put c 'evil-repeat 'abort))
          '(babel-execute-src-block babel-execute-buffer babel-remove-result babel-reset-environment babel-tangle))

(provide 'babel)
;;; babel.scm ends here
