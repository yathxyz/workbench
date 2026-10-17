;;; process.scm --- Scheme side of processes through the hub (spec §4.8: R4.43, R4.44)  -*- scheme -*-
;;
;; Loaded by edwin/server/process.mts into the server image only. The primitives (make-process,
;; process-send-string, kill-process, %call-process, ...) are server-only (R4.49); this file adds the
;; Emacs-shaped conveniences over them and the list-processes command.

(define (%process-opt opts key . default)
  "The value after keyword KEY in the keyword list OPTS, or DEFAULT (#f)."
  (let loop ((o opts))
    (cond ((or (null? o) (null? (cdr o))) (if (pair? default) (car default) #f))
          ((eq? (car o) key) (cadr o))
          (else (loop (cddr o))))))

(define (%process-opts-without opts . keys)
  "OPTS without the keywords in KEYS and their values."
  (let loop ((o opts) (acc '()))
    (cond ((or (null? o) (null? (cdr o))) (reverse acc))
          ((memq (car o) keys) (loop (cddr o) acc))
          (else (loop (cddr o) (cons (cadr o) (cons (car o) acc)))))))

(define (call-process command . opts)
  "Run COMMAND (a string in the shell's syntax) to completion in a card-less hub PTY and return its exit
status (R4.44). Options: :shell :cwd :env :size :timeout, and :buffer (a buffer, a name or #t for the
current buffer) to insert the output, with ANSI sequences stripped, at point. stdout and stderr are merged:
the child sees a terminal."
  (let* ((r (apply %call-process command (%process-opts-without opts ':buffer ':display)))
         (buf (%process-opt opts ':buffer)))
    (cond ((eq? buf #t) (insert (cdr r)))
          ((bufferp buf) (with-current-buffer buf (insert (cdr r))))
          ((string? buf) (with-current-buffer (get-buffer-create buf) (insert (cdr r)))))
    (car r)))

(define (call-process-to-string command . opts)
  "Run COMMAND as call-process does; two values: the exit status and the output."
  (let ((r (apply %call-process command (%process-opts-without opts ':buffer ':display))))
    (values (car r) (cdr r))))

(define (shell-command-to-string command . opts)
  "The output of COMMAND run to completion through the hub, ANSI sequences stripped (R4.44)."
  (cdr (apply %call-process command (%process-opts-without opts ':buffer ':display))))

(define (%shell-quote-argument s)
  "S quoted for a POSIX shell."
  (if (and (> (string-length s) 0)
           (let loop ((i 0))
             (or (= i (string-length s))
                 (and (let ((c (string-ref s i)))
                        (or (char-alphabetic? c) (char-numeric? c) (memv c '(#\- #\_ #\. #\/ #\= #\: #\, #\+ #\@ #\%))))
                      (loop (+ i 1))))))
      s
      (string-append "'" (let loop ((cs (string->list s)) (acc '()))
                           (if (null? cs) (apply string-append (reverse acc))
                               (loop (cdr cs) (cons (if (char=? (car cs) #\') "'\\''" (string (car cs))) acc))))
                     "'")))

(define (start-process name buffer program . args)
  "Start PROGRAM with ARGS, quoted for the shell, as a hub process named NAME writing to BUFFER (R4.43)."
  (make-process ':name name ':buffer buffer
                ':command (let loop ((a args) (acc (%shell-quote-argument program)))
                            (if (null? a) acc (loop (cdr a) (string-append acc " " (%shell-quote-argument (car a))))))))

(define (start-process-shell-command name buffer command)
  "Start COMMAND (a shell command line) as a hub process named NAME writing to BUFFER."
  (make-process ':name name ':buffer buffer ':command command))

(define (process-send-region process start end)
  "Send the text between START and END of the current buffer to PROCESS."
  (process-send-string process (buffer-substring start end)))

(define (process-session process)
  "The hub session handle of PROCESS (§5), or #f while the hub does not list it."
  (and (featurep 'wb-hub) (%session-handle-or-false (process-sid process))))

(define-command (list-processes)
  "Render every process of the image, card-less ones included (R9.22), in *Process List*; its buffer id."
  (interactive)
  (:where 'server)
  (let ((id (%process-list-refresh)))
    (message "~a processes" (length (process-list)))
    id))

(provide 'process)
;;; process.scm ends here
