//! The model a frame draws (src/display.js builds it; its header has the format), as the window reads it.

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

/* The cells a character takes, as display.js's charWidth counts them: 0 for combining marks, joiners and
variation selectors, 2 for East Asian wide and full-width characters and emoji, else 1. */
const WIDE: &[(u32, u32)] = &[
    (0x1100, 0x115f),
    (0x231a, 0x231b),
    (0x2329, 0x232a),
    (0x23e9, 0x23ec),
    (0x2e80, 0x303e),
    (0x3041, 0x33ff),
    (0x3400, 0x4dbf),
    (0x4e00, 0x9fff),
    (0xa000, 0xa4cf),
    (0xa960, 0xa97f),
    (0xac00, 0xd7a3),
    (0xf900, 0xfaff),
    (0xfe10, 0xfe19),
    (0xfe30, 0xfe6f),
    (0xff00, 0xff60),
    (0xffe0, 0xffe6),
    (0x1f300, 0x1f64f),
    (0x1f900, 0x1f9ff),
    (0x20000, 0x3fffd),
];
/// Emoji with emoji presentation outside WIDE's ranges (the common ones of Unicode's Emoji_Presentation).
const EMOJI: &[(u32, u32)] = &[
    (0x23f0, 0x23f0),
    (0x23f3, 0x23f3),
    (0x25fd, 0x25fe),
    (0x2614, 0x2615),
    (0x2648, 0x2653),
    (0x267f, 0x267f),
    (0x2693, 0x2693),
    (0x26a1, 0x26a1),
    (0x26aa, 0x26ab),
    (0x26bd, 0x26be),
    (0x26c4, 0x26c5),
    (0x26ce, 0x26ce),
    (0x26d4, 0x26d4),
    (0x26ea, 0x26ea),
    (0x26f2, 0x26f3),
    (0x26f5, 0x26f5),
    (0x26fa, 0x26fa),
    (0x26fd, 0x26fd),
    (0x2705, 0x2705),
    (0x270a, 0x270b),
    (0x2728, 0x2728),
    (0x274c, 0x274c),
    (0x274e, 0x274e),
    (0x2753, 0x2755),
    (0x2757, 0x2757),
    (0x2795, 0x2797),
    (0x27b0, 0x27b0),
    (0x27bf, 0x27bf),
    (0x2b1b, 0x2b1c),
    (0x2b50, 0x2b50),
    (0x2b55, 0x2b55),
    (0x1f004, 0x1f004),
    (0x1f0cf, 0x1f0cf),
    (0x1f18e, 0x1f18e),
    (0x1f191, 0x1f19a),
    (0x1f1e6, 0x1f1ff),
    (0x1f201, 0x1f201),
    (0x1f21a, 0x1f21a),
    (0x1f22f, 0x1f22f),
    (0x1f232, 0x1f236),
    (0x1f238, 0x1f23a),
    (0x1f250, 0x1f251),
    (0x1f680, 0x1f6ff),
    (0x1f7e0, 0x1f7eb),
    (0x1fa70, 0x1faff),
];
const ZERO: &[(u32, u32)] = &[
    (0x0300, 0x036f),
    (0x0483, 0x0489),
    (0x0591, 0x05bd),
    (0x0610, 0x061a),
    (0x064b, 0x065f),
    (0x0e31, 0x0e31),
    (0x0e34, 0x0e3a),
    (0x0e47, 0x0e4e),
    (0x1ab0, 0x1aff),
    (0x1dc0, 0x1dff),
    (0x200b, 0x200f),
    (0x2060, 0x2060),
    (0x20d0, 0x20ff),
    (0x302a, 0x302f),
    (0x3099, 0x309a),
    (0xfe00, 0xfe0f),
    (0xfe20, 0xfe2f),
    (0xe0100, 0xe01ef),
];
fn within(t: &[(u32, u32)], c: u32) -> bool {
    t.iter().any(|&(a, z)| c >= a && c <= z)
}
pub fn char_width(ch: char) -> u32 {
    let c = ch as u32;
    if c < 0x300 {
        1
    } else if within(ZERO, c) {
        0
    } else if within(WIDE, c) || within(EMOJI, c) {
        2
    } else {
        1
    }
}

/// A segment's text cut into cells: (column offset, text drawn there, cells it takes). A zero-width character
/// joins the one before it. When the widths do not add up to the segment's (a character this table counts
/// otherwise than display.js), the characters are laid one per cell from the left.
pub fn cells(seg: &Seg) -> Vec<(u32, String, u32)> {
    let mut out: Vec<(u32, String, u32)> = Vec::new();
    let mut x = 0;
    for ch in seg.text.chars() {
        let w = char_width(ch);
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
