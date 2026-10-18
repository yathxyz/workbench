//! edwin in a window (DT2), on a virtual X display: keys and the mouse as a person sends them (xdotool), the
//! close button, and the keystroke-to-screen latency budget.
//!
//! Each test starts its own Xvfb. Without Xvfb or xdotool, or without a GPU adapter (lavapipe will do), the tests
//! say so and pass.
#![cfg(feature = "gui")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_edwin");

fn has(program: &str, arg: &str) -> bool {
    Command::new(program)
        .arg(arg)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// A virtual X display, stopped when dropped.
struct Display {
    name: String,
    xvfb: Child,
}

impl Display {
    fn start(test: &str) -> Option<Display> {
        if !has("Xvfb", "-help") || !has("xdotool", "version") {
            eprintln!("{test}: skipped (needs Xvfb and xdotool)");
            return None;
        }
        // A display number of this process's own, one per test.
        let n = 300 + (std::process::id() % 200) * 10 + test.len() as u32 % 10;
        let _ = std::fs::remove_file(format!("/tmp/.X11-unix/X{n}"));
        let xvfb = Command::new("Xvfb")
            .args([
                &format!(":{n}"),
                "-screen",
                "0",
                "1920x1200x24",
                "-nolisten",
                "tcp",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let d = Display {
            name: format!(":{n}"),
            xvfb,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !Path::new(&format!("/tmp/.X11-unix/X{n}")).exists() {
            if Instant::now() > deadline {
                eprintln!("{test}: skipped (Xvfb did not start)");
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Some(d)
    }

    fn xdo(&self, args: &[&str]) -> String {
        let o = Command::new("xdotool")
            .args(args)
            .env("DISPLAY", &self.name)
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
}

impl Drop for Display {
    fn drop(&mut self) {
        let _ = self.xvfb.kill();
        let _ = self.xvfb.wait();
    }
}

/// edwin --gui in DIR on display D.
struct Edwin<'a> {
    d: &'a Display,
    child: Child,
    log: PathBuf,
    win: String,
    cell: (i32, i32),
}

impl<'a> Edwin<'a> {
    /// Runs edwin with ARGS and waits for its window; None when no window could open here (no GPU adapter).
    fn open(d: &'a Display, dir: &Path, args: &[&str], env: &[(&str, &str)]) -> Option<Edwin<'a>> {
        let log = dir.join("stderr.log");
        let child = Command::new(BIN)
            .arg("--gui")
            .args(args)
            .current_dir(dir)
            .env("DISPLAY", &d.name)
            .env_remove("WAYLAND_DISPLAY")
            .env("HOME", dir)
            .env("XDG_STATE_HOME", dir.join("state"))
            .env("XDG_CONFIG_HOME", dir.join("config"))
            .env("EDWIN_NO_ATTACH", "1")
            .env("EDWIN_TRACE", "1")
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(&log).unwrap())
            .spawn()
            .unwrap();
        let mut e = Edwin {
            d,
            child,
            log,
            win: String::new(),
            cell: (0, 0),
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        while e.win.is_empty() {
            if let Ok(Some(_)) = e.child.try_wait() {
                eprintln!("no window here: {}", e.stderr());
                return None;
            }
            assert!(
                Instant::now() < deadline,
                "the window did not appear: {}",
                e.stderr()
            );
            std::thread::sleep(Duration::from_millis(100));
            e.win = d
                .xdo(&["search", "--name", " - Edwin$"])
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
        }
        // The trace line says the cell's size: "... cell 8x21, scale 1".
        let err = e.stderr();
        let cell = err
            .split("cell ")
            .nth(1)
            .and_then(|s| s.split(',').next())
            .unwrap_or("8x21");
        let (w, h) = cell.split_once('x').unwrap();
        e.cell = (w.parse().unwrap(), h.parse().unwrap());
        d.xdo(&["mousemove", "300", "300"]);
        d.xdo(&["windowfocus", &e.win]);
        e.settle();
        Some(e)
    }

    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    fn settle(&self) {
        std::thread::sleep(Duration::from_millis(300));
    }

    fn typed(&self, s: &str) -> &Self {
        self.d.xdo(&["type", "--delay", "20", s]);
        self
    }

    fn key(&self, k: &str) -> &Self {
        self.d.xdo(&["key", k]);
        self
    }

    /// A click on the cell at (COL, ROW).
    fn click(&self, col: i32, row: i32) -> &Self {
        let (x, y) = (
            2 + col * self.cell.0 + self.cell.0 / 2,
            2 + row * self.cell.1 + self.cell.1 / 2,
        );
        self.d.xdo(&[
            "mousemove",
            "--window",
            &self.win,
            &x.to_string(),
            &y.to_string(),
            "click",
            "1",
        ]);
        self
    }

    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn exit(&mut self) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code().unwrap_or(-1);
            }
            assert!(
                Instant::now() < deadline,
                "edwin did not leave: {}",
                self.stderr()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// What a window manager sends when the close button is pressed.
    fn close_button(&self) {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{ClientMessageEvent, ConnectionExt, EventMask};
        let (c, _) = x11rb::connect(Some(&self.d.name)).unwrap();
        let atom = |n: &str| {
            c.intern_atom(false, n.as_bytes())
                .unwrap()
                .reply()
                .unwrap()
                .atom
        };
        let (protocols, delete) = (atom("WM_PROTOCOLS"), atom("WM_DELETE_WINDOW"));
        let win: u32 = self.win.parse().unwrap();
        let ev = ClientMessageEvent::new(32, win, protocols, [delete, 0, 0, 0, 0]);
        c.send_event(false, win, EventMask::NO_EVENT, ev)
            .unwrap()
            .check()
            .unwrap();
        c.flush().unwrap();
    }
}

impl Drop for Edwin<'_> {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn workdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("edwin-gui-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn read(p: impl AsRef<Path>) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn keys_and_clicks_edit_and_wq_leaves_zero() {
    let Some(d) = Display::start("keys") else {
        return;
    };
    let dir = workdir("keys");
    std::fs::write(dir.join("a.txt"), "hello world\nsecond line\n").unwrap();
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    e.typed("Atyped").key("Escape");
    // A click past the end of the second line puts point on its last character (Vim's normal state).
    e.click(60, 1).typed("x");
    e.typed("gg").key("ctrl+v").typed("jI> ").key("Escape");
    e.typed(":wq").key("Return");
    assert_eq!(e.exit(), 0, "{}", e.stderr());
    assert_eq!(
        read(dir.join("a.txt")),
        "> hello worldtyped\n> second lin\n"
    );
}

#[test]
fn the_close_button_asks_about_changes() {
    let Some(d) = Display::start("close") else {
        return;
    };
    let dir = workdir("close");
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    e.close_button();
    assert_eq!(e.exit(), 0, "with no changes the window closes at once");
    let Some(mut e) = Edwin::open(&d, &dir, &["a.txt"], &[]) else {
        return;
    };
    e.typed("Atwo").key("Escape");
    e.close_button();
    e.settle();
    assert!(e.running(), "a changed file is asked about first");
    e.typed("y");
    assert_eq!(e.exit(), 0);
    assert_eq!(read(dir.join("a.txt")), "onetwo\n");
}

/// The budget (edwin/README.md, step DT2): from a key's arrival to the frame's present, on a 200x50 window full of
/// source text, p50 at most 10 ms and p99 at most 25 ms, on the software renderer. Timing on a shared machine is
/// noisy, so this runs on request and alone: cargo test --release -- --ignored latency
#[test]
#[ignore]
fn keystroke_to_screen_latency_budget() {
    let Some(d) = Display::start("latency") else {
        return;
    };
    let dir = workdir("latency");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/display.ts");
    std::fs::copy(src, dir.join("big.js")).unwrap();
    let lat = dir.join("latency.log");
    let lat_s = lat.display().to_string();
    let env = [("EDWIN_GUI_LATENCY_LOG", lat_s.as_str())];
    let Some(mut e) = Edwin::open(&d, &dir, &["--geometry=200x50", "big.js"], &env) else {
        return;
    };
    for _ in 0..40 {
        e.key("j");
    }
    e.key("o")
        .typed("const answer = 42; // typed in the window to measure its latency")
        .key("Escape");
    for _ in 0..20 {
        e.key("ctrl+d");
    }
    e.settle();
    e.typed(":q!").key("Return");
    assert_eq!(e.exit(), 0);
    let mut us: Vec<u64> = read(&lat)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect();
    us.sort_unstable();
    // Keys that arrive before one present share it, so there are fewer measurements than keys.
    assert!(us.len() > 50, "{} presents measured", us.len());
    let at = |q: f64| us[((us.len() as f64 * q) as usize).min(us.len() - 1)];
    let (p50, p99) = (at(0.5), at(0.99));
    eprintln!(
        "{} keys: p50 {p50} us, p99 {p99} us, max {} us",
        us.len(),
        us[us.len() - 1]
    );
    assert!(
        p50 <= 10_000 && p99 <= 25_000,
        "over budget: p50 {p50} us, p99 {p99} us"
    );
}
