//! storage.test.ts: full-text search through the store, the v2 → v3
//! migration, and the compactor (codec/builder/html unit tests live next to
//! their modules)

use super::*;
use crate::db::SearchHit;
use crate::storage::compactor::{Compactor, CompactorOptions};
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::time::Duration;

/// The schema as shipped at v2 (commit e19a70d): TEXT bodies, no codec/state, no FTS
const V2_SCHEMA: &str = "
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, color TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail', refresh_token TEXT, history_id TEXT,
  backfill_page_token TEXT, backfill_done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gmail_id TEXT, gmail_draft_id TEXT, thread_id TEXT, message_id_hdr TEXT, in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]', from_name TEXT, from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', reply_to_json TEXT,
  subject TEXT NOT NULL DEFAULT '', date INTEGER NOT NULL, snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '', body_html TEXT, folder TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT 'people',
  important INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'synced',
  send_after INTEGER, send_error TEXT,
  UNIQUE(account_id, gmail_id), UNIQUE(account_id, message_id_hdr)
);
CREATE INDEX idx_messages_list ON messages(account_id, folder, date DESC);
CREATE INDEX idx_messages_date ON messages(account_id, date DESC);
CREATE INDEX idx_messages_thread ON messages(account_id, thread_id);
CREATE TABLE ops (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ops_due ON ops(state, next_attempt_at);
PRAGMA user_version = 2;
";

struct V2Row {
    gmail_id: String,
    body_text: String,
    body_html: Option<String>,
}

fn v2(gmail_id: &str, body_text: &str, body_html: Option<&str>) -> V2Row {
    V2Row { gmail_id: gmail_id.into(), body_text: body_text.into(), body_html: body_html.map(str::to_string) }
}

fn build_v2(path: &std::path::Path, rows: &[V2Row]) {
    let mut raw = Connection::open(path).unwrap();
    let _: String = raw.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).unwrap();
    raw.execute_batch(V2_SCHEMA).unwrap();
    raw.execute(
        "INSERT INTO accounts (id, email, name, color, created_at, backfill_done) VALUES ('a', 'a@example.com', 'A', '#000', 1, 1)",
        [],
    )
    .unwrap();
    let tx = raw.transaction().unwrap();
    for r in rows {
        tx.execute(
            "INSERT INTO messages (account_id, gmail_id, thread_id, message_id_hdr, subject, date, folder, body_text, body_html)
             VALUES ('a', ?1, 't-' || ?1, '<' || ?1 || '@x>', 'Subject ' || ?1, 1000, 'inbox', ?2, ?3)",
            rusqlite::params![r.gmail_id, r.body_text, r.body_html],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

#[derive(Debug, Clone, PartialEq)]
struct RawRow {
    gmail_id: String,
    text_is_blob: bool,
    html_is_blob: Option<bool>,
    text_bytes: Vec<u8>,
    codec: String,
    state: String,
}

fn raw_rows(path: &std::path::Path) -> Vec<RawRow> {
    let raw = Connection::open(path).unwrap();
    let mut stmt =
        raw.prepare("SELECT gmail_id, body_text, body_html, body_codec, body_state FROM messages ORDER BY id").unwrap();
    stmt.query_map([], |r| {
        let (tb, tbytes) = match r.get_ref(1)? {
            ValueRef::Blob(b) => (true, b.to_vec()),
            ValueRef::Text(t) => (false, t.to_vec()),
            _ => (false, vec![]),
        };
        let hb = match r.get_ref(2)? {
            ValueRef::Blob(_) => Some(true),
            ValueRef::Text(_) => Some(false),
            _ => None,
        };
        Ok(RawRow { gmail_id: r.get(0)?, text_is_blob: tb, html_is_blob: hb, text_bytes: tbytes, codec: r.get(3)?, state: r.get(4)? })
    })
    .unwrap()
    .collect::<rusqlite::Result<Vec<_>>>()
    .unwrap()
}

fn pragma(path: &std::path::Path, name: &str) -> i64 {
    let raw = Connection::open(path).unwrap();
    raw.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0)).unwrap()
}

// ---------- FTS through the store ----------

fn search_fixture() -> TestDb {
    let t = fresh();
    let db = t.db();
    create_account(db, "a", "a@example.com");
    create_account(db, "b", "b@example.com");
    db.upsert_messages(
        "a",
        &[
            ParsedMessage {
                subject: "Quarterly budget review".into(),
                body_text: "Please find the numbers attached.".into(),
                ..rec("g1")
            },
            ParsedMessage {
                subject: "Lunch?".into(),
                body_text: "The budget for lunch is unlimited. Budget budget budget.".into(),
                ..rec("g2")
            },
        ],
    )
    .unwrap();
    db.upsert_messages(
        "b",
        &[ParsedMessage { subject: "Budget".into(), body_text: "Other account, café résumé".into(), ..rec("g3") }],
    )
    .unwrap();
    t
}

fn ids(db: &Db, hits: &[SearchHit]) -> Vec<String> {
    hits.iter()
        .map(|h| {
            db.query_thread(&h.account_id, h.thread_id.as_deref().unwrap_or(""))
                .unwrap()
                .first()
                .and_then(|m| m.gmail_id.clone())
                .unwrap_or_else(|| "?".into())
        })
        .collect()
}

#[test]
fn finds_by_subject_and_body_with_a_subject_boost() {
    let t = search_fixture();
    let db = t.db();
    let hits = db.search_messages("budget", None, None).unwrap();
    assert_eq!(hits.len(), 3);
    assert_eq!(ids(db, &hits).iter().position(|g| g == "g2"), Some(2));
    assert!(hits[0].rank <= hits[1].rank && hits[1].rank <= hits[2].rank);
}

#[test]
fn filters_by_account_and_honours_the_limit() {
    let t = search_fixture();
    let db = t.db();
    assert_eq!(ids(db, &db.search_messages("budget", Some("b"), None).unwrap()), strings(&["g3"]));
    assert_eq!(db.search_messages("budget", None, Some(1)).unwrap().len(), 1);
}

#[test]
fn prefix_phrase_and_diacritic_insensitive_matches() {
    let t = search_fixture();
    let db = t.db();
    assert_eq!(ids(db, &db.search_messages("quart*", None, None).unwrap()), strings(&["g1"]));
    assert_eq!(ids(db, &db.search_messages("\"numbers attached\"", None, None).unwrap()), strings(&["g1"]));
    assert!(db.search_messages("\"attached numbers\"", None, None).unwrap().is_empty());
    assert_eq!(ids(db, &db.search_messages("cafe resume", None, None).unwrap()), strings(&["g3"]));
}

#[test]
fn never_fails_on_hostile_input() {
    let t = search_fixture();
    let db = t.db();
    let long = "x".repeat(5000);
    for raw in [
        "\"", "a\"b\"c\"", "(((", ")))", "NOT", "AND OR", "a NEAR(b c, 5)", "{col}:x", "\" \"", "\\",
        "'; DROP TABLE messages; --", "*", "a *", "\"a\" * \"b\"", long.as_str(),
    ] {
        db.search_messages(raw, None, None).unwrap();
        t.store.search_threads(raw, None, 50).unwrap();
    }
    assert!(db.search_messages("", None, None).unwrap().is_empty());
    assert_eq!(db.count_messages("a").unwrap(), 2);
}

#[test]
fn drops_deleted_messages_from_the_index() {
    let t = search_fixture();
    let db = t.db();
    db.delete_message("a", "g1").unwrap();
    assert!(db.search_messages("quarterly", None, None).unwrap().is_empty());
    assert_eq!(db.count_indexed().unwrap(), 2);
}

#[test]
fn label_only_refresh_does_not_reindex_or_duplicate() {
    let t = search_fixture();
    let db = t.db();
    db.upsert_messages(
        "a",
        &[ParsedMessage { subject: "ignored".into(), body_text: "ignored too".into(), seen: true, ..rec("g1") }],
    )
    .unwrap();
    assert_eq!(db.count_indexed().unwrap(), 3);
    assert_eq!(ids(db, &db.search_messages("quarterly", None, None).unwrap()), strings(&["g1"]));
    assert!(db.search_messages("ignored", None, None).unwrap().is_empty());
}

#[test]
fn indexes_local_drafts_and_follows_their_edits() {
    let t = search_fixture();
    let db = t.db();
    let me = mbox(Some("Me"), "a@example.com");
    let draft = LocalMessageInput {
        account_id: "a".into(),
        subject: "Draft about kittens".into(),
        text: "first version".into(),
        thread_id: Some("td".into()),
        ..Default::default()
    };
    let hdr = "<d@flint.local>";
    db.put_local_message(&draft, hdr, &me, MessageState::Draft, Folder::Drafts, None).unwrap();
    assert_eq!(db.search_messages("kittens", None, None).unwrap().len(), 1);
    assert_eq!(db.search_messages("first", None, None).unwrap().len(), 1);
    let edited = LocalMessageInput { text: "second version".into(), ..draft };
    db.put_local_message(&edited, hdr, &me, MessageState::Draft, Folder::Drafts, None).unwrap();
    assert!(db.search_messages("first", None, None).unwrap().is_empty());
    assert_eq!(db.search_messages("second", None, None).unwrap().len(), 1);
    assert_eq!(db.count_indexed().unwrap(), 4);
    db.delete_local_message("a", hdr).unwrap();
    assert!(db.search_messages("kittens", None, None).unwrap().is_empty());
    assert_eq!(db.count_indexed().unwrap(), 3);
}

#[test]
fn metadata_only_row_is_indexed_by_subject_then_by_body() {
    let t = search_fixture();
    let db = t.db();
    db.upsert_messages(
        "a",
        &[ParsedMessage {
            subject: "Pending bodies".into(),
            body_text: "must be ignored".into(),
            body_state: BodyState::Missing,
            ..rec("g9")
        }],
    )
    .unwrap();
    assert_eq!(db.count_missing_bodies("a").unwrap(), 1);
    assert_eq!(db.get_message_wire("a", "g9").unwrap().unwrap().body_text, "");
    assert_eq!(db.search_messages("pending", None, None).unwrap().len(), 1);
    assert!(db.search_messages("ignored", None, None).unwrap().is_empty());

    db.upsert_messages("a", &[ParsedMessage { subject: "Pending bodies".into(), body_text: "now arrived".into(), ..rec("g9") }])
        .unwrap();
    assert_eq!(db.count_missing_bodies("a").unwrap(), 0);
    assert_eq!(db.get_message_wire("a", "g9").unwrap().unwrap().body_text, "now arrived");
    assert_eq!(db.search_messages("arrived", None, None).unwrap().len(), 1);
    // a second metadata-only upsert does not blank the body again
    db.upsert_messages(
        "a",
        &[ParsedMessage { body_text: String::new(), body_state: BodyState::Missing, seen: true, ..rec("g9") }],
    )
    .unwrap();
    let w = db.get_message_wire("a", "g9").unwrap().unwrap();
    assert_eq!((w.body_text.as_str(), w.seen), ("now arrived", true));
}

#[test]
fn removes_an_accounts_rows_from_the_index() {
    let t = search_fixture();
    let db = t.db();
    db.delete_account("a").unwrap();
    assert_eq!(db.count_indexed().unwrap(), 1);
    assert_eq!(ids(db, &db.search_messages("budget", None, None).unwrap()), strings(&["g3"]));
}

#[test]
fn lists_missing_bodies_newest_first_per_account_and_thread() {
    let t = search_fixture();
    let db = t.db();
    let m = |id: &str, th: &str, d: i64| ParsedMessage {
        thread_id: th.into(),
        date_ms: d,
        body_state: BodyState::Missing,
        ..rec(id)
    };
    db.upsert_messages("a", &[m("m1", "T", 1000), m("m2", "T", 3000), m("m3", "U", 2000)]).unwrap();
    db.upsert_messages("b", &[m("m4", "T", 4000)]).unwrap();
    assert_eq!(db.list_missing_body_ids("a", 10).unwrap(), strings(&["m2", "m3", "m1"]));
    assert_eq!(db.list_missing_body_ids("a", 2).unwrap(), strings(&["m2", "m3"]));
    let mut in_thread = db.list_missing_body_ids_in_thread("a", "T").unwrap();
    in_thread.sort();
    assert_eq!(in_thread, strings(&["m1", "m2"]));
    assert_eq!(db.count_missing_bodies("b").unwrap(), 1);
}

// ---------- migration v2 → v3 ----------

#[test]
fn v2_to_v3_adds_columns_builds_the_index_and_vacuums() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    let mut rows: Vec<V2Row> = (0..300).map(|i| v2(&format!("g{i}"), &format!("filler {i} ").repeat(500), None)).collect();
    rows.push(v2("html-only", "", Some("<p>Hidden in <b>HTML</b></p>")));
    build_v2(&path, &rows);
    {
        let raw = Connection::open(&path).unwrap();
        raw.execute(
            "DELETE FROM messages WHERE gmail_id LIKE 'g%' AND CAST(substr(gmail_id, 2) AS INTEGER) >= 20",
            [],
        )
        .unwrap();
        raw.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    }
    assert!(pragma(&path, "freelist_count") > 0);

    let store = open_at(&path, ManualClock::new(T0));
    let db = &store.db;
    assert_eq!(pragma(&path, "user_version"), 4);
    assert_eq!(pragma(&path, "freelist_count"), 0);
    let after = raw_rows(&path);
    assert_eq!(after.len(), 21);
    assert!(after.iter().all(|r| r.codec == "none" && r.state == "full" && !r.text_is_blob));
    assert_eq!(db.count_indexed().unwrap(), 21);
    assert_eq!(db.search_messages("filler", None, None).unwrap().len(), 20);
    assert_eq!(db.search_messages("\"filler 7\"", None, None).unwrap().len(), 1);
    assert!(db.get_message_wire("a", "g7").unwrap().unwrap().body_text.starts_with("filler 7 "));
    assert_eq!(
        db.get_message_wire("a", "html-only").unwrap().unwrap().body_html.as_deref(),
        Some("<p>Hidden in <b>HTML</b></p>")
    );
    // HTML-only mail is not body-searchable until the compactor derives its text
    assert!(db.search_messages("hidden", None, None).unwrap().is_empty());
    assert_eq!(db.count_uncompacted().unwrap(), 21);
}

#[test]
fn v3_is_idempotent_and_a_fresh_store_has_nothing_to_compact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    build_v2(&path, &[v2("g1", "plain body of g1", None)]);
    let store = open_at(&path, ManualClock::new(T0));
    let first = raw_rows(&path);
    drop(store);
    let store = open_at(&path, ManualClock::new(T0));
    assert_eq!(raw_rows(&path), first);
    assert_eq!(store.db.count_indexed().unwrap(), 1);
    assert_eq!(fresh().db().count_uncompacted().unwrap(), 0);
}

#[test]
fn new_rows_are_written_compressed() {
    let t = fresh();
    let db = t.db();
    create_account(db, "a", "me@example.com");
    db.upsert_messages("a", &[ParsedMessage { body_text: "fresh".into(), body_html: Some("<p>fresh</p>".into()), ..rec("n1") }])
        .unwrap();
    let row = &raw_rows(&t.path())[0];
    assert_eq!(row.codec, "zstd");
    assert!(row.text_is_blob);
    assert_eq!(row.html_is_blob, Some(true));
    let w = db.get_message_wire("a", "n1").unwrap().unwrap();
    assert_eq!((w.body_text.as_str(), w.body_html.as_deref()), ("fresh", Some("<p>fresh</p>")));
    assert_eq!(db.count_uncompacted().unwrap(), 0);
}

#[test]
fn refuses_an_sqlite_older_than_3_43() {
    use crate::db::assert_sqlite_version as check;
    let e = check("3.42.0").unwrap_err();
    assert!(e.to_string().contains("3.43.0 or newer"));
    assert!(check("3.9.9").is_err());
    assert!(check("3.43.0").is_ok());
    assert!(check("3.53.4").is_ok());
    assert!(check("4.0.0").is_ok());
}

#[test]
fn never_lowers_a_newer_user_version() {
    let mut t = fresh();
    Connection::open(t.path()).unwrap().execute_batch("PRAGMA user_version = 99").unwrap();
    t.reopen();
    assert_eq!(pragma(&t.path(), "user_version"), 99);
}

// ---------- compactor ----------

fn migrated(count: usize) -> (TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    let mut rows: Vec<V2Row> = (0..count)
        .map(|i| {
            let html = (i % 2 == 0).then(|| format!("<p>html {i}</p>").repeat(50));
            v2(&format!("g{i}"), &format!("text {i} ").repeat(50), html.as_deref())
        })
        .collect();
    rows.push(v2("html-only", "", Some("<p>Hidden in <b>HTML</b></p>")));
    rows.push(v2("stub", "View online", Some("<h1>Real content of the mail</h1>")));
    build_v2(&path, &rows);
    let store = open_at(&path, ManualClock::new(T0));
    (dir, store)
}

type Lines = Arc<Mutex<Vec<String>>>;

fn compactor(db: &Arc<Db>, batch: usize, lines: &Lines) -> Compactor {
    let l = lines.clone();
    Compactor::new(CompactorOptions {
        batch_size: batch,
        log: Arc::new(move |s| l.lock().unwrap().push(s.to_string())),
        ..CompactorOptions::for_db(db.clone())
    })
}

#[test]
fn compacts_in_batches_keeps_reads_identical_and_is_idempotent() {
    let (dir, store) = migrated(10);
    let path = dir.path().join("mail.db");
    let db = &store.db;
    let snapshot = |db: &Db| -> Vec<(Option<String>, String, Option<String>)> {
        let mut v: Vec<_> =
            db.query_window(100).unwrap().into_iter().map(|m| (m.gmail_id, m.body_text, m.body_html)).collect();
        v.sort();
        v
    };
    let before = snapshot(db);
    let lines: Lines = Arc::default();
    let job = compactor(db, 3, &lines);

    let first = job.run_once().unwrap();
    assert_eq!((first.processed, first.remaining), (3, 9));
    assert_eq!(raw_rows(&path).iter().filter(|r| r.codec == "zstd").count(), 3);

    assert_eq!(job.run_to_completion().unwrap(), 9);
    let rows = raw_rows(&path);
    assert!(rows.iter().all(|r| r.codec == "zstd" && r.text_is_blob));
    assert!(rows.iter().all(|r| r.html_is_blob != Some(false)));
    assert_eq!(db.count_uncompacted().unwrap(), 0);
    let s = job.status();
    assert_eq!((s.processed, s.remaining, s.text_derived, s.error.clone()), (12, 0, 2, None));
    assert!(s.bytes_after < s.bytes_before);

    let derived = ["html-only", "stub"];
    let keep = |v: Vec<(Option<String>, String, Option<String>)>| -> Vec<_> {
        v.into_iter().filter(|r| !derived.contains(&r.0.as_deref().unwrap_or(""))).collect()
    };
    assert_eq!(keep(snapshot(db)), keep(before));
    assert_eq!(db.get_message_wire("a", "html-only").unwrap().unwrap().body_text, "Hidden in HTML");
    assert_eq!(db.get_message_wire("a", "stub").unwrap().unwrap().body_text, "Real content of the mail");
    assert_eq!(db.search_messages("hidden", None, None).unwrap().len(), 1);
    assert_eq!(db.search_messages("\"real content\"", None, None).unwrap().len(), 1);
    assert_eq!(db.search_messages("\"text 3\"", None, None).unwrap().len(), 1);
    assert_eq!(db.count_indexed().unwrap(), 12);

    assert_eq!(job.run_to_completion().unwrap(), 0);
    assert_eq!(raw_rows(&path), rows);
}

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..500 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached in 5 s");
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_on_a_timer_until_done_then_reports_and_stops() {
    let (_dir, store) = migrated(7);
    let db = store.db.clone();
    let lines: Lines = Arc::default();
    let job = Compactor::new(CompactorOptions {
        interval: Duration::from_millis(10),
        initial_delay: Duration::from_millis(300),
        log_every: Duration::ZERO,
        ..CompactorOptions { batch_size: 2, ..compactor_opts(&db, &lines) }
    });
    job.start(&tokio::runtime::Handle::current());
    assert!(job.status().running);
    assert_eq!(job.status().remaining, 9);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(db.count_uncompacted().unwrap(), 9); // initial delay not elapsed
    wait_until(|| !job.status().running).await;
    assert_eq!(db.count_uncompacted().unwrap(), 0);
    let s = job.status();
    assert_eq!((s.running, s.processed, s.remaining), (false, 9, 0));
    let l = lines.lock().unwrap().clone();
    assert!(l[0].contains("9 rows to compact"), "{l:?}");
    assert!(l.last().unwrap().contains("done: 9 rows, 0 left"), "{l:?}");
    drop(l);
    job.start(&tokio::runtime::Handle::current());
    assert!(!job.status().running);
    assert_eq!(lines.lock().unwrap().last().unwrap(), "[compactor] nothing to compact");
}

fn compactor_opts(db: &Arc<Db>, lines: &Lines) -> CompactorOptions {
    let l = lines.clone();
    CompactorOptions { log: Arc::new(move |s| l.lock().unwrap().push(s.to_string())), ..CompactorOptions::for_db(db.clone()) }
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_halts_the_timer_and_start_resumes() {
    let (_dir, store) = migrated(4);
    let db = store.db.clone();
    let lines: Lines = Arc::default();
    let job = Compactor::new(CompactorOptions {
        batch_size: 2,
        interval: Duration::from_millis(400),
        initial_delay: Duration::ZERO,
        ..compactor_opts(&db, &lines)
    });
    job.start(&tokio::runtime::Handle::current());
    wait_until(|| job.status().processed >= 2).await;
    job.stop();
    assert_eq!(db.count_uncompacted().unwrap(), 4);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(db.count_uncompacted().unwrap(), 4);
    assert!(!job.status().running);
    job.start(&tokio::runtime::Handle::current());
    wait_until(|| !job.status().running).await;
    assert_eq!(db.count_uncompacted().unwrap(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_and_records_the_error_when_a_batch_fails() {
    let lines: Lines = Arc::default();
    let l = lines.clone();
    let job = Compactor::new(CompactorOptions {
        batch_size: 200,
        interval: Duration::from_millis(10),
        initial_delay: Duration::ZERO,
        log_every: Duration::ZERO,
        run_batch: Arc::new(|_| Err(anyhow::anyhow!("disk full"))),
        count_remaining: Arc::new(|| Ok(5)),
        log: Arc::new(move |s| l.lock().unwrap().push(s.to_string())),
    });
    job.start(&tokio::runtime::Handle::current());
    wait_until(|| !job.status().running).await;
    assert_eq!(job.status().error.as_deref(), Some("disk full"));
    assert!(lines.lock().unwrap().last().unwrap().contains("stopped on error: disk full"));
}

#[test]
fn v3_rerun_over_compressed_rows_keeps_the_index_whole() {
    let (dir, store) = migrated(5);
    let path = dir.path().join("mail.db");
    let lines: Lines = Arc::default();
    compactor(&store.db, 200, &lines).run_to_completion().unwrap();
    assert!(raw_rows(&path).iter().all(|r| r.codec == "zstd"));
    drop(store);
    Connection::open(&path).unwrap().execute_batch("PRAGMA user_version = 2").unwrap();
    let store = open_at(&path, ManualClock::new(T0));
    let db = &store.db;
    assert_eq!(pragma(&path, "user_version"), 4);
    assert!(raw_rows(&path).iter().all(|r| r.codec == "zstd"));
    assert_eq!(db.count_indexed().unwrap(), 7);
    assert_eq!(db.search_messages("\"text 3\"", None, None).unwrap().len(), 1);
    assert_eq!(db.search_messages("hidden", None, None).unwrap().len(), 1);
    assert!(db.get_message_wire("a", "g3").unwrap().unwrap().body_text.starts_with("text 3 "));
}

#[test]
fn pages_freed_by_compaction_are_vacuumed_at_the_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mail.db");
    let rows: Vec<V2Row> = (0..600).map(|i| v2(&format!("g{i}"), &format!("{i} ").repeat(8000), None)).collect();
    build_v2(&path, &rows);
    let store = open_at(&path, ManualClock::new(T0));
    let lines: Lines = Arc::default();
    compactor(&store.db, 200, &lines).run_to_completion().unwrap();
    drop(store);
    {
        // Fold the WAL back so page counts describe the main file
        Connection::open(&path).unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    }
    let free_before = pragma(&path, "freelist_count");
    let pages_before = pragma(&path, "page_count");
    assert!(free_before * 4096 > 8 * 1024 * 1024);
    assert!(free_before as f64 / pages_before as f64 > 0.25);

    let store = open_at(&path, ManualClock::new(T0));
    assert_eq!(pragma(&path, "freelist_count"), 0);
    assert!(pragma(&path, "page_count") < pages_before / 2);
    assert!(store.db.get_message_wire("a", "g599").unwrap().unwrap().body_text.starts_with("599 599 "));
    assert_eq!(store.db.count_indexed().unwrap(), 600);
}

#[test]
fn text_rows_and_node_style_frames_decode_side_by_side() {
    // A row the Electron app compressed (a standard zstd frame with a checksum)
    // next to a plain TEXT row: both read back through the store
    let (dir, store) = migrated(1);
    let path = dir.path().join("mail.db");
    let mut enc = zstd::stream::Encoder::new(Vec::new(), 9).unwrap();
    enc.include_checksum(true).unwrap();
    std::io::Write::write_all(&mut enc, "written by node".as_bytes()).unwrap();
    let frame = enc.finish().unwrap();
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE messages SET body_text = ?, body_codec = 'zstd' WHERE gmail_id = 'stub'", [frame])
        .unwrap();
    assert_eq!(store.db.get_message_wire("a", "stub").unwrap().unwrap().body_text, "written by node");
    assert!(store.db.get_message_wire("a", "g0").unwrap().unwrap().body_text.starts_with("text 0 "));
    assert!(!raw_rows(&path)[0].text_bytes.is_empty());
}
