//! __n: what the JavaScript host gets from Rust. Files throw JS errors with the system's message; reading a
//! missing file gives null, as host.files.read promises.

use crate::{bridge, sources, sys};
use std::cell::{Cell, OnceCell};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::Instant;

thread_local! {
    static EXIT: Cell<Option<i32>> = const { Cell::new(None) };
    static CLOCK: OnceCell<Instant> = const { OnceCell::new() };
}

pub fn start_clock(t: Instant) {
    CLOCK.with(|c| {
        let _ = c.set(t);
    });
}
pub fn exit_code() -> Option<i32> {
    EXIT.with(|e| e.get())
}
/// Nothing left that could wake the loop: no terminal and no socket (timers are JS's to report).
pub fn idle_without_work() -> bool {
    !sys::tty_is_open() && sys::sock_count() == 0
}

fn throw(scope: &mut v8::HandleScope, msg: &str) {
    let m = v8::String::new(scope, msg).unwrap();
    let e = v8::Exception::error(scope, m);
    scope.throw_exception(e);
}
fn arg_str(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    args.get(i).to_rust_string_lossy(scope)
}
fn ret_str(scope: &mut v8::HandleScope, rv: &mut v8::ReturnValue, s: &str) {
    match v8::String::new(scope, s) {
        Some(v) => rv.set(v.into()),
        None => throw(scope, "string too long for V8"),
    }
}
/// The system's message without its error number ("Permission denied"). File errors say no path: the caller
/// names the file (the core's "Cannot write NAME: ...").
fn sys_msg(e: &std::io::Error) -> String {
    let m = e.to_string();
    m.split(" (os error").next().unwrap_or(&m).to_string()
}
fn io_msg(path: &str, e: &std::io::Error) -> String {
    format!("{path}: {}", sys_msg(e))
}

/// Compile and run one of the embedded sources; an exception is printed and reported as false.
pub fn run_source(scope: &mut v8::HandleScope, name: &str) -> bool {
    let Some(src) = sources::js(name) else {
        eprintln!("edwin: no embedded source {name}");
        return false;
    };
    let tc = &mut v8::TryCatch::new(scope);
    let code = v8::String::new(tc, src).unwrap();
    let file = if name.starts_with("native/") {
        format!("edwin/{}.js", name.replacen("native/", "native/js/", 1))
    } else {
        format!("edwin/src/{name}.js")
    };
    let origin_name = v8::String::new(tc, &file).unwrap();
    let origin = v8::ScriptOrigin::new(
        tc,
        origin_name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    if v8::Script::compile(tc, code, Some(&origin))
        .and_then(|s| s.run(tc))
        .is_some()
    {
        return true;
    }
    let msg = match tc.exception() {
        Some(e) => {
            let stack = tc.stack_trace().map(|s| s.to_rust_string_lossy(tc));
            stack.unwrap_or_else(|| e.to_rust_string_lossy(tc))
        }
        None => "terminated".into(),
    };
    sys::tty_close();
    eprintln!("edwin: {file}: {msg}");
    false
}

fn load(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let name = arg_str(scope, &args, 0);
    if !run_source(scope, &name) {
        EXIT.with(|e| e.set(Some(70)));
        throw(scope, &format!("cannot load {name}"));
    }
}

fn print(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let s = arg_str(scope, &args, 0);
    let _ = std::io::stdout().write_all(s.as_bytes());
    let _ = std::io::stdout().flush();
}
fn eprint(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let s = arg_str(scope, &args, 0);
    let _ = std::io::stderr().write_all(s.as_bytes());
}
fn env(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let k = arg_str(scope, &args, 0);
    if let Ok(v) = std::env::var(&k) {
        ret_str(scope, &mut rv, &v);
    }
}
fn cwd(scope: &mut v8::HandleScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let d = std::env::var("PWD")
        .ok()
        .filter(|p| Path::new(p).is_absolute() && same_dir(p))
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        });
    ret_str(scope, &mut rv, &d.unwrap_or_else(|| "/".into()));
}
/// $PWD keeps the user's spelling of the directory (through symlinks), when it still names where we are.
fn same_dir(p: &str) -> bool {
    match (std::fs::metadata(p), std::fs::metadata(".")) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}
fn now(scope: &mut v8::HandleScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let ms = CLOCK.with(|c| {
        c.get()
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    });
    rv.set(v8::Number::new(scope, ms).into());
}

fn read_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    match std::fs::metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            rv.set(v8::null(scope).into());
            return;
        }
        Ok(m) if m.is_dir() => return throw(scope, "is a directory"),
        _ => {}
    }
    match std::fs::read(&p) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => ret_str(scope, &mut rv, &s),
            Err(_) => throw(scope, "not UTF-8 text"),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => rv.set(v8::null(scope).into()),
        Err(e) => throw(scope, &sys_msg(&e)),
    }
}

/// Write TEXT to PATH. An ordinary file is replaced atomically: a temporary file beside it with the old
/// file's mode, written and synced, then renamed over it. A symlink, a file with other hard links, or a file
/// in a directory we may not create files in is written in place, so the link and the inode stay as they are.
fn write_atomic(p: &str, text: &[u8]) -> std::io::Result<()> {
    let path = Path::new(p);
    let meta = std::fs::symlink_metadata(path).ok();
    let in_place = meta
        .as_ref()
        .map(|m| m.file_type().is_symlink() || m.nlink() > 1)
        .unwrap_or(false);
    let write_in_place = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        f.write_all(text)?;
        f.sync_all()
    };
    if in_place {
        return write_in_place();
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let base = path
        .file_name()
        .map(|b| b.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{base}.edwin-{}~", std::process::id()));
    let mode = meta.as_ref().map(|m| m.permissions().mode() & 0o7777);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true)
        .create_new(true)
        .mode(mode.unwrap_or(0o666));
    let mut f = match opts.open(&tmp) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && meta.is_some() => {
            return write_in_place()
        }
        Err(e) => return Err(e),
    };
    let done = (|| {
        f.write_all(text)?;
        if let Some(m) = mode {
            f.set_permissions(std::fs::Permissions::from_mode(m))?;
        }
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return done;
    }
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}
fn write_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    let t = arg_str(scope, &args, 1);
    if let Err(e) = write_atomic(&p, t.as_bytes()) {
        throw(scope, &sys_msg(&e));
    }
}
fn append_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    let t = arg_str(scope, &args, 1);
    let r = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(&p)
        .and_then(|mut f| f.write_all(t.as_bytes()));
    if let Err(e) = r {
        throw(scope, &io_msg(&p, &e));
    }
}
fn set(scope: &mut v8::HandleScope, o: v8::Local<v8::Object>, k: &str, v: v8::Local<v8::Value>) {
    let key = v8::String::new(scope, k).unwrap();
    o.set(scope, key.into(), v);
}
fn stat(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let p = arg_str(scope, &args, 0);
    match std::fs::metadata(&p) {
        Ok(m) => {
            let o = v8::Object::new(scope);
            let dir = v8::Boolean::new(scope, m.is_dir()).into();
            set(scope, o, "dir", dir);
            let size = v8::Number::new(scope, m.len() as f64).into();
            set(scope, o, "size", size);
            let mtime = v8::Number::new(
                scope,
                m.mtime() as f64 * 1000.0 + (m.mtime_nsec() / 1_000_000) as f64,
            )
            .into();
            set(scope, o, "mtime", mtime);
            let mode = v8::Integer::new(scope, (m.mode() & 0o7777) as i32).into();
            set(scope, o, "mode", mode);
            rv.set(o.into());
        }
        Err(_) => rv.set(v8::null(scope).into()),
    }
}
/// The file's true name: the absolute path with every symbolic link resolved. For a file that does not exist
/// yet, its directory's true name and its own name; null when the directory does not exist either.
fn realpath(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = std::path::PathBuf::from(arg_str(scope, &args, 0));
    let t = std::fs::canonicalize(&p).ok().or_else(|| {
        let (dir, name) = (p.parent()?, p.file_name()?);
        Some(std::fs::canonicalize(dir).ok()?.join(name))
    });
    match t.and_then(|t| t.to_str().map(|s| s.to_owned())) {
        Some(t) => {
            let v = v8::String::new(scope, &t).unwrap();
            rv.set(v.into());
        }
        None => rv.set(v8::null(scope).into()),
    }
}
fn read_dir(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    match std::fs::read_dir(&p) {
        Ok(rd) => {
            let arr = v8::Array::new(scope, 0);
            for (i, ent) in rd.flatten().enumerate() {
                let name = ent.file_name().to_string_lossy().into_owned();
                let dir = ent
                    .file_type()
                    .map(|t| t.is_dir() || (t.is_symlink() && ent.path().is_dir()))
                    .unwrap_or(false);
                let pair = v8::Array::new(scope, 2);
                let n = v8::String::new(scope, &name).unwrap().into();
                pair.set_index(scope, 0, n);
                let d = v8::Boolean::new(scope, dir).into();
                pair.set_index(scope, 1, d);
                arr.set_index(scope, i as u32, pair.into());
            }
            rv.set(arr.into());
        }
        Err(e) => throw(scope, &io_msg(&p, &e)),
    }
}
fn remove(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let p = arg_str(scope, &args, 0);
    if let Err(e) = std::fs::remove_file(&p) {
        if e.kind() != std::io::ErrorKind::NotFound {
            throw(scope, &io_msg(&p, &e));
        }
    }
}
fn mkdirs(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let p = arg_str(scope, &args, 0);
    if let Err(e) = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&p)
    {
        throw(scope, &io_msg(&p, &e));
    }
}
fn read_stdin(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let mut b = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut b);
    ret_str(scope, &mut rv, &String::from_utf8_lossy(&b));
}

fn tty_open(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Boolean::new(scope, sys::tty_open()).into());
}
fn tty_close(
    _scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    sys::tty_close();
}
fn tty_write(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let s = arg_str(scope, &args, 0);
    sys::tty_write(&s);
}
fn tty_flush(
    _scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    sys::flush_out();
}
fn tty_size(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let (c, r) = sys::tty_size();
    let arr = v8::Array::new(scope, 2);
    let a = v8::Integer::new(scope, c as i32).into();
    arr.set_index(scope, 0, a);
    let b = v8::Integer::new(scope, r as i32).into();
    arr.set_index(scope, 1, b);
    rv.set(arr.into());
}
fn suspend(
    _scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    sys::suspend();
}
fn exit(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let code = args.get(0).int32_value(scope).unwrap_or(0);
    sys::flush_out();
    EXIT.with(|e| e.set(Some(code & 255)));
}
fn sock_open(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let p = arg_str(scope, &args, 0);
    match sys::sock_open(&p) {
        Ok(id) => rv.set(v8::Integer::new(scope, id as i32).into()),
        Err(e) => throw(scope, &format!("{p}: {e}")),
    }
}
fn sock_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let line = arg_str(scope, &args, 1);
    rv.set(v8::Boolean::new(scope, sys::sock_send(id, &line)).into());
}
fn sock_close(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    sys::sock_close(id);
}

/* ---------- the window (DT2): through the bridge, so this file needs no graphics library ---------- */
/// {cols, rows, theme} of the open window, or null when the program runs in a terminal.
fn gui_size(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let size = bridge::with(|b| b.open.then(|| (b.cols, b.rows, b.theme.clone())));
    match size {
        Some((cols, rows, theme)) => {
            let o = v8::Object::new(scope);
            let c = v8::Integer::new_from_unsigned(scope, cols).into();
            set(scope, o, "cols", c);
            let r = v8::Integer::new_from_unsigned(scope, rows).into();
            set(scope, o, "rows", r);
            if let Some(t) = theme {
                let t = v8::String::new(scope, &t).unwrap().into();
                set(scope, o, "theme", t);
            }
            rv.set(o.into());
        }
        None => rv.set(v8::null(scope).into()),
    }
}
/// The model to draw, as JSON (the window draws the last one it was given after this turn of JS).
fn gui_draw(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let json = arg_str(scope, &args, 0);
    bridge::with(|b| b.model = Some(json));
}
/// An action for the window: bell, clipboard TEXT, iconify, raise.
fn gui_action(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let name = arg_str(scope, &args, 0);
    let arg = if args.length() > 1 {
        arg_str(scope, &args, 1)
    } else {
        String::new()
    };
    bridge::with(|b| b.actions.push((name, arg)));
}
/// The system clipboard's text, or null.
fn gui_clipboard(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match bridge::clipboard_text() {
        Some(t) => ret_str(scope, &mut rv, &t),
        None => rv.set(v8::null(scope).into()),
    }
}
fn args(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let argv = v8::Array::new(scope, 0);
    for (i, a) in std::env::args().skip(1).enumerate() {
        let v = v8::String::new(scope, &a).unwrap();
        argv.set_index(scope, i as u32, v.into());
    }
    rv.set(argv.into());
}

/// Every native, by its name on __n. The startup snapshot refers to them by their place in this list, so the
/// binary that made it and the one that restores it must agree: both are built from this file. (A macro, as
/// V8 wants each callback as its own zero-sized function item, not a function pointer.)
macro_rules! natives {
    ($m:ident) => {
        $m!(
            "load" load, "args" args, "print" print, "eprint" eprint, "env" env, "cwd" cwd, "now" now,
            "readFile" read_file, "writeFile" write_file, "appendFile" append_file, "stat" stat, "realpath" realpath, "readDir" read_dir,
            "remove" remove, "mkdirs" mkdirs, "readStdin" read_stdin, "ttyOpen" tty_open, "ttyClose" tty_close,
            "ttyWrite" tty_write, "ttyFlush" tty_flush, "ttySize" tty_size, "suspend" suspend, "exit" exit,
            "sockOpen" sock_open, "sockSend" sock_send, "sockClose" sock_close, "guiSize" gui_size,
            "guiDraw" gui_draw, "guiAction" gui_action, "guiClipboard" gui_clipboard
        )
    };
}

/// The natives as V8's external references (for making and restoring the snapshot).
pub fn external_refs() -> &'static v8::ExternalReferences {
    static REFS: std::sync::OnceLock<v8::ExternalReferences> = std::sync::OnceLock::new();
    REFS.get_or_init(|| {
        use v8::MapFnTo;
        macro_rules! refs {
            ($($name:literal $f:ident),*) => { vec![$(v8::ExternalReference { function: $f.map_fn_to() }),*] };
        }
        v8::ExternalReferences::new(&natives!(refs))
    })
}

/// Put __n (the natives) and __scm (the shipped Scheme) on the global object.
pub fn install(scope: &mut v8::HandleScope, context: v8::Local<v8::Context>) {
    let n = v8::Object::new(scope);
    macro_rules! put {
        ($($name:literal $f:ident),*) => {$(
            let func = v8::Function::new(scope, $f).unwrap();
            set(scope, n, $name, func.into());
        )*};
    }
    natives!(put);
    let scm = v8::Object::new(scope);
    for (name, text) in sources::SCM {
        let v = v8::String::new(scope, text).unwrap();
        set(scope, scm, name, v.into());
    }
    let g = context.global(scope);
    set(scope, g, "__n", n.into());
    set(scope, g, "__scm", scm.into());
}
