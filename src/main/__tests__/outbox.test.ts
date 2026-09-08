import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as db from '../db'
import { GmailError } from '../google/gmail'
import { Outbox } from '../outbox'
import type { LocalMessageInput } from '../../preload/index.d'
import { createAccount, fakeGmail, parsed, record, wire, type FakeGmail } from './helpers'

const A = 'acct'
const B = 'other'
let api: FakeGmail
let apiB: FakeGmail
let outbox: Outbox

beforeEach(() => {
  // Date is faked so undo windows and backoff can be stepped through; the
  // outbox's own wake timers never fire unless a test advances the clock.
  // Node streams (used by the MIME builder) stay on the real nextTick.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
  db.initDb(':memory:')
  createAccount(A)
  api = fakeGmail()
  apiB = fakeGmail()
  outbox = new Outbox((id) => (id === A ? api : apiB))
})

afterEach(() => {
  db.closeDb()
  vi.useRealTimers()
})

const drain = (): Promise<void> => outbox['drain']()
const ops = (): db.OpRow[] => db.listOps()
const local = (hdr: string): db.LocalMessage | null => db.getLocalMessage(A, hdr)

function input(over: Partial<LocalMessageInput> = {}): LocalMessageInput {
  return {
    accountId: A,
    to: [{ address: 'you@example.com' }],
    cc: [],
    subject: 'hi',
    text: 'hello there',
    references: [],
    ...over
  }
}

function rejectWith(status: number, message = `status ${status}`): () => Promise<never> {
  return async () => {
    throw new GmailError(status, message)
  }
}

describe('queueSend', () => {
  it('persists a queued row and a send op, and does not send before sendAfter', async () => {
    const due = Date.now() + 5000
    const hdr = outbox.queueSend(input(), due)

    expect(hdr).toMatch(/^<.+@flint\.local>$/)
    expect(local(hdr)).toMatchObject({ state: 'queued', sendAfter: due, gmailId: null })
    expect(wire(A, hdr)?.folder).toBe('sent')
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({
      kind: 'send',
      state: 'pending',
      attempts: 0,
      nextAttemptAt: due,
      payload: { messageIdHdr: hdr }
    })

    await drain()
    expect(api.called()).toEqual([])
    expect(local(hdr)?.state).toBe('queued')

    vi.advanceTimersByTime(5001)
    await drain()
    expect(api.called()).toContain('send')
    expect(ops()).toEqual([])
    expect(local(hdr)?.gmailId).toBe('gm-sent')
  })

  it('sends immediately when sendAfter has already passed', async () => {
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(api.called().filter((m) => m === 'send')).toHaveLength(1)
    const [raw, threadId] = api.calls.find((c) => c.method === 'send')!.args as [Buffer, unknown]
    expect(raw.toString()).toContain(`Message-ID: ${hdr}`)
    expect(threadId).toBeUndefined()
    expect(local(hdr)?.threadId).toBe('th-sent')
  })

  it('sending a draft that arrived via sync deletes the Gmail draft by its message id', async () => {
    // A synced draft carries Gmail's draft *message* id but no draft id
    db.upsertMessages([
      record({
        accountId: A,
        gmailId: 'draft-msg',
        messageIdHdr: '<synced-draft@flint.local>',
        folder: 'drafts'
      })
    ])
    db.setLocalState(A, '<synced-draft@flint.local>', { state: 'draft' })
    const hdr = outbox.queueSend(input({ messageIdHdr: '<synced-draft@flint.local>' }), Date.now())
    api.script('findDraftIdForMessage', async () => 'r-draft')
    await drain()
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailId: 'gm-sent', gmailDraftId: null })
    const del = api.calls.find((c) => c.method === 'deleteDraft')
    expect(del?.args).toEqual(['r-draft'])
    expect(api.calls.find((c) => c.method === 'findDraftIdForMessage')?.args).toEqual(['draft-msg'])
    expect(ops()).toEqual([])
  })

  it('parks a send Gmail rejects (4xx) as failed', async () => {
    api.script('send', rejectWith(400, 'Invalid To header'))
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()

    expect(local(hdr)).toMatchObject({ state: 'failed' })
    expect(wire(A, hdr)?.sendError).toBe('Invalid To header')
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({
      kind: 'send',
      state: 'failed',
      attempts: 1,
      lastError: 'Invalid To header'
    })

    // Parked ops are not retried on their own
    vi.advanceTimersByTime(60 * 60_000)
    await drain()
    expect(api.called().filter((m) => m === 'send')).toHaveLength(1)
  })

  it.each([0, 429, 503])(
    'defers a send that fails with status %i and keeps it queued',
    async (status) => {
      api.script('send', rejectWith(status, 'flaky'))
      const before = Date.now()
      const hdr = outbox.queueSend(input(), before)
      await drain()

      expect(local(hdr)?.state).toBe('queued')
      expect(wire(A, hdr)?.sendError).toBe('flaky')
      expect(ops()).toHaveLength(1)
      expect(ops()[0]).toMatchObject({
        kind: 'send',
        state: 'pending',
        attempts: 1,
        lastError: 'flaky'
      })
      expect(ops()[0].nextAttemptAt).toBeGreaterThan(before)

      // Not due yet: a second drain leaves it alone
      await drain()
      expect(api.called().filter((m) => m === 'send')).toHaveLength(1)
    }
  )

  it('also defers on network-level errors (ECONNRESET)', async () => {
    api.script('send', async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    })
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(local(hdr)?.state).toBe('queued')
    expect(ops()[0]).toMatchObject({ state: 'pending', attempts: 1 })
  })

  it('marks the row sent with its Gmail id before reading the copy back', async () => {
    api.script('send', async () => ({ id: 'gm-42', threadId: 'th-42' }))
    let seenDuringReadBack: db.LocalMessage | null = null
    api.script('getMessage', async () => {
      seenDuringReadBack = local(hdr)
      throw new GmailError(500, 'read-back down')
    })
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()

    expect(seenDuringReadBack).toMatchObject({ state: 'sent', gmailId: 'gm-42', threadId: 'th-42' })
    // A failing read-back does not undo the send
    expect(local(hdr)).toMatchObject({
      state: 'sent',
      gmailId: 'gm-42',
      sendAfter: null
    })
    expect(wire(A, hdr)?.sendError).toBeNull()
    expect(ops()).toEqual([])
  })

  it('folds the synced copy onto the same row when read-back succeeds', async () => {
    api.script('send', async () => ({ id: 'gm-42', threadId: 'th-42' }))
    api.script('getMessage', async (id: string) =>
      parsed({ gmailId: id, threadId: 'th-42', messageIdHdr: hdr, folder: 'sent', seen: true })
    )
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(db.countMessages(A)).toBe(1)
    expect(wire(A, hdr)).toMatchObject({ state: 'synced', gmailId: 'gm-42', folder: 'sent' })
  })

  it('asks Gmail for the Message-ID before retrying and never sends twice', async () => {
    api.script('send', rejectWith(503))
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(ops()[0].attempts).toBe(1)

    api.script('findByMessageId', async () => 'gm-9')
    vi.advanceTimersByTime(ops()[0].nextAttemptAt - Date.now() + 1)
    await drain()

    const called = api.called()
    expect(called.filter((m) => m === 'send')).toHaveLength(1)
    expect(called.filter((m) => m === 'findByMessageId')).toHaveLength(1)
    expect(called.indexOf('findByMessageId')).toBeGreaterThan(called.indexOf('send'))
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailId: 'gm-9' })
    expect(ops()).toEqual([])
  })

  it('retries for real when Gmail does not have the message yet', async () => {
    api.script('send', rejectWith(503))
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    api.script('send', async () => ({ id: 'gm-second', threadId: '' }))
    vi.advanceTimersByTime(ops()[0].nextAttemptAt - Date.now() + 1)
    await drain()
    expect(api.called().filter((m) => m === 'findByMessageId')).toHaveLength(1)
    expect(api.called().filter((m) => m === 'send')).toHaveLength(2)
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailId: 'gm-second' })
  })

  it('does not send a row that was deleted or already sent meanwhile', async () => {
    const hdr = outbox.queueSend(input(), Date.now())
    db.setLocalState(A, hdr, { state: 'sent', gmailId: 'gm-elsewhere' })
    await drain()
    expect(api.called()).not.toContain('send')
    expect(ops()).toEqual([])

    const hdr2 = outbox.queueSend(input(), Date.now())
    db.deleteLocalMessage(A, hdr2)
    await drain()
    expect(api.called()).not.toContain('send')
    expect(ops()).toEqual([])
  })

  it('retires the Gmail draft a sent message grew out of', async () => {
    const hdr = outbox.saveDraft(input())
    await drain()
    expect(local(hdr)).toMatchObject({ gmailDraftId: 'dr-1', gmailId: 'gm-dr-1', state: 'draft' })

    outbox.queueSend(input({ messageIdHdr: hdr }), Date.now())
    expect(ops().map((o) => o.kind)).toEqual(['send'])
    await drain()

    // The send enqueues the draft's deletion and the same drain pass runs it
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailDraftId: null })
    expect(api.calls.find((c) => c.method === 'deleteDraft')?.args).toEqual(['dr-1'])
    expect(ops()).toEqual([])
  })

  it('marks the parent answered and puts replies on the parent thread', async () => {
    db.upsertMessages([
      record({ accountId: A, gmailId: 'P', messageIdHdr: '<p@x>', threadId: 'th-P' })
    ])
    outbox.queueSend(
      input({ inReplyTo: '<p@x>', references: ['<p@x>'], threadId: 'th-P' }),
      Date.now()
    )
    expect(db.getMessageWire(A, 'P')?.answered).toBe(true)
    await drain()
    const [, threadId] = api.calls.find((c) => c.method === 'send')!.args
    expect(threadId).toBe('th-P')
  })
})

describe('cancelSend', () => {
  const reply = (): LocalMessageInput =>
    input({ inReplyTo: '<p@x>', references: ['<p@x>'], threadId: 'th-P' })

  beforeEach(() => {
    db.upsertMessages([
      record({ accountId: A, gmailId: 'P', messageIdHdr: '<p@x>', threadId: 'th-P' })
    ])
  })

  it('deletes a queued send and reverts the parent answered flag', async () => {
    const hdr = outbox.queueSend(reply(), Date.now() + 5000)
    expect(db.getMessageWire(A, 'P')?.answered).toBe(true)

    expect(outbox.cancelSend(A, hdr, false)).toBe(true)
    expect(local(hdr)).toBeNull()
    expect(ops()).toEqual([])
    expect(db.getMessageWire(A, 'P')?.answered).toBe(false)

    vi.advanceTimersByTime(6000)
    await drain()
    expect(api.called()).toEqual([])
  })

  it('leaves the parent answered while another own reply still exists', () => {
    const first = outbox.queueSend(reply(), Date.now() + 5000)
    outbox.queueSend(reply(), Date.now() + 5000)
    expect(outbox.cancelSend(A, first, false)).toBe(true)
    expect(db.getMessageWire(A, 'P')?.answered).toBe(true)
    expect(ops()).toHaveLength(1)
  })

  it('turns a queued send into a draft and queues a draft push', async () => {
    const hdr = outbox.queueSend(reply(), Date.now() + 5000)
    expect(outbox.cancelSend(A, hdr, true)).toBe(true)

    expect(local(hdr)).toMatchObject({ state: 'draft', sendAfter: null })
    expect(wire(A, hdr)).toMatchObject({ folder: 'drafts', sendError: null })
    expect(ops().map((o) => o.kind)).toEqual(['draft_put'])
    expect(ops()[0].payload).toEqual({ messageIdHdr: hdr })
    // Only queued/sent replies count as answering; a draft withdraws the flag
    expect(db.getMessageWire(A, 'P')?.answered).toBe(false)

    await drain()
    expect(api.called()).toEqual(['createDraft'])
    const [, threadId] = api.calls[0].args
    expect(threadId).toBe('th-P')
  })

  it('turns a failed send into a draft', async () => {
    api.script('send', rejectWith(400))
    const hdr = outbox.queueSend(reply(), Date.now())
    await drain()
    expect(local(hdr)?.state).toBe('failed')
    expect(outbox.cancelSend(A, hdr, true)).toBe(true)
    expect(local(hdr)?.state).toBe('draft')
    expect(ops().map((o) => o.kind)).toEqual(['draft_put'])
  })

  it('refuses once the send is running, sent, or unknown', async () => {
    const hdr = outbox.queueSend(reply(), Date.now())
    db.markOpRunning(ops()[0].id)
    expect(outbox.cancelSend(A, hdr, false)).toBe(false)
    expect(local(hdr)).not.toBeNull()

    db.resetRunningOps()
    await drain()
    expect(local(hdr)?.state).toBe('sent')
    expect(outbox.cancelSend(A, hdr, false)).toBe(false)
    expect(outbox.cancelSend(A, '<missing@flint.local>', false)).toBe(false)
  })
})

describe('retrySend', () => {
  it('re-queues a failed send for immediate dispatch', async () => {
    api.script('send', rejectWith(400))
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(local(hdr)?.state).toBe('failed')

    api.script('send', async () => ({ id: 'gm-ok', threadId: '' }))
    outbox.retrySend(A, hdr)
    expect(local(hdr)).toMatchObject({ state: 'queued', sendAfter: Date.now() })
    expect(ops()).toHaveLength(1)
    expect(ops()[0]).toMatchObject({ state: 'pending', lastError: null })

    await drain()
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailId: 'gm-ok' })
    // the retried op had attempts > 0, so it verified before sending
    expect(api.called()).toContain('findByMessageId')
  })
})

describe('drafts', () => {
  it('saveDraft coalesces repeated saves into one pending draft_put', async () => {
    const hdr = outbox.saveDraft(input({ subject: 'v1' }))
    outbox.saveDraft(input({ messageIdHdr: hdr, subject: 'v2' }))
    outbox.saveDraft(input({ messageIdHdr: hdr, subject: 'v3' }))

    expect(db.countMessages(A)).toBe(1)
    expect(local(hdr)).toMatchObject({ state: 'draft', subject: 'v3', gmailDraftId: null })
    expect(wire(A, hdr)?.folder).toBe('drafts')
    expect(ops().map((o) => o.kind)).toEqual(['draft_put'])

    await drain()
    expect(api.called()).toEqual(['createDraft'])
    expect(local(hdr)).toMatchObject({
      gmailDraftId: 'dr-1',
      gmailId: 'gm-dr-1',
      threadId: 'th-dr-1'
    })
    expect(ops()).toEqual([])

    // Once pushed, the next save updates the existing Gmail draft
    outbox.saveDraft(input({ messageIdHdr: hdr, subject: 'v4' }))
    await drain()
    expect(api.called()).toEqual(['createDraft', 'updateDraft'])
    expect(api.calls[1].args[0]).toBe('dr-1')
    expect(local(hdr)?.gmailId).toBe('gm-dr-2')
  })

  it('saveDraft over a failed send withdraws it from the send lane', async () => {
    api.script('send', rejectWith(400))
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(ops().map((o) => o.kind)).toEqual(['send'])

    outbox.saveDraft(input({ messageIdHdr: hdr, subject: 'edited' }))
    expect(ops().map((o) => o.kind)).toEqual(['draft_put'])
    expect(local(hdr)).toMatchObject({ state: 'draft', subject: 'edited' })
    expect(wire(A, hdr)?.sendError).toBeNull()
  })

  it('a synced draft without a draft id is looked up before updating', async () => {
    const hdr = outbox.saveDraft(input())
    db.deleteOps(ops().map((o) => o.id))
    db.setLocalState(A, hdr, { gmailId: 'gm-synced-draft' })
    api.script('findDraftIdForMessage', async () => 'dr-found')
    outbox.saveDraft(input({ messageIdHdr: hdr, subject: 'edited' }))
    await drain()
    expect(api.called()).toEqual(['findDraftIdForMessage', 'updateDraft'])
    expect(api.calls[0].args).toEqual(['gm-synced-draft'])
    expect(api.calls[1].args[0]).toBe('dr-found')
    expect(local(hdr)?.gmailDraftId).toBe('dr-found')
  })

  it('deleteLocal on a pushed draft removes the row and queues the Gmail delete', async () => {
    const hdr = outbox.saveDraft(input())
    await drain()
    outbox.deleteLocal(A, hdr)

    expect(local(hdr)).toBeNull()
    expect(ops().map((o) => o.kind)).toEqual(['draft_delete'])
    expect(ops()[0].payload).toEqual({
      messageIdHdr: hdr,
      gmailDraftId: 'dr-1',
      gmailId: 'gm-dr-1'
    })
    await drain()
    expect(api.calls.find((c) => c.method === 'deleteDraft')?.args).toEqual(['dr-1'])
    expect(ops()).toEqual([])
  })

  it('deleteLocal on a never-pushed draft drops the pending push and owes Gmail nothing', () => {
    const hdr = outbox.saveDraft(input())
    expect(ops()).toHaveLength(1)
    outbox.deleteLocal(A, hdr)
    expect(local(hdr)).toBeNull()
    expect(ops()).toEqual([])
  })

  it('deleteLocal on a synced draft finds its draft id from the message id', async () => {
    const hdr = outbox.saveDraft(input())
    db.deleteOps(ops().map((o) => o.id))
    db.setLocalState(A, hdr, { gmailId: 'gm-synced-draft' })
    api.script('findDraftIdForMessage', async () => 'dr-found')
    outbox.deleteLocal(A, hdr)
    expect(ops().map((o) => o.kind)).toEqual(['draft_delete'])
    await drain()
    expect(api.called()).toEqual(['findDraftIdForMessage', 'deleteDraft'])
    expect(api.calls[1].args).toEqual(['dr-found'])
  })

  it('a draft_put for a row that became a send or vanished is a no-op', async () => {
    const hdr = outbox.saveDraft(input())
    db.setLocalState(A, hdr, { state: 'queued' })
    await drain()
    expect(api.called()).toEqual([])
    expect(ops()).toEqual([])
  })
})

describe('label actions', () => {
  beforeEach(() => {
    db.upsertMessages([
      record({ accountId: A, gmailId: 'g1', folder: 'inbox', seen: false }),
      record({ accountId: A, gmailId: 'g2', folder: 'inbox', seen: false })
    ])
  })

  it('mirrors the action locally and pushes the matching label change', async () => {
    outbox.applyAction(A, ['g1', 'g2'], 'archive')
    expect(db.getMessageWire(A, 'g1')?.folder).toBe('archive')
    expect(ops()[0]).toMatchObject({
      kind: 'action',
      payload: { gmailIds: ['g1', 'g2'], action: 'archive', value: null }
    })
    await drain()
    expect(api.calls).toEqual([{ method: 'batchModify', args: [['g1', 'g2'], [], ['INBOX']] }])
    expect(ops()).toEqual([])
  })

  it('runs FIFO per account and a deferred head blocks the lane until it is due', async () => {
    api.script('batchModify', rejectWith(503))
    outbox.applyAction(A, ['g1'], 'archive')
    outbox.applyAction(A, ['g1'], 'seen', true)
    await drain()

    expect(api.calls).toEqual([{ method: 'batchModify', args: [['g1'], [], ['INBOX']] }])
    expect(ops().map((o) => [o.state, o.attempts])).toEqual([
      ['pending', 1],
      ['pending', 0]
    ])
    // the optimistic local state stands while the writeback waits
    expect(db.getMessageWire(A, 'g1')).toMatchObject({ folder: 'archive', seen: true })

    api.script('batchModify', async () => undefined)
    await drain()
    expect(api.calls).toHaveLength(1) // head not due yet, tail still blocked

    vi.advanceTimersByTime(ops()[0].nextAttemptAt - Date.now() + 1)
    await drain()
    expect(api.calls.map((c) => c.args)).toEqual([
      [['g1'], [], ['INBOX']],
      [['g1'], [], ['INBOX']],
      [['g1'], [], ['UNREAD']]
    ])
    expect(ops()).toEqual([])
  })

  it('a failed head parks and blocks the rest of its lane', async () => {
    api.script('batchModify', rejectWith(403, 'forbidden'))
    outbox.applyAction(A, ['g1'], 'archive')
    outbox.applyAction(A, ['g2'], 'flagged', true)
    await drain()
    vi.advanceTimersByTime(60 * 60_000)
    await drain()
    expect(api.calls).toHaveLength(1)
    expect(ops().map((o) => o.state)).toEqual(['failed', 'pending'])
    expect(outbox.listTroubled().map((o) => o.action)).toEqual(['archive'])
  })

  it('a blocked lane in one account does not hold up another account', async () => {
    createAccount(B, 'b@example.com')
    db.upsertMessages([record({ accountId: B, gmailId: 'g9' })])
    api.script('batchModify', rejectWith(503))
    outbox.applyAction(A, ['g1'], 'archive')
    outbox.applyAction(B, ['g9'], 'flagged', true)
    await drain()
    expect(apiB.calls).toEqual([{ method: 'batchModify', args: [['g9'], ['STARRED'], []] }])
    expect(ops().filter((o) => o.accountId === B)).toEqual([])
  })

  it('sends and drafts are not held behind a blocked action lane', async () => {
    api.script('batchModify', rejectWith(503))
    outbox.applyAction(A, ['g1'], 'archive')
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(local(hdr)?.state).toBe('sent')
  })

  it('maps trash and inbox to the per-message Gmail calls', async () => {
    outbox.applyAction(A, ['g1', 'g2'], 'trash')
    await drain()
    expect(api.calls).toEqual([
      { method: 'trash', args: ['g1'] },
      { method: 'trash', args: ['g2'] }
    ])
    expect(db.getMessageWire(A, 'g1')?.folder).toBe('trash')

    api.calls.length = 0
    api.script('untrash', rejectWith(400, 'not in trash'))
    outbox.applyAction(A, ['g1'], 'inbox')
    await drain()
    expect(api.called()).toEqual(['untrash', 'batchModify'])
    expect(api.calls[1].args).toEqual([['g1'], ['INBOX'], ['SPAM']])
    expect(db.getMessageWire(A, 'g1')?.folder).toBe('inbox')
    expect(ops()).toEqual([])
  })

  it('ignores an empty selection', () => {
    outbox.applyAction(A, [], 'archive')
    expect(ops()).toEqual([])
  })

  describe('messages Gmail no longer has (404)', () => {
    it('retries a failed batch per message, treats a missing one as done, and keeps the lane moving', async () => {
      api.script('batchModify', async (ids: string[]) => {
        if (ids.length > 1 || ids[0] === 'g2')
          throw new GmailError(404, 'Requested entity was not found')
      })
      outbox.applyAction(A, ['g1', 'g2'], 'archive')
      outbox.applyAction(A, ['g1'], 'seen', true)
      await drain()

      expect(api.calls.map((c) => c.args)).toEqual([
        [['g1', 'g2'], [], ['INBOX']],
        [['g1'], [], ['INBOX']],
        [['g2'], [], ['INBOX']],
        [['g1'], [], ['UNREAD']]
      ])
      expect(ops()).toEqual([])
      expect(outbox.listTroubled()).toEqual([])
    })

    it('counts a single missing message as done without a retry', async () => {
      api.script('batchModify', rejectWith(404))
      outbox.applyAction(A, ['g1'], 'flagged', true)
      await drain()
      expect(api.calls).toHaveLength(1)
      expect(ops()).toEqual([])
    })

    it('still parks the op when the per-message retry fails for another reason', async () => {
      api.script('batchModify', async (ids: string[]) => {
        if (ids.length > 1) throw new GmailError(404, 'not found')
        if (ids[0] === 'g1') throw new GmailError(403, 'forbidden')
      })
      outbox.applyAction(A, ['g1', 'g2'], 'archive')
      await drain()
      expect(ops().map((o) => [o.state, o.lastError])).toEqual([['failed', 'forbidden']])
    })

    it('treats trashing a message that is already gone as done', async () => {
      api.script('trash', async (id: string) => {
        if (id === 'g2') throw new GmailError(404, 'not found')
      })
      outbox.applyAction(A, ['g1', 'g2'], 'trash')
      await drain()
      expect(api.called()).toEqual(['trash', 'trash'])
      expect(ops()).toEqual([])
    })
  })
})

describe('discard', () => {
  beforeEach(() => {
    db.upsertMessages([
      record({ accountId: A, gmailId: 'g1', folder: 'inbox', seen: false }),
      record({ accountId: A, gmailId: 'g2', folder: 'inbox', seen: false })
    ])
  })

  it('drops the ops, re-fetches touched messages, and keeps failed sends as drafts', async () => {
    api.script('batchModify', rejectWith(403))
    api.script('send', rejectWith(400, 'rejected'))
    outbox.applyAction(A, ['g1'], 'archive')
    outbox.applyAction(A, ['g2'], 'seen', true)
    const hdr = outbox.queueSend(input(), Date.now())
    await drain()
    expect(ops().map((o) => o.state)).toEqual(['failed', 'pending', 'failed'])
    expect(db.getMessageWire(A, 'g1')?.folder).toBe('archive')

    api.script('getMessage', async (id: string) => {
      if (id === 'g2') return null // gone from Gmail meanwhile
      return parsed({ gmailId: id, folder: 'inbox', seen: false, flagged: true })
    })
    await outbox.discard(null)

    // The discarded send lives on as a draft, and that draft gets pushed to Gmail
    expect(ops().map((o) => [o.kind, o.payload.messageIdHdr])).toEqual([['draft_put', hdr]])
    expect(
      api.calls
        .filter((c) => c.method === 'getMessage')
        .map((c) => c.args[0])
        .sort()
    ).toEqual(['g1', 'g2'])
    expect(db.getMessageWire(A, 'g1')).toMatchObject({
      folder: 'inbox',
      seen: false,
      flagged: true
    })
    expect(db.getMessageWire(A, 'g2')).toBeNull()
    expect(local(hdr)).toMatchObject({ state: 'draft', sendAfter: null })
    expect(wire(A, hdr)).toMatchObject({ folder: 'drafts', sendError: null })
    expect(db.countMessages(A)).toBe(2)
  })

  it('discards only the given ops and never a running one', async () => {
    outbox.applyAction(A, ['g1'], 'archive')
    outbox.applyAction(A, ['g2'], 'archive')
    const [first, second] = ops()
    db.markOpRunning(second.id)

    await outbox.discard([first.id, second.id])
    expect(ops().map((o) => o.id)).toEqual([second.id])
    expect(api.calls.map((c) => c.args[0])).toEqual(['g1'])
  })

  it('survives a failing re-fetch', async () => {
    api.script('getMessage', rejectWith(500))
    outbox.applyAction(A, ['g1'], 'archive')
    await expect(outbox.discard(null)).resolves.toBeUndefined()
    expect(ops()).toEqual([])
  })
})

describe('recoverInterrupted', () => {
  const recover = (): Promise<void> => outbox['recoverInterrupted']()

  /** A send the process died in the middle of */
  function interruptedSend(): string {
    const hdr = outbox.queueSend(input(), Date.now())
    db.markOpRunning(ops()[0].id)
    db.setLocalState(A, hdr, { state: 'sending' })
    return hdr
  }

  it('marks a running send as sent when Gmail already has it', async () => {
    const hdr = interruptedSend()
    api.script('findByMessageId', async () => 'gm-7')
    api.script('getMessage', async () => null)
    await recover()

    expect(api.called()).toEqual(['findByMessageId', 'getMessage'])
    expect(api.calls[0].args).toEqual([hdr])
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailId: 'gm-7', sendAfter: null })
    expect(ops()).toEqual([])
    await drain()
    expect(api.called()).not.toContain('send')
  })

  it('defers an unverified send so the next attempt re-checks Gmail before sending', async () => {
    const hdr = interruptedSend()
    await recover()
    expect(api.called()).toEqual(['findByMessageId'])
    // Counted as an attempt: Gmail's Message-ID search can lag acceptance, so
    // "not found" right after a crash is not proof the message never left.
    expect(ops()[0]).toMatchObject({ kind: 'send', state: 'pending', attempts: 1 })
    expect(ops()[0].nextAttemptAt).toBeGreaterThan(Date.now())
    expect(local(hdr)?.state).toBe('queued')
    await drain()
    expect(api.called()).not.toContain('send')

    // Later, Gmail turns out to have it after all: no second send
    vi.advanceTimersByTime(ops()[0].nextAttemptAt - Date.now() + 1)
    api.script('findByMessageId', async () => 'gm-late')
    await drain()
    expect(api.called()).not.toContain('send')
    expect(local(hdr)).toMatchObject({ state: 'sent', gmailId: 'gm-late' })
    expect(ops()).toEqual([])
  })

  it('defers when the verification itself fails', async () => {
    interruptedSend()
    api.script('findByMessageId', rejectWith(0, 'offline'))
    await recover()
    expect(ops()[0]).toMatchObject({ state: 'pending', attempts: 1, lastError: 'offline' })
    expect(ops()[0].nextAttemptAt).toBeGreaterThan(Date.now())
    await drain()
    expect(api.called()).toEqual(['findByMessageId'])
  })

  it('drops a running send whose message no longer exists', async () => {
    const hdr = interruptedSend()
    db.deleteLocalMessage(A, hdr)
    await recover()
    expect(ops()).toEqual([])
    expect(api.called()).toEqual([])
  })

  it('simply re-runs interrupted label actions', async () => {
    db.upsertMessages([record({ accountId: A, gmailId: 'g1' })])
    outbox.applyAction(A, ['g1'], 'archive')
    db.markOpRunning(ops()[0].id)
    await recover()
    expect(ops()[0].state).toBe('pending')
    await drain()
    expect(api.called()).toEqual(['batchModify'])
    expect(ops()).toEqual([])
  })
})
