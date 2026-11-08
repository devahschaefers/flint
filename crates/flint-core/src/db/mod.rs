//! Local mail store (port of `src/main/db.ts`). SQLite is the source of truth
//! for everything the app knows: synced mail, locally-authored mail, the
//! outbox of operations still owed to Gmail, and user settings. Same file,
//! same schema, same `user_version` as the Electron app, which may open the
//! database too. Dates are unix ms.
//!
//! Connections: one writer behind a mutex, plus a small pool of read
//! connections (WAL lets them read while the writer commits), so a list query
//! never waits on a sync write batch.
//!
//! Bodies and search work as described in db.ts: bodies are TEXT under codec
//! 'none' or zstd BLOBs, and `messages_fts` (contentless FTS5) is maintained
//! by hand by every function that inserts, rewrites, or deletes a row.

mod messages;
mod ops;

pub use messages::*;
pub use ops::*;

use crate::clock::Clock;
use crate::secrets::SecretBox;
use crate::storage::bodies::{decode_body, StoredBody};
use crate::types::WireAccount;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(crate) const FTS_DDL: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);";

const SCHEMA_TABLES: &str = "
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'gmail',
  refresh_token TEXT,
  history_id TEXT,
  backfill_page_token TEXT,
  backfill_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gmail_id TEXT,
  gmail_draft_id TEXT,
  thread_id TEXT,
  message_id_hdr TEXT,
  in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '[]',
  from_name TEXT,
  from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT,
  subject TEXT NOT NULL DEFAULT '',
  date INTEGER NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  folder TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'people',
  important INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'synced',
  send_after INTEGER,
  send_error TEXT,
  body_codec TEXT NOT NULL DEFAULT 'none',
  body_state TEXT NOT NULL DEFAULT 'full',
  thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, message_id_hdr)) VIRTUAL,
  UNIQUE(account_id, gmail_id),
  UNIQUE(account_id, message_id_hdr)
);
CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_key ON messages(account_id, thread_key, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_body_codec ON messages(body_codec);
CREATE INDEX IF NOT EXISTS idx_messages_body_missing ON messages(account_id, date DESC)
  WHERE body_state = 'missing';
";

const SCHEMA_OPS: &str = "
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_due ON ops(state, next_attempt_at);
";

/// The CREATE ... IF NOT EXISTS block describing the current shape (db.ts SCHEMA)
fn schema() -> String {
    format!("{SCHEMA_TABLES}{FTS_DDL}{SCHEMA_OPS}")
}

/// PRAGMA user_version this build writes
pub const SCHEMA_VERSION: i64 = 4;

/// Contentless-delete FTS5 tables need this SQLite or newer
const MIN_SQLITE: [u32; 3] = [3, 43, 0];

/// Free-page share of the file above which it is rewritten at startup
const VACUUM_FREE_FRACTION: f64 = 0.25;
/// ...as long as there is at least this much to reclaim
const VACUUM_FREE_MIN_BYTES: i64 = 8 * 1024 * 1024;

/// Idle read connections kept around
const MAX_IDLE_READERS: usize = 4;
/// The Electron app may hold the write lock; wait for it rather than fail
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Throws when the linked SQLite is too old for the schema
pub fn assert_sqlite_version(version: &str) -> Result<()> {
    let parts: Vec<u32> = version.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    for (i, min) in MIN_SQLITE.iter().enumerate() {
        let have = parts.get(i).copied().unwrap_or(0);
        if have > *min {
            return Ok(());
        }
        if have < *min {
            bail!(
                "SQLite {}.{}.{} or newer is required (FTS5 contentless_delete); linked {version}",
                MIN_SQLITE[0],
                MIN_SQLITE[1],
                MIN_SQLITE[2]
            );
        }
    }
    Ok(())
}

fn has_table(c: &Connection, name: &str) -> Result<bool> {
    Ok(c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name], |_| Ok(()))
        .optional()?
        .is_some())
}

/// Column names including generated (hidden) ones
fn column_names(c: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = c.prepare(&format!("PRAGMA table_xinfo({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>("name"))?.collect::<rusqlite::Result<_>>()?;
    Ok(names)
}

fn migrate_v2(c: &Connection) -> Result<()> {
    if !has_table(c, "messages")? {
        return Ok(());
    }
    let mut stmt = c.prepare("PRAGMA table_info(messages)")?;
    let cols: Vec<String> = stmt.query_map([], |r| r.get("name"))?.collect::<rusqlite::Result<_>>()?;
    if cols.iter().any(|c| c == "state") {
        return Ok(());
    }
    c.execute_batch(
        "ALTER TABLE messages RENAME TO messages_v1;
         DROP INDEX IF EXISTS idx_messages_list;
         DROP INDEX IF EXISTS idx_messages_date;
         DROP INDEX IF EXISTS idx_messages_thread;
         CREATE INDEX idx_v1_hdr ON messages_v1(account_id, message_id_hdr, id);",
    )?;
    c.execute_batch(&schema())?;
    c.execute_batch(
        "INSERT INTO messages (
           account_id, gmail_id, thread_id, message_id_hdr, in_reply_to, refs,
           from_name, from_addr, to_json, cc_json, reply_to_json,
           subject, date, snippet, body_text, body_html,
           folder, seen, flagged, answered, category, important, state
         )
         SELECT
           account_id, gmail_id, thread_id,
           CASE WHEN id = (
             SELECT MIN(id) FROM messages_v1 m2
             WHERE m2.account_id = m1.account_id AND m2.message_id_hdr = m1.message_id_hdr
           ) THEN message_id_hdr ELSE NULL END,
           in_reply_to, refs,
           from_name, from_addr, to_json, cc_json, reply_to_json,
           subject, date, snippet, body_text, body_html,
           folder, seen, flagged, answered, category, important, 'synced'
         FROM messages_v1 m1;
         DROP TABLE messages_v1;",
    )?;
    Ok(())
}

fn migrate_v3(c: &Connection) -> Result<()> {
    if !has_table(c, "messages")? {
        return Ok(());
    }
    let cols = column_names(c, "messages")?;
    if !cols.iter().any(|c| c == "body_codec") {
        c.execute_batch("ALTER TABLE messages ADD COLUMN body_codec TEXT NOT NULL DEFAULT 'none'")?;
    }
    if !cols.iter().any(|c| c == "body_state") {
        c.execute_batch("ALTER TABLE messages ADD COLUMN body_state TEXT NOT NULL DEFAULT 'full'")?;
    }
    c.execute_batch(FTS_DDL)?;
    c.execute_batch(
        "DELETE FROM messages_fts;
         INSERT INTO messages_fts (rowid, subject, body)
         SELECT id, subject, body_text FROM messages WHERE body_codec = 'none';",
    )?;
    // An older build writing user_version 2 back makes this step re-run over
    // rows the compactor has since compressed; decode those to index them
    let mut stmt =
        c.prepare("SELECT id, subject, body_text, body_codec FROM messages WHERE body_codec != 'none'")?;
    let rows: Vec<(i64, String, Option<StoredBody>, String)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, StoredBody::from_ref(r.get_ref(2)?), r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut insert = c.prepare("INSERT INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)")?;
    for (id, subject, body, codec) in rows {
        let text = decode_body(body.as_ref(), &codec)?.unwrap_or_default();
        insert.execute(params![id, subject, text])?;
    }
    Ok(())
}

fn migrate_v4(c: &Connection) -> Result<()> {
    if !has_table(c, "messages")? {
        return Ok(());
    }
    if !column_names(c, "messages")?.iter().any(|c| c == "thread_key") {
        c.execute_batch(
            "ALTER TABLE messages ADD COLUMN thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, message_id_hdr)) VIRTUAL",
        )?;
    }
    Ok(())
}

fn run_migration(v: i64, c: &Connection) -> Result<()> {
    match v {
        2 => migrate_v2(c),
        3 => migrate_v3(c),
        4 => migrate_v4(c),
        _ => Ok(()),
    }
}

fn pragma_i64(c: &Connection, name: &str) -> Result<i64> {
    Ok(c.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))?)
}

fn mb(bytes: i64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}

/// Reclaim free pages: always after a migration, otherwise when a quarter
/// of the file (and at least 8 MB) is free. Runs before any reader exists.
fn maybe_vacuum(c: &Connection, after_migration: bool) -> Result<()> {
    let page_size = pragma_i64(c, "page_size")?;
    let before = pragma_i64(c, "page_count")? * page_size;
    let free = pragma_i64(c, "freelist_count")? * page_size;
    let worth_it =
        free >= VACUUM_FREE_MIN_BYTES && free as f64 / (before.max(1) as f64) >= VACUUM_FREE_FRACTION;
    if !after_migration && !worth_it {
        return Ok(());
    }
    if free == 0 {
        log::info!("[db] vacuum skipped: no free pages");
        return Ok(());
    }
    let started = Instant::now();
    c.execute_batch("VACUUM")?;
    let after = pragma_i64(c, "page_count")? * page_size;
    log::info!(
        "[db] vacuum: {} MB ({} MB free) → {} MB in {} ms",
        mb(before),
        mb(free),
        mb(after),
        started.elapsed().as_millis()
    );
    Ok(())
}

fn configure(c: &Connection) -> Result<()> {
    c.busy_timeout(BUSY_TIMEOUT)?;
    c.execute_batch("PRAGMA foreign_keys = ON")?;
    Ok(())
}

/// The store: one writer, pooled readers, the clock, and the token sealer
pub struct Db {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) secrets: Arc<dyn SecretBox>,
}

impl Db {
    /// Open (or create) the store and bring it to the current schema
    pub fn open(path: &Path, clock: Arc<dyn Clock>, secrets: Arc<dyn SecretBox>) -> Result<Db> {
        let mut c = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        configure(&c)?;
        let _: String = c.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        // Big write bursts (migrations, the compactor) grow the WAL; this
        // truncates it back after each checkpoint
        let _: i64 = c.query_row("PRAGMA journal_size_limit = 67108864", [], |r| r.get(0))?;
        let version: String = c.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
        assert_sqlite_version(&version)?;
        let current = pragma_i64(&c, "user_version")?;
        // v1 never set user_version, so "existing store" is judged by its tables
        let upgrading = current < SCHEMA_VERSION && has_table(&c, "messages")?;
        let started = Instant::now();
        {
            let tx = c.transaction()?;
            for v in current + 1..=SCHEMA_VERSION {
                run_migration(v, &tx)?;
            }
            tx.execute_batch(&schema())?;
            // Never lower the marker: a newer build's store must not look old
            if current < SCHEMA_VERSION {
                tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
            }
            tx.commit()?;
        }
        if upgrading {
            log::info!(
                "[db] migrated v{current} → v{SCHEMA_VERSION} in {} ms",
                started.elapsed().as_millis()
            );
        }
        maybe_vacuum(&c, upgrading)?;
        Ok(Db {
            path: path.to_path_buf(),
            writer: Mutex::new(c),
            readers: Mutex::new(Vec::new()),
            clock,
            secrets,
        })
    }

    pub(crate) fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        self.writer.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Run `f` on the writer connection (no transaction; callers open one when needed)
    pub(crate) fn write<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut c = self.writer();
        f(&mut c)
    }

    /// Run `f` in one write transaction
    pub(crate) fn write_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut c = self.writer();
        let tx = c.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    fn open_reader(&self) -> Result<Connection> {
        let c = Connection::open(&self.path)?;
        configure(&c)?;
        c.execute_batch("PRAGMA query_only = 1")?;
        Ok(c)
    }

    /// Run `f` on a read connection: never waits for the writer's lock
    pub(crate) fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let pooled = self.readers.lock().unwrap_or_else(|e| e.into_inner()).pop();
        let c = match pooled {
            Some(c) => c,
            None => self.open_reader()?,
        };
        let out = f(&c);
        let mut pool = self.readers.lock().unwrap_or_else(|e| e.into_inner());
        if pool.len() < MAX_IDLE_READERS {
            pool.push(c);
        }
        out
    }

    // ---------- config ----------

    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        self.read(|c| {
            Ok(c.query_row("SELECT value FROM config WHERE key = ?", [key], |r| r.get(0)).optional()?)
        })
    }

    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        self.write(|c| {
            c.execute(
                "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
    }

    /// User-facing settings (the `setting:` slice of config, prefix stripped)
    pub fn get_settings(&self) -> Result<HashMap<String, String>> {
        self.read(|c| {
            let mut stmt = c.prepare("SELECT key, value FROM config WHERE key LIKE ?")?;
            let rows = stmt
                .query_map([format!("{SETTINGS_PREFIX}%")], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<(String, String)>>>()?;
            Ok(rows
                .into_iter()
                .map(|(k, v)| (k[SETTINGS_PREFIX.len()..].to_string(), v))
                .collect())
        })
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.set_config(&format!("{SETTINGS_PREFIX}{key}"), value)
    }

    // ---------- accounts ----------

    pub fn create_account(&self, id: &str, email: &str, name: &str, color: &str) -> Result<()> {
        let now = self.now();
        self.write(|c| {
            c.execute(
                "INSERT INTO accounts (id, email, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
                params![id, email, name, color, now],
            )?;
            Ok(())
        })
    }

    pub fn list_accounts(&self) -> Result<Vec<WireAccount>> {
        self.read(|c| {
            let mut stmt = c.prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts ORDER BY created_at"))?;
            let rows = stmt.query_map([], account_row)?.collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })
    }

    pub fn get_account(&self, id: &str) -> Result<Option<WireAccount>> {
        self.read(|c| {
            Ok(c.query_row(&format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE id = ?"), [id], account_row)
                .optional()?)
        })
    }

    pub fn get_account_by_email(&self, email: &str) -> Result<Option<WireAccount>> {
        self.read(|c| {
            Ok(c.query_row(&format!("SELECT {ACCOUNT_COLS} FROM accounts WHERE email = ?"), [email], account_row)
                .optional()?)
        })
    }

    pub fn delete_account(&self, id: &str) -> Result<()> {
        self.write_tx(|tx| {
            // The FTS index is not a real table, so the cascade does not reach it
            tx.execute(
                "DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)",
                [id],
            )?;
            tx.execute("DELETE FROM accounts WHERE id = ?", [id])?;
            Ok(())
        })
    }

    /// Stored sealed the way Electron's safeStorage does (`enc:` / `plain:`)
    pub fn save_refresh_token(&self, account_id: &str, token: &str) -> Result<()> {
        let stored = self.secrets.seal(token);
        self.write(|c| {
            c.execute("UPDATE accounts SET refresh_token = ? WHERE id = ?", params![stored, account_id])?;
            Ok(())
        })
    }

    pub fn get_refresh_token(&self, account_id: &str) -> Result<Option<String>> {
        let stored: Option<String> = self.read(|c| {
            Ok(c.query_row("SELECT refresh_token FROM accounts WHERE id = ?", [account_id], |r| r.get(0))
                .optional()?
                .flatten())
        })?;
        match stored.filter(|s| !s.is_empty()) {
            Some(s) => Ok(Some(self.secrets.unseal(&s)?)),
            None => Ok(None),
        }
    }

    pub fn get_history_id(&self, account_id: &str) -> Result<Option<String>> {
        self.read(|c| {
            Ok(c.query_row("SELECT history_id FROM accounts WHERE id = ?", [account_id], |r| r.get(0))
                .optional()?
                .flatten())
        })
    }

    pub fn set_history_id(&self, account_id: &str, history_id: &str) -> Result<()> {
        self.write(|c| {
            c.execute("UPDATE accounts SET history_id = ? WHERE id = ?", params![history_id, account_id])?;
            Ok(())
        })
    }

    pub fn get_backfill_state(&self, account_id: &str) -> Result<Option<BackfillState>> {
        self.read(|c| {
            Ok(c.query_row(
                "SELECT backfill_page_token, backfill_done FROM accounts WHERE id = ?",
                [account_id],
                |r| Ok(BackfillState { page_token: r.get(0)?, done: r.get::<_, i64>(1)? == 1 }),
            )
            .optional()?)
        })
    }

    pub fn set_backfill_state(&self, account_id: &str, page_token: Option<&str>, done: bool) -> Result<()> {
        self.write(|c| {
            c.execute(
                "UPDATE accounts SET backfill_page_token = ?, backfill_done = ? WHERE id = ?",
                params![page_token, done as i64, account_id],
            )?;
            Ok(())
        })
    }
}

const SETTINGS_PREFIX: &str = "setting:";

const ACCOUNT_COLS: &str = "id, email, name, color, backfill_done";

fn account_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WireAccount> {
    Ok(WireAccount {
        id: r.get(0)?,
        email: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        backfill_done: r.get::<_, i64>(4)? == 1,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackfillState {
    pub page_token: Option<String>,
    pub done: bool,
}
