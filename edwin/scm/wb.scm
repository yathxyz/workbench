;;; wb.scm --- Workbench as Lisp objects: the session family and the events (spec §5)  -*- scheme -*-
;;
;; Loaded by edwin/server/wb.mts into the server image only. The primitives (session-list, session-get,
;; %card-send, %card-read, card-interrupt, %card-kill, acp-prompt, acp-prompt-async, %shell-run) are
;; server-only (R4.49); this file adds the keyword-taking wrappers and the confirmation rule of R5.4.
;;
;; The board family (board-cards, find-card, open-card, link-cards, ...) is absent until EW-M4 lands:
;; (featurep 'wb-board) is #f (R5.3). The feature wb-hub is always present.

(define (%wb-opt opts key . default)
  "The value after keyword KEY in the keyword list OPTS, or DEFAULT (#f)."
  (let loop ((o opts))
    (cond ((or (null? o) (null? (cdr o))) (if (pair? default) (car default) #f))
          ((eq? (car o) key) (cadr o))
          (else (loop (cddr o))))))

(define (card-send target string)
  "Send STRING to TARGET, a session (or a process): pty.input for a PTY, acp.prompt with one text block for
an agent session. Returns the session."
  (%card-send target string))

(define (card-read target . opts)
  "The last :lines lines (default 200) of TARGET's PTY as plain text, or the Org transcript of an agent
session."
  (%card-read target (%wb-opt opts ':lines)))

(define (card-kill target . opts)
  "End TARGET's session. Destructive (R5.4): from code pass :force #t; called interactively it asks y-or-n-p
in the calling frame."
  (if (or (%wb-opt opts ':force) (y-or-n-p (string-append "Kill " (session-id (session-get target)) "? ")))
      (%card-kill target)
      (user-error "Not killed")))

(define (shell-run command . opts)
  "Open a shell card, send COMMAND and a newline, and wait until the shell is in the foreground again or
:timeout (default 600 s) passes; the output since the send. Options: :shell :cwd :timeout."
  (%shell-run command (%wb-opt opts ':shell) (%wb-opt opts ':cwd) (%wb-opt opts ':timeout)))

(define (session-alive? session) (session-get session 'alive))
(define (session-kind session) (session-get session 'kind))
(define (session-title session) (session-get session 'title))
(define (session-cwd session) (session-get session 'cwd))

(provide 'wb-hub)
;;; wb.scm ends here
