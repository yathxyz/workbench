//! The auth floor (design §3.6). It wraps every route, static files and fallbacks
//! included, so a request that fails it gets 403 before it can learn whether a path
//! exists.
//!
//! The prototype's `X-Token` header, `?token=` and `#token=` are never read: any value
//! behaves exactly like its absence.

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{self, AsHeaderName};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use subtle::ConstantTimeEq;

use crate::AppState;
use crate::http::ApiError;

const SECRET_HEADER: HeaderName = HeaderName::from_static("x-workbench-proxy-secret");

/// The only paths that upgrade. An `Upgrade` request for any other path is 404.
const UPGRADE_PATHS: [&str; 4] = ["/pty", "/acp", "/rpc", "/edit"];

/// What the floor compares against. Deliberately not `Debug`: it holds the secret.
pub struct Floor {
    /// Canonical form (an IPv4-mapped address is stored as IPv4).
    pub trusted_proxy: IpAddr,
    pub secret: Box<[u8]>,
    /// The authority of `publicOrigin`, lowercase.
    pub expected_host: String,
    /// `publicOrigin` as a browser serialises it.
    pub expected_origin: String,
}

/// Which check refused a request, in check order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deny {
    Source,
    Target,
    Secret,
    Host,
    Origin,
}

/// Runs the checks of §3.6 in order. `X-Forwarded-For` is never read.
pub fn check(floor: &Floor, peer: IpAddr, req: &Parts) -> Result<(), Deny> {
    if peer.to_canonical() != floor.trusted_proxy {
        return Err(Deny::Source);
    }
    // Origin-form only: absolute-form, authority-form and asterisk-form are refused.
    if req.uri.scheme().is_some()
        || req.uri.authority().is_some()
        || !req.uri.path().starts_with('/')
    {
        return Err(Deny::Target);
    }
    // The slice comparison is constant time for equal lengths; the length is not secret.
    let secret = exactly_one(&req.headers, SECRET_HEADER).ok_or(Deny::Secret)?;
    if !bool::from(secret.as_bytes().ct_eq(&floor.secret)) {
        return Err(Deny::Secret);
    }
    let host = exactly_one(&req.headers, header::HOST).ok_or(Deny::Host)?;
    if !host
        .as_bytes()
        .eq_ignore_ascii_case(floor.expected_host.as_bytes())
    {
        return Err(Deny::Host);
    }
    // Any Upgrade header counts, whatever its value.
    let required = req.headers.contains_key(header::UPGRADE)
        || !matches!(req.method, Method::GET | Method::HEAD);
    let mut origins = req.headers.get_all(header::ORIGIN).iter();
    match (origins.next(), origins.next()) {
        (None, _) if !required => Ok(()),
        (Some(o), None) if o.as_bytes() == floor.expected_origin.as_bytes() => Ok(()),
        _ => Err(Deny::Origin),
    }
}

fn exactly_one(headers: &HeaderMap, name: impl AsHeaderName) -> Option<&HeaderValue> {
    let mut values = headers.get_all(name).iter();
    match (values.next(), values.next()) {
        (Some(v), None) => Some(v),
        _ => None,
    }
}

/// The floor middleware, added last so it wraps everything.
pub async fn floor(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let (parts, body) = req.into_parts();
    let mut res = match check(&app.floor, peer.ip(), &parts) {
        Err(reason) => {
            // The path is logged without its query, and no header value is logged.
            tracing::warn!(
                peer = %peer.ip(),
                method = %parts.method,
                path = parts.uri.path(),
                ?reason,
                "request refused"
            );
            ApiError::new(StatusCode::FORBIDDEN, "forbidden").into_response()
        }
        Ok(())
            if parts.headers.contains_key(header::UPGRADE)
                && !UPGRADE_PATHS.contains(&parts.uri.path()) =>
        {
            ApiError::new(StatusCode::NOT_FOUND, "not found").into_response()
        }
        Ok(()) => next.run(Request::from_parts(parts, body)).await,
    };
    security_headers(res.headers_mut());
    res
}

/// Headers on every response (§3.5.5); the CSP only on HTML.
fn security_headers(h: &mut HeaderMap) {
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    let html = h
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.as_bytes().starts_with(b"text/html"));
    if html {
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("object-src 'none'; base-uri 'none'"),
        );
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Request;

    use super::*;

    const SECRET: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const PROXY: &str = "192.0.2.1";
    const ORIGIN: &str = "https://wb.example.org";
    const HOST: &str = "wb.example.org";

    fn floor() -> Floor {
        Floor {
            trusted_proxy: PROXY.parse().unwrap(),
            secret: SECRET.as_bytes().into(),
            expected_host: HOST.into(),
            expected_origin: ORIGIN.into(),
        }
    }

    /// A request as Caddy forwards it: secret and Host set, Origin as given.
    struct Req {
        method: &'static str,
        uri: &'static str,
        headers: Vec<(&'static str, String)>,
        peer: &'static str,
    }

    impl Req {
        fn new(method: &'static str, origin: bool) -> Self {
            let mut headers = vec![
                ("x-workbench-proxy-secret", SECRET.to_owned()),
                ("host", HOST.to_owned()),
            ];
            if origin {
                headers.push(("origin", ORIGIN.to_owned()));
            }
            Req {
                method,
                uri: "/api/info",
                headers,
                peer: PROXY,
            }
        }

        fn set(mut self, name: &'static str, value: &str) -> Self {
            self.headers.retain(|(n, _)| *n != name);
            self.headers.push((name, value.to_owned()));
            self
        }

        fn add(mut self, name: &'static str, value: &str) -> Self {
            self.headers.push((name, value.to_owned()));
            self
        }

        fn drop(mut self, name: &'static str) -> Self {
            self.headers.retain(|(n, _)| *n != name);
            self
        }

        fn check(&self) -> Result<(), Deny> {
            let mut b = Request::builder().method(self.method).uri(self.uri);
            for (n, v) in &self.headers {
                b = b.header(*n, v.as_str());
            }
            let (parts, ()) = b.body(()).unwrap().into_parts();
            check(&floor(), self.peer.parse().unwrap(), &parts)
        }
    }

    fn get() -> Req {
        Req::new("GET", false)
    }

    fn upgrade() -> Req {
        Req {
            uri: "/pty",
            ..Req::new("GET", true)
        }
        .add("upgrade", "websocket")
    }

    #[test]
    fn floor_table() {
        let wrong_secret = SECRET.replace('0', "1");
        let rows: Vec<(&str, Req, Result<(), Deny>)> = vec![
            ("correct GET", get(), Ok(())),
            ("correct POST", Req::new("POST", true), Ok(())),
            ("correct upgrade", upgrade(), Ok(())),
            (
                "wrong peer",
                Req {
                    peer: "192.0.2.2",
                    ..get()
                },
                Err(Deny::Source),
            ),
            (
                "loopback peer",
                Req {
                    peer: "127.0.0.1",
                    ..get()
                },
                Err(Deny::Source),
            ),
            (
                "IPv4-mapped peer",
                Req {
                    peer: "::ffff:192.0.2.1",
                    ..get()
                },
                Ok(()),
            ),
            (
                "absolute-form target",
                Req {
                    uri: "http://wb.example.org/api/info",
                    ..get()
                },
                Err(Deny::Target),
            ),
            (
                "asterisk-form target",
                Req {
                    method: "OPTIONS",
                    uri: "*",
                    ..Req::new("OPTIONS", true)
                },
                Err(Deny::Target),
            ),
            (
                "no secret",
                get().drop("x-workbench-proxy-secret"),
                Err(Deny::Secret),
            ),
            (
                "wrong secret, same length",
                get().set("x-workbench-proxy-secret", &wrong_secret),
                Err(Deny::Secret),
            ),
            (
                "secret one char short",
                get().set("x-workbench-proxy-secret", &SECRET[1..]),
                Err(Deny::Secret),
            ),
            (
                "secret one char long",
                get().set("x-workbench-proxy-secret", &format!("{SECRET}0")),
                Err(Deny::Secret),
            ),
            (
                "uppercase secret",
                get().set("x-workbench-proxy-secret", &SECRET.to_uppercase()),
                Err(Deny::Secret),
            ),
            (
                "two secrets, right first",
                get().add("x-workbench-proxy-secret", &wrong_secret),
                Err(Deny::Secret),
            ),
            (
                "two equal secrets",
                get().add("x-workbench-proxy-secret", SECRET),
                Err(Deny::Secret),
            ),
            (
                "X-Token instead of the secret",
                get()
                    .drop("x-workbench-proxy-secret")
                    .add("x-token", SECRET),
                Err(Deny::Secret),
            ),
            ("X-Token as well", get().add("x-token", "garbage"), Ok(())),
            (
                "?token= ignored",
                Req {
                    uri: "/api/info?token=garbage",
                    ..get()
                },
                Ok(()),
            ),
            ("no Host", get().drop("host"), Err(Deny::Host)),
            (
                "wrong Host",
                get().set("host", "evil.example.org"),
                Err(Deny::Host),
            ),
            (
                "Host case variant",
                get().set("host", "WB.Example.ORG"),
                Ok(()),
            ),
            (
                "Host with port",
                get().set("host", "wb.example.org:443"),
                Err(Deny::Host),
            ),
            ("two Hosts", get().add("host", HOST), Err(Deny::Host)),
            ("GET without Origin", get(), Ok(())),
            ("HEAD without Origin", Req::new("HEAD", false), Ok(())),
            ("GET with matching Origin", Req::new("GET", true), Ok(())),
            (
                "GET with foreign Origin",
                get().set("origin", "https://evil.example.org"),
                Err(Deny::Origin),
            ),
            (
                "GET with Origin: null",
                get().set("origin", "null"),
                Err(Deny::Origin),
            ),
            (
                "POST without Origin",
                Req::new("POST", false),
                Err(Deny::Origin),
            ),
            (
                "PUT without Origin",
                Req::new("PUT", false),
                Err(Deny::Origin),
            ),
            (
                "OPTIONS without Origin",
                Req::new("OPTIONS", false),
                Err(Deny::Origin),
            ),
            (
                "POST with foreign Origin",
                Req::new("POST", true).set("origin", "https://evil.example.org"),
                Err(Deny::Origin),
            ),
            (
                "Origin with a trailing slash",
                Req::new("POST", true).set("origin", "https://wb.example.org/"),
                Err(Deny::Origin),
            ),
            (
                "Origin case variant",
                Req::new("POST", true).set("origin", "https://WB.example.org"),
                Err(Deny::Origin),
            ),
            (
                "Origin with the default port",
                Req::new("POST", true).set("origin", "https://wb.example.org:443"),
                Err(Deny::Origin),
            ),
            (
                "Upgrade without Origin",
                upgrade().drop("origin"),
                Err(Deny::Origin),
            ),
            (
                "Upgrade with Origin: null",
                upgrade().set("origin", "null"),
                Err(Deny::Origin),
            ),
            (
                "Upgrade with foreign Origin",
                upgrade().set("origin", "https://evil.example.org"),
                Err(Deny::Origin),
            ),
            (
                "Upgrade: h2c without Origin",
                get().add("upgrade", "h2c"),
                Err(Deny::Origin),
            ),
            (
                "two Origins",
                Req::new("POST", true).add("origin", ORIGIN),
                Err(Deny::Origin),
            ),
            (
                "two Origins on GET",
                Req::new("GET", true).add("origin", ORIGIN),
                Err(Deny::Origin),
            ),
            (
                "the prototype handshake",
                Req {
                    uri: "/pty?token=",
                    ..get()
                }
                .drop("x-workbench-proxy-secret")
                .add("upgrade", "websocket"),
                Err(Deny::Secret),
            ),
            (
                "wrong peer beats the rest",
                Req {
                    peer: "192.0.2.2",
                    ..get().drop("x-workbench-proxy-secret").drop("host")
                },
                Err(Deny::Source),
            ),
        ];
        for (name, req, want) in rows {
            assert_eq!(req.check(), want, "{name}");
        }
    }

    #[test]
    fn csp_only_on_html() {
        let mut h = HeaderMap::new();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        security_headers(&mut h);
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(h[header::X_FRAME_OPTIONS], "DENY");
        assert!(h.get(header::CONTENT_SECURITY_POLICY).is_none());
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        security_headers(&mut h);
        assert_eq!(
            h[header::CONTENT_SECURITY_POLICY],
            "object-src 'none'; base-uri 'none'"
        );
    }
}
