//! Read queries the UI's lists are built from.
//! Everything is computed in SQL over the messages table, grouped by
//! `thread_key`. No body column is read, so nothing is decompressed for a list.

use crate::db::{parse_folder, parse_state, Db};
use crate::storage::search::build_match_expression;
use crate::types::*;
use anyhow::Result;
use rusqlite::types::Value;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

const PAGE_MAX: usize = 200;
/// Messages ranked per search before they are folded into conversations
const SEARCH_MESSAGE_CAP: i64 = 2000;

/// Lowercased addresses that belong to the user's accounts
const OWN_ADDRESSES: &str = "(SELECT LOWER(email) FROM accounts)";

/// Per-conversation aggregates plus the newest message's display fields
/// `inner_filter` narrows the aggregated messages.
fn threads_sql(inner_filter: &str) -> String {
    format!(
        "
WITH agg AS (
  SELECT account_id, thread_key,
    MAX(date) AS latest_date, COUNT(*) AS n, SUM(seen = 0) AS unread,
    MAX(flagged) AS flagged, MAX(important) AS important,
    SUM(folder = 'inbox') AS f_inbox, SUM(folder = 'archive') AS f_archive,
    SUM(folder = 'sent') AS f_sent, SUM(folder = 'drafts') AS f_drafts,
    SUM(folder = 'trash') AS f_trash, SUM(folder = 'spam') AS f_spam,
    (SELECT x.id FROM messages x
       WHERE x.account_id = m.account_id AND x.thread_key = m.thread_key
       ORDER BY x.date DESC, x.id DESC LIMIT 1) AS latest_id
  FROM messages m
  WHERE (@accountId IS NULL OR account_id = @accountId) AND thread_key IS NOT NULL {inner_filter}
  GROUP BY account_id, thread_key
)
SELECT agg.account_id, agg.thread_key, agg.latest_date, agg.n, agg.unread, agg.flagged, agg.important,
  agg.f_inbox, agg.f_archive, agg.f_sent, agg.f_drafts, agg.f_trash, agg.f_spam,
  l.subject, l.snippet, l.category, l.from_name, l.from_addr, l.to_json,
  l.folder AS latest_folder, l.state, l.send_after, l.send_error, l.message_id_hdr,
  (SELECT c.from_addr FROM messages c
     WHERE c.account_id = agg.account_id AND c.thread_key = agg.thread_key
       AND LOWER(c.from_addr) NOT IN {OWN_ADDRESSES}
     ORDER BY c.date DESC LIMIT 1) AS cp_addr,
  (SELECT c.from_name FROM messages c
     WHERE c.account_id = agg.account_id AND c.thread_key = agg.thread_key
       AND LOWER(c.from_addr) NOT IN {OWN_ADDRESSES}
     ORDER BY c.date DESC LIMIT 1) AS cp_name
FROM agg
JOIN messages l ON l.id = agg.latest_id
"
    )
}

fn thread_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WireThread> {
    let to_json: String = r.get("to_json")?;
    let cp_addr: Option<String> = r.get("cp_addr")?;
    let cp_name: Option<String> = r.get("cp_name")?;
    Ok(WireThread {
        account_id: r.get("account_id")?,
        thread_key: r.get("thread_key")?,
        subject: r.get("subject")?,
        latest_date_ms: r.get("latest_date")?,
        count: r.get("n")?,
        unread: r.get("unread")?,
        flagged: r.get::<_, i64>("flagged")? == 1,
        important: r.get::<_, i64>("important")? == 1,
        category: r.get("category")?,
        folders: FolderCounts {
            inbox: r.get("f_inbox")?,
            archive: r.get("f_archive")?,
            sent: r.get("f_sent")?,
            drafts: r.get("f_drafts")?,
            trash: r.get("f_trash")?,
            spam: r.get("f_spam")?,
        },
        latest: ThreadLatest {
            message_id_hdr: r.get("message_id_hdr")?,
            from: Mailbox { name: r.get("from_name")?, address: r.get("from_addr")? },
            to: serde_json::from_str(&to_json).unwrap_or_default(),
            snippet: r.get("snippet")?,
            folder: parse_folder(&r.get::<_, String>("latest_folder")?),
            state: parse_state(&r.get::<_, String>("state")?),
            send_after_ms: r.get("send_after")?,
            send_error: r.get("send_error")?,
        },
        counterpart: cp_addr.filter(|a| !a.is_empty()).map(|address| Mailbox { name: cp_name, address }),
    })
}

/// Named parameters built up alongside the SQL
#[derive(Default)]
struct Params(Vec<(String, Value)>);

impl Params {
    fn set(&mut self, name: &str, v: impl Into<Value>) {
        self.0.push((format!("@{name}"), v.into()));
    }

    fn opt(&mut self, name: &str, v: Option<&str>) {
        self.set(name, v.map(|s| Value::Text(s.to_string())).unwrap_or(Value::Null));
    }

    fn as_refs(&self) -> Vec<(&str, &dyn rusqlite::ToSql)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v as &dyn rusqlite::ToSql)).collect()
    }
}

fn folder_column(f: Folder) -> &'static str {
    match f {
        Folder::Inbox => "agg.f_inbox",
        Folder::Archive => "agg.f_archive",
        Folder::Sent => "agg.f_sent",
        Folder::Drafts => "agg.f_drafts",
        Folder::Trash => "agg.f_trash",
        Folder::Spam => "agg.f_spam",
    }
}

/// WHERE fragment (without the keyword) selecting the conversations a view shows
fn view_filter(view: &ThreadListView, p: &mut Params) -> String {
    match view {
        ThreadListView::Inbox { include_archived, category, important_only } => {
            p.set("includeArchived", *include_archived as i64);
            let mut parts = vec!["(agg.f_inbox > 0 OR (@includeArchived = 1 AND agg.f_archive > 0))".to_string()];
            if let Some(cat) = category.as_deref().filter(|c| !c.is_empty()) {
                p.set("category", cat.to_string());
                parts.push("l.category = @category".into());
                parts.push("agg.important = 0".into());
            }
            if *important_only {
                parts.push("agg.important = 1".into());
            }
            parts.join(" AND ")
        }
        ThreadListView::Folder(f) => format!("{} > 0", folder_column(*f)),
        ThreadListView::Pins => "agg.flagged = 1 AND agg.f_trash = 0 AND agg.f_spam = 0".into(),
    }
}

const ORDER: &str = "ORDER BY agg.latest_date DESC, agg.account_id, agg.thread_key";

fn query_threads(c: &Connection, sql: &str, p: &Params) -> Result<Vec<WireThread>> {
    let mut stmt = c.prepare_cached(sql)?;
    let rows = stmt.query_map(p.as_refs().as_slice(), thread_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn thread_summaries(c: &Connection, refs: &[ThreadRef]) -> Result<Vec<WireThread>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let mut p = Params::default();
    p.opt("accountId", None);
    let clauses: Vec<String> = refs
        .iter()
        .enumerate()
        .map(|(i, r)| {
            p.set(&format!("a{i}"), r.account_id.clone());
            p.set(&format!("k{i}"), r.thread_key.clone());
            format!("(m.account_id = @a{i} AND m.thread_key = @k{i})")
        })
        .collect();
    // Filter inside the aggregate so only these conversations' messages are read
    let sql = threads_sql(&format!("AND ({})", clauses.join(" OR ")));
    // Not cached: the statement text depends on the number of refs
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(p.as_refs().as_slice(), thread_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut by_ref: HashMap<(String, String), WireThread> =
        rows.into_iter().map(|t| ((t.account_id.clone(), t.thread_key.clone()), t)).collect();
    Ok(refs
        .iter()
        .filter_map(|r| by_ref.remove(&(r.account_id.clone(), r.thread_key.clone())))
        .collect())
}

const OVERVIEW_ORDER: [&str; 3] = ["notifications", "people", "invites"];
const CHIPS_PER_GROUP: usize = 6;

/// JS indexOf semantics for the overview sort (unknown categories sort first, as -1)
fn overview_rank(cat: &str) -> i64 {
    OVERVIEW_ORDER.iter().position(|c| *c == cat).map_or(-1, |i| i as i64)
}

const CONTACTS_CAP: usize = 1000;

/// Label actions a thread-level intent resolves to
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAction {
    pub action: MailAction,
    pub value: Option<bool>,
    pub gmail_ids: Vec<String>,
}

impl Db {
    /// One page of conversations for a view, newest first, keyset-paged
    pub fn list_threads(&self, q: &ThreadQuery) -> Result<ThreadPage> {
        let limit = q.limit.clamp(1, PAGE_MAX);
        let mut p = Params::default();
        p.opt("accountId", q.account_id.as_deref());
        p.set("limit", (limit + 1) as i64);
        let mut wheres = vec![view_filter(&q.view, &mut p)];
        if let Some(cur) = &q.cursor {
            p.set("cd", cur.latest_date_ms);
            p.set("ca", cur.account_id.clone());
            p.set("ck", cur.thread_key.clone());
            wheres.push(
                "(agg.latest_date < @cd OR (agg.latest_date = @cd AND
        (agg.account_id > @ca OR (agg.account_id = @ca AND agg.thread_key > @ck))))"
                    .into(),
            );
        }
        let sql = format!("{} WHERE {} {ORDER} LIMIT @limit", threads_sql(""), wheres.join(" AND "));
        let mut rows = self.read(|c| query_threads(c, &sql, &p))?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = match (more, rows.last()) {
            (true, Some(last)) => Some(ThreadCursor {
                latest_date_ms: last.latest_date_ms,
                account_id: last.account_id.clone(),
                thread_key: last.thread_key.clone(),
            }),
            _ => None,
        };
        Ok(ThreadPage { threads: rows, next_cursor })
    }

    /// Summaries for specific conversations, in the order given
    pub fn get_thread_summaries(&self, refs: &[ThreadRef]) -> Result<Vec<WireThread>> {
        self.read(|c| thread_summaries(c, refs))
    }

    /// The smart inbox's group rows: non-important inbox conversations
    /// bucketed by the newest message's category, with up to six people chips
    pub fn inbox_overview(&self, account_id: Option<&str>, include_archived: bool) -> Result<InboxOverview> {
        let mut p = Params::default();
        p.opt("accountId", account_id);
        let view = ThreadListView::Inbox { include_archived, category: None, important_only: false };
        let filter = view_filter(&view, &mut p);
        let sql = format!("{} WHERE {filter} AND agg.important = 0 {ORDER}", threads_sql(""));
        let rows = self.read(|c| query_threads(c, &sql, &p))?;

        struct Group {
            g: InboxGroup,
            chip_index: HashMap<String, usize>,
        }
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Group> = HashMap::new();
        for t in rows {
            let g = groups.entry(t.category.clone()).or_insert_with(|| {
                order.push(t.category.clone());
                Group {
                    g: InboxGroup { category: t.category.clone(), count: 0, unread: 0, chips: Vec::new() },
                    chip_index: HashMap::new(),
                }
            });
            g.g.count += 1;
            if t.unread > 0 {
                g.g.unread += 1;
            }
            let mailbox = t.counterpart.clone().or_else(|| t.latest.to.first().cloned());
            let Some(mailbox) = mailbox else { continue };
            let key = mailbox.address.to_lowercase();
            if let Some(&idx) = g.chip_index.get(&key) {
                let chip = &mut g.g.chips[idx];
                chip.count += 1;
                chip.unread = chip.unread || t.unread > 0;
            } else if g.g.chips.len() < CHIPS_PER_GROUP {
                g.chip_index.insert(key, g.g.chips.len());
                g.g.chips.push(InboxChip { mailbox, count: 1, unread: t.unread > 0 });
            }
        }
        // Insertion order, then a stable sort by the fixed category order (Array.sort is stable)
        let mut ordered: Vec<InboxGroup> = order.into_iter().filter_map(|k| groups.remove(&k)).map(|g| g.g).collect();
        ordered.sort_by_key(|g| overview_rank(&g.category));
        Ok(InboxOverview { groups: ordered })
    }

    /// Full-text search returning conversations, best match first, each with
    /// its best-matching message
    pub fn search_threads(&self, query: &str, account_id: Option<&str>, limit: usize) -> Result<Vec<SearchResult>> {
        let Some(m) = build_match_expression(query) else { return Ok(Vec::new()) };
        let cap = limit.clamp(1, PAGE_MAX);
        self.read(|c| {
            // bm25() only works in a plain query over the FTS table, so rank
            // messages first and group them in code
            let ranked: Vec<(i64, f64)> = match (|| -> rusqlite::Result<Vec<(i64, f64)>> {
                let mut stmt = c.prepare_cached(
                    "SELECT rowid, bm25(messages_fts, 5.0, 1.0) AS rank
                     FROM messages_fts WHERE messages_fts MATCH @match
                     ORDER BY rank LIMIT @limit",
                )?;
                let rows = stmt
                    .query_map(rusqlite::named_params! {"@match": m, "@limit": SEARCH_MESSAGE_CAP}, |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })() {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("[queries] search failed for {query:?}: {e}");
                    return Ok(Vec::new());
                }
            };
            if ranked.is_empty() {
                return Ok(Vec::new());
            }
            let ids = serde_json::to_string(&ranked.iter().map(|r| r.0).collect::<Vec<_>>())?;
            struct Hit {
                account_id: String,
                thread_key: String,
                message_id_hdr: Option<String>,
                subject: String,
                snippet: String,
            }
            let mut stmt = c.prepare_cached(
                "SELECT m.id, m.account_id, m.thread_key, m.message_id_hdr, m.subject, m.snippet
                 FROM messages m
                 WHERE m.id IN (SELECT value FROM json_each(@ids))
                   AND (@accountId IS NULL OR m.account_id = @accountId)
                   AND m.thread_key IS NOT NULL",
            )?;
            let mut by_id: HashMap<i64, Hit> = stmt
                .query_map(rusqlite::named_params! {"@ids": ids, "@accountId": account_id}, |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        Hit {
                            account_id: r.get(1)?,
                            thread_key: r.get(2)?,
                            message_id_hdr: r.get(3)?,
                            subject: r.get(4)?,
                            snippet: r.get(5)?,
                        },
                    ))
                })?
                .collect::<rusqlite::Result<_>>()?;
            // Best-ranked message per conversation, in rank order, up to the cap
            let mut hits: Vec<(Hit, f64)> = Vec::new();
            let mut seen = HashSet::new();
            for (rowid, rank) in ranked {
                let Some(row) = by_id.remove(&rowid) else { continue };
                if !seen.insert((row.account_id.clone(), row.thread_key.clone())) {
                    continue;
                }
                hits.push((row, rank));
                if hits.len() >= cap {
                    break;
                }
            }
            let refs: Vec<ThreadRef> = hits
                .iter()
                .map(|(h, _)| ThreadRef { account_id: h.account_id.clone(), thread_key: h.thread_key.clone() })
                .collect();
            let mut by_ref: HashMap<(String, String), WireThread> = thread_summaries(c, &refs)?
                .into_iter()
                .map(|t| ((t.account_id.clone(), t.thread_key.clone()), t))
                .collect();
            Ok(hits
                .into_iter()
                .filter_map(|(h, rank)| {
                    let thread = by_ref.remove(&(h.account_id.clone(), h.thread_key.clone()))?;
                    Some(SearchResult {
                        thread,
                        matched: SearchMatch {
                            message_id_hdr: h.message_id_hdr,
                            subject: h.subject,
                            snippet: h.snippet,
                            rank,
                        },
                    })
                })
                .collect())
        })
    }

    /// Address book derived from correspondence: named senders, then named
    /// recipients, newest first, one entry per address; own addresses excluded
    pub fn list_contacts(&self, account_id: Option<&str>) -> Result<Vec<WireContact>> {
        self.read(|c| {
            let cap = CONTACTS_CAP as i64;
            let mut senders = c.prepare_cached(&format!(
                "SELECT LOWER(from_addr) AS address, from_name AS name, MAX(date) AS last
                 FROM messages
                 WHERE (@accountId IS NULL OR account_id = @accountId)
                   AND from_name IS NOT NULL AND from_name != ''
                   AND LOWER(from_addr) NOT IN {OWN_ADDRESSES}
                 GROUP BY address ORDER BY last DESC LIMIT @cap"
            ))?;
            let s: Vec<(Option<String>, Option<String>)> = senders
                .query_map(rusqlite::named_params! {"@accountId": account_id, "@cap": cap}, |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut recipients = c.prepare_cached(&format!(
                "SELECT LOWER(json_extract(j.value, '$.address')) AS address,
                        json_extract(j.value, '$.name') AS name, MAX(m.date) AS last
                 FROM messages m, json_each(m.to_json) j
                 WHERE (@accountId IS NULL OR m.account_id = @accountId)
                   AND json_extract(j.value, '$.name') IS NOT NULL AND json_extract(j.value, '$.name') != ''
                   AND LOWER(json_extract(j.value, '$.address')) NOT IN {OWN_ADDRESSES}
                 GROUP BY address ORDER BY last DESC LIMIT @cap"
            ))?;
            let r: Vec<(Option<String>, Option<String>)> = recipients
                .query_map(rusqlite::named_params! {"@accountId": account_id, "@cap": cap}, |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out: Vec<WireContact> = Vec::new();
            let mut seen = HashSet::new();
            for (address, name) in s.into_iter().chain(r) {
                let Some(address) = address.filter(|a| !a.is_empty()) else { continue };
                if seen.contains(&address) || out.len() >= CONTACTS_CAP {
                    continue;
                }
                seen.insert(address.clone());
                out.push(WireContact { address, name: name.unwrap_or_default() });
            }
            Ok(out)
        })
    }

    pub fn unread_counts(&self) -> Result<Vec<UnreadCount>> {
        self.read(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT account_id AS accountId, COUNT(*) AS inboxUnread
                   FROM messages WHERE folder = 'inbox' AND seen = 0 GROUP BY account_id",
            )?;
            let rows = stmt
                .query_map([], |r| Ok(UnreadCount { account_id: r.get(0)?, inbox_unread: r.get(1)? }))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Turn a thread-level intent into the label actions it means for the
    /// messages Gmail knows about
    pub fn resolve_thread_action(&self, r: &ThreadRef, action: ThreadAction) -> Result<Vec<ResolvedAction>> {
        struct Row {
            gmail_id: String,
            folder: String,
            seen: bool,
            flagged: bool,
        }
        let rows: Vec<Row> = self.read(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT gmail_id, folder, seen, flagged FROM messages
                 WHERE account_id = ? AND thread_key = ? AND gmail_id IS NOT NULL",
            )?;
            let rows = stmt
                .query_map([&r.account_id, &r.thread_key], |row| {
                    Ok(Row {
                        gmail_id: row.get(0)?,
                        folder: row.get(1)?,
                        seen: row.get::<_, i64>(2)? == 1,
                        flagged: row.get::<_, i64>(3)? == 1,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let ids = |pick: &dyn Fn(&Row) -> bool| -> Vec<String> {
            rows.iter().filter(|r| pick(r)).map(|r| r.gmail_id.clone()).collect()
        };
        let non_empty = |action: MailAction, value: Option<bool>, gmail_ids: Vec<String>| {
            if gmail_ids.is_empty() {
                Vec::new()
            } else {
                vec![ResolvedAction { action, value, gmail_ids }]
            }
        };
        Ok(match action {
            ThreadAction::ToggleArchive => {
                if rows.iter().any(|r| r.folder == "inbox") {
                    non_empty(MailAction::Archive, None, ids(&|r| r.folder == "inbox"))
                } else {
                    non_empty(MailAction::Unarchive, None, ids(&|r| r.folder == "archive"))
                }
            }
            ThreadAction::Archive => non_empty(MailAction::Archive, None, ids(&|r| r.folder == "inbox")),
            ThreadAction::ToggleFlagged => {
                let any_flagged = rows.iter().any(|r| r.flagged);
                non_empty(MailAction::Flagged, Some(!any_flagged), ids(&|_| true))
            }
            ThreadAction::ToggleSeen => {
                let any_unseen = rows.iter().any(|r| !r.seen);
                non_empty(MailAction::Seen, Some(any_unseen), ids(&|_| true))
            }
            ThreadAction::MarkSeen => non_empty(MailAction::Seen, Some(true), ids(&|r| !r.seen)),
            ThreadAction::Trash | ThreadAction::Spam | ThreadAction::Inbox => {
                let a = match action {
                    ThreadAction::Trash => MailAction::Trash,
                    ThreadAction::Spam => MailAction::Spam,
                    _ => MailAction::Inbox,
                };
                non_empty(a, None, ids(&|r| r.folder != "sent" && r.folder != "drafts"))
            }
        })
    }
}
