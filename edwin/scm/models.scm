;;; models.scm --- gptel in the server image: backends, requests and streaming (spec §12.3)  -*- scheme -*-
;;
;; Loaded by edwin/server/models.mjs into the server image only. The primitives it wraps are server-only
;; (R4.49): credential, http-request, %make-backend, %model-request, %model-stream, %model-usage.
;;
;; Backends are objects (R12.1). The module defines `workbench` from edit.json `models` (R12.3); init.scm may
;; add more and change gptel-backend, after this file has loaded (it provides the feature `models`):
;;
;;   (gptel-make-openai "local" :host "localhost:11434" :protocol "http"
;;     :models '("qwen3:8b") :tiers '((default . "qwen3:8b")))
;;   (gptel-make-anthropic "mine" :key (credential "anthropic-api-key") :models '("claude-opus-5-5"))
;;   (set! gptel-backend "local")
;;
;; Keys are never typed here (R12.2): :key takes only a (credential NAME) handle, which prints as
;; #<credential NAME> and which only http-request can turn into a header, on the backend's own origin.
;;
;; gptel-request sends a prompt and streams the answer into a buffer or to a callback on a background thread
;; attributed to the agent gptel:<backend> (R12.9), so every frame sees it stream and undo-writer undoes it.
;; gptel-send is the server command behind C-c RET: the region, or the text before point, is the prompt and the
;; answer streams in after it. gptel-abort stops the request running in the buffer. model-usage sums the last
;; 30 days of usage.jsonl (R12.14).

(define (gptel-make-anthropic name . keys)
  "Define an Anthropic Messages API backend NAME: :key (a credential handle) :host :protocol :endpoint :models :tiers :headers :stream."
  (apply %make-backend name 'anthropic keys))

(define (gptel-make-openai name . keys)
  "Define an OpenAI-compatible backend NAME: :key (a credential handle or #f) :host :protocol :endpoint :url :models :tiers :headers :stream."
  (apply %make-backend name 'openai keys))

(define (gptel-backends)
  "Names of the defined backends."
  (%backends))

(define (gptel-backend-info . backend)
  "An alist describing BACKEND (default the current one): name kind url origin credential models tiers usable."
  (%backend-info (if (pair? backend) (car backend) (%current-backend))))

(define (gptel--plist-get keys key . default)
  (let loop ((k keys))
    (cond ((or (null? k) (null? (cdr k))) (if (pair? default) (car default) #f))
          ((eq? (car k) key) (cadr k))
          (else (loop (cddr k))))))

(define (gptel--request-alist prompt keys)
  (let ((alist '()))
    (define (put! name value) (if value (set! alist (cons (cons name value) alist))))
    (if (string? prompt) (put! 'prompt prompt) (put! 'messages prompt))
    (put! 'system (gptel--plist-get keys ':system))
    (put! 'model (gptel--plist-get keys ':model))
    (put! 'tier (gptel--plist-get keys ':tier))
    (put! 'max-tokens (gptel--plist-get keys ':max-tokens))
    (put! 'effort (gptel--plist-get keys ':effort))
    (put! 'temperature (gptel--plist-get keys ':temperature))
    (put! 'caller (gptel--plist-get keys ':caller "gptel"))
    alist))

;; The requests running now, as an alist of buffer -> thread, for gptel-abort.
(define gptel--running '())

(define (gptel--forget! thread)
  (set! gptel--running (filter (lambda (p) (not (eq? (cdr p) thread))) gptel--running)))

(define (gptel-request prompt . keys)
  "Send PROMPT (a string, or a list of ((role . \"user\") (content . \"...\")) alists) to the current backend.
Keys: :backend NAME, :model, :tier, :system, :max-tokens, :effort, :temperature, :caller,
:buffer B and :position P (a marker or position: the answer streams in there), :stream (lambda (text) ...)
(the cumulative text as it arrives), :callback (lambda (result) ...) (the result alist when done, or #f on
error, with the condition as the second argument). Without :buffer, :stream or :callback it waits for the
answer and returns the result alist. Otherwise it returns the background thread."
  (let* ((backend (or (gptel--plist-get keys ':backend) (%current-backend)))
         (request (gptel--request-alist prompt keys))
         (buffer (gptel--plist-get keys ':buffer))
         (position (gptel--plist-get keys ':position))
         (on-stream (gptel--plist-get keys ':stream))
         (callback (gptel--plist-get keys ':callback)))
    (if (and (not buffer) (not on-stream) (not callback))
        (%model-request backend request #f)
        (let* ((buf (and buffer (if (bufferp buffer) buffer (get-buffer-create buffer))))
               (marker (and buf (with-current-buffer buf
                                  (copy-marker (if position (if (number? position) position (marker-position position)) (point)) #t))))
               (inserted 0)
               (thread #f))
          (define (on-text text)
            (when on-stream (on-stream text))
            (when marker
              (with-current-buffer buf
                (save-excursion
                  (goto-char (marker-position marker))
                  (insert (substring text inserted (string-length text)))
                  (set! inserted (string-length text))))))
          (define (finish result condition)
            (gptel--forget! thread)
            (when marker (set-marker marker #f))
            (when callback (callback result condition)))
          (set! thread (%model-stream backend request on-text
                                      (lambda (result) (finish result #f))
                                      (lambda (condition) (finish #f condition))))
          (when buf (set! gptel--running (cons (cons buf thread) gptel--running)))
          thread))))

(define-command (gptel-send)
  "Send the region, or the text before point, to the current backend; the answer streams in after it."
  (interactive) (:where 'server)
  (let* ((buf (current-buffer))
         (start (if (region-active-p) (region-beginning) (point-min)))
         (end (if (region-active-p) (region-end) (point)))
         (prompt (buffer-substring start end)))
    (when (string-null? (string-trim prompt)) (signal 'user-error "gptel: nothing to send"))
    (when (assq buf gptel--running) (signal 'user-error "gptel: a request is already running in this buffer (gptel-abort stops it)"))
    (goto-char end)
    (insert "\n\n")
    (let ((backend (%current-backend)))
      (gptel-request prompt :buffer buf :position (point)
                     :callback (lambda (result condition)
                                 (if condition
                                     (message "gptel: ~a" (condition/report-string condition))
                                     (message "gptel: ~a answered (~a tokens)" (assq-ref result 'model)
                                              (+ (assq-ref result 'input-tokens 0) (assq-ref result 'output-tokens 0))))))
      (message "gptel: asking ~a" (assq-ref (%backend-info backend) 'name)))))

(define-command (gptel-abort)
  "Stop the gptel request running in this buffer."
  (interactive) (:where 'server)
  (let ((p (assq (current-buffer) gptel--running)))
    (if (not p)
        (message "gptel: no request is running here")
        (begin (thread-kill (cdr p)) (gptel--forget! (cdr p)) (message "gptel: aborted")))))

(define (model-usage-summary . days)
  "The usage of the last DAYS days (default 30) as an alist (R12.14)."
  (%model-usage (if (pair? days) (car days) 30)))

(define-command (model-usage)
  "Show the model usage of the last 30 days (requests, tokens, by model and caller)."
  (interactive) (:where 'server)
  (let* ((u (%model-usage 30))
         (by (lambda (key) (let ((rows (assq-ref u key '())))
                             (string-join (map (lambda (p) (format "~a: ~a requests, ~a in, ~a out"
                                                                   (car p) (assq-ref (cdr p) 'requests 0)
                                                                   (assq-ref (cdr p) 'input-tokens 0) (assq-ref (cdr p) 'output-tokens 0)))
                                               rows)
                                          "; ")))))
    (message "Model usage, ~a days: ~a requests (~a failed), ~a input tokens, ~a output tokens. By model: ~a. By caller: ~a"
             (assq-ref u 'days 30) (assq-ref u 'requests 0) (assq-ref u 'errors 0)
             (assq-ref u 'input-tokens 0) (assq-ref u 'output-tokens 0)
             (by 'by-model) (by 'by-caller))
    u))

(provide 'models)
;;; models.scm ends here
