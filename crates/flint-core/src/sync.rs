//! Per-account Gmail sync, the read side (port of `src/main/sync.ts`).
//!
//! Initial backfill walks the whole mailbox newest-first with a resumable
//! page-token checkpoint in two phases: metadata first (headers, labels,
//! snippet: the list is browsable within moments), then bodies for every
//! metadata-only row, newest first. Opening a thread fetches its missing
//! bodies on the spot ([`SyncEngine::ensure_bodies`]). Steady-state sync
//! applies history deltas anchored at the historyId captured when the
//! account was added. Writes to Gmail live in the outbox.

use crate::db::{Db, ParsedMessage};
use crate::google::client_defaults::{GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET};
use crate::google::gmail::{labels_to_state, GResult, GmailApi, GmailClient, GmailError, ListOpts};
use crate::google::oauth::{self, RefreshTokenAuth};
use crate::notify::Notifier;
use crate::types::{SyncStatus, WireAccount};
use anyhow::{anyhow, Result};
use futures::future::{BoxFuture, FutureExt, Shared};
use futures::{StreamExt, TryStreamExt};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::runtime::Handle;

pub const ACCOUNT_COLORS: [&str; 6] = ["#4E9BF5", "#E5684F", "#43B581", "#B57EDC", "#E8B04C", "#5CC9C2"];
const BACKFILL_CONCURRENCY: usize = 6;
/// Metadata-only rows fetched in full per body-fill round
const BODY_FILL_BATCH: usize = 50;
const DELTA_INTERVAL: Duration = Duration::from_secs(60);
const PAGE_PAUSE: Duration = Duration::from_millis(150);
const SCHEDULER_DELAY: Duration = Duration::from_millis(1500);
/// Newest remote messages a full resync will fetch when they are missing locally
const RESYNC_NEW_CAP: usize = 2000;
/// Labels that determine folder + flags (see labels_to_state)
const STATE_LABELS: [&str; 8] = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "DRAFT", "SENT"];

/// Fetch messages, at most six in flight, results in input order; the first
/// failure fails the whole batch (mapConcurrent + Promise.all)
pub(crate) async fn fetch_messages(
    api: &Arc<dyn GmailApi>,
    ids: &[String],
    metadata: bool,
) -> GResult<Vec<Option<ParsedMessage>>> {
    let futs = ids.iter().cloned().map(|id| {
        let api = api.clone();
        async move {
            if metadata {
                api.get_message_metadata(&id).await
            } else {
                api.get_message(&id).await
            }
        }
    });
    futures::stream::iter(futs).buffered(BACKFILL_CONCURRENCY).try_collect().await
}

type SharedFetch = Shared<BoxFuture<'static, Result<bool, Arc<anyhow::Error>>>>;

/// Turn a shared error back into an owned one, keeping a GmailError's status
fn unshare(e: Arc<anyhow::Error>) -> anyhow::Error {
    match e.downcast_ref::<GmailError>() {
        Some(g) => g.clone().into(),
        None => anyhow!("{e:#}"),
    }
}

pub fn gmail_status(e: &anyhow::Error) -> Option<u16> {
    e.downcast_ref::<GmailError>().map(|g| g.status)
}

type BrowserFn = Arc<dyn Fn(&str) -> Result<()> + Send + Sync>;

pub struct SyncEngine {
    db: Arc<Db>,
    notifier: Arc<Notifier>,
    handle: Handle,
    http: reqwest::Client,
    /// Gmail clients per account (tests seed fakes here)
    pub(crate) apis: Mutex<HashMap<String, Arc<dyn GmailApi>>>,
    pub(crate) backfilling: Mutex<HashSet<String>>,
    pub(crate) body_filling: Mutex<HashSet<String>>,
    /// In-flight on-demand body fetches, keyed by account/thread
    pub(crate) thread_fetches: Mutex<HashMap<String, SharedFetch>>,
    delta_running: Mutex<HashSet<String>>,
    open_browser: BrowserFn,
}

/// Holds an account in a guard set for the life of a task
struct SetGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl Drop for SetGuard<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.key);
    }
}

impl SyncEngine {
    pub fn new(db: Arc<Db>, notifier: Arc<Notifier>, handle: Handle, http: reqwest::Client) -> SyncEngine {
        SyncEngine {
            db,
            notifier,
            handle,
            http,
            apis: Mutex::default(),
            backfilling: Mutex::default(),
            body_filling: Mutex::default(),
            thread_fetches: Mutex::default(),
            delta_running: Mutex::default(),
            open_browser: Arc::new(|url| Ok(open::that_detached(url)?)),
        }
    }

    /// Built-in OAuth client, overridable via config rows (for forks)
    fn client_config(&self) -> Result<(String, String)> {
        let pick = |key: &str, default: &str| -> Result<String> {
            Ok(self.db.get_config(key)?.filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string()))
        };
        Ok((pick("google_client_id", GOOGLE_CLIENT_ID)?, pick("google_client_secret", GOOGLE_CLIENT_SECRET)?))
    }

    /// The Gmail client for an account, refreshing access tokens from the
    /// stored refresh token (a rotated one is persisted)
    pub fn api(&self, account_id: &str) -> Result<Arc<dyn GmailApi>> {
        if let Some(api) = self.apis.lock().unwrap().get(account_id) {
            return Ok(api.clone());
        }
        let (client_id, client_secret) = self.client_config()?;
        let refresh = self
            .db
            .get_refresh_token(account_id)?
            .ok_or_else(|| anyhow!("Account has no stored credentials — re-add it in Settings"))?;
        let db = self.db.clone();
        let id = account_id.to_string();
        let auth = RefreshTokenAuth::new(
            self.http.clone(),
            client_id,
            client_secret,
            refresh,
            Arc::new(move |token| {
                if let Err(e) = db.save_refresh_token(&id, token) {
                    log::error!("[sync] could not persist a rotated refresh token: {e}");
                }
            }),
        );
        let api: Arc<dyn GmailApi> = Arc::new(GmailClient::new(self.http.clone(), Arc::new(auth)));
        Ok(self.apis.lock().unwrap().entry(account_id.to_string()).or_insert(api).clone())
    }

    /// Run the browser OAuth flow, create (or re-authorize) the account, start syncing
    pub async fn add_account(self: &Arc<Self>) -> Result<WireAccount> {
        let (client_id, client_secret) = self.client_config()?;
        let open = self.open_browser.clone();
        let auth = oauth::run_auth_flow(&self.http, &client_id, &client_secret, |u| open(u)).await?;
        let account_id = match self.db.get_account_by_email(&auth.email)? {
            Some(existing) => existing.id,
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let color = ACCOUNT_COLORS[self.db.list_accounts()?.len() % ACCOUNT_COLORS.len()];
                self.db.create_account(&id, &auth.email, &auth.name, color)?;
                id
            }
        };
        self.db.save_refresh_token(&account_id, &auth.tokens.refresh_token)?;
        // Drop any client built on a previous refresh token (the re-add case)
        self.apis.lock().unwrap().remove(&account_id);
        // Anchor delta sync before backfill begins so nothing slips between them
        if self.db.get_history_id(&account_id)?.is_none() {
            let profile = self.api(&account_id)?.get_profile().await?;
            self.db.set_history_id(&account_id, &profile.history_id)?;
        }
        self.start_backfill(&account_id);
        self.notifier.mail_changed(true);
        self.db
            .list_accounts()?
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| anyhow!("Account vanished during setup"))
    }

    pub fn remove_account(&self, account_id: &str) -> Result<()> {
        self.db.delete_account(account_id)?;
        self.apis.lock().unwrap().remove(account_id);
        self.notifier.mail_changed(true);
        Ok(())
    }

    pub fn start_backfill(self: &Arc<Self>, account_id: &str) {
        if self.backfilling.lock().unwrap().contains(account_id) {
            return;
        }
        match self.db.get_backfill_state(account_id) {
            Ok(Some(s)) if !s.done => {}
            Ok(_) => return,
            Err(e) => {
                log::error!("[sync] backfill state unreadable: {e}");
                return;
            }
        }
        if !self.backfilling.lock().unwrap().insert(account_id.to_string()) {
            return;
        }
        let me = self.clone();
        let id = account_id.to_string();
        self.handle.spawn(async move {
            let _guard = SetGuard { set: &me.backfilling, key: id.clone() };
            if let Err(e) = me.backfill_loop(&id).await {
                log::error!("[sync] backfill failed: {e:#}");
            }
        });
    }

    /// Phase 1: every message as a metadata-only row, newest first
    pub(crate) async fn backfill_loop(self: &Arc<Self>, account_id: &str) -> Result<()> {
        let api = self.api(account_id)?;
        loop {
            let Some(state) = self.db.get_backfill_state(account_id)? else { return Ok(()) };
            if state.done {
                return Ok(());
            }
            let page = api.list_message_ids(state.page_token.as_deref(), ListOpts::default()).await?;
            let mut fresh = Vec::new();
            for id in &page.ids {
                if !self.db.has_message(account_id, id)? {
                    fresh.push(id.clone());
                }
            }
            let parsed = fetch_messages(&api, &fresh, true).await?;
            let rows: Vec<ParsedMessage> = parsed.into_iter().flatten().collect();
            self.db.upsert_messages(account_id, &rows)?;
            let next = page.next_page_token.as_deref();
            self.db.set_backfill_state(account_id, next, next.is_none())?;
            self.notifier.mail_changed(false);
            if next.is_none() {
                log::info!(
                    "[sync] backfill complete: {} messages, {} bodies to fetch",
                    self.db.count_messages(account_id)?,
                    self.db.count_missing_bodies(account_id)?
                );
                self.start_body_fill(account_id);
                return Ok(());
            }
            tokio::time::sleep(PAGE_PAUSE).await;
        }
    }

    /// Phase 2: bodies for metadata-only rows, newest first, until none are left
    pub fn start_body_fill(self: &Arc<Self>, account_id: &str) {
        if self.body_filling.lock().unwrap().contains(account_id) {
            return;
        }
        match self.db.count_missing_bodies(account_id) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) => {
                log::error!("[sync] missing-body count failed: {e}");
                return;
            }
        }
        if !self.body_filling.lock().unwrap().insert(account_id.to_string()) {
            return;
        }
        let me = self.clone();
        let id = account_id.to_string();
        self.handle.spawn(async move {
            let _guard = SetGuard { set: &me.body_filling, key: id.clone() };
            if let Err(e) = me.body_fill_loop(&id).await {
                log::error!("[sync] body fill failed: {e:#}");
            }
        });
    }

    async fn body_fill_loop(&self, account_id: &str) -> Result<()> {
        loop {
            if self.db.get_account(account_id)?.is_none() {
                return Ok(());
            }
            let ids = self.db.list_missing_body_ids(account_id, BODY_FILL_BATCH)?;
            if ids.is_empty() {
                log::info!("[sync] body fill complete for {account_id}");
                return Ok(());
            }
            self.fetch_bodies(account_id, &ids).await?;
            tokio::time::sleep(PAGE_PAUSE).await;
        }
    }

    /// Fetch the bodies a thread is still missing before it is shown. True
    /// when anything was fetched. Concurrent opens of the same thread share
    /// one fetch; failures (offline, no credentials) propagate.
    pub async fn ensure_bodies(self: &Arc<Self>, account_id: &str, thread_key: &str) -> Result<bool> {
        let key = format!("{account_id}/{thread_key}");
        let fetch = {
            let mut map = self.thread_fetches.lock().unwrap();
            match map.get(&key) {
                Some(f) => f.clone(),
                None => {
                    let me = self.clone();
                    let (a, t, k) = (account_id.to_string(), thread_key.to_string(), key.clone());
                    let fut: BoxFuture<'static, Result<bool, Arc<anyhow::Error>>> = async move {
                        let res = async {
                            let ids = me.db.list_missing_body_ids_in_thread(&a, &t)?;
                            if ids.is_empty() {
                                return Ok(false);
                            }
                            me.fetch_bodies(&a, &ids).await?;
                            Ok(true)
                        }
                        .await;
                        me.thread_fetches.lock().unwrap().remove(&k);
                        res.map_err(Arc::new)
                    }
                    .boxed();
                    let shared = fut.shared();
                    map.insert(key, shared.clone());
                    shared
                }
            }
        };
        fetch.await.map_err(unshare)
    }

    /// Full fetch for metadata-only rows; a message Gmail no longer has is dropped
    async fn fetch_bodies(&self, account_id: &str, ids: &[String]) -> Result<()> {
        let api = self.api(account_id)?;
        let parsed = fetch_messages(&api, ids, false).await?;
        let mut full = Vec::new();
        for (p, id) in parsed.into_iter().zip(ids) {
            match p {
                Some(p) => full.push(p),
                None => self.db.delete_message(account_id, id)?,
            }
        }
        // The gmail_id conflict path fills bodies into a 'missing' row (and refreshes labels)
        self.db.upsert_messages(account_id, &full)?;
        self.notifier.mail_changed(false);
        Ok(())
    }

    pub async fn delta_all(&self) {
        let accounts = match self.db.list_accounts() {
            Ok(a) => a,
            Err(e) => {
                log::error!("[sync] could not list accounts: {e}");
                return;
            }
        };
        for account in accounts {
            if let Err(e) = self.delta_sync(&account.id).await {
                log::error!("[sync] delta failed for {}: {e:#}", account.email);
            }
        }
    }

    async fn delta_sync(&self, account_id: &str) -> Result<()> {
        if !self.delta_running.lock().unwrap().insert(account_id.to_string()) {
            return Ok(());
        }
        let _guard = SetGuard { set: &self.delta_running, key: account_id.to_string() };
        self.delta_inner(account_id).await
    }

    pub(crate) async fn delta_inner(&self, account_id: &str) -> Result<()> {
        let api = self.api(account_id)?;
        let Some(start) = self.db.get_history_id(account_id)? else { return Ok(()) };
        let mut changed = false;
        let res: Result<()> = async {
            let mut page_token: Option<String> = None;
            let mut latest: Option<String> = None;
            loop {
                let page = api.list_history(&start, page_token.as_deref()).await?;
                if page.history_id.is_some() {
                    latest = page.history_id.clone();
                }
                for entry in &page.history {
                    for id in &entry.messages_added {
                        if let Some(p) = api.get_message(id).await? {
                            self.db.upsert_messages(account_id, &[p])?;
                            changed = true;
                        }
                    }
                    for id in &entry.messages_deleted {
                        self.db.delete_message(account_id, id)?;
                        changed = true;
                    }
                    for (id, labels) in &entry.label_changes {
                        if self.db.has_message(account_id, id)? {
                            self.db.update_message_state(account_id, id, labels_to_state(labels))?;
                            changed = true;
                        }
                    }
                }
                page_token = page.next_page_token;
                if page_token.is_none() {
                    break;
                }
            }
            if let Some(l) = latest {
                self.db.set_history_id(account_id, &l)?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = res {
            // History window expired: Gmail requires a full sync before a new anchor is valid
            if gmail_status(&e) == Some(404) {
                self.full_resync(account_id, &api).await?;
                changed = true;
            } else {
                return Err(e);
            }
        }
        if changed {
            self.notifier.mail_changed(false);
        }
        Ok(())
    }

    /// Reconcile the cached mailbox against Gmail when history is no longer
    /// available. The new anchor is captured first and committed last:
    ///   1. messages Gmail no longer has are deleted locally
    ///   2. folder/flags of everything we hold are recomputed from label listings
    ///   3. the newest messages we don't hold are fetched (capped)
    async fn full_resync(&self, account_id: &str, api: &Arc<dyn GmailApi>) -> Result<()> {
        log::warn!("[sync] history expired for {account_id}; running a full resync");
        let profile = api.get_profile().await?;
        let new_history_id = profile.history_id;

        let remote_list = api.list_all_message_ids(None).await?;
        let remote: HashSet<&str> = remote_list.iter().map(String::as_str).collect();
        let local = self.db.list_label_state(account_id)?;

        let mut removed = 0;
        for (gmail_id, _) in &local {
            if !remote.contains(gmail_id.as_str()) {
                self.db.delete_message(account_id, gmail_id)?;
                removed += 1;
            }
        }

        let mut label_sets: HashMap<&str, HashSet<String>> = HashMap::new();
        for label in STATE_LABELS {
            let ids = api.list_all_message_ids(Some(vec![label.to_string()])).await?;
            label_sets.insert(label, ids.into_iter().collect());
        }
        let mut relabelled = 0;
        for (gmail_id, cur) in &local {
            if !remote.contains(gmail_id.as_str()) {
                continue;
            }
            let labels: Vec<String> = STATE_LABELS
                .iter()
                .filter(|l| label_sets.get(**l).is_some_and(|s| s.contains(gmail_id)))
                .map(|l| l.to_string())
                .collect();
            let next = labels_to_state(&labels);
            if next != *cur {
                self.db.update_message_state(account_id, gmail_id, next)?;
                relabelled += 1;
            }
        }

        let local_ids: HashSet<&str> = local.iter().map(|(g, _)| g.as_str()).collect();
        let missing: Vec<String> =
            remote_list.iter().filter(|id| !local_ids.contains(id.as_str())).take(RESYNC_NEW_CAP).cloned().collect();
        let parsed = fetch_messages(api, &missing, false).await?;
        let rows: Vec<ParsedMessage> = parsed.into_iter().flatten().collect();
        self.db.upsert_messages(account_id, &rows)?;

        self.db.set_history_id(account_id, &new_history_id)?;
        log::info!(
            "[sync] full resync done: -{removed} ~{relabelled} +{} (remote {})",
            missing.len(),
            remote_list.len()
        );
        Ok(())
    }

    pub fn status(&self) -> Result<Vec<SyncStatus>> {
        self.db
            .list_accounts()?
            .into_iter()
            .map(|a| {
                Ok(SyncStatus {
                    message_count: self.db.count_messages(&a.id)?,
                    account_id: a.id,
                    email: a.email,
                    backfill_done: a.backfill_done,
                })
            })
            .collect()
    }

    /// 60 s delta ticks, and 1.5 s after start: resume any unfinished backfill
    /// (either phase) and catch up
    pub fn start_scheduler(self: &Arc<Self>) {
        let me = self.clone();
        self.handle.spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + DELTA_INTERVAL, DELTA_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                me.delta_all().await;
            }
        });
        let me = self.clone();
        self.handle.spawn(async move {
            tokio::time::sleep(SCHEDULER_DELAY).await;
            match me.db.list_accounts() {
                Ok(accounts) => {
                    for a in accounts {
                        if a.backfill_done {
                            me.start_body_fill(&a.id);
                        } else {
                            me.start_backfill(&a.id);
                        }
                    }
                }
                Err(e) => log::error!("[sync] could not list accounts: {e}"),
            }
            me.delta_all().await;
        });
    }
}
