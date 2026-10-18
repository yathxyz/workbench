//! The window (DT2): Edwin's model frame drawn with wgpu in a winit window, the counterpart of the terminal.
//!
//! JS draws as in the terminal, a model per redisplay (src/display.ts), handed over with __n.guiDraw; this module
//! draws the last one after each turn of JS. Input goes the other way, as events JS gives the core's own key
//! naming (Ed.keyName, the page's), so a key means in the window what it means on the page.
//!
//! The loop is main.rs's: winit's events are pumped (EventLoopExtPumpEvents) between turns of JS, and a helper
//! thread waits on the signal pipe and edwind's sockets so that either wakes the pump.

mod model;
mod render;
mod text;

use crate::bridge;
use model::Model;
use render::Renderer;
use serde_json::json;
use std::cell::RefCell;
use std::os::fd::RawFd;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use text::Text;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey, PhysicalKey};
use winit::platform::modifier_supplement::KeyEventExtModifierSupplement;
use winit::platform::pump_events::{EventLoopExtPumpEvents, PumpStatus};
use winit::window::{Theme, Window, WindowId};

/// Points to pixels at a scale of 1 (CSS's 96 per inch); 10.5 points is the page's 14 pixels.
const DEFAULT_POINTS: f32 = 10.5;
/// The window's first size, in cells.

#[derive(Debug)]
struct Wake;

struct Gfx {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
}

struct App {
    gfx: Option<Gfx>,
    error: Option<String>,
    instance: Option<wgpu::Instance>,
    text: Option<Text>,
    family: Option<String>,
    points: f32,
    /// The first size in cells (--geometry, else 100x36).
    start: (u32, u32),
    scale: f64,
    pad: f32,
    events: Vec<String>,
    model: Option<Model>,
    title: String,
    theme: String,
    mods: ModifiersState,
    mouse: Option<(i32, i32)>,
    buttons: u32,
    exit: bool,
    /// When the oldest key not yet drawn arrived (for the latency log).
    key_at: Option<Instant>,
}

impl App {
    fn cells(&self, size: PhysicalSize<u32>) -> (u32, u32) {
        let t = self.text.as_ref().unwrap();
        let w = (size.width as f32 - 2.0 * self.pad).max(0.0);
        let h = (size.height as f32 - 2.0 * self.pad).max(0.0);
        (
            ((w / t.cell_w as f32) as u32).max(1),
            ((h / t.cell_h as f32) as u32).max(1),
        )
    }

    fn set_size(&mut self, size: PhysicalSize<u32>) {
        let (cols, rows) = self.cells(size);
        bridge::with(|b| {
            b.cols = cols;
            b.rows = rows;
        });
        if let Some(g) = self.gfx.as_mut() {
            g.config.width = size.width.max(1);
            g.config.height = size.height.max(1);
            g.surface.configure(&g.renderer.device, &g.config);
        }
    }

    fn fonts(&mut self) {
        let px = self.points * 4.0 / 3.0 * self.scale as f32;
        self.text = Some(Text::new(self.family.as_deref(), px.round()));
        self.pad = (2.0 * self.scale as f32).round();
    }

    fn open(&mut self, el: &ActiveEventLoop) -> Result<(), String> {
        // The first size from fonts at a scale of 1; the window's own scale is known once it exists.
        self.scale = 1.0;
        self.fonts();
        let t = self.text.as_ref().unwrap();
        if t.empty {
            return Err("no fonts (fontconfig lists none)".into());
        }
        let logical = LogicalSize::new(
            self.start.0 * t.cell_w + 2 * self.pad as u32,
            self.start.1 * t.cell_h + 2 * self.pad as u32,
        );
        let attrs = Window::default_attributes()
            .with_title("Edwin")
            .with_inner_size(logical)
            .with_min_inner_size(LogicalSize::new(200, 100));
        let window = Arc::new(el.create_window(attrs).map_err(|e| e.to_string())?);
        window.set_ime_allowed(true);
        self.scale = window.scale_factor();
        if (self.scale - 1.0).abs() > f64::EPSILON {
            self.fonts();
        }
        let instance =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_with_display_handle_from_env(
                Box::new(el.owned_display_handle()),
            ));
        let surface = instance
            .create_surface(window.clone())
            .map_err(|e| format!("cannot draw in the window: {e}"))?;
        let (adapter, device, queue) =
            pollster::block_on(render::device(&instance, Some(&surface)))?;
        let caps = surface.get_capabilities(&adapter);
        // A format that keeps colours as they are (sRGB values blended as the browser blends them).
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or("the window offers no format to draw in")?;
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
        } else {
            wgpu::PresentMode::Fifo
        };
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode,
            desired_maximum_frame_latency: 1,
            alpha_mode: caps
                .alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto),
            view_formats: vec![],
        };
        surface.configure(&device, &config);
        trace(&format!(
            "window: {} ({:?}), {format:?}, {present_mode:?}, font {} {}px, cell {}x{}, scale {}",
            adapter.get_info().name,
            adapter.get_info().backend,
            self.text.as_ref().unwrap().family(),
            self.text.as_ref().unwrap().px,
            self.text.as_ref().unwrap().cell_w,
            self.text.as_ref().unwrap().cell_h,
            self.scale
        ));
        self.instance = Some(instance);
        self.gfx = Some(Gfx {
            window,
            surface,
            config,
            renderer: Renderer::new(device, queue, format),
        });
        self.set_size(size);
        let theme = self.gfx.as_ref().unwrap().window.theme().map(|t| match t {
            Theme::Dark => "dark".to_string(),
            Theme::Light => "light".to_string(),
        });
        bridge::with(|b| {
            b.open = true;
            b.theme = theme;
        });
        Ok(())
    }

    fn push(&mut self, ev: serde_json::Value) {
        self.events.push(ev.to_string());
    }

    fn cell_at(&self, p: PhysicalPosition<f64>) -> (i32, i32) {
        let t = self.text.as_ref().unwrap();
        (
            ((p.x as f32 - self.pad) / t.cell_w as f32).floor() as i32,
            ((p.y as f32 - self.pad) / t.cell_h as f32).floor() as i32,
        )
    }

    fn key(&mut self, ev: &KeyEvent) {
        if ev.state != ElementState::Pressed {
            return;
        }
        let m = self.mods;
        let key = match &ev.logical_key {
            Key::Named(NamedKey::Space) => " ".to_string(),
            Key::Named(n) => format!("{n:?}"),
            Key::Character(s) => s.to_string(),
            Key::Dead(_) => "Dead".to_string(),
            Key::Unidentified(_) => "Unidentified".to_string(),
        };
        // Keys an input method takes never come here (X11 filters them, Wayland's compositor keeps them) and its
        // text comes as Ime::Commit; while it composes, a key that still comes belongs to the composition.
        let composing = self
            .gfx
            .as_ref()
            .is_some_and(|g| !g.renderer.preedit.is_empty());
        if composing && !m.control_key() && !m.alt_key() {
            return;
        }
        let code = match ev.physical_key {
            PhysicalKey::Code(c) => format!("{c:?}"),
            PhysicalKey::Unidentified(_) => String::new(),
        };
        if m.control_key() && m.shift_key() && code == "KeyV" {
            // Paste from the system clipboard, as a page does on C-S-v.
            if let Some(text) = bridge::clipboard_text() {
                self.push(json!({"type": "paste", "text": text}));
            }
            return;
        }
        // AltGr on Windows-style layouts reports Control and Alt with the character they make (AltGr+Q is @ on a
        // German layout): a character other than the key's own is typed, as the page's AltGraph does. With Shift
        // held the key's own character cannot be told from the shifted one, so it stays a C-M- key.
        let alt_graph = m.control_key()
            && m.alt_key()
            && !m.shift_key()
            && match (&ev.logical_key, ev.key_without_modifiers()) {
                (Key::Character(s), Key::Character(own)) => s.to_lowercase() != own.to_lowercase(),
                _ => false,
            };
        self.key_at.get_or_insert_with(Instant::now);
        self.push(json!({
            "type": "key", "key": key, "code": code, "repeat": ev.repeat,
            "ctrlKey": m.control_key(), "altKey": m.alt_key(), "shiftKey": m.shift_key(), "metaKey": m.super_key(),
            "altGraph": alt_graph,
        }));
    }

    fn mouse_event(&mut self, action: &str, button: u32) {
        let Some((x, y)) = self.mouse else { return };
        let m = self.mods;
        self.push(json!({
            "type": "mouse", "action": action, "x": x, "y": y, "button": button,
            "shift": m.shift_key(), "ctrl": m.control_key(), "meta": m.alt_key(),
        }));
    }

    /// Draws the model JS gave last (or the one already drawn, after a resize), then the actions JS asked for.
    fn present(&mut self) {
        let (json, actions) = bridge::with(|b| (b.model.take(), std::mem::take(&mut b.actions)));
        let fresh = json.is_some();
        if let Some(j) = json {
            match serde_json::from_str::<Model>(&j) {
                Ok(m) => self.model = Some(m),
                Err(e) => trace(&format!("bad model: {e}")),
            }
        }
        for (name, arg) in actions {
            self.action(&name, &arg);
        }
        if fresh {
            self.draw();
        }
    }

    fn action(&mut self, name: &str, arg: &str) {
        let Some(g) = self.gfx.as_ref() else { return };
        match name {
            "bell" => {
                if !g.window.has_focus() {
                    g.window.request_user_attention(Some(
                        winit::window::UserAttentionType::Informational,
                    ));
                }
            }
            "iconify" => g.window.set_minimized(true),
            "raise" => g.window.focus_window(),
            "clipboard" => CLIPBOARD.with(|c| {
                if let Some(cb) = c.borrow().as_ref() {
                    let _ = cb.borrow_mut().set_text(arg.to_string());
                }
            }),
            _ => trace(&format!("unknown window action {name}")),
        }
    }

    fn draw(&mut self) {
        let (Some(g), Some(text), Some(m)) =
            (self.gfx.as_mut(), self.text.as_mut(), self.model.as_ref())
        else {
            return;
        };
        if let Some(t) = &m.title {
            if *t != self.title {
                g.window.set_title(&format!("{t} - Edwin"));
                self.title = t.clone();
            }
        }
        if m.theme != self.theme {
            g.window.set_theme(Some(if m.theme == "light" {
                Theme::Light
            } else {
                Theme::Dark
            }));
            self.theme = m.theme.clone();
        }
        if let Some(c) = &m.cursor {
            let (cw, ch) = (text.cell_w as f32, text.cell_h as f32);
            g.window.set_ime_cursor_area(
                PhysicalPosition::new(self.pad + c.x as f32 * cw, self.pad + c.y as f32 * ch),
                PhysicalSize::new(cw, ch),
            );
        }
        let frame = match g.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                g.surface.configure(&g.renderer.device, &g.config);
                return;
            }
            _ => return,
        };
        let view = frame.texture.create_view(&Default::default());
        g.renderer.draw(
            m,
            text,
            &view,
            (g.config.width, g.config.height),
            self.pad,
            self.scale as f32,
        );
        g.window.pre_present_notify();
        g.renderer.queue.present(frame);
        if let Some(t0) = self.key_at.take() {
            latency(t0.elapsed());
        }
    }
}

impl ApplicationHandler<Wake> for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.gfx.is_none() && self.error.is_none() {
            if let Err(e) = self.open(el) {
                self.error = Some(e);
            }
        }
    }

    fn user_event(&mut self, _el: &ActiveEventLoop, _ev: Wake) {}

    fn window_event(&mut self, _el: &ActiveEventLoop, _id: WindowId, ev: WindowEvent) {
        match ev {
            WindowEvent::CloseRequested => self.push(json!({"type": "close"})),
            WindowEvent::Destroyed => self.exit = true,
            WindowEvent::Resized(size) => {
                self.set_size(size);
                self.push(json!({"type": "resize"}));
                self.draw();
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.scale = scale_factor;
                self.fonts();
                if let Some(g) = self.gfx.as_ref() {
                    let size = g.window.inner_size();
                    self.set_size(size);
                }
                self.push(json!({"type": "resize"}));
            }
            WindowEvent::Focused(f) => self.push(json!({"type": "focus", "focused": f})),
            WindowEvent::ModifiersChanged(m) => self.mods = m.state(),
            WindowEvent::KeyboardInput { event, .. } => self.key(&event),
            WindowEvent::Ime(ime) => match ime {
                Ime::Enabled | Ime::Disabled => {}
                Ime::Preedit(s, _) => {
                    if let Some(g) = self.gfx.as_mut() {
                        g.renderer.preedit = s;
                    }
                    self.draw();
                }
                Ime::Commit(s) => {
                    if let Some(g) = self.gfx.as_mut() {
                        g.renderer.preedit.clear();
                    }
                    self.key_at.get_or_insert_with(Instant::now);
                    self.push(json!({"type": "text", "text": s}));
                }
            },
            WindowEvent::CursorMoved { position, .. } => {
                let c = self.cell_at(position);
                let moved = self.mouse != Some(c);
                self.mouse = Some(c);
                if moved && self.buttons & 1 != 0 {
                    self.mouse_event("drag", 0);
                }
            }
            WindowEvent::CursorLeft { .. } => {}
            WindowEvent::MouseInput { state, button, .. } => {
                let b = match button {
                    MouseButton::Left => 0,
                    MouseButton::Middle => 1,
                    MouseButton::Right => 2,
                    _ => return,
                };
                if state == ElementState::Pressed {
                    self.buttons |= 1 << b;
                    self.mouse_event("down", b);
                } else {
                    self.buttons &= !(1 << b);
                    self.mouse_event("up", b);
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let lines = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => {
                        p.y as f32 / self.text.as_ref().map(|t| t.cell_h as f32).unwrap_or(16.0)
                    }
                };
                let notches = lines.round() as i32;
                for _ in 0..notches.unsigned_abs().min(10) {
                    let Some((x, y)) = self.mouse else { break };
                    self.push(
                        json!({"type": "mouse", "action": "wheel", "x": x, "y": y, "button": 0,
                                     "dy": if notches > 0 { -1 } else { 1 }}),
                    );
                }
            }
            WindowEvent::DroppedFile(path) => {
                self.push(json!({"type": "drop", "path": path.to_string_lossy()}));
            }
            WindowEvent::RedrawRequested => self.draw(),
            _ => {}
        }
    }
}

thread_local! {
    static CLIPBOARD: RefCell<Option<Rc<RefCell<arboard::Clipboard>>>> = const { RefCell::new(None) };
}

/// EDWIN_TRACE's log line (stderr is the terminal's no longer; the trace goes to the log file JS keeps).
fn trace(s: &str) {
    if std::env::var_os("EDWIN_TRACE").is_some() {
        eprintln!("edwin: {s}");
    }
}

/// Each key's time from arriving to being on the screen, appended to EDWIN_GUI_LATENCY_LOG (microseconds).
fn latency(d: Duration) {
    if let Some(p) = std::env::var_os("EDWIN_GUI_LATENCY_LOG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            let _ = writeln!(f, "{}", d.as_micros());
        }
    }
}

/// Wakes the pump when the signal pipe or a socket has something: a thread that polls the descriptors it is
/// handed (arm) until main.rs takes them back (disarm), so the two never read the same descriptor at once.
struct Waker {
    arm: mpsc::Sender<Vec<(RawFd, i16)>>,
    done: mpsc::Receiver<()>,
    ctl: [RawFd; 2],
}

impl Waker {
    fn start(proxy: EventLoopProxy<Wake>) -> Waker {
        let mut ctl = [-1; 2];
        // SAFETY: pipe(2) fills the two descriptors.
        unsafe { libc::pipe(ctl.as_mut_ptr()) };
        let (arm, rx) = mpsc::channel::<Vec<(RawFd, i16)>>();
        let (tx_done, done) = mpsc::channel();
        let ctl_r = ctl[0];
        std::thread::Builder::new()
            .name("edwin-wake".into())
            .spawn(move || {
                while let Ok(fds) = rx.recv() {
                    let mut p: Vec<libc::pollfd> = fds
                        .iter()
                        .chain(std::iter::once(&(ctl_r, libc::POLLIN)))
                        .map(|&(fd, events)| libc::pollfd {
                            fd,
                            events,
                            revents: 0,
                        })
                        .collect();
                    // SAFETY: p is a valid pollfd array for the call.
                    let n = unsafe { libc::poll(p.as_mut_ptr(), p.len() as libc::nfds_t, -1) };
                    let ctl_ready = p.last().is_some_and(|c| c.revents != 0);
                    if n > 0 && !(ctl_ready && n == 1) {
                        let _ = proxy.send_event(Wake);
                    }
                    // Wait for disarm's byte, then say the descriptors are main.rs's again.
                    let mut b = [0u8; 1];
                    // SAFETY: reading one byte from our own pipe.
                    unsafe { libc::read(ctl_r, b.as_mut_ptr() as *mut libc::c_void, 1) };
                    if tx_done.send(()).is_err() {
                        break;
                    }
                }
            })
            .expect("start the wake thread");
        Waker { arm, done, ctl }
    }
    fn arm(&self, fds: Vec<(RawFd, i16)>) {
        let _ = self.arm.send(fds);
    }
    fn disarm(&self) {
        let b = [1u8];
        // SAFETY: writing one byte to our own pipe.
        unsafe { libc::write(self.ctl[1], b.as_ptr() as *const libc::c_void, 1) };
        let _ = self.done.recv();
    }
}

pub struct Gui {
    event_loop: EventLoop<Wake>,
    app: App,
    waker: Waker,
}

/// Why a window cannot be opened, or None: a display to open it on and the system libraries winit loads at
/// run time (it aborts the process when one is missing, so they are looked for first).
pub fn unavailable() -> Option<String> {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if !wayland && std::env::var_os("DISPLAY").is_none() {
        return Some("no display (DISPLAY and WAYLAND_DISPLAY are unset)".into());
    }
    let libs: &[&str] = if wayland {
        &["libwayland-client.so.0", "libxkbcommon.so.0"]
    } else {
        &["libX11.so.6", "libX11-xcb.so.1", "libxkbcommon-x11.so.0"]
    };
    let missing: Vec<&str> = libs
        .iter()
        .copied()
        .filter(|l| {
            let c = std::ffi::CString::new(*l).unwrap();
            // SAFETY: dlopen with a valid name; the handle stays open, as winit will open it again.
            unsafe { libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL).is_null() }
        })
        .collect();
    (!missing.is_empty()).then(|| format!("missing system libraries: {}", missing.join(", ")))
}

impl Gui {
    /// Opens a window of COLS x ROWS cells, or says why it cannot be opened.
    pub fn open((cols, rows): (u32, u32)) -> Result<Gui, String> {
        let mut builder = EventLoop::<Wake>::with_user_event();
        // V8's thread is not the process's first; X11 and Wayland do not mind.
        winit::platform::x11::EventLoopBuilderExtX11::with_any_thread(&mut builder, true);
        winit::platform::wayland::EventLoopBuilderExtWayland::with_any_thread(&mut builder, true);
        let mut event_loop = builder
            .build()
            .map_err(|e| format!("cannot reach the display: {e}"))?;
        let (family, points) = text::font_setting();
        let mut app = App {
            gfx: None,
            error: None,
            instance: None,
            text: None,
            family,
            points: points.unwrap_or(DEFAULT_POINTS),
            start: (cols.clamp(8, 1000), rows.clamp(3, 500)),
            scale: 1.0,
            pad: 2.0,
            events: Vec::new(),
            model: None,
            title: String::new(),
            theme: String::new(),
            mods: ModifiersState::empty(),
            mouse: None,
            buttons: 0,
            exit: false,
            key_at: None,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while app.gfx.is_none() && app.error.is_none() && Instant::now() < deadline {
            if let PumpStatus::Exit(_) =
                event_loop.pump_app_events(Some(Duration::from_millis(10)), &mut app)
            {
                break;
            }
        }
        if let Some(e) = app.error.take() {
            return Err(e);
        }
        if app.gfx.is_none() {
            return Err("the window did not open".into());
        }
        match arboard::Clipboard::new() {
            Ok(cb) => {
                let cb = Rc::new(RefCell::new(cb));
                let reader = cb.clone();
                CLIPBOARD.with(|c| *c.borrow_mut() = Some(cb));
                bridge::with(|b| {
                    b.clipboard = Some(Box::new(move || reader.borrow_mut().get_text().ok()))
                });
            }
            Err(e) => trace(&format!("no clipboard: {e}")),
        }
        let waker = Waker::start(event_loop.create_proxy());
        Ok(Gui {
            event_loop,
            app,
            waker,
        })
    }

    /// Waits up to TIMEOUT (None: until something happens) for window events or FDS, and handles the window's.
    pub fn pump(&mut self, timeout: Option<Duration>, fds: Vec<(RawFd, i16)>) {
        self.waker.arm(fds);
        let status = self.event_loop.pump_app_events(timeout, &mut self.app);
        self.waker.disarm();
        if let PumpStatus::Exit(_) = status {
            self.app.exit = true;
        }
    }

    /// The events for JS since the last call, as JSON.
    pub fn take_events(&mut self) -> Vec<String> {
        std::mem::take(&mut self.app.events)
    }

    /// Draws what JS drew this turn and does what it asked.
    pub fn present(&mut self) {
        self.app.present();
    }

    /// The window is gone (destroyed by the system).
    pub fn closed(&self) -> bool {
        self.app.exit
    }
}

#[cfg(test)]
mod tests {
    use super::model::Model;
    use super::render::render_rgba;
    use super::text::Text;

    fn sample() -> Model {
        serde_json::from_str(include_str!("../../tests/model.json")).unwrap()
    }

    #[test]
    fn a_model_draws_its_faces_text_and_cursor() {
        let m = sample();
        let mut text = Text::new(None, 14.0);
        if text.empty {
            eprintln!("skipped: no fonts");
            return;
        }
        let (cw, ch) = (text.cell_w, text.cell_h);
        let (w, h) = (m.cols * cw, m.rows * ch);
        let px = match render_rgba(&m, &mut text, w, h) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipped: {e}");
                return;
            }
        };
        if let Some(out) = std::env::var_os("EDWIN_TEST_DUMP") {
            let mut ppm = format!("P6 {w} {h} 255\n").into_bytes();
            for p in px.chunks(4) {
                ppm.extend_from_slice(&p[..3]);
            }
            std::fs::write(out, ppm).unwrap();
        }
        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [px[i], px[i + 1], px[i + 2]]
        };
        // The default background, from faces[0].
        assert_eq!(at(w - 2, h / 2 + ch / 2), [0xfb, 0xf7, 0xf0]);
        // The cursor: a bar in its colour at its cell's left edge.
        let c = m.cursor.as_ref().unwrap();
        assert_eq!(
            at(c.x as u32 * cw, c.y as u32 * ch + ch / 2),
            [0x00, 0x68, 0x00]
        );
        // Text has ink: some pixel of the first row's line number is darker than the background.
        let row0: Vec<[u8; 3]> = (0..3 * cw)
            .flat_map(|x| (0..ch).map(move |y| (x, y)))
            .map(|(x, y)| at(x, y))
            .collect();
        assert!(
            row0.iter().any(|p| p[0] < 0x90),
            "the gutter's digit was drawn"
        );
        // The modeline row has its face's background.
        let ml = m.lines[m.rows as usize - 2]
            .iter()
            .find(|s| s.w > 3)
            .unwrap();
        let bg = super::model::color(m.faces[ml.f].bg.as_deref()).unwrap();
        let want = [
            (bg[0] * 255.0).round() as u8,
            (bg[1] * 255.0).round() as u8,
            (bg[2] * 255.0).round() as u8,
        ];
        let y = (m.rows - 2) * ch + 1;
        assert!(
            (0..w).any(|x| at(x, y) == want),
            "the modeline's background"
        );
    }

    #[test]
    fn another_writer_is_a_bar_and_a_name_tag() {
        let mut m = sample();
        m.presence.push(super::model::Presence {
            x: 10,
            y: 5,
            label: "yanni".into(),
            color: Some("#d33682".into()),
        });
        let mut text = Text::new(None, 14.0);
        if text.empty {
            eprintln!("skipped: no fonts");
            return;
        }
        let (cw, ch) = (text.cell_w, text.cell_h);
        let (w, h) = (m.cols * cw, m.rows * ch);
        let px = match render_rgba(&m, &mut text, w, h) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("skipped: {e}");
                return;
            }
        };
        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [px[i], px[i + 1], px[i + 2]]
        };
        let pink = [0xd3, 0x36, 0x82];
        assert_eq!(
            at(10 * cw, 5 * ch + ch / 2),
            pink,
            "the bar at the writer's cell"
        );
        // The tag sits on the row above, its background the writer's colour behind white letters.
        let tag: Vec<[u8; 3]> = (10 * cw..15 * cw).map(|x| at(x, 4 * ch + 1)).collect();
        assert!(tag.iter().all(|p| *p == pink), "the tag's background");
        let letters = (10 * cw..15 * cw).flat_map(|x| (4 * ch..5 * ch).map(move |y| (x, y)));
        assert!(
            letters.map(|(x, y)| at(x, y)).any(|p| p[1] > 0xc0),
            "the name in white"
        );
    }

    #[test]
    fn wide_characters_and_combining_marks_take_their_cells() {
        use super::model::{cells, Seg};
        // The widths as gui.ts gives them (display.ts's charWidth); U+0670 is one of the marks a table could miss.
        let seg = Seg {
            x: 0,
            w: 7,
            text: "a漢e\u{301}🙂\u{627}\u{670}".into(),
            f: 0,
            cw: vec![1, 2, 1, 0, 2, 1, 0],
        };
        let c: Vec<(u32, String, u32)> = cells(&seg);
        assert_eq!(
            c.iter().map(|x| (x.0, x.2)).collect::<Vec<_>>(),
            vec![(0, 1), (1, 2), (3, 1), (4, 2), (6, 1)]
        );
        assert_eq!(c[2].1, "e\u{301}");
        assert_eq!(c[4].1, "\u{627}\u{670}");
        // Widths that do not add up to the segment's lay one character per cell.
        let odd = Seg {
            w: 3,
            text: "abc".into(),
            cw: vec![2, 2, 2],
            ..seg
        };
        assert_eq!(
            cells(&odd).iter().map(|x| (x.0, x.2)).collect::<Vec<_>>(),
            vec![(0, 1), (1, 1), (2, 1)]
        );
    }
}
