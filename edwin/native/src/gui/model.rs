//! The model a frame draws (src/display.ts builds it; its header has the format), as the window reads it.

use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Model {
    pub cols: u32,
    pub rows: u32,
    pub theme: String,
    pub focused: bool,
    pub title: Option<String>,
    pub faces: Vec<Face>,
    pub lines: Vec<Vec<Seg>>,
    pub cursor: Option<Cursor>,
    pub ghosts: Vec<Pt>,
    pub presence: Vec<Presence>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct Face {
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub weight: Option<f64>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    #[serde(rename = "box")]
    pub boxed: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Seg {
    pub x: u32,
    pub w: u32,
    pub text: String,
    pub f: usize,
    /// The cells each character takes, by display.ts's charWidth (gui.ts adds it to a segment with any character
    /// past U+02FF; without it every character takes one).
    #[serde(default)]
    pub cw: Vec<u8>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Cursor {
    pub x: i32,
    pub y: i32,
    pub shape: String,
    pub color: Option<String>,
    pub fg: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Pt {
    pub x: i32,
    pub y: i32,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Presence {
    pub x: i32,
    pub y: i32,
    pub label: String,
    pub color: Option<String>,
}

/// An sRGB colour, 0..1 per channel.
pub type Rgba = [f32; 4];

/// '#rrggbb' or '#rgb' to a colour; anything else is None.
pub fn color(s: Option<&str>) -> Option<Rgba> {
    let h = s?.strip_prefix('#')?;
    let v = |i: usize, n: usize| u8::from_str_radix(&h[i..i + n], 16).ok();
    let (r, g, b) = match h.len() {
        6 => (v(0, 2)?, v(2, 2)?, v(4, 2)?),
        3 => (v(0, 1)? * 17, v(1, 1)? * 17, v(2, 1)? * 17),
        _ => return None,
    };
    Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0])
}

/// A segment's text cut into cells: (column offset, text drawn there, cells it takes). A zero-width character
/// joins the one before it. When the widths do not add up to the segment's, the characters are laid one per cell
/// from the left.
pub fn cells(seg: &Seg) -> Vec<(u32, String, u32)> {
    let mut out: Vec<(u32, String, u32)> = Vec::new();
    let mut x = 0;
    for (i, ch) in seg.text.chars().enumerate() {
        let w = seg.cw.get(i).map_or(1, |&w| w as u32);
        if w == 0 {
            if let Some(last) = out.last_mut() {
                last.1.push(ch);
                continue;
            }
        }
        let w = w.max(1);
        out.push((x, ch.to_string(), w));
        x += w;
    }
    if x != seg.w {
        for (x, c) in out.iter_mut().enumerate() {
            c.0 = x as u32;
            c.2 = 1;
        }
    }
    out
}
