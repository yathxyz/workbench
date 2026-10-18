//! What JS asks of the window (DT2), kept apart from the window itself so that natives.rs, which build.rs
//! compiles into the snapshot maker too, needs no graphics library. The window (gui/) fills this in when it opens
//! and reads it after each turn of JS: the model to draw, the size it has, the actions asked for.

use std::cell::RefCell;

#[derive(Default)]
pub struct Bridge {
    /// A window is open (the program was started with --gui and the display answered).
    pub open: bool,
    /// The window's size in character cells.
    pub cols: u32,
    pub rows: u32,
    /// The desktop's theme when the window system says it ("dark" or "light").
    pub theme: Option<String>,
    /// The last model drawn (JSON, as display.ts builds it) that the window has not taken yet.
    pub model: Option<String>,
    /// Actions in the order asked: ("bell", ""), ("clipboard", text), ("iconify", ""), ("raise", "").
    pub actions: Vec<(String, String)>,
    /// Reads the system clipboard (set by the window, which owns the clipboard connection).
    pub clipboard: Option<Box<dyn FnMut() -> Option<String>>>,
}

thread_local! {
    static BRIDGE: RefCell<Bridge> = RefCell::new(Bridge::default());
}

pub fn with<R>(f: impl FnOnce(&mut Bridge) -> R) -> R {
    BRIDGE.with(|b| f(&mut b.borrow_mut()))
}

/// The system clipboard's text, read without holding the bridge (the reader may take a while).
pub fn clipboard_text() -> Option<String> {
    let mut reader = with(|b| b.clipboard.take())?;
    let text = reader();
    with(|b| b.clipboard = Some(reader));
    text
}
