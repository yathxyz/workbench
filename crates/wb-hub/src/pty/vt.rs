//! PTY screen state: a vt100 parser per live session, its `replay` snapshot and its
//! `.snap` persistence form.

use anyhow::Result;

/// The terminal state of one live PTY.
pub struct Vt {
    parser: vt100::Parser,
}

impl Vt {
    pub fn new(cols: u16, rows: u16) -> Self {
        todo!("M1-H1: parser of {cols}x{rows}")
    }

    /// Feeds PTY output to the parser. A parser panic is contained here.
    pub fn feed(&mut self, text: &str) {
        todo!("M1-H1: feed {} bytes", text.len())
    }

    /// Resizes the screen, applying the shrink rule first.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        todo!("M1-H1: resize to {cols}x{rows}")
    }

    /// The `replay` string: escape sequences that rebuild the screen, scrollback and
    /// modes in a fresh terminal.
    pub fn snapshot(&mut self) -> String {
        todo!("M1-H1: snapshot of {:?}", self.parser.screen().size())
    }

    /// The plain text of the newest `lines` rows, scrollback included.
    pub fn capture(&mut self, lines: usize) -> String {
        todo!("M1-H1: capture {lines} lines")
    }

    /// The `.snap` file contents.
    pub fn to_snap(&mut self) -> Vec<u8> {
        todo!("M1-H1: .snap of {:?}", self.parser.screen().size())
    }

    /// Restores a `Vt` from `.snap` file contents.
    pub fn from_snap(snap: &[u8]) -> Result<Vt> {
        todo!("M1-H1: restore from {} bytes", snap.len())
    }
}
