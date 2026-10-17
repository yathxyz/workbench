//! The Unix floor: the terminal (/dev/tty in raw mode), signals through a self-pipe, edwind's sockets, and
//! one poll(2) over all of them.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;

struct Tty {
    file: std::fs::File,
    saved: libc::termios,
    raw: bool,
}

struct Sock {
    stream: UnixStream,
    buf: Vec<u8>,
    /// Bytes sent but not yet taken by the peer: written as the socket accepts them (POLLOUT), so a peer that
    /// stops reading never blocks the loop, and lines still reach it whole and in order.
    outq: Vec<u8>,
}

/// A peer that leaves this much unread is taken as gone: the socket is shut down and the loop reports it closed.
const OUTQ_MAX: usize = 64 << 20;

impl Sock {
    /// Write what the socket accepts now. Err: the peer is gone.
    fn flush(&mut self) -> std::io::Result<()> {
        while !self.outq.is_empty() {
            match self.stream.write(&self.outq) {
                Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                Ok(k) => {
                    self.outq.drain(..k);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct State {
    tty: Option<Tty>,
    out: Vec<u8>,
    carry: Vec<u8>,
    socks: HashMap<u32, Sock>,
    next_sock: u32,
}

thread_local! {
    static ST: RefCell<State> = RefCell::new(State::default());
}

static mut SIG_PIPE: [RawFd; 2] = [-1, -1];

extern "C" fn on_signal(sig: libc::c_int) {
    let b = sig as u8;
    // SAFETY: write(2) is async-signal-safe; the pipe is non-blocking and a full pipe drops the byte.
    unsafe {
        let fd = SIG_PIPE[1];
        libc::write(fd, &b as *const u8 as *const libc::c_void, 1);
    }
}

const SIGNALS: &[libc::c_int] = &[
    libc::SIGWINCH,
    libc::SIGTSTP,
    libc::SIGCONT,
    libc::SIGHUP,
    libc::SIGTERM,
    libc::SIGINT,
    libc::SIGQUIT,
];

fn handle(sig: libc::c_int, f: libc::sighandler_t) {
    // SAFETY: a plain sigaction with an empty mask; the handler only writes to the pipe.
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = f;
        sa.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut sa.sa_mask);
        libc::sigaction(sig, &sa, std::ptr::null_mut());
    }
}

pub fn install_signals() {
    // SAFETY: pipe2 fills the array; the descriptors live as long as the process.
    unsafe {
        let mut fds = [0 as RawFd; 2];
        if libc::pipe2(fds.as_mut_ptr(), libc::O_NONBLOCK | libc::O_CLOEXEC) == 0 {
            SIG_PIPE = fds;
        }
    }
    for &s in SIGNALS {
        handle(
            s,
            on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
    }
    handle(libc::SIGPIPE, libc::SIG_IGN);
}

fn signal_name(sig: libc::c_int) -> &'static str {
    match sig {
        libc::SIGWINCH => "WINCH",
        libc::SIGTSTP => "TSTP",
        libc::SIGCONT => "CONT",
        libc::SIGHUP => "HUP",
        libc::SIGTERM => "TERM",
        libc::SIGINT => "INT",
        libc::SIGQUIT => "QUIT",
        _ => "OTHER",
    }
}

/* ---------- the terminal ---------- */

fn make_raw(fd: RawFd, saved: &libc::termios) {
    let mut t = *saved;
    // SAFETY: cfmakeraw edits the struct; tcsetattr applies it to our own tty.
    unsafe {
        libc::cfmakeraw(&mut t);
        t.c_cc[libc::VMIN] = 1;
        t.c_cc[libc::VTIME] = 0;
        libc::tcsetattr(fd, libc::TCSANOW, &t);
    }
}

/// Open /dev/tty and put it in raw mode (no echo, no line editing, no signals from keys, no flow control).
pub fn tty_open() -> bool {
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
    else {
        return false;
    };
    let fd = file.as_raw_fd();
    // SAFETY: tcgetattr fills the struct for a descriptor we own.
    let saved = unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut t) != 0 {
            return false;
        }
        t
    };
    make_raw(fd, &saved);
    ST.with(|s| {
        s.borrow_mut().tty = Some(Tty {
            file,
            saved,
            raw: true,
        })
    });
    true
}

/// Give the terminal back as it was.
pub fn tty_close() {
    flush_out();
    ST.with(|s| {
        if let Some(t) = s.borrow_mut().tty.take() {
            // SAFETY: restores the attributes saved at open.
            unsafe { libc::tcsetattr(t.file.as_raw_fd(), libc::TCSADRAIN, &t.saved) };
        }
    });
}

pub fn tty_write(s: &str) {
    ST.with(|st| st.borrow_mut().out.extend_from_slice(s.as_bytes()));
}

pub fn flush_out() {
    ST.with(|st| {
        let mut st = st.borrow_mut();
        if st.out.is_empty() {
            return;
        }
        let out = std::mem::take(&mut st.out);
        match st.tty.as_mut() {
            Some(t) => {
                let _ = t.file.write_all(&out);
                let _ = t.file.flush();
            }
            None => {
                let _ = std::io::stdout().write_all(&out);
            }
        }
    });
}

pub fn tty_size() -> (u16, u16) {
    ST.with(|st| {
        let st = st.borrow();
        let fd = st.tty.as_ref().map(|t| t.file.as_raw_fd()).unwrap_or(1);
        // SAFETY: TIOCGWINSZ fills a winsize.
        unsafe {
            let mut ws: libc::winsize = std::mem::zeroed();
            if libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
                (ws.ws_col, ws.ws_row)
            } else {
                (80, 24)
            }
        }
    })
}

/// Stop the process as the shell's job control expects (C-z): the terminal restored first, raw again after.
pub fn suspend() {
    flush_out();
    let saved = ST.with(|st| {
        st.borrow()
            .tty
            .as_ref()
            .map(|t| (t.file.as_raw_fd(), t.saved))
    });
    if let Some((fd, t)) = saved {
        // SAFETY: restores our own terminal's attributes.
        unsafe { libc::tcsetattr(fd, libc::TCSADRAIN, &t) };
    }
    handle(libc::SIGTSTP, libc::SIG_DFL);
    // SAFETY: raising SIGTSTP with the default action stops us until SIGCONT.
    unsafe { libc::raise(libc::SIGTSTP) };
    handle(
        libc::SIGTSTP,
        on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
    );
    if let Some((fd, t)) = saved {
        make_raw(fd, &t);
    }
    // The SIGCONT that woke us is in the pipe; its handler in JS redraws, which resume did already.
    drain_signal(libc::SIGCONT);
}

fn drain_signal(skip: libc::c_int) {
    let mut keep = Vec::new();
    let mut b = [0u8; 64];
    // SAFETY: reading our own non-blocking pipe.
    loop {
        let n = unsafe { libc::read(SIG_PIPE[0], b.as_mut_ptr() as *mut libc::c_void, b.len()) };
        if n <= 0 {
            break;
        }
        keep.extend(
            b[..n as usize]
                .iter()
                .filter(|&&x| x as libc::c_int != skip),
        );
    }
    for x in keep {
        // SAFETY: as in the handler.
        unsafe { libc::write(SIG_PIPE[1], &x as *const u8 as *const libc::c_void, 1) };
    }
}

pub fn tty_is_open() -> bool {
    ST.with(|st| st.borrow().tty.as_ref().map(|t| t.raw).unwrap_or(false))
}

/* ---------- sockets ---------- */

pub fn sock_open(path: &str) -> Result<u32, String> {
    let stream = UnixStream::connect(path).map_err(|e| e.to_string())?;
    stream.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(ST.with(|st| {
        let mut st = st.borrow_mut();
        st.next_sock += 1;
        let id = st.next_sock;
        st.socks.insert(
            id,
            Sock {
                stream,
                buf: Vec::new(),
                outq: Vec::new(),
            },
        );
        id
    }))
}

pub fn sock_send(id: u32, line: &str) -> bool {
    ST.with(|st| {
        let mut st = st.borrow_mut();
        let Some(s) = st.socks.get_mut(&id) else {
            return false;
        };
        s.outq.extend_from_slice(line.as_bytes());
        s.outq.push(b'\n');
        if s.flush().is_err() || s.outq.len() > OUTQ_MAX {
            // The next wait sees the hang-up and reports the socket closed (the protocol client reconnects).
            s.outq.clear();
            let _ = s.stream.shutdown(std::net::Shutdown::Both);
            return false;
        }
        true
    })
}

pub fn sock_close(id: u32) {
    ST.with(|st| {
        if let Some(s) = st.borrow_mut().socks.remove(&id) {
            let _ = s.stream.shutdown(std::net::Shutdown::Both);
        }
    });
}

pub fn sock_count() -> usize {
    ST.with(|st| st.borrow().socks.len())
}

/* ---------- waiting ---------- */

#[derive(Default)]
pub struct Ready {
    pub input: Option<String>,
    pub signals: Vec<&'static str>,
    pub socket_lines: Vec<(u32, Option<String>)>,
    pub tty_gone: bool,
}

/// Bytes to text: whole UTF-8 sequences now, an unfinished one kept for the next read, bad bytes as U+FFFD.
fn decode(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::new();
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(good).unwrap());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{fffd}');
                        rest = &bad[n..];
                    }
                    None => {
                        rest = bad;
                        break;
                    }
                }
            }
        }
    }
    *carry = rest.to_vec();
    out
}

/// Wait up to TIMEOUT ms (-1: forever) for input, a signal or socket data, and collect what arrived.
pub fn wait(timeout: i32) -> Ready {
    let mut ready = Ready::default();
    ST.with(|st| {
        let mut st = st.borrow_mut();
        let mut fds: Vec<libc::pollfd> = Vec::new();
        // SAFETY: reading a static set once at startup.
        let sig_fd = unsafe { SIG_PIPE[0] };
        fds.push(libc::pollfd {
            fd: sig_fd,
            events: libc::POLLIN,
            revents: 0,
        });
        let tty_fd = st
            .tty
            .as_ref()
            .filter(|t| t.raw)
            .map(|t| t.file.as_raw_fd());
        if let Some(fd) = tty_fd {
            fds.push(libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            });
        }
        let ids: Vec<u32> = st.socks.keys().copied().collect();
        for id in &ids {
            let s = &st.socks[id];
            fds.push(libc::pollfd {
                fd: s.stream.as_raw_fd(),
                events: libc::POLLIN | if s.outq.is_empty() { 0 } else { libc::POLLOUT },
                revents: 0,
            });
        }
        // SAFETY: fds is a valid array of pollfd for the duration of the call.
        let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if n <= 0 {
            return;
        }
        if fds[0].revents & libc::POLLIN != 0 {
            let mut b = [0u8; 64];
            // SAFETY: reading our own non-blocking pipe.
            let k = unsafe { libc::read(sig_fd, b.as_mut_ptr() as *mut libc::c_void, b.len()) };
            for &x in b.iter().take(k.max(0) as usize) {
                let name = signal_name(x as libc::c_int);
                if !ready.signals.contains(&name) {
                    ready.signals.push(name);
                }
            }
        }
        let mut i = 1;
        if tty_fd.is_some() {
            let re = fds[i].revents;
            i += 1;
            if re & libc::POLLIN != 0 {
                let mut b = [0u8; 65536];
                let k = st.tty.as_mut().unwrap().file.read(&mut b).unwrap_or(0);
                if k == 0 {
                    ready.tty_gone = true;
                } else {
                    let mut carry = std::mem::take(&mut st.carry);
                    ready.input = Some(decode(&mut carry, &b[..k]));
                    st.carry = carry;
                }
            } else if re & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                ready.tty_gone = true;
            }
            if ready.tty_gone {
                if let Some(t) = st.tty.as_mut() {
                    t.raw = false;
                }
            }
        }
        for id in ids {
            let re = fds[i].revents;
            i += 1;
            if re == 0 {
                continue;
            }
            let mut closed = re & (libc::POLLHUP | libc::POLLERR) != 0 && re & libc::POLLIN == 0;
            if let Some(s) = st.socks.get_mut(&id) {
                if re & libc::POLLOUT != 0 && s.flush().is_err() {
                    closed = true;
                }
                let mut b = [0u8; 65536];
                loop {
                    match s.stream.read(&mut b) {
                        Ok(0) => {
                            closed = true;
                            break;
                        }
                        Ok(k) => s.buf.extend_from_slice(&b[..k]),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            closed = true;
                            break;
                        }
                    }
                }
                while let Some(p) = s.buf.iter().position(|&c| c == b'\n') {
                    let line: Vec<u8> = s.buf.drain(..=p).collect();
                    ready.socket_lines.push((
                        id,
                        Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned()),
                    ));
                }
            }
            if closed {
                st.socks.remove(&id);
                ready.socket_lines.push((id, None));
            }
        }
    });
    ready
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn a_peer_that_stops_reading_never_blocks_a_send() {
        let path = std::env::temp_dir().join(format!("edwin-sock-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let id = sock_open(path.to_str().unwrap()).unwrap();
        let (mut peer, _) = listener.accept().unwrap();
        let line = "x".repeat(1 << 16);
        // 4 MB, far more than the socket buffer holds, while the peer reads nothing.
        let t0 = std::time::Instant::now();
        for _ in 0..64 {
            assert!(sock_send(id, &line));
        }
        assert!(t0.elapsed() < std::time::Duration::from_secs(2));
        // The peer starts reading: the loop writes the rest as the socket takes it, whole lines in order.
        let reader = std::thread::spawn(move || {
            let mut v = Vec::new();
            peer.read_to_end(&mut v).unwrap();
            v
        });
        while ST.with(|st| !st.borrow().socks[&id].outq.is_empty()) {
            wait(100);
        }
        sock_close(id);
        let got = reader.join().unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(got.len(), 64 * ((1 << 16) + 1));
        assert!(got
            .split(|&c| c == b'\n')
            .take(64)
            .all(|l| l.len() == 1 << 16));
    }
}
