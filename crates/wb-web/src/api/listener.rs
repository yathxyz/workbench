//! The API's listener (design §3.8.1): it holds at most `API_CONNS_MAX` connections,
//! so a peer that opens connections and leaves them idle uses up the API's share of
//! wb-web's descriptors and not the browser's or the hub's.

use std::io::{self, IoSlice};
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Connections the API holds at a time; a further one waits to be accepted.
pub const API_CONNS_MAX: usize = 256;

/// A TCP listener that accepts a connection only while fewer than `API_CONNS_MAX`
/// are open.
pub struct Capped {
    listener: TcpListener,
    slots: Arc<Semaphore>,
}

impl Capped {
    pub fn new(listener: TcpListener) -> Capped {
        Capped {
            listener,
            slots: Arc::new(Semaphore::new(API_CONNS_MAX)),
        }
    }
}

impl Listener for Capped {
    type Io = Conn;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Conn, SocketAddr) {
        let slot = self.slots.clone().acquire_owned().await;
        let slot = slot.expect("the semaphore is never closed");
        let (io, addr) = Listener::accept(&mut self.listener).await;
        (Conn { io, _slot: slot }, addr)
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}

/// An accepted connection; its slot is free again when it is dropped.
pub struct Conn {
    io: TcpStream,
    _slot: OwnedSemaphorePermit,
}

impl AsyncRead for Conn {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for Conn {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// The address a request's connection came from.
#[derive(Clone, Copy)]
pub struct Peer(pub SocketAddr);

impl Connected<IncomingStream<'_, Capped>> for Peer {
    fn connect_info(stream: IncomingStream<'_, Capped>) -> Peer {
        Peer(*stream.remote_addr())
    }
}
