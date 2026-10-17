# Hypernotes: literate programming as hypermedia

A hypernote is a markdown page whose code blocks run in edwind and whose `html` blocks become live cards on the
canvas. Each card asks the Lisp image for its HTML, in the way htmx asks a server. The exploration, with a demo on
Edwin's own Scheme, is the artifact "Hypernotes on Edwin" (https://claude.ai/artifact/7rkFUM8Ryv5VKYWBQWMeJr).

## Decisions (2026-10-14)

The owner accepted every recommendation of the exploration:

1. **One block engine, two syntaxes.** Babel is built once in edwind. Org's `#+begin_src` and markdown fences
   (```` ```lang {#id k=v} ````) both feed it. This widens the edwind spec's R10.8 (babel for Org) to markdown.
2. **A small request layer in the bridge.** Cards use htmx's attribute names (`hx-get`, `hx-post`, `hx-target`,
   `hx-swap`, `hx-trigger`, `hx-vals`) over a layer of about 3 KB in `web/bridge.ts`, not a full htmx in every card.
   `hx-get="chart"` names a Scheme handler in the note's environment, not a URL.
3. **Text results stay in the file** for `scheme` and `sh` blocks, as a ```` ```result {of=id} ```` fence under the
   block. Cards are never stored, because they are live.
4. **Note environments stay out of the image log.** Forms that run in a note's environment are not definitional for
   R4.15 and are not sent to frames. The environment lasts until edwind restarts; run-all rebuilds it. This is an
   amendment to the edwind spec, for the owner of the edwind phases to fold in.
5. **No automatic reactivity yet.** Blocks run only on an explicit run (R14.15). `broadcast!` refreshes live cards.
6. **H0 starts now**, on today's page cards, before edwind frames exist.

## The format

| Fence | Runs in | Runs when | Leaves in the file |
|---|---|---|---|
| `scheme` | edwind, in the note's environment | C-c C-c or run-all only | a `result` fence |
| `sh`, `bash` | a card-less hub PTY (`call-process`, R4.44) | C-c C-c or run-all only | a `result` fence |
| `html` | an opaque-origin artifact frame | when it is on screen | nothing |
| `json`, `csv`, `sexp` | nowhere; data bound to its `#id` | never | the data |

Attributes in the info string follow babel's header arguments: `#id` (`#+name:`), `in=a,b` (`:var`),
`results=value|output|silent`, `env=name` (`:session`), `noweb`, `tangle=path`, and `card=WxH` for the card size.

Executable HTML is a fence, not CommonMark raw HTML: an HTML block of kind 6 or 7 ends at the first blank line,
GitHub's tagfilter strips scripts, and Workbench must not put note HTML into its own page (F-A8). Raw inline HTML in
prose renders through a sanitiser and runs nothing.

## Steps

| Step | Content | Needs |
|---|---|---|
| H0 | Tear-out of `html` fences from page cards into artifact nodes bound to the block (F-A25). | `web/app.ts` only |
| H1 | The babel engine in edwind for Org and markdown: `scheme` and `sh` blocks, results, `in=`, noweb, tangle, note environments, decision 4. | E3 |
| H2 | Hypermedia: `define-handler` returning SXML, the bridge capability that carries `{note, handler, params}`, the `hx-*` layer, `broadcast!`, a grant per card. | H1 |
| H3 | Export: a static page with stored results and each card's last HTML. Agent tools for blocks. | H2 |

The edwind phases (E0–E4) keep their order; H1 and later start after E3.

## H0 as built

- A ```` ```html ```` fence (backticks or tildes, any case) in a page shows a `⇱ card` button at the end of its fence
  line. The button, the palette command "Page: tear out the html block at the cursor as a card" and the agent tool
  `tear_out_block` make a card.
- The card is an `artifact` node with `block: {page, id}` and a `ref` edge from the page. It has no source, no
  versions and no `artifact` capability; it declares `sample` and `db`. Its ✎ button and "Artifact: jump to its html
  block" open the block in the page.
- A block without an id gets `#blockN` written into its info string before the card is made, so the card's address
  survives edits around it. `card=WxH` sets the card's size.
- The frame is an opaque-origin `srcdoc` frame without `allow-same-origin`, in the demo and on the server alike, so
  block cards do not wait for M5's artifact origin.
- 400 ms after an edit to the page, every card whose block changed reloads. A removed block or page leaves a notice
  in the card; putting the block back restores it.
