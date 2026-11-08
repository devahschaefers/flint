//! Thread lists, the smart inbox overview, search,
//! contacts, unread counts, and thread-action resolution

use super::*;
use crate::queries::ResolvedAction;

const A: &str = "acct";
const B: &str = "acct-b";
const ME: &str = "me@example.com";

fn setup() -> TestDb {
    let t = fresh();
    create_account(t.db(), A, ME);
    t
}

/// A message in thread `th`
fn msg(gmail_id: &str, th: &str) -> ParsedMessage {
    ParsedMessage { thread_id: th.into(), ..rec(gmail_id) }
}

fn inbox() -> ThreadListView {
    ThreadListView::Inbox { include_archived: false, category: None, important_only: false }
}

fn q(account: Option<&str>, view: ThreadListView) -> ThreadQuery {
    ThreadQuery { account_id: account.map(str::to_string), view, cursor: None, limit: 50 }
}

fn keys(p: &ThreadPage) -> Vec<String> {
    p.threads.iter().map(|t| t.thread_key.clone()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[test]
fn groups_messages_into_conversations_with_the_newest_on_top() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(
        A,
        &[
            ParsedMessage { date_ms: 1000, seen: true, subject: "Hello".into(), ..msg("m1", "T1") },
            ParsedMessage {
                date_ms: 3000,
                subject: "Re: Hello".into(),
                from_addr: "other@x.com".into(),
                from_name: Some("Other".into()),
                ..msg("m2", "T1")
            },
            ParsedMessage { date_ms: 2000, seen: true, flagged: true, subject: "Solo".into(), ..msg("m3", "T2") },
        ],
    )
    .unwrap();
    let page = t.store.list_threads(&q(Some(A), inbox())).unwrap();
    assert_eq!(page.next_cursor, None);
    assert_eq!(keys(&page), strings(&["T1", "T2"]));
    let t1 = &page.threads[0];
    assert_eq!(t1.account_id, A);
    assert_eq!((t1.count, t1.unread, t1.flagged), (2, 1, false));
    assert_eq!(t1.subject, "Re: Hello");
    assert_eq!(t1.latest_date_ms, 3000);
    assert_eq!(t1.folders, FolderCounts { inbox: 2, ..Default::default() });
    assert_eq!(t1.latest.from, mbox(Some("Other"), "other@x.com"));
    assert_eq!(t1.counterpart, Some(mbox(Some("Other"), "other@x.com")));
    assert!(page.threads[1].flagged);
}

#[test]
fn counterpart_skips_own_addresses_and_is_none_on_a_pure_sent_thread() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(
        A,
        &[
            ParsedMessage { date_ms: 1000, from_addr: "friend@x.com".into(), from_name: Some("Friend".into()), ..msg("s1", "T1") },
            ParsedMessage { date_ms: 2000, from_addr: ME.into(), from_name: Some("Me".into()), folder: Folder::Sent, ..msg("s2", "T1") },
            ParsedMessage {
                date_ms: 3000,
                from_addr: ME.into(),
                from_name: Some("Me".into()),
                folder: Folder::Sent,
                to: vec![mbox(None, "you@x.com")],
                ..msg("s3", "T2")
            },
        ],
    )
    .unwrap();
    let page = t.store.list_threads(&q(Some(A), inbox())).unwrap();
    assert_eq!(page.threads.len(), 1);
    assert_eq!(page.threads[0].counterpart, Some(mbox(Some("Friend"), "friend@x.com")));
    let sent = t.store.list_threads(&q(Some(A), ThreadListView::Folder(Folder::Sent))).unwrap();
    let t2 = sent.threads.iter().find(|t| t.thread_key == "T2").unwrap();
    assert_eq!(t2.counterpart, None);
    assert_eq!(t2.latest.to, vec![mbox(None, "you@x.com")]);
}

#[test]
fn inbox_hides_fully_archived_threads_unless_asked() {
    let t = setup();
    t.db()
        .upsert_messages(
            A,
            &[
                ParsedMessage { folder: Folder::Archive, ..msg("a1", "T1") },
                msg("a2", "T2"),
                ParsedMessage { date_ms: 1, ..msg("a3", "T3") },
                ParsedMessage { date_ms: 2, folder: Folder::Archive, ..msg("a4", "T3") },
            ],
        )
        .unwrap();
    let hidden = t.store.list_threads(&q(Some(A), inbox())).unwrap();
    assert_eq!(sorted(keys(&hidden)), strings(&["T2", "T3"]));
    let shown = t
        .store
        .list_threads(&q(Some(A), ThreadListView::Inbox { include_archived: true, category: None, important_only: false }))
        .unwrap();
    assert_eq!(sorted(keys(&shown)), strings(&["T1", "T2", "T3"]));
}

#[test]
fn smart_inbox_splits_into_category_groups_and_important_threads() {
    let t = setup();
    let cat = |c: &str| c.to_string();
    t.db()
        .upsert_messages(
            A,
            &[
                ParsedMessage { category: cat("people"), ..msg("c1", "T1") },
                ParsedMessage { category: cat("notifications"), ..msg("c2", "T2") },
                ParsedMessage { category: cat("people"), important: true, ..msg("c3", "T3") },
                ParsedMessage { date_ms: 1, category: cat("notifications"), ..msg("c4", "T4") },
                ParsedMessage { date_ms: 2, category: cat("people"), ..msg("c5", "T4") }, // latest decides
            ],
        )
        .unwrap();
    let people = t
        .store
        .list_threads(&q(
            Some(A),
            ThreadListView::Inbox { include_archived: false, category: Some("people".into()), important_only: false },
        ))
        .unwrap();
    assert_eq!(sorted(keys(&people)), strings(&["T1", "T4"]));
    let important = t
        .store
        .list_threads(&q(Some(A), ThreadListView::Inbox { include_archived: false, category: None, important_only: true }))
        .unwrap();
    assert_eq!(keys(&important), strings(&["T3"]));
}

#[test]
fn pins_and_folders() {
    let t = setup();
    t.db()
        .upsert_messages(
            A,
            &[
                ParsedMessage { flagged: true, ..msg("p1", "T1") },
                ParsedMessage { flagged: true, folder: Folder::Trash, ..msg("p2", "T2") },
                ParsedMessage { folder: Folder::Spam, ..msg("p3", "T3") },
            ],
        )
        .unwrap();
    assert_eq!(keys(&t.store.list_threads(&q(Some(A), ThreadListView::Pins)).unwrap()), strings(&["T1"]));
    assert_eq!(keys(&t.store.list_threads(&q(Some(A), ThreadListView::Folder(Folder::Trash))).unwrap()), strings(&["T2"]));
    assert_eq!(keys(&t.store.list_threads(&q(Some(A), ThreadListView::Folder(Folder::Spam))).unwrap()), strings(&["T3"]));
}

#[test]
fn pages_with_a_keyset_cursor_without_gaps_or_repeats() {
    let t = setup();
    let msgs: Vec<ParsedMessage> =
        (0..7).map(|i| ParsedMessage { date_ms: 1000 + (i % 3) * 10, ..msg(&format!("k{i}"), &format!("T{i}")) }).collect();
    t.db().upsert_messages(A, &msgs).unwrap();
    let mut seen: Vec<String> = Vec::new();
    let mut cursor = None;
    for _ in 0..10 {
        let page = t.store.list_threads(&ThreadQuery { cursor: cursor.clone(), limit: 3, ..q(Some(A), inbox()) }).unwrap();
        seen.extend(keys(&page));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 7);
    assert_eq!(seen.iter().collect::<std::collections::HashSet<_>>().len(), 7);
    let dates: Vec<i64> = seen.iter().map(|k| k[1..].parse::<i64>().unwrap() % 3).collect();
    let mut desc = dates.clone();
    desc.sort_by(|a, b| b.cmp(a));
    assert_eq!(dates, desc);
}

#[test]
fn merges_accounts_by_date_when_no_account_is_given() {
    let t = setup();
    create_account(t.db(), B, "b@example.com");
    t.db().upsert_messages(A, &[ParsedMessage { date_ms: 1, ..msg("x1", "T1") }]).unwrap();
    t.db().upsert_messages(B, &[ParsedMessage { date_ms: 2, ..msg("y1", "T1") }]).unwrap();
    let page = t.store.list_threads(&q(None, inbox())).unwrap();
    let got: Vec<(String, String)> = page.threads.iter().map(|t| (t.account_id.clone(), t.thread_key.clone())).collect();
    assert_eq!(got, vec![(B.into(), "T1".into()), (A.into(), "T1".into())]);
}

#[test]
fn local_mail_without_a_gmail_thread_is_keyed_by_message_id() {
    let t = setup();
    let db = t.db();
    let li = LocalMessageInput {
        account_id: A.into(),
        to: vec![mbox(None, "you@x.com")],
        subject: "Out".into(),
        text: "body".into(),
        ..Default::default()
    };
    db.put_local_message(&li, "<local@flint.local>", &mbox(Some("Me"), ME), MessageState::Queued, Folder::Sent, Some(T0))
        .unwrap();
    let page = t.store.list_threads(&q(Some(A), ThreadListView::Folder(Folder::Sent))).unwrap();
    assert_eq!(page.threads[0].thread_key, "<local@flint.local>");
    assert_eq!(page.threads[0].count, 1);
    assert_eq!(page.threads[0].latest.state, MessageState::Queued);
    assert_eq!(db.query_thread(A, "<local@flint.local>").unwrap().len(), 1);
}

#[test]
fn inbox_overview_buckets_by_category_with_per_address_chips() {
    let t = setup();
    let n = |id: &str, th: &str, d: i64, addr: &str, name: &str, seen: bool| ParsedMessage {
        date_ms: d,
        category: "notifications".into(),
        from_addr: addr.into(),
        from_name: Some(name.into()),
        seen,
        ..msg(id, th)
    };
    t.db()
        .upsert_messages(
            A,
            &[
                n("o1", "T1", 3, "news@a.com", "A News", false),
                n("o2", "T2", 2, "news@a.com", "A News", true),
                n("o3", "T3", 1, "alerts@b.com", "B", true),
                ParsedMessage { category: "people".into(), important: true, ..msg("o4", "T4") },
                ParsedMessage {
                    category: "people".into(),
                    from_addr: "pal@c.com".into(),
                    from_name: Some("Pal".into()),
                    ..msg("o5", "T5")
                },
            ],
        )
        .unwrap();
    let ov = t.store.inbox_overview(Some(A), false).unwrap();
    assert_eq!(ov.groups.iter().map(|g| g.category.clone()).collect::<Vec<_>>(), strings(&["notifications", "people"]));
    let notif = &ov.groups[0];
    assert_eq!((notif.count, notif.unread), (3, 1));
    assert_eq!(
        notif.chips,
        vec![
            InboxChip { mailbox: mbox(Some("A News"), "news@a.com"), count: 2, unread: true },
            InboxChip { mailbox: mbox(Some("B"), "alerts@b.com"), count: 1, unread: false },
        ]
    );
    assert_eq!(ov.groups[1].count, 1);
}

#[test]
fn search_returns_one_result_per_conversation_best_first() {
    let t = setup();
    t.db()
        .upsert_messages(
            A,
            &[
                ParsedMessage { subject: "Invoice for October".into(), body_text: "please find attached".into(), ..msg("f1", "T1") },
                ParsedMessage {
                    date_ms: 2_000_000_000_000,
                    subject: "Re: Invoice for October".into(),
                    body_text: "thanks".into(),
                    ..msg("f2", "T1")
                },
                ParsedMessage { subject: "Lunch".into(), body_text: "the invoice was wrong".into(), ..msg("f3", "T2") },
                ParsedMessage { subject: "Unrelated".into(), body_text: "nothing here".into(), ..msg("f4", "T3") },
            ],
        )
        .unwrap();
    let hits = t.store.search_threads("invoice", Some(A), 50).unwrap();
    assert_eq!(hits.iter().map(|h| h.thread.thread_key.clone()).collect::<Vec<_>>(), strings(&["T1", "T2"]));
    assert!(hits[0].matched.subject.contains("Invoice"));
    assert_eq!(hits[0].thread.count, 2);
    let nothing = t.store.search_threads("\"nothing here\"", Some(A), 50).unwrap();
    assert_eq!(nothing.iter().map(|h| h.thread.thread_key.clone()).collect::<Vec<_>>(), strings(&["T3"]));
    assert!(t.store.search_threads("   ", Some(A), 50).unwrap().is_empty());
    assert!(t.store.search_threads("zzz-not-there", Some(A), 50).unwrap().is_empty());
}

#[test]
fn contacts_are_named_senders_then_recipients_without_own_addresses() {
    let t = setup();
    t.db()
        .upsert_messages(
            A,
            &[
                ParsedMessage {
                    from_addr: "Ann@x.com".into(),
                    from_name: Some("Ann".into()),
                    to: vec![mbox(Some("Me"), ME)],
                    ..msg("c1", "T1")
                },
                ParsedMessage {
                    from_addr: ME.into(),
                    from_name: Some("Me".into()),
                    folder: Folder::Sent,
                    to: vec![mbox(Some("Bob"), "bob@x.com")],
                    ..msg("c2", "T2")
                },
                ParsedMessage { from_addr: "ann@x.com".into(), from_name: Some("Ann Again".into()), ..msg("c3", "T3") },
                ParsedMessage { from_addr: "anon@x.com".into(), from_name: None, ..msg("c4", "T4") },
            ],
        )
        .unwrap();
    let contacts = t.store.list_contacts(Some(A)).unwrap();
    assert_eq!(sorted(contacts.iter().map(|c| c.address.clone()).collect()), strings(&["ann@x.com", "bob@x.com"]));
    assert!(contacts.iter().find(|c| c.address == "ann@x.com").unwrap().name.starts_with("Ann"));
}

#[test]
fn counts_unread_inbox_messages_per_account() {
    let t = setup();
    create_account(t.db(), B, "b@example.com");
    t.db().upsert_messages(A, &[msg("u1", "T1"), ParsedMessage { folder: Folder::Archive, ..msg("u2", "T2") }]).unwrap();
    t.db().upsert_messages(B, &[msg("u3", "T3")]).unwrap();
    let mut counts = t.store.unread_counts().unwrap();
    counts.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    assert_eq!(
        counts,
        vec![UnreadCount { account_id: A.into(), inbox_unread: 1 }, UnreadCount { account_id: B.into(), inbox_unread: 1 }]
    );
}

fn tref(key: &str) -> ThreadRef {
    ThreadRef { account_id: A.into(), thread_key: key.into() }
}

fn ra(action: MailAction, value: Option<bool>, ids: &[&str]) -> ResolvedAction {
    ResolvedAction { action, value, gmail_ids: strings(ids) }
}

#[test]
fn toggle_archive_archives_the_inbox_or_restores_the_archive() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(
        A,
        &[msg("r1", "T1"), ParsedMessage { folder: Folder::Archive, ..msg("r2", "T1") }, ParsedMessage { folder: Folder::Sent, ..msg("r3", "T1") }],
    )
    .unwrap();
    assert_eq!(db.resolve_thread_action(&tref("T1"), ThreadAction::ToggleArchive).unwrap(), vec![ra(MailAction::Archive, None, &["r1"])]);
    db.apply_local_action(A, &strings(&["r1"]), "archive", None).unwrap();
    assert_eq!(
        db.resolve_thread_action(&tref("T1"), ThreadAction::ToggleArchive).unwrap(),
        vec![ra(MailAction::Unarchive, None, &["r1", "r2"])]
    );
}

#[test]
fn flag_and_seen_toggles_look_at_the_whole_conversation() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(A, &[ParsedMessage { seen: true, ..msg("r1", "T1") }, ParsedMessage { flagged: true, ..msg("r2", "T1") }])
        .unwrap();
    let r = |a| db.resolve_thread_action(&tref("T1"), a).unwrap();
    assert_eq!(r(ThreadAction::ToggleFlagged), vec![ra(MailAction::Flagged, Some(false), &["r1", "r2"])]);
    assert_eq!(r(ThreadAction::ToggleSeen), vec![ra(MailAction::Seen, Some(true), &["r1", "r2"])]);
    assert_eq!(r(ThreadAction::MarkSeen), vec![ra(MailAction::Seen, Some(true), &["r2"])]);
    db.apply_local_action(A, &strings(&["r2"]), "seen", Some(true)).unwrap();
    assert_eq!(r(ThreadAction::MarkSeen), vec![]);
}

#[test]
fn moves_skip_sent_and_drafts_and_ignore_unknown_threads() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(
        A,
        &[msg("r1", "T1"), ParsedMessage { folder: Folder::Sent, ..msg("r2", "T1") }, ParsedMessage { folder: Folder::Drafts, ..msg("r3", "T1") }],
    )
    .unwrap();
    assert_eq!(db.resolve_thread_action(&tref("T1"), ThreadAction::Trash).unwrap(), vec![ra(MailAction::Trash, None, &["r1"])]);
    assert_eq!(db.resolve_thread_action(&tref("nope"), ThreadAction::Trash).unwrap(), vec![]);
}

#[test]
fn thread_summaries_come_back_in_the_order_asked() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(A, &[msg("s1", "T1"), msg("s2", "T2"), msg("s3", "T3")]).unwrap();
    let got = db.get_thread_summaries(&[tref("T3"), tref("missing"), tref("T1")]).unwrap();
    assert_eq!(got.iter().map(|t| t.thread_key.clone()).collect::<Vec<_>>(), strings(&["T3", "T1"]));
}

#[test]
fn drafts_list_and_message_by_header() {
    let t = setup();
    let db = t.db();
    db.upsert_messages(A, &[ParsedMessage { folder: Folder::Drafts, date_ms: 5, ..msg("d1", "T1") }, msg("i1", "T2")]).unwrap();
    let li = LocalMessageInput { account_id: A.into(), subject: "local".into(), text: "x".into(), ..Default::default() };
    db.put_local_message(&li, "<d2@flint.local>", &mbox(Some("Me"), ME), MessageState::Draft, Folder::Drafts, None).unwrap();
    let drafts = t.store.list_drafts(None).unwrap();
    assert_eq!(drafts.iter().map(|m| m.subject.clone()).collect::<Vec<_>>(), strings(&["local", "Subject d1"]));
    assert_eq!(t.store.list_drafts(Some("nobody")).unwrap(), vec![]);
    let m = t.store.message_by_hdr(A, "<d2@flint.local>").unwrap().unwrap();
    assert_eq!(m.thread_key, "<d2@flint.local>");
    assert_eq!(m.state, MessageState::Draft);
    assert_eq!(t.store.message_by_hdr(A, "<nope>").unwrap(), None);
}
