# F-A6

PtyBackend: `spawn:true` only for explicit actions (§3.5.1).
Reconnect and page-load opens send `spawn:false` with `resume{stream, out}`, and the spawn flag is cleared as soon as an open is sent.
`not_found` shows "No session: press Enter to start …".
Cards get `goneElsewhere` via `gone`.
`resize` is sent only when visible, focused and active.
On `resumed:true` the xterm is **not** reset.
