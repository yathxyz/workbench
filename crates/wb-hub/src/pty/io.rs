//! Reading and writing the PTY master, and the input queue that writes paste in pieces.

use std::collections::VecDeque;
use std::io;
use std::os::fd::OwnedFd;

use rustix::io::Errno;
use tokio::io::unix::AsyncFd;
use wb_proto::limits::PTY_INPUT_QUEUE;

pub type Master = AsyncFd<OwnedFd>;

/// Waits until the master is readable and reads once. `Ok(0)` means every slave fd is
/// closed. Never completes without a master.
pub async fn read(master: Option<&Master>, buf: &mut [u8]) -> io::Result<usize> {
    let Some(m) = master else {
        return std::future::pending().await;
    };
    loop {
        let mut ready = m.readable().await?;
        let hung_up = ready.ready().is_read_closed();
        match ready.try_io(|fd| Ok(rustix::io::read(fd.get_ref(), &mut *buf)?)) {
            Ok(r) => return eof_on_eio(r),
            // Hang-up readiness never clears, so retrying would spin.
            Err(_would_block) if hung_up => return Ok(0),
            Err(_would_block) => {}
        }
    }
}

/// Waits until the master is writable and writes as much of `data` as it takes. `EIO`
/// means every slave fd is closed. Never completes without a master.
pub async fn write(master: Option<&Master>, data: &[u8]) -> io::Result<usize> {
    let Some(m) = master else {
        return std::future::pending().await;
    };
    loop {
        let mut ready = m.writable().await?;
        let hung_up = ready.ready().is_write_closed();
        match ready.try_io(|fd| Ok(rustix::io::write(fd.get_ref(), data)?)) {
            Ok(r) => return r,
            // Once the slave is closed, a write to a full master fails with `EAGAIN`
            // rather than `EIO`, and the hang-up readiness never clears.
            Err(_would_block) if hung_up => return Err(Errno::IO.into()),
            Err(_would_block) => {}
        }
    }
}

fn eof_on_eio(r: io::Result<usize>) -> io::Result<usize> {
    match r {
        Err(e) if e.raw_os_error() == Some(Errno::IO.raw_os_error()) => Ok(0),
        r => r,
    }
}

/// Input not yet written to the master, at most [`PTY_INPUT_QUEUE`] bytes.
#[derive(Default)]
pub struct InputQueue {
    q: VecDeque<Vec<u8>>,
    /// Bytes of the front buffer already written.
    off: usize,
    len: usize,
}

/// Queuing the message would exceed [`PTY_INPUT_QUEUE`]; it was dropped whole.
#[derive(Debug, PartialEq, Eq)]
pub struct Overflow;

impl InputQueue {
    pub fn push(&mut self, d: Vec<u8>) -> Result<(), Overflow> {
        if self.len + d.len() > PTY_INPUT_QUEUE {
            return Err(Overflow);
        }
        if !d.is_empty() {
            self.len += d.len();
            self.q.push_back(d);
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The bytes to write next; empty when the queue is.
    pub fn front(&self) -> &[u8] {
        self.q.front().map_or(&[], |b| &b[self.off..])
    }

    /// Marks `n` bytes of [`front`](Self::front) as written.
    pub fn advance(&mut self, n: usize) {
        self.off += n;
        self.len -= n;
        if self.q.front().is_some_and(|b| self.off == b.len()) {
            self.q.pop_front();
            self.off = 0;
        }
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_writes_advance_through_the_queue_in_order() {
        let mut q = InputQueue::default();
        q.push(b"hello".to_vec()).unwrap();
        q.push(Vec::new()).unwrap();
        q.push(b"world".to_vec()).unwrap();
        let mut written = Vec::new();
        while !q.is_empty() {
            let n = q.front().len().min(3);
            written.extend_from_slice(&q.front()[..n]);
            q.advance(n);
        }
        assert_eq!(written, b"helloworld");
        assert_eq!(q.front(), b"");
    }

    #[test]
    fn a_message_that_would_overflow_is_dropped_whole() {
        let mut q = InputQueue::default();
        q.push(vec![0; PTY_INPUT_QUEUE - 1]).unwrap();
        assert_eq!(q.push(vec![0; 2]), Err(Overflow));
        q.push(vec![0; 1]).unwrap();
        q.advance(10);
        assert_eq!(q.push(vec![0; 10]), Ok(()));
        q.clear();
        assert!(q.is_empty());
    }
}
