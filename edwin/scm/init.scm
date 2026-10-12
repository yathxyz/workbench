;;; init.scm --- your settings, loaded after emacs.scm and evil.scm

;; Change anything here, then :w to keep it in this browser and :so to
;; apply it now.  :e evil.scm shows how every Vim key is defined.
;; The layout follows the desktop configuration (init.el, init-evil.el,
;; init-completion.el): the same leader keys, the same settings.

;;;; Editor

;; Line numbers: #f, #t for absolute, or 'relative.
(set! display-line-numbers 'relative)

;; Search case: smart (ignore case unless you type a capital),
;; sensitive or insensitive.
(set! evil-ex-search-case 'smart)

;; Columns that > and < shift by.
(set! evil-shift-width 2)

;; TAB indents, then completes the word at point (tab-always-indent 'complete).
(set! tab-always-indent 'complete)

;; TAB in a text buffer inserts spaces to the next 4-column stop, not a tab
;; (indent-tabs-mode nil, tab-width 4).  truncate-lines stays #f here:
;; long lines wrap in a browser window.
(set! indent-tabs-mode #f)
(set! tab-width 4)

;; Point goes back where it was in a file, files list by last visit,
;; and the minibuffer histories survive a reload.
(set! save-place-mode #t)
(set! recentf-mode #t)
(set! savehist-mode #t)

;; How long a prefix key (SPC, g, z ...) waits before its keys are listed.
(set! which-key-idle-delay 1.0)

;; Text width for SPC y c.
(set! centered-view-width 100)

(define-command (cycle-line-numbers)
  "Cycle the line numbers: relative, absolute, none."
  (set! display-line-numbers
        (cond ((eq? display-line-numbers 'relative) #t)
              (display-line-numbers #f)
              (else 'relative)))
  (message "Line numbers: ~a" (or display-line-numbers "off")))

;;;; Completion (vertico, orderless, marginalia, prescient, corfu, cape)

(set! vertico-count 20)        ; rows of candidates
(set! vertico-cycle #t)        ; C-n past the last wraps to the first
(set! vertico-resize #t)       ; the list shrinks to the candidates
(set! prescient-persist-mode #t) ; M-x, buffers and files sort by use, kept across reloads
(set! corfu-auto #t)           ; the popup opens by itself
(set! corfu-auto-prefix 3)     ; after this many word characters
(set! corfu-count 10)

;;;; Evil (init-evil.el)

(set! evil-want-C-u-delete #t)          ; C-u in Insert deletes to the indentation
(set! evil-undo-system 'undo-redo)       ; u undoes, C-r redoes
(set! evil-respect-visual-line-mode #t)  ; j and k by screen lines where SPC y v is on
(set! evil-snipe-scope 'visible)         ; s and S search the screen
(set! evil-snipe-repeat-scope 'whole-visible) ; ; and , too, boxing every visible match
;; The desktop turns on evil-snipe-override-mode: f, F, t and T snipe one
;; character over the screen.  Edwin keeps them line-local as in Vim; this
;; line makes them snipes.
;; (evil-snipe-override-mode 1)

(define-key evil-insert-state-map "C-u"
  (if evil-want-C-u-delete 'evil-delete-back-to-indentation 'universal-argument))

;; j and k follow screen lines in a visual-line-mode buffer; g j and g k stay on buffer lines.
(evil-define-motion (evil-next-visual-line count)
  "Move down COUNT screen lines in a visual-line-mode buffer, else COUNT lines (j)."
  #:type line
  (unless (and evil-respect-visual-line-mode (evil--visual-line-move (or count 1)))
    (evil--line-move (or count 1))))

(evil-define-motion (evil-previous-visual-line count)
  "Move up COUNT screen lines in a visual-line-mode buffer, else COUNT lines (k)."
  #:type line
  (unless (and evil-respect-visual-line-mode (evil--visual-line-move (- (or count 1))))
    (evil--line-move (- (or count 1)))))

(when evil-respect-visual-line-mode
  (define-key evil-motion-state-map "j" 'evil-next-visual-line)
  (define-key evil-motion-state-map "k" 'evil-previous-visual-line))

;; C-n and C-p are free in Insert, Motion and Emacs state (next-line and
;; previous-line from the global map, or the completion popup).
(define-key evil-insert-state-map "C-n" #f)
(define-key evil-insert-state-map "C-p" #f)
(define-key evil-motion-state-map "C-n" #f)
(define-key evil-motion-state-map "C-p" #f)
(define-key evil-emacs-state-map "C-n" #f)
(define-key evil-emacs-state-map "C-p" #f)

;; Insert state: delete the word before point, as M-<backspace> does on the desktop.
(define-key evil-insert-state-map "M-DEL" 'evil-delete-backward-word)

;; evil-collection: q leaves help, the buffer list and other special buffers.
(evil-define-key '(normal motion) 'special-mode "q" 'quit-window)

;;;; Desktop-only keys

;; Keys whose package has no counterpart in Edwin say so instead of failing.
(define-syntax desktop-only
  (syntax-rules ()
    ((_ name key what)
     (define-command (name) what
       (message "~a runs ~a on the desktop (~a); it is not in Edwin" key 'name what)))))

(desktop-only vile-vcs-status "SPC g g" "Magit or Majutsu status")
(desktop-only vile-magit-status "SPC g G" "Magit status")
(desktop-only vile-majutsu-status "SPC g J" "Majutsu log")
(desktop-only git-timemachine "SPC g t" "git-timemachine")
(desktop-only consult-eglot-symbols "SPC p s" "LSP symbols")
(desktop-only citar-open "SPC y o" "citar: open a reference")
(desktop-only compile "SPC c c" "compile")
(desktop-only apheleia-format-buffer "SPC b f" "apheleia: format the buffer")
(desktop-only embark-act "SPC e a" "embark-act")
(desktop-only devdocs-lookup "SPC h d" "devdocs")
(desktop-only org-journal-new-entry "SPC n j j" "org-journal")

;;;; Leader keys (general.el)

;; SPC, then the group letter, as in init-evil.el; pause after SPC to see
;; what comes next.  Edwin adds groups of its own where they do not
;; collide: w windows, t toggles, b buffers, f files, h help, m eval.
;; org-roam-*, org-agenda, org-capture, org-id-get-create and the gptel
;; commands come from org.scm and ai.scm.  Normal and Visual state only, as
;; general.el's :states; after an operator SPC is a motion again (d SPC).
(evil-define-key '(normal visual) 'global
  ;; files and buffers
  "SPC SPC" 'consult-buffer          ; consult-project-buffer
  "SPC <"   'switch-to-buffer
  "SPC f f" 'find-file
  "SPC f s" 'save-buffer
  "SPC f S" 'evil-write-all
  "SPC f r" 'consult-recent-file
  "SPC b b" 'consult-buffer
  "SPC b B" 'switch-to-buffer
  "SPC b i" 'list-buffers
  "SPC b k" 'kill-current-buffer
  "SPC b m" 'bookmark-set
  "SPC b n" 'evil-next-buffer
  "SPC b p" 'evil-prev-buffer
  "SPC b M" 'view-messages
  "SPC b f" 'apheleia-format-buffer  ; desktop only
  "SPC RET" 'bookmark-jump
  ;; project
  "SPC p f" 'project-find-file
  "SPC p g" 'project-find-regexp
  "SPC p p" 'project-switch-project
  "SPC p s" 'consult-eglot-symbols   ; desktop only
  ;; git and LLM (g)
  "SPC g g" 'vile-vcs-status         ; desktop only
  "SPC g G" 'vile-magit-status       ; desktop only
  "SPC g J" 'vile-majutsu-status     ; desktop only
  "SPC g t" 'git-timemachine         ; desktop only
  "SPC g j" 'gptel-send
  "SPC g l" 'gptel-preset-menu
  "SPC g L" 'gptel-menu
  "SPC g a" 'gptel                   ; agent-shell on the desktop
  "SPC c c" 'compile                 ; desktop only
  ;; notes: org-roam (n r), org (m, o)
  "SPC n r f" 'org-roam-node-find
  "SPC n r i" 'org-roam-node-insert
  "SPC n r a" 'org-roam-node-random
  "SPC n r d t" 'org-roam-dailies-goto-today
  "SPC n r d d" 'org-roam-dailies-goto-date
  "SPC n j j" 'org-journal-new-entry ; desktop only
  "SPC m I" 'org-id-get-create
  "SPC m a" 'org-agenda
  "SPC o"   'org-capture
  ;; eval
  "SPC m e e" 'eval-last-sexp
  "SPC m e d" 'eval-defun
  "SPC m e b" 'eval-buffer
  ;; help (helpful on the desktop)
  "SPC h h" 'evil-help
  "SPC h k" 'describe-function
  "SPC h v" 'describe-variable
  "SPC h K" 'describe-key
  "SPC h b" 'describe-bindings
  "SPC h d" 'devdocs-lookup          ; desktop only
  ;; text (y): fill, centre, wrap
  "SPC y a" 'auto-fill-mode
  "SPC y c" 'centered-view-mode
  "SPC y v" 'visual-line-mode
  "SPC y w" 'fill-paragraph
  "SPC y o" 'citar-open              ; desktop only
  ;; misc
  "SPC e a" 'embark-act              ; desktop only
  "SPC u"   'evil-undo               ; vundo on the desktop
  "SPC :"   'execute-extended-command
  "SPC ;"   'eval-expression
  "SPC /"   'consult-line
  "SPC i"   'consult-imenu
  ;; navigation: avy and expreg
  "SPC l"   'avy-goto-line
  "SPC a"   'avy-goto-char
  "SPC s"   'avy-goto-symbol-1
  "SPC v"   'expreg-expand
  "SPC V"   'expreg-contract
  ;; windows
  "SPC w s" 'split-window-below
  "SPC w v" 'split-window-right
  "SPC w c" 'delete-window
  "SPC w o" 'delete-other-windows
  "SPC w w" 'other-window
  "SPC w h" 'windmove-left
  "SPC w j" 'windmove-down
  "SPC w k" 'windmove-up
  "SPC w l" 'windmove-right
  "SPC w u" 'winner-undo
  ;; toggles
  "SPC t n" 'cycle-line-numbers
  "SPC t r" 'rainbow-delimiters-mode
  "SPC t e" 'electric-pair-mode
  "SPC t t" 'modus-themes-toggle
  "SPC q q" 'evil-quit-all)

;; Buffers that start in Motion state (help, the buffer list, the agenda)
;; share the same leader keys through their own maps.
(for-each (lambda (mode) (evil-define-key 'motion mode "SPC" (lookup-key evil-normal-state-map "SPC")))
          '(special-mode org-agenda-mode org-roam-mode))

;; C-c keys: i in Insert sends the buffer to the LLM; c in Normal state opens
;; a chat (agent-shell on the desktop, gptel here, as SPC g a).
(define-key evil-insert-state-map "C-c i" 'gptel-send)
(define-key evil-normal-state-map "C-c c" 'gptel)

;;;; Snippets (yasnippet)

;; TAB after the key expands it; ${1:name} is asked for in the minibuffer,
;; $0 is where point ends.  The org src block is the desktop's one snippet.
(define-snippet 'org-mode "src" "#+begin_src ${1:language}\n$0\n#+end_src" "source block")
(define-snippet 'org-mode "jjs" "#+begin_src ${1:language}\n$0\n#+end_src" "source block (desktop key)")
(define-snippet 'scheme-mode "scm" "(define (${1:name} ${2:args})\n  $0)" "procedure")
;; Scheme only, and a key no word starts with: el would take TAB from else.
(define-snippet 'scheme-mode "defcmd" "(define-command (${1:name})\n  \"${2:doc}\"\n  (interactive)\n  $0)" "command")

;;;; AI (gptel, from ai.scm)

;; The backend in use; the forms below register more.  Each is guarded so
;; this file still loads without ai.scm.
(when (bound? 'gptel-backend)
  (set! gptel-backend "Claude"))
;; More backends, for when Claude's usage runs out (:e ai.scm documents each form).
;; Keys are never written here: M-x gptel-set-api-key keeps them in this browser.
;; (gptel-make-openai "OpenRouter"
;;   :host "openrouter.ai" :endpoint "/api/v1/chat/completions" :key 'store
;;   :models '("openrouter/auto" "openai/gpt-5.5"))
;; (gptel-make-openai "Ollama"
;;   :host "localhost:11434" :protocol "http" :endpoint "/v1/chat/completions" :key #f
;;   :models '("qwen3:8b"))
;; (gptel-make-anthropic "Anthropic" :key 'store :models '("claude-sonnet-5-5"))
;; (gptel-make-mcp "yath.xyz" :server "yath.xyz" :tool "chat" :models '("default"))
;; Tried in order when the current backend is rate limited or out of usage:
;; (set! gptel-fallback-backends '("OpenRouter" "Anthropic"))

;;;; Ex commands

;; Your own ex commands: :Date inserts today's date.
(evil-ex-define-cmd "Date" 'insert-date)

;;; init.scm ends here
