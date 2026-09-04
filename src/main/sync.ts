import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { OAuth2Client } from 'google-auth-library'
import * as db from './db'
import { GmailApi, GmailError, labelsToState } from './google/gmail'
import { runAuthFlow } from './google/oauth'
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from './google/clientDefaults'
import { buildMime } from './mime'
import type { MailAction, SendMailInput, SyncStatus, WireAccount, WireMessage } from '../preload/index.d'

/**
 * Per-account Gmail sync. Initial backfill walks the whole mailbox newest-first
 * with a resumable page-token checkpoint; steady-state sync applies history
 * deltas anchored at the historyId captured when the account was added.
 */

const ACCOUNT_COLORS = ['#4E9BF5', '#E5684F', '#43B581', '#B57EDC', '#E8B04C', '#5CC9C2']
const BACKFILL_CONCURRENCY = 6
const DELTA_INTERVAL_MS = 60_000

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
  private deltaRunning = new Set<string>()
  private notifyTimer: NodeJS.Timeout | null = null

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

  private api(accountId: string): GmailApi {
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
    this.notify()
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

  private async backfillLoop(accountId: string): Promise<void> {
    const api = this.api(accountId)
    for (;;) {
      const state = db.getBackfillState(accountId)
      if (!state || state.done) return
      const page = await api.listMessageIds(state.pageToken ?? undefined)
      const fresh = page.ids.filter((id) => !db.hasMessage(accountId, id))
      const parsed = await mapConcurrent(fresh, BACKFILL_CONCURRENCY, (id) => api.getMessage(id))
      db.upsertMessages(
        parsed.filter((p) => p !== null).map((p) => ({ ...p, accountId }))
      )
      db.setBackfillState(accountId, page.nextPageToken ?? null, !page.nextPageToken)
      this.notify()
      if (!page.nextPageToken) {
        console.log(`[sync] backfill complete: ${db.countMessages(accountId)} messages`)
        return
      }
      await sleep(150)
    }
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
      // History window expired — re-anchor and refresh the recent slice
      if (err instanceof GmailError && err.status === 404) {
        const profile = await api.getProfile()
        db.setHistoryId(accountId, profile.historyId)
        await this.recentResync(accountId)
        changed = true
      } else {
        throw err
      }
    }
    if (changed) this.notify()
  }

  private async recentResync(accountId: string): Promise<void> {
    const api = this.api(accountId)
    const page = await api.listMessageIds()
    const parsed = await mapConcurrent(page.ids, BACKFILL_CONCURRENCY, (id) => api.getMessage(id))
    db.upsertMessages(parsed.filter((p) => p !== null).map((p) => ({ ...p, accountId })))
  }

  /** Optimistic local write + Gmail label writeback for a UI action */
  async applyAction(
    accountId: string,
    gmailIds: string[],
    action: MailAction,
    value?: boolean
  ): Promise<void> {
    db.applyLocalAction(accountId, gmailIds, action, value)
    this.notify()
    const api = this.api(accountId)
    switch (action) {
      case 'seen':
        await api.batchModify(gmailIds, value ? [] : ['UNREAD'], value ? ['UNREAD'] : [])
        break
      case 'flagged':
        await api.batchModify(gmailIds, value ? ['STARRED'] : [], value ? [] : ['STARRED'])
        break
      case 'archive':
        await api.batchModify(gmailIds, [], ['INBOX'])
        break
      case 'unarchive':
        await api.batchModify(gmailIds, ['INBOX'], [])
        break
      case 'trash':
        for (const id of gmailIds) await api.trash(id)
        break
      case 'spam':
        await api.batchModify(gmailIds, ['SPAM'], ['INBOX'])
        break
      case 'inbox':
        // Coming back from trash needs untrash; harmless 4xx if it wasn't there
        for (const id of gmailIds) {
          await api.untrash(id).catch(() => undefined)
        }
        await api.batchModify(gmailIds, ['INBOX'], ['SPAM'])
        break
    }
  }

  /** Build the RFC 822 message, send it through Gmail, and store the synced copy */
  async sendMail(input: SendMailInput): Promise<WireMessage> {
    const account = db.listAccounts().find((a) => a.id === input.accountId)
    if (!account) throw new Error('Unknown account')
    const raw = await buildMime({
      from: { name: account.name, address: account.email },
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references
    })
    const api = this.api(input.accountId)
    const gmailId = await api.send(raw, input.threadId)
    // Pull the message back so the local copy carries Gmail's ids and labels
    const parsed = await api.getMessage(gmailId)
    if (!parsed) throw new Error('Message sent but could not be read back')
    db.upsertMessages([{ ...parsed, accountId: input.accountId }])
    this.notify()
    const wire = db.getMessageWire(input.accountId, gmailId)
    if (!wire) throw new Error('Message sent but missing from the local store')
    return wire
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
    // Resume any unfinished backfill and catch up shortly after launch
    setTimeout(() => {
      for (const account of db.listAccounts()) this.startBackfill(account.id)
      void this.deltaAll()
    }, 1500)
  }

  /** Trailing-edge throttle so backfill pages don't spam the renderer */
  private notify(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('mail:changed')
      }
    }, 800)
  }
}

export const syncEngine = new SyncEngine()
