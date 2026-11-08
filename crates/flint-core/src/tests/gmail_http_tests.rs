//! The REST client against a local mock server: request shapes, retries,
//! the 401 refresh, and error mapping (the TS adapter leaned on the SDK for these)

use crate::google::gmail::*;
use crate::google::oauth::TokenSource;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    target: String,
    auth: Option<String>,
    body: String,
}

struct Mock {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

/// Serve `responses` in order, one per request, recording each request
async fn mock(responses: Vec<(u16, &'static str)>) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/gmail/v1/users/me", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
    let s = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            let (s, queue) = (s.clone(), queue.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = stream.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len: usize = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                    .unwrap_or(0);
                while buf.len() < head_end + len {
                    let n = stream.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let mut first = head.lines().next().unwrap().split_whitespace();
                let auth = head.lines().find_map(|l| {
                    l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim().to_string())
                });
                s.lock().unwrap().push(Seen {
                    method: first.next().unwrap().into(),
                    target: first.next().unwrap().into(),
                    auth,
                    body: String::from_utf8_lossy(&buf[head_end..head_end + len]).into(),
                });
                let (status, body) = queue.lock().unwrap().pop_front().unwrap_or((500, "{}"));
                let msg = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(msg.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    Mock { base, seen }
}

#[derive(Default)]
struct FakeTokens {
    refreshes: AtomicUsize,
}

#[async_trait]
impl TokenSource for FakeTokens {
    async fn access_token(&self, force: bool) -> GResult<String> {
        if force {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
        }
        Ok(format!("tok{}", self.refreshes.load(Ordering::SeqCst)))
    }
}

fn client(m: &Mock) -> (GmailClient, Arc<FakeTokens>) {
    let tokens = Arc::new(FakeTokens::default());
    (GmailClient::new(reqwest::Client::new(), tokens.clone()).with_base(m.base.clone()), tokens)
}

fn path_of(s: &Seen) -> &str {
    s.target.strip_prefix("/gmail/v1/users/me").unwrap()
}

#[tokio::test]
async fn profile_and_listing_requests() {
    let m = mock(vec![
        (200, r#"{"emailAddress":"me@x.com","historyId":"42"}"#),
        (200, r#"{"messages":[{"id":"a"},{"id":"b"}],"nextPageToken":"n1"}"#),
    ])
    .await;
    let (c, _) = client(&m);
    assert_eq!(c.get_profile().await.unwrap(), Profile { email_address: "me@x.com".into(), history_id: "42".into() });
    let page = c
        .list_message_ids(Some("p0"), ListOpts { label_ids: Some(vec!["INBOX".into(), "UNREAD".into()]), max_results: None, q: Some("rfc822msgid:<a@b>".into()) })
        .await
        .unwrap();
    assert_eq!(page, IdPage { ids: vec!["a".into(), "b".into()], next_page_token: Some("n1".into()) });
    let seen = m.seen.lock().unwrap().clone();
    assert_eq!(seen[0].auth.as_deref(), Some("Bearer tok0"));
    assert_eq!(path_of(&seen[0]), "/profile");
    let url = url::Url::parse(&format!("http://x{}", seen[1].target)).unwrap();
    let q: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    assert!(q.contains(&("maxResults".into(), "100".into())));
    assert!(q.contains(&("includeSpamTrash".into(), "true".into())));
    assert!(q.contains(&("labelIds".into(), "INBOX".into())) && q.contains(&("labelIds".into(), "UNREAD".into())));
    assert!(q.contains(&("q".into(), "rfc822msgid:<a@b>".into())));
    assert!(q.contains(&("pageToken".into(), "p0".into())));
}

#[tokio::test]
async fn list_all_follows_pages_and_dedupes_in_order() {
    let m = mock(vec![
        (200, r#"{"messages":[{"id":"c"},{"id":"a"}],"nextPageToken":"n"}"#),
        (200, r#"{"messages":[{"id":"a"},{"id":"b"}]}"#),
    ])
    .await;
    let (c, _) = client(&m);
    assert_eq!(c.list_all_message_ids(Some(vec!["STARRED".into()])).await.unwrap(), vec!["c", "a", "b"]);
    assert!(m.seen.lock().unwrap()[0].target.contains("maxResults=500"));
}

#[tokio::test]
async fn get_message_parses_and_a_404_is_none() {
    let m = mock(vec![
        (200, r#"{"id":"g1","threadId":"t1","labelIds":["INBOX"],"internalDate":"5","snippet":"s","payload":{"mimeType":"text/plain","headers":[{"name":"Subject","value":"Hi"}],"body":{"data":"aGVsbG8gdGhlcmUgZnJvbSB0aGUgcGxhaW4gcGFydA"}}}"#),
        (404, r#"{"error":{"code":404,"message":"Requested entity was not found."}}"#),
    ])
    .await;
    let (c, _) = client(&m);
    let p = c.get_message("g1").await.unwrap().unwrap();
    assert_eq!((p.subject.as_str(), p.body_text.as_str(), p.date_ms), ("Hi", "hello there from the plain part", 5));
    assert_eq!(c.get_message_metadata("gone").await.unwrap(), None);
    let seen = m.seen.lock().unwrap().clone();
    assert_eq!(path_of(&seen[0]), "/messages/g1?format=full");
    assert_eq!(path_of(&seen[1]), "/messages/gone?format=metadata");
}

#[tokio::test]
async fn retries_transient_statuses_with_backoff() {
    let m = mock(vec![(503, "{}"), (200, r#"{"emailAddress":"a","historyId":"1"}"#)]).await;
    let (c, _) = client(&m);
    let started = std::time::Instant::now();
    c.get_profile().await.unwrap();
    assert!(started.elapsed() >= std::time::Duration::from_millis(900));
    assert_eq!(m.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_401_refreshes_the_token_once_and_retries() {
    let m = mock(vec![(401, r#"{"error":{"message":"Invalid Credentials"}}"#), (200, r#"{"emailAddress":"a","historyId":"1"}"#)]).await;
    let (c, tokens) = client(&m);
    c.get_profile().await.unwrap();
    assert_eq!(tokens.refreshes.load(Ordering::SeqCst), 1);
    let seen = m.seen.lock().unwrap().clone();
    assert_eq!(seen[1].auth.as_deref(), Some("Bearer tok1"));
}

#[tokio::test]
async fn client_errors_map_to_gmail_error_with_googles_message() {
    let m = mock(vec![(400, r#"{"error":{"code":400,"message":"Invalid To header"}}"#)]).await;
    let (c, _) = client(&m);
    let e = c.send(b"raw", None).await.unwrap_err();
    assert_eq!(e.status, 400);
    assert_eq!(e.message, "Gmail messages.send failed: Invalid To header");
}

#[tokio::test]
async fn transport_failures_are_status_zero() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/x", listener.local_addr().unwrap());
    drop(listener);
    let c = GmailClient::new(reqwest::Client::new(), Arc::new(FakeTokens::default())).with_base(base);
    let e = c.get_profile().await.unwrap_err();
    assert_eq!(e.status, 0);
}

#[tokio::test]
async fn write_requests_carry_the_ts_bodies() {
    let m = mock(vec![
        (200, r#"{"id":"s1","threadId":"t1"}"#),
        (200, r#"{"id":"d1","message":{"id":"m1","threadId":"t2"}}"#),
        (200, r#"{"id":"d1","message":{"id":"m2","threadId":"t2"}}"#),
        (200, ""),
        (404, "{}"),
        (200, ""),
        (200, "{}"),
        (200, "{}"),
        (200, r#"{"drafts":[{"id":"d9","message":{"id":"other"}}],"nextPageToken":"p"}"#),
        (200, r#"{"drafts":[{"id":"d7","message":{"id":"m7"}}]}"#),
    ])
    .await;
    let (c, _) = client(&m);
    assert_eq!(c.send(b"hello", None).await.unwrap(), SentRef { id: "s1".into(), thread_id: "t1".into() });
    assert_eq!(
        c.create_draft(b"d", Some("t2")).await.unwrap(),
        DraftRef { draft_id: "d1".into(), message_id: "m1".into(), thread_id: "t2".into() }
    );
    assert_eq!(c.update_draft("d1", b"d", None).await.unwrap().message_id, "m2");
    c.batch_modify(&["g1".into()], &["INBOX"], &[]).await.unwrap();
    c.delete_draft("gone").await.unwrap(); // 404 is fine
    c.delete_draft("d1").await.unwrap();
    c.trash("g1").await.unwrap();
    c.untrash("g1").await.unwrap();
    assert_eq!(c.find_draft_id_for_message("m7").await.unwrap().as_deref(), Some("d7"));
    c.batch_modify(&[], &["INBOX"], &[]).await.unwrap(); // empty: no request

    let seen = m.seen.lock().unwrap().clone();
    let body = |i: usize| -> Value { serde_json::from_str(&seen[i].body).unwrap() };
    assert_eq!((seen[0].method.as_str(), path_of(&seen[0])), ("POST", "/messages/send"));
    assert_eq!(body(0), json!({ "raw": "aGVsbG8" })); // base64url, no threadId key when there is none
    assert_eq!(body(1), json!({ "message": { "raw": "ZA", "threadId": "t2" } }));
    assert_eq!((seen[2].method.as_str(), path_of(&seen[2])), ("PUT", "/drafts/d1"));
    assert_eq!(body(3), json!({ "ids": ["g1"], "addLabelIds": ["INBOX"], "removeLabelIds": [] }));
    assert_eq!((seen[4].method.as_str(), path_of(&seen[4])), ("DELETE", "/drafts/gone"));
    assert_eq!(path_of(&seen[6]), "/messages/g1/trash");
    assert_eq!(path_of(&seen[7]), "/messages/g1/untrash");
    assert!(seen[9].target.contains("pageToken=p"));
    assert_eq!(seen.len(), 10);
}

#[tokio::test]
async fn history_is_normalized() {
    let m = mock(vec![(
        200,
        r#"{"historyId":"9","history":[{"messagesAdded":[{"message":{"id":"a"}}],"messagesDeleted":[{"message":{"id":"b"}}],"labelsAdded":[{"message":{"id":"c","labelIds":["STARRED"]}}],"labelsRemoved":[{"message":{"id":"d"}}]}]}"#,
    )])
    .await;
    let (c, _) = client(&m);
    let page = c.list_history("5", None).await.unwrap();
    assert_eq!(page.history_id.as_deref(), Some("9"));
    assert_eq!(page.next_page_token, None);
    assert_eq!(
        page.history,
        vec![HistoryEntry {
            messages_added: vec!["a".into()],
            messages_deleted: vec!["b".into()],
            label_changes: vec![("c".into(), vec!["STARRED".into()]), ("d".into(), vec![])],
        }]
    );
    let target = m.seen.lock().unwrap()[0].target.clone();
    assert!(target.contains("startHistoryId=5") && target.contains("maxResults=100"));
}
