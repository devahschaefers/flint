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
pub mod outbox;
pub mod queries;
pub mod secrets;
pub mod storage;
pub mod sync;
pub mod types;

#[cfg(test)]
mod tests;

pub use types::*;

use anyhow::Result;
use clock::Clock;
use db::Db;
use notify::Notifier;
use outbox::Outbox;
use secrets::SecretBox;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use storage::compactor::{Compactor, CompactorOptions};
use sync::SyncEngine;

/// The local mail store
pub struct Store {
    pub(crate) db: Arc<Db>,
}

impl Store {
    /// `~/Library/Application Support/flint/mail.db` (the Electron app's
    /// userData file), or `$FLINT_DB` when set.
    pub fn default_path() -> PathBuf {
        if let Some(p) = std::env::var_os("FLINT_DB").filter(|p| !p.is_empty()) {
            return PathBuf::from(p);
        }
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        let user_data = if cfg!(target_os = "macos") {
            home.join("Library/Application Support/flint")
        } else {
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("flint")
        };
        user_data.join("mail.db")
    }

    /// Open (or create) the store and bring it to the current schema.
    /// Refresh tokens are sealed with the Electron app's keychain key (read
    /// lazily, on the first token read or write).
    pub fn open(path: &Path) -> Result<Arc<Store>> {
        Store::open_with(path, clock::system(), Arc::new(secrets::KeychainSecrets::default()))
    }

    /// [`Store::open`] with an explicit clock and token sealer (tests, tools)
    pub fn open_with(path: &Path, clock: Arc<dyn Clock>, secrets: Arc<dyn SecretBox>) -> Result<Arc<Store>> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Arc::new(Store { db: Arc::new(Db::open(path, clock, secrets)?) }))
    }

    /// The query layer underneath (every db.ts/queries.ts function, for tools and tests)
    pub fn db(&self) -> &Arc<Db> {
        &self.db
    }

    pub fn list_accounts(&self) -> Result<Vec<WireAccount>> {
        self.db.list_accounts()
    }

    /// One page of conversations, newest first, keyset-paged (queries.ts listThreads)
    pub fn list_threads(&self, query: &ThreadQuery) -> Result<ThreadPage> {
        self.db.list_threads(query)
    }

    /// The smart inbox's bundle rows (queries.ts inboxOverview)
    pub fn inbox_overview(&self, account_id: Option<&str>, include_archived: bool) -> Result<InboxOverview> {
        self.db.inbox_overview(account_id, include_archived)
    }

    /// Every message in a conversation, oldest first, exactly as stored (no
    /// body fetch; see [`Engine::get_thread`])
    pub fn thread_messages(&self, thread: &ThreadRef) -> Result<Vec<WireMessage>> {
        self.db.query_thread(&thread.account_id, &thread.thread_key)
    }

    /// Full-text search, best match first, one row per conversation
    pub fn search_threads(&self, query: &str, account_id: Option<&str>, limit: usize) -> Result<Vec<SearchResult>> {
        self.db.search_threads(query, account_id, limit)
    }

    /// Drafts as individual messages, newest first
    pub fn list_drafts(&self, account_id: Option<&str>) -> Result<Vec<WireMessage>> {
        self.db.list_draft_messages(account_id)
    }

    pub fn list_contacts(&self, account_id: Option<&str>) -> Result<Vec<WireContact>> {
        self.db.list_contacts(account_id)
    }

    pub fn unread_counts(&self) -> Result<Vec<UnreadCount>> {
        self.db.unread_counts()
    }

    /// One message by its Message-ID header (drafts the composer edits)
    pub fn message_by_hdr(&self, account_id: &str, hdr: &str) -> Result<Option<WireMessage>> {
        self.db.get_message_wire_by_hdr(account_id, hdr)
    }

    /// User settings (the `setting:` slice of the config table, prefix stripped)
    pub fn settings(&self) -> Result<HashMap<String, String>> {
        self.db.get_settings()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.db.set_setting(key, value)
    }
}

struct EngineInner {
    store: Arc<Store>,
    runtime: Option<tokio::runtime::Runtime>,
    sync: Arc<SyncEngine>,
    outbox: Arc<Outbox>,
    compactor: Compactor,
}

impl EngineInner {
    fn rt(&self) -> &tokio::runtime::Runtime {
        self.runtime.as_ref().expect("engine runtime")
    }
}

impl Drop for EngineInner {
    fn drop(&mut self) {
        self.compactor.stop();
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
    }
}

/// Sync engine + outbox, running on their own threads
#[derive(Clone)]
pub struct Engine {
    inner: Arc<EngineInner>,
}

impl Engine {
    /// Start background sync (backfill, body fill, 60 s delta), the outbox
    /// worker, and the body compactor. `on_change` may be called from any thread.
    pub fn start(store: Arc<Store>, on_change: impl Fn() + Send + Sync + 'static) -> Engine {
        let engine = Engine::build(store, on_change);
        let inner = &engine.inner;
        let handle = inner.rt().handle().clone();
        inner.sync.start_scheduler();
        inner.outbox.start();
        // Compresses pre-v3 bodies in the background; a no-op once they are all done
        inner.compactor.start(&handle);
        engine
    }

    /// Wire everything up without starting background work (tests drive it by hand)
    pub(crate) fn build(store: Arc<Store>, on_change: impl Fn() + Send + Sync + 'static) -> Engine {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("flint-engine")
            .enable_all()
            .build()
            .expect("starting the engine runtime");
        let handle = runtime.handle().clone();
        let notifier = Arc::new(Notifier::new(on_change, Some(handle.clone())));
        let http = reqwest::Client::builder()
            .user_agent(concat!("flint/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("building the HTTP client");
        let db = store.db.clone();
        let sync = Arc::new(SyncEngine::new(db.clone(), notifier.clone(), handle.clone(), http));
        let s = sync.clone();
        let outbox = Arc::new(Outbox::new(db.clone(), Arc::new(move |id| s.api(id)), notifier, Some(handle)));
        let compactor = Compactor::new(CompactorOptions::for_db(db));
        Engine { inner: Arc::new(EngineInner { store, runtime: Some(runtime), sync, outbox, compactor }) }
    }

    pub(crate) fn sync_engine(&self) -> &Arc<SyncEngine> {
        &self.inner.sync
    }

    pub(crate) fn outbox(&self) -> &Arc<Outbox> {
        &self.inner.outbox
    }

    fn block_on<F: std::future::Future>(&self, f: F) -> F::Output {
        self.inner.rt().block_on(f)
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.inner.store
    }

    /// Fetch the bodies a thread is still missing (errors are logged, not
    /// returned: offline, the thread shows what it has), then return it.
    pub fn get_thread(&self, thread: &ThreadRef) -> Result<Vec<WireMessage>> {
        let sync = self.inner.sync.clone();
        if let Err(e) = self.block_on(sync.ensure_bodies(&thread.account_id, &thread.thread_key)) {
            log::warn!("[engine] body fetch on open failed: {e:#}");
        }
        self.inner.store.thread_messages(thread)
    }

    /// Apply an intent to whole conversations: mirrored locally at once, queued for Gmail
    pub fn thread_action(&self, threads: &[ThreadRef], action: ThreadAction) -> Result<()> {
        let db = &self.inner.store.db;
        for t in threads {
            for r in db.resolve_thread_action(t, action)? {
                self.inner.outbox.apply_action(&t.account_id, &r.gmail_ids, r.action, r.value)?;
            }
        }
        Ok(())
    }

    /// Store a draft (local row + queued push to Gmail Drafts); returns its Message-ID
    pub fn save_draft(&self, input: LocalMessageInput) -> Result<String> {
        self.inner.outbox.save_draft(&input)
    }

    /// Delete a local message (draft or failed send), and its Gmail draft if any
    pub fn delete_local(&self, account_id: &str, hdr: &str) -> Result<()> {
        self.inner.outbox.delete_local(account_id, hdr)
    }

    /// Queue a message to leave at `send_after_ms` (now, or the end of an undo window)
    pub fn queue_send(&self, input: LocalMessageInput, send_after_ms: i64) -> Result<String> {
        self.inner.outbox.queue_send(&input, send_after_ms)
    }

    /// Pull a queued/failed message back; false once it is sending or sent
    pub fn cancel_send(&self, account_id: &str, hdr: &str, as_draft: bool) -> Result<bool> {
        self.inner.outbox.cancel_send(account_id, hdr, as_draft)
    }

    pub fn retry_send(&self, account_id: &str, hdr: &str) -> Result<()> {
        self.inner.outbox.retry_send(account_id, hdr)
    }

    /// Ops that have hit at least one error (still retrying, or parked)
    pub fn list_outbox(&self) -> Result<Vec<WireOp>> {
        self.inner.outbox.list_troubled()
    }

    pub fn retry_outbox(&self, ids: Option<Vec<i64>>) -> Result<()> {
        self.inner.outbox.retry(ids.as_deref())
    }

    /// Drop ops and re-fetch the affected messages so local state matches Gmail
    pub fn discard_outbox(&self, ids: Option<Vec<i64>>) -> Result<()> {
        let outbox = self.inner.outbox.clone();
        self.block_on(async move { outbox.discard(ids.as_deref()).await })
    }

    /// Browser OAuth flow; returns once the account exists and is syncing
    pub fn add_account(&self) -> Result<WireAccount> {
        let sync = self.inner.sync.clone();
        self.block_on(async move { sync.add_account().await })
    }

    pub fn remove_account(&self, account_id: &str) -> Result<()> {
        self.inner.sync.remove_account(account_id)
    }

    /// Delta-sync every account now
    pub fn refresh(&self) -> Result<()> {
        let sync = self.inner.sync.clone();
        self.block_on(async move { sync.delta_all().await });
        Ok(())
    }

    pub fn sync_status(&self) -> Result<Vec<SyncStatus>> {
        self.inner.sync.status()
    }
}
