import { randomUUID } from 'crypto'
import * as db from './db'
import { GmailApi, GmailError } from './google/gmail'
import { buildMime } from './mime'
import { notifyMailChanged } from './notify'
import { syncEngine } from './sync'
import type { LocalMessageInput, MailAction, WireOp } from '../preload/index.d'

/**
 * Persisted queue of everything we owe Gmail: label actions, sends, and draft
 * pushes. Every user intent is written to SQLite first (so it survives
 * restarts and window closes) and drained here with backoff. Transient
 * failures keep an op pending; permanent ones park it as failed until the
 * user retries or discards.
 *
 * Lanes: label actions run strictly in order per account (archive followed by
 * unarchive must land in that order). Send and draft ops are independent of
 * each other and of actions, and run whenever due.
 */

const POLL_MS = 10_000
const MAX_BACKOFF_MS = 5 * 60_000
const BASE_BACKOFF_MS = 5_000

function makeMessageId(): string {
  return `<${randomUUID()}@flint.local>`
}

function backoff(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS)
}

/** Is this error worth retrying later (network, rate limit, server trouble)? */
function isTransient(err: unknown): boolean {
  if (err instanceof GmailError) {
    return err.status === 0 || err.status === 429 || err.status >= 500
  }
  const code = (err as { code?: string }).code
  return (
    typeof code === 'string' &&
    /^(ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH)$/.test(code)
  )
}

/** Gmail says the message does not exist (any more) */
function isGone(err: unknown): boolean {
  return err instanceof GmailError && err.status === 404
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function buildRaw(local: db.LocalMessage): Promise<Buffer> {
  const account = db.getAccount(local.accountId)
  if (!account) throw new GmailError(400, 'Unknown account')
  return buildMime({
    from: { name: account.name, address: account.email },
    to: local.to,
    cc: local.cc,
    subject: local.subject,
    text: local.bodyText,
    html: local.bodyHtml ?? undefined,
    inReplyTo: local.inReplyTo ?? undefined,
    references: local.references,
    messageId: local.messageIdHdr
  })
}

export class Outbox {
  private draining = false
  private queued = false
  private wakeTimer: NodeJS.Timeout | null = null

  constructor(private apiFor: (accountId: string) => GmailApi) {}

  // ---------- intents (called from IPC) ----------

  /** Mirror a label action locally and queue its writeback */
  applyAction(accountId: string, gmailIds: string[], action: MailAction, value?: boolean): void {
    if (gmailIds.length === 0) return
    db.applyLocalAction(accountId, gmailIds, action, value)
    db.enqueueOp(accountId, 'action', { gmailIds, action, value: value ?? null })
    notifyMailChanged(true)
    this.kick()
  }

  /** Store a draft locally and queue a push to Gmail Drafts (coalescing pending pushes) */
  saveDraft(input: LocalMessageInput): string {
    const account = db.getAccount(input.accountId)
    if (!account) throw new Error('Unknown account')
    const messageIdHdr = input.messageIdHdr ?? makeMessageId()
    const existing = input.messageIdHdr
      ? db.getLocalMessage(input.accountId, input.messageIdHdr)
      : null
    // Editing a queued/failed send back into a draft withdraws it from the send lane
    if (existing && existing.state !== 'draft')
      this.dropPendingOpsFor(input.accountId, messageIdHdr)
    db.putLocalMessage(
      { ...input, messageIdHdr },
      { name: account.name, address: account.email },
      'draft',
      'drafts',
      null
    )
    // One pending push per draft is enough; it reads the latest content when it runs
    const pending = db
      .findOpsForMessage(input.accountId, messageIdHdr)
      .filter((op) => op.kind === 'draft_put' && op.state === 'pending')
    if (pending.length === 0) {
      db.enqueueOp(input.accountId, 'draft_put', { messageIdHdr })
    }
    notifyMailChanged(true)
    this.kick()
    return messageIdHdr
  }

  /** Delete a local message; if Gmail holds a draft for it, queue that delete too */
  deleteLocal(accountId: string, messageIdHdr: string): void {
    const local = db.getLocalMessage(accountId, messageIdHdr)
    if (!local) return
    this.dropPendingOpsFor(accountId, messageIdHdr)
    if (local.gmailDraftId || (local.gmailId && local.state === 'draft')) {
      db.enqueueOp(accountId, 'draft_delete', {
        messageIdHdr,
        gmailDraftId: local.gmailDraftId,
        gmailId: local.gmailId
      })
    }
    db.deleteLocalMessage(accountId, messageIdHdr)
    notifyMailChanged(true)
    this.kick()
  }

  /** Persist an outgoing message and queue it to leave at `sendAfter` */
  queueSend(input: LocalMessageInput, sendAfter: number): string {
    const account = db.getAccount(input.accountId)
    if (!account) throw new Error('Unknown account')
    const messageIdHdr = input.messageIdHdr ?? makeMessageId()
    const existing = input.messageIdHdr
      ? db.getLocalMessage(input.accountId, input.messageIdHdr)
      : null
    // A draft that becomes a send must not also get pushed as a draft
    if (existing) this.dropPendingOpsFor(input.accountId, messageIdHdr)
    db.putLocalMessage(
      { ...input, messageIdHdr },
      { name: account.name, address: account.email },
      'queued',
      'sent',
      sendAfter
    )
    db.enqueueOp(input.accountId, 'send', { messageIdHdr }, sendAfter)
    if (input.inReplyTo) db.setAnswered(input.accountId, input.inReplyTo, true)
    notifyMailChanged(true)
    this.kick(Math.max(0, sendAfter - Date.now()))
    return messageIdHdr
  }

  /**
   * Cancel a queued send. Returns false once the message is sending or sent.
   * `asDraft` turns it back into a draft (editing a failed send); otherwise the
   * message is deleted (toast Undo — the composer restores the text itself).
   */
  cancelSend(accountId: string, messageIdHdr: string, asDraft: boolean): boolean {
    const local = db.getLocalMessage(accountId, messageIdHdr)
    if (!local) return false
    if (local.state !== 'queued' && local.state !== 'failed') return false
    const ops = db.findOpsForMessage(accountId, messageIdHdr)
    if (ops.some((op) => op.state === 'running')) return false
    db.deleteOps(ops.map((op) => op.id))
    if (asDraft) {
      db.setLocalState(accountId, messageIdHdr, {
        state: 'draft',
        folder: 'drafts',
        sendAfter: null,
        sendError: null
      })
      db.enqueueOp(accountId, 'draft_put', { messageIdHdr })
    } else {
      db.deleteLocalMessage(accountId, messageIdHdr)
    }
    if (local.inReplyTo) {
      const account = db.getAccount(accountId)
      const stillAnswered =
        !!account && db.hasOwnReply(accountId, local.inReplyTo, account.email, messageIdHdr)
      if (!stillAnswered) db.setAnswered(accountId, local.inReplyTo, false)
    }
    notifyMailChanged(true)
    this.kick()
    return true
  }

  /** Put a failed send back in the queue */
  retrySend(accountId: string, messageIdHdr: string): void {
    const local = db.getLocalMessage(accountId, messageIdHdr)
    if (!local || local.state !== 'failed') return
    const ops = db.findOpsForMessage(accountId, messageIdHdr).filter((op) => op.kind === 'send')
    if (ops.length > 0) db.retryOps(ops.map((op) => op.id))
    else db.enqueueOp(accountId, 'send', { messageIdHdr })
    db.setLocalState(accountId, messageIdHdr, {
      state: 'queued',
      sendAfter: Date.now(),
      sendError: null
    })
    notifyMailChanged(true)
    this.kick()
  }

  /** Ops the user should know about: anything that has errored at least once */
  listTroubled(): WireOp[] {
    return db
      .listOps()
      .filter((op) => op.lastError !== null || op.state === 'failed')
      .map(db.toWireOp)
  }

  retry(ids: number[] | null): void {
    db.retryOps(ids ?? undefined)
    notifyMailChanged(true)
    this.kick()
  }

  /**
   * Discard ops and put the affected messages back the way Gmail has them.
   * Sends are kept as drafts so nothing the user wrote is lost.
   */
  async discard(ids: number[] | null): Promise<void> {
    const ops = db
      .listOps()
      .filter((op) => (ids ? ids.includes(op.id) : true) && op.state !== 'running')
    const refetch = new Map<string, Set<string>>()
    for (const op of ops) {
      if (op.kind === 'action') {
        const set = refetch.get(op.accountId) ?? new Set<string>()
        for (const id of op.payload.gmailIds as string[]) set.add(id)
        refetch.set(op.accountId, set)
      } else if (op.kind === 'send') {
        const hdr = op.payload.messageIdHdr as string
        db.setLocalState(op.accountId, hdr, {
          state: 'draft',
          folder: 'drafts',
          sendAfter: null,
          sendError: null
        })
      }
    }
    db.deleteOps(ops.map((op) => op.id))
    // The text of a discarded send lives on as a draft, in Gmail too
    for (const op of ops) {
      if (op.kind === 'send') {
        const hdr = op.payload.messageIdHdr as string
        if (db.getLocalMessage(op.accountId, hdr)) {
          db.enqueueOp(op.accountId, 'draft_put', { messageIdHdr: hdr })
        }
      }
    }
    notifyMailChanged(true)
    for (const [accountId, gmailIds] of refetch) {
      const api = this.apiFor(accountId)
      for (const id of gmailIds) {
        try {
          const parsed = await api.getMessage(id)
          if (parsed) db.upsertMessages([{ ...parsed, accountId }])
          else db.deleteMessage(accountId, id)
        } catch (err) {
          console.error('[outbox] discard refetch failed:', err)
        }
      }
    }
    notifyMailChanged(true)
  }

  private dropPendingOpsFor(accountId: string, messageIdHdr: string): void {
    const ops = db.findOpsForMessage(accountId, messageIdHdr).filter((op) => op.state !== 'running')
    db.deleteOps(ops.map((op) => op.id))
  }

  // ---------- worker ----------

  start(): void {
    void this.recoverInterrupted().finally(() => {
      setInterval(() => this.kick(), POLL_MS)
      this.kick()
    })
  }

  /**
   * Ops that were running when the process died. Label actions are idempotent
   * and simply rerun. A send may or may not have gone out: ask Gmail for the
   * Message-ID before deciding, so nothing is ever sent twice.
   */
  private async recoverInterrupted(): Promise<void> {
    for (const op of db.resetRunningOps()) {
      if (op.kind !== 'send') continue
      const hdr = op.payload.messageIdHdr as string
      const local = db.getLocalMessage(op.accountId, hdr)
      if (!local) {
        db.deleteOp(op.id)
        continue
      }
      try {
        const gmailId = await this.apiFor(op.accountId).findByMessageId(hdr)
        if (gmailId) {
          db.setLocalState(op.accountId, hdr, {
            state: 'sent',
            gmailId,
            sendAfter: null,
            sendError: null
          })
          db.deleteOp(op.id)
          await this.readBack(op.accountId, gmailId)
        } else {
          // Not found is not proof it never left: Gmail's Message-ID search lags
          // a little behind acceptance. Count this as an attempt and wait, so
          // the worker asks again before it would ever send.
          db.deferOp(op.id, 'interrupted before confirmation', Date.now() + BASE_BACKOFF_MS)
          db.setLocalState(op.accountId, hdr, {
            state: 'queued',
            sendError: 'interrupted before confirmation'
          })
        }
      } catch (err) {
        // Unknown: leave it pending; the next attempt asks again before sending
        console.error('[outbox] could not verify interrupted send:', err)
        db.deferOp(op.id, errorText(err), Date.now() + BASE_BACKOFF_MS)
      }
    }
  }

  /** Ask the worker to drain soon (or once an undo window elapses) */
  kick(delayMs = 0): void {
    if (delayMs > 0) {
      // Precise wake for undo windows; polling covers retries
      if (delayMs <= POLL_MS * 6) setTimeout(() => this.kick(), delayMs + 50)
      return
    }
    if (this.wakeTimer) return
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      void this.drain()
    }, 50)
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.queued = true
      return
    }
    this.draining = true
    try {
      // Ops enqueue other ops (a send queues the delete of the draft it grew
      // out of), so keep passing until a pass completes nothing. A failed or
      // deferred op is no longer due, so it cannot spin the loop.
      for (let ranAny = true; ranAny;) {
        ranAny = false
        const now = Date.now()
        const byAccount = new Map<string, db.OpRow[]>()
        for (const op of db.listOps()) {
          byAccount.set(op.accountId, [...(byAccount.get(op.accountId) ?? []), op])
        }
        for (const [accountId, ops] of byAccount) {
          if (!db.getAccount(accountId)) continue
          // Actions lane: strict FIFO; a deferred/failed head blocks the lane
          for (const op of ops.filter((o) => o.kind === 'action')) {
            if (op.state !== 'pending' || op.nextAttemptAt > now) break
            const ok = await this.run(op)
            if (!ok) break
            ranAny = true
          }
          // Independent lanes
          for (const op of ops.filter((o) => o.kind !== 'action')) {
            if (op.state !== 'pending' || op.nextAttemptAt > now) continue
            if (await this.run(op)) ranAny = true
          }
        }
      }
    } finally {
      this.draining = false
      if (this.queued) {
        this.queued = false
        this.kick()
      }
    }
  }

  /** Execute one op; returns true on success */
  private async run(op: db.OpRow): Promise<boolean> {
    db.markOpRunning(op.id)
    try {
      switch (op.kind) {
        case 'action':
          await this.runAction(op)
          break
        case 'send':
          await this.runSend(op)
          break
        case 'draft_put':
          await this.runDraftPut(op)
          break
        case 'draft_delete':
          await this.runDraftDelete(op)
          break
      }
      db.deleteOp(op.id)
      notifyMailChanged(true)
      return true
    } catch (err) {
      const text = errorText(err)
      const hdr = typeof op.payload.messageIdHdr === 'string' ? op.payload.messageIdHdr : null
      if (isTransient(err)) {
        console.warn(`[outbox] ${op.kind} #${op.id} deferred: ${text}`)
        db.deferOp(op.id, text, Date.now() + backoff(op.attempts))
        if (hdr && op.kind === 'send')
          db.setLocalState(op.accountId, hdr, { state: 'queued', sendError: text })
      } else {
        console.error(`[outbox] ${op.kind} #${op.id} failed: ${text}`)
        db.failOp(op.id, text)
        if (hdr && op.kind === 'send')
          db.setLocalState(op.accountId, hdr, { state: 'failed', sendError: text })
      }
      notifyMailChanged(true)
      return false
    }
  }

  private async runAction(op: db.OpRow): Promise<void> {
    const api = this.apiFor(op.accountId)
    const gmailIds = op.payload.gmailIds as string[]
    const value = op.payload.value as boolean | null
    switch (op.payload.action as MailAction) {
      case 'seen':
        await this.modify(api, gmailIds, value ? [] : ['UNREAD'], value ? ['UNREAD'] : [])
        break
      case 'flagged':
        await this.modify(api, gmailIds, value ? ['STARRED'] : [], value ? [] : ['STARRED'])
        break
      case 'archive':
        await this.modify(api, gmailIds, [], ['INBOX'])
        break
      case 'unarchive':
        await this.modify(api, gmailIds, ['INBOX'], [])
        break
      case 'trash':
        for (const id of gmailIds) {
          // Already gone is the same as trashed; sync removes the row
          await api.trash(id).catch((err) => {
            if (!isGone(err)) throw err
          })
        }
        break
      case 'spam':
        await this.modify(api, gmailIds, ['SPAM'], ['INBOX'])
        break
      case 'inbox':
        // Coming back from trash needs untrash; harmless 4xx if it wasn't there
        for (const id of gmailIds) {
          await api.untrash(id).catch(() => undefined)
        }
        await this.modify(api, gmailIds, ['INBOX'], ['SPAM'])
        break
    }
  }

  /**
   * batchModify fails wholesale (404) when any id in it no longer exists on
   * Gmail — another client deleted the message, or spam was purged. The
   * label change on a message that is gone has nothing left to do, so on a
   * 404 the batch is retried one message at a time and per-message 404s
   * count as done. Delta sync removes the local row shortly after.
   */
  private async modify(
    api: GmailApi,
    gmailIds: string[],
    add: string[],
    remove: string[]
  ): Promise<void> {
    try {
      await api.batchModify(gmailIds, add, remove)
      return
    } catch (err) {
      if (!isGone(err)) throw err
    }
    if (gmailIds.length === 1) {
      console.warn(`[outbox] ${gmailIds[0]} no longer exists on Gmail; label change dropped`)
      return
    }
    for (const id of gmailIds) {
      try {
        await api.batchModify([id], add, remove)
      } catch (err) {
        if (!isGone(err)) throw err
        console.warn(`[outbox] ${id} no longer exists on Gmail; label change dropped`)
      }
    }
  }

  private async runSend(op: db.OpRow): Promise<void> {
    const hdr = op.payload.messageIdHdr as string
    const local = db.getLocalMessage(op.accountId, hdr)
    if (!local) return // deleted meanwhile
    if (local.state === 'sent' || local.state === 'synced') return
    db.setLocalState(op.accountId, hdr, { state: 'sending' })
    notifyMailChanged(true)
    const api = this.apiFor(op.accountId)
    // A retry after an unverified attempt must not double-send
    if (op.attempts > 0) {
      const already = await api.findByMessageId(hdr)
      if (already) {
        db.setLocalState(op.accountId, hdr, {
          state: 'sent',
          gmailId: already,
          sendAfter: null,
          sendError: null
        })
        await this.readBack(op.accountId, already)
        return
      }
    }
    const raw = await buildRaw(local)
    const sent = await api.send(raw, local.threadId ?? undefined)
    // Gmail accepted it: that is the moment it counts as sent, whatever happens next
    db.setLocalState(op.accountId, hdr, {
      state: 'sent',
      gmailId: sent.id,
      threadId: sent.threadId || local.threadId,
      sendAfter: null,
      sendError: null,
      gmailDraftId: null
    })
    notifyMailChanged(true)
    // The Gmail draft this message grew out of is now redundant. A draft that
    // arrived via sync only carries its draft *message* id; the delete op
    // resolves the draft id from it.
    if (local.gmailDraftId || local.gmailId) {
      db.enqueueOp(op.accountId, 'draft_delete', {
        gmailDraftId: local.gmailDraftId,
        gmailId: local.gmailId
      })
    }
    await this.readBack(op.accountId, sent.id)
  }

  /** Best-effort refresh of the synced copy; delta sync catches it otherwise */
  private async readBack(accountId: string, gmailId: string): Promise<void> {
    try {
      const parsed = await this.apiFor(accountId).getMessage(gmailId)
      if (parsed) db.upsertMessages([{ ...parsed, accountId }])
    } catch (err) {
      console.warn('[outbox] sent, but reading the copy back failed:', errorText(err))
    }
  }

  private async runDraftPut(op: db.OpRow): Promise<void> {
    const hdr = op.payload.messageIdHdr as string
    const local = db.getLocalMessage(op.accountId, hdr)
    if (!local || local.state !== 'draft') return // deleted or sent meanwhile
    const api = this.apiFor(op.accountId)
    const raw = await buildRaw(local)
    let draftId = local.gmailDraftId
    // A draft that arrived via sync has a message id but no draft id yet
    if (!draftId && local.gmailId) draftId = await api.findDraftIdForMessage(local.gmailId)
    const res = draftId
      ? await api.updateDraft(draftId, raw, local.threadId ?? undefined)
      : await api.createDraft(raw, local.threadId ?? undefined)
    db.setLocalState(op.accountId, hdr, {
      gmailDraftId: res.draftId,
      gmailId: res.messageId || null,
      threadId: res.threadId || local.threadId
    })
  }

  private async runDraftDelete(op: db.OpRow): Promise<void> {
    const api = this.apiFor(op.accountId)
    let draftId = (op.payload.gmailDraftId as string | null) ?? null
    const gmailId = (op.payload.gmailId as string | null) ?? null
    if (!draftId && gmailId) draftId = await api.findDraftIdForMessage(gmailId)
    if (draftId) await api.deleteDraft(draftId)
  }
}

export const outbox = new Outbox((accountId) => syncEngine.api(accountId))
