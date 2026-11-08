//! Wire types shared by the store, the engine, and the UI. Times are unix
//! ms (`i64`).
//!
//! The serde attributes matter only where a value is persisted as JSON in
//! SQLite (mailboxes in `to_json`/`cc_json`/`reply_to_json`, op payloads):
//! those must stay byte-compatible with the rows already in the database.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Folder {
    Inbox,
    Archive,
    Sent,
    Drafts,
    Trash,
    Spam,
}

impl Folder {
    pub fn as_str(self) -> &'static str {
        match self {
            Folder::Inbox => "inbox",
            Folder::Archive => "archive",
            Folder::Sent => "sent",
            Folder::Drafts => "drafts",
            Folder::Trash => "trash",
            Folder::Spam => "spam",
        }
    }

    pub fn parse(s: &str) -> Option<Folder> {
        Some(match s {
            "inbox" => Folder::Inbox,
            "archive" => Folder::Archive,
            "sent" => Folder::Sent,
            "drafts" => Folder::Drafts,
            "trash" => Folder::Trash,
            "spam" => Folder::Spam,
            _ => return None,
        })
    }
}

/// Label-level actions the outbox writes back to Gmail
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailAction {
    Seen,
    Flagged,
    Archive,
    Unarchive,
    Trash,
    Spam,
    Inbox,
}

impl MailAction {
    pub fn as_str(self) -> &'static str {
        match self {
            MailAction::Seen => "seen",
            MailAction::Flagged => "flagged",
            MailAction::Archive => "archive",
            MailAction::Unarchive => "unarchive",
            MailAction::Trash => "trash",
            MailAction::Spam => "spam",
            MailAction::Inbox => "inbox",
        }
    }
}

/// Lifecycle of a message row
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageState {
    Synced,
    Draft,
    Queued,
    Sending,
    Sent,
    Failed,
}

impl MessageState {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageState::Synced => "synced",
            MessageState::Draft => "draft",
            MessageState::Queued => "queued",
            MessageState::Sending => "sending",
            MessageState::Sent => "sent",
            MessageState::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<MessageState> {
        Some(match s {
            "synced" => MessageState::Synced,
            "draft" => MessageState::Draft,
            "queued" => MessageState::Queued,
            "sending" => MessageState::Sending,
            "sent" => MessageState::Sent,
            "failed" => MessageState::Failed,
            _ => return None,
        })
    }
}

/// Outbox operation kinds (stored as text in `ops.kind`)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    Action,
    Send,
    DraftPut,
    DraftDelete,
}

/// RFC 5322 name-addr. Serialized exactly like JSON.stringify of the TS
/// object: `name` is omitted when absent.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Mailbox {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub address: String,
}

impl Mailbox {
    pub fn new(name: Option<String>, address: impl Into<String>) -> Self {
        Mailbox { name, address: address.into() }
    }
}

impl fmt::Display for Mailbox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.name {
            Some(n) => write!(f, "{n} <{}>", self.address),
            None => write!(f, "{}", self.address),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireAccount {
    pub id: String,
    pub email: String,
    /// Google profile display name
    pub name: String,
    pub color: String,
    pub backfill_done: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WireMessage {
    pub account_id: String,
    pub gmail_id: Option<String>,
    pub thread_id: Option<String>,
    /// Gmail's thread id, or the Message-ID for local mail; unique per account
    pub thread_key: String,
    pub message_id_hdr: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub from: Mailbox,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub reply_to: Option<Mailbox>,
    pub subject: String,
    pub date_ms: i64,
    pub snippet: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub folder: Folder,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub category: String,
    pub important: bool,
    pub state: MessageState,
    pub send_after_ms: Option<i64>,
    pub send_error: Option<String>,
}

// ---------- thread lists ----------

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ThreadRef {
    pub account_id: String,
    pub thread_key: String,
}

/// Which conversations a list shows (Gmail semantics: a thread is in a folder
/// when any of its messages is).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ThreadListView {
    Inbox {
        include_archived: bool,
        /// Smart-inbox group: latest message has this category and nothing is important
        category: Option<String>,
        /// Only threads with an important message (the smart inbox's main list)
        important_only: bool,
    },
    /// Only Archive, Sent, Trash, Spam are valid here
    Folder(Folder),
    /// Flagged conversations not in Trash or Spam
    Pins,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ThreadCursor {
    pub latest_date_ms: i64,
    pub account_id: String,
    pub thread_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ThreadQuery {
    /// None = every account merged by date
    pub account_id: Option<String>,
    pub view: ThreadListView,
    pub cursor: Option<ThreadCursor>,
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FolderCounts {
    pub inbox: i64,
    pub archive: i64,
    pub sent: i64,
    pub drafts: i64,
    pub trash: i64,
    pub spam: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ThreadLatest {
    pub message_id_hdr: Option<String>,
    pub from: Mailbox,
    pub to: Vec<Mailbox>,
    pub snippet: String,
    pub folder: Folder,
    pub state: MessageState,
    pub send_after_ms: Option<i64>,
    pub send_error: Option<String>,
}

/// What a list row needs, computed in SQL over the thread's messages
#[derive(Debug, Clone, PartialEq)]
pub struct WireThread {
    pub account_id: String,
    pub thread_key: String,
    /// Subject of the newest message (reply prefixes not stripped)
    pub subject: String,
    pub latest_date_ms: i64,
    pub count: i64,
    pub unread: i64,
    pub flagged: bool,
    pub important: bool,
    pub category: String,
    pub folders: FolderCounts,
    pub latest: ThreadLatest,
    /// Newest sender who is not one of the user's own addresses
    pub counterpart: Option<Mailbox>,
}

impl WireThread {
    pub fn thread_ref(&self) -> ThreadRef {
        ThreadRef { account_id: self.account_id.clone(), thread_key: self.thread_key.clone() }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ThreadPage {
    pub threads: Vec<WireThread>,
    /// None when this was the last page
    pub next_cursor: Option<ThreadCursor>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InboxChip {
    pub mailbox: Mailbox,
    pub count: i64,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InboxGroup {
    pub category: String,
    pub count: i64,
    pub unread: i64,
    pub chips: Vec<InboxChip>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct InboxOverview {
    pub groups: Vec<InboxGroup>,
}

/// Thread-level intents; the engine resolves which messages each one touches
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThreadAction {
    ToggleArchive,
    Archive,
    ToggleFlagged,
    ToggleSeen,
    MarkSeen,
    Trash,
    Spam,
    Inbox,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchMatch {
    pub message_id_hdr: Option<String>,
    pub subject: String,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub thread: WireThread,
    /// The best-matching message in the thread
    pub matched: SearchMatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireContact {
    /// Lowercased
    pub address: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadCount {
    pub account_id: String,
    pub inbox_unread: i64,
}

// ---------- writes ----------

/// A locally-authored message: what the UI hands the engine for drafts and sends
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LocalMessageInput {
    pub account_id: String,
    /// Existing local row to update; None for new mail
    pub message_id_hdr: Option<String>,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub subject: String,
    /// text/plain part
    pub text: String,
    /// text/html part, when composed rich
    pub html: Option<String>,
    /// Parent Message-ID header, for reply threading
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// Gmail conversation to append to (replies)
    pub thread_id: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpState {
    Pending,
    Running,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WireOp {
    pub id: i64,
    pub account_id: String,
    pub kind: OpKind,
    pub state: OpState,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub next_attempt_at: i64,
    pub created_at: i64,
    pub message_id_hdr: Option<String>,
    pub action: Option<String>,
    pub gmail_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncStatus {
    pub account_id: String,
    pub email: String,
    pub message_count: i64,
    pub backfill_done: bool,
}
