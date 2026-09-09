import { ElectronAPI } from '@electron-toolkit/preload'

/**
 * Wire types shared by the main process, preload, and renderer. This .d.ts is
 * the one preload file both tsconfig projects include, so it is where the IPC
 * contract lives.
 *
 * The renderer never holds mail. Every list is a paged query answered from
 * SQLite (`listThreads`, `search`, `listDrafts`), a thread is fetched when
 * opened (`getThread`), and every action addresses a thread (`threadAction`)
 * so main resolves the messages it touches. The renderer re-runs whatever it
 * has on screen when `onMailChanged` fires.
 */

export type Folder = 'inbox' | 'archive' | 'sent' | 'drafts' | 'trash' | 'spam'

export type MailAction = 'seen' | 'flagged' | 'archive' | 'unarchive' | 'trash' | 'spam' | 'inbox'

/**
 * Lifecycle of a message row.
 * - synced: mirrors Gmail
 * - draft: local draft (may also exist in Gmail's Drafts once pushed)
 * - queued: waiting to be sent (undo window not yet elapsed, or retrying after a transient error)
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
  /**
   * The conversation this message belongs to: Gmail's thread id, or the
   * Message-ID for local mail Gmail hasn't threaded yet. Unique per account.
   */
  threadKey: string
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
  /** When a queued message is due to leave (end of the undo window) */
  sendAfterMs: number | null
  /** Last send error, for queued (retrying) and failed messages */
  sendError: string | null
}

// ---------- thread lists ----------

/** Addresses one conversation; thread keys are unique within an account only */
export interface ThreadRef {
  accountId: string
  threadKey: string
}

/**
 * Which conversations a list shows. Gmail semantics throughout: a thread is in
 * a folder when any of its messages is; "done" means nothing left in the inbox.
 */
export type ThreadListView =
  | {
      kind: 'inbox'
      /** Show threads that are fully archived alongside inbox ones ("show done") */
      includeArchived: boolean
      /** Smart-inbox group: threads whose latest message has this category and that aren't important */
      category?: string | null
      /** Only threads with an important message (the smart inbox's main list) */
      importantOnly?: boolean
    }
  | { kind: 'folder'; folder: 'archive' | 'sent' | 'trash' | 'spam' }
  /** Flagged conversations not sitting in Trash or Spam */
  | { kind: 'pins' }

/** Keyset cursor: everything strictly after this thread in (latest date desc, account, key) order */
export interface ThreadCursor {
  latestDateMs: number
  accountId: string
  threadKey: string
}

export interface ThreadQuery {
  /** Null = every account merged by date */
  accountId: string | null
  view: ThreadListView
  cursor?: ThreadCursor | null
  limit: number
}

/** What a list row needs, computed in SQL over the thread's messages */
export interface WireThread {
  accountId: string
  threadKey: string
  /** Subject of the newest message (reply prefixes not yet stripped) */
  subject: string
  latestDateMs: number
  count: number
  unread: number
  flagged: boolean
  important: boolean
  /** Category of the newest message */
  category: string
  /** Messages per folder */
  folders: Record<Folder, number>
  latest: {
    messageIdHdr: string | null
    from: WireMailbox
    to: WireMailbox[]
    snippet: string
    folder: Folder
    state: MessageState
    sendAfterMs: number | null
    sendError: string | null
  }
  /** Newest sender who is not one of the user's own addresses; null on a pure sent thread */
  counterpart: WireMailbox | null
}

export interface ThreadPage {
  threads: WireThread[]
  /** Pass back to fetch the next page; null when this was the last one */
  nextCursor: ThreadCursor | null
}

/** One smart-inbox group row: how many conversations, and who they're with */
export interface InboxGroup {
  category: string
  count: number
  unread: number
  chips: { mailbox: WireMailbox; count: number; unread: boolean }[]
}

export interface InboxOverview {
  groups: InboxGroup[]
}

/** Thread-level intents; main resolves which messages each one touches */
export type ThreadAction =
  | 'toggleArchive'
  | 'archive'
  | 'toggleFlagged'
  | 'toggleSeen'
  | 'markSeen'
  | 'trash'
  | 'spam'
  | 'inbox'

export interface SearchResult extends WireThread {
  /** The best-matching message in the thread */
  match: { messageIdHdr: string | null; subject: string; snippet: string; rank: number }
}

export interface WireContact {
  /** Lowercased */
  address: string
  name: string
}

export interface UnreadCount {
  accountId: string
  inboxUnread: number
}

// ---------- writes ----------

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

  // reads (all answered from SQLite)
  listThreads(query: ThreadQuery): Promise<ThreadPage>
  inboxOverview(accountId: string | null, includeArchived: boolean): Promise<InboxOverview>
  /** Every message in a conversation, oldest first; fetches missing bodies first */
  getThread(ref: ThreadRef): Promise<WireMessage[]>
  /** Full-text search, best match first, one row per conversation */
  search(query: string, accountId: string | null, limit: number): Promise<SearchResult[]>
  /** Drafts are shown as individual messages, newest first */
  listDrafts(accountId: string | null): Promise<WireMessage[]>
  /** Address book derived from correspondence (senders first, then recipients) */
  listContacts(accountId: string | null): Promise<WireContact[]>
  unreadCounts(): Promise<UnreadCount[]>
  /** One message by its Message-ID header (drafts the composer edits) */
  getMessage(accountId: string, messageIdHdr: string): Promise<WireMessage | null>

  // writes
  /** Apply an intent to whole conversations; main mirrors it locally at once and queues Gmail */
  threadAction(refs: ThreadRef[], action: ThreadAction): Promise<void>
  /** Store a draft (local row + queued push to Gmail Drafts); resolves with its Message-ID */
  saveDraft(input: LocalMessageInput): Promise<string>
  /** Delete a local message (draft, or a failed send); pushes the delete to Gmail when it has a draft there */
  deleteLocalMessage(accountId: string, messageIdHdr: string): Promise<void>
  /**
   * Queue a message to send. `sendAfterMs` is the earliest send time (now for
   * immediate, a few seconds out for an undo window).
   * Resolves with the message's Message-ID.
   */
  queueSend(input: LocalMessageInput, sendAfterMs: number): Promise<string>
  /**
   * Pull a queued or failed message back. `asDraft` keeps it as a draft
   * (editing a failed send); otherwise it is deleted (toast Undo).
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
