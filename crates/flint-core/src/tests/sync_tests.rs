//! sync.test.ts: history-expired full resync, delta sync, metadata-first
//! backfill, body fill, and ensureBodies. Tests run on a current-thread
//! runtime so spawned body fills only progress when the test awaits, the
//! way they do on Node's event loop.

use super::*;
use crate::notify::Notifier;
use crate::sync::{gmail_status, SyncEngine};
use std::collections::HashMap;
use std::time::Duration;

const A: &str = "acct";

struct S {
    t: TestDb,
    api: Arc<FakeGmail>,
    sync: Arc<SyncEngine>,
}

impl S {
    fn db(&self) -> &Arc<Db> {
        self.t.db()
    }
    fn msg(&self, id: &str) -> WireMessage {
        self.db().get_message_wire(A, id).unwrap().expect("message")
    }
    fn ids(&self) -> Vec<String> {
        let mut v = self.db().list_gmail_ids(A).unwrap();
        v.sort();
        v
    }
    /// Remote mailbox as label listings: which ids carry which label
    fn remote(&self, all: &[&str], labels: &[(&str, &[&str])]) {
        let all = strings(all);
        let labels: HashMap<String, Vec<String>> = labels.iter().map(|(l, ids)| (l.to_string(), strings(ids))).collect();
        self.api.script(move |s| {
            s.list_all_message_ids = Some(Box::new(move |label_ids: Option<Vec<String>>| {
                Ok(match label_ids {
                    None => all.clone(),
                    Some(ls) => ls.iter().flat_map(|l| labels.get(l).cloned().unwrap_or_default()).collect(),
                })
            }))
        });
    }
    fn seed_local(&self) {
        self.db()
            .upsert_messages(
                A,
                &[
                    rec("g1"),
                    ParsedMessage { seen: true, ..rec("g2") },
                    ParsedMessage { folder: Folder::Archive, seen: true, ..rec("g3") },
                ],
            )
            .unwrap();
    }
    fn history_id(&self) -> Option<String> {
        self.db().get_history_id(A).unwrap()
    }
}

fn fetched(id: &str) -> ParsedMessage {
    ParsedMessage { subject: format!("fetched {id}"), ..rec(id) }
}

fn setup() -> S {
    let t = fresh();
    create_account(t.db(), A, "me@example.com");
    t.db().set_history_id(A, "old-anchor").unwrap();
    let api = FakeGmail::new();
    let sync = Arc::new(SyncEngine::new(
        t.db().clone(),
        Arc::new(Notifier::noop()),
        tokio::runtime::Handle::current(),
        reqwest::Client::new(),
    ));
    // The engine builds a real client per account on demand; seed its cache instead
    sync.apis.lock().unwrap().insert(A.into(), api.clone());
    api.script(|s| {
        s.list_history = reject(404, "history expired");
        s.get_profile = Some(Box::new(|_| Ok(Profile { email_address: "me@example.com".into(), history_id: "new-anchor".into() })));
        s.get_message = Some(Box::new(|id: String| Ok(Some(fetched(&id)))));
    });
    S { t, api, sync }
}

fn fetched_ids(api: &FakeGmail) -> Vec<String> {
    let mut v: Vec<String> = api.args_of("getMessage").into_iter().map(|a| a[0].as_str().unwrap().to_string()).collect();
    v.sort();
    v
}

#[tokio::test]
async fn full_resync_reconciles_deletions_labels_and_new_mail() {
    let s = setup();
    s.seed_local();
    // g2 is gone remotely; g4, g5 are new; g1 was read and archived; g3 got starred+important
    s.remote(&["g1", "g3", "g4", "g5"], &[("INBOX", &["g4", "g5"]), ("UNREAD", &["g4"]), ("STARRED", &["g3"]), ("IMPORTANT", &["g3"])]);
    s.sync.delta_all().await;
    assert_eq!(s.ids(), strings(&["g1", "g3", "g4", "g5"]));
    let g1 = s.msg("g1");
    assert_eq!((g1.folder, g1.seen), (Folder::Archive, true));
    let g3 = s.msg("g3");
    assert_eq!((g3.folder, g3.seen, g3.flagged, g3.important), (Folder::Archive, true, true, true));
    let g4 = s.msg("g4");
    assert_eq!((g4.subject.as_str(), g4.folder), ("fetched g4", Folder::Inbox));
    assert_eq!(s.msg("g5").subject, "fetched g5");
    assert_eq!(fetched_ids(&s.api), strings(&["g4", "g5"]));
    assert_eq!(s.history_id().as_deref(), Some("new-anchor"));
}

#[tokio::test]
async fn full_resync_consults_every_state_label_and_their_precedence() {
    let s = setup();
    s.db()
        .upsert_messages(
            A,
            &[rec("a"), rec("b"), rec("c"), rec("d"), ParsedMessage { folder: Folder::Archive, ..rec("e") }],
        )
        .unwrap();
    s.remote(
        &["a", "b", "c", "d", "e"],
        &[("INBOX", &["a", "b", "c", "d", "e"]), ("DRAFT", &["a"]), ("SPAM", &["b"]), ("TRASH", &["c"]), ("SENT", &["e"])],
    );
    s.sync.delta_all().await;
    let mut label_args: Vec<String> = s
        .api
        .args_of("listAllMessageIds")
        .into_iter()
        .map(|a| a[0].as_array().map(|l| l[0].as_str().unwrap().to_string()).unwrap_or_else(|| "*".into()))
        .collect();
    label_args.sort();
    let mut want = strings(&["*", "INBOX", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "DRAFT", "SENT"]);
    want.sort();
    assert_eq!(label_args, want);
    assert_eq!(s.msg("a").folder, Folder::Drafts);
    assert_eq!(s.msg("b").folder, Folder::Spam);
    assert_eq!(s.msg("c").folder, Folder::Trash);
    assert_eq!(s.msg("d").folder, Folder::Inbox);
    assert_eq!(s.msg("e").folder, Folder::Inbox);
}

#[tokio::test]
async fn full_resync_captures_the_anchor_before_listing() {
    let s = setup();
    s.seed_local();
    s.remote(&["g1", "g2", "g3"], &[("INBOX", &["g1", "g2"])]);
    s.sync.delta_all().await;
    let order = s.api.called();
    assert!(order.iter().position(|m| *m == "getProfile") < order.iter().position(|m| *m == "listAllMessageIds"));
    assert_eq!(s.history_id().as_deref(), Some("new-anchor"));
}

#[tokio::test]
async fn full_resync_leaves_local_rows_without_a_gmail_id_alone() {
    let s = setup();
    s.seed_local();
    let li = LocalMessageInput { account_id: A.into(), subject: "unsent".into(), text: "body".into(), ..Default::default() };
    s.db()
        .put_local_message(&li, "<draft@flint.local>", &mbox(Some("Me"), "me@example.com"), MessageState::Draft, Folder::Drafts, None)
        .unwrap();
    s.remote(&["g1", "g2", "g3"], &[("INBOX", &["g1", "g2"])]);
    s.sync.delta_all().await;
    assert_eq!(s.db().get_local_message(A, "<draft@flint.local>").unwrap().unwrap().state, MessageState::Draft);
    assert_eq!(s.db().count_messages(A).unwrap(), 4);
}

#[tokio::test]
async fn full_resync_keeps_just_sent_mail_gmail_has_not_listed_yet() {
    let s = setup();
    s.seed_local();
    let li = LocalMessageInput {
        account_id: A.into(),
        to: vec![mbox(None, "you@example.com")],
        subject: "out the door".into(),
        text: "body".into(),
        ..Default::default()
    };
    let h = "<sent@flint.local>";
    s.db().put_local_message(&li, h, &mbox(Some("Me"), "me@example.com"), MessageState::Sent, Folder::Sent, None).unwrap();
    s.db()
        .set_local_state(A, h, &crate::db::LocalPatch { gmail_id: Some(Some("g-just-sent".into())), ..Default::default() })
        .unwrap();
    s.remote(&["g1", "g2", "g3"], &[("INBOX", &["g1", "g2"])]);
    s.sync.delta_all().await;
    let l = s.db().get_local_message(A, h).unwrap().unwrap();
    assert_eq!((l.state, l.gmail_id.as_deref()), (MessageState::Sent, Some("g-just-sent")));
    assert_eq!(s.db().count_messages(A).unwrap(), 4);
}

#[tokio::test]
async fn full_resync_keeps_the_old_anchor_when_fetching_new_mail_fails() {
    let s = setup();
    s.seed_local();
    s.remote(&["g1", "g3", "g4"], &[("INBOX", &["g1", "g3", "g4"])]);
    s.api.script(|sc| sc.get_message = reject(500, "backend error"));
    s.sync.delta_all().await;
    assert_eq!(s.history_id().as_deref(), Some("old-anchor"));
    // The steps before the failure have already been applied
    assert_eq!(s.ids(), strings(&["g1", "g3"]));
    assert_eq!(s.msg("g3").folder, Folder::Inbox);
}

#[tokio::test]
async fn full_resync_keeps_the_old_anchor_when_a_label_listing_fails() {
    let s = setup();
    s.seed_local();
    s.api.script(|sc| {
        sc.list_all_message_ids = Some(Box::new(|labels: Option<Vec<String>>| match labels {
            Some(l) if l[0] == "STARRED" => Err(GmailError::new(503, "unavailable")),
            Some(_) => Ok(vec![]),
            None => Ok(strings(&["g1", "g2", "g3"])),
        }))
    });
    s.sync.delta_all().await;
    assert_eq!(s.history_id().as_deref(), Some("old-anchor"));
    assert!(!s.api.called().contains(&"getMessage"));
}

#[tokio::test]
async fn full_resync_keeps_the_old_anchor_when_the_profile_call_fails() {
    let s = setup();
    s.seed_local();
    s.api.script(|sc| sc.get_profile = reject(0, "offline"));
    s.sync.delta_all().await;
    assert_eq!(s.history_id().as_deref(), Some("old-anchor"));
    assert_eq!(s.ids(), strings(&["g1", "g2", "g3"]));
}

#[tokio::test]
async fn non_404_history_errors_are_rethrown_not_resynced() {
    let s = setup();
    s.seed_local();
    s.api.script(|sc| sc.list_history = reject(401, "unauthorized"));
    let err = s.sync.delta_inner(A).await.unwrap_err();
    assert_eq!(gmail_status(&err), Some(401));
    assert_eq!(s.api.called(), vec!["listHistory"]);
    assert_eq!(s.history_id().as_deref(), Some("old-anchor"));
    assert_eq!(s.ids(), strings(&["g1", "g2", "g3"]));
}

#[tokio::test]
async fn delta_is_skipped_for_an_account_with_no_anchor() {
    let s = setup();
    create_account(s.db(), "fresh", "fresh@example.com");
    let fresh_api = FakeGmail::new();
    s.sync.apis.lock().unwrap().insert("fresh".into(), fresh_api.clone());
    s.sync.delta_all().await;
    assert!(fresh_api.called().is_empty());
}

#[tokio::test]
async fn delta_applies_adds_deletes_and_label_changes_and_advances_the_anchor() {
    let s = setup();
    s.seed_local();
    s.api.script(|sc| {
        sc.list_history = Some(Box::new(|_| {
            Ok(HistoryPage {
                history_id: Some("h-next".into()),
                next_page_token: None,
                history: vec![HistoryEntry {
                    messages_added: strings(&["g9"]),
                    messages_deleted: strings(&["g2"]),
                    label_changes: vec![("g1".into(), strings(&["STARRED"])), ("unknown".into(), strings(&["INBOX"]))],
                }],
            })
        }))
    });
    s.sync.delta_all().await;
    assert_eq!(s.api.args_of("listHistory")[0][0], json!("old-anchor"));
    assert_eq!(s.ids(), strings(&["g1", "g3", "g9"]));
    let g1 = s.msg("g1");
    assert_eq!((g1.folder, g1.flagged, g1.seen), (Folder::Archive, true, true));
    assert_eq!(s.history_id().as_deref(), Some("h-next"));
    assert!(!s.db().has_message(A, "unknown").unwrap());
}

#[tokio::test]
async fn delta_follows_history_pages() {
    let s = setup();
    s.seed_local();
    s.api.script(|sc| {
        sc.list_history = Some(Box::new(|_| Ok(HistoryPage::default())));
    });
    // Two pages: the fake hands back the page token it was given
    let calls = Arc::new(Mutex::new(0));
    let c2 = calls.clone();
    s.api.script(move |sc| {
        sc.list_history = Some(Box::new(move |_| {
            let mut n = c2.lock().unwrap();
            *n += 1;
            Ok(if *n == 1 {
                HistoryPage { history: vec![HistoryEntry { messages_deleted: strings(&["g1"]), ..Default::default() }], history_id: Some("h1".into()), next_page_token: Some("p2".into()) }
            } else {
                HistoryPage { history: vec![HistoryEntry { messages_deleted: strings(&["g2"]), ..Default::default() }], history_id: Some("h2".into()), next_page_token: None }
            })
        }))
    });
    s.sync.delta_all().await;
    assert_eq!(s.api.args_of("listHistory")[1], vec![json!("old-anchor"), json!("p2")]);
    assert_eq!(s.ids(), strings(&["g3"]));
    assert_eq!(s.history_id().as_deref(), Some("h2"));
}

// ---------- metadata-first backfill ----------

fn date_of(id: &str) -> i64 {
    match id {
        "g1" => 3000,
        "g2" => 2000,
        "g3" => 1000,
        _ => 0,
    }
}

fn thread_of(id: &str) -> &'static str {
    if id == "g3" {
        "T2"
    } else {
        "T1"
    }
}

fn backfill_setup() -> S {
    let s = setup();
    s.api.script(|sc| {
        sc.get_message_metadata = Some(Box::new(|id: String| {
            Ok(Some(ParsedMessage {
                thread_id: thread_of(&id).into(),
                subject: format!("meta {id}"),
                body_text: String::new(),
                body_state: BodyState::Missing,
                date_ms: date_of(&id),
                ..rec(&id)
            }))
        }));
        sc.get_message = Some(Box::new(|id: String| {
            Ok(Some(ParsedMessage {
                thread_id: thread_of(&id).into(),
                subject: format!("meta {id}"),
                body_text: format!("full body {id}"),
                body_html: Some(format!("<p>full body {id}</p>")),
                date_ms: date_of(&id),
                seen: true,
                ..rec(&id)
            }))
        }));
    });
    s
}

async fn wait_for_body_fill(s: &S) {
    for _ in 0..400 {
        if !s.sync.body_filling.lock().unwrap().contains(A) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("body fill did not finish");
}

fn missing(id: &str) -> ParsedMessage {
    ParsedMessage { thread_id: thread_of(id).into(), body_state: BodyState::Missing, body_text: String::new(), ..rec(id) }
}

#[tokio::test]
async fn backfill_stores_metadata_for_every_page_then_fills_bodies_newest_first() {
    let s = backfill_setup();
    s.api.script(|sc| {
        sc.list_message_ids = Some(Box::new(|token: Option<String>| {
            Ok(match token {
                Some(_) => IdPage { ids: strings(&["g3"]), next_page_token: None },
                None => IdPage { ids: strings(&["g1", "g2"]), next_page_token: Some("p2".into()) },
            })
        }))
    });
    s.sync.backfill_loop(A).await.unwrap();

    // Phase 1 done: everything browsable, nothing fetched in full yet
    assert_eq!(s.db().get_backfill_state(A).unwrap().unwrap(), crate::db::BackfillState { page_token: None, done: true });
    assert_eq!(s.db().count_messages(A).unwrap(), 3);
    assert_eq!(s.db().count_missing_bodies(A).unwrap(), 3);
    let g2 = s.msg("g2");
    assert_eq!((g2.subject.as_str(), g2.body_text.as_str()), ("meta g2", ""));
    assert_eq!(s.api.count("getMessageMetadata"), 3);
    assert_eq!(s.db().search_messages("meta", None, None).unwrap().len(), 3);

    wait_for_body_fill(&s).await;
    assert_eq!(s.db().count_missing_bodies(A).unwrap(), 0);
    let g1 = s.msg("g1");
    assert_eq!((g1.body_text.as_str(), g1.body_html.as_deref(), g1.seen), ("full body g1", Some("<p>full body g1</p>"), true));
    let order: Vec<Value> = s.api.args_of("getMessage").into_iter().map(|a| a[0].clone()).collect();
    assert_eq!(order, vec![json!("g1"), json!("g2"), json!("g3")]);
    assert_eq!(s.db().search_messages("\"full body\"", None, None).unwrap().len(), 3);
}

#[tokio::test]
async fn backfill_skips_ids_it_already_holds() {
    let s = backfill_setup();
    s.db().upsert_messages(A, &[rec("g2")]).unwrap();
    s.api.script(|sc| sc.list_message_ids = Some(Box::new(|_| Ok(IdPage { ids: strings(&["g1", "g2"]), next_page_token: None }))));
    s.sync.backfill_loop(A).await.unwrap();
    let meta: Vec<Value> = s.api.args_of("getMessageMetadata").into_iter().map(|a| a[0].clone()).collect();
    assert_eq!(meta, vec![json!("g1")]);
}

#[tokio::test]
async fn body_fill_resumes_when_phase_1_is_already_done() {
    let s = backfill_setup();
    s.db().upsert_messages(A, &[missing("g1")]).unwrap();
    s.db().set_backfill_state(A, None, true).unwrap();
    s.sync.start_body_fill(A);
    wait_for_body_fill(&s).await;
    assert_eq!(s.msg("g1").body_text, "full body g1");
    // nothing to do: does not start
    s.sync.start_body_fill(A);
    assert!(!s.sync.body_filling.lock().unwrap().contains(A));
}

#[tokio::test]
async fn body_fill_drops_a_row_whose_message_gmail_no_longer_has() {
    let s = backfill_setup();
    s.db().upsert_messages(A, &[missing("g1"), missing("gone")]).unwrap();
    s.api.script(|sc| {
        sc.get_message = Some(Box::new(|id: String| {
            Ok(if id == "gone" { None } else { Some(ParsedMessage { body_text: format!("full body {id}"), ..rec(&id) }) })
        }))
    });
    s.sync.start_body_fill(A);
    wait_for_body_fill(&s).await;
    assert!(!s.db().has_message(A, "gone").unwrap());
    assert_eq!(s.msg("g1").body_text, "full body g1");
    assert_eq!(s.db().count_missing_bodies(A).unwrap(), 0);
}

fn ensure_setup() -> S {
    let s = backfill_setup();
    s.db().upsert_messages(A, &[missing("g1"), missing("g2"), missing("g3")]).unwrap();
    s
}

#[tokio::test]
async fn ensure_bodies_fetches_only_the_threads_missing_bodies() {
    let s = ensure_setup();
    assert!(s.sync.ensure_bodies(A, "T1").await.unwrap());
    assert_eq!(fetched_ids(&s.api), strings(&["g1", "g2"]));
    let mut bodies: Vec<String> = s.db().query_thread(A, "T1").unwrap().into_iter().map(|m| m.body_text).collect();
    bodies.sort();
    assert_eq!(bodies, strings(&["full body g1", "full body g2"]));
    assert_eq!(s.msg("g3").body_text, "");
    assert_eq!(s.db().count_missing_bodies(A).unwrap(), 1);
    // second open: nothing left to fetch
    s.api.clear();
    assert!(!s.sync.ensure_bodies(A, "T1").await.unwrap());
    assert!(s.api.calls().is_empty());
}

#[tokio::test]
async fn ensure_bodies_shares_one_fetch_between_concurrent_opens() {
    let s = ensure_setup();
    let (a, b) = tokio::join!(s.sync.ensure_bodies(A, "T1"), s.sync.ensure_bodies(A, "T1"));
    assert!(a.unwrap());
    assert!(b.unwrap());
    assert_eq!(s.api.count("getMessage"), 2);
    assert!(s.sync.thread_fetches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ensure_bodies_propagates_a_failure_and_leaves_rows_missing() {
    let s = ensure_setup();
    s.api.script(|sc| sc.get_message = reject(0, "offline"));
    let err = s.sync.ensure_bodies(A, "T1").await.unwrap_err();
    assert_eq!(gmail_status(&err), Some(0));
    assert_eq!(s.db().count_missing_bodies(A).unwrap(), 3);
    assert!(s.sync.thread_fetches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn status_reports_per_account_counts() {
    let s = setup();
    s.seed_local();
    let st = s.sync.status().unwrap();
    assert_eq!(st, vec![SyncStatus { account_id: A.into(), email: "me@example.com".into(), message_count: 3, backfill_done: false }]);
}

#[tokio::test]
async fn an_account_without_credentials_cannot_build_a_client() {
    let s = setup();
    create_account(s.db(), "nocreds", "n@example.com");
    let err = s.sync.api("nocreds").err().unwrap();
    assert!(err.to_string().contains("no stored credentials"));
    // with a stored token, a real client is built (no network until used)
    s.db().save_refresh_token("nocreds", "1//tok").unwrap();
    assert!(s.sync.api("nocreds").is_ok());
}

#[tokio::test]
async fn remove_account_drops_its_mail_and_client() {
    let s = setup();
    s.seed_local();
    s.sync.remove_account(A).unwrap();
    assert!(s.db().list_accounts().unwrap().is_empty());
    assert_eq!(s.db().count_messages(A).unwrap(), 0);
    assert!(s.sync.apis.lock().unwrap().is_empty());
}
