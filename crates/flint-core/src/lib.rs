//! Flint's backend, ported from the Electron main process (`src/main`).
//!
//! Two handles make up the public surface the GPUI app uses:
//!
//! - [`Store`]: the SQLite mail store (same file and schema as the Electron
//!   app: `~/Library/Application Support/flint/mail.db`, `user_version` 4).
//!   Every read the UI makes goes through it. Reads use their own WAL read
//!   connections, so they never wait on sync writes. Safe to call from any
//!   thread; calls block, so the UI runs them on a background executor.
//! - [`Engine`]: the sync engine and outbox (the Gmail side). Every user
//!   intent is written to SQLite first and then drained to Gmail. Methods
//!   block until their local effect is durable; network-bound ones
//!   (`get_thread`, `add_account`, `refresh`, `discard_outbox`) block until
//!   the network part finishes too.
//!
//! The engine tells the UI that the store changed through the `on_change`
//! callback given to [`Engine::start`]: sync traffic is throttled (trailing
//! edge, 800 ms), user-initiated writes fire immediately. The UI re-runs
//! whatever queries it has on screen when it fires.

pub mod clock;
pub mod db;
pub mod google;
pub mod mime;
pub mod notify;
pub mod queries;
pub mod secrets;
pub mod storage;
pub mod types;

pub use types::*;

use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The local mail store
pub struct Store {
    _private: (),
}

impl Store {
    /// `~/Library/Application Support/flint/mail.db` (the Electron app's
    /// userData file), or `$FLINT_DB` when set.
    pub fn default_path() -> PathBuf {
        todo!()
    }

    /// Open (or create) the store and bring it to the current schema.
    pub fn open(_path: &Path) -> Result<Arc<Store>> {
        todo!()
    }

    pub fn list_accounts(&self) -> Result<Vec<WireAccount>> {
        todo!()
    }

    /// One page of conversations, newest first, keyset-paged (queries.ts listThreads)
    pub fn list_threads(&self, _query: &ThreadQuery) -> Result<ThreadPage> {
        todo!()
    }

    /// The smart inbox's bundle rows (queries.ts inboxOverview)
    pub fn inbox_overview(
        &self,
        _account_id: Option<&str>,
        _include_archived: bool,
    ) -> Result<InboxOverview> {
        todo!()
    }

    /// Every message in a conversation, oldest first, exactly as stored (no
    /// body fetch; see [`Engine::get_thread`])
    pub fn thread_messages(&self, _thread: &ThreadRef) -> Result<Vec<WireMessage>> {
        todo!()
    }

    /// Full-text search, best match first, one row per conversation
    pub fn search_threads(
        &self,
        _query: &str,
        _account_id: Option<&str>,
        _limit: usize,
    ) -> Result<Vec<SearchResult>> {
        todo!()
    }

    /// Drafts as individual messages, newest first
    pub fn list_drafts(&self, _account_id: Option<&str>) -> Result<Vec<WireMessage>> {
        todo!()
    }

    pub fn list_contacts(&self, _account_id: Option<&str>) -> Result<Vec<WireContact>> {
        todo!()
    }

    pub fn unread_counts(&self) -> Result<Vec<UnreadCount>> {
        todo!()
    }

    /// One message by its Message-ID header (drafts the composer edits)
    pub fn message_by_hdr(&self, _account_id: &str, _hdr: &str) -> Result<Option<WireMessage>> {
        todo!()
    }

    /// User settings (the `setting:` slice of the config table, prefix stripped)
    pub fn settings(&self) -> Result<HashMap<String, String>> {
        todo!()
    }

    pub fn set_setting(&self, _key: &str, _value: &str) -> Result<()> {
        todo!()
    }
}

/// Sync engine + outbox, running on their own threads
#[derive(Clone)]
pub struct Engine {
    _private: Arc<()>,
}

impl Engine {
    /// Start background sync (backfill, body fill, 60 s delta), the outbox
    /// worker, and the body compactor. `on_change` may be called from any thread.
    pub fn start(_store: Arc<Store>, _on_change: impl Fn() + Send + Sync + 'static) -> Engine {
        todo!()
    }

    pub fn store(&self) -> &Arc<Store> {
        todo!()
    }

    /// Fetch the bodies a thread is still missing (errors are logged, not
    /// returned: offline, the thread shows what it has), then return it.
    pub fn get_thread(&self, _thread: &ThreadRef) -> Result<Vec<WireMessage>> {
        todo!()
    }

    /// Apply an intent to whole conversations: mirrored locally at once, queued for Gmail
    pub fn thread_action(&self, _threads: &[ThreadRef], _action: ThreadAction) -> Result<()> {
        todo!()
    }

    /// Store a draft (local row + queued push to Gmail Drafts); returns its Message-ID
    pub fn save_draft(&self, _input: LocalMessageInput) -> Result<String> {
        todo!()
    }

    /// Delete a local message (draft or failed send), and its Gmail draft if any
    pub fn delete_local(&self, _account_id: &str, _hdr: &str) -> Result<()> {
        todo!()
    }

    /// Queue a message to leave at `send_after_ms` (now, or the end of an undo window)
    pub fn queue_send(&self, _input: LocalMessageInput, _send_after_ms: i64) -> Result<String> {
        todo!()
    }

    /// Pull a queued/failed message back; false once it is sending or sent
    pub fn cancel_send(&self, _account_id: &str, _hdr: &str, _as_draft: bool) -> Result<bool> {
        todo!()
    }

    pub fn retry_send(&self, _account_id: &str, _hdr: &str) -> Result<()> {
        todo!()
    }

    /// Ops that have hit at least one error (still retrying, or parked)
    pub fn list_outbox(&self) -> Result<Vec<WireOp>> {
        todo!()
    }

    pub fn retry_outbox(&self, _ids: Option<Vec<i64>>) -> Result<()> {
        todo!()
    }

    /// Drop ops and re-fetch the affected messages so local state matches Gmail
    pub fn discard_outbox(&self, _ids: Option<Vec<i64>>) -> Result<()> {
        todo!()
    }

    /// Browser OAuth flow; returns once the account exists and is syncing
    pub fn add_account(&self) -> Result<WireAccount> {
        todo!()
    }

    pub fn remove_account(&self, _account_id: &str) -> Result<()> {
        todo!()
    }

    /// Delta-sync every account now
    pub fn refresh(&self) -> Result<()> {
        todo!()
    }

    pub fn sync_status(&self) -> Result<Vec<SyncStatus>> {
        todo!()
    }
}
