;;; notes-syntax.scm: the one grammar of notes (spec R10.2, R11.2)
;;;
;;; Everything that reads a note agrees here: the notes index (edwin/server/notes-parse.mts), markdown-mode's
;;; font-lock (E3) and the tests. The grammar is data: regular-expression source strings in the JavaScript
;;; dialect (no flags; the reader adds them) and lists of keywords. (notes-grammar) returns it as an alist of
;;; name -> value, which the index reads once at install and ships to its parser worker.
;;;
;;; Both formats share the grammar. A Markdown heading is `# text`, an Org heading `* text`; the parser picks
;;; the heading regexp by the file's extension and applies everything else to both.

;; Task keywords: the one table shared by Org (org.scm reads org-todo-keywords from it), markdown-mode
;; (edwin/src/markdown.js reads notes-task-keywords and notes-done-keywords) and the notes index. An entry is
;; (KEYWORD SELECTION DONE? ALIAS-OF): SELECTION is the Org fast-selection key with its logging flags
;; ("w@/!"), or #f for a keyword Org does not offer; DONE? marks a done state; ALIAS-OF names the keyword an
;; alias stands for. The first seven are the user's Org set; DOING, NOW and LATER are read as aliases (DOING
;; and NOW act as NEXT, LATER as TODO) so pages written in the Logseq style index as tasks too.
;; Change the table with notes-set-task-keywords!, which updates every derived list and Org's keywords at once.
(define notes-task-keyword-table
  '(("TODO" "t" #f #f) ("NEXT" "n" #f #f) ("WAITING" "w@/!" #f #f) ("HOLD" "h@/!" #f #f) ("SOMEDAY" "s" #f #f)
    ("DONE" "d!" #t #f) ("CANCELLED" "c@/!" #t #f)
    ("DOING" #f #f "NEXT") ("NOW" #f #f "NEXT") ("LATER" #f #f "TODO")))
(define (notes-task-entry-keyword e) (car e))
(define (notes-task-entry-done? e) (and (pair? (cddr e)) (caddr e)))
(define (notes-task-entry-alias e) (and (pair? (cddr e)) (pair? (cdddr e)) (cadddr e)))
(define (notes-task-entry-selection e) (and (pair? (cdr e)) (cadr e)))
(define (notes-table-keywords table) (map notes-task-entry-keyword table))
(define (notes-table-done table)
  (map notes-task-entry-keyword (filter notes-task-entry-done? table)))
;; The flat lists the parsers read: every keyword in table order, and the done ones.
(define notes-task-keywords (notes-table-keywords notes-task-keyword-table))
(define notes-done-keywords (notes-table-done notes-task-keyword-table))
;; The keyword an alias stands for (DOING -> NEXT), or the keyword itself.
(define (notes-task-keyword-base kw)
  (let ((e (assoc kw notes-task-keyword-table)))
    (or (and e (notes-task-entry-alias e)) kw)))
;; Org's org-todo-keywords value built from TABLE (the shared table by default): the entries that carry a
;; selection key, open states first, then "|", then the done states, each as "KEYWORD(selection)".
(define (notes-org-todo-keywords . table)
  (let* ((table (if (pair? table) (car table) notes-task-keyword-table))
         (own (filter (lambda (e) (and (notes-task-entry-selection e) (not (notes-task-entry-alias e)))) table))
         (name (lambda (e) (string-append (notes-task-entry-keyword e) "(" (notes-task-entry-selection e) ")"))))
    (list (cons 'sequence
                (append (map name (filter (lambda (e) (not (notes-task-entry-done? e))) own))
                        (list "|")
                        (map name (filter notes-task-entry-done? own)))))))
;; Replace the shared table: the flat lists change for markdown-mode and the index, and org-todo-keywords
;; (when Org is loaded) for Org, so one change reaches both modes.
(define (notes-set-task-keywords! table)
  (set! notes-task-keyword-table table)
  (set! notes-task-keywords (notes-table-keywords table))
  (set! notes-done-keywords (notes-table-done table))
  (when (bound? 'org-todo-keywords) (set! org-todo-keywords (notes-org-todo-keywords table)))
  table)

;; [[target]], [[target|label]] (Markdown) and [[target][label]] (Org). Group 1 is the target, group 2 or 3
;; the label. A target may carry `#Heading` or `#^anchor`; `id:`, `file:` and URL schemes name other kinds.
(define notes-wiki-link-regexp
  "\\[\\[([^\\[\\]\\n|]+?)(?:\\|([^\\[\\]\\n]*)|\\]\\[([^\\]\\n]*))?\\]\\]")
;; ((address)): a block reference by address (`Name#^anchor`, `Name › Heading`, or a bare `^anchor`).
(define notes-block-ref-regexp "\\(\\(([^()\\n]+?)\\)\\)")
;; Markdown inline links [label](target); the parser keeps URLs and note files, not images.
(define notes-inline-link-regexp "(?<!!)\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)")
;; A block anchor: `^name` at the end of a line.
(define notes-anchor-regexp "(?:^|\\s)\\^([A-Za-z0-9_-]+)\\s*$")
;; key:: value fields (Logseq properties), optionally behind a bullet. Group 1 the key, group 2 the value.
(define notes-field-regexp "^\\s*(?:[-*+]\\s+)?([A-Za-z][\\w-]*)::\\s*(.*?)\\s*$")
;; [#A] priorities.
(define notes-priority-regexp "\\[#([A-Z0-9])\\]")
;; Planning: SCHEDULED: <2026-10-11 Sat>, DEADLINE: [2026-10-11], CLOSED: ... (several per line).
(define notes-planning-regexp "(SCHEDULED|DEADLINE|CLOSED):\\s*[<\\[](\\d{4}-\\d{2}-\\d{2})[^>\\]\\n]*[>\\]]")
;; Headings: ATX for Markdown, stars for Org. Group 1 the marker, group 2 the text.
(define notes-md-heading-regexp "^(#{1,6})[ \\t]+(.*?)[ \\t]*$")
(define notes-org-heading-regexp "^(\\*+)[ \\t]+(.*?)[ \\t]*$")
;; Setext underlines (=== or ---) under a text line make a level 1 or 2 heading in Markdown.
(define notes-md-setext-regexp "^(=+|-+)[ \\t]*$")
;; List items: bullets and numbers. Group 1 the indentation, group 2 the marker, group 3 the text.
(define notes-list-item-regexp "^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$")
;; Org in-buffer settings: #+title:, #+filetags:, #+alias:, #+roam_alias:. Group 1 the key, group 2 the value.
(define notes-org-keyword-regexp "^#\\+([A-Za-z_]+):[ \\t]*(.*?)[ \\t]*$")
;; Org property drawers and their lines (:ID:, :ROAM_ALIASES:, any :KEY: value).
(define notes-org-drawer-begin-regexp "^[ \\t]*:PROPERTIES:[ \\t]*$")
(define notes-org-drawer-end-regexp "^[ \\t]*:END:[ \\t]*$")
(define notes-org-property-regexp "^[ \\t]*:([A-Za-z_][\\w-]*):[ \\t]+(.*?)[ \\t]*$")
;; Org heading tags `:a:b:` at the end of the heading text.
(define notes-org-tags-regexp "\\s+(:[\\w@#%:]+:)\\s*$")
;; Inline #tags in Markdown (not headings, not `#+keywords`): group 1 the tag.
(define notes-inline-tag-regexp "(?:^|[\\s(])#([A-Za-z][\\w/-]*)")
;; Markdown front matter delimiter and the keys read from it.
(define notes-front-matter-regexp "^---\\s*$")
(define notes-front-matter-keys '("title" "tags" "aliases" "alias" "id"))
;; Fenced code: nothing inside is a heading, a task or a link.
(define notes-fence-regexp "^\\s*(```|~~~)")
;; Flashcards (the deck syntax of web/app.js): a block whose fields hold `card:: kind`, with deck::, back::
;; and status::, and `{{c1::text}}` clozes in the body. Kinds: basic, reverse, cloze, type, pen, voice.
(define notes-card-field "card")
(define notes-card-kinds '("basic" "reverse" "cloze" "type" "pen" "voice"))
(define notes-cloze-regexp "\\{\\{c(\\d+)::(.*?)\\}\\}")
;; Journal files: journal/YYYY-MM-DD.md (or daily/, dailies/, and .org).
(define notes-journal-path-regexp "^(?:journal|daily|dailies)/(\\d{4})-(\\d{2})-(\\d{2})\\.(?:md|org)$")
;; A URL.
(define notes-url-regexp "^(?:https?|mailto|ftp):")

;; The index skips these paths (R11.1). A pattern ending in / names a directory anywhere in the tree; `*`
;; matches inside one path segment.
(define notes-index-ignore '(".git/" "node_modules/" "*.sync-conflict-*"))

;; The format of new journal pages: "md" (journal/YYYY-MM-DD.md) or "org".
(define journal-format "md")

;; The template of a new journal page (R11.3 POST /api/journal): a string in which <day> is replaced by the
;; day, or a procedure of the day returning the text.
(define journal-template "# <day>\n\n")

;; The generation of the notes index: bumped by edwind on every change (R11.7).
(define notes-generation 0)

(define (notes-grammar)
  "The notes grammar as an alist of name -> regexp source string or keyword list."
  ;; The flat keyword lists are what the index serialises (its golden test fixes these keys); the table they
  ;; come from is notes-task-keyword-table.
  (list (cons 'task-keywords notes-task-keywords)
        (cons 'done-keywords notes-done-keywords)
        (cons 'wiki-link notes-wiki-link-regexp)
        (cons 'block-ref notes-block-ref-regexp)
        (cons 'inline-link notes-inline-link-regexp)
        (cons 'anchor notes-anchor-regexp)
        (cons 'field notes-field-regexp)
        (cons 'priority notes-priority-regexp)
        (cons 'planning notes-planning-regexp)
        (cons 'md-heading notes-md-heading-regexp)
        (cons 'org-heading notes-org-heading-regexp)
        (cons 'md-setext notes-md-setext-regexp)
        (cons 'list-item notes-list-item-regexp)
        (cons 'org-keyword notes-org-keyword-regexp)
        (cons 'org-drawer-begin notes-org-drawer-begin-regexp)
        (cons 'org-drawer-end notes-org-drawer-end-regexp)
        (cons 'org-property notes-org-property-regexp)
        (cons 'org-tags notes-org-tags-regexp)
        (cons 'inline-tag notes-inline-tag-regexp)
        (cons 'front-matter notes-front-matter-regexp)
        (cons 'front-matter-keys notes-front-matter-keys)
        (cons 'fence notes-fence-regexp)
        (cons 'card-field notes-card-field)
        (cons 'card-kinds notes-card-kinds)
        (cons 'cloze notes-cloze-regexp)
        (cons 'journal-path notes-journal-path-regexp)
        (cons 'url notes-url-regexp)))

(provide 'notes-syntax)
