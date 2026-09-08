import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as db from '../db'
import { GmailError } from '../google/gmail'
import { syncEngine } from '../sync'
import { createAccount, fakeGmail, parsed, record, type FakeGmail } from './helpers'

const A = 'acct'
let api: FakeGmail

/** Remote mailbox as label listings: which ids carry which label */
function remote(all: string[], labels: Record<string, string[]>): void {
  api.script('listAllMessageIds', async (labelIds?: string[]) => {
    if (!labelIds) return new Set(all)
    return new Set(labelIds.flatMap((l) => labels[l] ?? []))
  })
}

beforeEach(() => {
  db.initDb(':memory:')
  createAccount(A)
  db.setHistoryId(A, 'old-anchor')
  api = fakeGmail()
  // The engine builds a real GmailApi per account on demand; seed its cache instead
  syncEngine['apis'].set(A, api)
  api.script('listHistory', async () => {
    throw new GmailError(404, 'history expired')
  })
  api.script('getProfile', async () => ({
    emailAddress: 'me@example.com',
    historyId: 'new-anchor'
  }))
  api.script('getMessage', async (id: string) =>
    parsed({ gmailId: id, folder: 'inbox', seen: false, subject: `fetched ${id}` })
  )
})

afterEach(() => {
  syncEngine['apis'].delete(A)
  db.closeDb()
})

function seedLocal(): void {
  db.upsertMessages([
    record({ accountId: A, gmailId: 'g1', folder: 'inbox', seen: false, flagged: false }),
    record({ accountId: A, gmailId: 'g2', folder: 'inbox', seen: true }),
    record({ accountId: A, gmailId: 'g3', folder: 'archive', seen: true, important: false })
  ])
}

describe('history-expired full resync', () => {
  it('reconciles deletions, label state and new mail, then commits the new anchor', async () => {
    seedLocal()
    // g2 is gone remotely; g4 and g5 are new; g1 was read and archived; g3 got starred+important
    remote(['g1', 'g3', 'g4', 'g5'], {
      INBOX: ['g4', 'g5'],
      UNREAD: ['g4'],
      STARRED: ['g3'],
      IMPORTANT: ['g3']
    })

    await syncEngine.deltaAll()

    expect(db.listGmailIds(A).sort()).toEqual(['g1', 'g3', 'g4', 'g5'])
    expect(db.getMessageWire(A, 'g1')).toMatchObject({ folder: 'archive', seen: true })
    expect(db.getMessageWire(A, 'g3')).toMatchObject({
      folder: 'archive',
      seen: true,
      flagged: true,
      important: true
    })
    expect(db.getMessageWire(A, 'g4')).toMatchObject({ subject: 'fetched g4', folder: 'inbox' })
    expect(db.getMessageWire(A, 'g5')).toMatchObject({ subject: 'fetched g5' })
    // Only the missing ids are fetched; held messages are relabelled from listings
    expect(
      api.calls
        .filter((c) => c.method === 'getMessage')
        .map((c) => c.args[0])
        .sort()
    ).toEqual(['g4', 'g5'])
    expect(db.getHistoryId(A)).toBe('new-anchor')
  })

  it('consults every state label listing and derives the folder from their precedence', async () => {
    db.upsertMessages([
      record({ accountId: A, gmailId: 'a', folder: 'inbox' }),
      record({ accountId: A, gmailId: 'b', folder: 'inbox' }),
      record({ accountId: A, gmailId: 'c', folder: 'inbox' }),
      record({ accountId: A, gmailId: 'd', folder: 'inbox' }),
      record({ accountId: A, gmailId: 'e', folder: 'archive' })
    ])
    remote(['a', 'b', 'c', 'd', 'e'], {
      INBOX: ['a', 'b', 'c', 'd', 'e'],
      DRAFT: ['a'],
      SPAM: ['b'],
      TRASH: ['c'],
      SENT: ['e']
    })
    await syncEngine.deltaAll()

    const labelArgs = api.calls
      .filter((c) => c.method === 'listAllMessageIds')
      .map((c) => (c.args[0] as string[] | undefined)?.[0] ?? '*')
    expect(labelArgs.sort()).toEqual(
      ['*', 'INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'DRAFT', 'SENT'].sort()
    )
    expect(db.getMessageWire(A, 'a')?.folder).toBe('drafts')
    expect(db.getMessageWire(A, 'b')?.folder).toBe('spam')
    expect(db.getMessageWire(A, 'c')?.folder).toBe('trash')
    expect(db.getMessageWire(A, 'd')?.folder).toBe('inbox')
    expect(db.getMessageWire(A, 'e')?.folder).toBe('inbox')
  })

  it('captures the anchor before listing so nothing changing mid-pass is skipped', async () => {
    seedLocal()
    remote(['g1', 'g2', 'g3'], { INBOX: ['g1', 'g2'] })
    await syncEngine.deltaAll()
    const order = api.called()
    expect(order.indexOf('getProfile')).toBeLessThan(order.indexOf('listAllMessageIds'))
    expect(db.getHistoryId(A)).toBe('new-anchor')
  })

  it('leaves local rows that have no Gmail id alone', async () => {
    seedLocal()
    db.putLocalMessage(
      {
        accountId: A,
        messageIdHdr: '<draft@flint.local>',
        to: [],
        cc: [],
        subject: 'unsent',
        text: 'body',
        references: []
      },
      { name: 'Me', address: 'me@example.com' },
      'draft',
      'drafts',
      null
    )
    remote(['g1', 'g2', 'g3'], { INBOX: ['g1', 'g2'] })
    await syncEngine.deltaAll()
    expect(db.getLocalMessage(A, '<draft@flint.local>')?.state).toBe('draft')
    expect(db.countMessages(A)).toBe(4)
  })

  it('keeps the old anchor when fetching new mail fails', async () => {
    seedLocal()
    remote(['g1', 'g3', 'g4'], { INBOX: ['g1', 'g3', 'g4'] })
    api.script('getMessage', async () => {
      throw new GmailError(500, 'backend error')
    })

    await syncEngine.deltaAll()

    expect(db.getHistoryId(A)).toBe('old-anchor')
    // The steps before the failure have already been applied
    expect(db.listGmailIds(A).sort()).toEqual(['g1', 'g3'])
    expect(db.getMessageWire(A, 'g3')?.folder).toBe('inbox')
  })

  it('keeps the old anchor when a label listing fails', async () => {
    seedLocal()
    api.script('listAllMessageIds', async (labelIds?: string[]) => {
      if (labelIds?.[0] === 'STARRED') throw new GmailError(503, 'unavailable')
      return new Set(labelIds ? [] : ['g1', 'g2', 'g3'])
    })
    await syncEngine.deltaAll()
    expect(db.getHistoryId(A)).toBe('old-anchor')
    expect(api.called()).not.toContain('getMessage')
  })

  it('keeps the old anchor when the profile call fails', async () => {
    seedLocal()
    api.script('getProfile', async () => {
      throw new GmailError(0, 'offline')
    })
    await syncEngine.deltaAll()
    expect(db.getHistoryId(A)).toBe('old-anchor')
    expect(db.listGmailIds(A).sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('rethrows non-404 history errors instead of resyncing', async () => {
    seedLocal()
    api.script('listHistory', async () => {
      throw new GmailError(401, 'unauthorized')
    })
    await expect(syncEngine['deltaInner'](A)).rejects.toMatchObject({ status: 401 })
    expect(api.called()).toEqual(['listHistory'])
    expect(db.getHistoryId(A)).toBe('old-anchor')
    expect(db.listGmailIds(A).sort()).toEqual(['g1', 'g2', 'g3'])
  })

  it('is skipped for an account with no anchor', async () => {
    createAccount('fresh', 'fresh@example.com')
    const freshApi = fakeGmail()
    syncEngine['apis'].set('fresh', freshApi)
    await syncEngine.deltaAll()
    expect(freshApi.called()).toEqual([])
    syncEngine['apis'].delete('fresh')
  })
})

describe('delta sync', () => {
  it('applies adds, deletes and label changes from history and advances the anchor', async () => {
    seedLocal()
    api.script('listHistory', async () => ({
      historyId: 'h-next',
      history: [
        {
          messagesAdded: [{ id: 'g9' }],
          messagesDeleted: [{ id: 'g2' }],
          labelChanges: [
            { id: 'g1', labelIds: ['STARRED'] },
            { id: 'unknown', labelIds: ['INBOX'] }
          ]
        }
      ]
    }))
    await syncEngine.deltaAll()
    expect(api.calls.find((c) => c.method === 'listHistory')?.args[0]).toBe('old-anchor')
    expect(db.listGmailIds(A).sort()).toEqual(['g1', 'g3', 'g9'])
    expect(db.getMessageWire(A, 'g1')).toMatchObject({
      folder: 'archive',
      flagged: true,
      seen: true
    })
    expect(db.getHistoryId(A)).toBe('h-next')
  })
})
