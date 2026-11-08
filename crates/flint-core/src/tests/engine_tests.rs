//! The facade the UI codes against: blocking calls from
//! a plain thread, the change callback, and the mapping onto sync/outbox.

use super::*;
use crate::Engine;
use std::sync::atomic::{AtomicUsize, Ordering};

const A: &str = "acct";

fn engine() -> (TestDb, Engine, Arc<FakeGmail>, Arc<AtomicUsize>) {
    let t = fresh();
    create_account(t.db(), A, "me@example.com");
    let pings = Arc::new(AtomicUsize::new(0));
    let p = pings.clone();
    let engine = Engine::build(t.store.clone(), move || {
        p.fetch_add(1, Ordering::SeqCst);
    });
    let api = FakeGmail::new();
    engine.sync_engine().apis.lock().unwrap().insert(A.into(), api.clone());
    (t, engine, api, pings)
}

#[test]
fn get_thread_fills_missing_bodies_then_returns_the_thread() {
    let (t, engine, api, _) = engine();
    t.db()
        .upsert_messages(A, &[ParsedMessage { thread_id: "T".into(), body_state: BodyState::Missing, body_text: String::new(), ..rec("g1") }])
        .unwrap();
    api.script(|s| s.get_message = Some(Box::new(|id: String| Ok(Some(ParsedMessage { thread_id: "T".into(), body_text: "full".into(), ..rec(&id) })))));
    let thread = engine.get_thread(&ThreadRef { account_id: A.into(), thread_key: "T".into() }).unwrap();
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].body_text, "full");
}

#[test]
fn get_thread_offline_still_returns_what_it_has() {
    let (t, engine, api, _) = engine();
    t.db()
        .upsert_messages(A, &[ParsedMessage { thread_id: "T".into(), body_state: BodyState::Missing, body_text: String::new(), ..rec("g1") }])
        .unwrap();
    api.script(|s| s.get_message = reject(0, "offline"));
    let thread = engine.get_thread(&ThreadRef { account_id: A.into(), thread_key: "T".into() }).unwrap();
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].body_text, "");
}

#[test]
fn thread_action_mirrors_locally_queues_ops_and_pings_at_once() {
    let (t, engine, _, pings) = engine();
    t.db().upsert_messages(A, &[ParsedMessage { thread_id: "T".into(), ..rec("g1") }, ParsedMessage { thread_id: "T".into(), ..rec("g2") }]).unwrap();
    let before = pings.load(Ordering::SeqCst);
    engine.thread_action(&[ThreadRef { account_id: A.into(), thread_key: "T".into() }], ThreadAction::Archive).unwrap();
    assert!(pings.load(Ordering::SeqCst) > before, "user writes notify immediately");
    assert_eq!(t.db().get_message_wire(A, "g1").unwrap().unwrap().folder, Folder::Archive);
    let ops = t.db().list_ops().unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].payload_strings("gmailIds"), strings(&["g1", "g2"]));
}

#[test]
fn compose_round_trip_through_the_facade() {
    let (t, engine, _, _) = engine();
    let hdr = engine.save_draft(LocalMessageInput { subject: "draft".into(), ..input(A) }).unwrap();
    assert_eq!(t.store.list_drafts(Some(A)).unwrap().len(), 1);
    let hdr2 = engine.queue_send(LocalMessageInput { message_id_hdr: Some(hdr.clone()), ..input(A) }, T0 + 10_000).unwrap();
    assert_eq!(hdr2, hdr);
    assert!(t.store.list_drafts(Some(A)).unwrap().is_empty());
    assert!(engine.cancel_send(A, &hdr, true).unwrap());
    assert_eq!(t.store.message_by_hdr(A, &hdr).unwrap().unwrap().state, MessageState::Draft);
    engine.delete_local(A, &hdr).unwrap();
    assert!(t.store.message_by_hdr(A, &hdr).unwrap().is_none());
    assert!(engine.list_outbox().unwrap().is_empty());
}

#[test]
fn outbox_retry_and_discard_through_the_facade() {
    let (t, engine, api, _) = engine();
    t.db().upsert_messages(A, &[rec("g1")]).unwrap();
    t.db().enqueue_op(A, OpKind::Action, &json!({"gmailIds": ["g1"], "action": "archive", "value": null}), None).unwrap();
    let id = t.db().list_ops().unwrap()[0].id;
    t.db().fail_op(id, "forbidden").unwrap();
    let troubled = engine.list_outbox().unwrap();
    assert_eq!(troubled.len(), 1);
    assert_eq!(troubled[0].gmail_ids, strings(&["g1"]));
    assert_eq!(troubled[0].action.as_deref(), Some("archive"));
    engine.retry_outbox(Some(vec![id])).unwrap();
    assert_eq!(t.db().get_op(id).unwrap().unwrap().state, OpState::Pending);
    api.script(|s| s.get_message = Some(Box::new(|id: String| Ok(Some(rec(&id))))));
    engine.discard_outbox(None).unwrap();
    assert!(t.db().list_ops().unwrap().is_empty());
    assert_eq!(api.count("getMessage"), 1);
}

#[test]
fn refresh_status_and_remove() {
    let (t, engine, api, _) = engine();
    t.db().set_history_id(A, "h0").unwrap();
    engine.refresh().unwrap();
    assert_eq!(api.called(), vec!["listHistory"]);
    let st = engine.sync_status().unwrap();
    assert_eq!(st.len(), 1);
    assert_eq!(st[0].email, "me@example.com");
    engine.remove_account(A).unwrap();
    assert!(t.store.list_accounts().unwrap().is_empty());
}

#[test]
fn engine_clones_share_one_runtime_and_drop_cleanly() {
    let (_t, engine, _, _) = engine();
    let e2 = engine.clone();
    std::thread::spawn(move || e2.sync_status().unwrap()).join().unwrap();
    drop(engine);
}

#[test]
fn default_path_is_the_app_support_file() {
    if std::env::var_os("FLINT_DB").is_none() {
        let p = Store::default_path();
        if cfg!(target_os = "macos") {
            assert!(p.ends_with("Library/Application Support/flint/mail.db"), "{p:?}");
        } else {
            assert!(p.ends_with("flint/mail.db"));
        }
    }
}
