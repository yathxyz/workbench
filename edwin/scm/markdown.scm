;;; markdown.scm: markdown-mode for the pages of the board (spec §10.1, R10.1-R10.5).
;;;
;;; The grammar is notes-syntax.scm (wiki links, block refs, anchors, the task keyword table shared with
;;; Org, key:: fields, priorities); the lexer, the display overlays and the editing primitives (%markdown-*)
;;; are in edwin/src/markdown.js, which loads after org.js. This file defines the variables the runtimes
;;; bind, the mode, its commands and its keys. org.scm requires it after Org and before init.scm, so the
;;; user's init.scm can change everything here.

(require 'notes-syntax)
(require 'address)

;;;; Variables the frame runtime and the server bind

;; Files open in the mode: (REGEXP . MODE) pairs, regexps in the JavaScript dialect, tried in order on the
;; file name before the built-in rules.
(define auto-mode-alist
  '(("\\.(md|markdown|mdown)$" . markdown-mode) ("\\.org$" . org-mode)))
;; The notes directory of the server (notesDir, R11.1): journal-today opens journal/YYYY-MM-DD.md under it.
;; Empty: file names are relative to the store, as in the browser-only Edwin.
(define notes-directory "")
;; What wiki-follow calls with the link target: the frame runtime binds Ed.hooks.openPage here. #f: the
;; default, which switches to an open page of that name or says that no page opener is installed.
(define wiki-follow-function #f)
;; The names wiki-capf offers after [[: note titles and folders, filled by the runtime from the server's
;; capf-candidates (R10.9). Open Markdown pages are offered as well.
(define wiki-candidates '())
;; How a ((reference)) to a page that is not open is resolved: a procedure of the address string returning
;; the text to show, or #f. The frame runtime binds it; on the server the notes index is used.
(define resolve-ref-function #f)
;; The page name of a buffer, for addresses and links: the board binds its card's name here; #f means the file
;; name without directory and extension (markdown-page-name reads it).
(defvar-local page-name #f "The page name of this buffer (a string), or #f for the file name without its extension.")
;; markdown-todo-cycle steps through these states (the tasks view's columns); every other keyword maps onto
;; one of them through markdown-todo-columns.
(define markdown-todo-cycle-order '("TODO" "NEXT" "WAITING" "DONE"))
(define markdown-todo-columns
  '(("TODO" . "TODO") ("SOMEDAY" . "TODO") ("LATER" . "TODO")
    ("NEXT" . "NEXT") ("DOING" . "NEXT") ("NOW" . "NEXT")
    ("WAITING" . "WAITING") ("HOLD" . "WAITING")
    ("DONE" . "DONE") ("CANCELLED" . "DONE")))

;;;; The mode

(define-derived-mode markdown-mode text-mode "Markdown"
  "Major mode for Markdown pages: headings, lists and tasks, emphasis, code, links, [[wiki links]],
((block references)), ^anchors, key:: fields and [#A] priorities, folded by heading as Org folds."
  #f)

;;;; Editing commands (the text work is in markdown.js)

(define-command (markdown-outline-enter)
  "RET in a list: a new sibling bullet (a numbered one counts up, a task bullet keeps its [ ]), or on an
empty item outdent it or end the list; elsewhere a plain newline."
  (interactive)
  (unless (%markdown-outline-enter)
    (if (evil-insert-state?) (evil-newline-and-indent) (newline))))

(define-command (markdown-demote)
  "TAB: indent the list item at point (or the lines of the region) by two spaces; elsewhere indent-for-tab-command."
  (interactive)
  (unless (%markdown-shift-lines 1) (indent-for-tab-command)))

(define-command (markdown-promote)
  "S-TAB: dedent the list item at point (or the lines of the region) by up to two spaces."
  (interactive)
  (%markdown-shift-lines -1))

(define-command (markdown-tab)
  "TAB in Normal state: fold the heading at point as org-cycle does, indent a list item, else reveal."
  (interactive)
  (when (or (org-at-heading-p) (not (%markdown-shift-lines 1)))
    (set! this-command 'org-cycle)          ; org-cycle's TAB sequence (folded, children, subtree) reads last-command
    (org-cycle)))

(define-command (markdown-todo-cycle)
  "Step the task at point to the next state of markdown-todo-cycle-order (C-c C-t, S-<right>)."
  (interactive)
  (message "TODO state: ~a" (%markdown-todo-cycle #f)))

(define-command (markdown-todo-cycle-backward)
  "Step the task at point to the previous state of markdown-todo-cycle-order (S-<left>)."
  (interactive)
  (message "TODO state: ~a" (%markdown-todo-cycle #t)))

;;;; Links and references

(define (markdown-default-wiki-follow target)
  "Switch to the open page named TARGET, else say that no page opener is installed."
  (let ((b (markdown-find-page target)))
    (if b (switch-to-buffer b)
        (message "No page opener for [[~a]] (set wiki-follow-function)" target))))

(define-command (wiki-follow)
  "Follow the link at point: a [[wiki link]] through wiki-follow-function, a ((reference)) to its block,
a URL or [label](target) through org-open-at-point."
  (interactive)
  (let ((lk (markdown-link-at)))
    (unless lk (user-error "No link at point"))
    (let ((kind (vector-ref lk 0)) (target (vector-ref lk 1)))
      (cond ((eq? kind 'ref) (markdown-follow-ref))
            ((eq? kind 'wiki)
             (if (procedure? wiki-follow-function)
                 (wiki-follow-function target)
                 (markdown-default-wiki-follow target)))
            (else (org-open-at-point))))))

(define-command (markdown-follow-ref)
  "Jump to the block a ((reference)) at point names, in its page."
  (interactive)
  (let ((lk (markdown-link-at)))
    (unless (and lk (eq? (vector-ref lk 0) 'ref)) (user-error "No block reference at point"))
    (let ((hit (markdown-resolve-ref-position (vector-ref lk 1))))
      (unless hit (user-error "((~a)) is not found" (vector-ref lk 1)))
      (switch-to-buffer (car hit))
      (goto-char (cdr hit)))))

(define-command (markdown-ret)
  "RET in Normal state: follow the link at point, else move to the next line as RET does in Vim."
  (interactive)
  (if (markdown-link-at) (wiki-follow) (evil-next-line-first-non-blank 1)))

(define-command (wiki-copy-ref)
  "Copy a ((reference)) to the block at point: its address Name › Heading ¶N \"quote\" (R6.14)."
  (interactive)
  (let ((ref (markdown-block-ref-at-point)))
    (kill-new ref)
    (message "Copied ~a" ref)))

(define-command (wiki-capf)
  "Complete the [[wiki link]] before point from wiki-candidates and the open pages, closing it with ]]."
  (interactive)
  (unless (%wiki-capf) (user-error "No [[link to complete before point")))

;;;; Journal

(define (journal-file-name day)
  "The journal page of DAY (YYYY-MM-DD) under notes-directory, .md or .org after journal-format."
  (let ((dir (cond ((string-null? notes-directory) "")
                   ((string-suffix? "/" notes-directory) notes-directory)
                   (else (string-append notes-directory "/"))))
        (ext (if (or (eq? journal-format 'org) (equal? journal-format "org")) "org" "md")))
    (string-append dir "journal/" day "." ext)))

(define-command (journal-today)
  "Open today's journal page, journal/YYYY-MM-DD.md under notes-directory (or .org when journal-format is org)."
  (interactive)
  (find-file (journal-file-name (journal-day-string))))

;;;; The index: unlinked mentions (server side, R11.10)

(define-command (markdown-unlinked-mentions)
  "List the mentions of this page's title in other notes that are not links, from the notes index."
  (interactive) (:where 'server)
  (unless (bound? 'unlinked-mentions) (user-error "unlinked-mentions needs the notes index of the server"))
  (let* ((file (or (buffer-file-name) (user-error "This buffer visits no file")))
         (hits (unlinked-mentions file))
         (buf (get-buffer-create "*Unlinked Mentions*")))
    (with-current-buffer buf
      (erase-buffer)
      (insert (format #f "Unlinked mentions of ~a: ~a~%~%" file (length hits)))
      (for-each (lambda (h)
                  (insert (format #f "~a:~a: ~a~%" (vector-ref h 0) (vector-ref h 1) (vector-ref h 3))))
                hits)
      (goto-char (point-min)))
    (pop-to-buffer buf)
    (length hits)))

;;;; Keys

;; Insert and Emacs state: the outliner's RET and TAB, as the CodeMirror page keymap had them.
(evil-define-key '(insert emacs) 'markdown-mode
  "RET" 'markdown-outline-enter
  "TAB" 'markdown-demote
  "S-TAB" 'markdown-promote)
;; Normal state: folding on headings, links on RET, evil-markdown's motions, task cycling on S-<arrows>;
;; z a, z c and z o fold as org.scm binds them for markdown-mode.
(evil-define-key '(normal motion) 'markdown-mode
  "RET" 'markdown-ret
  "TAB" 'markdown-tab
  "S-TAB" 'org-global-cycle
  "] ]" 'org-next-visible-heading
  "[ [" 'org-previous-visible-heading
  "g j" 'evil-next-visual-line
  "g k" 'evil-previous-visual-line
  "S-<right>" 'markdown-todo-cycle
  "S-<left>" 'markdown-todo-cycle-backward)
(evil-define-key 'visual 'markdown-mode
  "TAB" 'markdown-demote
  "S-TAB" 'markdown-promote)
(define-key markdown-mode-map "C-c C-t" 'markdown-todo-cycle)
(define-key markdown-mode-map "C-c C-w" 'wiki-copy-ref)
(define-key markdown-mode-map "C-c C-f" 'wiki-follow)
(define-key markdown-mode-map "C-c C-j" 'journal-today)
(define-key markdown-mode-map "C-c C-m" 'markdown-unlinked-mentions)
(for-each (lambda (c) (put c 'evil-repeat 'abort))
          '(markdown-tab markdown-ret wiki-follow markdown-follow-ref wiki-copy-ref wiki-capf journal-today
            markdown-unlinked-mentions markdown-todo-cycle markdown-todo-cycle-backward))

(provide 'markdown)

;;; markdown.scm ends here
