import { ElectronAPI } from '@electron-toolkit/preload'

/**
 * Wire types shared by the main process, preload, and renderer. This .d.ts is
 * the one preload file both tsconfig projects include, so it is where the IPC
 * contract lives.
 */

export type Folder = 'inbox' | 'archive' | 'sent' | 'drafts' | 'trash' | 'spam'

export type MailAction = 'seen' | 'flagged' | 'archive' | 'unarchive' | 'trash' | 'spam' | 'inbox'

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
  gmailId: string
  threadId: string
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
}

export interface SendMailInput {
  accountId: string
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
  mailAction(p: {
    accountId: string
    gmailIds: string[]
    action: MailAction
    value?: boolean
  }): Promise<void>
  /** Send through Gmail; resolves with the stored synced copy of the sent message */
  sendMail(input: SendMailInput): Promise<WireMessage>
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
