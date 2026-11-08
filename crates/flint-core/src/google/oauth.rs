//! OAuth 2.0 for native apps (RFC 8252):
//! PKCE + loopback redirect on an ephemeral 127.0.0.1 port, the system
//! browser for the Google sign-in, then token exchange and the userinfo
//! fetch. [`RefreshTokenAuth`] keeps access tokens fresh from the stored
//! refresh token afterwards (what google-auth-library's OAuth2Client did).

use crate::google::gmail::{GResult, GmailError};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::Engine as _;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPES: [&str; 4] = ["https://www.googleapis.com/auth/gmail.modify", "openid", "email", "profile"];
const FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before Google's stated expiry
const EXPIRY_SLACK_MS: i64 = 60_000;

const LANDING_HTML: &str = r#"<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;background:#1F2124;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>Account connected</h2><p>You can close this tab and return to the app.</p></div>"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// unix ms when the access token expires
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthResult {
    pub tokens: TokenSet,
    /// Lowercased
    pub email: String,
    /// Google profile display name
    pub name: String,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64url(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    b64url(&buf)
}

/// PKCE verifier (128 chars of the unreserved set) and its S256 challenge
pub fn pkce_pair() -> (String, String) {
    let verifier = random_b64url(96);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn auth_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    let mut url = url::Url::parse(AUTH_URL).expect("static url");
    url.query_pairs_mut()
        .append_pair("access_type", "offline")
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", challenge)
        // Force the consent screen so Google always issues a refresh token,
        // including on account re-adds
        .append_pair("prompt", "consent")
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri);
    url.into()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct TokenErrorResponse {
    error: Option<String>,
    error_description: Option<String>,
}

fn token_error(status: u16, body: &str) -> String {
    match serde_json::from_str::<TokenErrorResponse>(body) {
        Ok(TokenErrorResponse { error: Some(e), error_description: Some(d) }) => format!("{e} ({d})"),
        Ok(TokenErrorResponse { error: Some(e), .. }) => e,
        _ => format!("status {status}"),
    }
}

/// POST the token endpoint; errors carry the HTTP status (0 offline)
async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> GResult<TokenResponse> {
    let res = http
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| GmailError::new(0, format!("Token request failed: {e}")))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| GmailError::new(0, format!("Token request failed: {e}")))?;
    if !(200..300).contains(&status) {
        return Err(GmailError::new(status, format!("Token request failed: {}", token_error(status, &body))));
    }
    serde_json::from_str(&body).map_err(|e| GmailError::new(status, format!("Token response unreadable: {e}")))
}

/// Read one HTTP request head off a loopback connection: the request target
async fn read_request_target(stream: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    let _method = parts.next()?;
    parts.next().map(str::to_string)
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(msg.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait for the redirect carrying the authorization code
async fn await_code(listener: TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let Some(target) = read_request_target(&mut stream).await else { continue };
        let url = match url::Url::parse(&format!("http://127.0.0.1{target}")) {
            Ok(u) => u,
            Err(_) => {
                respond(&mut stream, "400 Bad Request", "").await;
                continue;
            }
        };
        if url.path() != "/oauth2callback" {
            respond(&mut stream, "404 Not Found", "").await;
            continue;
        }
        let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
        let (code, cb_state, error) = (get("code"), get("state"), get("error"));
        respond(&mut stream, "200 OK", LANDING_HTML).await;
        if let Some(e) = error {
            bail!("Google returned: {e}");
        }
        match code {
            Some(c) if cb_state.as_deref() == Some(state) => return Ok(c),
            _ => bail!("Invalid OAuth callback"),
        }
    }
}

/// Run the browser flow. `open_browser` is handed the consent URL.
pub async fn run_auth_flow(
    http: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    open_browser: impl Fn(&str) -> Result<()>,
) -> Result<AuthResult> {
    let state = random_b64url(16);
    // Listen first so the redirect port is known
    let listener = TcpListener::bind("127.0.0.1:0").await.context("starting the sign-in listener")?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth2callback");
    let (verifier, challenge) = pkce_pair();
    let url = auth_url(client_id, &redirect_uri, &state, &challenge);
    if let Err(e) = open_browser(&url) {
        log::warn!("[oauth] could not open the browser ({e}); sign in at {url}");
    }

    let code = match tokio::time::timeout(FLOW_TIMEOUT, await_code(listener, &state)).await {
        Ok(r) => r?,
        Err(_) => bail!("Sign-in timed out (5 minutes) — try again"),
    };
    let tokens = token_request(
        http,
        &[
            ("code", &code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", &redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", &verifier),
        ],
    )
    .await?;
    let access_token = tokens.access_token.ok_or_else(|| anyhow!("Google did not return an access token — try again"))?;
    let refresh_token =
        tokens.refresh_token.ok_or_else(|| anyhow!("Google did not return a refresh token — try again"))?;

    let res = http.get(USERINFO_URL).bearer_auth(&access_token).send().await?;
    if !res.status().is_success() {
        bail!("Could not read Google profile ({})", res.status().as_u16());
    }
    #[derive(Deserialize)]
    struct Info {
        email: Option<String>,
        name: Option<String>,
    }
    let info: Info = res.json().await?;
    let email = info.email.ok_or_else(|| anyhow!("Google profile has no email address"))?;
    Ok(AuthResult {
        tokens: TokenSet {
            access_token,
            refresh_token,
            expires_at: now_ms() + tokens.expires_in.unwrap_or(3600) * 1000,
        },
        name: info.name.unwrap_or_else(|| email.clone()),
        email: email.to_lowercase(),
    })
}

/// Hands out access tokens for one account
#[async_trait]
pub trait TokenSource: Send + Sync {
    /// A valid access token; `force_refresh` discards the cached one first
    async fn access_token(&self, force_refresh: bool) -> GResult<String>;
}

type RotateFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Access tokens from a stored refresh token. Google can rotate the refresh
/// token; `on_rotate` persists whatever it hands back.
pub struct RefreshTokenAuth {
    http: reqwest::Client,
    client_id: String,
    client_secret: String,
    refresh_token: Mutex<String>,
    cached: Mutex<Option<(String, i64)>>,
    /// Serializes refreshes so concurrent requests share one
    gate: tokio::sync::Mutex<()>,
    on_rotate: RotateFn,
}

impl RefreshTokenAuth {
    pub fn new(
        http: reqwest::Client,
        client_id: String,
        client_secret: String,
        refresh_token: String,
        on_rotate: RotateFn,
    ) -> RefreshTokenAuth {
        RefreshTokenAuth {
            http,
            client_id,
            client_secret,
            refresh_token: Mutex::new(refresh_token),
            cached: Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
            on_rotate,
        }
    }

    fn fresh_cached(&self) -> Option<String> {
        let c = self.cached.lock().unwrap();
        c.as_ref().filter(|(_, exp)| *exp - EXPIRY_SLACK_MS > now_ms()).map(|(t, _)| t.clone())
    }
}

#[async_trait]
impl TokenSource for RefreshTokenAuth {
    async fn access_token(&self, force_refresh: bool) -> GResult<String> {
        if force_refresh {
            *self.cached.lock().unwrap() = None;
        } else if let Some(t) = self.fresh_cached() {
            return Ok(t);
        }
        let _gate = self.gate.lock().await;
        // Someone else may have refreshed while we waited
        if let Some(t) = self.fresh_cached() {
            return Ok(t);
        }
        let refresh = self.refresh_token.lock().unwrap().clone();
        let res = token_request(
            &self.http,
            &[
                ("refresh_token", &refresh),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("grant_type", "refresh_token"),
            ],
        )
        .await?;
        let token = res.access_token.ok_or_else(|| GmailError::new(500, "Token refresh returned no access token"))?;
        if let Some(rotated) = res.refresh_token.filter(|r| !r.is_empty() && *r != refresh) {
            *self.refresh_token.lock().unwrap() = rotated.clone();
            (self.on_rotate)(&rotated);
        }
        *self.cached.lock().unwrap() = Some((token.clone(), now_ms() + res.expires_in.unwrap_or(3600) * 1000));
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        let (v, c) = pkce_pair();
        assert_eq!(v.len(), 128);
        assert!(v.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        assert_eq!(c, b64url(&Sha256::digest(v.as_bytes())));
    }

    #[test]
    fn auth_url_asks_for_offline_consent_with_pkce() {
        let u = url::Url::parse(&auth_url("cid", "http://127.0.0.1:5/oauth2callback", "st", "ch")).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["scope"], "https://www.googleapis.com/auth/gmail.modify openid email profile");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5/oauth2callback");
        assert_eq!(q["response_type"], "code");
    }

    #[tokio::test]
    async fn loopback_listener_takes_the_code_and_ignores_other_paths() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { await_code(listener, "good").await });
        let get = |path: &'static str| async move {
            let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        };
        assert!(get("/favicon.ico").await.starts_with("HTTP/1.1 404"));
        assert!(get("/oauth2callback?code=abc&state=good").await.contains("Account connected"));
        assert_eq!(waiter.await.unwrap().unwrap(), "abc");

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port2 = listener.local_addr().unwrap().port();
        let waiter = tokio::spawn(async move { await_code(listener, "good").await });
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port2)).await.unwrap();
        s.write_all(b"GET /oauth2callback?code=abc&state=forged HTTP/1.1\r\n\r\n").await.unwrap();
        let err = waiter.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("Invalid OAuth callback"));
    }
}
