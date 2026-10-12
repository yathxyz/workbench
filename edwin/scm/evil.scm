;;; evil.scm --- Vim states and keys for Edwin

;; This file is the Vim layer.  The JavaScript core supplies the
;; machinery: states and their keymaps, the operator-pending reader,
;; registers, the . history, macros, / search and the : command line.
;; Every key is bound here, and every motion, text object and operator
;; is defined here, in Scheme.  Change one, then :w and :so to apply it.
;;
;; Commands read their arguments through interactive codes:
;;   <c>  the count, or #f           <x>  the register, or #f
;;   <R>  BEG END TYPE of the motion or text object typed next,
;;        or of the selection in Visual state
;;   <r>  BEG END only               <C>  a character typed next
;;   <L>  BEG END of the ex range, by default the current line
;;   <%>  the same, by default the whole buffer
;;   <a>  the ex argument            <!>  #t after a !
;;
;; TYPE is exclusive, inclusive, line or block.  BEG and END are
;; already adjusted, so the text is always (buffer-substring BEG END).

;;;; Definers

(define-syntax evil-define-motion
  (syntax-rules (interactive :type :jump)
    ((_ (name . args) doc (interactive spec) #:type type #:jump body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-motion-type 'type)
            (set-procedure-property! name 'evil-jump #t) 'name))
    ((_ (name . args) doc (interactive spec) #:type type body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-motion-type 'type) 'name))
    ((_ (name . args) doc (interactive spec) #:jump body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-motion-type 'exclusive)
            (set-procedure-property! name 'evil-jump #t) 'name))
    ((_ (name . args) doc (interactive spec) body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-motion-type 'exclusive) 'name))
    ((_ (name . args) doc #:type type #:jump body ...)
     (evil-define-motion (name . args) doc (interactive "<c>") #:type type #:jump body ...))
    ((_ (name . args) doc #:type type body ...)
     (evil-define-motion (name . args) doc (interactive "<c>") #:type type body ...))
    ((_ (name . args) doc #:jump body ...)
     (evil-define-motion (name . args) doc (interactive "<c>") #:jump body ...))
    ((_ (name . args) doc body ...)
     (evil-define-motion (name . args) doc (interactive "<c>") body ...))))

(define-syntax evil-define-text-object
  (syntax-rules ()
    ((_ (name . args) doc body ...)
     (begin (define-command (name . args) doc (interactive "<c>")
              (evil--apply-text-object (begin body ...)))
            (set-procedure-property! name 'evil-text-object #t) 'name))))

(define-syntax evil-define-operator
  (syntax-rules (interactive :no-repeat)
    ((_ (name . args) doc #:no-repeat (interactive spec) body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-operator #t)
            (set-procedure-property! name 'evil-repeat 'abort) 'name))
    ((_ (name . args) doc (interactive spec) body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-operator #t) 'name))
    ((_ (name . args) doc body ...)
     (begin (define-command (name . args) doc (interactive "<R>") body ...)
            (set-procedure-property! name 'evil-operator #t) 'name))))

(define-syntax evil-define-command
  (syntax-rules (interactive :no-repeat)
    ((_ (name . args) doc #:no-repeat (interactive spec) body ...)
     (begin (define-command (name . args) doc (interactive spec) body ...)
            (set-procedure-property! name 'evil-repeat 'abort) 'name))
    ((_ (name . args) doc #:no-repeat body ...)
     (begin (define-command (name . args) doc body ...)
            (set-procedure-property! name 'evil-repeat 'abort) 'name))
    ((_ (name . args) doc (interactive spec) body ...)
     (define-command (name . args) doc (interactive spec) body ...))
    ((_ (name . args) doc body ...)
     (define-command (name . args) doc body ...))))

(define (evil-ex-define-cmd name command)
  "Make the ex command NAME run COMMAND.
Brackets mark the part that may be left out, as in \"w[rite]\"."
  (let ((entry (assoc name evil-ex-commands)))
    (if entry
        (set-cdr! entry command)
        (set! evil-ex-commands (append evil-ex-commands (list (cons name command)))))
    command))

(define (evil--bind map . bindings)
  "Bind each KEY DEF pair of BINDINGS in MAP."
  (let loop ((b bindings))
    (when (pair? b)
      (define-key map (car b) (cadr b))
      (loop (cddr b)))))

;;;; Helpers

(define (evil--first-non-blank)
  "Move point to the first non-blank character of this line."
  (beginning-of-line)
  (skip-chars-forward " \t"))

(define (evil--empty-line?)
  "#t if point is on an empty line."
  (save-excursion (beginning-of-line) (or (eobp) (eqv? (char-after) #\newline))))

(define (evil--blank-line?)
  "#t if the line at point holds only blanks."
  (save-excursion (beginning-of-line) (looking-at "[ \t]*$")))

(define (evil--cls #!optional pos big)
  "Word class of the character at POS: 0 blank, 1 word, 2 other, 3 newline, 4 none."
  (evil--class (char-after (or pos (point))) big))

(define (evil--line-indentation #!optional offset)
  "The leading blanks of the line OFFSET lines away from point."
  (save-excursion
    (forward-line (or offset 0))
    (buffer-substring (point) (begin (skip-chars-forward " \t") (point)))))

(define (evil--lines count)
  "BEG and END of COUNT whole lines from point, as a list."
  (list (line-beginning-position)
        (min (point-max) (+ 1 (line-end-position (or count 1))))))

(define (evil--whole-lines beg end)
  "BEG and END grown to whole lines, as a list."
  (list (save-excursion (goto-char beg) (line-beginning-position))
        (save-excursion (goto-char (max beg (- end 1)))
                        (min (point-max) (+ 1 (line-end-position))))))

(define (evil--map-range beg end type f)
  "Call F with the start and end of each piece of the range (one per line of a block)."
  (if (eq? type 'block)
      (for-each (lambda (r) (f (car r) (cdr r))) (evil--block-ranges beg end))
      (f beg end)))

(define (evil--transform-region beg end f)
  "Replace the text from BEG to END with the result of F on each character."
  (let ((s (buffer-substring beg end)))
    (save-excursion
      (delete-region beg end)
      (goto-char beg)
      (insert (string-map f s)))))

(define (evil--invert-char-case c)
  (if (char-upper-case? c) (char-downcase c) (char-upcase c)))

(define (evil--rot13-char c)
  (let ((n (char->integer c)))
    (cond ((and (>= n 97) (<= n 122)) (integer->char (+ 97 (modulo (+ (- n 97) 13) 26))))
          ((and (>= n 65) (<= n 90)) (integer->char (+ 65 (modulo (+ (- n 65) 13) 26))))
          (else c))))

;;;; Motions: characters and lines

(evil-define-motion (evil-backward-char count)
  "Move left COUNT characters, staying on this line (h)."
  (let ((bol (line-beginning-position)))
    (when (= (point) bol) (signal 'beginning-of-line))
    (goto-char (max bol (- (point) (or count 1))))))

(evil-define-motion (evil-forward-char count)
  "Move right COUNT characters, staying on this line (l)."
  (let* ((eol (line-end-position))
         (limit (if (or (evil-operator-state?) (evil-insert-state?))
                    eol
                    (max (line-beginning-position) (- eol 1)))))
    (when (>= (point) limit) (signal 'end-of-line))
    (goto-char (min limit (+ (point) (or count 1))))))

(evil-define-motion (evil-next-line count)
  "Move down COUNT lines, keeping the column (j)."
  #:type line
  (evil--line-move (or count 1)))

(evil-define-motion (evil-previous-line count)
  "Move up COUNT lines, keeping the column (k)."
  #:type line
  (evil--line-move (- (or count 1))))

(evil-define-motion (evil-next-line-first-non-blank count)
  "Move down COUNT lines, to the first non-blank character (+ and RET)."
  #:type line
  (evil--line-move (or count 1))
  (evil--first-non-blank))

(evil-define-motion (evil-previous-line-first-non-blank count)
  "Move up COUNT lines, to the first non-blank character (-)."
  #:type line
  (evil--line-move (- (or count 1)))
  (evil--first-non-blank))

(evil-define-motion (evil-next-line-1-first-non-blank count)
  "Move down COUNT - 1 lines, to the first non-blank character (_)."
  #:type line
  (when (and count (> count 1)) (evil--line-move (- count 1)))
  (evil--first-non-blank))

(evil-define-motion (evil-beginning-of-line count)
  "Move to column 0 (0)."
  (beginning-of-line))

(evil-define-motion (evil-first-non-blank count)
  "Move to the first non-blank character of the line (^)."
  (evil--first-non-blank))

(evil-define-motion (evil-end-of-line count)
  "Move to the last character of the line, COUNT - 1 lines down ($)."
  #:type inclusive
  (when (and count (> count 1)) (evil--line-move (- count 1) #t))
  (end-of-line)
  (unless (or (bolp) (evil-visual-state?)) (backward-char 1)))

(evil-define-motion (evil-last-non-blank count)
  "Move to the last non-blank character of the line (g_)."
  #:type inclusive
  (when (and count (> count 1)) (evil--line-move (- count 1) #t))
  (end-of-line)
  (skip-chars-backward " \t")
  (unless (bolp) (backward-char 1)))

(evil-define-motion (evil-goto-column count)
  "Move to column COUNT, counting from 1 (|)."
  (move-to-column (- (or count 1) 1)))

(evil-define-motion (evil-goto-line count)
  "Move to line COUNT, by default the last, at its first non-blank (G)."
  #:type line #:jump
  (if (not count)
      (goto-char (evil--last-line-position))
      (begin
        (goto-char (point-min))
        (forward-line (- count 1))
        (when (and (eobp) (bolp) (not (bobp))) (forward-line -1))))
  (evil--first-non-blank))

(evil-define-motion (evil-goto-first-line count)
  "Move to line COUNT, by default the first, at its first non-blank (gg)."
  #:type line #:jump
  (evil-goto-line (or count 1)))

;;;; Motions: words

;; A word is a run of letters, digits and _ or a run of other non-blank
;; characters.  A WORD is any run of non-blank characters.  An empty line
;; counts as a word too.

(define (evil--forward-word-begin-1 big)
  (let ((c (evil--cls #f big)))
    (cond ((memv c '(1 2))
           (while (and (not (eobp)) (= (evil--cls #f big) c)) (forward-char 1)))
          ((= c 3) (forward-char 1)))
    (while (and (not (eobp))
                (let ((k (evil--cls #f big))) (or (= k 0) (and (= k 3) (not (bolp))))))
      (forward-char 1))))

(define (evil--forward-word-end-1 big)
  (unless (eobp) (forward-char 1))
  (while (and (not (eobp)) (memv (evil--cls #f big) '(0 3))) (forward-char 1))
  (let ((c (evil--cls #f big)))
    (while (and (< (+ (point) 1) (point-max)) (= (evil--cls (+ (point) 1) big) c))
      (forward-char 1))))

(define (evil--backward-word-begin-1 big)
  (unless (bobp) (backward-char 1))
  (while (and (not (bobp))
              (let ((k (evil--cls #f big))) (or (= k 0) (and (= k 3) (not (bolp))))))
    (backward-char 1))
  (let ((c (evil--cls #f big)))
    (when (memv c '(1 2))
      (while (and (not (bobp)) (= (evil--cls (- (point) 1) big) c)) (backward-char 1)))))

(define (evil--backward-word-end-1 big)
  (let ((c (evil--cls #f big)))
    (when (memv c '(1 2))
      (while (and (not (bobp)) (= (evil--cls #f big) c)) (backward-char 1))))
  (while (and (not (bobp))
              (let ((k (evil--cls #f big))) (or (= k 0) (and (= k 3) (not (bolp))))))
    (backward-char 1)))

(evil-define-motion (evil-forward-word-begin count #!optional big)
  "Move to the start of the COUNTth next word (w).
After an operator, a word at the end of a line stops at the line end, as in Vim."
  (when (eobp) (signal 'end-of-buffer))
  (let ((n (or count 1)))
    (dotimes (i n)
      (let ((start (point)) (line (line-number-at-pos)))
        (evil--forward-word-begin-1 big)
        (when (and (= i (- n 1)) (evil-operator-state?)
                   (> (line-number-at-pos) line)
                   (< start (save-excursion (goto-char start) (line-end-position))))
          (goto-char start)
          (end-of-line))))))

(evil-define-motion (evil-forward-WORD-begin count)
  "Move to the start of the COUNTth next WORD (W)."
  (evil-forward-word-begin count #t))

(evil-define-motion (evil-forward-word-end count #!optional big)
  "Move to the end of the COUNTth word (e)."
  #:type inclusive
  (when (>= (+ (point) 1) (point-max)) (signal 'end-of-buffer))
  (dotimes (_ (or count 1)) (evil--forward-word-end-1 big)))

(evil-define-motion (evil-forward-WORD-end count)
  "Move to the end of the COUNTth WORD (E)."
  #:type inclusive
  (evil-forward-word-end count #t))

(evil-define-motion (evil-backward-word-begin count #!optional big)
  "Move to the start of the COUNTth previous word (b)."
  (when (bobp) (signal 'beginning-of-buffer))
  (dotimes (_ (or count 1)) (evil--backward-word-begin-1 big)))

(evil-define-motion (evil-backward-WORD-begin count)
  "Move to the start of the COUNTth previous WORD (B)."
  (evil-backward-word-begin count #t))

(evil-define-motion (evil-backward-word-end count #!optional big)
  "Move to the end of the COUNTth previous word (ge)."
  #:type inclusive
  (when (bobp) (signal 'beginning-of-buffer))
  (dotimes (_ (or count 1)) (evil--backward-word-end-1 big)))

(evil-define-motion (evil-backward-WORD-end count)
  "Move to the end of the COUNTth previous WORD (gE)."
  #:type inclusive
  (evil-backward-word-end count #t))

;;;; Motions: finding characters, brackets, paragraphs, screen lines, marks

(define evil-last-find #f
  "The last f, F, t or T as (CHAR FORWARD TILL).")

(define (evil--find count char forward till repeat)
  (let ((pos (evil--find-char (or count 1) char forward till repeat)))
    (unless pos (signal 'search-failed (char->string char)))
    (set! evil-this-type (if forward 'inclusive 'exclusive))
    (goto-char pos)))

(evil-define-motion (evil-find-char count char)
  "Move to the COUNTth CHAR to the right on this line (f)."
  (interactive "<c><C>") #:type inclusive
  (set! evil-last-find (list char #t #f))
  (evil--find count char #t #f #f))

(evil-define-motion (evil-find-char-backward count char)
  "Move to the COUNTth CHAR to the left on this line (F)."
  (interactive "<c><C>")
  (set! evil-last-find (list char #f #f))
  (evil--find count char #f #f #f))

(evil-define-motion (evil-find-char-to count char)
  "Move to just before the COUNTth CHAR to the right (t)."
  (interactive "<c><C>") #:type inclusive
  (set! evil-last-find (list char #t #t))
  (evil--find count char #t #t #f))

(evil-define-motion (evil-find-char-to-backward count char)
  "Move to just after the COUNTth CHAR to the left (T)."
  (interactive "<c><C>")
  (set! evil-last-find (list char #f #t))
  (evil--find count char #f #t #f))

(evil-define-motion (evil-repeat-find-char count)
  "Repeat the last f, F, t or T (;)."
  #:type inclusive
  (unless evil-last-find (user-error "No previous f, F, t or T"))
  (apply (lambda (char forward till) (evil--find count char forward till #t)) evil-last-find))

(evil-define-motion (evil-repeat-find-char-reverse count)
  "Repeat the last f, F, t or T the other way (,)."
  (unless evil-last-find (user-error "No previous f, F, t or T"))
  (apply (lambda (char forward till) (evil--find count char (not forward) till #t)) evil-last-find))

(evil-define-motion (evil-jump-item count)
  "Move to the bracket matching the next bracket on this line (%).
With COUNT, move to COUNT percent of the way through the buffer."
  #:type inclusive #:jump
  (if count
      (begin
        (set! evil-this-type 'line)
        (evil-goto-line (max 1 (quotient (+ (* count (line-number-at-pos (point-max))) 99) 100))))
      (let ((pos (evil--jump-item)))
        (unless pos (user-error "No matching bracket on this line"))
        (goto-char pos))))

(evil-define-motion (evil-forward-paragraph count)
  "Move past the end of the COUNTth paragraph (})."
  #:jump
  (dotimes (_ (or count 1))
    (while (and (not (eobp)) (evil--empty-line?)) (forward-line 1))
    (while (and (not (eobp)) (not (evil--empty-line?))) (forward-line 1))))

(evil-define-motion (evil-backward-paragraph count)
  "Move before the start of the COUNTth previous paragraph ({)."
  #:jump
  (dotimes (_ (or count 1))
    (beginning-of-line)
    (when (and (not (bobp)) (evil--empty-line?)) (forward-line -1))
    (while (and (not (bobp)) (evil--empty-line?)) (forward-line -1))
    (while (and (not (bobp)) (not (evil--empty-line?))) (forward-line -1))))

(evil-define-motion (evil-window-top count)
  "Move to the COUNTth line from the top of the window (H)."
  #:type line #:jump
  (goto-char (evil--window-line #\H count))
  (evil--first-non-blank))

(evil-define-motion (evil-window-middle count)
  "Move to the middle line of the window (M)."
  #:type line #:jump
  (goto-char (evil--window-line #\M))
  (evil--first-non-blank))

(evil-define-motion (evil-window-bottom count)
  "Move to the COUNTth line from the bottom of the window (L)."
  #:type line #:jump
  (goto-char (evil--window-line #\L count))
  (evil--first-non-blank))

(evil-define-command (evil-set-mark char)
  "Set mark CHAR at point (m)."
  #:no-repeat
  (interactive "<C>")
  (evil-set-marker char))

(evil-define-motion (evil-goto-mark char)
  "Move to mark CHAR (`).  `` goes back to where the last jump started."
  (interactive "<C>") #:jump
  (let ((pos (evil-get-marker char)))
    (unless pos (user-error "E20: Mark not set"))
    (goto-char pos)))

(evil-define-motion (evil-goto-mark-line char)
  "Move to the first non-blank of the line of mark CHAR (')."
  (interactive "<C>") #:type line #:jump
  (evil-goto-mark char)
  (evil--first-non-blank))

;;;; Text objects

(define (evil--paragraph count outer)
  (save-excursion
    (beginning-of-line)
    (let ((blank (evil--blank-line?)) (n (or count 1)))
      (while (and (not (bobp))
                  (eq? (save-excursion (forward-line -1) (evil--blank-line?)) blank))
        (forward-line -1))
      (let ((beg (point)))
        (dotimes (_ (if outer (* 2 n) n))
          (let ((b2 (evil--blank-line?)))
            (while (and (not (eobp)) (eq? (evil--blank-line?) b2))
              (forward-line 1))))
        (list beg (point) 'line)))))

(evil-define-text-object (evil-inner-word count) "A word, or a run of blanks (iw)." (evil--word-object count #f #f))
(evil-define-text-object (evil-a-word count) "A word and the blanks after it, or before it at the end of a line (aw)." (evil--word-object count #f #t))
(evil-define-text-object (evil-inner-WORD count) "A WORD (iW)." (evil--word-object count #t #f))
(evil-define-text-object (evil-a-WORD count) "A WORD and the blanks after it (aW)." (evil--word-object count #t #t))
(evil-define-text-object (evil-inner-paragraph count) "A paragraph, or a run of blank lines (ip)." (evil--paragraph count #f))
(evil-define-text-object (evil-a-paragraph count) "A paragraph and the blank lines after it (ap)." (evil--paragraph count #t))
(evil-define-text-object (evil-inner-paren count) "The text inside ( and ) (i( or ib)." (evil--pair-object #\( #\) count #f))
(evil-define-text-object (evil-a-paren count) "The text with its ( and ) (a( or ab)." (evil--pair-object #\( #\) count #t))
(evil-define-text-object (evil-inner-bracket count) "The text inside [ and ] (i[)." (evil--pair-object #\[ #\] count #f))
(evil-define-text-object (evil-a-bracket count) "The text with its [ and ] (a[)." (evil--pair-object #\[ #\] count #t))
(evil-define-text-object (evil-inner-curly count) "The text inside { and } (i{ or iB)." (evil--pair-object #\{ #\} count #f))
(evil-define-text-object (evil-a-curly count) "The text with its { and } (a{ or aB)." (evil--pair-object #\{ #\} count #t))
(evil-define-text-object (evil-inner-angle count) "The text inside < and > (i<)." (evil--pair-object #\< #\> count #f))
(evil-define-text-object (evil-an-angle count) "The text with its < and > (a<)." (evil--pair-object #\< #\> count #t))
(evil-define-text-object (evil-inner-double-quote count) "The text inside double quotes on this line (i\")." (evil--quote-object #\" #f))
(evil-define-text-object (evil-a-double-quote count) "A double-quoted string and the blanks after it (a\")." (evil--quote-object #\" #t))
(evil-define-text-object (evil-inner-single-quote count) "The text inside single quotes on this line (i')." (evil--quote-object #\' #f))
(evil-define-text-object (evil-a-single-quote count) "A single-quoted string and the blanks after it (a')." (evil--quote-object #\' #t))
(evil-define-text-object (evil-inner-back-quote count) "The text inside backquotes on this line (i`)." (evil--quote-object #\` #f))
(evil-define-text-object (evil-a-back-quote count) "A backquoted string and the blanks after it (a`)." (evil--quote-object #\` #t))

;;;; Operators

(define (evil--delete-lines beg end)
  (let ((beg (if (and (= end (point-max)) (> beg (point-min)) (not (eqv? (char-before end) #\newline)))
                 (- beg 1)
                 beg)))
    (delete-region beg end)
    (goto-char (min beg (point-max)))
    (when (and (eobp) (bolp) (not (bobp))) (forward-line -1))
    (evil--first-non-blank)))

(evil-define-operator (evil-yank beg end type register)
  "Save the text from BEG to END in REGISTER (y)."
  #:no-repeat
  (interactive "<R><x>")
  (evil--yank beg end type register)
  (if (eq? type 'line)
      (when (< beg (line-beginning-position))
        (let ((col (current-column)))
          (goto-char beg)
          (move-to-column col)))
      (goto-char beg)))

(evil-define-operator (evil-delete beg end type register)
  "Delete the text from BEG to END, saving it in REGISTER (d)."
  (interactive "<R><x>")
  (evil--yank beg end type register #t)
  (case type
    ((block) (evil--delete-block beg end))
    ((line) (evil--delete-lines beg end))
    (else (delete-region beg end) (goto-char beg))))

(evil-define-operator (evil-change beg end type register)
  "Delete the text from BEG to END into REGISTER, then enter Insert state (c).
On whole lines the first line and its indentation stay."
  (interactive "<R><x>")
  (case type
    ((line)
     (evil--yank beg end type register #t)
     (let ((stop (if (and (> end beg) (eqv? (char-before end) #\newline)) (- end 1) end)))
       (goto-char beg)
       (skip-chars-forward " \t")
       (delete-region (point) (max (point) stop)))
     (when (and (lisp-buffer?) (bolp)) (lisp-indent-line))
     (evil-insert-state))
    ((block)
     (evil--yank beg end type register #t)
     (evil--change-block beg end))
    (else (evil-delete beg end type register)
          (evil-insert-state))))

(define (evil--shift beg end count right)
  "Shift the lines from BEG to END by COUNT steps of evil-shift-width."
  (let* ((width (* (or count 1) evil-shift-width))
         (l1 (line-number-at-pos beg))
         (l2 (line-number-at-pos (max beg (- end 1)))))
    (goto-char beg)
    (dotimes (_ (+ 1 (- l2 l1)))
      (beginning-of-line)
      (if right
          (unless (eolp) (insert (make-string width #\space)))
          (let ((s (point)))
            (skip-chars-forward " \t" (min (line-end-position) (+ s width)))
            (delete-region s (point))))
      (forward-line 1))
    (goto-char beg)
    (evil--first-non-blank)))

(evil-define-operator (evil-shift-right beg end type count)
  "Indent the lines from BEG to END by evil-shift-width columns (>)."
  (interactive "<R><c>")
  (evil--shift beg end count #t))

(evil-define-operator (evil-shift-left beg end type count)
  "Remove evil-shift-width columns of indentation from the lines (<)."
  (interactive "<R><c>")
  (evil--shift beg end count #f))

(evil-define-operator (evil-indent beg end type)
  "Reindent the lines from BEG to END (=)."
  (if (lisp-buffer?)
      (indent-region beg end)
      (message "No indentation rules for ~a" (major-mode)))
  (goto-char beg)
  (evil--first-non-blank))

(evil-define-operator (evil-upcase beg end type)
  "Make the text from BEG to END upper case (gU)."
  (evil--map-range beg end type upcase-region)
  (goto-char beg))

(evil-define-operator (evil-downcase beg end type)
  "Make the text from BEG to END lower case (gu)."
  (evil--map-range beg end type downcase-region)
  (goto-char beg))

(evil-define-operator (evil-invert-case beg end type)
  "Toggle the case of the text from BEG to END (g~)."
  (evil--map-range beg end type (lambda (b e) (evil--transform-region b e evil--invert-char-case)))
  (goto-char beg))

(evil-define-operator (evil-rot13 beg end type)
  "Rotate the letters from BEG to END by 13 places (g?)."
  (evil--map-range beg end type (lambda (b e) (evil--transform-region b e evil--rot13-char)))
  (goto-char beg))

(evil-define-operator (evil-replace-region beg end type char)
  "Replace every character from BEG to END with CHAR (r in Visual state)."
  (interactive "<R><C>")
  (evil--map-range beg end type
                   (lambda (b e) (evil--transform-region b e (lambda (c) (if (eqv? c #\newline) c char)))))
  (goto-char beg))

(evil-define-operator (evil-join-lines beg end type)
  "Join the lines from BEG to END with single spaces (J in Visual state)."
  (evil--join beg (max 2 (count-lines beg end)) #f))

(evil-define-operator (evil-delete-whole-lines beg end type register)
  "Delete the whole lines of the range (D and X in Visual state)."
  (interactive "<R><x>")
  (apply (lambda (b e) (evil-delete b e 'line register)) (evil--whole-lines beg end)))

(evil-define-operator (evil-yank-whole-lines beg end type register)
  "Yank the whole lines of the range (Y in Visual state)."
  #:no-repeat
  (interactive "<R><x>")
  (apply (lambda (b e) (evil-yank b e 'line register)) (evil--whole-lines beg end)))

(evil-define-operator (evil-change-whole-lines beg end type register)
  "Change the whole lines of the range (S, R and C in Visual state)."
  (interactive "<R><x>")
  (apply (lambda (b e) (evil-change b e 'line register)) (evil--whole-lines beg end)))

;;;; Commands that act on a fixed range

(evil-define-command (evil-delete-char count register)
  "Delete COUNT characters under and after point (x)."
  (interactive "<c><x>")
  (let ((end (min (+ (point) (or count 1)) (line-end-position))))
    (if (= end (point)) (ding) (evil-delete (point) end 'exclusive register))))

(evil-define-command (evil-delete-backward-char count register)
  "Delete COUNT characters before point (X)."
  (interactive "<c><x>")
  (let ((beg (max (- (point) (or count 1)) (line-beginning-position))))
    (if (= beg (point)) (ding) (evil-delete beg (point) 'exclusive register))))

(evil-define-command (evil-substitute count register)
  "Delete COUNT characters and enter Insert state (s)."
  (interactive "<c><x>")
  (evil-change (point) (min (+ (point) (or count 1)) (line-end-position)) 'exclusive register))

(evil-define-command (evil-change-whole-line count register)
  "Change COUNT whole lines, keeping the indentation (S and cc)."
  (interactive "<c><x>")
  (apply (lambda (b e) (evil-change b e 'line register)) (evil--lines count)))

(evil-define-command (evil-change-line count register)
  "Change to the end of the line, COUNT - 1 lines down (C)."
  (interactive "<c><x>")
  (evil-change (point) (line-end-position (or count 1)) 'exclusive register))

(evil-define-command (evil-delete-line count register)
  "Delete to the end of the line, COUNT - 1 lines down (D)."
  (interactive "<c><x>")
  (evil-delete (point) (line-end-position (or count 1)) 'exclusive register))

(evil-define-command (evil-yank-line count register)
  "Yank COUNT whole lines (Y)."
  #:no-repeat
  (interactive "<c><x>")
  (apply (lambda (b e) (evil-yank b e 'line register)) (evil--lines count)))

(evil-define-command (evil-paste-after count register)
  "Paste the text of REGISTER after point, COUNT times (p)."
  (interactive "<c><x>")
  (evil--paste (evil-get-register register) (evil-register-type register) count #t))

(evil-define-command (evil-paste-before count register)
  "Paste the text of REGISTER before point, COUNT times (P)."
  (interactive "<c><x>")
  (evil--paste (evil-get-register register) (evil-register-type register) count #f))

(evil-define-command (evil-visual-paste count register)
  "Replace the selection with the text of REGISTER (p in Visual state).
The replaced text goes to the unnamed register."
  (interactive "<c><x>")
  (let* ((text (evil-get-register register))
         (rtype (evil-register-type register))
         (range (evil-visual-range))
         (beg (car range)) (end (cadr range)) (type (caddr range)))
    (evil-delete beg end type #f)
    (cond ((eq? type 'line)
           (evil--paste (if (eq? rtype 'line) text (string-append text "\n")) 'line count (>= beg (point-max))))
          ((eq? rtype 'line)
           (evil--paste (string-append "\n" text) 'char count #f)
           (forward-line 1)
           (evil--first-non-blank))
          (else (evil--paste text rtype count #f)))))

(evil-define-command (evil-replace-char count char)
  "Replace COUNT characters with CHAR (r).  r RET splits the line."
  (interactive "<c><C>")
  (let* ((n (or count 1)) (end (+ (point) n)))
    (when (> end (line-end-position)) (user-error "Not enough characters to replace"))
    (delete-region (point) end)
    (if (eqv? char #\newline)
        (evil-newline-and-indent)
        (begin (insert (make-string n char)) (backward-char 1)))))

(evil-define-command (evil-invert-char count)
  "Toggle the case of COUNT characters and move past them (~)."
  (interactive "<c>")
  (let ((end (min (+ (point) (or count 1)) (line-end-position))))
    (evil--transform-region (point) end evil--invert-char-case)
    (goto-char end)))

(evil-define-command (evil-join count)
  "Join COUNT lines, at least two, with single spaces (J)."
  (interactive "<c>")
  (evil--join (point) (max 2 (or count 2)) #f))

(evil-define-command (evil-join-whitespace count)
  "Join COUNT lines without changing blanks (gJ)."
  (interactive "<c>")
  (evil--join (point) (max 2 (or count 2)) #t))

;;;; Numbers

(define (evil--add-to-number n)
  "Add N to the number at or after point on this line; leave point on its last digit."
  (let ((eol (line-end-position)) (start (point)))
    (skip-chars-backward "0-9")
    (when (eqv? (char-before) #\-) (backward-char 1))
    (if (re-search-forward "-?[0-9]+" eol #t)
        (let* ((b (match-beginning 0))
               (new (number->string (+ (string->number (match-string 0)) n))))
          (replace-match new)
          (goto-char (+ b (string-length new) -1)))
        (begin (goto-char start) (user-error "No number on this line")))))

(evil-define-command (evil-increment count)
  "Add COUNT to the number at or after point (C-a and g =)."
  (interactive "<c>")
  (evil--add-to-number (or count 1)))

(evil-define-command (evil-decrement count)
  "Subtract COUNT from the number at or after point (g -)."
  (interactive "<c>")
  (evil--add-to-number (- (or count 1))))

;;;; Entering Insert state

(evil-define-command (evil-newline-and-indent)
  "Insert a newline, then indent like the line above (RET in Insert state)."
  (interactive "*")
  (let ((indent (evil--line-indentation)))
    (insert "\n")
    (if (lisp-buffer?) (lisp-indent-line) (insert indent))))

(evil-define-command (evil-insert count)
  "Insert before point; COUNT repeats the text (i)."
  (interactive "<c>")
  (evil-insert-state count))

(evil-define-command (evil-append count)
  "Insert after point (a)."
  (interactive "<c>")
  (unless (eolp) (forward-char 1))
  (evil-insert-state count))

(evil-define-command (evil-insert-line count)
  "Insert before the first non-blank character of the line (I)."
  (interactive "<c>")
  (evil--first-non-blank)
  (evil-insert-state count))

(evil-define-command (evil-append-line count)
  "Insert at the end of the line (A)."
  (interactive "<c>")
  (end-of-line)
  (evil-insert-state count))

(evil-define-command (evil-open-below count)
  "Open a new line below this one and insert there (o)."
  (interactive "<c>")
  (evil--end-of-line-or-fold)
  (evil-newline-and-indent)
  (evil-insert-state count #t))

(evil-define-command (evil-open-above count)
  "Open a new line above this one and insert there (O)."
  (interactive "<c>")
  (let ((indent (evil--line-indentation)))
    (beginning-of-line)
    (insert "\n")
    (backward-char 1)
    (if (lisp-buffer?) (lisp-indent-line) (insert indent)))
  (evil-insert-state count #t))

(evil-define-command (evil-insert-resume count)
  "Insert where Insert state was last left (gi)."
  (interactive "<c>")
  (let ((pos (evil-get-marker #\^)))
    (when pos (goto-char pos)))
  (evil-insert-state count))

(evil-define-command (evil-enter-replace-state count)
  "Enter Replace state: typing overwrites, DEL restores (R)."
  (interactive "<c>")
  (evil-replace-state count))

(evil-define-command (evil-delete-backward-word)
  "Delete the word before point (C-w in Insert state)."
  (interactive "*")
  (if (bolp)
      (unless (bobp) (delete-char -1))
      (let ((end (point)) (bol (line-beginning-position)))
        (evil--backward-word-begin-1 #f)
        (delete-region (max bol (point)) end))))

(evil-define-command (evil-delete-back-to-indentation)
  "Delete from point back to the indentation (C-u in Insert state)."
  (interactive "*")
  (let ((end (point)))
    (evil--first-non-blank)
    (when (>= (point) end) (beginning-of-line))
    (delete-region (point) end)))

(evil-define-command (evil-shift-right-line count)
  "Indent this line while typing (C-t in Insert state)."
  (interactive "<c>")
  (let ((from-end (- (line-end-position) (point))))
    (evil--shift (line-beginning-position) (line-end-position) count #t)
    (goto-char (- (line-end-position) from-end))))

(evil-define-command (evil-shift-left-line count)
  "Unindent this line while typing (C-d in Insert state)."
  (interactive "<c>")
  (let ((from-end (- (line-end-position) (point))))
    (evil--shift (line-beginning-position) (line-end-position) count #f)
    (goto-char (max (line-beginning-position) (- (line-end-position) from-end)))))

;;;; Surround: ys ds cs, and S in Visual state

(define evil-surround-pairs
  '((#\( "(" ")") (#\) "(" ")") (#\b "(" ")")
    (#\[ "[" "]") (#\] "[" "]")
    (#\{ "{" "}") (#\} "{" "}") (#\B "{" "}")
    (#\< "<" ">") (#\> "<" ">")
    (#\" "\"" "\"") (#\' "'" "'") (#\` "`" "`"))
  "Characters that name a pair, with the strings that open and close it.
An opening bracket adds spaces inside; a closing one does not.")

(define (evil--surround-strings char)
  "The opening and closing strings for CHAR, as a pair.  Unknown characters surround with themselves."
  (let ((p (assv char evil-surround-pairs)))
    (cond ((not p) (let ((s (char->string char))) (cons s s)))
          ((memv char '(#\( #\[ #\{ #\<)) (cons (string-append (cadr p) " ") (string-append " " (caddr p))))
          (else (cons (cadr p) (caddr p))))))

(evil-define-operator (evil-surround-region beg end type char)
  "Put the pair named by CHAR around the text from BEG to END (ys and S)."
  (interactive "<R><C>")
  (let ((pair (evil--surround-strings char)))
    (save-excursion
      (goto-char end)
      (when (and (eq? type 'line) (eqv? (char-before end) #\newline)) (backward-char 1))
      (insert (cdr pair))
      (goto-char beg)
      (insert (car pair)))
    (goto-char beg)))

(define (evil--surround-bounds char)
  "The pair around point that CHAR names, as (OPEN-START OPEN-END CLOSE-START CLOSE-END), or #f."
  (let* ((p (assv char evil-surround-pairs))
         (open (if p (cadr p) (char->string char)))
         (close (if p (caddr p) (char->string char)))
         (r (if (and p (not (string=? open close)))
                (evil--pair-object (string-ref open 0) (string-ref close 0) 1 #t)
                (evil--quote-object (string-ref open 0) #f))))
    (and r
         (if (and p (not (string=? open close)))
             (list (car r) (+ (car r) 1) (- (cadr r) 1) (cadr r))
             ;; the quote object is the inside; the quotes sit just outside it
             (list (- (car r) 1) (car r) (cadr r) (+ (cadr r) 1))))))

(evil-define-command (evil-surround-delete char)
  "Delete the pair named by CHAR around point, and any blanks just inside it (ds)."
  (interactive "<C>")
  (let ((b (evil--surround-bounds char)))
    (unless b (user-error "No surrounding ~a" char))
    (let ((o1 (car b)) (o2 (cadr b)) (c1 (caddr b)) (c2 (cadddr b)))
      (save-excursion
        (goto-char c1)
        (skip-chars-backward " \t" o2)
        (delete-region (point) c2)
        (goto-char o2)
        (skip-chars-forward " \t" c1)
        (delete-region o1 (point)))
      (goto-char o1))))

(evil-define-command (evil-surround-change old new)
  "Replace the pair OLD around point with the pair NEW (cs)."
  (interactive "<C><C>")
  (let ((b (evil--surround-bounds old)))
    (unless b (user-error "No surrounding ~a" old))
    (let ((inner (buffer-substring (cadr b) (caddr b)))
          (pair (evil--surround-strings new))
          (start (car b)))
      (delete-region (car b) (cadddr b))
      (goto-char start)
      (insert (car pair) (string-trim inner) (cdr pair))
      (goto-char start))))

(define-command (evil-surround-edit)
  "After an operator, s means surround: ys{motion}{char} adds a pair, ds{char} removes one, cs{old}{new} replaces one."
  (user-error "evil-surround-edit is only meaningful after an operator"))
(set-procedure-property! evil-surround-edit 'evil-surround-edit #t)

;;;; Snipe: s and S jump to a pair of characters on screen; ; and , repeat

(define evil-snipe-last #f "The last snipe as (STRING FORWARD TILL).")

(define (evil--snipe count string forward repeat . till)
  (let ((pos (evil--find-string (or count 1) string forward repeat (and (pair? till) (car till)))))
    (unless pos (signal 'search-failed string))
    (set! evil-this-type (if forward 'inclusive 'exclusive))
    (goto-char pos)))

(define (evil--snipe-till)
  (and (pair? (cddr evil-snipe-last)) (caddr evil-snipe-last)))

(evil-define-motion (evil-snipe-s count c1 c2)
  "Jump forward to the next C1 C2 on screen (s).  ; and , repeat it."
  (interactive "<c><C><C>") #:type inclusive
  (let ((str (string c1 c2)))
    (set! evil-snipe-last (list str #t))
    (set! evil-last-find #f)
    (evil--snipe count str #t #f)))

(evil-define-motion (evil-snipe-S count c1 c2)
  "Jump backward to the previous C1 C2 on screen (S)."
  (interactive "<c><C><C>")
  (let ((str (string c1 c2)))
    (set! evil-snipe-last (list str #f))
    (set! evil-last-find #f)
    (evil--snipe count str #f #f)))

;; ; and , repeat whichever of f/t or s/S came last.
(evil-define-motion (evil-repeat-find-char count)
  "Repeat the last f, F, t, T, s or S (;)."
  #:type inclusive
  (cond (evil-last-find
         (apply (lambda (char forward till) (evil--find count char forward till #t)) evil-last-find))
        (evil-snipe-last
         (evil--snipe count (car evil-snipe-last) (cadr evil-snipe-last) #t (evil--snipe-till)))
        (else (user-error "No previous f, F, t, T, s or S"))))

(evil-define-motion (evil-repeat-find-char-reverse count)
  "Repeat the last f, F, t, T, s or S the other way (,)."
  (cond (evil-last-find
         (apply (lambda (char forward till) (evil--find count char (not forward) till #t)) evil-last-find))
        (evil-snipe-last
         (evil--snipe count (car evil-snipe-last) (not (cadr evil-snipe-last)) #t (evil--snipe-till)))
        (else (user-error "No previous f, F, t, T, s or S"))))

;; evil-snipe-override-mode: f, F, t and T become one-character snipes over the
;; visible part of the buffer, boxed and repeated with ; and , like s.
(define (evil--snipe-1 count char forward till)
  (let ((str (string char)))
    (set! evil-snipe-last (list str forward till))
    (set! evil-last-find #f)
    (evil--snipe count str forward #f till)))

(evil-define-motion (evil-snipe-f count char)
  "Jump to the COUNTth CHAR ahead on screen (f under evil-snipe-override-mode)."
  (interactive "<c><C>") #:type inclusive
  (evil--snipe-1 count char #t #f))

(evil-define-motion (evil-snipe-F count char)
  "Jump to the COUNTth CHAR behind on screen (F under evil-snipe-override-mode)."
  (interactive "<c><C>")
  (evil--snipe-1 count char #f #f))

(evil-define-motion (evil-snipe-t count char)
  "Jump to just before the COUNTth CHAR ahead on screen (t under evil-snipe-override-mode)."
  (interactive "<c><C>") #:type inclusive
  (evil--snipe-1 count char #t #t))

(evil-define-motion (evil-snipe-T count char)
  "Jump to just after the COUNTth CHAR behind on screen (T under evil-snipe-override-mode)."
  (interactive "<c><C>")
  (evil--snipe-1 count char #f #t))

(define evil--snipe-override #f
  "Non-#f while evil-snipe-override-mode is on.")

(define-command (evil-snipe-override-mode #!optional arg)
  "Toggle f, F, t and T between one-character snipes over the visible part of the buffer and
line-local finds.  With ARG, on when it is positive."
  (interactive "P")
  (set! evil--snipe-override (if arg (> (prefix-numeric-value arg) 0) (not evil--snipe-override)))
  (for-each (lambda (k plain snipe) (define-key evil-motion-state-map k (if evil--snipe-override snipe plain)))
            '("f" "F" "t" "T")
            '(evil-find-char evil-find-char-backward evil-find-char-to evil-find-char-to-backward)
            '(evil-snipe-f evil-snipe-F evil-snipe-t evil-snipe-T))
  evil--snipe-override)


;;;; Comments: gc is an operator, gcc comments the line

(define (comment-prefix)
  "The comment marker for the current buffer."
  (case (major-mode)
    ((scheme-mode scheme-interaction-mode) ";; ")
    ((org-mode) "# ")
    (else "# ")))

(evil-define-operator (evil-comment-operator beg end type)
  "Comment the lines from BEG to END out, or back in when they all are (gc)."
  (let* ((prefix (comment-prefix))
         (marker (string-trim prefix))
         (lines (count-lines beg end))
         (all-commented
          (save-excursion
            (goto-char beg)
            (let loop ((i 0))
              (cond ((= i lines) #t)
                    ((begin (back-to-indentation) (or (looking-at (string-append (regexp-quote marker))) (eolp)))
                     (forward-line 1) (loop (+ i 1)))
                    (else #f))))))
    (save-excursion
      (goto-char beg)
      (dotimes (_ lines)
        (back-to-indentation)
        (if all-commented
            (when (looking-at (string-append (regexp-quote marker) " ?"))
              (replace-match ""))
            (unless (eolp) (insert prefix)))
        (forward-line 1)))
    (goto-char beg)
    (evil--first-non-blank)))


;;;; Expand region: SPC v grows the selection, SPC V shrinks it again

(define expreg--stack '() "Selections before each expansion, newest first.")

(define (expreg--candidates)
  "Candidate regions around point, smallest first, as (BEG . END) pairs."
  (let ((cands '()))
    (define (add! r) (when (and r (< (car r) (cadr r))) (push! (cons (car r) (cadr r)) cands)))
    (add! (evil--word-object 1 #f #f))
    (if (lisp-buffer?) (add! (symbol-bounds-at-point)) (add! (evil--word-object 1 #t #f)))
    (when (lisp-buffer?)
      (let loop ((n 1))
        (when (< n 20)
          (let ((inner (evil--pair-object #\( #\) n #f)) (outer (evil--pair-object #\( #\) n #t)))
            (when inner (add! inner) (add! outer) (loop (+ n 1)))))))
    (add! (list (line-beginning-position) (min (point-max) (+ 1 (line-end-position)))))
    (add! (evil--paragraph 1 #f))
    (add! (list (point-min) (point-max)))
    (sort (delete-duplicates cands) (lambda (a b) (< (- (cdr a) (car a)) (- (cdr b) (car b)))))))

(evil-define-command (expreg-expand)
  "Select the smallest region larger than the current selection: word, sexp, list, line, paragraph, buffer (SPC v)."
  #:no-repeat
  (let* ((sel (and (evil-visual-state?) (cons (min (point) (mark)) (+ 1 (max (point) (mark))))))
         (next (find (lambda (c) (or (not sel) (and (<= (car c) (car sel)) (>= (cdr c) (cdr sel)) (not (equal? c sel)))))
                     (expreg--candidates))))
    (unless next (user-error "Nothing larger to select"))
    (unless (evil-visual-state?) (set! expreg--stack '()))
    (when sel (push! sel expreg--stack))
    (evil-select-region (car next) (cdr next))))

(evil-define-command (expreg-contract)
  "Shrink the selection back to what it was before the last expansion (SPC V)."
  #:no-repeat
  (if (null? expreg--stack)
      (evil-exit-visual-state)
      (let ((prev (pop! expreg--stack)))
        (evil-select-region (car prev) (cdr prev)))))

;;;; Buffers, files and help

(evil-define-command (evil-write file force)
  "Save the buffer, or write a copy to FILE (:w)."
  #:no-repeat
  (interactive "<f><!>")
  (cond (file (if (buffer-file-name) (write-region #f #f file) (write-file file)))
        ((buffer-file-name) (save-buffer))
        (else (user-error "E32: No file name"))))
(set-procedure-property! evil-write 'evil-ex-complete 'file)

(evil-define-command (evil-quit force)
  "Close this window (:q), or the buffer when it is the only window.
It refuses to drop unsaved changes unless FORCE (:q!)."
  #:no-repeat
  (interactive "<!>")
  (cond ((pair? (cdr (window-list))) (delete-window))
        ((and (buffer-file-name) (buffer-modified?) (not force))
         (user-error "E37: No write since last change (add ! to override)"))
        ((equal? (buffer-name) "*scratch*")
         (message "Edwin lives in this page; close the tab to leave"))
        (else (kill-buffer))))

(evil-define-command (evil-window-split-file file)
  "Split the window below; show FILE in the new one (:sp)."
  #:no-repeat
  (interactive "<f>")
  (select-window (split-window-below))
  (other-window 1)
  (when file (find-file file)))
(set-procedure-property! evil-window-split-file 'evil-ex-complete 'file)

(evil-define-command (evil-window-vsplit-file file)
  "Split the window to the right; show FILE in the new one (:vs)."
  #:no-repeat
  (interactive "<f>")
  (select-window (split-window-right))
  (other-window 1)
  (when file (find-file file)))
(set-procedure-property! evil-window-vsplit-file 'evil-ex-complete 'file)

(evil-define-command (evil-window-close-others)
  "Make this the only window (:only, C-w o)."
  #:no-repeat
  (delete-other-windows))

(evil-define-command (evil-save-and-quit)
  "Save, then close this buffer (:wq)."
  #:no-repeat
  (evil-write #f #f)
  (evil-quit #f))

(evil-define-command (evil-save-modified-and-close)
  "Save if there are changes, then close this buffer (:x and ZZ)."
  #:no-repeat
  (when (and (buffer-file-name) (buffer-modified?)) (save-buffer))
  (evil-quit #f))

(evil-define-command (evil-quit-without-saving)
  "Close this buffer, dropping changes (ZQ)."
  #:no-repeat
  (evil-quit #t))

(evil-define-command (evil-write-all)
  "Save every buffer that visits a file and has changes (:wa)."
  #:no-repeat
  (let ((n 0))
    (for-each (lambda (b)
                (with-current-buffer b
                  (when (and (buffer-file-name) (buffer-modified?))
                    (save-buffer)
                    (inc! n))))
              (buffer-list))
    (message "Saved ~a buffer~a" n (if (= n 1) "" "s"))))

(evil-define-command (evil-quit-all)
  "Explain that Edwin cannot close its page (:qa)."
  #:no-repeat
  (message "Edwin lives in this page; close the tab to leave"))

(evil-define-command (evil-edit file force)
  "Visit FILE (:e).  With no FILE, reload this buffer's file; :e! drops changes."
  #:no-repeat
  (interactive "<f><!>")
  (cond (file (find-file file))
        ((not (buffer-file-name)) (user-error "E32: No file name"))
        ((and (buffer-modified?) (not force))
         (user-error "E37: No write since last change (add ! to override)"))
        (else (revert-buffer))))
(set-procedure-property! evil-edit 'evil-ex-complete 'file)

(evil-define-command (evil-save-as file)
  "Write the buffer to FILE and visit it (:sav)."
  #:no-repeat
  (interactive "<f>")
  (unless file (user-error "E471: Argument required"))
  (write-file file))
(set-procedure-property! evil-save-as 'evil-ex-complete 'file)

(evil-define-command (evil-read file)
  "Insert the saved file FILE below this line (:r)."
  (interactive "<f>")
  (unless file (user-error "E32: No file name"))
  (end-of-line)
  (insert "\n")
  (insert-file-contents file)
  (evil--first-non-blank))
(set-procedure-property! evil-read 'evil-ex-complete 'file)

(evil-define-command (evil-source file)
  "Evaluate FILE, or this buffer (:so)."
  #:no-repeat
  (interactive "<f>")
  (if file (load file) (eval-buffer)))
(set-procedure-property! evil-source 'evil-ex-complete 'file)

(evil-define-command (evil-new-buffer)
  "Show a new empty buffer (:enew)."
  #:no-repeat
  (switch-to-buffer (generate-new-buffer-name "*new*")))

(evil-define-command (evil-buffer name)
  "Show the buffer whose name contains NAME (:b)."
  #:no-repeat
  (interactive "<a>")
  (if (not name)
      (message "\"~a\"" (buffer-name))
      (let ((exact (get-buffer name)))
        (if exact
            (switch-to-buffer exact)
            (let ((matches (filter (lambda (b) (string-contains (buffer-name b) name)) (buffer-list))))
              (cond ((null? matches) (user-error "E94: No matching buffer for ~a" name))
                    ((pair? (cdr matches)) (user-error "E93: More than one match for ~a" name))
                    (else (switch-to-buffer (car matches)))))))))
(set-procedure-property! evil-buffer 'evil-ex-complete 'buffer)

(evil-define-command (evil-delete-buffer name force)
  "Kill the buffer NAME, or this one (:bd).  :bd! drops unsaved changes."
  #:no-repeat
  (interactive "<a><!>")
  (let ((b (if name (get-buffer name) (current-buffer))))
    (unless b (user-error "E94: No matching buffer for ~a" name))
    (when (and (not force) (buffer-modified? b) (buffer-file-name b))
      (user-error "E89: No write since last change for buffer \"~a\" (add ! to override)" (buffer-name b)))
    (kill-buffer b)))
(set-procedure-property! evil-delete-buffer 'evil-ex-complete 'buffer)

(evil-define-command (evil-file-info)
  "Show the file name, line count and position (:f)."
  #:no-repeat
  (let ((lines (line-number-at-pos (evil--last-line-position))))
    (message "\"~a\"~a ~a line~a --~a%--"
             (or (buffer-file-name) (buffer-name))
             (if (buffer-modified?) " [Modified]" "")
             lines (if (= lines 1) "" "s")
             (quotient (* 100 (line-number-at-pos)) (max 1 lines)))))

(evil-define-command (evil-ex-put register)
  "Paste the text of REGISTER on a new line below this one (:pu)."
  (interactive "<x>")
  (evil--paste (evil-get-register register) 'line 1 #t))

(evil-define-command (evil-lookup)
  "Describe the procedure or variable named at point (K)."
  #:no-repeat
  (let ((name (thing-at-point 'symbol)))
    (cond ((not name) (user-error "No name at point"))
          ((or (bound? (string->symbol name)) (macro? (string->symbol name))) (describe-function (string->symbol name)))
          (else (user-error "Nothing named ~a" name)))))

(evil-define-command (evil-buffer-menu-visit)
  "In the buffer list, show the buffer on this line; elsewhere move down a line."
  #:no-repeat
  (let ((line (buffer-substring (line-beginning-position) (line-end-position))))
    (if (and (equal? (buffer-name) "*Buffer List*")
             (string-match "^.\\{4\\}\\(.*?\\) +[0-9]+  " line))
        (switch-to-buffer (match-string 1 line))
        (evil-next-line-first-non-blank 1))))

(define evil-quick-reference
  "Edwin key reference                                    q to go back

STATES   Normal: keys are commands.  i a I A o O: Insert state; ESC back.
         v V C-v: Visual (characters, lines, block).  R: Replace.
         C-z: Emacs state, plain Emacs keys; C-z again returns.

MOVING   h j k l   w b e ge (W B E gE for WORDs)   0 ^ $ g_ |
         gg G :N   f F t T ; ,   %   { }   H M L   + - RET _
         C-d C-u C-f C-b  C-e C-y  zz zt zb    `a 'a ``  C-o TAB
         A number first repeats a motion: 3w, 5j, 2fx.

SEARCH   /re ?re n N * #     Vim regexps: \\( \\) \\| \\< \\> \\{n,m} \\zs \\ze \\v
         :noh hides the highlight.  Smart case unless you :set noic.

OPERATORS take a motion or text object, or act on a selection:
         d delete  c change  y yank  > < shift  = indent
         gu gU g~ case  g? rot13   (doubled: dd cc yy >> gUU)
TEXT OBJECTS  iw aw iW aW ip ap  i( a( ib  i[ a[  i{ a{ iB  i< a<
         i\" a\" i' a' i` a`         e.g. ciw, da(, yap, >ip, gUiw

EDITING  x X s S C D Y   p P   r R   J gJ   ~   u C-r   .   C-a g- numbers
         \"a before a command uses register a; \"A appends to it.
         qa ... q records a macro into a; @a plays it; @@ again.
         ma sets mark a.  gv reselects.  gi inserts where you left off.

VISUAL   o swaps ends   I A insert on every line of a block
         p replaces     r replaces each character   u U ~ case   J joins

INSERT   C-w delete word   C-u delete to indentation   C-r a paste
         C-t C-d shift line   C-o one Normal command

EX       :w [file]  :q[!]  :wq  :x  :e file  :e!  :sav file  :r file
         :b name  :bn  :bp  :bd  :ls  :enew  :wa
         :s/re/new/g  :%s//new/g  :&  :g/re/d  :v/re/d  :g/re/normal A;
         :d :y :> :< :j :m 0 :t $ :pu :sort :normal :noh
         :set nu rnu wrap ic scs hls ws sw=4  :reg  :marks  :so
         :(+ 1 2) evaluates Scheme.  :h name describes a procedure.

LEADER   SPC f f find file   SPC b b switch buffer   SPC SPC M-x
         SPC h k describe key   SPC e b evaluate buffer  (see init.scm)

FILES    Files are kept in this browser's storage.  emacs.scm, evil.scm
         and init.scm are the configuration; :w saves your copy and it
         loads next time.  M-x reset-config restores the shipped ones.
"
  "The text :h shows.")

(evil-define-command (evil-help topic)
  "Show the key reference, or describe the procedure TOPIC (:h)."
  #:no-repeat
  (interactive "<a>")
  (cond ((not topic) (evil--show-help-text evil-quick-reference))
        ((bound? (string->symbol topic)) (describe-function (string->symbol topic)))
        ((bound? (string->symbol (string-append "evil-" topic))) (describe-function (string->symbol (string-append "evil-" topic))))
        (else (user-error "E149: Sorry, no help for ~a" topic))))
(set-procedure-property! evil-help 'evil-ex-complete 'function)

;;;; Ex commands

(for-each
 (lambda (c) (evil-ex-define-cmd (car c) (cdr c)))
 '(("w[rite]" . evil-write) ("q[uit]" . evil-quit) ("wq" . evil-save-and-quit)
   ("x[it]" . evil-save-modified-and-close) ("exi[t]" . evil-save-modified-and-close)
   ("wa[ll]" . evil-write-all) ("qa[ll]" . evil-quit-all) ("wqa[ll]" . evil-quit-all) ("xa[ll]" . evil-quit-all)
   ("e[dit]" . evil-edit) ("ene[w]" . evil-new-buffer) ("sav[eas]" . evil-save-as) ("r[ead]" . evil-read)
   ("so[urce]" . evil-source) ("f[ile]" . evil-file-info)
   ("b[uffer]" . evil-buffer) ("bn[ext]" . evil-next-buffer) ("bp[revious]" . evil-prev-buffer) ("bN[ext]" . evil-prev-buffer)
   ("bd[elete]" . evil-delete-buffer) ("ls" . list-buffers) ("buffers" . list-buffers) ("files" . list-buffers)
   ("s[ubstitute]" . evil-ex-substitute) ("&" . evil-ex-repeat-substitute) ("&&" . evil-ex-repeat-substitute)
   ("g[lobal]" . evil-ex-global) ("v[global]" . evil-ex-vglobal) ("norm[al]" . evil-ex-normal)
   ("d[elete]" . evil-delete) ("y[ank]" . evil-yank) ("pu[t]" . evil-ex-put) ("j[oin]" . evil-ex-join)
   (">" . evil-shift-right) ("<" . evil-shift-left) ("m[ove]" . evil-ex-move) ("t" . evil-ex-copy) ("co[py]" . evil-ex-copy)
   ("p[rint]" . evil-ex-print) ("sor[t]" . evil-ex-sort) ("noh[lsearch]" . evil-ex-nohighlight) ("se[t]" . evil-ex-set)
   ("reg[isters]" . evil-ex-registers) ("di[splay]" . evil-ex-registers) ("marks" . evil-ex-marks)
   ("u[ndo]" . evil-undo) ("red[o]" . evil-redo) ("h[elp]" . evil-help)
   ("sp[lit]" . evil-window-split-file) ("vs[plit]" . evil-window-vsplit-file) ("new" . evil-window-new)
   ("on[ly]" . evil-window-close-others) ("clo[se]" . delete-window) ("q[uit]" . evil-quit)))

;;;; Key bindings

(evil--bind evil-motion-state-map
  "h" 'evil-backward-char       "<left>" 'evil-backward-char   "DEL" 'evil-backward-char
  "l" 'evil-forward-char        "<right>" 'evil-forward-char   "SPC" 'evil-forward-char
  "j" 'evil-next-line           "<down>" 'evil-next-line       "g j" 'evil-next-line
  "k" 'evil-previous-line       "<up>" 'evil-previous-line     "g k" 'evil-previous-line
  "w" 'evil-forward-word-begin  "W" 'evil-forward-WORD-begin
  "b" 'evil-backward-word-begin "B" 'evil-backward-WORD-begin
  "e" 'evil-forward-word-end    "E" 'evil-forward-WORD-end
  "g e" 'evil-backward-word-end "g E" 'evil-backward-WORD-end
  "0" 'evil-beginning-of-line   "<home>" 'evil-beginning-of-line
  "^" 'evil-first-non-blank     "$" 'evil-end-of-line          "<end>" 'evil-end-of-line
  "g _" 'evil-last-non-blank    "|" 'evil-goto-column
  "g g" 'evil-goto-first-line   "G" 'evil-goto-line
  "f" 'evil-find-char           "F" 'evil-find-char-backward
  "t" 'evil-find-char-to        "T" 'evil-find-char-to-backward
  ";" 'evil-repeat-find-char    "," 'evil-repeat-find-char-reverse
  "%" 'evil-jump-item
  "}" 'evil-forward-paragraph   "{" 'evil-backward-paragraph
  "H" 'evil-window-top          "M" 'evil-window-middle        "L" 'evil-window-bottom
  "+" 'evil-next-line-first-non-blank  "RET" 'evil-next-line-first-non-blank
  "-" 'evil-previous-line-first-non-blank  "_" 'evil-next-line-1-first-non-blank
  "`" 'evil-goto-mark           "'" 'evil-goto-mark-line
  "/" 'evil-search-forward      "?" 'evil-search-backward
  "n" 'evil-search-next         "N" 'evil-search-previous
  "*" 'evil-search-word-forward "#" 'evil-search-word-backward
  ":" 'evil-ex
  "C-o" 'evil-jump-backward     "TAB" 'evil-jump-forward
  "C-d" 'evil-scroll-down       "C-u" 'evil-scroll-up
  "C-f" 'evil-scroll-page-down  "C-b" 'evil-scroll-page-up
  "<next>" 'evil-scroll-page-down  "<prior>" 'evil-scroll-page-up
  "C-e" 'evil-scroll-line-down  "C-y" 'evil-scroll-line-up
  "z z" 'evil-scroll-line-to-center  "z t" 'evil-scroll-line-to-top
  "z b" 'evil-scroll-line-to-bottom
  "v" 'evil-visual-char         "V" 'evil-visual-line          "C-v" 'evil-visual-block
  "K" 'evil-lookup
  "] b" 'evil-next-buffer       "[ b" 'evil-prev-buffer
  "C-w s" 'split-window-below   "C-w v" 'split-window-right
  "C-w c" 'delete-window        "C-w q" 'evil-quit
  "C-w o" 'delete-other-windows "C-w n" 'evil-window-new
  "C-w w" 'other-window         "C-w W" 'evil-window-prev   "C-w C-w" 'other-window
  "C-w h" 'windmove-left        "C-w j" 'windmove-down
  "C-w k" 'windmove-up          "C-w l" 'windmove-right
  "C-w <left>" 'windmove-left   "C-w <down>" 'windmove-down
  "C-w <up>" 'windmove-up       "C-w <right>" 'windmove-right
  "C-w r" 'evil-window-rotate-downwards
  "C-w u" 'winner-undo          "C-w C-r" 'winner-redo
  "C-z" 'evil-emacs-state)

(define-key evil-operator-state-map "i" evil-inner-text-objects-map)
(define-key evil-operator-state-map "z" 'evil-snipe-s)
(define-key evil-operator-state-map "Z" 'evil-snipe-S)
(define-key evil-operator-state-map "a" evil-outer-text-objects-map)

(evil--bind evil-inner-text-objects-map
  "w" 'evil-inner-word  "W" 'evil-inner-WORD  "p" 'evil-inner-paragraph
  "(" 'evil-inner-paren ")" 'evil-inner-paren "b" 'evil-inner-paren
  "[" 'evil-inner-bracket "]" 'evil-inner-bracket
  "{" 'evil-inner-curly "}" 'evil-inner-curly "B" 'evil-inner-curly
  "<" 'evil-inner-angle ">" 'evil-inner-angle
  "\"" 'evil-inner-double-quote "'" 'evil-inner-single-quote "`" 'evil-inner-back-quote)

(evil--bind evil-outer-text-objects-map
  "w" 'evil-a-word  "W" 'evil-a-WORD  "p" 'evil-a-paragraph
  "(" 'evil-a-paren ")" 'evil-a-paren "b" 'evil-a-paren
  "[" 'evil-a-bracket "]" 'evil-a-bracket
  "{" 'evil-a-curly "}" 'evil-a-curly "B" 'evil-a-curly
  "<" 'evil-an-angle ">" 'evil-an-angle
  "\"" 'evil-a-double-quote "'" 'evil-a-single-quote "`" 'evil-a-back-quote)

(evil--bind evil-normal-state-map
  "i" 'evil-insert          "a" 'evil-append
  "I" 'evil-insert-line     "A" 'evil-append-line
  "o" 'evil-open-below      "O" 'evil-open-above
  "g i" 'evil-insert-resume "R" 'evil-enter-replace-state
  "d" 'evil-delete          "c" 'evil-change          "y" 'evil-yank
  "x" 'evil-delete-char     "<deletechar>" 'evil-delete-char
  "X" 'evil-delete-backward-char
  "s" 'evil-substitute      "S" 'evil-change-whole-line
  "C" 'evil-change-line     "D" 'evil-delete-line     "Y" 'evil-yank-line
  "p" 'evil-paste-after     "P" 'evil-paste-before
  "r" 'evil-replace-char    "~" 'evil-invert-char
  "J" 'evil-join            "g J" 'evil-join-whitespace
  "u" 'evil-undo            "C-r" 'evil-redo
  "g ~" 'evil-invert-case   "g u" 'evil-downcase      "g U" 'evil-upcase
  "g ?" 'evil-rot13
  ">" 'evil-shift-right     "<" 'evil-shift-left      "=" 'evil-indent
  "." 'evil-repeat
  "q" 'evil-record-macro    "@" 'evil-execute-macro
  "m" 'evil-set-mark
  "&" 'evil-ex-repeat-substitute
  "g v" 'evil-visual-restore
  "g a" 'what-cursor-position
  "C-a" 'evil-increment       "g =" 'evil-increment       "g -" 'evil-decrement
  "Z Z" 'evil-save-modified-and-close  "Z Q" 'evil-quit-without-saving
  "ESC" 'evil-force-normal-state)

(evil--bind evil-visual-state-map
  "ESC" 'evil-exit-visual-state  "C-g" 'evil-exit-visual-state
  "o" 'evil-visual-exchange-corners  "O" 'evil-visual-rotate
  "I" 'evil-visual-insert   "A" 'evil-visual-append
  "x" 'evil-delete          "<deletechar>" 'evil-delete
  "s" 'evil-change
  "D" 'evil-delete-whole-lines  "X" 'evil-delete-whole-lines
  "Y" 'evil-yank-whole-lines
  "S" 'evil-change-whole-lines  "R" 'evil-change-whole-lines  "C" 'evil-change-whole-lines
  "p" 'evil-visual-paste    "P" 'evil-visual-paste
  "r" 'evil-replace-region  "J" 'evil-join-lines
  "u" 'evil-downcase        "U" 'evil-upcase          "~" 'evil-invert-case)
(define-key evil-visual-state-map "i" evil-inner-text-objects-map)
(define-key evil-visual-state-map "a" evil-outer-text-objects-map)

(evil--bind evil-insert-state-map
  "ESC" 'evil-normal-state
  "RET" 'evil-newline-and-indent
  "C-w" 'evil-delete-backward-word
  "C-u" 'evil-delete-back-to-indentation
  "C-r" 'evil-paste-from-register
  "C-o" 'evil-execute-in-normal-state
  "C-t" 'evil-shift-right-line
  "C-d" 'evil-shift-left-line
  "TAB" 'indent-for-tab-command
  "C-SPC" 'completion-at-point
  "C-z" 'evil-emacs-state)

(evil--bind evil-replace-state-map
  "DEL" 'evil-replace-backspace)

(evil--bind evil-emacs-state-map
  "C-z" 'evil-exit-emacs-state)

(evil-define-key 'motion 'special-mode
  "q" 'quit-window
  "RET" 'evil-buffer-menu-visit)

;; Surround, snipe and comments take s, S and gc from the default bindings above.
(define-key evil-normal-state-map "s" 'evil-snipe-s)
(define-key evil-normal-state-map "S" 'evil-snipe-S)
(define-key evil-motion-state-map "s" 'evil-snipe-s)
(define-key evil-motion-state-map "S" 'evil-snipe-S)
(define-key evil-operator-state-map "s" 'evil-surround-edit)
(define-key evil-visual-state-map "S" 'evil-surround-region)
(define-key evil-normal-state-map "g c" 'evil-comment-operator)
(define-key evil-visual-state-map "g c" 'evil-comment-operator)

;;; evil.scm ends here
