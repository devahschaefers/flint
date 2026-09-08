import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from '../db'
import { createAccount, record, wire } from './helpers'

/** The schema as shipped before lifecycle columns existed (commit 8da96e5) */
const V1_SCHEMA = `
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

interface V1Row {
  account_id: string
  gmail_id: string
  thread_id: string
  message_id_hdr: string | null
  subject?: string
  folder?: string
  seen?: number
  answered?: number
}

/** Build a v1 database file at `path` with the given accounts and rows */
function buildV1(path: string, accounts: string[], rows: V1Row[]): void {
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.exec(V1_SCHEMA)
  // v1 never set user_version; it stays at SQLite's default of 0
  const insAccount = raw.prepare(
    "INSERT INTO accounts (id, email, name, color, created_at, history_id) VALUES (?, ?, ?, '#000', 1, 'h1')"
  )
  for (const id of accounts) insAccount.run(id, `${id}@example.com`, id)
  const insMsg = raw.prepare(
    `INSERT INTO messages (account_id, gmail_id, thread_id, message_id_hdr, subject, date, folder, seen, answered, body_text)
     VALUES (@account_id, @gmail_id, @thread_id, @message_id_hdr, @subject, 1000, @folder, @seen, @answered, 'body')`
  )
  for (const r of rows) {
    insMsg.run({
      subject: '',
      folder: 'inbox',
      seen: 0,
      answered: 0,
      ...r
    })
  }
  raw.close()
}

interface MigratedRow {
  id: number
  account_id: string
  gmail_id: string | null
  gmail_draft_id: string | null
  thread_id: string | null
  message_id_hdr: string | null
  subject: string
  folder: string
  seen: number
  answered: number
  state: string
  send_after: number | null
  send_error: string | null
  body_text: string
}

/** Read the file through a second connection, so assertions see raw columns */
function inspect(path: string): {
  version: number
  rows: MigratedRow[]
  tables: string[]
  indexes: string[]
} {
  const raw = new Database(path, { readonly: true })
  const version = raw.pragma('user_version', { simple: true }) as number
  const rows = raw.prepare('SELECT * FROM messages ORDER BY id').all() as MigratedRow[]
  const names = (type: string): string[] =>
    (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
        .all(type) as { name: string }[]
    ).map((r) => r.name)
  const out = { version, rows, tables: names('table'), indexes: names('index') }
  raw.close()
  return out
}

let dir: string
let n = 0
function freshPath(): string {
  return join(dir, `mail-${n++}.db`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-db-test-'))
})

afterEach(() => {
  db.closeDb()
})

describe('initDb migration v1 -> v2', () => {
  it('rebuilds a v1 messages table without losing rows and de-duplicates Message-ID headers', () => {
    const path = freshPath()
    buildV1(
      path,
      ['a', 'b'],
      [
        { account_id: 'a', gmail_id: 'g1', thread_id: 't1', message_id_hdr: '<dup@x>', seen: 1 },
        { account_id: 'a', gmail_id: 'g2', thread_id: 't1', message_id_hdr: '<dup@x>' },
        { account_id: 'a', gmail_id: 'g3', thread_id: 't2', message_id_hdr: '<solo@x>' },
        { account_id: 'a', gmail_id: 'g4', thread_id: 't3', message_id_hdr: null, answered: 1 },
        // The same header in another account is not a duplicate
        { account_id: 'b', gmail_id: 'g5', thread_id: 't9', message_id_hdr: '<dup@x>' }
      ]
    )

    db.initDb(path)
    const { version, rows, tables, indexes } = inspect(path)

    expect(version).toBe(2)
    expect(rows.map((r) => r.gmail_id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5'])
    const byGmail = Object.fromEntries(rows.map((r) => [r.gmail_id, r]))
    // duplicate header: kept on the lowest id, nulled on the later copy
    expect(byGmail.g1.message_id_hdr).toBe('<dup@x>')
    expect(byGmail.g2.message_id_hdr).toBeNull()
    expect(byGmail.g3.message_id_hdr).toBe('<solo@x>')
    expect(byGmail.g4.message_id_hdr).toBeNull()
    expect(byGmail.g5.message_id_hdr).toBe('<dup@x>')
    // existing data survives the copy
    expect(byGmail.g1.seen).toBe(1)
    expect(byGmail.g4.answered).toBe(1)
    expect(byGmail.g1.thread_id).toBe('t1')
    expect(rows.every((r) => r.body_text === 'body')).toBe(true)
    // lifecycle columns exist and default to synced
    expect(rows.every((r) => r.state === 'synced')).toBe(true)
    expect(rows.every((r) => r.send_after === null && r.send_error === null)).toBe(true)
    expect(rows.every((r) => r.gmail_draft_id === null)).toBe(true)
    // scratch table and index are gone; the standard indexes are back
    expect(tables).not.toContain('messages_v1')
    expect(tables).toEqual(expect.arrayContaining(['messages', 'ops', 'accounts', 'config']))
    expect(indexes).not.toContain('idx_v1_hdr')
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_messages_list', 'idx_messages_date', 'idx_messages_thread'])
    )
    // the store is usable through the module API afterwards
    expect(db.listAccounts().map((a) => a.id)).toEqual(['a', 'b'])
    expect(db.getHistoryId('a')).toBe('h1')
    expect(db.listGmailIds('a').sort()).toEqual(['g1', 'g2', 'g3', 'g4'])
  })

  it('accepts a v1 database with no messages', () => {
    const path = freshPath()
    buildV1(path, ['a'], [])
    db.initDb(path)
    const { version, rows } = inspect(path)
    expect(version).toBe(2)
    expect(rows).toEqual([])
    expect(db.listAccounts()).toHaveLength(1)
  })

  it('is idempotent: reopening a migrated database changes nothing', () => {
    const path = freshPath()
    buildV1(
      path,
      ['a'],
      [{ account_id: 'a', gmail_id: 'g1', thread_id: 't1', message_id_hdr: '<m1@x>' }]
    )
    db.initDb(path)
    const first = inspect(path)
    db.closeDb()
    db.initDb(path)
    const second = inspect(path)
    expect(second).toEqual(first)
    expect(second.version).toBe(2)
  })

  it('initializes a fresh database straight to v2', () => {
    const path = freshPath()
    db.initDb(path)
    const { version, tables, rows } = inspect(path)
    expect(version).toBe(2)
    expect(rows).toEqual([])
    expect(tables).toEqual(expect.arrayContaining(['messages', 'ops', 'accounts', 'config']))
    // The v2 shape: local rows without a Gmail id are allowed
    createAccount('a')
    db.putLocalMessage(
      {
        accountId: 'a',
        messageIdHdr: '<local@x>',
        to: [],
        cc: [],
        subject: 's',
        text: 't',
        references: []
      },
      { name: 'Me', address: 'me@example.com' },
      'draft',
      'drafts',
      null
    )
    expect(db.getLocalMessage('a', '<local@x>')?.gmailId).toBeNull()
  })
})

describe('upsertMessages', () => {
  beforeEach(() => {
    db.initDb(':memory:')
    createAccount('a')
  })

  const localInput = {
    accountId: 'a',
    messageIdHdr: '<H@flint.local>',
    to: [{ address: 'you@example.com' }],
    cc: [],
    subject: 'hello',
    text: 'body text',
    references: [] as string[]
  }
  const me = { name: 'Me', address: 'me@example.com' }

  it('adopts a local row by Message-ID instead of inserting a twin', () => {
    db.putLocalMessage(localInput, me, 'queued', 'sent', null)
    expect(db.getLocalMessage('a', '<H@flint.local>')?.gmailId).toBeNull()

    db.upsertMessages([
      record({
        accountId: 'a',
        gmailId: 'G',
        threadId: 'T',
        messageIdHdr: '<H@flint.local>',
        folder: 'sent',
        seen: true
      })
    ])

    const local = db.getLocalMessage('a', '<H@flint.local>')
    expect(local?.gmailId).toBe('G')
    expect(local?.threadId).toBe('T')
    expect(db.countMessages('a')).toBe(1)
    expect(db.listGmailIds('a')).toEqual(['G'])
    // the local body is kept; only ids/labels/snippet/date come from Gmail
    expect(local?.bodyText).toBe('body text')
    // Gmail holding a non-draft copy means it went out: the outbox must not send it again
    expect(local?.state).toBe('synced')
  })

  it('keeps a queued row queued when Gmail only holds it as a draft', () => {
    db.putLocalMessage(localInput, me, 'queued', 'sent', null)
    db.upsertMessages([
      record({
        accountId: 'a',
        gmailId: 'GD',
        messageIdHdr: '<H@flint.local>',
        folder: 'drafts'
      })
    ])
    const local = db.getLocalMessage('a', '<H@flint.local>')
    expect(local).toMatchObject({ gmailId: 'GD', state: 'queued' })
  })

  it('moves a sent row to synced when its copy comes back', () => {
    db.putLocalMessage(localInput, me, 'queued', 'sent', null)
    db.setLocalState('a', '<H@flint.local>', {
      state: 'sent',
      gmailId: 'G',
      sendError: 'old error'
    })
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'G', messageIdHdr: '<H@flint.local>', folder: 'sent' })
    ])
    const w = wire('a', '<H@flint.local>')
    expect(w?.state).toBe('synced')
    expect(w?.folder).toBe('sent')
    expect(db.countMessages('a')).toBe(1)
  })

  it('refreshes label state on a known gmail id without duplicating', () => {
    db.upsertMessages([record({ accountId: 'a', gmailId: 'G', folder: 'inbox', seen: false })])
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'G', folder: 'archive', seen: true, flagged: true })
    ])
    expect(db.countMessages('a')).toBe(1)
    const w = db.getMessageWire('a', 'G')
    expect(w?.folder).toBe('archive')
    expect(w?.seen).toBe(true)
    expect(w?.flagged).toBe(true)
  })

  it('stores a header-colliding message without its header rather than dropping it', () => {
    // Row A: synced, gmail id GA. Row B: local draft with header H and gmail id GB.
    db.upsertMessages([record({ accountId: 'a', gmailId: 'GA', messageIdHdr: null })])
    db.putLocalMessage(localInput, me, 'draft', 'drafts', null)
    db.setLocalState('a', '<H@flint.local>', { gmailId: 'GB' })
    // Gmail now claims GA carries header H: adopting would put GA on two rows.
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'GA', messageIdHdr: '<H@flint.local>', seen: true })
    ])
    expect(db.countMessages('a')).toBe(2)
    expect(db.getLocalMessage('a', '<H@flint.local>')?.gmailId).toBe('GB')
    expect(db.getMessageWire('a', 'GA')?.seen).toBe(true)
  })

  it('keeps the same header in two accounts as two rows', () => {
    createAccount('b', 'other@example.com')
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'G1', messageIdHdr: '<same@x>' }),
      record({ accountId: 'b', gmailId: 'G2', messageIdHdr: '<same@x>' })
    ])
    expect(db.countMessages('a')).toBe(1)
    expect(db.countMessages('b')).toBe(1)
  })
})

describe('local message rows', () => {
  const me = { name: 'Me', address: 'me@example.com' }
  const input = {
    accountId: 'a',
    messageIdHdr: '<L@flint.local>',
    to: [{ address: 'you@example.com' }],
    cc: [{ address: 'cc@example.com' }],
    subject: 'first',
    text: 'first body',
    references: ['<p@x>'],
    inReplyTo: '<p@x>',
    threadId: 'T1'
  }

  beforeEach(() => {
    db.initDb(':memory:')
    createAccount('a')
  })

  it('putLocalMessage inserts a seen, unflagged row in the given state and folder', () => {
    db.putLocalMessage(input, me, 'queued', 'sent', 12345)
    const local = db.getLocalMessage('a', '<L@flint.local>')
    expect(local).toMatchObject({
      accountId: 'a',
      messageIdHdr: '<L@flint.local>',
      gmailId: null,
      gmailDraftId: null,
      threadId: 'T1',
      inReplyTo: '<p@x>',
      references: ['<p@x>'],
      to: [{ address: 'you@example.com' }],
      cc: [{ address: 'cc@example.com' }],
      subject: 'first',
      bodyText: 'first body',
      bodyHtml: null,
      state: 'queued',
      sendAfter: 12345
    })
    const w = wire('a', '<L@flint.local>')
    expect(w).toMatchObject({
      folder: 'sent',
      seen: true,
      flagged: false,
      from: { name: 'Me', address: 'me@example.com' },
      snippet: 'first body',
      sendAfterMs: 12345,
      sendError: null
    })
  })

  it('putLocalMessage on an existing header replaces content but keeps Gmail ids and thread', () => {
    db.putLocalMessage(input, me, 'draft', 'drafts', null)
    db.setLocalState('a', '<L@flint.local>', {
      gmailId: 'G',
      gmailDraftId: 'D',
      sendError: 'boom'
    })
    db.putLocalMessage(
      { ...input, subject: 'second', text: 'second body', html: '<p>hi</p>', threadId: 'T2' },
      me,
      'queued',
      'sent',
      99
    )
    const local = db.getLocalMessage('a', '<L@flint.local>')
    expect(local).toMatchObject({
      subject: 'second',
      bodyText: 'second body',
      bodyHtml: '<p>hi</p>',
      gmailId: 'G',
      gmailDraftId: 'D',
      threadId: 'T1',
      state: 'queued',
      sendAfter: 99
    })
    expect(wire('a', '<L@flint.local>')?.sendError).toBeNull()
    expect(db.countMessages('a')).toBe(1)
  })

  it('setLocalState patches only the given fields', () => {
    db.putLocalMessage(input, me, 'queued', 'sent', 5)
    db.setLocalState('a', '<L@flint.local>', { state: 'failed', sendError: 'nope' })
    let local = db.getLocalMessage('a', '<L@flint.local>')
    expect(local?.state).toBe('failed')
    expect(local?.sendAfter).toBe(5)
    expect(wire('a', '<L@flint.local>')?.sendError).toBe('nope')

    db.setLocalState('a', '<L@flint.local>', {
      state: 'sent',
      gmailId: 'G',
      threadId: 'T9',
      sendAfter: null,
      sendError: null
    })
    local = db.getLocalMessage('a', '<L@flint.local>')
    expect(local).toMatchObject({ state: 'sent', gmailId: 'G', threadId: 'T9', sendAfter: null })
    expect(wire('a', '<L@flint.local>')?.sendError).toBeNull()

    // an empty patch is a no-op
    db.setLocalState('a', '<L@flint.local>', {})
    expect(db.getLocalMessage('a', '<L@flint.local>')?.state).toBe('sent')
  })

  it('hasOwnReply finds our other replies to a parent, ignoring the excluded one and address case', () => {
    db.putLocalMessage(input, me, 'queued', 'sent', null)
    expect(db.hasOwnReply('a', '<p@x>', 'me@example.com', '<L@flint.local>')).toBe(false)
    db.putLocalMessage({ ...input, messageIdHdr: '<L2@flint.local>' }, me, 'draft', 'drafts', null)
    expect(db.hasOwnReply('a', '<p@x>', 'ME@Example.com', '<L@flint.local>')).toBe(true)
    // someone else's reply does not count
    db.deleteLocalMessage('a', '<L2@flint.local>')
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'G', inReplyTo: '<p@x>', fromAddr: 'them@example.com' })
    ])
    expect(db.hasOwnReply('a', '<p@x>', 'me@example.com', '<L@flint.local>')).toBe(false)
  })

  it('setAnswered flips the parent flag by Message-ID', () => {
    db.upsertMessages([record({ accountId: 'a', gmailId: 'P', messageIdHdr: '<p@x>' })])
    db.setAnswered('a', '<p@x>', true)
    expect(db.getMessageWire('a', 'P')?.answered).toBe(true)
    db.setAnswered('a', '<p@x>', false)
    expect(db.getMessageWire('a', 'P')?.answered).toBe(false)
  })
})
