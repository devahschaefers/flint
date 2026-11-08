//! Persisted queue of everything we owe Gmail:
//! label actions, sends, and draft pushes. Every user intent is written to
//! SQLite first and drained here with backoff. Transient failures keep an op
//! pending; permanent ones park it as failed until the user retries or
//! discards.
//!
//! Lanes: label actions run strictly in order per account (archive then
//! unarchive must land in that order). Send and draft ops are independent of
//! each other and of actions, and run whenever due.

use crate::db::{Db, LocalMessage, LocalPatch, OpRow};
use crate::google::gmail::{GmailApi, GmailError};
use crate::mime::{build_mime, OutgoingMail};
use crate::notify::Notifier;
use crate::sync::gmail_status;
use crate::types::{Folder, LocalMessageInput, MailAction, Mailbox, MessageState, OpKind, OpState, WireOp};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Handle;
use tokio::sync::Notify;

const POLL: Duration = Duration::from_secs(10);
const MAX_BACKOFF_MS: i64 = 5 * 60_000;
const BASE_BACKOFF_MS: i64 = 5_000;
const WAKE_DEBOUNCE: Duration = Duration::from_millis(50);

pub type ApiFor = Arc<dyn Fn(&str) -> Result<Arc<dyn GmailApi>> + Send + Sync>;

fn make_message_id() -> String {
    format!("<{}@flint.local>", uuid::Uuid::new_v4())
}

fn backoff(attempts: i64) -> i64 {
    if attempts >= 16 {
        return MAX_BACKOFF_MS;
    }
    (BASE_BACKOFF_MS * 2i64.pow(attempts.max(0) as u32)).min(MAX_BACKOFF_MS)
}

/// Worth retrying later (network, rate limit, server trouble)?
fn is_transient(e: &anyhow::Error) -> bool {
    matches!(gmail_status(e), Some(s) if s == 0 || s == 429 || s >= 500)
}

/// Gmail says the message does not exist (any more)
fn is_gone(e: &GmailError) -> bool {
    e.status == 404
}

fn error_text(e: &anyhow::Error) -> String {
    e.to_string()
}

// Payload shapes, field order and keys as the TS objects JSON.stringify to

#[derive(Serialize)]
struct ActionPayload<'a> {
    #[serde(rename = "gmailIds")]
    gmail_ids: &'a [String],
    action: &'a str,
    value: Option<bool>,
}

#[derive(Serialize)]
struct HdrPayload<'a> {
    #[serde(rename = "messageIdHdr")]
    message_id_hdr: &'a str,
}

#[derive(Serialize)]
struct DraftDeletePayload<'a> {
    #[serde(rename = "messageIdHdr", skip_serializing_if = "Option::is_none")]
    message_id_hdr: Option<&'a str>,
    #[serde(rename = "gmailDraftId")]
    gmail_draft_id: Option<&'a str>,
    #[serde(rename = "gmailId")]
    gmail_id: Option<&'a str>,
}

pub struct Outbox {
    db: Arc<Db>,
    api_for: ApiFor,
    notifier: Arc<Notifier>,
    /// Where wake timers run; None in tests that drive `drain` by hand
    handle: Option<Handle>,
    wake: Arc<Notify>,
    draining: AtomicBool,
    queued: AtomicBool,
}

impl Outbox {
    pub fn new(db: Arc<Db>, api_for: ApiFor, notifier: Arc<Notifier>, handle: Option<Handle>) -> Outbox {
        Outbox {
            db,
            api_for,
            notifier,
            handle,
            wake: Arc::new(Notify::new()),
            draining: AtomicBool::new(false),
            queued: AtomicBool::new(false),
        }
    }

    fn changed(&self) {
        self.notifier.mail_changed(true);
    }

    // ---------- intents ----------

    /// Mirror a label action locally and queue its writeback
    pub fn apply_action(&self, account_id: &str, gmail_ids: &[String], action: MailAction, value: Option<bool>) -> Result<()> {
        if gmail_ids.is_empty() {
            return Ok(());
        }
        self.db.apply_local_action(account_id, gmail_ids, action.as_str(), value)?;
        self.db.enqueue_op(account_id, OpKind::Action, &ActionPayload { gmail_ids, action: action.as_str(), value }, None)?;
        self.changed();
        self.kick(0);
        Ok(())
    }

    fn own_mailbox(&self, account_id: &str) -> Result<Mailbox> {
        let account = self.db.get_account(account_id)?.ok_or_else(|| anyhow!("Unknown account"))?;
        Ok(Mailbox { name: Some(account.name), address: account.email })
    }

    /// Store a draft locally and queue a push to Gmail Drafts (coalescing pending pushes)
    pub fn save_draft(&self, input: &LocalMessageInput) -> Result<String> {
        let from = self.own_mailbox(&input.account_id)?;
        let hdr = input.message_id_hdr.clone().unwrap_or_else(make_message_id);
        let existing = match &input.message_id_hdr {
            Some(h) => self.db.get_local_message(&input.account_id, h)?,
            None => None,
        };
        // Editing a queued/failed send back into a draft withdraws it from the send lane
        if existing.is_some_and(|e| e.state != MessageState::Draft) {
            self.drop_pending_ops_for(&input.account_id, &hdr)?;
        }
        self.db.put_local_message(input, &hdr, &from, MessageState::Draft, Folder::Drafts, None)?;
        // One pending push per draft is enough; it reads the latest content when it runs
        let pending = self
            .db
            .find_ops_for_message(&input.account_id, &hdr)?
            .into_iter()
            .any(|op| op.kind == OpKind::DraftPut && op.state == OpState::Pending);
        if !pending {
            self.db.enqueue_op(&input.account_id, OpKind::DraftPut, &HdrPayload { message_id_hdr: &hdr }, None)?;
        }
        self.changed();
        self.kick(0);
        Ok(hdr)
    }

    /// Delete a local message; if Gmail holds a draft for it, queue that delete too
    pub fn delete_local(&self, account_id: &str, hdr: &str) -> Result<()> {
        let Some(local) = self.db.get_local_message(account_id, hdr)? else { return Ok(()) };
        self.drop_pending_ops_for(account_id, hdr)?;
        if local.gmail_draft_id.is_some() || (local.gmail_id.is_some() && local.state == MessageState::Draft) {
            self.db.enqueue_op(
                account_id,
                OpKind::DraftDelete,
                &DraftDeletePayload {
                    message_id_hdr: Some(hdr),
                    gmail_draft_id: local.gmail_draft_id.as_deref(),
                    gmail_id: local.gmail_id.as_deref(),
                },
                None,
            )?;
        }
        self.db.delete_local_message(account_id, hdr)?;
        self.changed();
        self.kick(0);
        Ok(())
    }

    /// Persist an outgoing message and queue it to leave at `send_after`
    pub fn queue_send(&self, input: &LocalMessageInput, send_after: i64) -> Result<String> {
        let from = self.own_mailbox(&input.account_id)?;
        let hdr = input.message_id_hdr.clone().unwrap_or_else(make_message_id);
        let existing = match &input.message_id_hdr {
            Some(h) => self.db.get_local_message(&input.account_id, h)?,
            None => None,
        };
        // A draft that becomes a send must not also get pushed as a draft
        if existing.is_some() {
            self.drop_pending_ops_for(&input.account_id, &hdr)?;
        }
        self.db.put_local_message(input, &hdr, &from, MessageState::Queued, Folder::Sent, Some(send_after))?;
        self.db.enqueue_op(&input.account_id, OpKind::Send, &HdrPayload { message_id_hdr: &hdr }, Some(send_after))?;
        if let Some(parent) = &input.in_reply_to {
            self.db.set_answered(&input.account_id, parent, true)?;
        }
        self.changed();
        self.kick((send_after - self.db.now()).max(0));
        Ok(hdr)
    }

    /// Cancel a queued send; false once it is sending or sent. `as_draft`
    /// turns it back into a draft, otherwise it is deleted (toast Undo).
    pub fn cancel_send(&self, account_id: &str, hdr: &str, as_draft: bool) -> Result<bool> {
        let Some(local) = self.db.get_local_message(account_id, hdr)? else { return Ok(false) };
        if local.state != MessageState::Queued && local.state != MessageState::Failed {
            return Ok(false);
        }
        let ops = self.db.find_ops_for_message(account_id, hdr)?;
        if ops.iter().any(|op| op.state == OpState::Running) {
            return Ok(false);
        }
        self.db.delete_ops(&ops.iter().map(|op| op.id).collect::<Vec<_>>())?;
        if as_draft {
            self.db.set_local_state(
                account_id,
                hdr,
                &LocalPatch {
                    state: Some(MessageState::Draft),
                    folder: Some(Folder::Drafts),
                    send_after: Some(None),
                    send_error: Some(None),
                    ..Default::default()
                },
            )?;
            self.db.enqueue_op(account_id, OpKind::DraftPut, &HdrPayload { message_id_hdr: hdr }, None)?;
        } else {
            self.db.delete_local_message(account_id, hdr)?;
        }
        if let Some(parent) = &local.in_reply_to {
            let still = match self.db.get_account(account_id)? {
                Some(a) => self.db.has_own_reply(account_id, parent, &a.email, hdr)?,
                None => false,
            };
            if !still {
                self.db.set_answered(account_id, parent, false)?;
            }
        }
        self.changed();
        self.kick(0);
        Ok(true)
    }

    /// Put a failed send back in the queue
    pub fn retry_send(&self, account_id: &str, hdr: &str) -> Result<()> {
        let Some(local) = self.db.get_local_message(account_id, hdr)? else { return Ok(()) };
        if local.state != MessageState::Failed {
            return Ok(());
        }
        let ops: Vec<i64> = self
            .db
            .find_ops_for_message(account_id, hdr)?
            .into_iter()
            .filter(|op| op.kind == OpKind::Send)
            .map(|op| op.id)
            .collect();
        if ops.is_empty() {
            self.db.enqueue_op(account_id, OpKind::Send, &HdrPayload { message_id_hdr: hdr }, None)?;
        } else {
            self.db.retry_ops(Some(&ops))?;
        }
        self.db.set_local_state(
            account_id,
            hdr,
            &LocalPatch {
                state: Some(MessageState::Queued),
                send_after: Some(Some(self.db.now())),
                send_error: Some(None),
                ..Default::default()
            },
        )?;
        self.changed();
        self.kick(0);
        Ok(())
    }

    /// Ops the user should know about: anything that has errored at least once
    pub fn list_troubled(&self) -> Result<Vec<WireOp>> {
        Ok(self
            .db
            .list_ops()?
            .iter()
            .filter(|op| op.last_error.is_some() || op.state == OpState::Failed)
            .map(OpRow::to_wire)
            .collect())
    }

    pub fn retry(&self, ids: Option<&[i64]>) -> Result<()> {
        self.db.retry_ops(ids)?;
        self.changed();
        self.kick(0);
        Ok(())
    }

    /// Discard ops and put the affected messages back the way Gmail has
    /// them. Sends are kept as drafts so nothing the user wrote is lost.
    pub async fn discard(&self, ids: Option<&[i64]>) -> Result<()> {
        let ops: Vec<OpRow> = self
            .db
            .list_ops()?
            .into_iter()
            .filter(|op| ids.is_none_or(|ids| ids.contains(&op.id)) && op.state != OpState::Running)
            .collect();
        let mut refetch: Vec<(String, Vec<String>)> = Vec::new();
        let draft_patch = LocalPatch {
            state: Some(MessageState::Draft),
            folder: Some(Folder::Drafts),
            send_after: Some(None),
            send_error: Some(None),
            ..Default::default()
        };
        for op in &ops {
            match op.kind {
                OpKind::Action => {
                    let entry = match refetch.iter_mut().find(|(a, _)| *a == op.account_id) {
                        Some(e) => e,
                        None => {
                            refetch.push((op.account_id.clone(), Vec::new()));
                            refetch.last_mut().unwrap()
                        }
                    };
                    for id in op.payload_strings("gmailIds") {
                        if !entry.1.contains(&id) {
                            entry.1.push(id);
                        }
                    }
                }
                OpKind::Send => {
                    if let Some(hdr) = op.payload_str("messageIdHdr") {
                        self.db.set_local_state(&op.account_id, hdr, &draft_patch)?;
                    }
                }
                _ => {}
            }
        }
        self.db.delete_ops(&ops.iter().map(|op| op.id).collect::<Vec<_>>())?;
        // The text of a discarded send lives on as a draft, in Gmail too
        for op in &ops {
            if op.kind == OpKind::Send {
                if let Some(hdr) = op.payload_str("messageIdHdr") {
                    if self.db.get_local_message(&op.account_id, hdr)?.is_some() {
                        self.db.enqueue_op(&op.account_id, OpKind::DraftPut, &HdrPayload { message_id_hdr: hdr }, None)?;
                    }
                }
            }
        }
        self.changed();
        for (account_id, gmail_ids) in refetch {
            let api = match (self.api_for)(&account_id) {
                Ok(a) => a,
                Err(e) => {
                    log::error!("[outbox] discard refetch failed: {e:#}");
                    continue;
                }
            };
            for id in gmail_ids {
                let res: Result<()> = async {
                    match api.get_message(&id).await? {
                        Some(p) => self.db.upsert_messages(&account_id, &[p])?,
                        None => self.db.delete_message(&account_id, &id)?,
                    }
                    Ok(())
                }
                .await;
                if let Err(e) = res {
                    log::error!("[outbox] discard refetch failed: {e:#}");
                }
            }
        }
        self.changed();
        Ok(())
    }

    fn drop_pending_ops_for(&self, account_id: &str, hdr: &str) -> Result<()> {
        let ids: Vec<i64> = self
            .db
            .find_ops_for_message(account_id, hdr)?
            .into_iter()
            .filter(|op| op.state != OpState::Running)
            .map(|op| op.id)
            .collect();
        self.db.delete_ops(&ids)
    }

    // ---------- worker ----------

    /// Recover interrupted ops, then drain on every kick and every 10 s
    pub fn start(self: &Arc<Self>) {
        let Some(handle) = &self.handle else { return };
        let me = self.clone();
        handle.spawn(async move {
            if let Err(e) = me.recover_interrupted().await {
                log::error!("[outbox] recovery failed: {e:#}");
            }
            let mut poll = tokio::time::interval_at(tokio::time::Instant::now() + POLL, POLL);
            poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            me.kick(0);
            loop {
                tokio::select! {
                    _ = poll.tick() => {}
                    _ = me.wake.notified() => tokio::time::sleep(WAKE_DEBOUNCE).await,
                }
                if let Err(e) = me.drain().await {
                    log::error!("[outbox] drain failed: {e:#}");
                }
            }
        });
    }

    /// Ops that were running when the process died. Label actions are
    /// idempotent and simply rerun. A send may or may not have gone out: ask
    /// Gmail for the Message-ID before deciding, so nothing is sent twice.
    pub(crate) async fn recover_interrupted(&self) -> Result<()> {
        for op in self.db.reset_running_ops()? {
            if op.kind != OpKind::Send {
                continue;
            }
            let hdr = op.payload_str("messageIdHdr").unwrap_or_default().to_string();
            if self.db.get_local_message(&op.account_id, &hdr)?.is_none() {
                self.db.delete_op(op.id)?;
                continue;
            }
            let found: Result<Option<String>> = async {
                let api = (self.api_for)(&op.account_id)?;
                Ok(api.find_by_message_id(&hdr).await?)
            }
            .await;
            match found {
                Ok(Some(gmail_id)) => {
                    self.db.set_local_state(
                        &op.account_id,
                        &hdr,
                        &LocalPatch {
                            state: Some(MessageState::Sent),
                            gmail_id: Some(Some(gmail_id.clone())),
                            send_after: Some(None),
                            send_error: Some(None),
                            ..Default::default()
                        },
                    )?;
                    self.db.delete_op(op.id)?;
                    self.read_back(&op.account_id, &gmail_id).await;
                }
                Ok(None) => {
                    // Not found is not proof it never left: Gmail's Message-ID
                    // search lags acceptance. Count an attempt and wait, so the
                    // worker asks again before it would ever send.
                    let msg = "interrupted before confirmation";
                    self.db.defer_op(op.id, msg, self.db.now() + BASE_BACKOFF_MS)?;
                    self.db.set_local_state(
                        &op.account_id,
                        &hdr,
                        &LocalPatch {
                            state: Some(MessageState::Queued),
                            send_error: Some(Some(msg.into())),
                            ..Default::default()
                        },
                    )?;
                }
                Err(e) => {
                    log::error!("[outbox] could not verify interrupted send: {e:#}");
                    self.db.defer_op(op.id, &error_text(&e), self.db.now() + BASE_BACKOFF_MS)?;
                }
            }
        }
        Ok(())
    }

    /// Ask the worker to drain soon, or once an undo window elapses
    pub fn kick(&self, delay_ms: i64) {
        if delay_ms > 0 {
            // Precise wake for undo windows; polling covers retries
            if delay_ms <= POLL.as_millis() as i64 * 6 {
                if let Some(h) = &self.handle {
                    let wake = self.wake.clone();
                    h.spawn(async move {
                        tokio::time::sleep(Duration::from_millis(delay_ms as u64 + 50)).await;
                        wake.notify_one();
                    });
                }
            }
            return;
        }
        self.wake.notify_one();
    }

    /// Run every due op; keeps passing until a pass completes nothing
    pub async fn drain(&self) -> Result<()> {
        if self.draining.swap(true, Ordering::SeqCst) {
            self.queued.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let res = self.drain_passes().await;
        self.draining.store(false, Ordering::SeqCst);
        if self.queued.swap(false, Ordering::SeqCst) {
            self.kick(0);
        }
        res
    }

    async fn drain_passes(&self) -> Result<()> {
        // Ops enqueue other ops (a send queues the delete of the draft it grew
        // out of). A failed or deferred op is no longer due, so it cannot spin.
        let mut ran_any = true;
        while ran_any {
            ran_any = false;
            let now = self.db.now();
            let mut order: Vec<String> = Vec::new();
            let mut by_account: HashMap<String, Vec<OpRow>> = HashMap::new();
            for op in self.db.list_ops()? {
                if !by_account.contains_key(&op.account_id) {
                    order.push(op.account_id.clone());
                }
                by_account.entry(op.account_id.clone()).or_default().push(op);
            }
            let mut known: HashSet<String> = HashSet::new();
            for account_id in order {
                let ops = by_account.remove(&account_id).unwrap_or_default();
                if !known.contains(&account_id) {
                    if self.db.get_account(&account_id)?.is_none() {
                        continue;
                    }
                    known.insert(account_id.clone());
                }
                // Actions lane: strict FIFO; a deferred/failed head blocks the lane
                for op in ops.iter().filter(|o| o.kind == OpKind::Action) {
                    if op.state != OpState::Pending || op.next_attempt_at > now {
                        break;
                    }
                    if !self.run(op).await? {
                        break;
                    }
                    ran_any = true;
                }
                // Independent lanes
                for op in ops.iter().filter(|o| o.kind != OpKind::Action) {
                    if op.state != OpState::Pending || op.next_attempt_at > now {
                        continue;
                    }
                    if self.run(op).await? {
                        ran_any = true;
                    }
                }
            }
        }
        Ok(())
    }

    /// Execute one op; Ok(true) on success. Err only for store failures
    /// while recording the outcome.
    async fn run(&self, op: &OpRow) -> Result<bool> {
        self.db.mark_op_running(op.id)?;
        let res = match op.kind {
            OpKind::Action => self.run_action(op).await,
            OpKind::Send => self.run_send(op).await,
            OpKind::DraftPut => self.run_draft_put(op).await,
            OpKind::DraftDelete => self.run_draft_delete(op).await,
        };
        match res {
            Ok(()) => {
                self.db.delete_op(op.id)?;
                self.changed();
                Ok(true)
            }
            Err(e) => {
                let text = error_text(&e);
                let hdr = op.payload_str("messageIdHdr");
                let kind = crate::db::op_kind_str(op.kind);
                if is_transient(&e) {
                    log::warn!("[outbox] {kind} #{} deferred: {text}", op.id);
                    self.db.defer_op(op.id, &text, self.db.now() + backoff(op.attempts))?;
                    if let (Some(h), OpKind::Send) = (hdr, op.kind) {
                        self.db.set_local_state(
                            &op.account_id,
                            h,
                            &LocalPatch {
                                state: Some(MessageState::Queued),
                                send_error: Some(Some(text.clone())),
                                ..Default::default()
                            },
                        )?;
                    }
                } else {
                    log::error!("[outbox] {kind} #{} failed: {text}", op.id);
                    self.db.fail_op(op.id, &text)?;
                    if let (Some(h), OpKind::Send) = (hdr, op.kind) {
                        self.db.set_local_state(
                            &op.account_id,
                            h,
                            &LocalPatch {
                                state: Some(MessageState::Failed),
                                send_error: Some(Some(text.clone())),
                                ..Default::default()
                            },
                        )?;
                    }
                }
                self.changed();
                Ok(false)
            }
        }
    }

    async fn run_action(&self, op: &OpRow) -> Result<()> {
        let api = (self.api_for)(&op.account_id)?;
        let ids = op.payload_strings("gmailIds");
        let value = op.payload.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
        let api = api.as_ref();
        match op.payload_str("action").unwrap_or_default() {
            "seen" => {
                if value {
                    modify(api, &ids, &[], &["UNREAD"]).await?
                } else {
                    modify(api, &ids, &["UNREAD"], &[]).await?
                }
            }
            "flagged" => {
                if value {
                    modify(api, &ids, &["STARRED"], &[]).await?
                } else {
                    modify(api, &ids, &[], &["STARRED"]).await?
                }
            }
            "archive" => modify(api, &ids, &[], &["INBOX"]).await?,
            "unarchive" => modify(api, &ids, &["INBOX"], &[]).await?,
            "trash" => {
                for id in &ids {
                    // Already gone is the same as trashed; sync removes the row
                    if let Err(e) = api.trash(id).await {
                        if !is_gone(&e) {
                            return Err(e.into());
                        }
                    }
                }
            }
            "spam" => modify(api, &ids, &["SPAM"], &["INBOX"]).await?,
            "inbox" => {
                // Coming back from trash needs untrash; harmless 4xx if it wasn't there
                for id in &ids {
                    let _ = api.untrash(id).await;
                }
                modify(api, &ids, &["INBOX"], &["SPAM"]).await?
            }
            other => log::warn!("[outbox] unknown action {other:?}; dropped"),
        }
        Ok(())
    }

    async fn run_send(&self, op: &OpRow) -> Result<()> {
        let hdr = op.payload_str("messageIdHdr").unwrap_or_default().to_string();
        let Some(local) = self.db.get_local_message(&op.account_id, &hdr)? else {
            return Ok(()); // deleted meanwhile
        };
        if local.state == MessageState::Sent || local.state == MessageState::Synced {
            return Ok(());
        }
        self.db.set_local_state(&op.account_id, &hdr, &LocalPatch { state: Some(MessageState::Sending), ..Default::default() })?;
        self.changed();
        let api = (self.api_for)(&op.account_id)?;
        // A retry after an unverified attempt must not double-send
        if op.attempts > 0 {
            if let Some(already) = api.find_by_message_id(&hdr).await? {
                self.db.set_local_state(
                    &op.account_id,
                    &hdr,
                    &LocalPatch {
                        state: Some(MessageState::Sent),
                        gmail_id: Some(Some(already.clone())),
                        send_after: Some(None),
                        send_error: Some(None),
                        ..Default::default()
                    },
                )?;
                self.read_back(&op.account_id, &already).await;
                return Ok(());
            }
        }
        let raw = self.build_raw(&local)?;
        let sent = api.send(&raw, local.thread_id.as_deref()).await?;
        // Gmail accepted it: that is the moment it counts as sent
        let thread = if sent.thread_id.is_empty() { local.thread_id.clone() } else { Some(sent.thread_id.clone()) };
        self.db.set_local_state(
            &op.account_id,
            &hdr,
            &LocalPatch {
                state: Some(MessageState::Sent),
                gmail_id: Some(Some(sent.id.clone())),
                thread_id: Some(thread),
                send_after: Some(None),
                send_error: Some(None),
                gmail_draft_id: Some(None),
                ..Default::default()
            },
        )?;
        self.changed();
        // The Gmail draft this grew out of is now redundant; a synced draft only
        // carries its draft *message* id, which the delete op resolves
        if local.gmail_draft_id.is_some() || local.gmail_id.is_some() {
            self.db.enqueue_op(
                &op.account_id,
                OpKind::DraftDelete,
                &DraftDeletePayload {
                    message_id_hdr: None,
                    gmail_draft_id: local.gmail_draft_id.as_deref(),
                    gmail_id: local.gmail_id.as_deref(),
                },
                None,
            )?;
        }
        self.read_back(&op.account_id, &sent.id).await;
        Ok(())
    }

    fn build_raw(&self, local: &LocalMessage) -> Result<Vec<u8>> {
        let account = self.db.get_account(&local.account_id)?.ok_or_else(|| GmailError::new(400, "Unknown account"))?;
        build_mime(&OutgoingMail {
            from: Mailbox { name: Some(account.name), address: account.email },
            to: local.to.clone(),
            cc: local.cc.clone(),
            subject: local.subject.clone(),
            text: local.body_text.clone(),
            html: local.body_html.clone(),
            in_reply_to: local.in_reply_to.clone(),
            references: local.references.clone(),
            message_id: Some(local.message_id_hdr.clone()),
        })
    }

    /// Best-effort refresh of the synced copy; delta sync catches it otherwise
    async fn read_back(&self, account_id: &str, gmail_id: &str) {
        let res: Result<()> = async {
            let api = (self.api_for)(account_id)?;
            if let Some(p) = api.get_message(gmail_id).await? {
                self.db.upsert_messages(account_id, &[p])?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = res {
            log::warn!("[outbox] sent, but reading the copy back failed: {e:#}");
        }
    }

    async fn run_draft_put(&self, op: &OpRow) -> Result<()> {
        let hdr = op.payload_str("messageIdHdr").unwrap_or_default().to_string();
        let local = match self.db.get_local_message(&op.account_id, &hdr)? {
            Some(l) if l.state == MessageState::Draft => l,
            _ => return Ok(()), // deleted or sent meanwhile
        };
        let api = (self.api_for)(&op.account_id)?;
        let raw = self.build_raw(&local)?;
        let mut draft_id = local.gmail_draft_id.clone();
        // A draft that arrived via sync has a message id but no draft id yet
        if draft_id.is_none() {
            if let Some(g) = &local.gmail_id {
                draft_id = api.find_draft_id_for_message(g).await?;
            }
        }
        let res = match &draft_id {
            Some(d) => api.update_draft(d, &raw, local.thread_id.as_deref()).await?,
            None => api.create_draft(&raw, local.thread_id.as_deref()).await?,
        };
        let thread = if res.thread_id.is_empty() { local.thread_id.clone() } else { Some(res.thread_id) };
        self.db.set_local_state(
            &op.account_id,
            &hdr,
            &LocalPatch {
                gmail_draft_id: Some(Some(res.draft_id)),
                gmail_id: Some((!res.message_id.is_empty()).then_some(res.message_id)),
                thread_id: Some(thread),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    async fn run_draft_delete(&self, op: &OpRow) -> Result<()> {
        let api = (self.api_for)(&op.account_id)?;
        let mut draft_id = op.payload_str("gmailDraftId").map(str::to_string);
        let gmail_id = op.payload_str("gmailId").map(str::to_string);
        if draft_id.is_none() {
            if let Some(g) = &gmail_id {
                draft_id = api.find_draft_id_for_message(g).await?;
            }
        }
        if let Some(d) = draft_id {
            api.delete_draft(&d).await?;
        }
        Ok(())
    }
}

/// batchModify fails wholesale (404) when any id in it no longer exists. On
/// a 404 the batch is retried one message at a time and per-message 404s
/// count as done; delta sync removes the local rows shortly after.
async fn modify(api: &dyn GmailApi, ids: &[String], add: &[&str], remove: &[&str]) -> Result<(), GmailError> {
    match api.batch_modify(ids, add, remove).await {
        Ok(()) => return Ok(()),
        Err(e) if !is_gone(&e) => return Err(e),
        Err(_) => {}
    }
    if ids.len() == 1 {
        log::warn!("[outbox] {} no longer exists on Gmail; label change dropped", ids[0]);
        return Ok(());
    }
    for id in ids {
        if let Err(e) = api.batch_modify(std::slice::from_ref(id), add, remove).await {
            if !is_gone(&e) {
                return Err(e);
            }
            log::warn!("[outbox] {id} no longer exists on Gmail; label change dropped");
        }
    }
    Ok(())
}
