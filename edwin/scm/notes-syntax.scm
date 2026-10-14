;;; notes-syntax.scm: the one grammar of notes (spec R10.2, R11.2)
;;;
;;; Everything that reads a note agrees here: the notes index (edwin/server/notes-parse.mjs), markdown-mode's
;;; font-lock (E3) and the tests. The grammar is data: regular-expression source strings in the JavaScript
;;; dialect (no flags; the reader adds them) and lists of keywords. (notes-grammar) returns it as an alist of
;;; name -> value, which the index reads once at install and ships to its parser worker.
;;;
;;; Both formats share the grammar. A Markdown heading is `# text`, an Org heading `* text`; the parser picks
;;; the heading regexp by the file's extension and applies everything else to both.

;; Task keywords. The first seven are the user's Org set (org.scm); DOING, NOW and LATER are read as aliases
;; (DOING and NOW act as NEXT, LATER as TODO) so pages written in the Logseq style index as tasks too.
(define notes-task-keywords
  '("TODO" "NEXT" "WAITING" "HOLD" "SOMEDAY" "DONE" "CANCELLED" "DOING" "NOW" "LATER"))
(define notes-done-keywords '("DONE" "CANCELLED"))

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
