//! edwin: Edwin's JavaScript core on embedded V8, in a terminal (DT1) or a window (DT2, `--gui`).
//!
//! The Rust side is the host's floor: the files, the terminal or the window, signals, edwind's socket and the
//! event loop. Everything Edwin is runs as JavaScript: native/js/prelude.js, host-native.js, term.js and
//! main.js, which loads the unchanged core from edwin/src. All of it is compiled into the binary, with the
//! shipped Scheme.
//!
//! The loop: poll the terminal (or pump the window's events), the signal pipe and the sockets; hand what arrived
//! to JS; run due timers; run microtasks; write or draw what JS drew; sleep until the next input or timer.

mod bridge;
#[cfg(feature = "gui")]
mod gui;
mod natives;
mod snapshot;
mod sources;
mod sys;

use std::time::Instant;

/// ICU's data, for V8's \p{...} classes and Unicode case folding (build.rs finds it).
#[repr(C, align(16))]
struct Aligned<T: ?Sized>(T);
static ICU_DATA: &Aligned<[u8]> =
    &Aligned(*include_bytes!(concat!(env!("OUT_DIR"), "/icudtl.dat")));
/// The startup snapshot build.rs made: the core loaded and booted with the shipped Scheme.
static SNAPSHOT: &Aligned<[u8]> =
    &Aligned(*include_bytes!(concat!(env!("OUT_DIR"), "/snapshot.bin")));

fn main() {
    // `edwin --daemon` (in the background) and `edwin --fg-daemon` start the user's edwind, as Emacs's do: through
    // edwin-daemon beside this program, which the package installs with edwind.
    if let Some(a) = std::env::args()
        .nth(1)
        .filter(|a| a == "--daemon" || a == "--fg-daemon")
    {
        let daemon = std::env::current_exe()
            .ok()
            .and_then(|e| Some(e.parent()?.join("edwin-daemon")));
        match daemon.filter(|d| d.exists()) {
            Some(d) => {
                let mut cmd = std::process::Command::new(d);
                if a == "--fg-daemon" {
                    cmd.arg("--fg");
                }
                cmd.args(std::env::args().skip(2));
                let err = std::os::unix::process::CommandExt::exec(&mut cmd);
                eprintln!("edwin: cannot start edwin-daemon: {err}");
            }
            None => eprintln!("edwin: {a} needs edwin-daemon beside edwin (the Nix package installs it with edwind)"),
        }
        std::process::exit(1);
    }
    // V8 runs on a thread whose stack holds the Scheme evaluator's depth cap (R4.34; edwind sizes it alike).
    let code = std::thread::Builder::new()
        .name("edwin".into())
        .stack_size(96 << 20)
        .spawn(run)
        .expect("start the V8 thread")
        .join()
        .unwrap_or(70);
    std::process::exit(code);
}

/// The socket of the user's own edwind (`edwin --daemon`): $XDG_RUNTIME_DIR/edwin/edit.sock.
fn user_socket() -> Option<String> {
    std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|d| !d.is_empty())
        .map(|d| format!("{d}/edwin/edit.sock"))
}

/// Whether main.js will attach to edwind, whose boot (Ed.bootServed) the snapshot cannot hold: the same
/// choice main.js makes (--standalone, --socket, EDWIN_NO_ATTACH, EDWIN_SOCKET, the user's daemon, the
/// service's socket).
fn will_attach() -> bool {
    let args: Vec<String> = std::env::args().skip(1).take_while(|a| a != "--").collect();
    if args
        .iter()
        .any(|a| a == "--standalone" || a == "--help" || a == "-h" || a == "--version")
        || std::env::var_os("EDWIN_NO_ATTACH").is_some()
    {
        return false;
    }
    if args
        .iter()
        .any(|a| a == "--socket" || a.starts_with("--socket="))
    {
        return true;
    }
    let mut cands: Vec<String> = std::env::var("EDWIN_SOCKET")
        .ok()
        .filter(|s| !s.is_empty())
        .into_iter()
        .collect();
    cands.extend(user_socket());
    cands.push("/run/workbench-edit/edit.sock".into());
    cands
        .iter()
        .any(|p| std::os::unix::net::UnixStream::connect(p).is_ok())
}

/// Whether the program was asked for a window (`-g`, `--gui`; `-nw` after them asks for the terminal again).
/// Whether a window was asked for (-g, --gui; the last of those and -nw, -t wins) and its size in cells
/// (--geometry=COLSxROWS).
fn window_args() -> (bool, (u32, u32)) {
    let (mut gui, mut size) = (false, (100, 36));
    for a in std::env::args().skip(1).take_while(|a| a != "--") {
        match a.as_str() {
            "-g" | "--gui" => gui = true,
            "-nw" | "--no-window" | "-t" => gui = false,
            // These print and leave; no window for them.
            "-h" | "--help" | "--version" => return (false, size),
            _ => {
                if let Some((c, r)) = a
                    .strip_prefix("--geometry=")
                    .and_then(|g| g.split_once('x'))
                {
                    if let (Ok(c), Ok(r)) = (c.parse(), r.parse()) {
                        size = (c, r);
                    }
                }
            }
        }
    }
    (gui, size)
}

#[cfg(feature = "gui")]
type Window = Option<gui::Gui>;
#[cfg(not(feature = "gui"))]
type Window = Option<()>;

/// Opens the window when one was asked for. Without one the program runs in the terminal, as asked by -nw:
/// when no display answers it says so and goes on there, if it has a terminal.
fn open_window() -> Result<Window, i32> {
    let (gui, size) = window_args();
    if !gui {
        return Ok(None);
    }
    #[cfg(feature = "gui")]
    {
        let why = match gui::unavailable() {
            Some(why) => why,
            None => match gui::Gui::open(size) {
                Ok(g) => return Ok(Some(g)),
                Err(e) => e,
            },
        };
        fallback(&why)
    }
    #[cfg(not(feature = "gui"))]
    {
        let _ = size;
        fallback("this edwin was built without the window (the gui feature)")
    }
}

fn fallback(why: &str) -> Result<Window, i32> {
    // The terminal program draws on /dev/tty, whatever the standard descriptors are, so that decides.
    // SAFETY: open and close of a constant path.
    let tty = unsafe {
        let fd = libc::open(
            c"/dev/tty".as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
        );
        fd >= 0 && libc::close(fd) == 0
    };
    eprintln!(
        "edwin: cannot open a window: {why}{}",
        if tty { "; using the terminal" } else { "" }
    );
    if tty {
        Ok(None)
    } else {
        Err(1)
    }
}

fn run() -> i32 {
    snapshot::init_v8(&ICU_DATA.0);
    natives::start_clock(Instant::now());
    sys::install_signals();
    let restore = std::env::var_os("EDWIN_NO_SNAPSHOT").is_none() && !will_attach();
    let mut params = v8::CreateParams::default().external_references(&**natives::external_refs());
    if restore {
        params = params.snapshot_blob(&SNAPSHOT.0[..]);
    }
    let window = match open_window() {
        Ok(w) => w,
        Err(code) => return code,
    };
    let isolate = &mut v8::Isolate::new(params);
    let scope = &mut v8::HandleScope::new(isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let fresh: &[&str] = &[
        "native/prelude",
        "native/host-native",
        "native/term",
        "native/main",
    ];
    let names = if restore {
        &fresh[3..]
    } else {
        natives::install(scope, context);
        fresh
    };
    for name in names {
        if !natives::run_source(scope, name) {
            sys::tty_close();
            return 70;
        }
        scope.perform_microtask_checkpoint();
        if let Some(code) = natives::exit_code() {
            sys::tty_close();
            return code;
        }
    }
    #[cfg(feature = "gui")]
    if let Some(gui) = window {
        return gui_loop(scope, context, gui);
    }
    #[cfg(not(feature = "gui"))]
    let _ = window;
    let code = event_loop(scope, context);
    sys::tty_close();
    code
}

fn global_fn<'s>(
    scope: &mut v8::HandleScope<'s>,
    obj: v8::Local<v8::Object>,
    name: &str,
) -> v8::Local<'s, v8::Function> {
    let k = v8::String::new(scope, name).unwrap();
    v8::Local::<v8::Function>::try_from(obj.get(scope, k.into()).unwrap())
        .unwrap_or_else(|_| panic!("__native.{name} is not a function"))
}

fn event_loop(scope: &mut v8::HandleScope, context: v8::Local<v8::Context>) -> i32 {
    let g = context.global(scope);
    let k = v8::String::new(scope, "__native").unwrap();
    let nat = g.get(scope, k.into()).unwrap().to_object(scope).unwrap();
    let (tick, next, input) = (
        global_fn(scope, nat, "tick"),
        global_fn(scope, nat, "next"),
        global_fn(scope, nat, "input"),
    );
    let (signal, sock) = (
        global_fn(scope, nat, "signal"),
        global_fn(scope, nat, "sock"),
    );
    let recv: v8::Local<v8::Value> = nat.into();
    let mut next_ms: f64 = 0.0;
    loop {
        sys::flush_out();
        if let Some(code) = natives::exit_code() {
            return code;
        }
        let timeout = if next_ms < 0.0 {
            -1
        } else {
            next_ms.ceil().min(i32::MAX as f64) as i32
        };
        let ready = sys::wait(timeout);
        for sig in ready.signals {
            let s = v8::String::new(scope, sig).unwrap();
            let tc = &mut v8::TryCatch::new(scope);
            signal.call(tc, recv, &[s.into()]);
            tc.perform_microtask_checkpoint();
        }
        if let Some(text) = ready.input {
            let s = v8::String::new(scope, &text).unwrap();
            let tc = &mut v8::TryCatch::new(scope);
            input.call(tc, recv, &[s.into()]);
            tc.perform_microtask_checkpoint();
        }
        if ready.tty_gone {
            // The terminal hung up without a SIGHUP reaching us (a closed pty): the same path.
            let s = v8::String::new(scope, "HUP").unwrap();
            signal.call(scope, recv, &[s.into()]);
        }
        for (id, line) in ready.socket_lines {
            let a0 = v8::Integer::new(scope, id as i32).into();
            let a1 = match line {
                Some(l) => v8::String::new(scope, &l).unwrap().into(),
                None => v8::null(scope).into(),
            };
            let tc = &mut v8::TryCatch::new(scope);
            sock.call(tc, recv, &[a0, a1]);
            tc.perform_microtask_checkpoint();
        }
        if natives::exit_code().is_some() {
            continue;
        }
        let tc = &mut v8::TryCatch::new(scope);
        tick.call(tc, recv, &[]);
        tc.perform_microtask_checkpoint();
        next_ms = next
            .call(tc, recv, &[])
            .and_then(|v| v.number_value(tc))
            .unwrap_or(-1.0);
        if natives::idle_without_work() && next_ms < 0.0 {
            // No terminal, no socket, no timer: nothing can happen any more.
            return natives::exit_code().unwrap_or(0);
        }
    }
}

/// The window's loop: the terminal loop's steps, with the window's events pumped where the terminal is polled.
#[cfg(feature = "gui")]
fn gui_loop(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    mut gui: gui::Gui,
) -> i32 {
    let g = context.global(scope);
    let k = v8::String::new(scope, "__native").unwrap();
    let nat = g.get(scope, k.into()).unwrap().to_object(scope).unwrap();
    let (tick, next, signal, sock) = (
        global_fn(scope, nat, "tick"),
        global_fn(scope, nat, "next"),
        global_fn(scope, nat, "signal"),
        global_fn(scope, nat, "sock"),
    );
    let k = v8::String::new(scope, "gui").unwrap();
    let on_event = nat
        .get(scope, k.into())
        .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok());
    let recv: v8::Local<v8::Value> = nat.into();
    let mut next_ms: f64 = 0.0;
    loop {
        gui.present();
        if let Some(code) = natives::exit_code() {
            return code;
        }
        if gui.closed() {
            // The system took the window away: as the terminal hanging up.
            let s = v8::String::new(scope, "HUP").unwrap();
            signal.call(scope, recv, &[s.into()]);
            return natives::exit_code().unwrap_or(1);
        }
        let timeout =
            (next_ms >= 0.0).then(|| std::time::Duration::from_micros((next_ms * 1000.0) as u64));
        gui.pump(timeout, sys::poll_fds());
        let ready = sys::wait(0);
        for sig in ready.signals {
            let s = v8::String::new(scope, sig).unwrap();
            let tc = &mut v8::TryCatch::new(scope);
            signal.call(tc, recv, &[s.into()]);
            tc.perform_microtask_checkpoint();
        }
        for (id, line) in ready.socket_lines {
            let a0 = v8::Integer::new(scope, id as i32).into();
            let a1 = match line {
                Some(l) => v8::String::new(scope, &l).unwrap().into(),
                None => v8::null(scope).into(),
            };
            let tc = &mut v8::TryCatch::new(scope);
            sock.call(tc, recv, &[a0, a1]);
            tc.perform_microtask_checkpoint();
        }
        if let Some(f) = on_event {
            for ev in gui.take_events() {
                let s = v8::String::new(scope, &ev).unwrap();
                let tc = &mut v8::TryCatch::new(scope);
                f.call(tc, recv, &[s.into()]);
                tc.perform_microtask_checkpoint();
            }
        }
        if natives::exit_code().is_some() {
            continue;
        }
        let tc = &mut v8::TryCatch::new(scope);
        tick.call(tc, recv, &[]);
        tc.perform_microtask_checkpoint();
        next_ms = next
            .call(tc, recv, &[])
            .and_then(|v| v.number_value(tc))
            .unwrap_or(-1.0);
    }
}
