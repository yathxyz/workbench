//! Every source the binary carries: the core (edwin/src), the native layer (native/js) and the shipped Scheme.

/// JavaScript, by the name main.js loads it with (core files bare, the native layer under native/).
pub const JS: &[(&str, &str)] = &[
    ("scheme", include_str!("../../src/scheme.js")),
    ("runtime", include_str!("../../src/runtime.js")),
    ("text", include_str!("../../src/text.js")),
    ("editor-core", include_str!("../../src/editor-core.js")),
    ("editor-prims", include_str!("../../src/editor-prims.js")),
    ("evil-core", include_str!("../../src/evil-core.js")),
    ("pool", include_str!("../../src/pool.js")),
    ("complete", include_str!("../../src/complete.js")),
    ("extras", include_str!("../../src/extras.js")),
    ("stack", include_str!("../../src/stack.js")),
    ("ai", include_str!("../../src/ai.js")),
    ("evil-ex", include_str!("../../src/evil-ex.js")),
    ("org", include_str!("../../src/org.js")),
    ("markdown", include_str!("../../src/markdown.js")),
    ("ot", include_str!("../../src/ot.js")),
    ("sync", include_str!("../../src/sync.js")),
    ("display", include_str!("../../src/display.js")),
    ("native/prelude", include_str!("../js/prelude.js")),
    ("native/host-native", include_str!("../js/host-native.js")),
    ("native/boot", include_str!("../js/boot.js")),
    ("native/term", include_str!("../js/term.js")),
    ("native/gui", include_str!("../js/gui.js")),
    ("native/main", include_str!("../js/main.js")),
];

/// The shipped Scheme, by file name (host.config).
pub const SCM: &[(&str, &str)] = &[
    ("address.scm", include_str!("../../scm/address.scm")),
    ("ai.scm", include_str!("../../scm/ai.scm")),
    ("debug.scm", include_str!("../../scm/debug.scm")),
    ("emacs.scm", include_str!("../../scm/emacs.scm")),
    ("evil.scm", include_str!("../../scm/evil.scm")),
    ("init.scm", include_str!("../../scm/init.scm")),
    ("markdown.scm", include_str!("../../scm/markdown.scm")),
    ("models.scm", include_str!("../../scm/models.scm")),
    (
        "notes-syntax.scm",
        include_str!("../../scm/notes-syntax.scm"),
    ),
    ("org.scm", include_str!("../../scm/org.scm")),
    ("process.scm", include_str!("../../scm/process.scm")),
    ("threads.scm", include_str!("../../scm/threads.scm")),
    ("wb.scm", include_str!("../../scm/wb.scm")),
];

pub fn js(name: &str) -> Option<&'static str> {
    JS.iter().find(|(n, _)| *n == name).map(|(_, s)| *s)
}
