import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'
import { join } from 'path'
import type { WireAccount, WireMessage, Folder } from '../preload/index.d'

/**
 * Local mail store. SQLite in the main process is the source of truth the
 * renderer hydrates from; Gmail is the remote source of truth the sync engine
 * reconciles against. Dates are unix ms (cheap index comparisons).
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
  gmail_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
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
  UNIQUE(account_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_list ON messages(account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id);
`

let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'mail.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
}

// ---------- config ----------

export function getConfig(key: string): string | null {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setConfig(key: string, value: string): void {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
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

export function getAccountByEmail(email: string): WireAccount | null {
  const row = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) as
    | AccountRow
    | undefined
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
    | { refresh_token: string | null }
    | undefined
  const stored = row?.refresh_token
  if (!stored) return null
  if (stored.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  }
  return stored.replace(/^plain:/, '')
}

export function getHistoryId(accountId: string): string | null {
  const row = db.prepare('SELECT history_id FROM accounts WHERE id = ?').get(accountId) as
    | { history_id: string | null }
    | undefined
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

// ---------- messages ----------

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

const UPSERT_SQL = `
INSERT INTO messages (
  account_id, gmail_id, thread_id, message_id_hdr, in_reply_to, refs,
  from_name, from_addr, to_json, cc_json, reply_to_json,
  subject, date, snippet, body_text, body_html,
  folder, seen, flagged, category, important
) VALUES (
  @accountId, @gmailId, @threadId, @messageIdHdr, @inReplyTo, @refs,
  @fromName, @fromAddr, @toJson, @ccJson, @replyToJson,
  @subject, @dateMs, @snippet, @bodyText, @bodyHtml,
  @folder, @seen, @flagged, @category, @important
)
ON CONFLICT(account_id, gmail_id) DO UPDATE SET
  folder = excluded.folder,
  seen = excluded.seen,
  flagged = excluded.flagged,
  category = excluded.category,
  important = excluded.important
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
    for (const r of records) stmt.run(toParams(r))
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
  ).run(state.folder, state.seen ? 1 : 0, state.flagged ? 1 : 0, state.important ? 1 : 0, accountId, gmailId)
}

export function hasMessage(accountId: string, gmailId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM messages WHERE account_id = ? AND gmail_id = ?')
    .get(accountId, gmailId)
}

interface MessageRow {
  account_id: string
  gmail_id: string
  thread_id: string
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
    important: row.important === 1
  }
}

/**
 * The renderer's hydration window: per account, the newest `perAccount`
 * messages plus everything flagged or drafted (those must never fall out of
 * view regardless of age). Full paged queries replace this later.
 */
export function queryWindow(perAccount: number): WireMessage[] {
  const latest = db.prepare(
    'SELECT * FROM messages WHERE account_id = ? ORDER BY date DESC LIMIT ?'
  )
  const pinned = db.prepare(
    "SELECT * FROM messages WHERE account_id = ? AND (flagged = 1 OR folder = 'drafts')"
  )
  const out: WireMessage[] = []
  for (const account of listAccounts()) {
    const seen = new Set<string>()
    for (const row of [
      ...(latest.all(account.id, perAccount) as MessageRow[]),
      ...(pinned.all(account.id) as MessageRow[])
    ]) {
      if (seen.has(row.gmail_id)) continue
      seen.add(row.gmail_id)
      out.push(rowToWire(row))
    }
  }
  return out
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
