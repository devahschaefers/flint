import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from '../db'
import * as q from '../queries'
import type { ThreadCursor } from '../../preload/index.d'
import { createAccount, record } from './helpers'

const A = 'acct'
const B = 'acct-b'
const ME = 'me@example.com'

/** A message in thread `th` with per-test overrides */
function msg(
  gmailId: string,
  th: string,
  over: Partial<Parameters<typeof record>[0]> = {}
): ReturnType<typeof record> {
  return record({ accountId: A, gmailId, threadId: th, ...over })
}

beforeEach(() => {
  db.initDb(':memory:')
  createAccount(A, ME)
})

afterEach(() => {
  db.closeDb()
})

const inbox = { kind: 'inbox' as const, includeArchived: false }

describe('listThreads', () => {
  it('groups messages into conversations with aggregate state and the newest message on top', () => {
    db.upsertMessages([
      msg('m1', 'T1', { dateMs: 1000, seen: true, subject: 'Hello' }),
      msg('m2', 'T1', {
        dateMs: 3000,
        seen: false,
        subject: 'Re: Hello',
        fromAddr: 'other@x.com',
        fromName: 'Other'
      }),
      msg('m3', 'T2', { dateMs: 2000, seen: true, flagged: true, subject: 'Solo' })
    ])
    const page = q.listThreads({ accountId: A, view: inbox, limit: 50 })
    expect(page.nextCursor).toBeNull()
    expect(page.threads.map((t) => t.threadKey)).toEqual(['T1', 'T2'])
    const t1 = page.threads[0]
    expect(t1).toMatchObject({
      accountId: A,
      count: 2,
      unread: 1,
      flagged: false,
      subject: 'Re: Hello',
      latestDateMs: 3000,
      folders: { inbox: 2, archive: 0, sent: 0, drafts: 0, trash: 0, spam: 0 }
    })
    expect(t1.latest.from).toEqual({ name: 'Other', address: 'other@x.com' })
    expect(t1.counterpart).toEqual({ name: 'Other', address: 'other@x.com' })
    expect(page.threads[1].flagged).toBe(true)
  })

  it("counterpart skips the user's own addresses and is null on a pure sent thread", () => {
    db.upsertMessages([
      msg('s1', 'T1', {
        dateMs: 1000,
        fromAddr: 'friend@x.com',
        fromName: 'Friend',
        folder: 'inbox'
      }),
      msg('s2', 'T1', { dateMs: 2000, fromAddr: ME, fromName: 'Me', folder: 'sent' }),
      msg('s3', 'T2', {
        dateMs: 3000,
        fromAddr: ME,
        fromName: 'Me',
        folder: 'sent',
        to: [{ address: 'you@x.com' }]
      })
    ])
    const page = q.listThreads({ accountId: A, view: inbox, limit: 50 })
    expect(page.threads).toHaveLength(1) // T2 has nothing in the inbox
    expect(page.threads[0].counterpart).toEqual({ name: 'Friend', address: 'friend@x.com' })
    const sent = q.listThreads({
      accountId: A,
      view: { kind: 'folder', folder: 'sent' },
      limit: 50
    })
    const t2 = sent.threads.find((t) => t.threadKey === 'T2')
    expect(t2?.counterpart).toBeNull()
    expect(t2?.latest.to).toEqual([{ address: 'you@x.com' }])
  })

  it('inbox hides fully archived threads unless includeArchived', () => {
    db.upsertMessages([
      msg('a1', 'T1', { folder: 'archive' }),
      msg('a2', 'T2', { folder: 'inbox' }),
      msg('a3', 'T3', { dateMs: 1, folder: 'inbox' }),
      msg('a4', 'T3', { dateMs: 2, folder: 'archive' })
    ])
    const hidden = q.listThreads({ accountId: A, view: inbox, limit: 50 })
    expect(hidden.threads.map((t) => t.threadKey).sort()).toEqual(['T2', 'T3'])
    const shown = q.listThreads({
      accountId: A,
      view: { ...inbox, includeArchived: true },
      limit: 50
    })
    expect(shown.threads.map((t) => t.threadKey).sort()).toEqual(['T1', 'T2', 'T3'])
  })

  it('splits the smart inbox into category groups and important threads', () => {
    db.upsertMessages([
      msg('c1', 'T1', { category: 'people', important: false }),
      msg('c2', 'T2', { category: 'notifications', important: false }),
      msg('c3', 'T3', { category: 'people', important: true }),
      msg('c4', 'T4', { dateMs: 1, category: 'notifications', important: false }),
      msg('c5', 'T4', { dateMs: 2, category: 'people', important: false }) // latest decides
    ])
    const people = q.listThreads({
      accountId: A,
      view: { ...inbox, category: 'people' },
      limit: 50
    })
    expect(people.threads.map((t) => t.threadKey).sort()).toEqual(['T1', 'T4'])
    const important = q.listThreads({
      accountId: A,
      view: { ...inbox, importantOnly: true },
      limit: 50
    })
    expect(important.threads.map((t) => t.threadKey)).toEqual(['T3'])
  })

  it('pins are flagged threads outside trash and spam; folders show threads with any message there', () => {
    db.upsertMessages([
      msg('p1', 'T1', { flagged: true, folder: 'inbox' }),
      msg('p2', 'T2', { flagged: true, folder: 'trash' }),
      msg('p3', 'T3', { flagged: false, folder: 'spam' })
    ])
    expect(
      q
        .listThreads({ accountId: A, view: { kind: 'pins' }, limit: 50 })
        .threads.map((t) => t.threadKey)
    ).toEqual(['T1'])
    expect(
      q
        .listThreads({ accountId: A, view: { kind: 'folder', folder: 'trash' }, limit: 50 })
        .threads.map((t) => t.threadKey)
    ).toEqual(['T2'])
    expect(
      q
        .listThreads({ accountId: A, view: { kind: 'folder', folder: 'spam' }, limit: 50 })
        .threads.map((t) => t.threadKey)
    ).toEqual(['T3'])
  })

  it('pages with a keyset cursor, newest first, without gaps or repeats', () => {
    db.upsertMessages(
      Array.from({ length: 7 }, (_, i) => msg(`k${i}`, `T${i}`, { dateMs: 1000 + (i % 3) * 10 }))
    )
    const seen: string[] = []
    let cursor: ThreadCursor | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page = q.listThreads({ accountId: A, view: inbox, cursor, limit: 3 })
      seen.push(...page.threads.map((t) => t.threadKey))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    const dates = seen.map((k) => Number(k.slice(1)) % 3)
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
  })

  it('merges accounts by date when accountId is null', () => {
    createAccount(B, 'b@example.com')
    db.upsertMessages([
      msg('x1', 'T1', { dateMs: 1 }),
      record({ accountId: B, gmailId: 'y1', threadId: 'T1', dateMs: 2 })
    ])
    const page = q.listThreads({ accountId: null, view: inbox, limit: 50 })
    expect(page.threads.map((t) => [t.accountId, t.threadKey])).toEqual([
      [B, 'T1'],
      [A, 'T1']
    ])
  })

  it('local mail without a Gmail thread is its own conversation keyed by Message-ID', () => {
    db.putLocalMessage(
      {
        accountId: A,
        messageIdHdr: '<local@flint.local>',
        to: [{ address: 'you@x.com' }],
        cc: [],
        subject: 'Out',
        text: 'body',
        references: []
      },
      { name: 'Me', address: ME },
      'queued',
      'sent',
      Date.now()
    )
    const page = q.listThreads({
      accountId: A,
      view: { kind: 'folder', folder: 'sent' },
      limit: 50
    })
    expect(page.threads[0]).toMatchObject({ threadKey: '<local@flint.local>', count: 1 })
    expect(page.threads[0].latest.state).toBe('queued')
    expect(db.queryThread(A, '<local@flint.local>')).toHaveLength(1)
  })
})

describe('inboxOverview', () => {
  it('buckets non-important inbox threads by category with per-address chips', () => {
    db.upsertMessages([
      msg('o1', 'T1', {
        dateMs: 3,
        category: 'notifications',
        fromAddr: 'news@a.com',
        fromName: 'A News',
        seen: false
      }),
      msg('o2', 'T2', {
        dateMs: 2,
        category: 'notifications',
        fromAddr: 'news@a.com',
        fromName: 'A News',
        seen: true
      }),
      msg('o3', 'T3', {
        dateMs: 1,
        category: 'notifications',
        fromAddr: 'alerts@b.com',
        fromName: 'B',
        seen: true
      }),
      msg('o4', 'T4', { category: 'people', important: true }),
      msg('o5', 'T5', { category: 'people', fromAddr: 'pal@c.com', fromName: 'Pal' })
    ])
    const { groups } = q.inboxOverview(A, false)
    expect(groups.map((g) => g.category)).toEqual(['notifications', 'people'])
    const notif = groups[0]
    expect(notif).toMatchObject({ count: 3, unread: 1 })
    expect(notif.chips).toEqual([
      { mailbox: { name: 'A News', address: 'news@a.com' }, count: 2, unread: true },
      { mailbox: { name: 'B', address: 'alerts@b.com' }, count: 1, unread: false }
    ])
    expect(groups[1]).toMatchObject({ count: 1 }) // the important thread is not a group member
  })
})

describe('searchThreads', () => {
  it('returns one result per conversation, best match first, with the matching message', () => {
    db.upsertMessages([
      msg('f1', 'T1', { subject: 'Invoice for October', bodyText: 'please find attached' }),
      msg('f2', 'T1', { dateMs: 2e12, subject: 'Re: Invoice for October', bodyText: 'thanks' }),
      msg('f3', 'T2', { subject: 'Lunch', bodyText: 'the invoice was wrong' }),
      msg('f4', 'T3', { subject: 'Unrelated', bodyText: 'nothing here' })
    ])
    const hits = q.searchThreads('invoice', A, 50)
    expect(hits.map((h) => h.threadKey)).toEqual(['T1', 'T2'])
    expect(hits[0].match.subject).toMatch(/Invoice/)
    expect(hits[0].count).toBe(2)
    expect(q.searchThreads('"nothing here"', A, 50).map((h) => h.threadKey)).toEqual(['T3'])
    expect(q.searchThreads('   ', A, 50)).toEqual([])
    expect(q.searchThreads('zzz-not-there', A, 50)).toEqual([])
  })
})

describe('contacts and counts', () => {
  it('lists named senders then recipients, excluding own addresses, once per address', () => {
    db.upsertMessages([
      msg('c1', 'T1', {
        fromAddr: 'Ann@x.com',
        fromName: 'Ann',
        to: [{ address: ME, name: 'Me' }]
      }),
      msg('c2', 'T2', {
        fromAddr: ME,
        fromName: 'Me',
        folder: 'sent',
        to: [{ address: 'bob@x.com', name: 'Bob' }]
      }),
      msg('c3', 'T3', { fromAddr: 'ann@x.com', fromName: 'Ann Again' }),
      msg('c4', 'T4', { fromAddr: 'anon@x.com', fromName: null })
    ])
    const contacts = q.listContacts(A)
    expect(contacts.map((c) => c.address).sort()).toEqual(['ann@x.com', 'bob@x.com'])
    expect(contacts.find((c) => c.address === 'ann@x.com')?.name).toMatch(/^Ann/)
  })

  it('counts unread inbox messages per account', () => {
    createAccount(B, 'b@example.com')
    db.upsertMessages([
      msg('u1', 'T1', { seen: false }),
      msg('u2', 'T2', { seen: false, folder: 'archive' }),
      record({ accountId: B, gmailId: 'u3', threadId: 'T3', seen: false })
    ])
    expect(q.unreadCounts().sort((a, b) => a.accountId.localeCompare(b.accountId))).toEqual([
      { accountId: A, inboxUnread: 1 },
      { accountId: B, inboxUnread: 1 }
    ])
  })
})

describe('resolveThreadAction', () => {
  const ref = { accountId: A, threadKey: 'T1' }

  it('toggleArchive archives what is in the inbox, or restores what is archived', () => {
    db.upsertMessages([
      msg('r1', 'T1', { folder: 'inbox' }),
      msg('r2', 'T1', { folder: 'archive' }),
      msg('r3', 'T1', { folder: 'sent' })
    ])
    expect(q.resolveThreadAction(ref, 'toggleArchive')).toEqual([
      { action: 'archive', gmailIds: ['r1'] }
    ])
    db.applyLocalAction(A, ['r1'], 'archive')
    expect(q.resolveThreadAction(ref, 'toggleArchive')).toEqual([
      { action: 'unarchive', gmailIds: ['r1', 'r2'] }
    ])
  })

  it('flag/seen toggles look at the whole conversation; markSeen touches only unread', () => {
    db.upsertMessages([
      msg('r1', 'T1', { seen: true, flagged: false }),
      msg('r2', 'T1', { seen: false, flagged: true })
    ])
    expect(q.resolveThreadAction(ref, 'toggleFlagged')).toEqual([
      { action: 'flagged', value: false, gmailIds: ['r1', 'r2'] }
    ])
    expect(q.resolveThreadAction(ref, 'toggleSeen')).toEqual([
      { action: 'seen', value: true, gmailIds: ['r1', 'r2'] }
    ])
    expect(q.resolveThreadAction(ref, 'markSeen')).toEqual([
      { action: 'seen', value: true, gmailIds: ['r2'] }
    ])
    db.applyLocalAction(A, ['r2'], 'seen', true)
    expect(q.resolveThreadAction(ref, 'markSeen')).toEqual([])
  })

  it('moves skip sent and draft messages and ignore local-only rows', () => {
    db.upsertMessages([
      msg('r1', 'T1', { folder: 'inbox' }),
      msg('r2', 'T1', { folder: 'sent' }),
      msg('r3', 'T1', { folder: 'drafts' })
    ])
    expect(q.resolveThreadAction(ref, 'trash')).toEqual([{ action: 'trash', gmailIds: ['r1'] }])
    expect(q.resolveThreadAction({ accountId: A, threadKey: 'nope' }, 'trash')).toEqual([])
  })
})
