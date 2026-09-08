import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'
import { join } from 'path'
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
 */

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
  UNIQUE(account_id, gmail_id),
  UNIQUE(account_id, message_id_hdr)
);
CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
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
const SCHEMA_VERSION = 2

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
  }
}

let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'mail.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const version = db.pragma('user_version', { simple: true }) as number
  db.transaction(() => {
    for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
      MIGRATIONS[v]?.(db)
    }
    db.exec(SCHEMA)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })()
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
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
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
 * Conflicts on gmail_id (already-known synced mail) only refresh label state.
 */
const UPSERT_SQL = `
INSERT INTO messages (
  account_id, gmail_id, thread_id, message_id_hdr, in_reply_to, refs,
  from_name, from_addr, to_json, cc_json, reply_to_json,
  subject, date, snippet, body_text, body_html,
  folder, seen, flagged, category, important, state
) VALUES (
  @accountId, @gmailId, @threadId, @messageIdHdr, @inReplyTo, @refs,
  @fromName, @fromAddr, @toJson, @ccJson, @replyToJson,
  @subject, @dateMs, @snippet, @bodyText, @bodyHtml,
  @folder, @seen, @flagged, @category, @important, 'synced'
)
ON CONFLICT(account_id, gmail_id) DO UPDATE SET
  folder = excluded.folder,
  seen = excluded.seen,
  flagged = excluded.flagged,
  category = excluded.category,
  important = excluded.important,
  snippet = CASE WHEN messages.snippet = '' THEN excluded.snippet ELSE messages.snippet END,
  state = CASE WHEN messages.state IN ('sent', 'synced') THEN 'synced' ELSE messages.state END
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
  state = CASE WHEN messages.state IN ('sent', 'synced') THEN 'synced' ELSE messages.state END,
  send_after = NULL,
  send_error = NULL
`

function toParams(r: MsgRecord): Record<string, unknown> {
  return {
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
    bodyText: r.bodyText,
    bodyHtml: r.bodyHtml,
    folder: r.folder,
    seen: r.seen ? 1 : 0,
    flagged: r.flagged ? 1 : 0,
    category: r.category,
    important: r.important ? 1 : 0
  }
}

export function upsertMessages(records: MsgRecord[]): void {
  const stmt = db.prepare(UPSERT_SQL)
  db.transaction(() => {
    for (const r of records) {
      try {
        stmt.run(toParams(r))
      } catch (err) {
        // A synced message whose Message-ID collides with a *different* local
        // row (Gmail reuses headers across draft revisions): store it without
        // the header rather than losing it.
        if ((err as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err
        stmt.run({ ...toParams(r), messageIdHdr: null })
      }
    }
  })()
}

export function deleteMessage(accountId: string, gmailId: string): void {
  db.prepare('DELETE FROM messages WHERE account_id = ? AND gmail_id = ?').run(accountId, gmailId)
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
      .prepare('SELECT gmail_id FROM messages WHERE account_id = ? AND gmail_id IS NOT NULL')
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
        'SELECT gmail_id, folder, seen, flagged, important FROM messages WHERE account_id = ? AND gmail_id IS NOT NULL'
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
  body_text: string
  body_html: string | null
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
    bodyText: row.body_text,
    bodyHtml: row.body_html,
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

export function queryThread(accountId: string, threadId: string): WireMessage[] {
  return (
    db
      .prepare('SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date')
      .all(accountId, threadId) as MessageRow[]
  ).map(rowToWire)
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
    bodyText: row.body_text,
    bodyHtml: row.body_html,
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
  db.prepare(
    `INSERT INTO messages (
      account_id, thread_id, message_id_hdr, in_reply_to, refs,
      from_name, from_addr, to_json, cc_json,
      subject, date, snippet, body_text, body_html,
      folder, seen, flagged, answered, category, important, state, send_after, send_error
    ) VALUES (
      @accountId, @threadId, @messageIdHdr, @inReplyTo, @refs,
      @fromName, @fromAddr, @toJson, @ccJson,
      @subject, @date, @snippet, @bodyText, @bodyHtml,
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
      folder = excluded.folder,
      category = excluded.category,
      state = excluded.state,
      send_after = excluded.send_after,
      send_error = NULL`
  ).run({
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
    bodyText: input.text,
    bodyHtml: input.html ?? null,
    folder,
    category: input.category ?? 'people',
    state,
    sendAfter
  })
}

export function deleteLocalMessage(accountId: string, messageIdHdr: string): void {
  db.prepare('DELETE FROM messages WHERE account_id = ? AND message_id_hdr = ?').run(
    accountId,
    messageIdHdr
  )
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
