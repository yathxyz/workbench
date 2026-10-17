;;; threads.scm --- Scheme side of the server image's threads (spec §4.8)  -*- scheme -*-
;;
;; Loaded by edwin/server/threads.mts into the server image only; the primitives it wraps are
;; server-only (R4.49). with-timeout and with-mutex are the usual macros over the primitives.

(define-syntax with-timeout
  (syntax-rules ()
    ((_ (seconds timeout-form ...) body ...)
     (guard (e ((timeout? e) timeout-form ...))
       (%with-timeout seconds (lambda () body ...))))))

(define-syntax with-mutex
  (syntax-rules ()
    ((_ mutex body ...)
     (let ((m mutex))
       (mutex-lock! m)
       (dynamic-wind (lambda () #f) (lambda () body ...) (lambda () (mutex-unlock! m)))))))

(define (thread-join! thread . rest) (apply thread-join thread rest))

(provide 'threads)
;;; threads.scm ends here
