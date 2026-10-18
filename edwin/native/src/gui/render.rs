//! Drawing a model with wgpu: one pipeline, one instanced quad per background run, glyph, line or cursor, in the
//! order they stack; glyphs come from an atlas texture filled as characters first appear.

use super::model::{self, cells, Model, Rgba};
use super::text::{self, Text};
use cosmic_text::CacheKey;
use std::collections::HashMap;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Inst {
    pos: [f32; 2],
    size: [f32; 2],
    uv: [f32; 4],
    color: [f32; 4],
    kind: u32,
    _pad: [u32; 3],
}

const RECT: u32 = 0;
const MASK: u32 = 1;
const COLOR: u32 = 2;

const SHADER: &str = r#"
struct Globals { screen: vec2<f32>, atlas: vec2<f32> };
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct In {
  @builtin(vertex_index) vi: u32,
  @location(0) pos: vec2<f32>, @location(1) size: vec2<f32>, @location(2) uv: vec4<f32>,
  @location(3) color: vec4<f32>, @location(4) kind: u32,
};
struct Out {
  @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec4<f32>,
  @location(2) @interpolate(flat) kind: u32,
};
@vertex fn vs(i: In) -> Out {
  let corner = vec2<f32>(f32(i.vi & 1u), f32(i.vi >> 1u));
  let px = i.pos + corner * i.size;
  var o: Out;
  o.p = vec4<f32>(px.x / g.screen.x * 2.0 - 1.0, 1.0 - px.y / g.screen.y * 2.0, 0.0, 1.0);
  o.uv = (i.uv.xy + corner * i.uv.zw) / g.atlas;
  o.color = i.color;
  o.kind = i.kind;
  return o;
}
@fragment fn fs(o: Out) -> @location(0) vec4<f32> {
  if (o.kind == 0u) { return o.color; }
  let t = textureSampleLevel(tex, samp, o.uv, 0.0);
  if (o.kind == 1u) { return vec4<f32>(o.color.rgb, o.color.a * t.a); }
  return t;
}
"#;

const ATLAS: u32 = 2048;

#[derive(Clone, Copy)]
struct Entry {
    u: u32,
    v: u32,
    w: u32,
    h: u32,
    left: i32,
    top: i32,
    color: bool,
}

#[derive(Default)]
struct Atlas {
    map: HashMap<CacheKey, Option<Entry>>,
    x: u32,
    y: u32,
    row: u32,
}

struct Full;

pub struct Renderer {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bind: wgpu::BindGroup,
    globals: wgpu::Buffer,
    atlas_tex: wgpu::Texture,
    atlas: Atlas,
    insts: wgpu::Buffer,
    cap: u64,
    /// The target stores linear colours (an sRGB format): the model's sRGB colours are converted.
    linear: bool,
    /// Extra things to draw over the model: the input method's text being composed at the cursor.
    pub preedit: String,
}

fn to_linear(c: Rgba) -> Rgba {
    let f = |v: f32| {
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    [f(c[0]), f(c[1]), f(c[2]), c[3]]
}

impl Renderer {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat) -> Renderer {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("edwin"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let atlas_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("atlas"),
            size: wgpu::Extent3d {
                width: ATLAS,
                height: ATLAS,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("atlas"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("edwin"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let view = atlas_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("edwin"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: globals.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("edwin"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let attrs = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32x4, 4 => Uint32];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("edwin"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Inst>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &attrs,
                })],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let cap = 4096;
        let insts = Self::inst_buffer(&device, cap);
        Renderer {
            device,
            queue,
            pipeline,
            bind,
            globals,
            atlas_tex,
            atlas: Atlas::default(),
            insts,
            cap,
            linear: format.is_srgb(),
            preedit: String::new(),
        }
    }

    fn inst_buffer(device: &wgpu::Device, n: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("instances"),
            size: n * std::mem::size_of::<Inst>() as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    /// The atlas entry of a glyph, rasterized and uploaded the first time; None for one with no ink.
    fn glyph(&mut self, text: &mut Text, key: CacheKey) -> Result<Option<Entry>, Full> {
        if let Some(e) = self.atlas.map.get(&key) {
            return Ok(*e);
        }
        let Some(r) = text.raster(key) else {
            self.atlas.map.insert(key, None);
            return Ok(None);
        };
        let a = &mut self.atlas;
        if r.w + 1 > ATLAS || r.h + 1 > ATLAS {
            a.map.insert(key, None);
            return Ok(None);
        }
        if a.x + r.w + 1 > ATLAS {
            a.x = 0;
            a.y += a.row + 1;
            a.row = 0;
        }
        if a.y + r.h + 1 > ATLAS {
            return Err(Full);
        }
        let e = Entry {
            u: a.x,
            v: a.y,
            w: r.w,
            h: r.h,
            left: r.left,
            top: r.top,
            color: r.color,
        };
        a.x += r.w + 1;
        a.row = a.row.max(r.h);
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas_tex,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: e.u,
                    y: e.v,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            &r.rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * r.w),
                rows_per_image: Some(r.h),
            },
            wgpu::Extent3d {
                width: r.w,
                height: r.h,
                depth_or_array_layers: 1,
            },
        );
        self.atlas.map.insert(key, Some(e));
        Ok(Some(e))
    }

    fn col(&self, c: Rgba) -> [f32; 4] {
        if self.linear {
            to_linear(c)
        } else {
            c
        }
    }

    /// The background colour of the model (its default face), as the clear colour.
    pub fn background(m: &Model) -> Rgba {
        m.faces
            .first()
            .and_then(|f| model::color(f.bg.as_deref()))
            .unwrap_or(if m.theme == "light" {
                [0.984, 0.969, 0.941, 1.0]
            } else {
                [0.051, 0.055, 0.110, 1.0]
            })
    }

    /// The instances that draw M in cells of TEXT, PAD pixels in from the edges.
    fn scene(
        &mut self,
        m: &Model,
        text: &mut Text,
        pad: f32,
        scale: f32,
    ) -> Result<Vec<Inst>, Full> {
        let (cw, ch) = (text.cell_w as f32, text.cell_h as f32);
        let line = scale.round().max(1.0);
        let def = m.faces.first().cloned().unwrap_or_default();
        let def_fg = model::color(def.fg.as_deref()).unwrap_or([0.5, 0.5, 0.5, 1.0]);
        let def_bg = Self::background(m);
        let at = |x: f32, y: f32| (pad + x * cw, pad + y * ch);
        let rect = |r: &Self, x: f32, y: f32, w: f32, h: f32, c: Rgba| Inst {
            pos: [x, y],
            size: [w, h],
            uv: [0.0; 4],
            color: r.col(c),
            kind: RECT,
            _pad: [0; 3],
        };
        let (mut under, mut glyphs, mut over, mut top) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let cursor = m.cursor.as_ref();
        let focused = m.focused;
        let cur_color = cursor
            .and_then(|c| model::color(c.color.as_deref()))
            .unwrap_or(def_fg);
        let shape = match cursor {
            Some(_) if !focused => "hollow",
            Some(c) => c.shape.as_str(),
            None => "",
        };
        let on_cursor =
            |x: u32, y: usize| cursor.is_some_and(|c| c.x == x as i32 && c.y == y as i32);
        let mut cursor_w = 1u32;
        for (y, row) in m.lines.iter().enumerate() {
            for seg in row {
                let face = m.faces.get(seg.f).cloned().unwrap_or_else(|| def.clone());
                let fg = model::color(face.fg.as_deref()).unwrap_or(def_fg);
                let bg = model::color(face.bg.as_deref()).unwrap_or(def_bg);
                let (sx, sy) = at(seg.x as f32, y as f32);
                if bg != def_bg {
                    under.push(rect(self, sx, sy, seg.w as f32 * cw, ch, bg));
                }
                let w = face.weight.unwrap_or(400.0);
                let style = if face.bold || w >= 600.0 {
                    text::BOLD
                } else if w >= 500.0 {
                    text::MEDIUM
                } else {
                    0
                } | if face.italic { text::ITALIC } else { 0 };
                for (dx, s, cells_w) in cells(seg) {
                    let x = seg.x + dx;
                    let mut color = fg;
                    if on_cursor(x, y) {
                        cursor_w = cells_w;
                        if shape == "box" {
                            color = cursor
                                .and_then(|c| model::color(c.fg.as_deref()))
                                .unwrap_or(def_bg);
                        }
                    }
                    if s.trim().is_empty() {
                        continue;
                    }
                    let (gx, gy) = at(x as f32, y as f32);
                    let placed: Vec<text::Glyph> = text.shape(&s, style).to_vec();
                    for g in placed {
                        if let Some(e) = self.glyph(text, g.key)? {
                            glyphs.push(Inst {
                                pos: [gx + (g.x + e.left) as f32, gy + (g.y - e.top) as f32],
                                size: [e.w as f32, e.h as f32],
                                uv: [e.u as f32, e.v as f32, e.w as f32, e.h as f32],
                                color: self.col(color),
                                kind: if e.color { COLOR } else { MASK },
                                _pad: [0; 3],
                            });
                        }
                    }
                }
                let sw = seg.w as f32 * cw;
                if face.underline {
                    over.push(rect(self, sx, sy + text.baseline + line, sw, line, fg));
                }
                if face.strike {
                    over.push(rect(self, sx, sy + ch / 2.0, sw, line, fg));
                }
                if face.boxed {
                    outline(
                        &mut over,
                        |x, y, w, h| rect(self, x, y, w, h, fg),
                        sx,
                        sy,
                        sw,
                        ch,
                        line,
                    );
                }
            }
        }
        if let Some(c) = cursor {
            let (x, y) = at(c.x as f32, c.y as f32);
            let w = cursor_w as f32 * cw;
            let bar = (2.0 * scale).round().max(1.0);
            match shape {
                "box" => under.push(rect(self, x, y, w, ch, cur_color)),
                "bar" => over.push(rect(self, x, y, bar, ch, cur_color)),
                "hbar" => over.push(rect(self, x, y + ch - bar, w, bar, cur_color)),
                "half" => under.push(rect(self, x, y + ch / 2.0, w, ch / 2.0, cur_color)),
                _ => outline(
                    &mut over,
                    |a, b, cw2, ch2| rect(self, a, b, cw2, ch2, cur_color),
                    x,
                    y,
                    w,
                    ch,
                    line,
                ),
            }
        }
        for g in &m.ghosts {
            let (x, y) = at(g.x as f32, g.y as f32);
            let c = [def_fg[0], def_fg[1], def_fg[2], 0.5];
            outline(
                &mut over,
                |a, b, w, h| rect(self, a, b, w, h, c),
                x,
                y,
                cw,
                ch,
                line,
            );
        }
        let mut top_glyphs = Vec::new();
        for p in &m.presence {
            let c = model::color(p.color.as_deref()).unwrap_or(def_fg);
            let (x, y) = at(p.x as f32, p.y as f32);
            over.push(rect(self, x, y, (2.0 * scale).round().max(1.0), ch, c));
            if !p.label.is_empty() {
                // The writer's name in a tag above the line (below it on the first row).
                let ly = if p.y > 0 { p.y - 1 } else { p.y + 1 };
                let label: Vec<char> = p.label.chars().take(24).collect();
                let (lx, lyp) = at(p.x as f32, ly as f32);
                top.push(rect(self, lx, lyp, label.len() as f32 * cw, ch, c));
                for (i, chr) in label.iter().enumerate() {
                    let s = chr.to_string();
                    let placed: Vec<text::Glyph> = text.shape(&s, text::MEDIUM).to_vec();
                    for g in placed {
                        if let Some(e) = self.glyph(text, g.key)? {
                            top_glyphs.push(Inst {
                                pos: [
                                    lx + i as f32 * cw + (g.x + e.left) as f32,
                                    lyp + (g.y - e.top) as f32,
                                ],
                                size: [e.w as f32, e.h as f32],
                                uv: [e.u as f32, e.v as f32, e.w as f32, e.h as f32],
                                color: self.col([1.0, 1.0, 1.0, 1.0]),
                                kind: if e.color { COLOR } else { MASK },
                                _pad: [0; 3],
                            });
                        }
                    }
                }
            }
        }
        if let (Some(c), false) = (cursor, self.preedit.is_empty()) {
            // The input method's composition, at the cursor, underlined.
            let pre = self.preedit.clone();
            let chars: Vec<char> = pre.chars().collect();
            let n: u32 = chars.iter().map(|&c| preedit_width(c)).sum();
            let (x, y) = at(c.x as f32, c.y as f32);
            top.push(rect(self, x, y, n as f32 * cw, ch, def_bg));
            top.push(rect(
                self,
                x,
                y + text.baseline + line,
                n as f32 * cw,
                line,
                def_fg,
            ));
            let mut dx = 0.0;
            for chr in chars {
                let placed: Vec<text::Glyph> = text.shape(&chr.to_string(), 0).to_vec();
                for g in placed {
                    if let Some(e) = self.glyph(text, g.key)? {
                        top_glyphs.push(Inst {
                            pos: [x + dx + (g.x + e.left) as f32, y + (g.y - e.top) as f32],
                            size: [e.w as f32, e.h as f32],
                            uv: [e.u as f32, e.v as f32, e.w as f32, e.h as f32],
                            color: self.col(def_fg),
                            kind: if e.color { COLOR } else { MASK },
                            _pad: [0; 3],
                        });
                    }
                }
                dx += preedit_width(chr) as f32 * cw;
            }
        }
        let mut all = under;
        all.append(&mut glyphs);
        all.append(&mut over);
        all.append(&mut top);
        all.append(&mut top_glyphs);
        Ok(all)
    }

    /// Draws M into TARGET, (W, H) pixels.
    pub fn draw(
        &mut self,
        m: &Model,
        text: &mut Text,
        target: &wgpu::TextureView,
        (w, h): (u32, u32),
        pad: f32,
        scale: f32,
    ) {
        let insts = match self.scene(m, text, pad, scale) {
            Ok(v) => v,
            Err(Full) => {
                // The atlas is full: start it again with this frame's glyphs only.
                self.atlas = Atlas::default();
                self.scene(m, text, pad, scale).unwrap_or_default()
            }
        };
        let n = insts.len() as u64;
        if n > self.cap {
            self.cap = n.next_power_of_two();
            self.insts = Self::inst_buffer(&self.device, self.cap);
        }
        if n > 0 {
            self.queue
                .write_buffer(&self.insts, 0, bytemuck::cast_slice(&insts));
        }
        let g: [f32; 4] = [w as f32, h as f32, ATLAS as f32, ATLAS as f32];
        self.queue
            .write_buffer(&self.globals, 0, bytemuck::cast_slice(&g));
        let bg = self.col(Self::background(m));
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("frame"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: bg[0] as f64,
                            g: bg[1] as f64,
                            b: bg[2] as f64,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if n > 0 {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.bind, &[]);
                pass.set_vertex_buffer(
                    0,
                    self.insts.slice(..n * std::mem::size_of::<Inst>() as u64),
                );
                pass.draw(0..4, 0..n as u32);
            }
        }
        self.queue.submit([enc.finish()]);
    }
}

/// Four lines of thickness T around the rectangle X, Y, W, H.
fn outline(
    out: &mut Vec<Inst>,
    mut rect: impl FnMut(f32, f32, f32, f32) -> Inst,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    t: f32,
) {
    out.push(rect(x, y, w, t));
    out.push(rect(x, y + h - t, w, t));
    out.push(rect(x, y, t, h));
    out.push(rect(x + w - t, y, t, h));
}

/// A device for drawing (to SURFACE when given), the adapter it runs on described for the log.
pub async fn device(
    instance: &wgpu::Instance,
    surface: Option<&wgpu::Surface<'_>>,
) -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue), String> {
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            force_fallback_adapter: false,
            compatible_surface: surface,
            apply_limit_buckets: false,
        })
        .await
        .map_err(|e| format!("no graphics adapter: {e}"))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("edwin"),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("no graphics device: {e}"))?;
    Ok((adapter, device, queue))
}

/// Draws M offscreen at W x H and returns the pixels (RGBA, rows top to bottom): for tests.
#[cfg(test)]
pub fn render_rgba(m: &Model, text: &mut Text, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let (_a, device, queue) = pollster::block_on(device(&instance, None))?;
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let mut r = Renderer::new(device, queue, format);
    let tex = r.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&Default::default());
    r.draw(m, text, &view, (w, h), 0.0, 1.0);
    let row = (4 * w).div_ceil(256) * 256;
    let buf = r.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: (row * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = r.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buf,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    r.queue.submit([enc.finish()]);
    let slice = buf.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    r.device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| e.to_string())?;
    let data = slice.get_mapped_range().map_err(|e| format!("{e:?}"))?;
    let mut out = Vec::with_capacity((4 * w * h) as usize);
    for y in 0..h {
        let s = (y * row) as usize;
        out.extend_from_slice(&data[s..s + (4 * w) as usize]);
    }
    Ok(out)
}

/// The cells a character of an input method's composition takes (it is not in the model, so display.ts has not
/// counted it): Unicode's East Asian width, at least one.
fn preedit_width(c: char) -> u32 {
    unicode_width::UnicodeWidthChar::width(c)
        .unwrap_or(1)
        .max(1) as u32
}
