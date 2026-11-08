//! Message rows: sync writes, the full-text index, body compaction, and
//! locally-authored mail (db.ts, from "synced messages" to "outbox").

use super::Db;
use crate::storage::bodies::{decode_body, encode_body, stored_size, StoredBody, DEFAULT_CODEC};
use crate::storage::html_to_text::best_plain_text;
use crate::storage::search::build_match_expression;
use crate::types::{Folder, LocalMessageInput, Mailbox, MessageState, WireMessage};
use anyhow::Result;
use rusqlite::{named_params, params, Connection, ErrorCode, OptionalExtension};
use serde::de::DeserializeOwned;
use std::collections::HashSet;

/// 'missing': metadata-only row whose bodies are still to be fetched
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BodyState {
    #[default]
    Full,
    Missing,
}

impl BodyState {
    pub fn as_str(self) -> &'static str {
        match self {
            BodyState::Full => "full",
            BodyState::Missing => "missing",
        }
    }
}

/// Column-shaped message record (what the sync engine writes; db.MsgRecord
/// minus accountId, which `upsert_messages` takes separately)
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMessage {
    pub gmail_id: String,
    pub thread_id: String,
    pub message_id_hdr: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub from_name: Option<String>,
    pub from_addr: String,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub reply_to: Option<Mailbox>,
    pub subject: String,
    pub date_ms: i64,
    pub snippet: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub body_state: BodyState,
    pub folder: Folder,
    pub seen: bool,
    pub flagged: bool,
    pub category: String,
    pub important: bool,
}

/// Folder + flags derived from Gmail labels
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LabelState {
    pub folder: Folder,
    pub seen: bool,
    pub flagged: bool,
    pub important: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    /// messages.id (the FTS rowid)
    pub message_id: i64,
    pub thread_id: Option<String>,
    pub account_id: String,
    /// bm25 score: lower is better
    pub rank: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CompactBatch {
    pub processed: u64,
    pub remaining: u64,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub text_derived: u64,
}

/// A local message row: what the outbox needs to build and send it
#[derive(Debug, Clone, PartialEq)]
pub struct LocalMessage {
    pub account_id: String,
    pub message_id_hdr: String,
    pub gmail_id: Option<String>,
    pub gmail_draft_id: Option<String>,
    pub thread_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub state: MessageState,
    pub send_after: Option<i64>,
}

/// A partial update of a local row (setLocalState's patch); `None` leaves a
/// column alone, `Some(None)` writes NULL
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LocalPatch {
    pub state: Option<MessageState>,
    pub folder: Option<Folder>,
    pub send_after: Option<Option<i64>>,
    pub send_error: Option<Option<String>>,
    pub gmail_id: Option<Option<String>>,
    pub gmail_draft_id: Option<Option<String>>,
    pub thread_id: Option<Option<String>>,
}

/// Sync writes (db.ts UPSERT_SQL, unchanged)
const UPSERT_SQL: &str = "
INSERT INTO messages (
  account_id, gmail_id, thread_id, message_id_hdr, in_reply_to, refs,
  from_name, from_addr, to_json, cc_json, reply_to_json,
  subject, date, snippet, body_text, body_html, body_codec, body_state,
  folder, seen, flagged, category, important, state
) VALUES (
  @accountId, @gmailId, @threadId, @messageIdHdr, @inReplyTo, @refs,
  @fromName, @fromAddr, @toJson, @ccJson, @replyToJson,
  @subject, @dateMs, @snippet, @bodyText, @bodyHtml, @bodyCodec, @bodyState,
  @folder, @seen, @flagged, @category, @important, 'synced'
)
ON CONFLICT(account_id, gmail_id) DO UPDATE SET
  folder = excluded.folder,
  seen = excluded.seen,
  flagged = excluded.flagged,
  category = excluded.category,
  important = excluded.important,
  snippet = CASE WHEN messages.snippet = '' THEN excluded.snippet ELSE messages.snippet END,
  state = CASE WHEN messages.state IN ('sent', 'synced') THEN 'synced' ELSE messages.state END,
  body_text = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN excluded.body_text ELSE messages.body_text END,
  body_html = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN excluded.body_html ELSE messages.body_html END,
  body_codec = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN excluded.body_codec ELSE messages.body_codec END,
  body_state = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN 'full' ELSE messages.body_state END
ON CONFLICT(account_id, message_id_hdr) DO UPDATE SET
  gmail_id = excluded.gmail_id,
  thread_id = excluded.thread_id,
  folder = excluded.folder,
  seen = excluded.seen,
  flagged = excluded.flagged,
  category = excluded.category,
  important = excluded.important,
  snippet = excluded.snippet,
  date = excluded.date,
  state = CASE
    WHEN excluded.folder = 'drafts' THEN messages.state
    ELSE 'synced'
  END,
  send_after = CASE WHEN excluded.folder = 'drafts' THEN messages.send_after ELSE NULL END,
  send_error = CASE WHEN excluded.folder = 'drafts' THEN messages.send_error ELSE NULL END
RETURNING id
";

/// JSON.stringify-compatible serialization (Mailbox omits an absent name)
pub(crate) fn to_json<T: serde::Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).expect("serializable")
}

fn from_json<T: DeserializeOwned + Default>(s: &str, what: &str) -> T {
    serde_json::from_str(s).unwrap_or_else(|e| {
        log::warn!("[db] unreadable {what} JSON ({e}): {s}");
        T::default()
    })
}

fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _)
        if f.code == ErrorCode::ConstraintViolation
            && f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
}

fn upsert_one(c: &Connection, account_id: &str, r: &ParsedMessage, hdr: Option<&str>) -> rusqlite::Result<i64> {
    let missing = r.body_state == BodyState::Missing;
    let body_text = encode_body(Some(if missing { "" } else { &r.body_text }));
    let body_html = encode_body(if missing { None } else { r.body_html.as_deref() });
    let mut stmt = c.prepare_cached(UPSERT_SQL)?;
    stmt.query_row(
        named_params! {
            "@accountId": account_id,
            "@gmailId": r.gmail_id,
            "@threadId": r.thread_id,
            "@messageIdHdr": hdr,
            "@inReplyTo": r.in_reply_to,
            "@refs": to_json(&r.references),
            "@fromName": r.from_name,
            "@fromAddr": r.from_addr,
            "@toJson": to_json(&r.to),
            "@ccJson": to_json(&r.cc),
            "@replyToJson": r.reply_to.as_ref().map(to_json),
            "@subject": r.subject,
            "@dateMs": r.date_ms,
            "@snippet": r.snippet,
            "@bodyText": body_text,
            "@bodyHtml": body_html,
            "@bodyCodec": DEFAULT_CODEC,
            "@bodyState": r.body_state.as_str(),
            "@folder": r.folder.as_str(),
            "@seen": r.seen as i64,
            "@flagged": r.flagged as i64,
            "@category": r.category,
            "@important": r.important as i64,
        },
        |row| row.get(0),
    )
}

/// (Re)index one row from what is stored: subject + decoded plain-text body
pub(crate) fn index_row(c: &Connection, id: i64) -> Result<()> {
    let row: Option<(String, Option<StoredBody>, String)> = c
        .query_row("SELECT subject, body_text, body_codec FROM messages WHERE id = ?", [id], |r| {
            Ok((r.get(0)?, StoredBody::from_ref(r.get_ref(1)?), r.get(2)?))
        })
        .optional()?;
    let Some((subject, body, codec)) = row else { return Ok(()) };
    let body = decode_body(body.as_ref(), &codec)?.unwrap_or_default();
    c.prepare_cached("DELETE FROM messages_fts WHERE rowid = ?")?.execute([id])?;
    c.prepare_cached("INSERT INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)")?
        .execute(params![id, subject, body])?;
    Ok(())
}

fn unindex_row(c: &Connection, id: i64) -> Result<()> {
    c.prepare_cached("DELETE FROM messages_fts WHERE rowid = ?")?.execute([id])?;
    Ok(())
}

/// Every column a message read needs (db.ts reads `SELECT *`)
pub(crate) const MSG_COLS: &str = "account_id, gmail_id, gmail_draft_id, thread_id, thread_key, message_id_hdr, \
in_reply_to, refs, from_name, from_addr, to_json, cc_json, reply_to_json, subject, date, snippet, \
body_text, body_html, body_codec, folder, seen, flagged, answered, category, important, state, \
send_after, send_error";

/// A messages row as read (bodies still encoded)
pub(crate) struct MessageRow {
    account_id: String,
    gmail_id: Option<String>,
    gmail_draft_id: Option<String>,
    thread_id: Option<String>,
    thread_key: Option<String>,
    message_id_hdr: Option<String>,
    in_reply_to: Option<String>,
    refs: String,
    from_name: Option<String>,
    from_addr: String,
    to_json: String,
    cc_json: String,
    reply_to_json: Option<String>,
    subject: String,
    date: i64,
    snippet: String,
    body_text: Option<StoredBody>,
    body_html: Option<StoredBody>,
    body_codec: String,
    folder: String,
    seen: i64,
    flagged: i64,
    answered: i64,
    category: String,
    important: i64,
    state: String,
    send_after: Option<i64>,
    send_error: Option<String>,
}

pub(crate) fn message_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        account_id: r.get("account_id")?,
        gmail_id: r.get("gmail_id")?,
        gmail_draft_id: r.get("gmail_draft_id")?,
        thread_id: r.get("thread_id")?,
        thread_key: r.get("thread_key")?,
        message_id_hdr: r.get("message_id_hdr")?,
        in_reply_to: r.get("in_reply_to")?,
        refs: r.get("refs")?,
        from_name: r.get("from_name")?,
        from_addr: r.get("from_addr")?,
        to_json: r.get("to_json")?,
        cc_json: r.get("cc_json")?,
        reply_to_json: r.get("reply_to_json")?,
        subject: r.get("subject")?,
        date: r.get("date")?,
        snippet: r.get("snippet")?,
        body_text: StoredBody::from_ref(r.get_ref("body_text")?),
        body_html: StoredBody::from_ref(r.get_ref("body_html")?),
        body_codec: r.get("body_codec")?,
        folder: r.get("folder")?,
        seen: r.get("seen")?,
        flagged: r.get("flagged")?,
        answered: r.get("answered")?,
        category: r.get("category")?,
        important: r.get("important")?,
        state: r.get("state")?,
        send_after: r.get("send_after")?,
        send_error: r.get("send_error")?,
    })
}

pub(crate) fn parse_folder(s: &str) -> Folder {
    Folder::parse(s).unwrap_or_else(|| {
        log::warn!("[db] unknown folder {s:?}; treating as archive");
        Folder::Archive
    })
}

pub(crate) fn parse_state(s: &str) -> MessageState {
    MessageState::parse(s).unwrap_or_else(|| {
        log::warn!("[db] unknown message state {s:?}; treating as synced");
        MessageState::Synced
    })
}

fn decode_or_log(stored: Option<&StoredBody>, codec: &str) -> Option<String> {
    decode_body(stored, codec).unwrap_or_else(|e| {
        log::warn!("[db] body decode failed: {e}");
        None
    })
}

impl MessageRow {
    pub(crate) fn into_wire(self) -> WireMessage {
        let thread_key = self
            .thread_key
            .clone()
            .or_else(|| self.message_id_hdr.clone())
            .unwrap_or_else(|| format!("row:{}", self.gmail_id.as_deref().unwrap_or("null")));
        WireMessage {
            body_text: decode_or_log(self.body_text.as_ref(), &self.body_codec).unwrap_or_default(),
            body_html: decode_or_log(self.body_html.as_ref(), &self.body_codec),
            account_id: self.account_id,
            gmail_id: self.gmail_id,
            thread_id: self.thread_id,
            thread_key,
            message_id_hdr: self.message_id_hdr,
            in_reply_to: self.in_reply_to,
            references: from_json(&self.refs, "refs"),
            from: Mailbox { name: self.from_name, address: self.from_addr },
            to: from_json(&self.to_json, "to"),
            cc: from_json(&self.cc_json, "cc"),
            reply_to: self
                .reply_to_json
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(|s| serde_json::from_str(s).ok()),
            subject: self.subject,
            date_ms: self.date,
            snippet: self.snippet,
            folder: parse_folder(&self.folder),
            seen: self.seen == 1,
            flagged: self.flagged == 1,
            answered: self.answered == 1,
            category: self.category,
            important: self.important == 1,
            state: parse_state(&self.state),
            send_after_ms: self.send_after,
            send_error: self.send_error,
        }
    }

    fn into_local(self) -> LocalMessage {
        LocalMessage {
            body_text: decode_or_log(self.body_text.as_ref(), &self.body_codec).unwrap_or_default(),
            body_html: decode_or_log(self.body_html.as_ref(), &self.body_codec),
            account_id: self.account_id,
            message_id_hdr: self.message_id_hdr.unwrap_or_default(),
            gmail_id: self.gmail_id,
            gmail_draft_id: self.gmail_draft_id,
            thread_id: self.thread_id,
            in_reply_to: self.in_reply_to,
            references: from_json(&self.refs, "refs"),
            to: from_json(&self.to_json, "to"),
            cc: from_json(&self.cc_json, "cc"),
            subject: self.subject,
            state: parse_state(&self.state),
            send_after: self.send_after,
        }
    }
}

fn query_messages(c: &Connection, sql_tail: &str, p: impl rusqlite::Params) -> Result<Vec<MessageRow>> {
    let mut stmt = c.prepare_cached(&format!("SELECT {MSG_COLS} FROM messages {sql_tail}"))?;
    let rows = stmt.query_map(p, message_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn strings(c: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<String>> {
    let mut stmt = c.prepare_cached(sql)?;
    let rows = stmt.query_map(p, |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}

fn count(c: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<i64> {
    Ok(c.prepare_cached(sql)?.query_row(p, |r| r.get(0))?)
}

/// Codecs the compactor upgrades from (anything not the current default)
const STALE_CODECS: &[&str] = &["none"];

fn count_uncompacted_on(c: &Connection) -> Result<i64> {
    let marks = vec!["?"; STALE_CODECS.len()].join(", ");
    count(
        c,
        &format!("SELECT COUNT(*) FROM messages WHERE body_codec IN ({marks})"),
        rusqlite::params_from_iter(STALE_CODECS),
    )
}

/// The first `n` UTF-16 code units of `s` (JS `slice(0, n)`), never splitting a char
fn js_slice(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in s.chars() {
        units += ch.len_utf16();
        if units > n {
            break;
        }
        out.push(ch);
    }
    out
}

impl Db {
    // ---------- synced messages ----------

    /// Sync writes. A local row (queued/sent/draft) keyed by Message-ID is
    /// adopted rather than twinned; a known gmail_id refreshes labels and
    /// fills bodies into a metadata-only row.
    pub fn upsert_messages(&self, account_id: &str, records: &[ParsedMessage]) -> Result<()> {
        if records.is_empty() {
            return Ok(());
        }
        self.write_tx(|tx| {
            for r in records {
                let before: Option<(i64, String)> = tx
                    .prepare_cached("SELECT id, body_state FROM messages WHERE account_id = ? AND gmail_id = ?")?
                    .query_row(params![account_id, r.gmail_id], |row| Ok((row.get(0)?, row.get(1)?)))
                    .optional()?;
                let id = match upsert_one(tx, account_id, r, r.message_id_hdr.as_deref()) {
                    Ok(id) => id,
                    // A synced message whose Message-ID collides with a
                    // *different* local row: store it without the header
                    Err(e) if is_unique_violation(&e) => upsert_one(tx, account_id, r, None)?,
                    Err(e) => return Err(e.into()),
                };
                let filled = before.as_ref().is_some_and(|(_, s)| s == "missing") && r.body_state == BodyState::Full;
                if before.is_none() || filled {
                    index_row(tx, id)?;
                }
            }
            Ok(())
        })
    }

    pub fn delete_message(&self, account_id: &str, gmail_id: &str) -> Result<()> {
        self.write_tx(|tx| {
            let id: Option<i64> = tx
                .query_row("SELECT id FROM messages WHERE account_id = ? AND gmail_id = ?", [account_id, gmail_id], |r| r.get(0))
                .optional()?;
            if let Some(id) = id {
                unindex_row(tx, id)?;
                tx.execute("DELETE FROM messages WHERE id = ?", [id])?;
            }
            Ok(())
        })
    }

    // ---------- full-text index ----------

    /// Full-text search over subject + body, best match first (bm25, subject
    /// weighted 5× body). FTS syntax in the input is searched for, never interpreted.
    pub fn search_messages(&self, query: &str, account_id: Option<&str>, limit: Option<usize>) -> Result<Vec<SearchHit>> {
        let Some(m) = build_match_expression(query) else { return Ok(Vec::new()) };
        let limit = limit.unwrap_or(100).clamp(1, 10_000) as i64;
        let res = self.read(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT messages_fts.rowid AS messageId, m.thread_id AS threadId, m.account_id AS accountId,
                        bm25(messages_fts, 5.0, 1.0) AS rank
                 FROM messages_fts
                 JOIN messages m ON m.id = messages_fts.rowid
                 WHERE messages_fts MATCH @match AND (@accountId IS NULL OR m.account_id = @accountId)
                 ORDER BY rank
                 LIMIT @limit",
            )?;
            let hits = stmt
                .query_map(named_params! {"@match": m, "@accountId": account_id, "@limit": limit}, |r| {
                    Ok(SearchHit { message_id: r.get(0)?, thread_id: r.get(1)?, account_id: r.get(2)?, rank: r.get(3)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(hits)
        });
        match res {
            Ok(h) => Ok(h),
            Err(e) => {
                log::warn!("[db] search failed for {query:?}: {e}");
                Ok(Vec::new())
            }
        }
    }

    /// Rows in the index (test/diagnostic aid)
    pub fn count_indexed(&self) -> Result<i64> {
        self.read(|c| count(c, "SELECT COUNT(*) FROM messages_fts", []))
    }

    // ---------- body compaction ----------

    pub fn count_uncompacted(&self) -> Result<i64> {
        self.read(count_uncompacted_on)
    }

    /// Re-encode up to `limit` stale-codec rows into the current one, lowest
    /// id first, deriving an empty text body from the HTML on the way. One
    /// transaction per batch; idempotent.
    pub fn compact_bodies_batch(&self, limit: usize) -> Result<CompactBatch> {
        self.write_tx(|tx| {
            let marks = vec!["?"; STALE_CODECS.len()].join(", ");
            let mut select = tx.prepare(&format!(
                "SELECT id, body_text, body_html, body_codec FROM messages
                 WHERE body_codec IN ({marks}) ORDER BY id LIMIT ?"
            ))?;
            let mut args: Vec<rusqlite::types::Value> =
                STALE_CODECS.iter().map(|s| rusqlite::types::Value::Text(s.to_string())).collect();
            args.push(rusqlite::types::Value::Integer(limit as i64));
            let rows: Vec<(i64, Option<StoredBody>, Option<StoredBody>, String)> = select
                .query_map(rusqlite::params_from_iter(args), |r| {
                    Ok((r.get(0)?, StoredBody::from_ref(r.get_ref(1)?), StoredBody::from_ref(r.get_ref(2)?), r.get(3)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = CompactBatch::default();
            for (id, text_stored, html_stored, codec) in rows {
                let text = decode_body(text_stored.as_ref(), &codec)?.unwrap_or_default();
                let html = decode_body(html_stored.as_ref(), &codec)?;
                let best = best_plain_text(&text, html.as_deref());
                let enc_text = encode_body(Some(&best));
                let enc_html = encode_body(html.as_deref());
                tx.prepare_cached("UPDATE messages SET body_text = ?, body_html = ?, body_codec = ? WHERE id = ?")?
                    .execute(params![enc_text, enc_html, DEFAULT_CODEC, id])?;
                out.processed += 1;
                out.bytes_before += stored_size(text_stored.as_ref()) + stored_size(html_stored.as_ref());
                out.bytes_after += stored_size(enc_text.as_ref()) + stored_size(enc_html.as_ref());
                if best != text {
                    out.text_derived += 1;
                    index_row(tx, id)?;
                }
            }
            out.remaining = count_uncompacted_on(tx)? as u64;
            Ok(out)
        })
    }

    // ---------- missing bodies ----------

    pub fn count_missing_bodies(&self, account_id: &str) -> Result<i64> {
        self.read(|c| count(c, "SELECT COUNT(*) FROM messages WHERE account_id = ? AND body_state = 'missing'", [account_id]))
    }

    /// Gmail ids of metadata-only rows, newest first
    pub fn list_missing_body_ids(&self, account_id: &str, limit: usize) -> Result<Vec<String>> {
        self.read(|c| {
            strings(
                c,
                "SELECT gmail_id FROM messages
                 WHERE account_id = ? AND body_state = 'missing' AND gmail_id IS NOT NULL
                 ORDER BY date DESC LIMIT ?",
                params![account_id, limit as i64],
            )
        })
    }

    /// Gmail ids of metadata-only rows in one conversation
    pub fn list_missing_body_ids_in_thread(&self, account_id: &str, thread_key: &str) -> Result<Vec<String>> {
        self.read(|c| {
            strings(
                c,
                "SELECT gmail_id FROM messages
                 WHERE account_id = ? AND thread_key = ? AND body_state = 'missing' AND gmail_id IS NOT NULL",
                [account_id, thread_key],
            )
        })
    }

    /// Apply a label-state change from history sync (folder + flags only)
    pub fn update_message_state(&self, account_id: &str, gmail_id: &str, s: LabelState) -> Result<()> {
        self.write(|c| {
            c.prepare_cached(
                "UPDATE messages SET folder = ?, seen = ?, flagged = ?, important = ? WHERE account_id = ? AND gmail_id = ?",
            )?
            .execute(params![s.folder.as_str(), s.seen as i64, s.flagged as i64, s.important as i64, account_id, gmail_id])?;
            Ok(())
        })
    }

    pub fn has_message(&self, account_id: &str, gmail_id: &str) -> Result<bool> {
        self.read(|c| {
            Ok(c.prepare_cached("SELECT 1 FROM messages WHERE account_id = ? AND gmail_id = ?")?
                .query_row([account_id, gmail_id], |_| Ok(()))
                .optional()?
                .is_some())
        })
    }

    /// Every Gmail id we hold for an account (synced rows only)
    pub fn list_gmail_ids(&self, account_id: &str) -> Result<Vec<String>> {
        self.read(|c| {
            strings(
                c,
                "SELECT gmail_id FROM messages WHERE account_id = ? AND gmail_id IS NOT NULL AND state = 'synced'",
                [account_id],
            )
        })
    }

    /// Label-derived state for every synced message (reconciliation input)
    pub fn list_label_state(&self, account_id: &str) -> Result<Vec<(String, LabelState)>> {
        self.read(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT gmail_id, folder, seen, flagged, important FROM messages WHERE account_id = ? AND gmail_id IS NOT NULL AND state = 'synced'",
            )?;
            let rows = stmt
                .query_map([account_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        LabelState {
                            folder: parse_folder(&r.get::<_, String>(1)?),
                            seen: r.get::<_, i64>(2)? == 1,
                            flagged: r.get::<_, i64>(3)? == 1,
                            important: r.get::<_, i64>(4)? == 1,
                        },
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Per account, the newest `per_account` messages plus everything flagged,
    /// drafted, or still leaving the machine (test aid, as in db.ts)
    pub fn query_window(&self, per_account: usize) -> Result<Vec<WireMessage>> {
        let accounts = self.list_accounts()?;
        self.read(|c| {
            let mut out = Vec::new();
            for account in accounts {
                let mut seen = HashSet::new();
                let mut stmt = c.prepare_cached(&format!(
                    "SELECT id, {MSG_COLS} FROM messages WHERE account_id = ? ORDER BY date DESC LIMIT ?"
                ))?;
                let latest = stmt
                    .query_map(params![account.id, per_account as i64], |r| Ok((r.get::<_, i64>("id")?, message_row(r)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut stmt = c.prepare_cached(&format!(
                    "SELECT id, {MSG_COLS} FROM messages WHERE account_id = ? AND (flagged = 1 OR folder = 'drafts' OR state NOT IN ('synced'))"
                ))?;
                let pinned = stmt
                    .query_map([&account.id], |r| Ok((r.get::<_, i64>("id")?, message_row(r)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for (id, row) in latest.into_iter().chain(pinned) {
                    if seen.insert(id) {
                        out.push(row.into_wire());
                    }
                }
            }
            Ok(out)
        })
    }

    pub fn get_message_wire(&self, account_id: &str, gmail_id: &str) -> Result<Option<WireMessage>> {
        self.read(|c| {
            Ok(query_messages(c, "WHERE account_id = ? AND gmail_id = ?", [account_id, gmail_id])?
                .into_iter()
                .next()
                .map(MessageRow::into_wire))
        })
    }

    /// Every message in a conversation, oldest first
    pub fn query_thread(&self, account_id: &str, thread_key: &str) -> Result<Vec<WireMessage>> {
        self.read(|c| {
            Ok(query_messages(c, "WHERE account_id = ? AND thread_key = ? ORDER BY date, id", [account_id, thread_key])?
                .into_iter()
                .map(MessageRow::into_wire)
                .collect())
        })
    }

    /// Drafts, newest first (shown as individual messages)
    pub fn list_draft_messages(&self, account_id: Option<&str>) -> Result<Vec<WireMessage>> {
        self.read(|c| {
            Ok(query_messages(
                c,
                "WHERE folder = 'drafts' AND (@accountId IS NULL OR account_id = @accountId)
                 ORDER BY date DESC LIMIT 500",
                named_params! {"@accountId": account_id},
            )?
            .into_iter()
            .map(MessageRow::into_wire)
            .collect())
        })
    }

    /// One message by its Message-ID header
    pub fn get_message_wire_by_hdr(&self, account_id: &str, hdr: &str) -> Result<Option<WireMessage>> {
        self.read(|c| {
            Ok(query_messages(c, "WHERE account_id = ? AND message_id_hdr = ?", [account_id, hdr])?
                .into_iter()
                .next()
                .map(MessageRow::into_wire))
        })
    }

    /// Optimistic local mirror of a Gmail label action (remote writeback follows)
    pub fn apply_local_action(&self, account_id: &str, gmail_ids: &[String], action: &str, value: Option<bool>) -> Result<()> {
        let sql = match action {
            "seen" => "UPDATE messages SET seen = ?3 WHERE account_id = ?1 AND gmail_id = ?2",
            "flagged" => "UPDATE messages SET flagged = ?3 WHERE account_id = ?1 AND gmail_id = ?2",
            "archive" => "UPDATE messages SET folder = 'archive' WHERE account_id = ?1 AND gmail_id = ?2 AND folder = 'inbox'",
            "unarchive" => "UPDATE messages SET folder = 'inbox' WHERE account_id = ?1 AND gmail_id = ?2 AND folder = 'archive'",
            "trash" => "UPDATE messages SET folder = 'trash' WHERE account_id = ?1 AND gmail_id = ?2",
            "spam" => "UPDATE messages SET folder = 'spam' WHERE account_id = ?1 AND gmail_id = ?2",
            "inbox" => "UPDATE messages SET folder = 'inbox' WHERE account_id = ?1 AND gmail_id = ?2",
            _ => return Ok(()),
        };
        let wants_value = sql.contains("?3");
        let v = value.unwrap_or(false) as i64;
        self.write_tx(|tx| {
            let mut stmt = tx.prepare(sql)?;
            for g in gmail_ids {
                if wants_value {
                    stmt.execute(params![account_id, g, v])?;
                } else {
                    stmt.execute(params![account_id, g])?;
                }
            }
            Ok(())
        })
    }

    pub fn count_messages(&self, account_id: &str) -> Result<i64> {
        self.read(|c| count(c, "SELECT COUNT(*) FROM messages WHERE account_id = ?", [account_id]))
    }

    // ---------- locally-authored messages ----------

    pub fn get_local_message(&self, account_id: &str, hdr: &str) -> Result<Option<LocalMessage>> {
        self.read(|c| {
            Ok(query_messages(c, "WHERE account_id = ? AND message_id_hdr = ?", [account_id, hdr])?
                .into_iter()
                .next()
                .map(MessageRow::into_local))
        })
    }

    /// Insert or replace the content of a locally-authored message. Existing
    /// rows keep their Gmail ids (and thread); new rows start with none.
    pub fn put_local_message(
        &self,
        input: &LocalMessageInput,
        hdr: &str,
        from: &Mailbox,
        state: MessageState,
        folder: Folder,
        send_after: Option<i64>,
    ) -> Result<()> {
        let now = self.now();
        self.write_tx(|tx| {
            let id: i64 = tx.prepare_cached(
                "INSERT INTO messages (
                  account_id, thread_id, message_id_hdr, in_reply_to, refs,
                  from_name, from_addr, to_json, cc_json,
                  subject, date, snippet, body_text, body_html, body_codec, body_state,
                  folder, seen, flagged, answered, category, important, state, send_after, send_error
                ) VALUES (
                  @accountId, @threadId, @messageIdHdr, @inReplyTo, @refs,
                  @fromName, @fromAddr, @toJson, @ccJson,
                  @subject, @date, @snippet, @bodyText, @bodyHtml, @bodyCodec, 'full',
                  @folder, 1, 0, 0, @category, 0, @state, @sendAfter, NULL
                )
                ON CONFLICT(account_id, message_id_hdr) DO UPDATE SET
                  thread_id = COALESCE(messages.thread_id, excluded.thread_id),
                  in_reply_to = excluded.in_reply_to,
                  refs = excluded.refs,
                  from_name = excluded.from_name,
                  from_addr = excluded.from_addr,
                  to_json = excluded.to_json,
                  cc_json = excluded.cc_json,
                  subject = excluded.subject,
                  date = excluded.date,
                  snippet = excluded.snippet,
                  body_text = excluded.body_text,
                  body_html = excluded.body_html,
                  body_codec = excluded.body_codec,
                  body_state = 'full',
                  folder = excluded.folder,
                  category = excluded.category,
                  state = excluded.state,
                  send_after = excluded.send_after,
                  send_error = NULL
                RETURNING id",
            )?
            .query_row(
                named_params! {
                    "@accountId": input.account_id,
                    "@threadId": input.thread_id,
                    "@messageIdHdr": hdr,
                    "@inReplyTo": input.in_reply_to,
                    "@refs": to_json(&input.references),
                    "@fromName": from.name,
                    "@fromAddr": from.address,
                    "@toJson": to_json(&input.to),
                    "@ccJson": to_json(&input.cc),
                    "@subject": input.subject,
                    "@date": now,
                    "@snippet": js_slice(&input.text, 200),
                    "@bodyText": encode_body(Some(&input.text)),
                    "@bodyHtml": encode_body(input.html.as_deref()),
                    "@bodyCodec": DEFAULT_CODEC,
                    "@folder": folder.as_str(),
                    "@category": input.category.as_deref().unwrap_or("people"),
                    "@state": state.as_str(),
                    "@sendAfter": send_after,
                },
                |r| r.get(0),
            )?;
            index_row(tx, id)
        })
    }

    pub fn delete_local_message(&self, account_id: &str, hdr: &str) -> Result<()> {
        self.write_tx(|tx| {
            let id: Option<i64> = tx
                .query_row("SELECT id FROM messages WHERE account_id = ? AND message_id_hdr = ?", [account_id, hdr], |r| r.get(0))
                .optional()?;
            if let Some(id) = id {
                unindex_row(tx, id)?;
                tx.execute("DELETE FROM messages WHERE id = ?", [id])?;
            }
            Ok(())
        })
    }

    pub fn set_local_state(&self, account_id: &str, hdr: &str, patch: &LocalPatch) -> Result<()> {
        use rusqlite::types::Value;
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<Value> = Vec::new();
        let opt = |v: &Option<String>| v.clone().map(Value::Text).unwrap_or(Value::Null);
        if let Some(s) = patch.state {
            sets.push("state = ?");
            vals.push(Value::Text(s.as_str().into()));
        }
        if let Some(f) = patch.folder {
            sets.push("folder = ?");
            vals.push(Value::Text(f.as_str().into()));
        }
        if let Some(v) = patch.send_after {
            sets.push("send_after = ?");
            vals.push(v.map(Value::Integer).unwrap_or(Value::Null));
        }
        if let Some(v) = &patch.send_error {
            sets.push("send_error = ?");
            vals.push(opt(v));
        }
        if let Some(v) = &patch.gmail_id {
            sets.push("gmail_id = ?");
            vals.push(opt(v));
        }
        if let Some(v) = &patch.gmail_draft_id {
            sets.push("gmail_draft_id = ?");
            vals.push(opt(v));
        }
        if let Some(v) = &patch.thread_id {
            sets.push("thread_id = ?");
            vals.push(opt(v));
        }
        if sets.is_empty() {
            return Ok(());
        }
        vals.push(Value::Text(account_id.into()));
        vals.push(Value::Text(hdr.into()));
        self.write(|c| {
            c.execute(
                &format!("UPDATE messages SET {} WHERE account_id = ? AND message_id_hdr = ?", sets.join(", ")),
                rusqlite::params_from_iter(vals),
            )?;
            Ok(())
        })
    }

    /// \Answered on the parent of one of our replies (Gmail never reports it)
    pub fn set_answered(&self, account_id: &str, parent_hdr: &str, answered: bool) -> Result<()> {
        self.write(|c| {
            c.execute(
                "UPDATE messages SET answered = ? WHERE account_id = ? AND message_id_hdr = ?",
                params![answered as i64, account_id, parent_hdr],
            )?;
            Ok(())
        })
    }

    /// Does any of our outgoing mail (other than `except`) still reply to this parent?
    pub fn has_own_reply(&self, account_id: &str, parent_hdr: &str, own_address: &str, except: &str) -> Result<bool> {
        self.read(|c| {
            Ok(c.query_row(
                "SELECT 1 FROM messages
                 WHERE account_id = ? AND in_reply_to = ? AND LOWER(from_addr) = LOWER(?)
                   AND message_id_hdr != ? LIMIT 1",
                [account_id, parent_hdr, own_address, except],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
        })
    }
}
