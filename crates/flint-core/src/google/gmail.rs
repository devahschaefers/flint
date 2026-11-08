//! Gmail REST v1 (port of `src/main/google/gmail.ts`): the [`GmailApi`]
//! trait the sync engine and outbox code against, a hand-written reqwest
//! client implementing it, and the message parsing pipeline.
//!
//! Errors are [`GmailError`] with the HTTP status (0 for transport errors),
//! because callers branch on it: 404 means gone (or history expired), 429
//! and 5xx are transient.

use crate::db::{BodyState, LabelState, ParsedMessage};
use crate::google::oauth::TokenSource;
use crate::storage::html_to_text::best_plain_text;
use crate::types::{Folder, Mailbox};
use async_trait::async_trait;
use base64::Engine as _;
use regex::Regex;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GmailError {
    /// HTTP status; 0 for transport-level failures (offline, DNS, reset)
    pub status: u16,
    pub message: String,
}

impl GmailError {
    pub fn new(status: u16, message: impl Into<String>) -> GmailError {
        GmailError { status, message: message.into() }
    }
}

impl fmt::Display for GmailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GmailError {}

pub type GResult<T> = Result<T, GmailError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub email_address: String,
    pub history_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListOpts {
    pub label_ids: Option<Vec<String>>,
    pub max_results: Option<u32>,
    pub q: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdPage {
    pub ids: Vec<String>,
    pub next_page_token: Option<String>,
}

/// One history record, normalized (nulls dropped)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryEntry {
    pub messages_added: Vec<String>,
    pub messages_deleted: Vec<String>,
    /// (message id, its labels after the change)
    pub label_changes: Vec<(String, Vec<String>)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryPage {
    pub history: Vec<HistoryEntry>,
    pub history_id: Option<String>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentRef {
    pub id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftRef {
    pub draft_id: String,
    pub message_id: String,
    pub thread_id: String,
}

/// Everything the engine asks of Gmail (the TS GmailApi class's surface)
#[async_trait]
pub trait GmailApi: Send + Sync {
    async fn get_profile(&self) -> GResult<Profile>;
    async fn list_message_ids(&self, page_token: Option<&str>, opts: ListOpts) -> GResult<IdPage>;
    /// Every message id carrying a label (or every id at all), across pages,
    /// deduplicated, in listing order (newest first, like the TS Set)
    async fn list_all_message_ids(&self, label_ids: Option<Vec<String>>) -> GResult<Vec<String>>;
    /// Gmail id of a message by its Message-ID header
    async fn find_by_message_id(&self, message_id_hdr: &str) -> GResult<Option<String>>;
    /// Full fetch; None when the message no longer exists
    async fn get_message(&self, id: &str) -> GResult<Option<ParsedMessage>>;
    /// Headers, labels, snippet, dates (bodies 'missing'); None when gone
    async fn get_message_metadata(&self, id: &str) -> GResult<Option<ParsedMessage>>;
    async fn list_history(&self, start_history_id: &str, page_token: Option<&str>) -> GResult<HistoryPage>;
    async fn batch_modify(&self, ids: &[String], add: &[&str], remove: &[&str]) -> GResult<()>;
    async fn send(&self, raw: &[u8], thread_id: Option<&str>) -> GResult<SentRef>;
    async fn create_draft(&self, raw: &[u8], thread_id: Option<&str>) -> GResult<DraftRef>;
    async fn update_draft(&self, draft_id: &str, raw: &[u8], thread_id: Option<&str>) -> GResult<DraftRef>;
    /// A 404 means it is already gone, which is the goal
    async fn delete_draft(&self, draft_id: &str) -> GResult<()>;
    /// The draft id wrapping a draft message id (synced drafts don't carry it)
    async fn find_draft_id_for_message(&self, message_id: &str) -> GResult<Option<String>>;
    async fn trash(&self, id: &str) -> GResult<()>;
    async fn untrash(&self, id: &str) -> GResult<()>;
}

// ---------- REST client ----------

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const RETRIABLE: [u16; 4] = [429, 500, 502, 503];

pub struct GmailClient {
    http: reqwest::Client,
    auth: Arc<dyn TokenSource>,
    base: String,
}

fn b64url(raw: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
}

/// Google's error JSON (`{"error": {"message": ...}}`), else the raw body
fn error_message(body: &str, status: u16) -> String {
    #[derive(Deserialize)]
    struct Env {
        error: Option<serde_json::Value>,
    }
    if let Ok(Env { error: Some(e) }) = serde_json::from_str::<Env>(body) {
        if let Some(m) = e.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
        if let Some(s) = e.as_str() {
            return s.to_string();
        }
    }
    if body.trim().is_empty() {
        format!("Request failed with status code {status}")
    } else {
        body.chars().take(300).collect()
    }
}

impl GmailClient {
    pub fn new(http: reqwest::Client, auth: Arc<dyn TokenSource>) -> GmailClient {
        GmailClient { http, auth, base: BASE.to_string() }
    }

    /// Point at another server (tests)
    pub fn with_base(mut self, base: impl Into<String>) -> GmailClient {
        self.base = base.into();
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    /// One API call with backoff on transient failures, as GmailError
    async fn call<T: DeserializeOwned>(
        &self,
        label: &str,
        build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder + Send + Sync,
    ) -> GResult<T> {
        let fail = |status: u16, msg: String| GmailError::new(status, format!("Gmail {label} failed: {msg}"));
        let mut refreshed = false;
        let mut attempt = 0u32;
        loop {
            let token = self.auth.access_token(false).await?;
            let res = build(&self.http).bearer_auth(&token).send().await;
            let res = match res {
                Ok(r) => r,
                Err(e) => return Err(fail(0, e.to_string())),
            };
            let status = res.status().as_u16();
            let body = match res.text().await {
                Ok(b) => b,
                Err(e) => return Err(fail(0, e.to_string())),
            };
            if (200..300).contains(&status) {
                let text = if body.trim().is_empty() { "{}" } else { body.as_str() };
                return serde_json::from_str(text).map_err(|e| fail(status, format!("unreadable response: {e}")));
            }
            // An access token Google no longer accepts: refresh once and retry
            if status == 401 && !refreshed {
                refreshed = true;
                self.auth.access_token(true).await?;
                continue;
            }
            if RETRIABLE.contains(&status) && attempt < 3 {
                tokio::time::sleep(Duration::from_millis(1000 * 2u64.pow(attempt))).await;
                attempt += 1;
                continue;
            }
            return Err(fail(status, error_message(&body, status)));
        }
    }

    async fn get_parsed(&self, id: &str, format: &str, state: BodyState) -> GResult<Option<ParsedMessage>> {
        let url = self.url(&format!("/messages/{}", urlencode(id)));
        let res: GResult<GmailMessage> =
            self.call("messages.get", |h| h.get(&url).query(&[("format", format)])).await;
        match res {
            Ok(m) => Ok(Some(parse_gmail_message(&m, state))),
            // Messages can vanish between list and get (e.g. spam purge)
            Err(e) if e.status == 404 => Ok(None),
            Err(e) => Err(e),
        }
    }
}

/// `threadId` only when there is one (JSON.stringify drops undefined)
fn with_thread(mut v: serde_json::Value, thread_id: Option<&str>) -> serde_json::Value {
    if let Some(t) = thread_id {
        v["threadId"] = json!(t);
    }
    v
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    #[serde(default)]
    messages: Vec<IdOnly>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
struct IdOnly {
    id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProfileResponse {
    email_address: Option<String>,
    history_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryMessage {
    id: Option<String>,
    #[serde(default)]
    label_ids: Vec<String>,
}

#[derive(Deserialize, Default)]
struct HistoryMessageRef {
    message: Option<HistoryMessage>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    #[serde(default)]
    messages_added: Vec<HistoryMessageRef>,
    #[serde(default)]
    messages_deleted: Vec<HistoryMessageRef>,
    #[serde(default)]
    labels_added: Vec<HistoryMessageRef>,
    #[serde(default)]
    labels_removed: Vec<HistoryMessageRef>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryResponse {
    #[serde(default)]
    history: Vec<HistoryRecord>,
    history_id: Option<String>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SendResponse {
    id: Option<String>,
    thread_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct DraftResponse {
    id: Option<String>,
    message: Option<SendResponse>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DraftListResponse {
    #[serde(default)]
    drafts: Vec<DraftResponse>,
    next_page_token: Option<String>,
}

#[async_trait]
impl GmailApi for GmailClient {
    async fn get_profile(&self) -> GResult<Profile> {
        let url = self.url("/profile");
        let p: ProfileResponse = self.call("getProfile", |h| h.get(&url)).await?;
        Ok(Profile { email_address: p.email_address.unwrap_or_default(), history_id: p.history_id.unwrap_or_default() })
    }

    async fn list_message_ids(&self, page_token: Option<&str>, opts: ListOpts) -> GResult<IdPage> {
        let url = self.url("/messages");
        let mut query: Vec<(&str, String)> = vec![
            ("maxResults", opts.max_results.unwrap_or(100).to_string()),
            ("includeSpamTrash", "true".into()),
        ];
        for l in opts.label_ids.iter().flatten() {
            query.push(("labelIds", l.clone()));
        }
        if let Some(q) = &opts.q {
            query.push(("q", q.clone()));
        }
        if let Some(t) = page_token {
            query.push(("pageToken", t.to_string()));
        }
        let res: ListResponse = self.call("messages.list", |h| h.get(&url).query(&query)).await?;
        Ok(IdPage {
            ids: res.messages.into_iter().filter_map(|m| m.id).collect(),
            next_page_token: res.next_page_token.filter(|t| !t.is_empty()),
        })
    }

    async fn list_all_message_ids(&self, label_ids: Option<Vec<String>>) -> GResult<Vec<String>> {
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = self
                .list_message_ids(
                    token.as_deref(),
                    ListOpts { label_ids: label_ids.clone(), max_results: Some(500), q: None },
                )
                .await?;
            ids.extend(page.ids.into_iter().filter(|id| seen.insert(id.clone())));
            token = page.next_page_token;
            if token.is_none() {
                return Ok(ids);
            }
        }
    }

    async fn find_by_message_id(&self, hdr: &str) -> GResult<Option<String>> {
        let page = self
            .list_message_ids(
                None,
                ListOpts { label_ids: None, max_results: Some(1), q: Some(format!("rfc822msgid:{hdr}")) },
            )
            .await?;
        Ok(page.ids.into_iter().next())
    }

    async fn get_message(&self, id: &str) -> GResult<Option<ParsedMessage>> {
        self.get_parsed(id, "full", BodyState::Full).await
    }

    async fn get_message_metadata(&self, id: &str) -> GResult<Option<ParsedMessage>> {
        self.get_parsed(id, "metadata", BodyState::Missing).await
    }

    async fn list_history(&self, start: &str, page_token: Option<&str>) -> GResult<HistoryPage> {
        let url = self.url("/history");
        let mut query: Vec<(&str, String)> = vec![("startHistoryId", start.to_string()), ("maxResults", "100".into())];
        if let Some(t) = page_token {
            query.push(("pageToken", t.to_string()));
        }
        let res: HistoryResponse = self.call("history.list", |h| h.get(&url).query(&query)).await?;
        let ids = |v: Vec<HistoryMessageRef>| -> Vec<String> {
            v.into_iter().filter_map(|m| m.message.and_then(|m| m.id)).collect()
        };
        let history = res
            .history
            .into_iter()
            .map(|h| HistoryEntry {
                messages_added: ids(h.messages_added),
                messages_deleted: ids(h.messages_deleted),
                label_changes: h
                    .labels_added
                    .into_iter()
                    .chain(h.labels_removed)
                    .filter_map(|l| l.message.and_then(|m| m.id.map(|id| (id, m.label_ids))))
                    .collect(),
            })
            .collect();
        Ok(HistoryPage {
            history,
            history_id: res.history_id,
            next_page_token: res.next_page_token.filter(|t| !t.is_empty()),
        })
    }

    async fn batch_modify(&self, ids: &[String], add: &[&str], remove: &[&str]) -> GResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let url = self.url("/messages/batchModify");
        let body = json!({ "ids": ids, "addLabelIds": add, "removeLabelIds": remove });
        let _: IgnoredAny = self.call("messages.batchModify", |h| h.post(&url).json(&body)).await?;
        Ok(())
    }

    async fn send(&self, raw: &[u8], thread_id: Option<&str>) -> GResult<SentRef> {
        let url = self.url("/messages/send");
        let body = with_thread(json!({ "raw": b64url(raw) }), thread_id);
        let res: SendResponse = self.call("messages.send", |h| h.post(&url).json(&body)).await?;
        Ok(SentRef { id: res.id.unwrap_or_default(), thread_id: res.thread_id.unwrap_or_default() })
    }

    async fn create_draft(&self, raw: &[u8], thread_id: Option<&str>) -> GResult<DraftRef> {
        let url = self.url("/drafts");
        let body = json!({ "message": with_thread(json!({ "raw": b64url(raw) }), thread_id) });
        let res: DraftResponse = self.call("drafts.create", |h| h.post(&url).json(&body)).await?;
        let m = res.message.unwrap_or_default();
        Ok(DraftRef {
            draft_id: res.id.unwrap_or_default(),
            message_id: m.id.unwrap_or_default(),
            thread_id: m.thread_id.unwrap_or_default(),
        })
    }

    async fn update_draft(&self, draft_id: &str, raw: &[u8], thread_id: Option<&str>) -> GResult<DraftRef> {
        let url = self.url(&format!("/drafts/{}", urlencode(draft_id)));
        let body = json!({ "message": with_thread(json!({ "raw": b64url(raw) }), thread_id) });
        let res: DraftResponse = self.call("drafts.update", |h| h.put(&url).json(&body)).await?;
        let m = res.message.unwrap_or_default();
        Ok(DraftRef {
            draft_id: res.id.unwrap_or_else(|| draft_id.to_string()),
            message_id: m.id.unwrap_or_default(),
            thread_id: m.thread_id.unwrap_or_default(),
        })
    }

    async fn delete_draft(&self, draft_id: &str) -> GResult<()> {
        let url = self.url(&format!("/drafts/{}", urlencode(draft_id)));
        match self.call::<IgnoredAny>("drafts.delete", |h| h.delete(&url)).await {
            Ok(_) => Ok(()),
            Err(e) if e.status == 404 => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn find_draft_id_for_message(&self, message_id: &str) -> GResult<Option<String>> {
        let url = self.url("/drafts");
        let mut token: Option<String> = None;
        loop {
            let mut query: Vec<(&str, String)> = vec![("maxResults", "500".into())];
            if let Some(t) = &token {
                query.push(("pageToken", t.clone()));
            }
            let res: DraftListResponse = self.call("drafts.list", |h| h.get(&url).query(&query)).await?;
            let hit = res
                .drafts
                .into_iter()
                .find(|d| d.message.as_ref().and_then(|m| m.id.as_deref()) == Some(message_id))
                .and_then(|d| d.id);
            if hit.is_some() {
                return Ok(hit);
            }
            token = res.next_page_token.filter(|t| !t.is_empty());
            if token.is_none() {
                return Ok(None);
            }
        }
    }

    async fn trash(&self, id: &str) -> GResult<()> {
        let url = self.url(&format!("/messages/{}/trash", urlencode(id)));
        let _: IgnoredAny = self.call("messages.trash", |h| h.post(&url)).await?;
        Ok(())
    }

    async fn untrash(&self, id: &str) -> GResult<()> {
        let url = self.url(&format!("/messages/{}/untrash", urlencode(id)));
        let _: IgnoredAny = self.call("messages.untrash", |h| h.post(&url)).await?;
        Ok(())
    }
}

// ---------- parsing ----------

/// Gmail's Message resource (the parts the parser reads)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: Option<String>,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub label_ids: Option<Vec<String>>,
    pub snippet: Option<String>,
    pub internal_date: Option<String>,
    pub payload: Option<MessagePart>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePart {
    pub mime_type: Option<String>,
    pub filename: Option<String>,
    #[serde(default)]
    pub headers: Option<Vec<Header>>,
    pub body: Option<PartBody>,
    #[serde(default)]
    pub parts: Option<Vec<MessagePart>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Header {
    pub name: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PartBody {
    pub data: Option<String>,
}

static ANGLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)<([^<>]+)>\s*$").unwrap());
static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"(.*)"$"#).unwrap());
static BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<|>$").unwrap());

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Minimal RFC 5322 address-list parser (same forms the TS parser handles)
pub fn parse_address_list(input: Option<&str>) -> Vec<Mailbox> {
    let Some(input) = input.filter(|s| !s.is_empty()) else { return Vec::new() };
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut in_angle = false;
    for ch in input.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
        } else if ch == '<' && !in_quotes {
            in_angle = true;
        } else if ch == '>' && !in_quotes {
            in_angle = false;
        }
        if ch == ',' && !in_quotes && !in_angle {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    parts.push(current);

    let mut out = Vec::new();
    for raw in parts {
        let trimmed = js_trim(&raw);
        if trimmed.is_empty() {
            continue;
        }
        if let Some(c) = ANGLE.captures(trimmed) {
            let name = js_trim(&QUOTED.replace(js_trim(&c[1]), "$1")).to_string();
            let address = js_trim(&c[2]).to_lowercase();
            if address.contains('@') {
                out.push(Mailbox { name: (!name.is_empty()).then_some(name), address });
            }
        } else if trimmed.contains('@') {
            out.push(Mailbox { name: None, address: BRACKETS.replace_all(trimmed, "").to_lowercase() });
        }
    }
    out
}

/// Node's lenient base64url decode (padding optional, standard alphabet tolerated)
fn decode_part_data(data: &str) -> String {
    let cleaned: String = data
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cleaned.as_bytes()).unwrap_or_else(|_| {
        // Trailing garbage: decode what forms whole quanta, as Node does
        let usable = cleaned.len() - cleaned.len() % 4;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&cleaned.as_bytes()[..usable]).unwrap_or_default()
    });
    String::from_utf8_lossy(&bytes).into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bodies {
    pub text: String,
    pub html: Option<String>,
    pub has_calendar: bool,
}

/// Depth-first walk for the first text/plain and text/html parts, plus
/// calendar detection; HTML-only (or token-text) mail gets derived text
pub fn extract_bodies(part: Option<&MessagePart>) -> Bodies {
    fn walk(p: &MessagePart, text: &mut String, html: &mut Option<String>, cal: &mut bool) {
        let mime = p.mime_type.as_deref().unwrap_or("");
        if mime == "text/calendar" || p.filename.as_deref().unwrap_or("").to_lowercase().ends_with(".ics") {
            *cal = true;
        }
        let data = p.body.as_ref().and_then(|b| b.data.as_deref()).filter(|d| !d.is_empty());
        match data {
            Some(d) if mime == "text/plain" && text.is_empty() => *text = decode_part_data(d),
            Some(d) if mime == "text/html" && html.is_none() => *html = Some(decode_part_data(d)),
            _ => {}
        }
        for child in p.parts.iter().flatten() {
            walk(child, text, html, cal);
        }
    }
    let mut text = String::new();
    let mut html = None;
    let mut has_calendar = false;
    if let Some(p) = part {
        walk(p, &mut text, &mut html, &mut has_calendar);
    }
    Bodies { text: best_plain_text(&text, html.as_deref()), html, has_calendar }
}

/// Gmail snippets are HTML-entity encoded (same replacement order as TS)
fn decode_snippet(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

pub fn labels_to_state(labels: &[String]) -> LabelState {
    let has = |l: &str| labels.iter().any(|x| x == l);
    let folder = if has("DRAFT") {
        Folder::Drafts
    } else if has("SPAM") {
        Folder::Spam
    } else if has("TRASH") {
        Folder::Trash
    } else if has("INBOX") {
        Folder::Inbox
    } else if has("SENT") {
        Folder::Sent
    } else {
        Folder::Archive
    };
    LabelState { folder, seen: !has("UNREAD"), flagged: has("STARRED"), important: has("IMPORTANT") }
}

pub fn category_of(labels: &[String], has_calendar: bool) -> &'static str {
    let has = |l: &str| labels.iter().any(|x| x == l);
    if has_calendar {
        return "invites";
    }
    if has("CATEGORY_PERSONAL") {
        return "people";
    }
    if has("CATEGORY_UPDATES") || has("CATEGORY_PROMOTIONS") || has("CATEGORY_SOCIAL") || has("CATEGORY_FORUMS") {
        return "notifications";
    }
    "people"
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn parse_gmail_message(res: &GmailMessage, body_state: BodyState) -> ParsedMessage {
    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(hs) = res.payload.as_ref().and_then(|p| p.headers.as_ref()) {
        for h in hs {
            if let (Some(name), Some(value)) = (&h.name, &h.value) {
                let key = name.to_lowercase();
                if !key.is_empty() {
                    headers.entry(key).or_insert_with(|| value.clone());
                }
            }
        }
    }
    let header = |k: &str| headers.get(k).map(String::as_str);
    let labels: &[String] = res.label_ids.as_deref().unwrap_or(&[]);
    let bodies = extract_bodies(res.payload.as_ref());
    let from = parse_address_list(header("from")).into_iter().next().unwrap_or_default();
    let reply_to = parse_address_list(header("reply-to")).into_iter().next();
    let references = header("references")
        .unwrap_or("")
        .split(|c: char| c.is_whitespace())
        .filter(|r| r.starts_with('<'))
        .map(str::to_string)
        .collect();
    let state = labels_to_state(labels);
    // Number(internalDate ?? Date.now()); a non-numeric value is NaN in JS, 0 here
    let date_ms = match &res.internal_date {
        Some(d) => d.trim().parse::<f64>().map(|f| f as i64).unwrap_or(0),
        None => now_ms(),
    };
    ParsedMessage {
        gmail_id: res.id.clone().unwrap_or_default(),
        thread_id: res.thread_id.clone().unwrap_or_default(),
        message_id_hdr: header("message-id").map(str::to_string),
        in_reply_to: header("in-reply-to").map(str::to_string),
        references,
        from_name: from.name,
        from_addr: from.address,
        to: parse_address_list(header("to")),
        cc: parse_address_list(header("cc")),
        reply_to,
        subject: header("subject").unwrap_or("").to_string(),
        date_ms,
        snippet: decode_snippet(res.snippet.as_deref().unwrap_or("")),
        body_text: bodies.text,
        body_html: bodies.html,
        body_state,
        folder: state.folder,
        seen: state.seen,
        flagged: state.flagged,
        category: category_of(labels, bodies.has_calendar).to_string(),
        important: state.important,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        b64url(s.as_bytes())
    }

    fn part(mime: &str, data: &str) -> serde_json::Value {
        json!({ "mimeType": mime, "body": { "data": b64(data) } })
    }

    fn message(mut payload: serde_json::Value) -> GmailMessage {
        payload["headers"] = json!([
            { "name": "From", "value": "Sender <sender@example.com>" },
            { "name": "Subject", "value": "Hello" },
            { "name": "Message-ID", "value": "<m1@example.com>" }
        ]);
        serde_json::from_value(json!({
            "id": "g1",
            "threadId": "t1",
            "labelIds": ["INBOX", "UNREAD"],
            "internalDate": "1700000000000",
            "snippet": "snip &amp; more",
            "payload": payload
        }))
        .unwrap()
    }

    #[test]
    fn keeps_a_real_text_part_alongside_html() {
        let m = message(json!({
            "mimeType": "multipart/alternative",
            "parts": [part("text/plain", "The plain version of this message."), part("text/html", "<p>The <b>HTML</b> version</p>")]
        }));
        let p = parse_gmail_message(&m, BodyState::Full);
        assert_eq!(p.body_text, "The plain version of this message.");
        assert_eq!(p.body_html.as_deref(), Some("<p>The <b>HTML</b> version</p>"));
        assert_eq!(p.body_state, BodyState::Full);
        assert_eq!(p.date_ms, 1_700_000_000_000);
        assert_eq!(p.message_id_hdr.as_deref(), Some("<m1@example.com>"));
    }

    #[test]
    fn derives_text_from_html_only_mail() {
        let m = message(part(
            "text/html",
            "<html><head><style>p{}</style></head><body><h1>Invoice #42</h1><p>Amount due: &euro;12</p></body></html>",
        ));
        let p = parse_gmail_message(&m, BodyState::Full);
        assert_eq!(p.body_text, "Invoice #42\nAmount due: €12");
        assert!(p.body_html.unwrap().contains("<h1>Invoice #42</h1>"));
    }

    #[test]
    fn replaces_a_token_text_part() {
        let m = message(json!({
            "mimeType": "multipart/alternative",
            "parts": [part("text/plain", "View online"), part("text/html", "<p>Your order has shipped and will arrive Tuesday.</p>")]
        }));
        assert_eq!(parse_gmail_message(&m, BodyState::Full).body_text, "Your order has shipped and will arrive Tuesday.");
    }

    #[test]
    fn finds_nested_parts_and_flags_calendar_invites() {
        let p: MessagePart = serde_json::from_value(json!({
            "mimeType": "multipart/mixed",
            "parts": [
                { "mimeType": "multipart/alternative", "parts": [part("text/plain", "Meeting at ten, bring the slides."), part("text/html", "<p>x</p>")] },
                { "mimeType": "text/calendar", "filename": "invite.ics", "body": { "data": b64("BEGIN:VCALENDAR") } }
            ]
        }))
        .unwrap();
        assert_eq!(
            extract_bodies(Some(&p)),
            Bodies { text: "Meeting at ten, bring the slides.".into(), html: Some("<p>x</p>".into()), has_calendar: true }
        );
    }

    #[test]
    fn metadata_only_fetch_is_missing_its_bodies() {
        let m = message(json!({ "mimeType": "multipart/alternative", "parts": [] }));
        let p = parse_gmail_message(&m, BodyState::Missing);
        assert_eq!(p.gmail_id, "g1");
        assert_eq!(p.thread_id, "t1");
        assert_eq!(p.subject, "Hello");
        assert_eq!(p.from_addr, "sender@example.com");
        assert_eq!(p.from_name.as_deref(), Some("Sender"));
        assert_eq!(p.snippet, "snip & more");
        assert_eq!(p.body_text, "");
        assert_eq!(p.body_html, None);
        assert_eq!(p.body_state, BodyState::Missing);
        assert_eq!(p.folder, Folder::Inbox);
        assert!(!p.seen);
    }

    #[test]
    fn parses_address_lists() {
        let mb = |n: Option<&str>, a: &str| Mailbox { name: n.map(str::to_string), address: a.into() };
        assert_eq!(
            parse_address_list(Some(r#""Doe, Jane" <Jane@X.com>, bob@y.com, <c@z.com>, Name Only, Al <al@q.io> "#)),
            vec![mb(Some("Doe, Jane"), "jane@x.com"), mb(None, "bob@y.com"), mb(None, "c@z.com"), mb(Some("Al"), "al@q.io")]
        );
        assert_eq!(parse_address_list(None), vec![]);
        assert_eq!(parse_address_list(Some("<nobody>")), vec![]);
    }

    #[test]
    fn labels_and_categories() {
        let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(labels_to_state(&l(&["INBOX", "DRAFT"])).folder, Folder::Drafts);
        assert_eq!(labels_to_state(&l(&["INBOX", "SPAM"])).folder, Folder::Spam);
        assert_eq!(labels_to_state(&l(&["TRASH", "INBOX"])).folder, Folder::Trash);
        assert_eq!(labels_to_state(&l(&["SENT", "INBOX"])).folder, Folder::Inbox);
        assert_eq!(labels_to_state(&l(&["SENT"])).folder, Folder::Sent);
        let s = labels_to_state(&l(&["STARRED", "IMPORTANT"]));
        assert_eq!((s.folder, s.seen, s.flagged, s.important), (Folder::Archive, true, true, true));
        assert_eq!(category_of(&l(&["CATEGORY_PROMOTIONS"]), false), "notifications");
        assert_eq!(category_of(&l(&["CATEGORY_PERSONAL", "CATEGORY_UPDATES"]), false), "people");
        assert_eq!(category_of(&l(&["CATEGORY_UPDATES"]), true), "invites");
        assert_eq!(category_of(&[], false), "people");
    }

    #[test]
    fn snippet_entities_decode_in_order() {
        assert_eq!(decode_snippet("a &amp;lt; b &#39;c&#39; &quot;d&quot;&nbsp;e"), "a < b 'c' \"d\" e");
    }

    #[test]
    fn references_keep_only_message_ids() {
        let mut m = message(json!({ "mimeType": "text/plain" }));
        m.payload.as_mut().unwrap().headers.as_mut().unwrap().push(Header {
            name: Some("References".into()),
            value: Some("<a@x>  junk\n <b@y>".into()),
        });
        assert_eq!(parse_gmail_message(&m, BodyState::Full).references, vec!["<a@x>", "<b@y>"]);
    }

    #[test]
    fn decodes_padded_and_standard_base64() {
        assert_eq!(decode_part_data("aGk_"), String::from_utf8_lossy(&[0x68, 0x69, 0x3f]));
        assert_eq!(decode_part_data("aGVsbG8="), "hello");
        assert_eq!(decode_part_data("aGVs\nbG8"), "hello");
    }

    #[test]
    fn error_messages_come_from_google_json() {
        assert_eq!(error_message(r#"{"error":{"code":404,"message":"Requested entity was not found."}}"#, 404), "Requested entity was not found.");
        assert_eq!(error_message("", 502), "Request failed with status code 502");
    }
}
