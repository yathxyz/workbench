;;; address.scm --- buffer addresses: `Name › Heading ¶N "quote"`
;;
;; A pure Scheme port of bufferAddress, fmtAddr and resolveBufferAddress in web/app.ts (the
;; "addresses" section).  An address names a place in a Markdown buffer by its heading path, the
;; paragraph number under the innermost heading and a short quote of the words at point, so it
;; reads aloud and survives line shifts.  The golden test edwin/test/address.test.mts checks every
;; procedure here against the JavaScript over generated cases, so the regexps and the order of
;; the steps below follow app.js exactly, including its corners (a quote may keep a trailing
;; space when the line ends in whitespace, an empty name resolves to the first buffer, and so on).
;;
;;   (block-address name text pos)   -> address alist for POS (a 0-based offset) in TEXT
;;   (format-address address)        -> "Name › Heading ¶N \"quote\""
;;   (parse-address string)          -> address alist, or #f when the string names nothing
;;   (resolve-address string buffers) -> (name . pos) or #f; BUFFERS is an alist of (name . text)
;;
;; An address is an alist ((name . string) (path string ...) (para . integer) (quote . string));
;; address-name, address-path, address-para and address-quote read it.  Lines are separated by
;; newline characters only, as in Edwin buffers; offsets count UTF-16 code units like JavaScript.

;; Regexps are built with empty flags so they behave exactly like the literals in app.js.
(define address-heading-rx (regexp "^(#{1,6})\\s+(.*)$" ""))
(define address-heading-start-rx (regexp "^(#{1,6})\\s" ""))
(define address-h1-rx (regexp "^#\\s" ""))
(define address-bullet-rx (regexp "^\\s*([-*+]|\\d+\\.)\\s" ""))
(define address-quote-lead-rx (regexp "^[#>*\\-\\s]+" ""))
(define address-spaces-rx (regexp "\\s+" ""))
(define address-non-space-rx (regexp "\\S" ""))
(define address-tail-rx (regexp "^(.*?)\\s*(?:¶\\s*(\\d+))?\\s*(?:\"([^\"]*)\"?)?$" ""))

(define (address-name a) (assq-ref a 'name ""))
(define (address-path a) (assq-ref a 'path '()))
(define (address-para a) (assq-ref a 'para 0))
(define (address-quote a) (assq-ref a 'quote ""))
(define (make-address name path para quote-text)
  (list (cons 'name name) (cons 'path path) (cons 'para para) (cons 'quote quote-text)))

(define (address-clamp v lo hi) (max lo (min hi v)))
(define (address-blank? s) (string-null? (string-trim s)))

;; A line table stands for the CodeMirror document: a vector of line texts and a vector of their
;; start offsets.  Line numbers are 1-based like doc.line(n).
(define (make-address-doc text)
  (let* ((lines (list->vector (string-split text "\n")))
         (n (vector-length lines))
         (starts (make-vector n 0)))
    (do ((i 1 (+ i 1))) ((>= i n))
      (vector-set! starts i (+ (vector-ref starts (- i 1)) (string-length (vector-ref lines (- i 1))) 1)))
    (cons lines starts)))
(define (address-doc-lines doc) (vector-length (car doc)))
(define (address-doc-text doc i) (vector-ref (car doc) (- i 1)))
(define (address-doc-from doc i) (vector-ref (cdr doc) (- i 1)))
(define (address-doc-to doc i) (+ (address-doc-from doc i) (string-length (address-doc-text doc i))))
;; The number of the line holding POS: the last line starting at or before it (doc.lineAt).
(define (address-doc-line-at doc pos)
  (let loop ((i 1))
    (if (and (< i (address-doc-lines doc)) (<= (address-doc-from doc (+ i 1)) pos)) (loop (+ i 1)) i)))
;; doc.sliceString(a, b): the text between two offsets, empty when they are reversed.
(define (address-doc-slice doc a b)
  (let ((text (string-join (vector->list (car doc)) "\n")))
    (if (> a b) "" (substring text a b))))

;; The address of POS in TEXT, the text of a buffer called NAME.
(define (block-address name text pos)
  (let* ((doc (make-address-doc text))
         (ln (address-doc-line-at doc pos))
         (stack '())                    ; (level . title) pairs, innermost first
         (para 0) (in-para #f) (is-heading #f))
    (do ((i 1 (+ i 1))) ((> i ln))
      (let* ((t (address-doc-text doc i)) (m (regexp-match address-heading-rx t)))
        (cond (m (let ((lvl (string-length (cadr m))))
                   (set! stack (cons (cons lvl (string-trim (caddr m)))
                                     (filter (lambda (s) (< (car s) lvl)) stack)))
                   (set! para 0) (set! in-para #f) (set! is-heading (= i ln))))
              (else
               (set! is-heading #f)
               (cond ((address-blank? t) (set! in-para #f))
                     ((or (not in-para) (regexp-match address-bullet-rx t))
                      (set! para (+ para 1)) (set! in-para #t)))))))
    ;; The quote: from the start of the word at point, three words at most, 28 characters at most.
    (let* ((line-text (address-doc-text doc ln))
           (start (- pos (address-doc-from doc ln))))
      (let back ()
        (when (and (> start 0) (regexp-match address-non-space-rx (substring line-text (- start 1) start)))
          (set! start (- start 1)) (back)))
      (let* ((rest (regexp-replace address-quote-lead-rx (substring line-text start (string-length line-text)) ""))
             (words (regexp-split address-spaces-rx rest))
             (joined (string-join (list-head words (min 3 (length words))) " "))
             (cut (substring joined 0 (min 28 (string-length joined))))
             (quote-text (if (address-blank? line-text) "" (string-replace cut "\"" "")))
             (h1s 0))
        (do ((i 1 (+ i 1))) ((or (> i (address-doc-lines doc)) (>= h1s 2)))
          (when (regexp-match address-h1-rx (address-doc-text doc i)) (set! h1s (+ h1s 1))))
        (let ((path (reverse stack)))      ; outermost first
          ;; A single H1 is the document title when deeper headings follow it or it repeats the name.
          (when (and (= h1s 1) (pair? path) (= (car (car path)) 1)
                     (or (pair? (cdr path))
                         (string=? (string-downcase (cdr (car path))) (string-downcase name))))
            (set! path (cdr path)))
          (make-address name (map cdr path) (if is-heading 0 para) quote-text))))))

;; The printed form: name and headings joined by " › ", then ¶N when N is not 0, then the quote.
(define (format-address a)
  (let ((para (address-para a)) (quote-text (address-quote a)))
    (string-append (string-join (cons (address-name a) (address-path a)) " › ")
                   (if (and (number? para) (not (= para 0))) (string-append " ¶" (number->string para)) "")
                   (if (string-null? quote-text) "" (string-append " \"" quote-text "\"")))))

;; The parsing half of resolve-address.  Parts are split at "›" and trimmed; the last part may end
;; in ¶N and a quote (the closing quote mark is optional).  #f when nothing is left.
(define (parse-address q)
  (let ((parts (filter (lambda (s) (not (string-null? s))) (map string-trim (string-split q "›")))))
    (if (null? parts) #f
        (let* ((rev (reverse parts))
               (m (regexp-match address-tail-rx (car rev)))
               (head (cadr m)) (para-text (caddr m)) (quote-text (cadddr m))
               (parts (reverse (if (string-null? head) (cdr rev) (cons head (cdr rev))))))
          (make-address (if (pair? parts) (car parts) "")
                        (if (pair? parts) (cdr parts) '())
                        (if para-text (string->number para-text) 0)
                        (or quote-text ""))))))

;; Where Q points in BUFFERS, an alist of (name . text) in page order: (name . pos) or #f.
;; The buffer is the first whose name equals the address name ignoring case, else the first whose
;; name starts with it.  Each heading of the path narrows the line range to that section (a prefix
;; match ignoring case, deeper than the last); then ¶N picks a paragraph, and the quote is searched
;; in the paragraph, the section and the whole buffer in turn.
(define (resolve-address q buffers)
  (let ((a (parse-address q)))
    (and a
         (let* ((name (string-downcase (address-name a)))
                (hit (or (find (lambda (b) (string=? (string-downcase (car b)) name)) buffers)
                         (find (lambda (b) (string-prefix? name (string-downcase (car b)))) buffers))))
           (and hit
                (let* ((doc (make-address-doc (cdr hit)))
                       (nlines (address-doc-lines doc))
                       (from 1) (to nlines) (lvl 0))
                  ;; Narrow to the section named by the heading path.
                  (let next-title ((titles (address-path a)))
                    (when (pair? titles)
                      (let ((title (string-downcase (car titles))) (found #f))
                        (let scan ((i from))
                          (when (and (not found) (<= i to))
                            (let ((m (regexp-match address-heading-rx (address-doc-text doc i))))
                              (if (and m (> (string-length (cadr m)) lvl)
                                       (string-prefix? title (string-downcase (string-trim (caddr m)))))
                                  (begin
                                    (set! lvl (string-length (cadr m)))
                                    (set! from (+ i 1))
                                    (let close ((j (+ i 1)))
                                      (if (<= j nlines)
                                          (let ((mm (regexp-match address-heading-start-rx (address-doc-text doc j))))
                                            (if (and mm (<= (string-length (cadr mm)) lvl))
                                                (set! to (- j 1))
                                                (close (+ j 1))))
                                          (set! to (- j 1))))
                                    (set! found #t))
                                  (scan (+ i 1))))))
                        (when found (next-title (cdr titles))))))
                  (let* ((pos (address-doc-from doc (address-clamp (- from 1) 1 nlines)))
                         (p-from from) (p-to to)
                         (para (address-para a)) (quote-text (address-quote a)))
                    ;; Paragraph N of the section: blank lines and list items start paragraphs.
                    (when (and (number? para) (not (= para 0)))
                      (let ((k 0) (in-p #f))
                        (let loop ((i from))
                          (when (<= i to)
                            (let ((t (address-doc-text doc i)))
                              (cond ((regexp-match address-heading-start-rx t)
                                     (set! k 0) (set! in-p #f) (loop (+ i 1)))
                                    (else
                                     (let* ((bullet (if (regexp-match address-bullet-rx t) #t #f))
                                            (blank (address-blank? t))
                                            (action 'count))
                                       (when (or blank (and bullet in-p (= k para)))
                                         (if (and in-p (= k para))
                                             (begin (set! p-to (- i 1)) (set! action 'stop))
                                             (begin (set! in-p #f) (when blank (set! action 'skip)))))
                                       (cond ((eq? action 'stop) #f)
                                             ((eq? action 'skip) (loop (+ i 1)))
                                             (else
                                              (when (or (not in-p) bullet)
                                                (set! k (+ k 1)) (set! in-p #t)
                                                (when (= k para)
                                                  (set! pos (address-doc-from doc i))
                                                  (set! p-from i)))
                                              (loop (+ i 1))))))))))))
                    ;; The quote: searched ignoring case, in the paragraph, the section, the buffer.
                    (when (not (string-null? quote-text))
                      (let ((needle (string-downcase quote-text)))
                        (let try ((scopes (list (cons p-from p-to) (cons from to) (cons 1 nlines))))
                          (when (pair? scopes)
                            (let* ((s (address-doc-from doc (address-clamp (car (car scopes)) 1 nlines)))
                                   (e (address-doc-to doc (address-clamp (cdr (car scopes)) 1 nlines)))
                                   (i (string-search-forward needle (string-downcase (address-doc-slice doc s e)) 0)))
                              (if i (set! pos (+ s i)) (try (cdr scopes))))))))
                    (cons (car hit) pos))))))))

(provide 'address)
