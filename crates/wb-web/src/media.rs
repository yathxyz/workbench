//! Image providers for the canvas's media cards (F-A41): `POST /api/media` runs one
//! `imagine` (text to images) or `edit` (an image and text to images) on a provider that
//! `web.json`'s `media.providers` names, stores what comes back in the blob store and
//! answers the hashes. `/api/info` lists the providers as `media`, without their keys.
//!
//! The provider is called from here, never from the page, so its key stays on the
//! server. Two protocols cover the services worth having: the OpenAI image API (OpenAI,
//! xAI, LocalAI and other servers that copy it) and Hugging Face Inference. Describe and
//! expand are text and go through `sample`, so a media card works with any model the
//! server has.

use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::blobs;
use crate::config::{MediaApi, MediaProvider};
use crate::http::{ApiError, Body};

/// The most images one run makes.
const N_MAX: u32 = 4;
/// A provider that has not answered by then has failed.
const TIMEOUT: Duration = Duration::from_secs(240);
/// The longest prompt sent, in bytes.
const PROMPT_MAX: usize = 32 << 10;
/// The most of a provider's error text an answer repeats.
const ERROR_SHOWN: usize = 400;

pub fn routes() -> Router<AppState> {
    Router::new().route("/media", post(run))
}

/// `/api/info`'s `media`: each provider's name, protocol, models and operations.
pub fn catalog(app: &AppState) -> Value {
    let providers = app.cfg.media.iter().flat_map(|m| &m.providers);
    Value::Array(
        providers
            .map(|(name, p)| {
                json!({
                    "name": name,
                    "api": match p.api { MediaApi::Openai => "openai", MediaApi::Huggingface => "huggingface" },
                    "models": p.models,
                    "ops": ["imagine", "edit"],
                })
            })
            .collect(),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunRequest {
    provider: String,
    model: Option<String>,
    op: Op,
    prompt: String,
    n: Option<u32>,
    /// `WxH`, e.g. `1024x1024`; the provider's default when absent.
    size: Option<String>,
    /// The blob hash of the image an `edit` starts from.
    image: Option<String>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Op {
    Imagine,
    Edit,
}

/// A failed run: the status and the message the card shows.
struct Fail(StatusCode, String);

impl Fail {
    fn bad(msg: impl Into<String>) -> Self {
        Fail(StatusCode::BAD_REQUEST, msg.into())
    }
    fn upstream(msg: impl Into<String>) -> Self {
        Fail(StatusCode::BAD_GATEWAY, msg.into())
    }
}

async fn run(State(app): State<AppState>, Body(body): Body) -> Response {
    let req: RunRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(e) => {
            return ApiError::new(StatusCode::BAD_REQUEST, format!("invalid request: {e}"))
                .into_response();
        }
    };
    match generate(&app, &req).await {
        Ok(images) => {
            let mut out = Vec::new();
            for (bytes, kind) in images {
                let size = bytes.len();
                match blobs::store(&app, bytes).await {
                    Ok(hash) => out.push(json!({"hash": hash, "type": kind, "size": size})),
                    Err(e) => {
                        tracing::error!(error = %e, "cannot store a generated image");
                        return ApiError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "cannot store the image",
                        )
                        .into_response();
                    }
                }
            }
            Json(json!({"images": out})).into_response()
        }
        Err(Fail(status, msg)) => ApiError::new(status, msg).into_response(),
    }
}

async fn generate(app: &AppState, req: &RunRequest) -> Result<Vec<(Vec<u8>, &'static str)>, Fail> {
    let p = app
        .cfg
        .media
        .as_ref()
        .and_then(|m| m.providers.get(&req.provider))
        .ok_or_else(|| {
            Fail::bad(format!(
                "no media provider {:?} on this server",
                req.provider
            ))
        })?;
    let model = match &req.model {
        Some(m) if p.models.contains(m) => m.clone(),
        Some(m) => return Err(Fail::bad(format!("{} offers no model {m:?}", req.provider))),
        None => p.models[0].clone(),
    };
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err(Fail::bad("the prompt is empty"));
    }
    if prompt.len() > PROMPT_MAX {
        return Err(Fail::bad("the prompt is too long (32 KiB at most)"));
    }
    let n = req.n.unwrap_or(1).clamp(1, N_MAX);
    let size = match &req.size {
        Some(s) => {
            Some(parse_size(s).ok_or_else(|| Fail::bad("size must be WxH, e.g. 1024x1024"))?)
        }
        None => None,
    };
    let image = match (req.op, &req.image) {
        (Op::Edit, Some(hash)) => Some(
            blobs::read_image(app, hash)
                .await
                .ok_or_else(|| Fail::bad("the image to edit is not on this server"))?,
        ),
        (Op::Edit, None) => return Err(Fail::bad("edit needs an image")),
        (Op::Imagine, _) => None,
    };
    let key = read_key(p).await?;
    let call = Call {
        p,
        key: key.as_deref(),
        model: &model,
        prompt,
        n,
        size,
    };
    let images = match p.api {
        MediaApi::Openai => call.openai(image.as_ref()).await?,
        MediaApi::Huggingface => call.huggingface(image.as_ref()).await?,
    };
    if images.is_empty() {
        return Err(Fail::upstream(format!(
            "{} answered with no image",
            req.provider
        )));
    }
    Ok(images)
}

/// `1024x1024` as (1024, 1024): each side 64 to 4096.
fn parse_size(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.split_once(['x', 'X'])?;
    let side = |v: &str| v.parse::<u32>().ok().filter(|n| (64..=4096).contains(n));
    Some((side(w)?, side(h)?))
}

async fn read_key(p: &MediaProvider) -> Result<Option<String>, Fail> {
    let Some(path) = &p.key_file else {
        return Ok(None);
    };
    match tokio::fs::read_to_string(path).await {
        Ok(k) if !k.trim().is_empty() => Ok(Some(k.trim().to_owned())),
        // The path is the operator's; the key never appears in a message.
        _ => Err(Fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "the media provider's key file cannot be read on this server".into(),
        )),
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let base = || {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
        };
        base().build().unwrap_or_else(|e| {
            // No system certificates (a build sandbox, an SSL_CERT_FILE naming no file): a
            // loopback http provider still works, an https one fails its handshake and says so.
            tracing::warn!(error = %e, "media: no system certificates; https providers will fail");
            base()
                .tls_certs_only([])
                .build()
                .expect("a client with an empty root store")
        })
    })
}

struct Call<'a> {
    p: &'a MediaProvider,
    key: Option<&'a str>,
    model: &'a str,
    prompt: &'a str,
    n: u32,
    size: Option<(u32, u32)>,
}

impl Call<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}/{path}", self.p.base_url.trim_end_matches('/'))
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        }
    }

    /// `POST /images/generations` (JSON) or `/images/edits` (multipart). Each image
    /// comes back as `b64_json`, or as an https `url` fetched here.
    async fn openai(
        &self,
        image: Option<&(Vec<u8>, &'static str)>,
    ) -> Result<Vec<(Vec<u8>, &'static str)>, Fail> {
        let size = self.size.map(|(w, h)| format!("{w}x{h}"));
        let rb = match image {
            None => {
                let mut body = json!({"model": self.model, "prompt": self.prompt, "n": self.n});
                if let Some(s) = &size {
                    body["size"] = json!(s);
                }
                self.auth(client().post(self.url("images/generations")))
                    .json(&body)
            }
            Some((bytes, kind)) => {
                let mut parts: Vec<(&str, Part)> = vec![
                    ("model", Part::Text(self.model.into())),
                    ("prompt", Part::Text(self.prompt.into())),
                    ("n", Part::Text(self.n.to_string())),
                    ("image", Part::File(bytes, kind)),
                ];
                if let Some(s) = size {
                    parts.push(("size", Part::Text(s)));
                }
                let (boundary, body) = multipart(&parts);
                self.auth(client().post(self.url("images/edits")))
                    .header(
                        "Content-Type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(body)
            }
        };
        let res = send(rb).await?;
        let v: Value = res
            .json()
            .await
            .map_err(|_| Fail::upstream("the provider's answer is not JSON"))?;
        let mut out = Vec::new();
        for item in v["data"].as_array().into_iter().flatten() {
            let bytes = if let Some(b64) = item["b64_json"].as_str() {
                base64_decode(b64).ok_or_else(|| Fail::upstream("the provider sent bad base64"))?
            } else if let Some(url) = item["url"].as_str().filter(|u| u.starts_with("https://")) {
                let r = send(client().get(url)).await?;
                r.bytes()
                    .await
                    .map_err(|e| Fail::upstream(format!("cannot fetch the image: {e}")))?
                    .to_vec()
            } else {
                continue;
            };
            out.push(image_of(bytes)?);
        }
        Ok(out)
    }

    /// `POST /models/{model}`: `{"inputs": prompt}` for text to image, or the image as
    /// base64 with the prompt in `parameters` for image to image. The answer is the
    /// image's bytes. One image per request, so `n` runs send `n` requests with
    /// different seeds.
    async fn huggingface(
        &self,
        image: Option<&(Vec<u8>, &'static str)>,
    ) -> Result<Vec<(Vec<u8>, &'static str)>, Fail> {
        let mut out = Vec::new();
        for i in 0..self.n {
            let mut params = json!({});
            if self.n > 1 {
                params["seed"] = json!(seed() + u64::from(i));
            }
            // text to image takes the size as flat fields, image to image as `target_size`
            if let Some((w, h)) = self.size {
                if image.is_some() {
                    params["target_size"] = json!({"width": w, "height": h});
                } else {
                    params["width"] = json!(w);
                    params["height"] = json!(h);
                }
            }
            let body = match image {
                None => json!({"inputs": self.prompt, "parameters": params}),
                Some((bytes, _)) => {
                    params["prompt"] = json!(self.prompt);
                    json!({"inputs": base64_encode(bytes), "parameters": params})
                }
            };
            let rb = self
                .auth(client().post(self.url(&format!("models/{}", self.model))))
                .header("Accept", "image/png")
                .json(&body);
            let res = send(rb).await?;
            let bytes = res
                .bytes()
                .await
                .map_err(|e| Fail::upstream(format!("cannot read the image: {e}")))?;
            out.push(image_of(bytes.to_vec())?);
        }
        Ok(out)
    }
}

/// Sends `rb`; a failure or an error status is a `Fail` carrying the provider's own
/// message, cut short.
async fn send(rb: reqwest::RequestBuilder) -> Result<reqwest::Response, Fail> {
    let res = rb.send().await.map_err(|e| {
        Fail::upstream(if e.is_timeout() {
            "the provider did not answer in time".to_owned()
        } else {
            format!("cannot reach the provider: {}", e.without_url())
        })
    })?;
    if res.status().is_success() {
        return Ok(res);
    }
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            [
                &v["error"]["message"],
                &v["error"],
                &v["message"],
                &v["detail"],
            ]
            .into_iter()
            .find_map(|m| m.as_str().map(str::to_owned))
        })
        .unwrap_or(text);
    let mut msg: String = msg.chars().filter(|c| !c.is_control()).collect();
    if msg.len() > ERROR_SHOWN {
        let mut cut = ERROR_SHOWN;
        while !msg.is_char_boundary(cut) {
            cut -= 1;
        }
        msg.truncate(cut);
        msg.push('…');
    }
    Err(Fail::upstream(format!(
        "the provider answered {status}: {msg}"
    )))
}

fn image_of(bytes: Vec<u8>) -> Result<(Vec<u8>, &'static str), Fail> {
    match blobs::sniff(&bytes) {
        Some(kind) => Ok((bytes, kind)),
        None => Err(Fail::upstream(
            "the provider answered with something that is not an image",
        )),
    }
}

fn seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64 & 0xffff_ffff)
}

enum Part<'a> {
    Text(String),
    File(&'a [u8], &'static str),
}

/// A `multipart/form-data` body: the boundary and the bytes.
fn multipart(parts: &[(&str, Part)]) -> (String, Vec<u8>) {
    let boundary = format!(
        "wb-media-{:016x}",
        seed().wrapping_mul(0x9e37_79b9_7f4a_7c15)
    );
    let mut body = Vec::new();
    for (name, part) in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match part {
            Part::Text(t) => {
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                );
                body.extend_from_slice(t.as_bytes());
            }
            Part::File(bytes, kind) => {
                let ext = kind.trim_start_matches("image/");
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"image.{ext}\"\r\nContent-Type: {kind}\r\n\r\n")
                        .as_bytes(),
                );
                body.extend_from_slice(bytes);
            }
        }
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (boundary, body)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Standard base64, padding optional, whitespace ignored; `None` on any other byte.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        for len in 0..40 {
            let b: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(base64_decode(&base64_encode(&b)).unwrap(), b, "{len}");
        }
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_decode("TWE").unwrap(), b"Ma");
        assert!(base64_decode("TW*=").is_none());
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("1024x768"), Some((1024, 768)));
        assert_eq!(parse_size("512X512"), Some((512, 512)));
        for no in ["1024", "0x512", "99999x1", "axb", "1024x"] {
            assert_eq!(parse_size(no), None, "{no}");
        }
    }

    #[test]
    fn multipart_body() {
        let (b, body) = multipart(&[
            ("prompt", Part::Text("a cat".into())),
            ("image", Part::File(b"PNG", "image/png")),
        ]);
        let s = String::from_utf8_lossy(&body);
        assert!(s.starts_with(&format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\na cat\r\n"
        )));
        assert!(s.contains(
            "name=\"image\"; filename=\"image.png\"\r\nContent-Type: image/png\r\n\r\nPNG\r\n"
        ));
        assert!(s.ends_with(&format!("--{b}--\r\n")));
    }
}
