import { ElectronAPI } from '@electron-toolkit/preload'

/**
 * Wire types shared by the main process, preload, and renderer. This .d.ts is
 * the one preload file both tsconfig projects include, so it is where the IPC
 * contract lives.
 */

export type Folder = 'inbox' | 'archive' | 'sent' | 'drafts' | 'trash' | 'spam'

export type MailAction = 'seen' | 'flagged' | 'archive' | 'unarchive' | 'trash' | 'spam' | 'inbox'

/**
 * Lifecycle of a message row.
 * - synced: mirrors Gmail
 * - draft: local draft (may also exist in Gmail's Drafts once pushed)
 * - queued: waiting to be sent (undo window or scheduled time not yet reached)
 * - sending: handed to the outbox worker
 * - sent: Gmail accepted it; the synced copy hasn't been pulled back yet
 * - failed: Gmail rejected it; needs Retry or Edit
 */
export type MessageState = 'synced' | 'draft' | 'queued' | 'sending' | 'sent' | 'failed'

/** Outbox operation kinds */
export type OpKind = 'action' | 'send' | 'draft_put' | 'draft_delete'

export interface WireMailbox {
  name?: string
  address: string
}

export interface WireAccount {
  id: string
  email: string
  /** Google profile display name */
  name: string
  color: string
  backfillDone: boolean
}

export interface WireMessage {
  accountId: string
  /** Null for mail that hasn't reached Gmail yet */
  gmailId: string | null
  /** Null until Gmail assigns one (new local messages) */
  threadId: string | null
  messageIdHdr: string | null
  inReplyTo: string | null
  references: string[]
  from: WireMailbox
  to: WireMailbox[]
  cc: WireMailbox[]
  replyTo: WireMailbox | null
  subject: string
  dateMs: number
  snippet: string
  bodyText: string
  bodyHtml: string | null
  folder: Folder
  seen: boolean
  flagged: boolean
  answered: boolean
  category: string
  important: boolean
  state: MessageState
  /** When a queued message is due to leave (undo window / scheduled send) */
  sendAfterMs: number | null
  /** Last send error, for queued (retrying) and failed messages */
  sendError: string | null
}

/** A locally-authored message: what the renderer hands main for drafts and sends */
export interface LocalMessageInput {
  accountId: string
  /** Existing local row to update (re-saving a draft, sending a draft); omitted for new mail */
  messageIdHdr?: string
  to: WireMailbox[]
  cc: WireMailbox[]
  subject: string
  /** text/plain part */
  text: string
  /** text/html part, when composed rich */
  html?: string
  /** Parent Message-ID header, for reply threading */
  inReplyTo?: string
  references: string[]
  /** Gmail conversation to append to (replies) */
  threadId?: string
  category?: string
}

export interface WireOp {
  id: number
  accountId: string
  kind: OpKind
  state: 'pending' | 'running' | 'failed'
  attempts: number
  lastError: string | null
  nextAttemptAt: number
  createdAt: number
  messageIdHdr: string | null
  action: string | null
  gmailIds: string[]
}

export interface SyncStatus {
  accountId: string
  email: string
  messageCount: number
  backfillDone: boolean
}

export interface GoogleConfig {
  clientId: string
  clientSecret: string
}

export interface MailApi {
  getGoogleConfig(): Promise<GoogleConfig>
  setGoogleConfig(cfg: GoogleConfig): Promise<void>
  listAccounts(): Promise<WireAccount[]>
  /** Runs the browser OAuth flow; resolves once the account is created and syncing */
  addAccount(): Promise<WireAccount>
  removeAccount(id: string): Promise<void>
  getMailWindow(perAccount: number): Promise<WireMessage[]>
  getThread(accountId: string, threadId: string): Promise<WireMessage[]>
  /** Mirror a label action locally and queue it for Gmail */
  mailAction(p: {
    accountId: string
    gmailIds: string[]
    action: MailAction
    value?: boolean
  }): Promise<void>

  /** Store a draft (local row + queued push to Gmail Drafts); resolves with its Message-ID */
  saveDraft(input: LocalMessageInput): Promise<string>
  /** Delete a local message (draft, or a scheduled/failed send); pushes the delete to Gmail when it has a draft there */
  deleteLocalMessage(accountId: string, messageIdHdr: string): Promise<void>
  /**
   * Queue a message to send. `sendAfterMs` is the earliest send time (now for
   * immediate, a few seconds out for an undo window, later for scheduling).
   * Resolves with the message's Message-ID.
   */
  queueSend(input: LocalMessageInput, sendAfterMs: number): Promise<string>
  /**
   * Pull a queued message back before it leaves. `asDraft` keeps it as a draft
   * (cancelling a scheduled send); otherwise it is deleted (toast Undo).
   * Resolves false when it was already sending/sent.
   */
  cancelSend(accountId: string, messageIdHdr: string, asDraft: boolean): Promise<boolean>
  /** Re-queue a failed send */
  retrySend(accountId: string, messageIdHdr: string): Promise<void>

  /** Outbox ops that have hit at least one error (still retrying, or parked) */
  listOutbox(): Promise<WireOp[]>
  retryOutbox(ids?: number[]): Promise<void>
  /** Drop ops and re-fetch the affected messages from Gmail so local state matches the server */
  discardOutbox(ids?: number[]): Promise<void>

  getSettings(): Promise<Record<string, string>>
  setSetting(key: string, value: string): Promise<void>

  refresh(): Promise<void>
  syncStatus(): Promise<SyncStatus[]>
  /** Subscribe to "local store changed" pushes; returns unsubscribe */
  onMailChanged(cb: () => void): () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: MailApi
  }
}
