;;; debug.scm --- the debugger, the inspector and introspection commands of the server image  -*- scheme -*-
;;
;; Loaded by edwin/server/debug.mjs into the server image. The modes and their keys are defined here so
;; the frames that display these server special buffers (E3 loads this file in frames too) know them.
;; Every command is (:where 'server): a frame sends call{cmd} with the point of its *Backtrace* line.

(define (%write-string x) (call-with-output-string (lambda (p) (write x p))))

;; The frame or part number at the start of the current line: "  3:   (proc ...)" -> 3.
(define (%number-at-line-start)
  (save-excursion
    (beginning-of-line)
    (if (looking-at "^ *\\([0-9]+\\):") (string->number (match-string 1)) #f)))

(define (%backtrace-frame)
  (or (%number-at-line-start) (user-error "Point is not on a stack frame")))

(define-derived-mode backtrace-mode special-mode "Backtrace"
  "The debugger of the server image (R4.35).")
(define-key backtrace-mode-map (kbd "RET") 'debugger-show-locals)
(define-key backtrace-mode-map (kbd "e") 'debugger-eval-in-frame)
(define-key backtrace-mode-map (kbd "v") 'debugger-inspect-local)
(define-key backtrace-mode-map (kbd "r") 'debugger-restart)
(define-key backtrace-mode-map (kbd "c") 'debugger-continue-command)
(define-key backtrace-mode-map (kbd "q") 'debugger-abort-command)

(define-command (debugger-show-locals)
  "Show the locals of the stack frame at point by parameter name."
  (interactive) (:where 'server)
  (let ((locals (debugger-locals (%backtrace-frame))))
    (if (null? locals)
        (message "No locals in this frame")
        (message "%s" (string-join (map (lambda (p) (string-append (symbol->string (car p)) " = " (%write-string (cdr p)))) locals) "; ")))))

(define-command (debugger-eval-in-frame form)
  "Evaluate FORM in the lexical environment of the stack frame at point."
  (interactive "xEval in frame: ") (:where 'server)
  (let ((v (debugger-eval (%backtrace-frame) form)))
    (message "%s" (%write-string v))
    v))

(define-command (debugger-inspect-local name)
  "Open the inspector on the local NAME of the stack frame at point."
  (interactive "SInspect local: ") (:where 'server)
  (let ((p (assq name (debugger-locals (%backtrace-frame)))))
    (if p (inspect (cdr p)) (user-error "No local named %s in this frame" name))))

(define-command (debugger-restart index)
  "Invoke restart number INDEX of the thread in the debugger."
  (interactive "nRestart number: ") (:where 'server)
  (let ((r (debugger-invoke-restart index)))
    (%debugger-refresh)
    (message "Invoked restart %s" r)))

(define-command (debugger-continue-command)
  "Continue the thread in the debugger (its condition must be continuable)."
  (interactive) (:where 'server)
  (debugger-continue)
  (%debugger-refresh)
  (message "Continued"))

(define-command (debugger-abort-command)
  "Invoke the abort restart of the thread in the debugger."
  (interactive) (:where 'server)
  (debugger-abort)
  (%debugger-refresh)
  (message "Aborted"))

(define-derived-mode inspector-mode special-mode "Inspector"
  "The inspector of the server image (R4.50).")
(define-key inspector-mode-map (kbd "RET") 'inspector-enter)
(define-key inspector-mode-map (kbd "l") 'inspector-pop)

(define-command (inspector-enter)
  "Enter the part of the inspected object at point."
  (interactive) (:where 'server)
  (let ((n (%number-at-line-start)))
    (if n (%inspect-nth n) (user-error "Point is not on a part"))))

(define-command (inspector-pop)
  "Back to the enclosing object in the inspector."
  (interactive) (:where 'server)
  (%inspect-pop))

(define-command (list-threads)
  "Show every thread of the server image in *Threads* (R4.37)."
  (interactive) (:where 'server)
  (%show-special "*Threads*" (%threads-text)))

(define-command (list-clients)
  "Show every connected client in *Clients* (R4.50)."
  (interactive) (:where 'server)
  (%show-special "*Clients*" (%clients-text)))

(define-command (apropos pattern)
  "List the commands, procedures, variables and macros whose names match PATTERN."
  (interactive "sApropos (regexp): ") (:where 'server)
  (%show-special "*Apropos*" (%apropos-text pattern)))

(define-command (find-definition name)
  "Show where NAME is defined: a Scheme procedure's source location or a primitive's line in edwin/src."
  (interactive "aFind definition of: ") (:where 'server)
  (let ((loc (find-definition-location name)))
    (cond ((not loc) (user-error "No definition found for %s" name))
          ((car loc) (message "%s is defined at %s:%s" name (car loc) (cadr loc)) loc)
          (else (message "%s is a %s without a recorded location" name (list-ref loc 2)) loc))))

(define-command (room)
  "Report the heap, the buffers and the journal sizes (R4.50)."
  (interactive) (:where 'server)
  (let ((r (room-internal)))
    (message "Heap %s of %s MiB; %s buffers, %s chars; journals %s KiB; %s threads"
             (cdr (assq 'heapUsedMiB r)) (cdr (assq 'heapTotalMiB r)) (cdr (assq 'buffers r))
             (cdr (assq 'chars r)) (quotient (cdr (assq 'journalBytes r)) 1024) (cdr (assq 'threads r)))
    r))

(provide 'debug)
;;; debug.scm ends here
