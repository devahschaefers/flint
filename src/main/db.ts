import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'
import { join } from 'path'
import {
  DEFAULT_CODEC,
  decodeBody,
  encodeBody,
  storedSize,
  type BodyCodec,
  type StoredBody
} from './storage/bodies'
import { bestPlainText } from './storage/htmlToText'
import { buildMatchExpression } from './storage/search'
import type {
  Folder,
  LocalMessageInput,
  MessageState,
  OpKind,
  WireAccount,
  WireMessage,
  WireOp
} from '../preload/index.d'

/**
 * Local mail store. SQLite in the main process is the source of truth for
 * everything the app knows — synced mail, locally-authored mail (drafts,
 * queued/failed sends), the outbox of operations still owed to
 * Gmail, and user settings. The renderer is a view over it; Gmail is the
 * remote source of truth the sync engine reconciles against.
 * Dates are unix ms (cheap index comparisons).
 *
 * Bodies. `body_text` and `body_html` hold either plain TEXT or a BLOB the
 * codec named in `body_codec` produced (see storage/bodies.ts): rows written
 * before v3 are TEXT under 'none', new rows are zstd BLOBs, and the
 * background compactor converts the former to the latter a batch at a time.
 * `body_state` says whether the bodies are there at all: 'full' rows hold
 * whatever the sender sent (possibly nothing), 'missing' rows came from a
 * metadata-only fetch and still owe a body fetch. Every read path decodes and
 * every write path encodes, so nothing outside this file sees a BLOB.
 *
 * Search. `messages_fts` is a contentless FTS5 index (rowid = messages.id)
 * over subject and plain-text body. SQLite triggers cannot run the body
 * decoder, so the index is maintained explicitly by every function here that
 * inserts, rewrites, or deletes a message row.
 */

const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, body,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);`

const SCHEMA = `
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
${FTS_DDL}
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
`

/**
 * Schema versions (PRAGMA user_version). Each migration upgrades from the
 * previous version; the CREATE ... IF NOT EXISTS block above describes the
 * current shape for fresh databases.
 */
const SCHEMA_VERSION = 4

/** Contentless-delete FTS5 tables need this SQLite or newer */
const MIN_SQLITE = [3, 43, 0]

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

/** Column names including generated (hidden) ones */
function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[]).map((c) => c.name)
}

/** Throws when the linked SQLite is too old for the schema */
export function assertSqliteVersion(version: string): void {
  const parts = version.split('.').map((p) => Number(p) || 0)
  for (let i = 0; i < MIN_SQLITE.length; i++) {
    const have = parts[i] ?? 0
    if (have > MIN_SQLITE[i]) return
    if (have < MIN_SQLITE[i]) {
      throw new Error(
        `SQLite ${MIN_SQLITE.join('.')} or newer is required (FTS5 contentless_delete); ` +
          `better-sqlite3 linked ${version}`
      )
    }
  }
}

const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  // v1 → v2: messages gain local-only rows (nullable gmail_id, message_id_hdr
  // as the local key) plus lifecycle columns. SQLite can't drop NOT NULL, so
  // the table is rebuilt in place.
  2: (db) => {
    const hasMessages = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get()
    if (!hasMessages) return
    const cols = (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(
      (c) => c.name
    )
    if (cols.includes('state')) return
    db.exec(`
      ALTER TABLE messages RENAME TO messages_v1;
      DROP INDEX IF EXISTS idx_messages_list;
      DROP INDEX IF EXISTS idx_messages_date;
      DROP INDEX IF EXISTS idx_messages_thread;
      CREATE INDEX idx_v1_hdr ON messages_v1(account_id, message_id_hdr, id);
    `)
    db.exec(SCHEMA)
    // Synced Gmail mail can carry duplicate Message-ID headers (the same
    // message in two accounts is fine, but Gmail also occasionally exposes
    // the same header twice within one account); keep the first, drop the
    // header on later copies so the new UNIQUE holds.
    db.exec(`
      INSERT INTO messages (
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
      DROP TABLE messages_v1;
    `)
  },
  // v2 → v3: body codec + body state columns, and the full-text index built
  // over every existing row. Existing bodies stay plain TEXT ('none'); the
  // background compactor compresses them later so this migration stays short.
  3: (db) => {
    if (!hasTable(db, 'messages')) return
    const cols = columnNames(db, 'messages')
    if (!cols.includes('body_codec')) {
      db.exec("ALTER TABLE messages ADD COLUMN body_codec TEXT NOT NULL DEFAULT 'none'")
    }
    if (!cols.includes('body_state')) {
      db.exec("ALTER TABLE messages ADD COLUMN body_state TEXT NOT NULL DEFAULT 'full'")
    }
    // A v1 store arriving here has already had SCHEMA (and so an empty index)
    // applied by the v2 step; (re)building from scratch covers both paths.
    // Every pre-v3 body is TEXT, so the index can be built in SQL.
    db.exec(FTS_DDL)
    db.exec(`
      DELETE FROM messages_fts;
      INSERT INTO messages_fts (rowid, subject, body)
      SELECT id, subject, body_text FROM messages WHERE body_codec = 'none';
    `)
    // Normally nothing is left. But an older build opening this store writes
    // user_version 2 back, which makes this step run again over rows the
    // compactor has since compressed; those have to be decoded to be indexed.
    const compressed = db
      .prepare("SELECT id, subject, body_text, body_codec FROM messages WHERE body_codec != 'none'")
      .all() as { id: number; subject: string; body_text: StoredBody; body_codec: BodyCodec }[]
    const insert = db.prepare('INSERT INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)')
    for (const r of compressed) {
      insert.run(r.id, r.subject, decodeBody(r.body_text, r.body_codec) ?? '')
    }
  },
  // v3 → v4: the conversation key every list groups by, as a virtual generated
  // column (Gmail's thread id, else the Message-ID for local mail), indexed
  // with the date so thread aggregates and paging read one index range.
  4: (db) => {
    if (!hasTable(db, 'messages')) return
    if (!columnNames(db, 'messages').includes('thread_key')) {
      db.exec(
        'ALTER TABLE messages ADD COLUMN thread_key TEXT GENERATED ALWAYS AS (COALESCE(thread_id, message_id_hdr)) VIRTUAL'
      )
    }
  }
}

let db: Database.Database

/** Open (or create) the store and bring it to the current schema. `path` is a test seam. */
export function initDb(path: string = join(app.getPath('userData'), 'mail.db')): void {
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  // Big write bursts (migrations, the body compactor) grow the WAL to their
  // size; this truncates it back after each checkpoint instead of at close
  db.pragma('journal_size_limit = 67108864')
  db.pragma('foreign_keys = ON')
  assertSqliteVersion((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v)
  const version = db.pragma('user_version', { simple: true }) as number
  // v1 never set user_version, so "existing store" is judged by its tables
  const upgrading = version < SCHEMA_VERSION && hasTable(db, 'messages')
  const started = Date.now()
  db.transaction(() => {
    for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
      MIGRATIONS[v]?.(db)
    }
    db.exec(SCHEMA)
    // Never lower the marker: a store a newer build has migrated must not be
    // made to look old, or that build would run its migration again
    if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })()
  if (upgrading) {
    console.log(`[db] migrated v${version} → v${SCHEMA_VERSION} in ${Date.now() - started} ms`)
  }
  maybeVacuum(upgrading)
}

/** Free-page share of the file above which it is rewritten at startup */
const VACUUM_FREE_FRACTION = 0.25
/** ...as long as there is at least this much to reclaim */
const VACUUM_FREE_MIN_BYTES = 8 * 1024 * 1024

/**
 * Reclaim free pages. Table rebuilds (the v2 migration) and the body
 * compactor rewriting every row leave the old copies on the freelist, so the
 * file stays far larger than its live data until this runs. VACUUM must run
 * outside a transaction and blocks for a few seconds per GB, so it happens
 * here, before any window is shown: always after a migration, otherwise when
 * a quarter of the file is free.
 */
function maybeVacuum(afterMigration: boolean): void {
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const before = (db.pragma('page_count', { simple: true }) as number) * pageSize
  const free = (db.pragma('freelist_count', { simple: true }) as number) * pageSize
  const worthIt =
    free >= VACUUM_FREE_MIN_BYTES && free / Math.max(before, 1) >= VACUUM_FREE_FRACTION
  if (!afterMigration && !worthIt) return
  if (free === 0) {
    console.log('[db] vacuum skipped: no free pages')
    return
  }
  const started = Date.now()
  db.exec('VACUUM')
  const after = (db.pragma('page_count', { simple: true }) as number) * pageSize
  console.log(
    `[db] vacuum: ${mb(before)} MB (${mb(free)} MB free) → ${mb(after)} MB in ${Date.now() - started} ms`
  )
}

function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

/** The open connection, for query modules that live outside this file */
export function connection(): Database.Database {
  return db
}

export function closeDb(): void {
  db?.close()
}

// ---------- config ----------

export function getConfig(key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setConfig(key: string, value: string): void {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

/** User-facing settings (a namespaced slice of config) */
const SETTINGS_PREFIX = 'setting:'

export function getSettings(): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM config WHERE key LIKE ?')
    .all(`${SETTINGS_PREFIX}%`) as { key: string; value: string }[]
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key.slice(SETTINGS_PREFIX.length)] = r.value
  return out
}

export function setSetting(key: string, value: string): void {
  setConfig(SETTINGS_PREFIX + key, value)
}

// ---------- accounts ----------

interface AccountRow {
  id: string
  email: string
  name: string
  color: string
  refresh_token: string | null
  history_id: string | null
  backfill_page_token: string | null
  backfill_done: number
}

function toWireAccount(row: AccountRow): WireAccount {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    color: row.color,
    backfillDone: row.backfill_done === 1
  }
}

export function createAccount(a: { id: string; email: string; name: string; color: string }): void {
  db.prepare(
    'INSERT INTO accounts (id, email, name, color, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(a.id, a.email, a.name, a.color, Date.now())
}

export function listAccounts(): WireAccount[] {
  return (db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as AccountRow[]).map(
    toWireAccount
  )
}

export function getAccount(id: string): WireAccount | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  return row ? toWireAccount(row) : null
}

export function getAccountByEmail(email: string): WireAccount | null {
  const row = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as
    AccountRow | undefined
  return row ? toWireAccount(row) : null
}

export function deleteAccount(id: string): void {
  db.transaction(() => {
    // The FTS index is not a real table, so the cascade below does not reach it
    db.prepare(
      'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)'
    ).run(id)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  })()
}

/** Refresh tokens are stored encrypted via the OS keychain (safeStorage) when available */
export function saveRefreshToken(accountId: string, token: string): void {
  const stored = safeStorage.isEncryptionAvailable()
    ? `enc:${safeStorage.encryptString(token).toString('base64')}`
    : `plain:${token}`
  db.prepare('UPDATE accounts SET refresh_token = ? WHERE id = ?').run(stored, accountId)
}

export function getRefreshToken(accountId: string): string | null {
  const row = db.prepare('SELECT refresh_token FROM accounts WHERE id = ?').get(accountId) as
    { refresh_token: string | null } | undefined
  const stored = row?.refresh_token
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  return stored.replace(/^plain:/, '')
}

export function getHistoryId(accountId: string): string | null {
  const row = db.prepare('SELECT history_id FROM accounts WHERE id = ?').get(accountId) as
    { history_id: string | null } | undefined
  return row?.history_id ?? null
}

export function setHistoryId(accountId: string, historyId: string): void {
  db.prepare('UPDATE accounts SET history_id = ? WHERE id = ?').run(historyId, accountId)
}

export function getBackfillState(
  accountId: string
): { pageToken: string | null; done: boolean } | null {
  const row = db
    .prepare('SELECT backfill_page_token, backfill_done FROM accounts WHERE id = ?')
    .get(accountId) as { backfill_page_token: string | null; backfill_done: number } | undefined
  return row ? { pageToken: row.backfill_page_token, done: row.backfill_done === 1 } : null
}

export function setBackfillState(accountId: string, pageToken: string | null, done: boolean): void {
  db.prepare('UPDATE accounts SET backfill_page_token = ?, backfill_done = ? WHERE id = ?').run(
    pageToken,
    done ? 1 : 0,
    accountId
  )
}

// ---------- synced messages ----------

/** 'missing': metadata-only row whose bodies are still to be fetched */
export type BodyState = 'full' | 'missing'

/** Column-shaped message record (what the sync engine writes) */
export interface MsgRecord {
  accountId: string
  gmailId: string
  threadId: string
  messageIdHdr: string | null
  inReplyTo: string | null
  references: string[]
  fromName: string | null
  fromAddr: string
  to: { name?: string; address: string }[]
  cc: { name?: string; address: string }[]
  replyTo: { name?: string; address: string } | null
  subject: string
  dateMs: number
  snippet: string
  bodyText: string
  bodyHtml: string | null
  /** Defaults to 'full' */
  bodyState?: BodyState
  folder: Folder
  seen: boolean
  flagged: boolean
  category: string
  important: boolean
}

/**
 * Sync writes. A message we authored locally (state queued/sent/draft) already
 * has its row keyed by Message-ID header; when Gmail hands the same message
 * back we adopt its ids/labels onto that row rather than inserting a twin.
 * Conflicts on gmail_id (already-known synced mail) refresh label state, and
 * fill in the bodies when the row was metadata-only and the record is full.
 */
const UPSERT_SQL = `
INSERT INTO messages (
  account_id, gmail_id, thread_id, message_id_hdr, in_reply_to, refs,
  from_name, from_addr, to_json, cc_json, reply_to_json,
  subject, date, snippet, body_text, body_html, body_codec, body_state,
  folder, seen, flagged, category, important, state
) VALUES (
  @accountId, @gmailId, @threadId, @messageIdHdr, @inReplyTo, @refs,
  @fromName, @fromAddr, @toJson, @ccJson, @replyToJson,
  @subject, @dateMs, @snippet, @bodyText, @bodyHtml, @bodyCodec, @bodyState,
  @folder, @seen, @flagged, @category, @important, 'synced'
)
ON CONFLICT(account_id, gmail_id) DO UPDATE SET
  folder = excluded.folder,
  seen = excluded.seen,
  flagged = excluded.flagged,
  category = excluded.category,
  important = excluded.important,
  snippet = CASE WHEN messages.snippet = '' THEN excluded.snippet ELSE messages.snippet END,
  state = CASE WHEN messages.state IN ('sent', 'synced') THEN 'synced' ELSE messages.state END,
  body_text = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN excluded.body_text ELSE messages.body_text END,
  body_html = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN excluded.body_html ELSE messages.body_html END,
  body_codec = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN excluded.body_codec ELSE messages.body_codec END,
  body_state = CASE WHEN messages.body_state = 'missing' AND excluded.body_state = 'full'
    THEN 'full' ELSE messages.body_state END
ON CONFLICT(account_id, message_id_hdr) DO UPDATE SET
  gmail_id = excluded.gmail_id,
  thread_id = excluded.thread_id,
  folder = excluded.folder,
  seen = excluded.seen,
  flagged = excluded.flagged,
  category = excluded.category,
  important = excluded.important,
  snippet = excluded.snippet,
  date = excluded.date,
  state = CASE
    WHEN excluded.folder = 'drafts' THEN messages.state
    ELSE 'synced'
  END,
  send_after = CASE WHEN excluded.folder = 'drafts' THEN messages.send_after ELSE NULL END,
  send_error = CASE WHEN excluded.folder = 'drafts' THEN messages.send_error ELSE NULL END
RETURNING id
`

function toParams(r: MsgRecord): Record<string, unknown> {
  const bodyState: BodyState = r.bodyState ?? 'full'
  return {
    bodyCodec: DEFAULT_CODEC,
    bodyState,
    accountId: r.accountId,
    gmailId: r.gmailId,
    threadId: r.threadId,
    messageIdHdr: r.messageIdHdr,
    inReplyTo: r.inReplyTo,
    refs: JSON.stringify(r.references),
    fromName: r.fromName,
    fromAddr: r.fromAddr,
    toJson: JSON.stringify(r.to),
    ccJson: JSON.stringify(r.cc),
    replyToJson: r.replyTo ? JSON.stringify(r.replyTo) : null,
    subject: r.subject,
    dateMs: r.dateMs,
    snippet: r.snippet,
    bodyText: encodeBody(bodyState === 'missing' ? '' : r.bodyText),
    bodyHtml: encodeBody(bodyState === 'missing' ? null : r.bodyHtml),
    folder: r.folder,
    seen: r.seen ? 1 : 0,
    flagged: r.flagged ? 1 : 0,
    category: r.category,
    important: r.important ? 1 : 0
  }
}

export function upsertMessages(records: MsgRecord[]): void {
  const stmt = db.prepare(UPSERT_SQL)
  const existing = db.prepare(
    'SELECT id, body_state FROM messages WHERE account_id = ? AND gmail_id = ?'
  )
  db.transaction(() => {
    for (const r of records) {
      const before = existing.get(r.accountId, r.gmailId) as
        { id: number; body_state: BodyState } | undefined
      let row: { id: number }
      try {
        row = stmt.get(toParams(r)) as { id: number }
      } catch (err) {
        // A synced message whose Message-ID collides with a *different* local
        // row (Gmail reuses headers across draft revisions): store it without
        // the header rather than losing it.
        if ((err as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err
        row = stmt.get({ ...toParams(r), messageIdHdr: null }) as { id: number }
      }
      // Searchable content changes only for new rows (or adopted local ones)
      // and when a metadata-only row gets its bodies; label refreshes don't touch it
      const filled = before?.body_state === 'missing' && (r.bodyState ?? 'full') === 'full'
      if (!before || filled) indexRow(row.id)
    }
  })()
}

export function deleteMessage(accountId: string, gmailId: string): void {
  db.transaction(() => {
    const row = db
      .prepare('SELECT id FROM messages WHERE account_id = ? AND gmail_id = ?')
      .get(accountId, gmailId) as { id: number } | undefined
    if (!row) return
    unindexRow(row.id)
    db.prepare('DELETE FROM messages WHERE id = ?').run(row.id)
  })()
}

// ---------- full-text index ----------

/** (Re)index one row from what is stored: subject + decoded plain-text body */
function indexRow(id: number): void {
  const row = db
    .prepare('SELECT subject, body_text, body_codec FROM messages WHERE id = ?')
    .get(id) as { subject: string; body_text: StoredBody; body_codec: BodyCodec } | undefined
  if (!row) return
  const body = decodeBody(row.body_text, row.body_codec) ?? ''
  db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id)
  db.prepare('INSERT INTO messages_fts (rowid, subject, body) VALUES (?, ?, ?)').run(
    id,
    row.subject,
    body
  )
}

function unindexRow(id: number): void {
  db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id)
}

export interface SearchHit {
  /** messages.id (the FTS rowid) */
  messageId: number
  threadId: string | null
  accountId: string
  /** bm25 score: lower is better; results come back best first */
  rank: number
}

/**
 * Full-text search over subject + body, best match first (bm25, subject
 * weighted 5× body). Raw user text goes through the query builder, so FTS
 * syntax in the input is searched for, never interpreted; an input with no
 * searchable word yields no hits.
 */
export function searchMessages(
  query: string,
  opts: { accountId?: string; limit?: number } = {}
): SearchHit[] {
  const match = buildMatchExpression(query)
  if (!match) return []
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 10_000))
  try {
    return db
      .prepare(
        `SELECT messages_fts.rowid AS messageId, m.thread_id AS threadId, m.account_id AS accountId,
                bm25(messages_fts, 5.0, 1.0) AS rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         WHERE messages_fts MATCH @match AND (@accountId IS NULL OR m.account_id = @accountId)
         ORDER BY rank
         LIMIT @limit`
      )
      .all({ match, accountId: opts.accountId ?? null, limit }) as SearchHit[]
  } catch (err) {
    // The builder should make this unreachable; a bad expression is not the user's problem
    console.warn(`[db] search failed for ${JSON.stringify(query)}: ${(err as Error).message}`)
    return []
  }
}

/** Rows in the index (test/diagnostic aid) */
export function countIndexed(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get() as { n: number }
  return row.n
}

// ---------- body compaction (see storage/compactor.ts) ----------

export interface CompactBatch {
  /** Rows rewritten in this batch */
  processed: number
  /** Rows that still need compacting after this batch */
  remaining: number
  bytesBefore: number
  bytesAfter: number
  /** Rows whose empty text body was derived from their HTML on the way */
  textDerived: number
}

/** Codecs the compactor upgrades from (anything not the current default) */
const STALE_CODECS: BodyCodec[] = ['none']

export function countUncompacted(): number {
  const marks = STALE_CODECS.map(() => '?').join(', ')
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE body_codec IN (${marks})`)
    .get(...STALE_CODECS) as { n: number }
  return row.n
}

/**
 * Re-encode up to `limit` rows written with a stale codec into the current
 * one, lowest id first. A row whose text body is empty but has HTML also
 * gets its text derived (the same rule new mail goes through), so search
 * covers it. Idempotent: a row already on the default codec is never
 * selected. One transaction per batch.
 */
export function compactBodiesBatch(limit: number): CompactBatch {
  const marks = STALE_CODECS.map(() => '?').join(', ')
  const select = db.prepare(
    `SELECT id, body_text, body_html, body_codec FROM messages
     WHERE body_codec IN (${marks}) ORDER BY id LIMIT ?`
  )
  const update = db.prepare(
    'UPDATE messages SET body_text = ?, body_html = ?, body_codec = ? WHERE id = ?'
  )
  const result: CompactBatch = {
    processed: 0,
    remaining: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    textDerived: 0
  }
  db.transaction(() => {
    const rows = select.all(...STALE_CODECS, limit) as {
      id: number
      body_text: StoredBody
      body_html: StoredBody
      body_codec: BodyCodec
    }[]
    for (const row of rows) {
      const text = decodeBody(row.body_text, row.body_codec) ?? ''
      const html = decodeBody(row.body_html, row.body_codec)
      const bestText = bestPlainText(text, html)
      const encText = encodeBody(bestText)
      const encHtml = encodeBody(html)
      update.run(encText, encHtml, DEFAULT_CODEC, row.id)
      result.processed++
      result.bytesBefore += storedSize(row.body_text) + storedSize(row.body_html)
      result.bytesAfter += storedSize(encText) + storedSize(encHtml)
      if (bestText !== text) {
        result.textDerived++
        indexRow(row.id)
      }
    }
    result.remaining = countUncompacted()
  })()
  return result
}

// ---------- missing bodies (metadata-first backfill) ----------

export function countMissingBodies(accountId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND body_state = 'missing'")
    .get(accountId) as { n: number }
  return row.n
}

/** Gmail ids of metadata-only rows, newest first (what phase-2 backfill fetches next) */
export function listMissingBodyIds(accountId: string, limit: number): string[] {
  return (
    db
      .prepare(
        `SELECT gmail_id FROM messages
         WHERE account_id = ? AND body_state = 'missing' AND gmail_id IS NOT NULL
         ORDER BY date DESC LIMIT ?`
      )
      .all(accountId, limit) as { gmail_id: string }[]
  ).map((r) => r.gmail_id)
}

/** Gmail ids of metadata-only rows in one conversation (fetched on open) */
export function listMissingBodyIdsInThread(accountId: string, threadKey: string): string[] {
  return (
    db
      .prepare(
        `SELECT gmail_id FROM messages
         WHERE account_id = ? AND thread_key = ? AND body_state = 'missing' AND gmail_id IS NOT NULL`
      )
      .all(accountId, threadKey) as { gmail_id: string }[]
  ).map((r) => r.gmail_id)
}

/** Apply a label-state change from history sync (folder + flags only) */
export function updateMessageState(
  accountId: string,
  gmailId: string,
  state: { folder: Folder; seen: boolean; flagged: boolean; important: boolean }
): void {
  db.prepare(
    'UPDATE messages SET folder = ?, seen = ?, flagged = ?, important = ? WHERE account_id = ? AND gmail_id = ?'
  ).run(
    state.folder,
    state.seen ? 1 : 0,
    state.flagged ? 1 : 0,
    state.important ? 1 : 0,
    accountId,
    gmailId
  )
}

export function hasMessage(accountId: string, gmailId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM messages WHERE account_id = ? AND gmail_id = ?')
    .get(accountId, gmailId)
}

/** Every Gmail id we hold for an account (reconciliation input) */
export function listGmailIds(accountId: string): string[] {
  return (
    db
      .prepare(
        "SELECT gmail_id FROM messages WHERE account_id = ? AND gmail_id IS NOT NULL AND state = 'synced'"
      )
      .all(accountId) as { gmail_id: string }[]
  ).map((r) => r.gmail_id)
}

/** Label-derived state for every synced message (reconciliation input) */
export function listLabelState(
  accountId: string
): { gmailId: string; folder: Folder; seen: boolean; flagged: boolean; important: boolean }[] {
  return (
    db
      .prepare(
        "SELECT gmail_id, folder, seen, flagged, important FROM messages WHERE account_id = ? AND gmail_id IS NOT NULL AND state = 'synced'"
      )
      .all(accountId) as {
      gmail_id: string
      folder: Folder
      seen: number
      flagged: number
      important: number
    }[]
  ).map((r) => ({
    gmailId: r.gmail_id,
    folder: r.folder,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    important: r.important === 1
  }))
}

interface MessageRow {
  account_id: string
  gmail_id: string | null
  gmail_draft_id: string | null
  thread_id: string | null
  thread_key: string | null
  message_id_hdr: string | null
  in_reply_to: string | null
  refs: string
  from_name: string | null
  from_addr: string
  to_json: string
  cc_json: string
  reply_to_json: string | null
  subject: string
  date: number
  snippet: string
  body_text: StoredBody
  body_html: StoredBody
  body_codec: BodyCodec
  body_state: BodyState
  folder: Folder
  seen: number
  flagged: number
  answered: number
  category: string
  important: number
  state: MessageState
  send_after: number | null
  send_error: string | null
}

function rowToWire(row: MessageRow): WireMessage {
  return {
    accountId: row.account_id,
    gmailId: row.gmail_id,
    threadId: row.thread_id,
    threadKey: row.thread_key ?? row.message_id_hdr ?? `row:${row.gmail_id}`,
    messageIdHdr: row.message_id_hdr,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.refs),
    from: { name: row.from_name ?? undefined, address: row.from_addr },
    to: JSON.parse(row.to_json),
    cc: JSON.parse(row.cc_json),
    replyTo: row.reply_to_json ? JSON.parse(row.reply_to_json) : null,
    subject: row.subject,
    dateMs: row.date,
    snippet: row.snippet,
    bodyText: decodeBody(row.body_text, row.body_codec) ?? '',
    bodyHtml: decodeBody(row.body_html, row.body_codec),
    folder: row.folder,
    seen: row.seen === 1,
    flagged: row.flagged === 1,
    answered: row.answered === 1,
    category: row.category,
    important: row.important === 1,
    state: row.state,
    sendAfterMs: row.send_after,
    sendError: row.send_error
  }
}

/**
 * The renderer's hydration window: per account, the newest `perAccount`
 * messages plus everything flagged, drafted, or still leaving the machine
 * (those must never fall out of view regardless of age). Full paged queries
 * replace this later.
 */
export function queryWindow(perAccount: number): WireMessage[] {
  const latest = db.prepare(
    'SELECT * FROM messages WHERE account_id = ? ORDER BY date DESC LIMIT ?'
  )
  const pinned = db.prepare(
    "SELECT * FROM messages WHERE account_id = ? AND (flagged = 1 OR folder = 'drafts' OR state NOT IN ('synced'))"
  )
  const out: WireMessage[] = []
  for (const account of listAccounts()) {
    const seen = new Set<number>()
    for (const row of [
      ...(latest.all(account.id, perAccount) as (MessageRow & { id: number })[]),
      ...(pinned.all(account.id) as (MessageRow & { id: number })[])
    ]) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      out.push(rowToWire(row))
    }
  }
  return out
}

export function getMessageWire(accountId: string, gmailId: string): WireMessage | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE account_id = ? AND gmail_id = ?')
    .get(accountId, gmailId) as MessageRow | undefined
  return row ? rowToWire(row) : null
}

/** Every message in a conversation, oldest first */
export function queryThread(accountId: string, threadKey: string): WireMessage[] {
  return (
    db
      .prepare('SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY date, id')
      .all(accountId, threadKey) as MessageRow[]
  ).map(rowToWire)
}

/** Drafts, newest first (shown as individual messages, not conversations) */
export function listDraftMessages(accountId: string | null): WireMessage[] {
  return (
    db
      .prepare(
        `SELECT * FROM messages
         WHERE folder = 'drafts' AND (@accountId IS NULL OR account_id = @accountId)
         ORDER BY date DESC LIMIT 500`
      )
      .all({ accountId }) as MessageRow[]
  ).map(rowToWire)
}

/** One message by its Message-ID header */
export function getMessageWireByHdr(accountId: string, messageIdHdr: string): WireMessage | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE account_id = ? AND message_id_hdr = ?')
    .get(accountId, messageIdHdr) as MessageRow | undefined
  return row ? rowToWire(row) : null
}

/** Optimistic local mirror of a Gmail label action (remote writeback follows) */
export function applyLocalAction(
  accountId: string,
  gmailIds: string[],
  action: string,
  value?: boolean
): void {
  const sqlByAction: Record<string, string> = {
    seen: `UPDATE messages SET seen = @v WHERE account_id = @a AND gmail_id = @g`,
    flagged: `UPDATE messages SET flagged = @v WHERE account_id = @a AND gmail_id = @g`,
    archive: `UPDATE messages SET folder = 'archive' WHERE account_id = @a AND gmail_id = @g AND folder = 'inbox'`,
    unarchive: `UPDATE messages SET folder = 'inbox' WHERE account_id = @a AND gmail_id = @g AND folder = 'archive'`,
    trash: `UPDATE messages SET folder = 'trash' WHERE account_id = @a AND gmail_id = @g`,
    spam: `UPDATE messages SET folder = 'spam' WHERE account_id = @a AND gmail_id = @g`,
    inbox: `UPDATE messages SET folder = 'inbox' WHERE account_id = @a AND gmail_id = @g`
  }
  const sql = sqlByAction[action]
  if (!sql) return
  const stmt = db.prepare(sql)
  // better-sqlite3 rejects bind objects with keys the statement doesn't use
  const wantsValue = sql.includes('@v')
  db.transaction(() => {
    for (const g of gmailIds) {
      stmt.run(wantsValue ? { a: accountId, g, v: value ? 1 : 0 } : { a: accountId, g })
    }
  })()
}

export function countMessages(accountId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?')
    .get(accountId) as { n: number }
  return row.n
}

// ---------- locally-authored messages (drafts, outgoing) ----------

/** A local message row: what the outbox needs to build and send it */
export interface LocalMessage {
  accountId: string
  messageIdHdr: string
  gmailId: string | null
  gmailDraftId: string | null
  threadId: string | null
  inReplyTo: string | null
  references: string[]
  to: { name?: string; address: string }[]
  cc: { name?: string; address: string }[]
  subject: string
  bodyText: string
  bodyHtml: string | null
  state: MessageState
  sendAfter: number | null
}

function rowToLocal(row: MessageRow): LocalMessage {
  return {
    accountId: row.account_id,
    messageIdHdr: row.message_id_hdr ?? '',
    gmailId: row.gmail_id,
    gmailDraftId: row.gmail_draft_id,
    threadId: row.thread_id,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.refs),
    to: JSON.parse(row.to_json),
    cc: JSON.parse(row.cc_json),
    subject: row.subject,
    bodyText: decodeBody(row.body_text, row.body_codec) ?? '',
    bodyHtml: decodeBody(row.body_html, row.body_codec),
    state: row.state,
    sendAfter: row.send_after
  }
}

export function getLocalMessage(accountId: string, messageIdHdr: string): LocalMessage | null {
  const row = db
    .prepare('SELECT * FROM messages WHERE account_id = ? AND message_id_hdr = ?')
    .get(accountId, messageIdHdr) as MessageRow | undefined
  return row ? rowToLocal(row) : null
}

/**
 * Insert or replace the content of a locally-authored message. Existing rows
 * (a draft being re-saved, a synced draft being edited, a failed send being
 * retried) keep their Gmail ids; new rows start with none.
 */
export function putLocalMessage(
  input: LocalMessageInput & { messageIdHdr: string },
  from: { name: string; address: string },
  state: MessageState,
  folder: Folder,
  sendAfter: number | null
): void {
  db.transaction(() => {
    const row = db
      .prepare(
        `INSERT INTO messages (
          account_id, thread_id, message_id_hdr, in_reply_to, refs,
          from_name, from_addr, to_json, cc_json,
          subject, date, snippet, body_text, body_html, body_codec, body_state,
          folder, seen, flagged, answered, category, important, state, send_after, send_error
        ) VALUES (
          @accountId, @threadId, @messageIdHdr, @inReplyTo, @refs,
          @fromName, @fromAddr, @toJson, @ccJson,
          @subject, @date, @snippet, @bodyText, @bodyHtml, @bodyCodec, 'full',
          @folder, 1, 0, 0, @category, 0, @state, @sendAfter, NULL
        )
        ON CONFLICT(account_id, message_id_hdr) DO UPDATE SET
          thread_id = COALESCE(messages.thread_id, excluded.thread_id),
          in_reply_to = excluded.in_reply_to,
          refs = excluded.refs,
          from_name = excluded.from_name,
          from_addr = excluded.from_addr,
          to_json = excluded.to_json,
          cc_json = excluded.cc_json,
          subject = excluded.subject,
          date = excluded.date,
          snippet = excluded.snippet,
          body_text = excluded.body_text,
          body_html = excluded.body_html,
          body_codec = excluded.body_codec,
          body_state = 'full',
          folder = excluded.folder,
          category = excluded.category,
          state = excluded.state,
          send_after = excluded.send_after,
          send_error = NULL
        RETURNING id`
      )
      .get({
        accountId: input.accountId,
        threadId: input.threadId ?? null,
        messageIdHdr: input.messageIdHdr,
        inReplyTo: input.inReplyTo ?? null,
        refs: JSON.stringify(input.references),
        fromName: from.name,
        fromAddr: from.address,
        toJson: JSON.stringify(input.to),
        ccJson: JSON.stringify(input.cc),
        subject: input.subject,
        date: Date.now(),
        snippet: input.text.slice(0, 200),
        bodyText: encodeBody(input.text),
        bodyHtml: encodeBody(input.html ?? null),
        bodyCodec: DEFAULT_CODEC,
        folder,
        category: input.category ?? 'people',
        state,
        sendAfter
      }) as { id: number }
    indexRow(row.id)
  })()
}

export function deleteLocalMessage(accountId: string, messageIdHdr: string): void {
  db.transaction(() => {
    const row = db
      .prepare('SELECT id FROM messages WHERE account_id = ? AND message_id_hdr = ?')
      .get(accountId, messageIdHdr) as { id: number } | undefined
    if (!row) return
    unindexRow(row.id)
    db.prepare('DELETE FROM messages WHERE id = ?').run(row.id)
  })()
}

export function setLocalState(
  accountId: string,
  messageIdHdr: string,
  patch: Partial<{
    state: MessageState
    folder: Folder
    sendAfter: number | null
    sendError: string | null
    gmailId: string | null
    gmailDraftId: string | null
    threadId: string | null
  }>
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { a: accountId, h: messageIdHdr }
  const map: Record<string, string> = {
    state: 'state',
    folder: 'folder',
    sendAfter: 'send_after',
    sendError: 'send_error',
    gmailId: 'gmail_id',
    gmailDraftId: 'gmail_draft_id',
    threadId: 'thread_id'
  }
  for (const [key, col] of Object.entries(map)) {
    if (key in patch) {
      sets.push(`${col} = @${key}`)
      params[key] = (patch as Record<string, unknown>)[key]
    }
  }
  if (sets.length === 0) return
  db.prepare(
    `UPDATE messages SET ${sets.join(', ')} WHERE account_id = @a AND message_id_hdr = @h`
  ).run(params)
}

/**
 * \Answered on the parent of one of our replies. Gmail never reports this
 * label, so it is derived from our own outgoing mail and persisted here.
 */
export function setAnswered(
  accountId: string,
  parentMessageIdHdr: string,
  answered: boolean
): void {
  db.prepare('UPDATE messages SET answered = ? WHERE account_id = ? AND message_id_hdr = ?').run(
    answered ? 1 : 0,
    accountId,
    parentMessageIdHdr
  )
}

/** Does any of our outgoing mail (other than `except`) still reply to this parent? */
export function hasOwnReply(
  accountId: string,
  parentMessageIdHdr: string,
  ownAddress: string,
  except: string
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM messages
       WHERE account_id = ? AND in_reply_to = ? AND LOWER(from_addr) = LOWER(?)
         AND message_id_hdr != ? LIMIT 1`
    )
    .get(accountId, parentMessageIdHdr, ownAddress, except)
}

// ---------- outbox ----------

export interface OpRow {
  id: number
  accountId: string
  kind: OpKind
  payload: Record<string, unknown>
  state: 'pending' | 'running' | 'failed'
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  createdAt: number
}

interface OpDbRow {
  id: number
  account_id: string
  kind: OpKind
  payload: string
  state: 'pending' | 'running' | 'failed'
  attempts: number
  next_attempt_at: number
  last_error: string | null
  created_at: number
}

function toOp(r: OpDbRow): OpRow {
  return {
    id: r.id,
    accountId: r.account_id,
    kind: r.kind,
    payload: JSON.parse(r.payload),
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    createdAt: r.created_at
  }
}

export function enqueueOp(
  accountId: string,
  kind: OpKind,
  payload: Record<string, unknown>,
  runAt: number = Date.now()
): number {
  const res = db
    .prepare(
      'INSERT INTO ops (account_id, kind, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(accountId, kind, JSON.stringify(payload), runAt, Date.now())
  return Number(res.lastInsertRowid)
}

export function listOps(): OpRow[] {
  return (db.prepare('SELECT * FROM ops ORDER BY id').all() as OpDbRow[]).map(toOp)
}

export function getOp(id: number): OpRow | null {
  const row = db.prepare('SELECT * FROM ops WHERE id = ?').get(id) as OpDbRow | undefined
  return row ? toOp(row) : null
}

/** Pending ops for one message (send/draft ops carry messageIdHdr in their payload) */
export function findOpsForMessage(accountId: string, messageIdHdr: string): OpRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM ops WHERE account_id = ? AND json_extract(payload, '$.messageIdHdr') = ? ORDER BY id"
      )
      .all(accountId, messageIdHdr) as OpDbRow[]
  ).map(toOp)
}

export function deleteOp(id: number): void {
  db.prepare('DELETE FROM ops WHERE id = ?').run(id)
}

export function deleteOps(ids: number[]): void {
  const stmt = db.prepare('DELETE FROM ops WHERE id = ?')
  db.transaction(() => {
    for (const id of ids) stmt.run(id)
  })()
}

export function markOpRunning(id: number): void {
  db.prepare("UPDATE ops SET state = 'running' WHERE id = ?").run(id)
}

/** A transient failure: stay pending, back off */
export function deferOp(id: number, error: string, nextAttemptAt: number): void {
  db.prepare(
    "UPDATE ops SET state = 'pending', attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?"
  ).run(error, nextAttemptAt, id)
}

/** A permanent failure: park until the user retries or discards */
export function failOp(id: number, error: string): void {
  db.prepare(
    "UPDATE ops SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?"
  ).run(error, id)
}

/** Put every parked/deferred op back on the front of the line */
export function retryOps(ids?: number[]): void {
  if (ids) {
    const stmt = db.prepare(
      "UPDATE ops SET state = 'pending', next_attempt_at = ?, last_error = NULL WHERE id = ? AND state != 'running'"
    )
    db.transaction(() => {
      for (const id of ids) stmt.run(Date.now(), id)
    })()
  } else {
    db.prepare(
      "UPDATE ops SET state = 'pending', next_attempt_at = ?, last_error = NULL WHERE state != 'running'"
    ).run(Date.now())
  }
}

/** Ops that were mid-flight when the process died */
export function resetRunningOps(): OpRow[] {
  const rows = (db.prepare("SELECT * FROM ops WHERE state = 'running'").all() as OpDbRow[]).map(
    toOp
  )
  db.prepare("UPDATE ops SET state = 'pending' WHERE state = 'running'").run()
  return rows
}

export function toWireOp(op: OpRow): WireOp {
  return {
    id: op.id,
    accountId: op.accountId,
    kind: op.kind,
    state: op.state,
    attempts: op.attempts,
    lastError: op.lastError,
    nextAttemptAt: op.nextAttemptAt,
    createdAt: op.createdAt,
    messageIdHdr: typeof op.payload.messageIdHdr === 'string' ? op.payload.messageIdHdr : null,
    action: typeof op.payload.action === 'string' ? op.payload.action : null,
    gmailIds: Array.isArray(op.payload.gmailIds) ? (op.payload.gmailIds as string[]) : []
  }
}
