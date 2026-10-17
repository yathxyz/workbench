//! Fonts for the window: one monospaced family on a grid of cells, shaped and rasterized by cosmic-text (which
//! falls back to other system fonts for characters the family lacks, CJK and emoji among them).
//!
//! The family is EDWIN_FONT ("Family Name 14", the size in points optional), else the first of JetBrains Mono
//! (the page's font), its Nerd Font build, DejaVu Sans Mono and Liberation Mono found, else the system's
//! monospace. Cells are the family's advance wide and EDWIN_LINE_HEIGHT (1.5, the page's) times the size high.

use cosmic_text::{
    Attrs, Buffer, CacheKey, Family, FontSystem, Metrics, Shaping, Style, SwashCache, SwashContent,
    Weight,
};
use std::collections::HashMap;

pub const BOLD: u8 = 1;
pub const ITALIC: u8 = 2;
pub const MEDIUM: u8 = 4;

/// A glyph of a character, placed relative to its cell's top left corner (before the raster's own offset).
#[derive(Clone, Copy)]
pub struct Glyph {
    pub key: CacheKey,
    pub x: i32,
    pub y: i32,
}

/// A glyph's pixels: RGBA, white with coverage in alpha for an outline, the colours for an emoji.
pub struct Raster {
    pub left: i32,
    pub top: i32,
    pub w: u32,
    pub h: u32,
    pub color: bool,
    pub rgba: Vec<u8>,
}

pub struct Text {
    fs: FontSystem,
    swash: SwashCache,
    family: Option<String>,
    pub px: f32,
    pub cell_w: u32,
    pub cell_h: u32,
    /// The baseline's distance from the top of a cell.
    pub baseline: f32,
    shaped: HashMap<(String, u8), Vec<Glyph>>,
}

const PREFERRED: &[&str] = &[
    "JetBrains Mono",
    "JetBrainsMono Nerd Font Mono",
    "JetBrainsMono Nerd Font",
    "DejaVu Sans Mono",
    "Liberation Mono",
];

/// EDWIN_FONT as (family, points): "Iosevka 13" or "Iosevka" or "13".
pub fn font_setting() -> (Option<String>, Option<f32>) {
    let Ok(v) = std::env::var("EDWIN_FONT") else {
        return (None, None);
    };
    let v = v.trim();
    match v.rsplit_once(' ') {
        Some((fam, n)) if n.parse::<f32>().is_ok() => {
            (Some(fam.trim().to_string()), n.parse().ok())
        }
        _ if v.parse::<f32>().is_ok() => (None, v.parse().ok()),
        _ if v.is_empty() => (None, None),
        _ => (Some(v.to_string()), None),
    }
}

impl Text {
    /// Fonts at PX pixels: the family asked for (or the first preferred one installed).
    pub fn new(wanted: Option<&str>, px: f32) -> Text {
        let fs = FontSystem::new();
        let has = |name: &str| {
            fs.db()
                .faces()
                .any(|f| f.families.iter().any(|(n, _)| n.eq_ignore_ascii_case(name)))
        };
        let family = wanted
            .filter(|w| has(w))
            .map(str::to_string)
            .or_else(|| PREFERRED.iter().find(|n| has(n)).map(|n| n.to_string()));
        let mut t = Text {
            fs,
            swash: SwashCache::new(),
            family,
            px,
            cell_w: 1,
            cell_h: 1,
            baseline: 0.0,
            shaped: HashMap::new(),
        };
        t.measure();
        t
    }

    pub fn family(&self) -> &str {
        self.family.as_deref().unwrap_or("monospace")
    }

    fn line_height(&self) -> f32 {
        let ratio = std::env::var("EDWIN_LINE_HEIGHT")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .filter(|r| (0.8..=4.0).contains(r))
            .unwrap_or(1.5);
        (self.px * ratio).round().max(1.0)
    }

    fn buffer(&mut self, s: &str, style: u8) -> Buffer {
        let lh = self.line_height();
        let mut buf = Buffer::new(&mut self.fs, Metrics::new(self.px, lh));
        let family = match &self.family {
            Some(n) => Family::Name(n),
            None => Family::Monospace,
        };
        let attrs = Attrs::new()
            .family(family)
            .weight(if style & BOLD != 0 {
                Weight::BOLD
            } else if style & MEDIUM != 0 {
                Weight::MEDIUM
            } else {
                Weight::NORMAL
            })
            .style(if style & ITALIC != 0 {
                Style::Italic
            } else {
                Style::Normal
            });
        {
            let mut b = buf.borrow_with(&mut self.fs);
            b.set_size(None, None);
            b.set_text(s, &attrs, Shaping::Advanced, None);
            b.shape_until_scroll(true);
        }
        buf
    }

    /// The cell's size and baseline, from the family's "M".
    fn measure(&mut self) {
        let buf = self.buffer("M", 0);
        let lh = self.line_height();
        let (mut w, mut base) = (self.px * 0.6, self.px);
        if let Some(run) = buf.layout_runs().next() {
            base = run.line_y;
            if let Some(g) = run.glyphs.first() {
                w = g.w;
            }
        }
        self.cell_w = w.round().max(1.0) as u32;
        self.cell_h = lh as u32;
        self.baseline = base;
    }

    /// The glyphs of one character (with its combining marks) in STYLE.
    pub fn shape(&mut self, s: &str, style: u8) -> &[Glyph] {
        let k = (s.to_string(), style);
        if !self.shaped.contains_key(&k) {
            let buf = self.buffer(s, style);
            let mut out = Vec::new();
            for run in buf.layout_runs() {
                for g in run.glyphs.iter() {
                    let p = g.physical((0.0, run.line_y), 1.0);
                    out.push(Glyph {
                        key: p.cache_key,
                        x: p.x,
                        y: p.y,
                    });
                }
            }
            self.shaped.insert(k.clone(), out);
        }
        &self.shaped[&k]
    }

    /// A glyph's pixels, or None for one with no ink (a space).
    pub fn raster(&mut self, key: CacheKey) -> Option<Raster> {
        let img = self.swash.get_image(&mut self.fs, key).as_ref()?;
        let (w, h) = (img.placement.width, img.placement.height);
        if w == 0 || h == 0 {
            return None;
        }
        let n = (w * h) as usize;
        let (color, rgba) = match img.content {
            SwashContent::Mask => {
                let mut v = Vec::with_capacity(n * 4);
                for &a in img.data.iter().take(n) {
                    v.extend_from_slice(&[255, 255, 255, a]);
                }
                (false, v)
            }
            SwashContent::SubpixelMask => {
                let mut v = Vec::with_capacity(n * 4);
                for px in img.data.chunks(4).take(n) {
                    let a = ((px[0] as u32 + px[1] as u32 + px[2] as u32) / 3) as u8;
                    v.extend_from_slice(&[255, 255, 255, a]);
                }
                (false, v)
            }
            SwashContent::Color => (true, img.data.clone()),
        };
        Some(Raster {
            left: img.placement.left,
            top: img.placement.top,
            w,
            h,
            color,
            rgba,
        })
    }
}
