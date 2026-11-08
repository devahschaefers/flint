//! db.test.ts: migrations v1 → v4, sync upserts, local message rows

use super::*;
use crate::db::LocalPatch;
use rusqlite::Connection;

/// The schema as shipped before lifecycle columns existed (commit 8da96e5)
const V1_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail', refresh_token TEXT, history_id TEXT,
  backfill_page_token TEXT, backfill_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gmail_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id_hdr TEXT, in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]', from_name TEXT, from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', reply_to_json TEXT,
  subject TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL, snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '', body_html TEXT, folder TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'people',
  important INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
";

struct V1Row {
    account_id: &'static str,
    gmail_id: &'static str,
    thread_id: &'static str,
    hdr: Option<&'static str>,
    seen: i64,
    answered: i64,
}

fn v1(account_id: &'static str, gmail_id: &'static str, thread_id: &'static str, hdr: Option<&'static str>) -> V1Row {
    V1Row { account_id, gmail_id, thread_id, hdr, seen: 0, answered: 0 }
}

fn build_v1(path: &std::path::Path, accounts: &[&str], rows: &[V1Row]) {
    let raw = Connection::open(path).unwrap();
    let _: String = raw.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).unwrap();
    raw.execute_batch(V1_SCHEMA).unwrap();
    for id in accounts {
        raw.execute(
            "INSERT INTO accounts (id, email, name, color, created_at, history_id) VALUES (?, ?, ?, '#000', 1, 'h1')",
            rusqlite::params![id, format!("{id}@example.com"), id],
        )
        .unwrap();
    }
    for r in rows {
        raw.execute(
            "INSERT INTO messages (account_id, gmail_id, thread_id, message_id_hdr, subject, date, folder, seen, answered, body_text)
             VALUES (?, ?, ?, ?, '', 1000, 'inbox', ?, ?, 'body')",
            rusqlite::params![r.account_id, r.gmail_id, r.thread_id, r.hdr, r.seen, r.answered],
        )
        .unwrap();
    }
}

/// (gmail_id, message_id_hdr, thread_id, seen, answered, state, send_after, send_error, gmail_draft_id, body_text)
type RawMsg = (Option<String>, Option<String>, Option<String>, i64, i64, String, Option<i64>, Option<String>, Option<String>, String);

#[derive(Debug, PartialEq)]
struct Inspected {
    version: i64,
    rows: Vec<RawMsg>,
    tables: Vec<String>,
    indexes: Vec<String>,
}

/// Read the file through a second connection, so assertions see raw columns
fn inspect(path: &std::path::Path) -> Inspected {
    let raw = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let version = raw.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let mut stmt = raw
        .prepare(
            "SELECT gmail_id, message_id_hdr, thread_id, seen, answered, state, send_after, send_error, gmail_draft_id, body_text
             FROM messages ORDER BY id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let names = |ty: &str| -> Vec<String> {
        let mut s = raw
            .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        s.query_map([ty], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<String>>>().unwrap()
    };
    Inspected { version, rows, tables: names("table"), indexes: names("index") }
}

#[test]
fn v1_rebuild_keeps_rows_and_dedupes_message_id_headers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    build_v1(
        &path,
        &["a", "b"],
        &[
            V1Row { seen: 1, ..v1("a", "g1", "t1", Some("<dup@x>")) },
            v1("a", "g2", "t1", Some("<dup@x>")),
            v1("a", "g3", "t2", Some("<solo@x>")),
            V1Row { answered: 1, ..v1("a", "g4", "t3", None) },
            // The same header in another account is not a duplicate
            v1("b", "g5", "t9", Some("<dup@x>")),
        ],
    );
    let store = open_at(&path, ManualClock::new(T0));
    let db = &store.db;
    let i = inspect(&path);
    assert_eq!(i.version, 4);
    let gid = |r: &RawMsg| r.0.clone().unwrap();
    assert_eq!(i.rows.iter().map(gid).collect::<Vec<_>>(), strings(&["g1", "g2", "g3", "g4", "g5"]));
    let hdrs: Vec<Option<&str>> = i.rows.iter().map(|r| r.1.as_deref()).collect();
    assert_eq!(hdrs, vec![Some("<dup@x>"), None, Some("<solo@x>"), None, Some("<dup@x>")]);
    assert_eq!(i.rows[0].3, 1); // seen survives
    assert_eq!(i.rows[3].4, 1); // answered survives
    assert_eq!(i.rows[0].2.as_deref(), Some("t1"));
    assert!(i.rows.iter().all(|r| r.9 == "body"));
    assert!(i.rows.iter().all(|r| r.5 == "synced" && r.6.is_none() && r.7.is_none() && r.8.is_none()));
    assert!(!i.tables.contains(&"messages_v1".to_string()));
    for t in ["messages", "ops", "accounts", "config"] {
        assert!(i.tables.contains(&t.to_string()), "{t}");
    }
    assert!(!i.indexes.contains(&"idx_v1_hdr".to_string()));
    for x in ["idx_messages_list", "idx_messages_date", "idx_messages_thread", "idx_messages_thread_key"] {
        assert!(i.indexes.contains(&x.to_string()), "{x}");
    }
    assert_eq!(db.list_accounts().unwrap().iter().map(|a| a.id.clone()).collect::<Vec<_>>(), strings(&["a", "b"]));
    assert_eq!(db.get_history_id("a").unwrap().as_deref(), Some("h1"));
    let mut ids = db.list_gmail_ids("a").unwrap();
    ids.sort();
    assert_eq!(ids, strings(&["g1", "g2", "g3", "g4"]));
    // v3 on top: the full-text index covers the copied rows
    assert_eq!(db.count_indexed().unwrap(), 5);
    assert_eq!(db.search_messages("body", None, None).unwrap().len(), 5);
}

#[test]
fn accepts_a_v1_database_with_no_messages() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    build_v1(&path, &["a"], &[]);
    let store = open_at(&path, ManualClock::new(T0));
    let i = inspect(&path);
    assert_eq!(i.version, 4);
    assert!(i.rows.is_empty());
    assert_eq!(store.db.list_accounts().unwrap().len(), 1);
}

#[test]
fn reopening_a_migrated_database_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    build_v1(&path, &["a"], &[v1("a", "g1", "t1", Some("<m1@x>"))]);
    let store = open_at(&path, ManualClock::new(T0));
    let first = inspect(&path);
    drop(store);
    let _store = open_at(&path, ManualClock::new(T0));
    let second = inspect(&path);
    assert_eq!(second, first);
    assert_eq!(second.version, 4);
}

#[test]
fn fresh_database_goes_straight_to_current_version() {
    let t = fresh();
    let i = inspect(&t.path());
    assert_eq!(i.version, 4);
    assert!(i.rows.is_empty());
    let db = t.db();
    create_account(db, "a", "me@example.com");
    let li = LocalMessageInput { account_id: "a".into(), subject: "s".into(), text: "t".into(), ..Default::default() };
    db.put_local_message(&li, "<local@x>", &mbox(Some("Me"), "me@example.com"), MessageState::Draft, Folder::Drafts, None)
        .unwrap();
    assert_eq!(db.get_local_message("a", "<local@x>").unwrap().unwrap().gmail_id, None);
    // WAL and the journal size limit are set
    let raw = Connection::open(t.path()).unwrap();
    let mode: String = raw.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
}

// ---------- upsertMessages ----------

fn local_input() -> LocalMessageInput {
    LocalMessageInput {
        account_id: "a".into(),
        message_id_hdr: Some("<H@flint.local>".into()),
        to: vec![mbox(None, "you@example.com")],
        subject: "hello".into(),
        text: "body text".into(),
        ..Default::default()
    }
}

fn me() -> Mailbox {
    mbox(Some("Me"), "me@example.com")
}

const H: &str = "<H@flint.local>";

fn with_account() -> TestDb {
    let t = fresh();
    create_account(t.db(), "a", "me@example.com");
    t
}

#[test]
fn adopts_a_local_row_by_message_id_instead_of_twinning() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&local_input(), H, &me(), MessageState::Queued, Folder::Sent, None).unwrap();
    assert_eq!(db.get_local_message("a", H).unwrap().unwrap().gmail_id, None);
    db.upsert_messages(
        "a",
        &[ParsedMessage {
            thread_id: "T".into(),
            message_id_hdr: Some(H.into()),
            folder: Folder::Sent,
            seen: true,
            ..rec("G")
        }],
    )
    .unwrap();
    let local = db.get_local_message("a", H).unwrap().unwrap();
    assert_eq!(local.gmail_id.as_deref(), Some("G"));
    assert_eq!(local.thread_id.as_deref(), Some("T"));
    assert_eq!(db.count_messages("a").unwrap(), 1);
    assert_eq!(db.list_gmail_ids("a").unwrap(), strings(&["G"]));
    // the local body is kept; only ids/labels/snippet/date come from Gmail
    assert_eq!(local.body_text, "body text");
    // Gmail holding a non-draft copy means it went out
    assert_eq!(local.state, MessageState::Synced);
}

#[test]
fn keeps_a_queued_row_queued_when_gmail_only_holds_a_draft() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&local_input(), H, &me(), MessageState::Queued, Folder::Sent, None).unwrap();
    db.upsert_messages("a", &[ParsedMessage { message_id_hdr: Some(H.into()), folder: Folder::Drafts, ..rec("GD") }])
        .unwrap();
    let local = db.get_local_message("a", H).unwrap().unwrap();
    assert_eq!(local.gmail_id.as_deref(), Some("GD"));
    assert_eq!(local.state, MessageState::Queued);
}

#[test]
fn moves_a_sent_row_to_synced_when_its_copy_comes_back() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&local_input(), H, &me(), MessageState::Queued, Folder::Sent, None).unwrap();
    db.set_local_state(
        "a",
        H,
        &LocalPatch {
            state: Some(MessageState::Sent),
            gmail_id: Some(Some("G".into())),
            send_error: Some(Some("old error".into())),
            ..Default::default()
        },
    )
    .unwrap();
    db.upsert_messages("a", &[ParsedMessage { message_id_hdr: Some(H.into()), folder: Folder::Sent, ..rec("G") }])
        .unwrap();
    let w = wire(db, "a", H).unwrap();
    assert_eq!(w.state, MessageState::Synced);
    assert_eq!(w.folder, Folder::Sent);
    assert_eq!(db.count_messages("a").unwrap(), 1);
}

#[test]
fn refreshes_label_state_on_a_known_gmail_id() {
    let t = with_account();
    let db = t.db();
    db.upsert_messages("a", &[rec("G")]).unwrap();
    db.upsert_messages("a", &[ParsedMessage { folder: Folder::Archive, seen: true, flagged: true, ..rec("G") }]).unwrap();
    assert_eq!(db.count_messages("a").unwrap(), 1);
    let w = db.get_message_wire("a", "G").unwrap().unwrap();
    assert_eq!((w.folder, w.seen, w.flagged), (Folder::Archive, true, true));
}

#[test]
fn stores_a_header_colliding_message_without_its_header() {
    let t = with_account();
    let db = t.db();
    db.upsert_messages("a", &[ParsedMessage { message_id_hdr: None, ..rec("GA") }]).unwrap();
    db.put_local_message(&local_input(), H, &me(), MessageState::Draft, Folder::Drafts, None).unwrap();
    db.set_local_state("a", H, &LocalPatch { gmail_id: Some(Some("GB".into())), ..Default::default() }).unwrap();
    // Gmail now claims GA carries header H: adopting would put GA on two rows
    db.upsert_messages("a", &[ParsedMessage { message_id_hdr: Some(H.into()), seen: true, ..rec("GA") }]).unwrap();
    assert_eq!(db.count_messages("a").unwrap(), 2);
    assert_eq!(db.get_local_message("a", H).unwrap().unwrap().gmail_id.as_deref(), Some("GB"));
    assert!(db.get_message_wire("a", "GA").unwrap().unwrap().seen);
}

#[test]
fn keeps_the_same_header_in_two_accounts_as_two_rows() {
    let t = with_account();
    let db = t.db();
    create_account(db, "b", "other@example.com");
    db.upsert_messages("a", &[ParsedMessage { message_id_hdr: Some("<same@x>".into()), ..rec("G1") }]).unwrap();
    db.upsert_messages("b", &[ParsedMessage { message_id_hdr: Some("<same@x>".into()), ..rec("G2") }]).unwrap();
    assert_eq!(db.count_messages("a").unwrap(), 1);
    assert_eq!(db.count_messages("b").unwrap(), 1);
}

#[test]
fn mailbox_json_matches_json_stringify() {
    let t = with_account();
    let db = t.db();
    db.upsert_messages(
        "a",
        &[ParsedMessage {
            to: vec![mbox(Some("Ann \"A\""), "ann@x.com"), mbox(None, "bob@x.com")],
            references: strings(&["<r1@x>"]),
            reply_to: Some(mbox(None, "r@x.com")),
            ..rec("J")
        }],
    )
    .unwrap();
    let raw = Connection::open(t.path()).unwrap();
    let (to, refs, rt): (String, String, String) = raw
        .query_row("SELECT to_json, refs, reply_to_json FROM messages WHERE gmail_id = 'J'", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(to, r#"[{"name":"Ann \"A\"","address":"ann@x.com"},{"address":"bob@x.com"}]"#);
    assert_eq!(refs, r#"["<r1@x>"]"#);
    assert_eq!(rt, r#"{"address":"r@x.com"}"#);
}

// ---------- local message rows ----------

fn reply_input() -> LocalMessageInput {
    LocalMessageInput {
        account_id: "a".into(),
        message_id_hdr: Some("<L@flint.local>".into()),
        to: vec![mbox(None, "you@example.com")],
        cc: vec![mbox(None, "cc@example.com")],
        subject: "first".into(),
        text: "first body".into(),
        references: strings(&["<p@x>"]),
        in_reply_to: Some("<p@x>".into()),
        thread_id: Some("T1".into()),
        ..Default::default()
    }
}

const L: &str = "<L@flint.local>";

#[test]
fn put_local_message_inserts_a_seen_unflagged_row() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&reply_input(), L, &me(), MessageState::Queued, Folder::Sent, Some(12345)).unwrap();
    let local = db.get_local_message("a", L).unwrap().unwrap();
    assert_eq!(local.account_id, "a");
    assert_eq!(local.message_id_hdr, L);
    assert_eq!((local.gmail_id.clone(), local.gmail_draft_id.clone()), (None, None));
    assert_eq!(local.thread_id.as_deref(), Some("T1"));
    assert_eq!(local.in_reply_to.as_deref(), Some("<p@x>"));
    assert_eq!(local.references, strings(&["<p@x>"]));
    assert_eq!(local.to, vec![mbox(None, "you@example.com")]);
    assert_eq!(local.cc, vec![mbox(None, "cc@example.com")]);
    assert_eq!((local.subject.as_str(), local.body_text.as_str(), local.body_html.clone()), ("first", "first body", None));
    assert_eq!((local.state, local.send_after), (MessageState::Queued, Some(12345)));
    let w = wire(db, "a", L).unwrap();
    assert_eq!(w.folder, Folder::Sent);
    assert!(w.seen && !w.flagged);
    assert_eq!(w.from, me());
    assert_eq!(w.snippet, "first body");
    assert_eq!(w.send_after_ms, Some(12345));
    assert_eq!(w.send_error, None);
    assert_eq!(w.date_ms, T0);
}

#[test]
fn put_local_message_on_an_existing_header_keeps_gmail_ids_and_thread() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&reply_input(), L, &me(), MessageState::Draft, Folder::Drafts, None).unwrap();
    db.set_local_state(
        "a",
        L,
        &LocalPatch {
            gmail_id: Some(Some("G".into())),
            gmail_draft_id: Some(Some("D".into())),
            send_error: Some(Some("boom".into())),
            ..Default::default()
        },
    )
    .unwrap();
    let second = LocalMessageInput {
        subject: "second".into(),
        text: "second body".into(),
        html: Some("<p>hi</p>".into()),
        thread_id: Some("T2".into()),
        ..reply_input()
    };
    db.put_local_message(&second, L, &me(), MessageState::Queued, Folder::Sent, Some(99)).unwrap();
    let local = db.get_local_message("a", L).unwrap().unwrap();
    assert_eq!(local.subject, "second");
    assert_eq!(local.body_text, "second body");
    assert_eq!(local.body_html.as_deref(), Some("<p>hi</p>"));
    assert_eq!(local.gmail_id.as_deref(), Some("G"));
    assert_eq!(local.gmail_draft_id.as_deref(), Some("D"));
    assert_eq!(local.thread_id.as_deref(), Some("T1"));
    assert_eq!((local.state, local.send_after), (MessageState::Queued, Some(99)));
    assert_eq!(wire(db, "a", L).unwrap().send_error, None);
    assert_eq!(db.count_messages("a").unwrap(), 1);
}

#[test]
fn set_local_state_patches_only_the_given_fields() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&reply_input(), L, &me(), MessageState::Queued, Folder::Sent, Some(5)).unwrap();
    db.set_local_state(
        "a",
        L,
        &LocalPatch { state: Some(MessageState::Failed), send_error: Some(Some("nope".into())), ..Default::default() },
    )
    .unwrap();
    let local = db.get_local_message("a", L).unwrap().unwrap();
    assert_eq!((local.state, local.send_after), (MessageState::Failed, Some(5)));
    assert_eq!(wire(db, "a", L).unwrap().send_error.as_deref(), Some("nope"));

    db.set_local_state(
        "a",
        L,
        &LocalPatch {
            state: Some(MessageState::Sent),
            gmail_id: Some(Some("G".into())),
            thread_id: Some(Some("T9".into())),
            send_after: Some(None),
            send_error: Some(None),
            ..Default::default()
        },
    )
    .unwrap();
    let local = db.get_local_message("a", L).unwrap().unwrap();
    assert_eq!(local.state, MessageState::Sent);
    assert_eq!(local.gmail_id.as_deref(), Some("G"));
    assert_eq!(local.thread_id.as_deref(), Some("T9"));
    assert_eq!(local.send_after, None);
    assert_eq!(wire(db, "a", L).unwrap().send_error, None);

    db.set_local_state("a", L, &LocalPatch::default()).unwrap();
    assert_eq!(db.get_local_message("a", L).unwrap().unwrap().state, MessageState::Sent);
}

#[test]
fn has_own_reply_ignores_the_excluded_row_and_address_case() {
    let t = with_account();
    let db = t.db();
    db.put_local_message(&reply_input(), L, &me(), MessageState::Queued, Folder::Sent, None).unwrap();
    assert!(!db.has_own_reply("a", "<p@x>", "me@example.com", L).unwrap());
    db.put_local_message(&reply_input(), "<L2@flint.local>", &me(), MessageState::Draft, Folder::Drafts, None).unwrap();
    assert!(db.has_own_reply("a", "<p@x>", "ME@Example.com", L).unwrap());
    db.delete_local_message("a", "<L2@flint.local>").unwrap();
    db.upsert_messages(
        "a",
        &[ParsedMessage { in_reply_to: Some("<p@x>".into()), from_addr: "them@example.com".into(), ..rec("G") }],
    )
    .unwrap();
    assert!(!db.has_own_reply("a", "<p@x>", "me@example.com", L).unwrap());
}

#[test]
fn set_answered_flips_the_parent_flag() {
    let t = with_account();
    let db = t.db();
    db.upsert_messages("a", &[ParsedMessage { message_id_hdr: Some("<p@x>".into()), ..rec("P") }]).unwrap();
    db.set_answered("a", "<p@x>", true).unwrap();
    assert!(db.get_message_wire("a", "P").unwrap().unwrap().answered);
    db.set_answered("a", "<p@x>", false).unwrap();
    assert!(!db.get_message_wire("a", "P").unwrap().unwrap().answered);
}

#[test]
fn settings_and_config() {
    let t = with_account();
    let db = t.db();
    db.set_setting("theme", "dark").unwrap();
    db.set_setting("theme", "light").unwrap();
    db.set_config("google_client_id", "x").unwrap();
    let s = t.store.settings().unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s["theme"], "light");
    assert_eq!(db.get_config("google_client_id").unwrap().as_deref(), Some("x"));
    assert_eq!(db.get_config("missing").unwrap(), None);
}

#[test]
fn refresh_tokens_are_sealed_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open_with(
        &dir.path().join("mail.db"),
        ManualClock::new(T0),
        Arc::new(crate::secrets::FixedKeySecrets::new(b"test-key")),
    )
    .unwrap();
    let db = &store.db;
    create_account(db, "a", "me@example.com");
    assert_eq!(db.get_refresh_token("a").unwrap(), None);
    db.save_refresh_token("a", "1//tok").unwrap();
    let raw = Connection::open(dir.path().join("mail.db")).unwrap();
    let stored: String = raw.query_row("SELECT refresh_token FROM accounts WHERE id = 'a'", [], |r| r.get(0)).unwrap();
    assert!(stored.starts_with("enc:"));
    assert_eq!(db.get_refresh_token("a").unwrap().as_deref(), Some("1//tok"));
    // A row written without encryption reads back too
    raw.execute("UPDATE accounts SET refresh_token = 'plain:abc' WHERE id = 'a'", []).unwrap();
    assert_eq!(db.get_refresh_token("a").unwrap().as_deref(), Some("abc"));
}

#[test]
fn deleting_an_account_cascades_to_messages_and_ops() {
    let t = with_account();
    let db = t.db();
    db.upsert_messages("a", &[rec("g1")]).unwrap();
    db.enqueue_op("a", OpKind::Action, &json!({"gmailIds": ["g1"], "action": "archive", "value": null}), None).unwrap();
    db.delete_account("a").unwrap();
    assert_eq!(db.count_messages("a").unwrap(), 0);
    assert!(db.list_ops().unwrap().is_empty());
    assert_eq!(db.count_indexed().unwrap(), 0);
}
