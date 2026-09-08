import { randomUUID } from 'crypto'
import { OAuth2Client } from 'google-auth-library'
import * as db from './db'
import { GmailApi, GmailError, labelsToState } from './google/gmail'
import { runAuthFlow } from './google/oauth'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from './google/clientDefaults'
import { notifyMailChanged } from './notify'
import type { SyncStatus, WireAccount } from '../preload/index.d'

/**
 * Per-account Gmail sync (the read side). Initial backfill walks the whole
 * mailbox newest-first with a resumable page-token checkpoint in two phases:
 * metadata first (headers, labels, snippet: the list is browsable within
 * moments), then bodies for every metadata-only row, newest first. Opening a
 * thread fetches its missing bodies on the spot (`ensureBodies`).
 * Steady-state sync applies history deltas anchored at the historyId captured
 * when the account was added. Writes to Gmail live in the outbox.
 */

const ACCOUNT_COLORS = ['#4E9BF5', '#E5684F', '#43B581', '#B57EDC', '#E8B04C', '#5CC9C2']
const BACKFILL_CONCURRENCY = 6
/** Metadata-only rows fetched in full per body-fill round */
const BODY_FILL_BATCH = 50
const DELTA_INTERVAL_MS = 60_000
/** Newest remote messages a full resync will fetch when they are missing locally */
const RESYNC_NEW_CAP = 2000
/** Labels that determine folder + flags (see labelsToState) */
const STATE_LABELS = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'DRAFT', 'SENT']

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

class SyncEngine {
  private authClients = new Map<string, OAuth2Client>()
  private apis = new Map<string, GmailApi>()
  private backfilling = new Set<string>()
  private bodyFilling = new Set<string>()
  /** In-flight on-demand body fetches, keyed by account/thread */
  private threadFetches = new Map<string, Promise<boolean>>()
  private deltaRunning = new Set<string>()

  /** Built-in OAuth client, overridable via config rows (for forks) */
  private clientConfig(): { clientId: string; clientSecret: string } {
    return {
      clientId: db.getConfig('google_client_id') || GOOGLE_CLIENT_ID,
      clientSecret: db.getConfig('google_client_secret') || GOOGLE_CLIENT_SECRET
    }
  }

  /** OAuth2Client per account: refreshes access tokens from the stored refresh token */
  private authClient(accountId: string): OAuth2Client {
    let client = this.authClients.get(accountId)
    if (!client) {
      const { clientId, clientSecret } = this.clientConfig()
      const refreshToken = db.getRefreshToken(accountId)
      if (!refreshToken) {
        throw new Error('Account has no stored credentials — re-add it in Settings')
      }
      client = new OAuth2Client({ clientId, clientSecret })
      client.setCredentials({ refresh_token: refreshToken })
      // Google can rotate the refresh token; persist whatever it hands back
      client.on('tokens', (tokens) => {
        if (tokens.refresh_token) db.saveRefreshToken(accountId, tokens.refresh_token)
      })
      this.authClients.set(accountId, client)
    }
    return client
  }

  api(accountId: string): GmailApi {
    let api = this.apis.get(accountId)
    if (!api) {
      api = new GmailApi(this.authClient(accountId))
      this.apis.set(accountId, api)
    }
    return api
  }

  /** Run the browser OAuth flow, create (or re-authorize) the account, start syncing */
  async addAccount(): Promise<WireAccount> {
    const { clientId, clientSecret } = this.clientConfig()
    const auth = await runAuthFlow(clientId, clientSecret)
    const existing = db.getAccountByEmail(auth.email)
    let accountId: string
    if (existing) {
      accountId = existing.id
    } else {
      accountId = randomUUID()
      db.createAccount({
        id: accountId,
        email: auth.email,
        name: auth.name,
        color: ACCOUNT_COLORS[db.listAccounts().length % ACCOUNT_COLORS.length]
      })
    }
    db.saveRefreshToken(accountId, auth.tokens.refreshToken)
    // Drop any client built on a previous refresh token (the re-add case)
    this.authClients.delete(accountId)
    this.apis.delete(accountId)
    // Anchor delta sync before backfill begins so nothing slips between them
    if (!db.getHistoryId(accountId)) {
      const profile = await this.api(accountId).getProfile()
      db.setHistoryId(accountId, profile.historyId)
    }
    this.startBackfill(accountId)
    const account = db.listAccounts().find((a) => a.id === accountId)
    if (!account) throw new Error('Account vanished during setup')
    return account
  }

  removeAccount(accountId: string): void {
    db.deleteAccount(accountId)
    this.authClients.delete(accountId)
    this.apis.delete(accountId)
    notifyMailChanged(true)
  }

  startBackfill(accountId: string): void {
    if (this.backfilling.has(accountId)) return
    const state = db.getBackfillState(accountId)
    if (!state || state.done) return
    this.backfilling.add(accountId)
    void this.backfillLoop(accountId)
      .catch((err) => console.error('[sync] backfill failed:', err))
      .finally(() => this.backfilling.delete(accountId))
  }

  /** Phase 1: every message as a metadata-only row, newest first */
  private async backfillLoop(accountId: string): Promise<void> {
    const api = this.api(accountId)
    for (;;) {
      const state = db.getBackfillState(accountId)
      if (!state || state.done) return
      const page = await api.listMessageIds(state.pageToken ?? undefined)
      const fresh = page.ids.filter((id) => !db.hasMessage(accountId, id))
      const parsed = await mapConcurrent(fresh, BACKFILL_CONCURRENCY, (id) =>
        api.getMessageMetadata(id)
      )
      db.upsertMessages(parsed.filter((p) => p !== null).map((p) => ({ ...p, accountId })))
      db.setBackfillState(accountId, page.nextPageToken ?? null, !page.nextPageToken)
      notifyMailChanged()
      if (!page.nextPageToken) {
        console.log(
          `[sync] backfill complete: ${db.countMessages(accountId)} messages, ` +
            `${db.countMissingBodies(accountId)} bodies to fetch`
        )
        this.startBodyFill(accountId)
        return
      }
      await sleep(150)
    }
  }

  /** Phase 2: bodies for metadata-only rows, newest first, until none are left */
  startBodyFill(accountId: string): void {
    if (this.bodyFilling.has(accountId)) return
    if (db.countMissingBodies(accountId) === 0) return
    this.bodyFilling.add(accountId)
    void this.bodyFillLoop(accountId)
      .catch((err) => console.error('[sync] body fill failed:', err))
      .finally(() => this.bodyFilling.delete(accountId))
  }

  private async bodyFillLoop(accountId: string): Promise<void> {
    for (;;) {
      if (!db.getAccount(accountId)) return
      const ids = db.listMissingBodyIds(accountId, BODY_FILL_BATCH)
      if (ids.length === 0) {
        console.log(`[sync] body fill complete for ${accountId}`)
        return
      }
      await this.fetchBodies(accountId, ids)
      await sleep(150)
    }
  }

  /**
   * Fetch the bodies a thread is still missing before it is shown. Resolves
   * true when anything was fetched. Concurrent opens of the same thread
   * share one fetch; failures (offline, no credentials) propagate so the
   * caller can still show what it has.
   */
  ensureBodies(accountId: string, threadId: string): Promise<boolean> {
    const key = `${accountId}/${threadId}`
    let inflight = this.threadFetches.get(key)
    if (!inflight) {
      inflight = (async () => {
        const ids = db.listMissingBodyIdsInThread(accountId, threadId)
        if (ids.length === 0) return false
        await this.fetchBodies(accountId, ids)
        return true
      })().finally(() => this.threadFetches.delete(key))
      this.threadFetches.set(key, inflight)
    }
    return inflight
  }

  /** Full fetch for metadata-only rows; a message Gmail no longer has is dropped */
  private async fetchBodies(accountId: string, ids: string[]): Promise<void> {
    const api = this.api(accountId)
    const parsed = await mapConcurrent(ids, BACKFILL_CONCURRENCY, (id) => api.getMessage(id))
    const full: db.MsgRecord[] = []
    parsed.forEach((p, i) => {
      if (p) full.push({ ...p, accountId })
      else db.deleteMessage(accountId, ids[i])
    })
    // The gmail_id conflict path fills bodies into a 'missing' row (and refreshes labels)
    db.upsertMessages(full)
    notifyMailChanged()
  }

  async deltaAll(): Promise<void> {
    for (const account of db.listAccounts()) {
      try {
        await this.deltaSync(account.id)
      } catch (err) {
        console.error(`[sync] delta failed for ${account.email}:`, err)
      }
    }
  }

  private async deltaSync(accountId: string): Promise<void> {
    if (this.deltaRunning.has(accountId)) return
    this.deltaRunning.add(accountId)
    try {
      await this.deltaInner(accountId)
    } finally {
      this.deltaRunning.delete(accountId)
    }
  }

  private async deltaInner(accountId: string): Promise<void> {
    const api = this.api(accountId)
    const start = db.getHistoryId(accountId)
    if (!start) return
    let pageToken: string | undefined
    let latest: string | null = null
    let changed = false
    try {
      do {
        const page = await api.listHistory(start, pageToken)
        latest = page.historyId ?? latest
        for (const entry of page.history) {
          for (const added of entry.messagesAdded) {
            const parsed = await api.getMessage(added.id)
            if (parsed) {
              db.upsertMessages([{ ...parsed, accountId }])
              changed = true
            }
          }
          for (const deleted of entry.messagesDeleted) {
            db.deleteMessage(accountId, deleted.id)
            changed = true
          }
          for (const change of entry.labelChanges) {
            if (db.hasMessage(accountId, change.id)) {
              db.updateMessageState(accountId, change.id, labelsToState(change.labelIds))
              changed = true
            }
          }
        }
        pageToken = page.nextPageToken
      } while (pageToken)
      if (latest) db.setHistoryId(accountId, latest)
    } catch (err) {
      // History window expired: Gmail requires a full sync before a new anchor is valid
      if (err instanceof GmailError && err.status === 404) {
        await this.fullResync(accountId)
        changed = true
      } else {
        throw err
      }
    }
    if (changed) notifyMailChanged()
  }

  /**
   * Reconcile the cached mailbox against Gmail when history is no longer
   * available. The new anchor is captured first (anything changing during the
   * pass is replayed by the next delta) and committed last (a failure leaves
   * the old anchor in place, so the next tick tries again):
   *   1. messages Gmail no longer has are deleted locally
   *   2. folder/flags of everything we hold are recomputed from label listings
   *   3. the newest messages we don't hold are fetched (capped)
   */
  private async fullResync(accountId: string): Promise<void> {
    const api = this.api(accountId)
    console.warn(`[sync] history expired for ${accountId}; running a full resync`)
    const profile = await api.getProfile()
    const newHistoryId = profile.historyId

    const remoteIds = await api.listAllMessageIds()
    const local = db.listLabelState(accountId)

    const removed = local.filter((l) => !remoteIds.has(l.gmailId))
    for (const l of removed) db.deleteMessage(accountId, l.gmailId)

    const labelSets = new Map<string, Set<string>>()
    for (const label of STATE_LABELS) labelSets.set(label, await api.listAllMessageIds([label]))
    let relabelled = 0
    for (const l of local) {
      if (!remoteIds.has(l.gmailId)) continue
      const labels = STATE_LABELS.filter((label) => labelSets.get(label)?.has(l.gmailId))
      const next = labelsToState(labels)
      if (
        next.folder !== l.folder ||
        next.seen !== l.seen ||
        next.flagged !== l.flagged ||
        next.important !== l.important
      ) {
        db.updateMessageState(accountId, l.gmailId, next)
        relabelled++
      }
    }

    const localIds = new Set(local.map((l) => l.gmailId))
    const missing = [...remoteIds].filter((id) => !localIds.has(id)).slice(0, RESYNC_NEW_CAP)
    const parsed = await mapConcurrent(missing, BACKFILL_CONCURRENCY, (id) => api.getMessage(id))
    db.upsertMessages(parsed.filter((p) => p !== null).map((p) => ({ ...p, accountId })))

    db.setHistoryId(accountId, newHistoryId)
    console.log(
      `[sync] full resync done: -${removed.length} ~${relabelled} +${missing.length} (remote ${remoteIds.size})`
    )
  }

  status(): SyncStatus[] {
    return db.listAccounts().map((a) => ({
      accountId: a.id,
      email: a.email,
      messageCount: db.countMessages(a.id),
      backfillDone: a.backfillDone
    }))
  }

  startScheduler(): void {
    setInterval(() => void this.deltaAll(), DELTA_INTERVAL_MS)
    // Resume any unfinished backfill (either phase) and catch up shortly after launch
    setTimeout(() => {
      for (const account of db.listAccounts()) {
        if (account.backfillDone) this.startBodyFill(account.id)
        else this.startBackfill(account.id)
      }
      void this.deltaAll()
    }, 1500)
  }
}

export const syncEngine = new SyncEngine()
