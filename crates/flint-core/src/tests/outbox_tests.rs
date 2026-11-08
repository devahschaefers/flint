//! outbox.test.ts: sends, cancel/retry, drafts, label actions and their
//! lanes, discard, and interrupted-send recovery. The clock is manual, so
//! undo windows and backoff are stepped through like vi's fake Date; the
//! worker never runs on its own, tests call `drain` by hand.

use super::*;
use crate::db::{LocalMessage, LocalPatch, OpRow};
use crate::notify::Notifier;
use crate::outbox::{ApiFor, Outbox};

const A: &str = "acct";
const B: &str = "other";

struct Ctx {
    t: TestDb,
    api: Arc<FakeGmail>,
    api_b: Arc<FakeGmail>,
    outbox: Arc<Outbox>,
}

impl Ctx {
    fn db(&self) -> &Arc<Db> {
        self.t.db()
    }
    fn ops(&self) -> Vec<OpRow> {
        self.db().list_ops().unwrap()
    }
    fn local(&self, hdr: &str) -> Option<LocalMessage> {
        self.db().get_local_message(A, hdr).unwrap()
    }
    fn wire(&self, hdr: &str) -> WireMessage {
        wire(self.db(), A, hdr).expect("row")
    }
    fn now(&self) -> i64 {
        self.t.clock.now_ms()
    }
    fn advance(&self, ms: i64) {
        self.t.clock.advance(ms)
    }
    /// Step the clock past the head op's next attempt
    fn advance_past_head(&self) {
        let due = self.ops()[0].next_attempt_at;
        self.advance(due - self.now() + 1);
    }
    async fn drain(&self) {
        self.outbox.drain().await.unwrap();
    }
    fn msg(&self, gmail_id: &str) -> WireMessage {
        self.db().get_message_wire(A, gmail_id).unwrap().expect("message")
    }
}

use crate::clock::Clock;

fn setup() -> Ctx {
    let t = fresh();
    create_account(t.db(), A, "me@example.com");
    let api = FakeGmail::new();
    let api_b = FakeGmail::new();
    let (a, b) = (api.clone(), api_b.clone());
    let api_for: ApiFor =
        Arc::new(move |id| Ok(if id == A { a.clone() as Arc<dyn GmailApi> } else { b.clone() as Arc<dyn GmailApi> }));
    let outbox = Arc::new(Outbox::new(t.db().clone(), api_for, Arc::new(Notifier::noop()), None));
    Ctx { t, api, api_b, outbox }
}

fn kinds(ops: &[OpRow]) -> Vec<OpKind> {
    ops.iter().map(|o| o.kind).collect()
}

fn hdr_payload(hdr: &str) -> Value {
    json!({ "messageIdHdr": hdr })
}

// ---------- queueSend ----------

#[tokio::test]
async fn queue_send_persists_and_waits_for_send_after() {
    let c = setup();
    let due = c.now() + 5000;
    let hdr = c.outbox.queue_send(&input(A), due).unwrap();
    assert!(hdr.starts_with('<') && hdr.ends_with("@flint.local>"));
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.send_after, l.gmail_id), (MessageState::Queued, Some(due), None));
    assert_eq!(c.wire(&hdr).folder, Folder::Sent);
    let ops = c.ops();
    assert_eq!(ops.len(), 1);
    assert_eq!((ops[0].kind, ops[0].state, ops[0].attempts, ops[0].next_attempt_at), (OpKind::Send, OpState::Pending, 0, due));
    assert_eq!(ops[0].payload, hdr_payload(&hdr));

    c.drain().await;
    assert!(c.api.called().is_empty());
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Queued);

    c.advance(5001);
    c.drain().await;
    assert!(c.api.called().contains(&"send"));
    assert!(c.ops().is_empty());
    assert_eq!(c.local(&hdr).unwrap().gmail_id.as_deref(), Some("gm-sent"));
}

#[tokio::test]
async fn sends_immediately_when_send_after_has_passed() {
    let c = setup();
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.api.count("send"), 1);
    let args = &c.api.args_of("send")[0];
    assert!(args[0].as_str().unwrap().contains(&format!("Message-ID: {hdr}")), "{}", args[0]);
    assert_eq!(args[1], Value::Null);
    assert_eq!(c.local(&hdr).unwrap().thread_id.as_deref(), Some("th-sent"));
}

#[tokio::test]
async fn sending_a_synced_draft_deletes_the_gmail_draft_by_its_message_id() {
    let c = setup();
    let h = "<synced-draft@flint.local>";
    c.db()
        .upsert_messages(A, &[ParsedMessage { message_id_hdr: Some(h.into()), folder: Folder::Drafts, ..rec("draft-msg") }])
        .unwrap();
    c.db().set_local_state(A, h, &LocalPatch { state: Some(MessageState::Draft), ..Default::default() }).unwrap();
    let hdr = c.outbox.queue_send(&LocalMessageInput { message_id_hdr: Some(h.into()), ..input(A) }, c.now()).unwrap();
    c.api.script(|s| s.find_draft_id_for_message = Some(Box::new(|_| Ok(Some("r-draft".into())))));
    c.drain().await;
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref(), l.gmail_draft_id.as_deref()), (MessageState::Sent, Some("gm-sent"), None));
    assert_eq!(c.api.args_of("deleteDraft"), vec![vec![json!("r-draft")]]);
    assert_eq!(c.api.args_of("findDraftIdForMessage"), vec![vec![json!("draft-msg")]]);
    assert!(c.ops().is_empty());
    // the draft_delete payload the send enqueued carries no messageIdHdr key
}

#[tokio::test]
async fn parks_a_send_gmail_rejects_as_failed() {
    let c = setup();
    c.api.script(|s| s.send = reject(400, "Invalid To header"));
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Failed);
    assert_eq!(c.wire(&hdr).send_error.as_deref(), Some("Invalid To header"));
    let ops = c.ops();
    assert_eq!(ops.len(), 1);
    assert_eq!((ops[0].kind, ops[0].state, ops[0].attempts), (OpKind::Send, OpState::Failed, 1));
    assert_eq!(ops[0].last_error.as_deref(), Some("Invalid To header"));
    // Parked ops are not retried on their own
    c.advance(60 * 60_000);
    c.drain().await;
    assert_eq!(c.api.count("send"), 1);
}

#[tokio::test]
async fn defers_transient_send_failures_and_keeps_them_queued() {
    for status in [0u16, 429, 503] {
        let c = setup();
        c.api.script(|s| s.send = reject(status, "flaky"));
        let before = c.now();
        let hdr = c.outbox.queue_send(&input(A), before).unwrap();
        c.drain().await;
        assert_eq!(c.local(&hdr).unwrap().state, MessageState::Queued, "status {status}");
        assert_eq!(c.wire(&hdr).send_error.as_deref(), Some("flaky"));
        let ops = c.ops();
        assert_eq!((ops[0].kind, ops[0].state, ops[0].attempts), (OpKind::Send, OpState::Pending, 1));
        assert_eq!(ops[0].last_error.as_deref(), Some("flaky"));
        assert!(ops[0].next_attempt_at > before);
        // Not due yet: a second drain leaves it alone
        c.drain().await;
        assert_eq!(c.api.count("send"), 1);
    }
}

#[tokio::test]
async fn marks_the_row_sent_before_reading_the_copy_back() {
    let c = setup();
    let hdr = "<fixed@flint.local>";
    c.api.script(|s| s.send = Some(Box::new(|_| Ok(SentRef { id: "gm-42".into(), thread_id: "th-42".into() }))));
    let seen: Arc<Mutex<Option<LocalMessage>>> = Arc::default();
    let (db, s2) = (c.db().clone(), seen.clone());
    c.api.script(move |s| {
        s.get_message = Some(Box::new(move |_| {
            *s2.lock().unwrap() = db.get_local_message(A, hdr).unwrap();
            Err(GmailError::new(500, "read-back down"))
        }))
    });
    c.outbox.queue_send(&LocalMessageInput { message_id_hdr: Some(hdr.into()), ..input(A) }, c.now()).unwrap();
    c.drain().await;
    let during = seen.lock().unwrap().clone().unwrap();
    assert_eq!((during.state, during.gmail_id.as_deref(), during.thread_id.as_deref()), (MessageState::Sent, Some("gm-42"), Some("th-42")));
    // A failing read-back does not undo the send
    let l = c.local(hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref(), l.send_after), (MessageState::Sent, Some("gm-42"), None));
    assert_eq!(c.wire(hdr).send_error, None);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn folds_the_synced_copy_onto_the_same_row() {
    let c = setup();
    let hdr = "<fold@flint.local>";
    c.api.script(|s| {
        s.send = Some(Box::new(|_| Ok(SentRef { id: "gm-42".into(), thread_id: "th-42".into() })));
        s.get_message = Some(Box::new(move |id| {
            Ok(Some(ParsedMessage {
                thread_id: "th-42".into(),
                message_id_hdr: Some(hdr.into()),
                folder: Folder::Sent,
                seen: true,
                ..rec(&id)
            }))
        }));
    });
    c.outbox.queue_send(&LocalMessageInput { message_id_hdr: Some(hdr.into()), ..input(A) }, c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.db().count_messages(A).unwrap(), 1);
    let w = c.wire(hdr);
    assert_eq!((w.state, w.gmail_id.as_deref(), w.folder), (MessageState::Synced, Some("gm-42"), Folder::Sent));
}

#[tokio::test]
async fn asks_gmail_for_the_message_id_before_retrying_and_never_sends_twice() {
    let c = setup();
    c.api.script(|s| s.send = reject(503, "status 503"));
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.ops()[0].attempts, 1);
    c.api.script(|s| s.find_by_message_id = Some(Box::new(|_| Ok(Some("gm-9".into())))));
    c.advance_past_head();
    c.drain().await;
    let called = c.api.called();
    assert_eq!(c.api.count("send"), 1);
    assert_eq!(c.api.count("findByMessageId"), 1);
    assert!(called.iter().position(|m| *m == "findByMessageId") > called.iter().position(|m| *m == "send"));
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref()), (MessageState::Sent, Some("gm-9")));
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn retries_for_real_when_gmail_does_not_have_it_yet() {
    let c = setup();
    c.api.script(|s| s.send = reject(503, "status 503"));
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    c.api.script(|s| s.send = Some(Box::new(|_| Ok(SentRef { id: "gm-second".into(), thread_id: String::new() }))));
    c.advance_past_head();
    c.drain().await;
    assert_eq!(c.api.count("findByMessageId"), 1);
    assert_eq!(c.api.count("send"), 2);
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref()), (MessageState::Sent, Some("gm-second")));
}

#[tokio::test]
async fn does_not_send_a_row_deleted_or_already_sent_meanwhile() {
    let c = setup();
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.db()
        .set_local_state(A, &hdr, &LocalPatch { state: Some(MessageState::Sent), gmail_id: Some(Some("gm-elsewhere".into())), ..Default::default() })
        .unwrap();
    c.drain().await;
    assert!(!c.api.called().contains(&"send"));
    assert!(c.ops().is_empty());

    let hdr2 = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.db().delete_local_message(A, &hdr2).unwrap();
    c.drain().await;
    assert!(!c.api.called().contains(&"send"));
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn retires_the_gmail_draft_a_sent_message_grew_out_of() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    c.drain().await;
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.gmail_draft_id.as_deref(), l.gmail_id.as_deref(), l.state), (Some("dr-1"), Some("gm-dr-1"), MessageState::Draft));

    c.outbox.queue_send(&LocalMessageInput { message_id_hdr: Some(hdr.clone()), ..input(A) }, c.now()).unwrap();
    assert_eq!(kinds(&c.ops()), vec![OpKind::Send]);
    c.drain().await;
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_draft_id), (MessageState::Sent, None));
    assert_eq!(c.api.args_of("deleteDraft"), vec![vec![json!("dr-1")]]);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn the_draft_delete_a_send_enqueues_has_the_ts_payload_shape() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    c.drain().await;
    c.api.script(|s| s.delete_draft = reject(503, "later"));
    c.outbox.queue_send(&LocalMessageInput { message_id_hdr: Some(hdr), ..input(A) }, c.now()).unwrap();
    c.drain().await;
    let ops = c.ops();
    assert_eq!(kinds(&ops), vec![OpKind::DraftDelete]);
    let raw: String = rusqlite::Connection::open(c.t.path())
        .unwrap()
        .query_row("SELECT payload FROM ops", [], |r| r.get(0))
        .unwrap();
    assert_eq!(raw, r#"{"gmailDraftId":"dr-1","gmailId":"gm-dr-1"}"#);
}

#[tokio::test]
async fn marks_the_parent_answered_and_replies_on_the_parent_thread() {
    let c = setup();
    c.db()
        .upsert_messages(A, &[ParsedMessage { message_id_hdr: Some("<p@x>".into()), thread_id: "th-P".into(), ..rec("P") }])
        .unwrap();
    c.outbox
        .queue_send(
            &LocalMessageInput {
                in_reply_to: Some("<p@x>".into()),
                references: strings(&["<p@x>"]),
                thread_id: Some("th-P".into()),
                ..input(A)
            },
            c.now(),
        )
        .unwrap();
    assert!(c.msg("P").answered);
    c.drain().await;
    assert_eq!(c.api.args_of("send")[0][1], json!("th-P"));
}

// ---------- cancelSend ----------

fn reply() -> LocalMessageInput {
    LocalMessageInput {
        in_reply_to: Some("<p@x>".into()),
        references: strings(&["<p@x>"]),
        thread_id: Some("th-P".into()),
        ..input(A)
    }
}

fn with_parent() -> Ctx {
    let c = setup();
    c.db()
        .upsert_messages(A, &[ParsedMessage { message_id_hdr: Some("<p@x>".into()), thread_id: "th-P".into(), ..rec("P") }])
        .unwrap();
    c
}

#[tokio::test]
async fn cancel_deletes_a_queued_send_and_reverts_answered() {
    let c = with_parent();
    let hdr = c.outbox.queue_send(&reply(), c.now() + 5000).unwrap();
    assert!(c.msg("P").answered);
    assert!(c.outbox.cancel_send(A, &hdr, false).unwrap());
    assert!(c.local(&hdr).is_none());
    assert!(c.ops().is_empty());
    assert!(!c.msg("P").answered);
    c.advance(6000);
    c.drain().await;
    assert!(c.api.called().is_empty());
}

#[tokio::test]
async fn cancel_leaves_answered_while_another_own_reply_exists() {
    let c = with_parent();
    let first = c.outbox.queue_send(&reply(), c.now() + 5000).unwrap();
    c.outbox.queue_send(&reply(), c.now() + 5000).unwrap();
    assert!(c.outbox.cancel_send(A, &first, false).unwrap());
    assert!(c.msg("P").answered);
    assert_eq!(c.ops().len(), 1);
}

#[tokio::test]
async fn cancel_as_draft_queues_a_draft_push() {
    let c = with_parent();
    let hdr = c.outbox.queue_send(&reply(), c.now() + 5000).unwrap();
    assert!(c.outbox.cancel_send(A, &hdr, true).unwrap());
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.send_after), (MessageState::Draft, None));
    let w = c.wire(&hdr);
    assert_eq!((w.folder, w.send_error), (Folder::Drafts, None));
    assert_eq!(kinds(&c.ops()), vec![OpKind::DraftPut]);
    assert_eq!(c.ops()[0].payload, hdr_payload(&hdr));
    // Only queued/sent replies count as answering; a draft withdraws the flag
    assert!(!c.msg("P").answered);
    c.drain().await;
    assert_eq!(c.api.called(), vec!["createDraft"]);
    assert_eq!(c.api.calls()[0].args[1], json!("th-P"));
}

#[tokio::test]
async fn cancel_turns_a_failed_send_into_a_draft() {
    let c = with_parent();
    c.api.script(|s| s.send = reject(400, "status 400"));
    let hdr = c.outbox.queue_send(&reply(), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Failed);
    assert!(c.outbox.cancel_send(A, &hdr, true).unwrap());
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Draft);
    assert_eq!(kinds(&c.ops()), vec![OpKind::DraftPut]);
}

#[tokio::test]
async fn cancel_refuses_once_running_sent_or_unknown() {
    let c = with_parent();
    let hdr = c.outbox.queue_send(&reply(), c.now()).unwrap();
    c.db().mark_op_running(c.ops()[0].id).unwrap();
    assert!(!c.outbox.cancel_send(A, &hdr, false).unwrap());
    assert!(c.local(&hdr).is_some());
    c.db().reset_running_ops().unwrap();
    c.drain().await;
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Sent);
    assert!(!c.outbox.cancel_send(A, &hdr, false).unwrap());
    assert!(!c.outbox.cancel_send(A, "<missing@flint.local>", false).unwrap());
}

// ---------- retrySend ----------

#[tokio::test]
async fn retry_send_requeues_a_failed_send() {
    let c = setup();
    c.api.script(|s| s.send = reject(400, "status 400"));
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Failed);
    c.api.script(|s| s.send = Some(Box::new(|_| Ok(SentRef { id: "gm-ok".into(), thread_id: String::new() }))));
    c.outbox.retry_send(A, &hdr).unwrap();
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.send_after), (MessageState::Queued, Some(c.now())));
    let ops = c.ops();
    assert_eq!(ops.len(), 1);
    assert_eq!((ops[0].state, ops[0].last_error.clone()), (OpState::Pending, None));
    c.drain().await;
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref()), (MessageState::Sent, Some("gm-ok")));
    // the retried op had attempts > 0, so it verified before sending
    assert!(c.api.called().contains(&"findByMessageId"));
}

// ---------- drafts ----------

#[tokio::test]
async fn save_draft_coalesces_repeated_saves() {
    let c = setup();
    let hdr = c.outbox.save_draft(&LocalMessageInput { subject: "v1".into(), ..input(A) }).unwrap();
    for v in ["v2", "v3"] {
        c.outbox.save_draft(&LocalMessageInput { message_id_hdr: Some(hdr.clone()), subject: v.into(), ..input(A) }).unwrap();
    }
    assert_eq!(c.db().count_messages(A).unwrap(), 1);
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.subject.as_str(), l.gmail_draft_id), (MessageState::Draft, "v3", None));
    assert_eq!(c.wire(&hdr).folder, Folder::Drafts);
    assert_eq!(kinds(&c.ops()), vec![OpKind::DraftPut]);

    c.drain().await;
    assert_eq!(c.api.called(), vec!["createDraft"]);
    let l = c.local(&hdr).unwrap();
    assert_eq!(
        (l.gmail_draft_id.as_deref(), l.gmail_id.as_deref(), l.thread_id.as_deref()),
        (Some("dr-1"), Some("gm-dr-1"), Some("th-dr-1"))
    );
    assert!(c.ops().is_empty());

    c.outbox.save_draft(&LocalMessageInput { message_id_hdr: Some(hdr.clone()), subject: "v4".into(), ..input(A) }).unwrap();
    c.drain().await;
    assert_eq!(c.api.called(), vec!["createDraft", "updateDraft"]);
    assert_eq!(c.api.calls()[1].args[0], json!("dr-1"));
    assert_eq!(c.local(&hdr).unwrap().gmail_id.as_deref(), Some("gm-dr-2"));
}

#[tokio::test]
async fn save_draft_over_a_failed_send_withdraws_it_from_the_send_lane() {
    let c = setup();
    c.api.script(|s| s.send = reject(400, "status 400"));
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(kinds(&c.ops()), vec![OpKind::Send]);
    c.outbox.save_draft(&LocalMessageInput { message_id_hdr: Some(hdr.clone()), subject: "edited".into(), ..input(A) }).unwrap();
    assert_eq!(kinds(&c.ops()), vec![OpKind::DraftPut]);
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.subject.as_str()), (MessageState::Draft, "edited"));
    assert_eq!(c.wire(&hdr).send_error, None);
}

#[tokio::test]
async fn a_synced_draft_without_a_draft_id_is_looked_up_before_updating() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    c.db().delete_ops(&c.ops().iter().map(|o| o.id).collect::<Vec<_>>()).unwrap();
    c.db().set_local_state(A, &hdr, &LocalPatch { gmail_id: Some(Some("gm-synced-draft".into())), ..Default::default() }).unwrap();
    c.api.script(|s| s.find_draft_id_for_message = Some(Box::new(|_| Ok(Some("dr-found".into())))));
    c.outbox.save_draft(&LocalMessageInput { message_id_hdr: Some(hdr.clone()), subject: "edited".into(), ..input(A) }).unwrap();
    c.drain().await;
    assert_eq!(c.api.called(), vec!["findDraftIdForMessage", "updateDraft"]);
    assert_eq!(c.api.calls()[0].args, vec![json!("gm-synced-draft")]);
    assert_eq!(c.api.calls()[1].args[0], json!("dr-found"));
    assert_eq!(c.local(&hdr).unwrap().gmail_draft_id.as_deref(), Some("dr-found"));
}

#[tokio::test]
async fn delete_local_on_a_pushed_draft_queues_the_gmail_delete() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    c.drain().await;
    c.outbox.delete_local(A, &hdr).unwrap();
    assert!(c.local(&hdr).is_none());
    assert_eq!(kinds(&c.ops()), vec![OpKind::DraftDelete]);
    assert_eq!(c.ops()[0].payload, json!({ "messageIdHdr": hdr, "gmailDraftId": "dr-1", "gmailId": "gm-dr-1" }));
    c.drain().await;
    assert_eq!(c.api.args_of("deleteDraft"), vec![vec![json!("dr-1")]]);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn delete_local_on_a_never_pushed_draft_owes_gmail_nothing() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    assert_eq!(c.ops().len(), 1);
    c.outbox.delete_local(A, &hdr).unwrap();
    assert!(c.local(&hdr).is_none());
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn delete_local_on_a_synced_draft_finds_its_draft_id() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    c.db().delete_ops(&c.ops().iter().map(|o| o.id).collect::<Vec<_>>()).unwrap();
    c.db().set_local_state(A, &hdr, &LocalPatch { gmail_id: Some(Some("gm-synced-draft".into())), ..Default::default() }).unwrap();
    c.api.script(|s| s.find_draft_id_for_message = Some(Box::new(|_| Ok(Some("dr-found".into())))));
    c.outbox.delete_local(A, &hdr).unwrap();
    assert_eq!(kinds(&c.ops()), vec![OpKind::DraftDelete]);
    c.drain().await;
    assert_eq!(c.api.called(), vec!["findDraftIdForMessage", "deleteDraft"]);
    assert_eq!(c.api.calls()[1].args, vec![json!("dr-found")]);
}

#[tokio::test]
async fn a_draft_put_for_a_row_that_became_a_send_is_a_no_op() {
    let c = setup();
    let hdr = c.outbox.save_draft(&input(A)).unwrap();
    c.db().set_local_state(A, &hdr, &LocalPatch { state: Some(MessageState::Queued), ..Default::default() }).unwrap();
    c.drain().await;
    assert!(c.api.called().is_empty());
    assert!(c.ops().is_empty());
}

// ---------- label actions ----------

fn with_messages() -> Ctx {
    let c = setup();
    c.db().upsert_messages(A, &[rec("g1"), rec("g2")]).unwrap();
    c
}

fn ids(v: &[&str]) -> Vec<String> {
    strings(v)
}

fn bm(ids: &[&str], add: &[&str], remove: &[&str]) -> Vec<Value> {
    vec![json!(ids), json!(add), json!(remove)]
}

#[tokio::test]
async fn mirrors_the_action_locally_and_pushes_the_label_change() {
    let c = with_messages();
    c.outbox.apply_action(A, &ids(&["g1", "g2"]), MailAction::Archive, None).unwrap();
    assert_eq!(c.msg("g1").folder, Folder::Archive);
    assert_eq!(c.ops()[0].kind, OpKind::Action);
    assert_eq!(c.ops()[0].payload, json!({ "gmailIds": ["g1", "g2"], "action": "archive", "value": null }));
    let raw: String = rusqlite::Connection::open(c.t.path())
        .unwrap()
        .query_row("SELECT payload FROM ops", [], |r| r.get(0))
        .unwrap();
    assert_eq!(raw, r#"{"gmailIds":["g1","g2"],"action":"archive","value":null}"#);
    c.drain().await;
    assert_eq!(c.api.calls(), vec![Call { method: "batchModify", args: bm(&["g1", "g2"], &[], &["INBOX"]) }]);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn runs_fifo_per_account_and_a_deferred_head_blocks_the_lane() {
    let c = with_messages();
    c.api.script(|s| s.batch_modify = reject(503, "status 503"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Seen, Some(true)).unwrap();
    c.drain().await;
    assert_eq!(c.api.args_of("batchModify"), vec![bm(&["g1"], &[], &["INBOX"])]);
    assert_eq!(
        c.ops().iter().map(|o| (o.state, o.attempts)).collect::<Vec<_>>(),
        vec![(OpState::Pending, 1), (OpState::Pending, 0)]
    );
    let w = c.msg("g1");
    assert_eq!((w.folder, w.seen), (Folder::Archive, true));

    c.api.script(|s| s.batch_modify = None);
    c.drain().await;
    assert_eq!(c.api.calls().len(), 1); // head not due yet, tail still blocked

    c.advance_past_head();
    c.drain().await;
    assert_eq!(
        c.api.args_of("batchModify"),
        vec![bm(&["g1"], &[], &["INBOX"]), bm(&["g1"], &[], &["INBOX"]), bm(&["g1"], &[], &["UNREAD"])]
    );
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn a_failed_head_parks_and_blocks_the_rest_of_its_lane() {
    let c = with_messages();
    c.api.script(|s| s.batch_modify = reject(403, "forbidden"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.outbox.apply_action(A, &ids(&["g2"]), MailAction::Flagged, Some(true)).unwrap();
    c.drain().await;
    c.advance(60 * 60_000);
    c.drain().await;
    assert_eq!(c.api.calls().len(), 1);
    assert_eq!(c.ops().iter().map(|o| o.state).collect::<Vec<_>>(), vec![OpState::Failed, OpState::Pending]);
    assert_eq!(
        c.outbox.list_troubled().unwrap().iter().map(|o| o.action.clone()).collect::<Vec<_>>(),
        vec![Some("archive".to_string())]
    );
}

#[tokio::test]
async fn a_blocked_lane_does_not_hold_up_another_account() {
    let c = with_messages();
    create_account(c.db(), B, "b@example.com");
    c.db().upsert_messages(B, &[rec("g9")]).unwrap();
    c.api.script(|s| s.batch_modify = reject(503, "status 503"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.outbox.apply_action(B, &ids(&["g9"]), MailAction::Flagged, Some(true)).unwrap();
    c.drain().await;
    assert_eq!(c.api_b.calls(), vec![Call { method: "batchModify", args: bm(&["g9"], &["STARRED"], &[]) }]);
    assert!(c.ops().iter().all(|o| o.account_id != B));
}

#[tokio::test]
async fn sends_are_not_held_behind_a_blocked_action_lane() {
    let c = with_messages();
    c.api.script(|s| s.batch_modify = reject(503, "status 503"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Sent);
}

#[tokio::test]
async fn trash_and_inbox_map_to_per_message_calls() {
    let c = with_messages();
    c.outbox.apply_action(A, &ids(&["g1", "g2"]), MailAction::Trash, None).unwrap();
    c.drain().await;
    assert_eq!(
        c.api.calls(),
        vec![Call { method: "trash", args: vec![json!("g1")] }, Call { method: "trash", args: vec![json!("g2")] }]
    );
    assert_eq!(c.msg("g1").folder, Folder::Trash);

    c.api.clear();
    c.api.script(|s| s.untrash = reject(400, "not in trash"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Inbox, None).unwrap();
    c.drain().await;
    assert_eq!(c.api.called(), vec!["untrash", "batchModify"]);
    assert_eq!(c.api.calls()[1].args, bm(&["g1"], &["INBOX"], &["SPAM"]));
    assert_eq!(c.msg("g1").folder, Folder::Inbox);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn ignores_an_empty_selection() {
    let c = with_messages();
    c.outbox.apply_action(A, &[], MailAction::Archive, None).unwrap();
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn a_404_batch_is_retried_per_message_and_missing_ones_count_as_done() {
    let c = with_messages();
    c.api.script(|s| {
        s.batch_modify = Some(Box::new(|ids: Vec<String>| {
            if ids.len() > 1 || ids[0] == "g2" {
                Err(GmailError::new(404, "Requested entity was not found"))
            } else {
                Ok(())
            }
        }))
    });
    c.outbox.apply_action(A, &ids(&["g1", "g2"]), MailAction::Archive, None).unwrap();
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Seen, Some(true)).unwrap();
    c.drain().await;
    assert_eq!(
        c.api.args_of("batchModify"),
        vec![
            bm(&["g1", "g2"], &[], &["INBOX"]),
            bm(&["g1"], &[], &["INBOX"]),
            bm(&["g2"], &[], &["INBOX"]),
            bm(&["g1"], &[], &["UNREAD"]),
        ]
    );
    assert!(c.ops().is_empty());
    assert!(c.outbox.list_troubled().unwrap().is_empty());
}

#[tokio::test]
async fn a_single_missing_message_counts_as_done_without_a_retry() {
    let c = with_messages();
    c.api.script(|s| s.batch_modify = reject(404, "status 404"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Flagged, Some(true)).unwrap();
    c.drain().await;
    assert_eq!(c.api.calls().len(), 1);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn the_per_message_retry_still_parks_on_other_errors() {
    let c = with_messages();
    c.api.script(|s| {
        s.batch_modify = Some(Box::new(|ids: Vec<String>| {
            if ids.len() > 1 {
                Err(GmailError::new(404, "not found"))
            } else if ids[0] == "g1" {
                Err(GmailError::new(403, "forbidden"))
            } else {
                Ok(())
            }
        }))
    });
    c.outbox.apply_action(A, &ids(&["g1", "g2"]), MailAction::Archive, None).unwrap();
    c.drain().await;
    assert_eq!(
        c.ops().iter().map(|o| (o.state, o.last_error.clone())).collect::<Vec<_>>(),
        vec![(OpState::Failed, Some("forbidden".into()))]
    );
}

#[tokio::test]
async fn trashing_a_message_that_is_already_gone_is_done() {
    let c = with_messages();
    c.api.script(|s| {
        s.trash = Some(Box::new(|id: String| if id == "g2" { Err(GmailError::new(404, "not found")) } else { Ok(()) }))
    });
    c.outbox.apply_action(A, &ids(&["g1", "g2"]), MailAction::Trash, None).unwrap();
    c.drain().await;
    assert_eq!(c.api.called(), vec!["trash", "trash"]);
    assert!(c.ops().is_empty());
}

// ---------- discard ----------

#[tokio::test]
async fn discard_drops_ops_refetches_and_keeps_failed_sends_as_drafts() {
    let c = with_messages();
    c.api.script(|s| {
        s.batch_modify = reject(403, "status 403");
        s.send = reject(400, "rejected");
    });
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.outbox.apply_action(A, &ids(&["g2"]), MailAction::Seen, Some(true)).unwrap();
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.drain().await;
    assert_eq!(c.ops().iter().map(|o| o.state).collect::<Vec<_>>(), vec![OpState::Failed, OpState::Pending, OpState::Failed]);
    assert_eq!(c.msg("g1").folder, Folder::Archive);

    c.api.script(|s| {
        s.get_message = Some(Box::new(|id: String| {
            if id == "g2" {
                Ok(None) // gone from Gmail meanwhile
            } else {
                Ok(Some(ParsedMessage { flagged: true, ..rec(&id) }))
            }
        }))
    });
    c.outbox.discard(None).await.unwrap();

    let ops = c.ops();
    assert_eq!(ops.iter().map(|o| (o.kind, o.payload_str("messageIdHdr").map(str::to_string))).collect::<Vec<_>>(), vec![(OpKind::DraftPut, Some(hdr.clone()))]);
    let mut fetched: Vec<Value> = c.api.args_of("getMessage").into_iter().map(|a| a[0].clone()).collect();
    fetched.sort_by_key(|v| v.to_string());
    assert_eq!(fetched, vec![json!("g1"), json!("g2")]);
    let w = c.msg("g1");
    assert_eq!((w.folder, w.seen, w.flagged), (Folder::Inbox, false, true));
    assert!(c.db().get_message_wire(A, "g2").unwrap().is_none());
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.send_after), (MessageState::Draft, None));
    let w = c.wire(&hdr);
    assert_eq!((w.folder, w.send_error), (Folder::Drafts, None));
    assert_eq!(c.db().count_messages(A).unwrap(), 2);
}

#[tokio::test]
async fn discard_only_the_given_ops_and_never_a_running_one() {
    let c = with_messages();
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.outbox.apply_action(A, &ids(&["g2"]), MailAction::Archive, None).unwrap();
    let ops = c.ops();
    let (first, second) = (ops[0].id, ops[1].id);
    c.db().mark_op_running(second).unwrap();
    c.outbox.discard(Some(&[first, second])).await.unwrap();
    assert_eq!(c.ops().iter().map(|o| o.id).collect::<Vec<_>>(), vec![second]);
    assert_eq!(c.api.calls().iter().map(|c| c.args[0].clone()).collect::<Vec<_>>(), vec![json!("g1")]);
}

#[tokio::test]
async fn discard_survives_a_failing_refetch() {
    let c = with_messages();
    c.api.script(|s| s.get_message = reject(500, "status 500"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.outbox.discard(None).await.unwrap();
    assert!(c.ops().is_empty());
}

// ---------- recoverInterrupted ----------

/// A send the process died in the middle of
fn interrupted_send(c: &Ctx) -> String {
    let hdr = c.outbox.queue_send(&input(A), c.now()).unwrap();
    c.db().mark_op_running(c.ops()[0].id).unwrap();
    c.db().set_local_state(A, &hdr, &LocalPatch { state: Some(MessageState::Sending), ..Default::default() }).unwrap();
    hdr
}

#[tokio::test]
async fn recovery_marks_a_running_send_sent_when_gmail_has_it() {
    let c = setup();
    let hdr = interrupted_send(&c);
    c.api.script(|s| s.find_by_message_id = Some(Box::new(|_| Ok(Some("gm-7".into())))));
    c.outbox.recover_interrupted().await.unwrap();
    assert_eq!(c.api.called(), vec!["findByMessageId", "getMessage"]);
    assert_eq!(c.api.calls()[0].args, vec![json!(hdr)]);
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref(), l.send_after), (MessageState::Sent, Some("gm-7"), None));
    assert!(c.ops().is_empty());
    c.drain().await;
    assert!(!c.api.called().contains(&"send"));
}

#[tokio::test]
async fn recovery_defers_an_unverified_send_so_it_rechecks_before_sending() {
    let c = setup();
    let hdr = interrupted_send(&c);
    c.outbox.recover_interrupted().await.unwrap();
    assert_eq!(c.api.called(), vec!["findByMessageId"]);
    let op = &c.ops()[0];
    assert_eq!((op.kind, op.state, op.attempts), (OpKind::Send, OpState::Pending, 1));
    assert!(op.next_attempt_at > c.now());
    assert_eq!(c.local(&hdr).unwrap().state, MessageState::Queued);
    c.drain().await;
    assert!(!c.api.called().contains(&"send"));

    // Later, Gmail turns out to have it after all: no second send
    c.advance_past_head();
    c.api.script(|s| s.find_by_message_id = Some(Box::new(|_| Ok(Some("gm-late".into())))));
    c.drain().await;
    assert!(!c.api.called().contains(&"send"));
    let l = c.local(&hdr).unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref()), (MessageState::Sent, Some("gm-late")));
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn recovery_defers_when_verification_fails() {
    let c = setup();
    interrupted_send(&c);
    c.api.script(|s| s.find_by_message_id = reject(0, "offline"));
    c.outbox.recover_interrupted().await.unwrap();
    let op = &c.ops()[0];
    assert_eq!((op.state, op.attempts, op.last_error.as_deref()), (OpState::Pending, 1, Some("offline")));
    assert!(op.next_attempt_at > c.now());
    c.drain().await;
    assert_eq!(c.api.called(), vec!["findByMessageId"]);
}

#[tokio::test]
async fn recovery_drops_a_running_send_whose_message_is_gone() {
    let c = setup();
    let hdr = interrupted_send(&c);
    c.db().delete_local_message(A, &hdr).unwrap();
    c.outbox.recover_interrupted().await.unwrap();
    assert!(c.ops().is_empty());
    assert!(c.api.called().is_empty());
}

#[tokio::test]
async fn recovery_simply_reruns_interrupted_label_actions() {
    let c = setup();
    c.db().upsert_messages(A, &[rec("g1")]).unwrap();
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    c.db().mark_op_running(c.ops()[0].id).unwrap();
    c.outbox.recover_interrupted().await.unwrap();
    assert_eq!(c.ops()[0].state, OpState::Pending);
    c.drain().await;
    assert_eq!(c.api.called(), vec!["batchModify"]);
    assert!(c.ops().is_empty());
}

#[tokio::test]
async fn backoff_doubles_from_five_seconds_up_to_five_minutes() {
    let c = with_messages();
    c.api.script(|s| s.batch_modify = reject(503, "status 503"));
    c.outbox.apply_action(A, &ids(&["g1"]), MailAction::Archive, None).unwrap();
    let mut waits = Vec::new();
    for _ in 0..8 {
        let before = c.now();
        c.drain().await;
        waits.push(c.ops()[0].next_attempt_at - before);
        c.advance_past_head();
    }
    assert_eq!(waits, vec![5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
}
