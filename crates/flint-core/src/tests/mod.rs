//! Ports of the vitest suites in `src/main/__tests__/`, plus the helpers
//! they share (`helpers.ts`). Every test opens its own database in a temp
//! directory; nothing here touches the real mailbox or the keychain.

mod db_tests;
mod engine_tests;
mod gmail_http_tests;
mod outbox_tests;
mod queries_tests;
mod storage_tests;
mod sync_tests;

use crate::clock::ManualClock;
use crate::db::{BodyState, Db, ParsedMessage};
use crate::google::gmail::*;
use crate::secrets::PlainSecrets;
use crate::types::*;
use crate::Store;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

/// 2026-09-08T12:00:00Z, the instant the TS outbox suite fakes
pub const T0: i64 = 1_788_868_800_000;

pub struct TestDb {
    pub dir: TempDir,
    pub store: Arc<Store>,
    pub clock: Arc<ManualClock>,
}

impl TestDb {
    pub fn db(&self) -> &Arc<Db> {
        &self.store.db
    }

    pub fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("mail.db")
    }

    /// Close and reopen the store on the same file
    pub fn reopen(&mut self) {
        let path = self.path();
        self.store = open_at(&path, self.clock.clone());
    }
}

pub fn open_at(path: &std::path::Path, clock: Arc<ManualClock>) -> Arc<Store> {
    Store::open_with(path, clock, Arc::new(PlainSecrets)).expect("open store")
}

/// A fresh store in a temp dir, on a manual clock at T0
pub fn fresh() -> TestDb {
    let dir = tempfile::tempdir().unwrap();
    let clock = ManualClock::new(T0);
    let store = open_at(&dir.path().join("mail.db"), clock.clone());
    TestDb { dir, store, clock }
}

/// A synced-message record with sensible defaults; override with struct update
pub fn rec(gmail_id: &str) -> ParsedMessage {
    ParsedMessage {
        gmail_id: gmail_id.into(),
        thread_id: format!("th-{gmail_id}"),
        message_id_hdr: Some(format!("<{gmail_id}@example.com>")),
        in_reply_to: None,
        references: vec![],
        from_name: Some("Sender".into()),
        from_addr: "sender@example.com".into(),
        to: vec![mbox(None, "me@example.com")],
        cc: vec![],
        reply_to: None,
        subject: format!("Subject {gmail_id}"),
        date_ms: 1_700_000_000_000,
        snippet: format!("snippet {gmail_id}"),
        body_text: format!("body {gmail_id}"),
        body_html: None,
        body_state: BodyState::Full,
        folder: Folder::Inbox,
        seen: false,
        flagged: false,
        category: "people".into(),
        important: false,
    }
}

pub fn mbox(name: Option<&str>, address: &str) -> Mailbox {
    Mailbox { name: name.map(str::to_string), address: address.into() }
}

pub fn create_account(db: &Db, id: &str, email: &str) {
    db.create_account(id, email, "Me", "#000").unwrap();
}

/// The UI-facing row for a local message, by Message-ID header
pub fn wire(db: &Db, account_id: &str, hdr: &str) -> Option<WireMessage> {
    db.query_window(1000)
        .unwrap()
        .into_iter()
        .find(|m| m.account_id == account_id && m.message_id_hdr.as_deref() == Some(hdr))
}

pub fn input(account_id: &str) -> LocalMessageInput {
    LocalMessageInput {
        account_id: account_id.into(),
        to: vec![mbox(None, "you@example.com")],
        subject: "hi".into(),
        text: "hello there".into(),
        ..Default::default()
    }
}

pub fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ---------- fake Gmail ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub method: &'static str,
    pub args: Vec<Value>,
}

type F<A, R> = Box<dyn Fn(A) -> GResult<R> + Send + Sync>;
/// (raw RFC 822, threadId)
type SendArgs = (Vec<u8>, Option<String>);

/// Per-method behavior; None means the benign default
#[derive(Default)]
pub struct Scripts {
    pub get_profile: Option<F<(), Profile>>,
    pub list_message_ids: Option<F<Option<String>, IdPage>>,
    pub list_all_message_ids: Option<F<Option<Vec<String>>, Vec<String>>>,
    pub find_by_message_id: Option<F<String, Option<String>>>,
    pub get_message: Option<F<String, Option<ParsedMessage>>>,
    pub get_message_metadata: Option<F<String, Option<ParsedMessage>>>,
    pub list_history: Option<F<String, HistoryPage>>,
    pub batch_modify: Option<F<Vec<String>, ()>>,
    pub send: Option<F<SendArgs, SentRef>>,
    pub create_draft: Option<F<(), DraftRef>>,
    pub update_draft: Option<F<String, DraftRef>>,
    pub delete_draft: Option<F<String, ()>>,
    pub find_draft_id_for_message: Option<F<String, Option<String>>>,
    pub trash: Option<F<String, ()>>,
    pub untrash: Option<F<String, ()>>,
}

/// Hand-rolled GmailApi double (helpers.ts fakeGmail): every method records
/// its call, yields once (so concurrent callers interleave the way awaits
/// do in JS), then runs its script or a benign default.
#[derive(Default)]
pub struct FakeGmail {
    pub calls: Mutex<Vec<Call>>,
    scripts: Mutex<Scripts>,
}

pub fn reject<A, R>(status: u16, message: &str) -> Option<F<A, R>> {
    let m = message.to_string();
    Some(Box::new(move |_| Err(GmailError::new(status, m.clone()))))
}

impl FakeGmail {
    pub fn new() -> Arc<FakeGmail> {
        Arc::new(FakeGmail::default())
    }

    pub fn script(&self, f: impl FnOnce(&mut Scripts)) {
        f(&mut self.scripts.lock().unwrap());
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    /// Method names called so far, in order
    pub fn called(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().iter().map(|c| c.method).collect()
    }

    pub fn count(&self, method: &str) -> usize {
        self.called().iter().filter(|m| **m == method).count()
    }

    pub fn args_of(&self, method: &str) -> Vec<Vec<Value>> {
        self.calls().into_iter().filter(|c| c.method == method).map(|c| c.args).collect()
    }

    pub fn clear(&self) {
        self.calls.lock().unwrap().clear();
    }

    async fn record(&self, method: &'static str, args: Vec<Value>) {
        self.calls.lock().unwrap().push(Call { method, args });
        tokio::task::yield_now().await;
    }
}

fn opt(v: Option<&str>) -> Value {
    v.map_or(Value::Null, |s| json!(s))
}

#[async_trait]
impl GmailApi for FakeGmail {
    async fn get_profile(&self) -> GResult<Profile> {
        self.record("getProfile", vec![]).await;
        match &self.scripts.lock().unwrap().get_profile {
            Some(f) => f(()),
            None => Ok(Profile { email_address: "me@example.com".into(), history_id: "1".into() }),
        }
    }

    async fn list_message_ids(&self, page_token: Option<&str>, opts: ListOpts) -> GResult<IdPage> {
        self.record("listMessageIds", vec![opt(page_token), json!(opts.q)]).await;
        match &self.scripts.lock().unwrap().list_message_ids {
            Some(f) => f(page_token.map(str::to_string)),
            None => Ok(IdPage::default()),
        }
    }

    async fn list_all_message_ids(&self, label_ids: Option<Vec<String>>) -> GResult<Vec<String>> {
        self.record("listAllMessageIds", vec![json!(label_ids)]).await;
        match &self.scripts.lock().unwrap().list_all_message_ids {
            Some(f) => f(label_ids),
            None => Ok(vec![]),
        }
    }

    async fn find_by_message_id(&self, hdr: &str) -> GResult<Option<String>> {
        self.record("findByMessageId", vec![json!(hdr)]).await;
        match &self.scripts.lock().unwrap().find_by_message_id {
            Some(f) => f(hdr.into()),
            None => Ok(None),
        }
    }

    async fn get_message(&self, id: &str) -> GResult<Option<ParsedMessage>> {
        self.record("getMessage", vec![json!(id)]).await;
        match &self.scripts.lock().unwrap().get_message {
            Some(f) => f(id.into()),
            None => Ok(None),
        }
    }

    async fn get_message_metadata(&self, id: &str) -> GResult<Option<ParsedMessage>> {
        self.record("getMessageMetadata", vec![json!(id)]).await;
        match &self.scripts.lock().unwrap().get_message_metadata {
            Some(f) => f(id.into()),
            None => Ok(None),
        }
    }

    async fn list_history(&self, start: &str, page_token: Option<&str>) -> GResult<HistoryPage> {
        self.record("listHistory", vec![json!(start), opt(page_token)]).await;
        match &self.scripts.lock().unwrap().list_history {
            Some(f) => f(start.into()),
            None => Ok(HistoryPage::default()),
        }
    }

    async fn batch_modify(&self, ids: &[String], add: &[&str], remove: &[&str]) -> GResult<()> {
        self.record("batchModify", vec![json!(ids), json!(add), json!(remove)]).await;
        match &self.scripts.lock().unwrap().batch_modify {
            Some(f) => f(ids.to_vec()),
            None => Ok(()),
        }
    }

    async fn send(&self, raw: &[u8], thread_id: Option<&str>) -> GResult<SentRef> {
        self.record("send", vec![json!(String::from_utf8_lossy(raw)), opt(thread_id)]).await;
        match &self.scripts.lock().unwrap().send {
            Some(f) => f((raw.to_vec(), thread_id.map(str::to_string))),
            None => Ok(SentRef { id: "gm-sent".into(), thread_id: "th-sent".into() }),
        }
    }

    async fn create_draft(&self, raw: &[u8], thread_id: Option<&str>) -> GResult<DraftRef> {
        self.record("createDraft", vec![json!(String::from_utf8_lossy(raw)), opt(thread_id)]).await;
        match &self.scripts.lock().unwrap().create_draft {
            Some(f) => f(()),
            None => Ok(DraftRef { draft_id: "dr-1".into(), message_id: "gm-dr-1".into(), thread_id: "th-dr-1".into() }),
        }
    }

    async fn update_draft(&self, draft_id: &str, raw: &[u8], thread_id: Option<&str>) -> GResult<DraftRef> {
        self.record("updateDraft", vec![json!(draft_id), json!(String::from_utf8_lossy(raw)), opt(thread_id)]).await;
        match &self.scripts.lock().unwrap().update_draft {
            Some(f) => f(draft_id.into()),
            None => Ok(DraftRef { draft_id: draft_id.into(), message_id: "gm-dr-2".into(), thread_id: "th-dr-1".into() }),
        }
    }

    async fn delete_draft(&self, draft_id: &str) -> GResult<()> {
        self.record("deleteDraft", vec![json!(draft_id)]).await;
        match &self.scripts.lock().unwrap().delete_draft {
            Some(f) => f(draft_id.into()),
            None => Ok(()),
        }
    }

    async fn find_draft_id_for_message(&self, message_id: &str) -> GResult<Option<String>> {
        self.record("findDraftIdForMessage", vec![json!(message_id)]).await;
        match &self.scripts.lock().unwrap().find_draft_id_for_message {
            Some(f) => f(message_id.into()),
            None => Ok(None),
        }
    }

    async fn trash(&self, id: &str) -> GResult<()> {
        self.record("trash", vec![json!(id)]).await;
        match &self.scripts.lock().unwrap().trash {
            Some(f) => f(id.into()),
            None => Ok(()),
        }
    }

    async fn untrash(&self, id: &str) -> GResult<()> {
        self.record("untrash", vec![json!(id)]).await;
        match &self.scripts.lock().unwrap().untrash {
            Some(f) => f(id.into()),
            None => Ok(()),
        }
    }
}
