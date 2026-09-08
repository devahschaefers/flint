import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../db'
import { decodeBody, encodeBody, isBodyCodec, storedSize } from '../storage/bodies'
import { createCompactor } from '../storage/compactor'
import { bestPlainText, decodeEntities, htmlToText } from '../storage/htmlToText'
import { buildMatchExpression, parseSearchTerms } from '../storage/search'
import { createAccount, record } from './helpers'

// ---------- fixtures ----------

/** The schema as shipped at v2 (commit e19a70d): TEXT bodies, no codec/state, no FTS */
const V2_SCHEMA = `
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
`

interface V2Row {
  gmail_id: string
  subject?: string
  body_text?: string
  body_html?: string | null
  date?: number
}

function buildV2(path: string, rows: V2Row[]): void {
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.exec(V2_SCHEMA)
  raw
    .prepare(
      "INSERT INTO accounts (id, email, name, color, created_at, backfill_done) VALUES ('a', 'a@example.com', 'A', '#000', 1, 1)"
    )
    .run()
  const ins = raw.prepare(
    `INSERT INTO messages (account_id, gmail_id, thread_id, message_id_hdr, subject, date, folder, body_text, body_html)
     VALUES ('a', @gmail_id, @thread_id, @hdr, @subject, @date, 'inbox', @body_text, @body_html)`
  )
  for (const r of rows) {
    ins.run({
      gmail_id: r.gmail_id,
      thread_id: `t-${r.gmail_id}`,
      hdr: `<${r.gmail_id}@x>`,
      subject: r.subject ?? `Subject ${r.gmail_id}`,
      date: r.date ?? 1000,
      body_text: r.body_text ?? `plain body of ${r.gmail_id}`,
      body_html: r.body_html ?? null
    })
  }
  raw.close()
}

interface RawBodyRow {
  id: number
  gmail_id: string
  body_text: string | Buffer
  body_html: string | Buffer | null
  body_codec: string
  body_state: string
}

/** Raw body columns through a second connection, so the codec is visible */
function rawRows(path: string): RawBodyRow[] {
  const raw = new Database(path, { readonly: true })
  const rows = raw
    .prepare(
      'SELECT id, gmail_id, body_text, body_html, body_codec, body_state FROM messages ORDER BY id'
    )
    .all() as RawBodyRow[]
  raw.close()
  return rows
}

function pragma(path: string, name: string): number {
  const raw = new Database(path, { readonly: true })
  const v = raw.pragma(name, { simple: true }) as number
  raw.close()
  return v
}

let dir: string
let n = 0
const freshPath = (): string => join(dir, `mail-${n++}.db`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flint-storage-test-'))
})

afterEach(() => {
  db.closeDb()
})

// ---------- codec ----------

describe('body codec', () => {
  const samples = [
    '',
    'hello',
    'Grüße aus Köln — 日本語のテキスト 🚀',
    'line1\r\nline2\n\ttabbed',
    'x'.repeat(100_000),
    JSON.stringify({ nested: ['a', 'b', { c: 1 }] })
  ]

  it('round-trips text through zstd and stores it as a BLOB', () => {
    for (const s of samples) {
      const stored = encodeBody(s)
      expect(Buffer.isBuffer(stored)).toBe(true)
      expect(decodeBody(stored, 'zstd')).toBe(s)
    }
  })

  it('compresses repetitive text well', () => {
    const stored = encodeBody('<p>the same paragraph</p>\n'.repeat(2000))
    expect(storedSize(stored)).toBeLessThan(2000)
  })

  it('keeps null as null (no HTML part)', () => {
    expect(encodeBody(null)).toBeNull()
    expect(decodeBody(null, 'zstd')).toBeNull()
    expect(storedSize(null)).toBe(0)
  })

  it("'none' stores plain text and decodes it back unchanged", () => {
    const stored = encodeBody('plain', 'none')
    expect(stored).toBe('plain')
    expect(decodeBody(stored, 'none')).toBe('plain')
  })

  it('decodes a legacy TEXT value whatever codec the row claims', () => {
    expect(decodeBody('legacy text', 'zstd')).toBe('legacy text')
  })

  it('rejects an unknown codec on both sides', () => {
    const bad = 'brotli' as unknown as 'zstd'
    expect(() => encodeBody('x', bad)).toThrow(/Unknown body codec/)
    expect(() => decodeBody(Buffer.from('x'), bad)).toThrow(/Unknown body codec/)
  })

  it('recognises codec ids, including future dictionary variants', () => {
    expect(isBodyCodec('none')).toBe(true)
    expect(isBodyCodec('zstd')).toBe(true)
    expect(isBodyCodec('zstd-dict:2026-09')).toBe(true)
    expect(isBodyCodec('gzip')).toBe(false)
    expect(isBodyCodec(3)).toBe(false)
  })
})

// ---------- html → text ----------

describe('htmlToText', () => {
  it('drops head, script and style contents and turns blocks into lines', () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head>
      <body><script>alert(1)</script><h1>Hello</h1><p>First   para</p><div>Second<br>line</div>
      <ul><li>one</li><li>two</li></ul></body></html>`
    expect(htmlToText(html)).toBe('Hello\nFirst para\nSecond\nline\none\ntwo')
  })

  it('separates table cells with spaces and rows with newlines', () => {
    const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'
    expect(htmlToText(html)).toBe('a b\nc d')
  })

  it('decodes named, decimal and hex entities and leaves unknown ones alone', () => {
    expect(decodeEntities('&amp; &lt;b&gt; &quot;q&quot; &nbsp;x &#8212; &#x1F600; &bogus;')).toBe(
      '& <b> "q"  x — 😀 &bogus;'
    )
    expect(htmlToText('<p>Tom &amp; Jerry&rsquo;s caf&eacute;</p>')).toBe('Tom & Jerry’s café')
  })

  it('leaves a lone < in prose alone and strips comments', () => {
    expect(htmlToText('<p>if a < b then<!-- hidden --> ok</p>')).toBe('if a < b then ok')
  })

  it('collapses whitespace and caps blank runs', () => {
    expect(htmlToText('<p>a</p>\n\n\n\n<p>&nbsp;</p><p>b</p>')).toBe('a\nb')
  })

  it('handles a typical newsletter shell', () => {
    const html = `<!DOCTYPE html><html><body style="margin:0">
      <table role="presentation"><tr><td><a href="#">View in browser</a></td></tr>
      <tr><td><h2>Weekly digest</h2><p>Three things happened this week.</p></td></tr>
      </table><img src="pixel.gif" width="1" height="1"></body></html>`
    expect(htmlToText(html)).toBe(
      'View in browser\nWeekly digest\nThree things happened this week.'
    )
  })
})

describe('bestPlainText', () => {
  it('keeps a real text part', () => {
    expect(bestPlainText('This is the plain text version.', '<p>HTML</p>')).toBe(
      'This is the plain text version.'
    )
  })

  it('derives text when the sender sent none', () => {
    expect(bestPlainText('', '<p>Only <b>HTML</b> here</p>')).toBe('Only HTML here')
  })

  it('derives text when the text part is a token stub', () => {
    expect(bestPlainText('View online', '<h1>Big announcement</h1><p>Details follow.</p>')).toBe(
      'Big announcement\nDetails follow.'
    )
  })

  it('keeps the text when there is no HTML or the HTML has nothing more', () => {
    expect(bestPlainText('hi', null)).toBe('hi')
    expect(bestPlainText('hi', '<img src="x">')).toBe('hi')
  })
})

// ---------- query builder ----------

describe('buildMatchExpression', () => {
  it('quotes every bare word and ANDs them', () => {
    expect(buildMatchExpression('hello world')).toBe('"hello" AND "world"')
  })

  it('supports a trailing * as a prefix query', () => {
    expect(buildMatchExpression('inv*')).toBe('"inv" *')
    expect(buildMatchExpression('inv** oice')).toBe('"inv" * AND "oice"')
  })

  it('keeps a double-quoted run as one phrase, with optional prefix', () => {
    expect(buildMatchExpression('"quick brown" fox')).toBe('"quick brown" AND "fox"')
    expect(buildMatchExpression('"quick bro"*')).toBe('"quick bro" *')
    expect(buildMatchExpression('"unterminated phrase')).toBe('"unterminated phrase"')
  })

  it('neutralises FTS5 operators and syntax', () => {
    expect(buildMatchExpression('AND NOT OR NEAR')).toBe('"AND" AND "NOT" AND "OR" AND "NEAR"')
    expect(buildMatchExpression('(a OR b) NOT c')).toBe('"a" AND "OR" AND "b" AND "NOT" AND "c"')
    expect(buildMatchExpression('subject:foo col:bar')).toBe('"subject foo" AND "col bar"')
    expect(buildMatchExpression('^caret {brace} -minus +plus')).toBe(
      '"caret" AND "brace" AND "minus" AND "plus"'
    )
  })

  it('splits punctuated words the way the tokenizer does', () => {
    expect(buildMatchExpression('foo.bar a-b')).toBe('"foo bar" AND "a b"')
    expect(buildMatchExpression('me@example.com')).toBe('"me example com"')
  })

  it('passes unicode through', () => {
    expect(buildMatchExpression('résumé 日本語 Straße')).toBe('"résumé" AND "日本語" AND "Straße"')
  })

  it('returns null when nothing searchable remains', () => {
    for (const raw of ['', '   ', '"', '""', '***', '()', '"  "*', '!!!', '" * "']) {
      expect(buildMatchExpression(raw)).toBeNull()
    }
  })

  it('exposes parsed terms', () => {
    expect(parseSearchTerms('a "b c"* d*')).toEqual([
      { words: ['a'], prefix: false },
      { words: ['b', 'c'], prefix: true },
      { words: ['d'], prefix: true }
    ])
  })
})

// ---------- FTS through the store ----------

describe('full-text search', () => {
  beforeEach(() => {
    db.initDb(':memory:')
    createAccount('a')
    createAccount('b', 'b@example.com')
    db.upsertMessages([
      record({
        accountId: 'a',
        gmailId: 'g1',
        subject: 'Quarterly budget review',
        bodyText: 'Please find the numbers attached.'
      }),
      record({
        accountId: 'a',
        gmailId: 'g2',
        subject: 'Lunch?',
        bodyText: 'The budget for lunch is unlimited. Budget budget budget.'
      }),
      record({
        accountId: 'b',
        gmailId: 'g3',
        subject: 'Budget',
        bodyText: 'Other account, café résumé'
      })
    ])
  })

  const ids = (hits: db.SearchHit[]): string[] =>
    hits.map((h) => db.queryThread(h.accountId, h.threadId ?? '')[0]?.gmailId ?? '?')

  it('finds by subject and body, best match first, with a subject boost', () => {
    const hits = db.searchMessages('budget')
    expect(hits).toHaveLength(3)
    // subject matches outrank a body-only match even with more body occurrences
    expect(ids(hits).indexOf('g2')).toBe(2)
    expect(hits[0].rank).toBeLessThanOrEqual(hits[1].rank)
    expect(hits[1].rank).toBeLessThanOrEqual(hits[2].rank)
    expect(hits[0]).toMatchObject({ messageId: expect.any(Number), accountId: expect.any(String) })
  })

  it('filters by account and honours the limit', () => {
    expect(ids(db.searchMessages('budget', { accountId: 'b' }))).toEqual(['g3'])
    expect(db.searchMessages('budget', { limit: 1 })).toHaveLength(1)
  })

  it('supports prefix, phrase and diacritic-insensitive matches', () => {
    expect(ids(db.searchMessages('quart*'))).toEqual(['g1'])
    expect(ids(db.searchMessages('"numbers attached"'))).toEqual(['g1'])
    expect(ids(db.searchMessages('"attached numbers"'))).toEqual([])
    expect(ids(db.searchMessages('cafe resume'))).toEqual(['g3'])
  })

  it('never throws on hostile input', () => {
    for (const raw of [
      '"',
      'a"b"c"',
      '(((',
      ')))',
      'NOT',
      'AND OR',
      'a NEAR(b c, 5)',
      '{col}:x',
      '" "',
      '\\',
      "'; DROP TABLE messages; --",
      '*',
      'a *',
      '"a" * "b"',
      'x'.repeat(5000)
    ]) {
      expect(() => db.searchMessages(raw)).not.toThrow()
    }
    expect(db.searchMessages('')).toEqual([])
    expect(db.countMessages('a')).toBe(2)
  })

  it('drops deleted messages from the index', () => {
    db.deleteMessage('a', 'g1')
    expect(ids(db.searchMessages('quarterly'))).toEqual([])
    expect(db.countIndexed()).toBe(2)
  })

  it('does not re-index a label-only refresh, and does not duplicate', () => {
    db.upsertMessages([
      record({
        accountId: 'a',
        gmailId: 'g1',
        subject: 'ignored',
        bodyText: 'ignored too',
        seen: true
      })
    ])
    expect(db.countIndexed()).toBe(3)
    expect(ids(db.searchMessages('quarterly'))).toEqual(['g1'])
    expect(db.searchMessages('ignored')).toEqual([])
  })

  it('indexes local drafts and follows their edits', () => {
    const me = { name: 'Me', address: 'a@example.com' }
    const input = {
      accountId: 'a',
      messageIdHdr: '<d@flint.local>',
      to: [],
      cc: [],
      subject: 'Draft about kittens',
      text: 'first version',
      references: [],
      threadId: 'td'
    }
    db.putLocalMessage(input, me, 'draft', 'drafts', null)
    expect(db.searchMessages('kittens')).toHaveLength(1)
    expect(db.searchMessages('first')).toHaveLength(1)
    db.putLocalMessage({ ...input, text: 'second version' }, me, 'draft', 'drafts', null)
    expect(db.searchMessages('first')).toHaveLength(0)
    expect(db.searchMessages('second')).toHaveLength(1)
    expect(db.countIndexed()).toBe(4)
    db.deleteLocalMessage('a', '<d@flint.local>')
    expect(db.searchMessages('kittens')).toHaveLength(0)
    expect(db.countIndexed()).toBe(3)
  })

  it('indexes a metadata-only row by subject, then by body once it is filled', () => {
    db.upsertMessages([
      record({
        accountId: 'a',
        gmailId: 'g9',
        subject: 'Pending bodies',
        bodyText: 'must be ignored',
        bodyState: 'missing'
      })
    ])
    expect(db.countMissingBodies('a')).toBe(1)
    expect(db.getMessageWire('a', 'g9')?.bodyText).toBe('')
    expect(db.searchMessages('pending')).toHaveLength(1)
    expect(db.searchMessages('ignored')).toHaveLength(0)

    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'g9', subject: 'Pending bodies', bodyText: 'now arrived' })
    ])
    expect(db.countMissingBodies('a')).toBe(0)
    expect(db.getMessageWire('a', 'g9')?.bodyText).toBe('now arrived')
    expect(db.searchMessages('arrived')).toHaveLength(1)
    // a second metadata-only upsert does not blank the body again
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'g9', bodyText: '', bodyState: 'missing', seen: true })
    ])
    expect(db.getMessageWire('a', 'g9')).toMatchObject({ bodyText: 'now arrived', seen: true })
  })

  it('removes an account’s rows from the index with the account', () => {
    db.deleteAccount('a')
    expect(db.countIndexed()).toBe(1)
    expect(ids(db.searchMessages('budget'))).toEqual(['g3'])
  })

  it('lists missing bodies newest first, per account and per thread', () => {
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'm1', threadId: 'T', dateMs: 1000, bodyState: 'missing' }),
      record({ accountId: 'a', gmailId: 'm2', threadId: 'T', dateMs: 3000, bodyState: 'missing' }),
      record({ accountId: 'a', gmailId: 'm3', threadId: 'U', dateMs: 2000, bodyState: 'missing' }),
      record({ accountId: 'b', gmailId: 'm4', threadId: 'T', dateMs: 4000, bodyState: 'missing' })
    ])
    expect(db.listMissingBodyIds('a', 10)).toEqual(['m2', 'm3', 'm1'])
    expect(db.listMissingBodyIds('a', 2)).toEqual(['m2', 'm3'])
    expect(db.listMissingBodyIdsInThread('a', 'T').sort()).toEqual(['m1', 'm2'])
    expect(db.countMissingBodies('b')).toBe(1)
  })
})

// ---------- migration v2 → v3 ----------

describe('initDb migration v2 -> v3', () => {
  it('adds codec/state columns, builds the index over TEXT bodies, and vacuums', () => {
    const path = freshPath()
    const rows: V2Row[] = []
    for (let i = 0; i < 300; i++) {
      rows.push({ gmail_id: `g${i}`, body_text: `filler ${i} `.repeat(500) })
    }
    rows.push({ gmail_id: 'html-only', body_text: '', body_html: '<p>Hidden in <b>HTML</b></p>' })
    buildV2(path, rows)
    // Leave free pages behind, the way a table rebuild does
    const raw = new Database(path)
    raw
      .prepare(
        "DELETE FROM messages WHERE gmail_id LIKE 'g%' AND CAST(substr(gmail_id, 2) AS INTEGER) >= 20"
      )
      .run()
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    raw.close()
    expect(pragma(path, 'freelist_count')).toBeGreaterThan(0)

    db.initDb(path)

    expect(pragma(path, 'user_version')).toBe(3)
    expect(pragma(path, 'freelist_count')).toBe(0)
    const after = rawRows(path)
    expect(after).toHaveLength(21)
    expect(after.every((r) => r.body_codec === 'none' && r.body_state === 'full')).toBe(true)
    expect(after.every((r) => typeof r.body_text === 'string')).toBe(true)
    // the index covers every migrated row and reads still work
    expect(db.countIndexed()).toBe(21)
    expect(db.searchMessages('filler')).toHaveLength(20)
    expect(db.searchMessages('"filler 7"')).toHaveLength(1)
    expect(db.getMessageWire('a', 'g7')?.bodyText.startsWith('filler 7 ')).toBe(true)
    expect(db.getMessageWire('a', 'html-only')?.bodyHtml).toBe('<p>Hidden in <b>HTML</b></p>')
    // HTML-only mail is not body-searchable until the compactor derives its text
    expect(db.searchMessages('hidden')).toHaveLength(0)
    expect(db.countUncompacted()).toBe(21)
  })

  it('is idempotent and leaves a fresh store with nothing to compact', () => {
    const path = freshPath()
    buildV2(path, [{ gmail_id: 'g1' }])
    db.initDb(path)
    const first = rawRows(path)
    db.closeDb()
    db.initDb(path)
    expect(rawRows(path)).toEqual(first)
    expect(db.countIndexed()).toBe(1)
    db.closeDb()

    db.initDb(':memory:')
    expect(db.countUncompacted()).toBe(0)
  })

  it('writes new rows compressed on the current codec', () => {
    const path = freshPath()
    db.initDb(path)
    createAccount('a')
    db.upsertMessages([
      record({ accountId: 'a', gmailId: 'n1', bodyText: 'fresh', bodyHtml: '<p>fresh</p>' })
    ])
    const [row] = rawRows(path)
    expect(row.body_codec).toBe('zstd')
    expect(Buffer.isBuffer(row.body_text)).toBe(true)
    expect(Buffer.isBuffer(row.body_html)).toBe(true)
    expect(db.getMessageWire('a', 'n1')).toMatchObject({
      bodyText: 'fresh',
      bodyHtml: '<p>fresh</p>'
    })
    expect(db.countUncompacted()).toBe(0)
  })

  it('refuses an SQLite older than 3.43', () => {
    expect(() => db.assertSqliteVersion('3.42.0')).toThrow(/3\.43\.0 or newer/)
    expect(() => db.assertSqliteVersion('3.9.9')).toThrow()
    expect(() => db.assertSqliteVersion('3.43.0')).not.toThrow()
    expect(() => db.assertSqliteVersion('3.53.4')).not.toThrow()
    expect(() => db.assertSqliteVersion('4.0.0')).not.toThrow()
  })

  it('never lowers a user_version written by a newer build', () => {
    const path = freshPath()
    db.initDb(path)
    db.closeDb()
    const raw = new Database(path)
    raw.pragma('user_version = 99')
    raw.close()
    db.initDb(path)
    expect(pragma(path, 'user_version')).toBe(99)
  })
})

// ---------- compactor ----------

describe('compactor', () => {
  function migrated(count: number): string {
    const path = freshPath()
    const rows: V2Row[] = []
    for (let i = 0; i < count; i++) {
      rows.push({
        gmail_id: `g${i}`,
        body_text: `text ${i} `.repeat(50),
        body_html: i % 2 === 0 ? `<p>html ${i}</p>`.repeat(50) : null
      })
    }
    rows.push({ gmail_id: 'html-only', body_text: '', body_html: '<p>Hidden in <b>HTML</b></p>' })
    rows.push({
      gmail_id: 'stub',
      body_text: 'View online',
      body_html: '<h1>Real content of the mail</h1>'
    })
    buildV2(path, rows)
    db.initDb(path)
    return path
  }

  it('compresses every legacy row in batches, keeps reads identical, and is idempotent', () => {
    const path = migrated(10)
    const before = db.queryWindow(100).map((m) => [m.gmailId, m.bodyText, m.bodyHtml])
    const lines: string[] = []
    const job = createCompactor({ batchSize: 3, log: (l) => lines.push(l) })

    const first = job.runOnce()
    expect(first).toMatchObject({ processed: 3, remaining: 9 })
    expect(rawRows(path).filter((r) => r.body_codec === 'zstd')).toHaveLength(3)

    expect(job.runToCompletion()).toBe(9)
    const rows = rawRows(path)
    expect(rows.every((r) => r.body_codec === 'zstd')).toBe(true)
    expect(rows.every((r) => Buffer.isBuffer(r.body_text))).toBe(true)
    expect(
      rows.filter((r) => r.body_html !== null).every((r) => Buffer.isBuffer(r.body_html))
    ).toBe(true)
    expect(db.countUncompacted()).toBe(0)
    const status = job.status()
    expect(status).toMatchObject({ processed: 12, remaining: 0, textDerived: 2, error: null })
    expect(status.bytesAfter).toBeLessThan(status.bytesBefore)

    // Reads are unchanged except where text was derived from HTML
    const after = db.queryWindow(100).map((m) => [m.gmailId, m.bodyText, m.bodyHtml])
    const derived = new Set(['html-only', 'stub'])
    expect(after.filter((r) => !derived.has(r[0] as string))).toEqual(
      before.filter((r) => !derived.has(r[0] as string))
    )
    expect(db.getMessageWire('a', 'html-only')?.bodyText).toBe('Hidden in HTML')
    expect(db.getMessageWire('a', 'stub')?.bodyText).toBe('Real content of the mail')
    expect(db.searchMessages('hidden')).toHaveLength(1)
    expect(db.searchMessages('"real content"')).toHaveLength(1)
    expect(db.searchMessages('"text 3"')).toHaveLength(1)
    expect(db.countIndexed()).toBe(12)

    // Nothing left: a second pass touches nothing
    expect(job.runToCompletion()).toBe(0)
    expect(rawRows(path)).toEqual(rows)
  })

  it('runs on a timer from start() until done, then reports and stops', () => {
    vi.useFakeTimers()
    try {
      migrated(7)
      const lines: string[] = []
      const job = createCompactor({
        batchSize: 2,
        intervalMs: 10,
        initialDelayMs: 100,
        logEveryMs: 0,
        log: (l) => lines.push(l)
      })
      job.start()
      expect(job.status().running).toBe(true)
      expect(job.status().remaining).toBe(9)
      vi.advanceTimersByTime(50)
      expect(db.countUncompacted()).toBe(9) // initial delay not elapsed
      vi.advanceTimersByTime(50)
      expect(db.countUncompacted()).toBe(7)
      vi.advanceTimersByTime(1000)
      expect(db.countUncompacted()).toBe(0)
      expect(job.status()).toMatchObject({ running: false, processed: 9, remaining: 0 })
      expect(lines[0]).toMatch(/9 rows to compact/)
      expect(lines.at(-1)).toMatch(/done: 9 rows, 0 left/)
      // start() again is a no-op with a log line
      job.start()
      expect(job.status().running).toBe(false)
      expect(lines.at(-1)).toBe('[compactor] nothing to compact')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() halts the timer and start() resumes where the rows are', () => {
    vi.useFakeTimers()
    try {
      migrated(4)
      const job = createCompactor({
        batchSize: 2,
        intervalMs: 10,
        initialDelayMs: 0,
        log: () => undefined
      })
      job.start()
      vi.advanceTimersByTime(1)
      expect(db.countUncompacted()).toBe(4)
      job.stop()
      vi.advanceTimersByTime(1000)
      expect(db.countUncompacted()).toBe(4)
      expect(job.status().running).toBe(false)
      job.start()
      vi.advanceTimersByTime(1000)
      expect(db.countUncompacted()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops and records the error when a batch throws', () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      const job = createCompactor({
        initialDelayMs: 0,
        intervalMs: 10,
        countRemaining: () => 5,
        runBatch: () => {
          throw new Error('disk full')
        },
        log: (l) => lines.push(l)
      })
      job.start()
      vi.advanceTimersByTime(1)
      expect(job.status()).toMatchObject({ running: false, error: 'disk full' })
      expect(lines.at(-1)).toMatch(/stopped on error: disk full/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a v3 migration re-run over compressed rows (older build wrote user_version 2) keeps the index whole', () => {
    const path = migrated(5)
    createCompactor({ log: () => undefined }).runToCompletion()
    expect(rawRows(path).every((r) => r.body_codec === 'zstd')).toBe(true)
    db.closeDb()
    const raw = new Database(path)
    raw.pragma('user_version = 2')
    raw.close()

    db.initDb(path)
    expect(pragma(path, 'user_version')).toBe(3)
    expect(rawRows(path).every((r) => r.body_codec === 'zstd')).toBe(true)
    expect(db.countIndexed()).toBe(7)
    expect(db.searchMessages('"text 3"')).toHaveLength(1)
    expect(db.searchMessages('hidden')).toHaveLength(1)
    expect(db.getMessageWire('a', 'g3')?.bodyText.startsWith('text 3 ')).toBe(true)
  })

  it('the pages compaction frees are reclaimed by a vacuum at the next start', () => {
    const path = freshPath()
    const rows: V2Row[] = []
    for (let i = 0; i < 600; i++) rows.push({ gmail_id: `g${i}`, body_text: `${i} `.repeat(8000) })
    buildV2(path, rows)
    db.initDb(path)
    createCompactor({ log: () => undefined }).runToCompletion()
    db.closeDb()
    const freeBefore = pragma(path, 'freelist_count')
    const pagesBefore = pragma(path, 'page_count')
    expect(freeBefore * 4096).toBeGreaterThan(8 * 1024 * 1024)
    expect(freeBefore / pagesBefore).toBeGreaterThan(0.25)

    db.initDb(path)
    expect(pragma(path, 'freelist_count')).toBe(0)
    expect(pragma(path, 'page_count')).toBeLessThan(pagesBefore / 2)
    expect(db.getMessageWire('a', 'g599')?.bodyText.startsWith('599 599 ')).toBe(true)
    expect(db.countIndexed()).toBe(600)
  })
})
