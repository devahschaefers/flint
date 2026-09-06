import { create } from 'zustand'
import type { Account, Category, Contact, Message } from './data/types'
import { parseAddressList } from './lib/address'
import { threadRootId } from './lib/threads'
import { deriveContacts, wireToAccount, wireToMessage } from './lib/wire'
import type { LocalMessageInput, MailAction, WireOp } from '../../preload/index.d'
import type { RailItem } from './components/sidebar/IconRail'

/**
 * Renderer state. Everything durable (mail, drafts, outgoing messages, the
 * outbox, settings) lives in SQLite in the main process; this store is a view
 * over it plus navigation. Mutations go over IPC and come back through the
 * `mail:changed` push, so nothing here is ever the only copy.
 */

/** Folder-style lists reachable from the rail/sidebar ('pins' = flagged, not a folder) */
export type FolderView = 'pins' | 'drafts' | 'sent' | 'trash' | 'spam' | 'archive'

export type View =
  | { name: 'inbox' }
  | { name: 'group'; category: Category }
  | { name: 'folder'; folder: FolderView }
  | { name: 'thread'; threadId: string }
  | { name: 'settings' }

export function makeMessageId(): string {
  return `<${crypto.randomUUID()}@flint.local>`
}

/** Is this one of the user's own addresses? (used for sent rendering and reply targeting) */
export function isOwnAddress(address: string): boolean {
  const key = address.toLowerCase()
  return useAppStore.getState().accounts.some((a) => a.identity.address.toLowerCase() === key)
}

/** Cap on hydrated messages per account (server-side paged queries replace this later) */
const WINDOW_PER_ACCOUNT = 1500

/** Undo window before a reply actually leaves the machine */
const UNDO_SEND_MS = 5000

function hasMailApi(): boolean {
  return typeof window.api?.listAccounts === 'function'
}

function logFailure(what: string): (err: unknown) => void {
  return (err) => console.error(`${what} failed:`, err)
}

/** Queue a label action for the affected synced messages (main mirrors it locally at once) */
function remoteAction(affected: Message[], action: MailAction, value?: boolean): void {
  if (!useAppStore.getState().connected) return
  const byAccount = new Map<string, string[]>()
  for (const m of affected) {
    if (!m.gmailId) continue
    byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m.gmailId])
  }
  for (const [accountId, gmailIds] of byAccount) {
    window.api.mailAction({ accountId, gmailIds, action, value }).catch(logFailure('mail action'))
  }
}

let reloading = false
let reloadQueued = false
/** Re-hydrate messages, contacts, and outbox status from the local DB */
async function reloadMail(): Promise<void> {
  if (reloading) {
    reloadQueued = true
    return
  }
  reloading = true
  try {
    const [wires, outbox] = await Promise.all([
      window.api.getMailWindow(WINDOW_PER_ACCOUNT),
      window.api.listOutbox()
    ])
    const s = useAppStore.getState()
    if (!s.connected) return
    const messages = wires.map(wireToMessage)
    const own = new Set(s.accounts.map((a) => a.identity.address.toLowerCase()))
    useAppStore.setState({
      messages,
      contacts: deriveContacts(messages, own),
      outbox
    })
  } finally {
    reloading = false
    if (reloadQueued) {
      reloadQueued = false
      void reloadMail()
    }
  }
}

let subscribed = false
function subscribeOnce(): void {
  if (subscribed || !hasMailApi()) return
  subscribed = true
  window.api.onMailChanged(() => void reloadMail())
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** Messages in a thread, date ascending */
function threadMessages(messages: Message[], threadId: string): Message[] {
  return messages
    .filter((m) => threadRootId(m) === threadId)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export interface ComposerInput {
  /** Raw To-field text; parsed as an RFC 5322 address list */
  to: string
  subject: string
  /** Plain-text body (the text/plain part) */
  body: string
  /** Rich body markup (the text/html part), when composed in the rich editor */
  html?: string
  accountId: string
  draftId?: string | null
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Append the signature to a rich body the same way it lands in the text part */
function withSignatureHtml(html: string, signature: string): string {
  return `${html}<p>${escapeHtml(signature)}</p>`
}

/** Plain-text part: paragraphs, then the signature as its own paragraph */
function withSignatureText(body: string, signature: string): string {
  return [...toParagraphs(body), signature].join('\n\n')
}

/** Settings keys as stored in main's config table */
const SETTING_KEYS = {
  signature: 'signature',
  hideDone: 'hide_done',
  showWordCount: 'show_word_count'
} as const

interface AppState {
  view: View
  prevView: View | null
  railItem: RailItem
  sidebarOpen: boolean
  activeAccountId: string
  accounts: Account[]
  /** True once at least one account is connected */
  connected: boolean
  messages: Message[]
  contacts: Contact[]
  /** Outbox operations that have hit at least one error (retrying or parked) */
  outbox: WireOp[]
  /** When true (default) archived threads are hidden from the inbox lists */
  hideDone: boolean
  searchOpen: boolean
  composer: { open: boolean; draftId: string | null }
  signature: string
  showWordCount: boolean
  refreshCount: number

  /** Hydrate accounts, settings, and mail from the local DB (empty state when no account) */
  init: () => Promise<void>

  // navigation
  openGroup: (category: Category) => void
  openFolder: (folder: FolderView) => void
  openThread: (threadId: string) => void
  openSettings: () => void
  back: () => void
  goInbox: () => void
  setRailItem: (item: RailItem) => void
  setSidebarOpen: (open: boolean) => void
  setAccount: (accountId: string) => void

  // mail actions (thread-level unless noted)
  toggleArchiveThread: (threadId: string) => void
  archiveThreads: (threadIds: string[]) => void
  toggleFlagged: (threadId: string) => void
  toggleSeen: (threadId: string) => void
  moveThread: (threadId: string, folder: 'inbox' | 'trash' | 'spam') => void
  deleteDraft: (messageId: string) => void
  sendMessage: (input: ComposerInput) => void
  saveDraft: (input: ComposerInput) => void
  /** Queues the reply (undo window first); returns its Message-ID, or null when nothing was sent */
  sendReply: (threadId: string, body: string, html?: string) => string | null
  /** Pull a queued reply back before it leaves (toast Undo) */
  unsend: (messageId: string) => void
  /** "Send later": queues the reply to leave after the delay; persisted, survives restarts */
  scheduleReply: (threadId: string, body: string, html: string | undefined, delayMs: number) => void
  /** Turn a scheduled (or failed) message back into a draft */
  cancelScheduled: (messageId: string) => void
  /** Re-queue a failed send */
  retrySend: (messageId: string) => void
  /** Outbox recovery: push every errored op again, or drop them and re-fetch from Gmail */
  retryOutbox: () => void
  discardOutbox: () => void
  refreshInbox: () => void

  // ui state
  toggleHideDone: () => void
  setSearchOpen: (open: boolean) => void
  openCompose: (draftId?: string | null) => void
  closeCompose: () => void
  setSignature: (signature: string) => void
  toggleShowWordCount: () => void
}

export const useAppStore = create<AppState>()((set, get) => ({
  view: { name: 'inbox' },
  prevView: null,
  railItem: 'inbox',
  sidebarOpen: false,
  activeAccountId: 'all',
  accounts: [],
  connected: false,
  messages: [],
  contacts: [],
  outbox: [],
  hideDone: true,
  searchOpen: false,
  composer: { open: false, draftId: null },
  signature: '',
  showWordCount: true,
  refreshCount: 0,

  init: async () => {
    if (!hasMailApi()) return
    const [wireAccounts, settings] = await Promise.all([
      window.api.listAccounts(),
      window.api.getSettings()
    ])
    set({
      signature: settings[SETTING_KEYS.signature] ?? '',
      hideDone: settings[SETTING_KEYS.hideDone] !== 'false',
      showWordCount: settings[SETTING_KEYS.showWordCount] !== 'false'
    })
    if (wireAccounts.length === 0) {
      set({
        connected: false,
        accounts: [],
        messages: [],
        contacts: [],
        outbox: [],
        activeAccountId: 'all'
      })
      return
    }
    const accs = wireAccounts.map(wireToAccount)
    set((s) => ({
      connected: true,
      accounts: accs,
      activeAccountId:
        s.activeAccountId !== 'all' && !accs.some((a) => a.id === s.activeAccountId)
          ? 'all'
          : s.activeAccountId
    }))
    await reloadMail()
    subscribeOnce()
  },

  openGroup: (category) => set({ view: { name: 'group', category } }),
  openFolder: (folder) => set({ view: { name: 'folder', folder } }),
  openThread: (threadId) => {
    const unseen = threadMessages(get().messages, threadId).filter((m) => !m.flags.seen)
    set((s) => ({
      view: { name: 'thread', threadId },
      prevView: s.view.name === 'thread' || s.view.name === 'settings' ? s.prevView : s.view
    }))
    remoteAction(unseen, 'seen', true)
  },
  openSettings: () =>
    set((s) => ({
      view: { name: 'settings' },
      prevView: s.view.name === 'thread' || s.view.name === 'settings' ? s.prevView : s.view
    })),
  back: () =>
    set((s) => {
      if (s.view.name === 'thread' || s.view.name === 'settings') {
        return { view: s.prevView ?? { name: 'inbox' }, prevView: null }
      }
      return { view: { name: 'inbox' }, prevView: null }
    }),
  goInbox: () => set({ view: { name: 'inbox' }, prevView: null, railItem: 'inbox' }),
  setRailItem: (item) =>
    set(() => {
      const base = { railItem: item, prevView: null }
      if (item === 'home' || item === 'inbox') return { ...base, view: { name: 'inbox' } as View }
      return { ...base, view: { name: 'folder', folder: item } as View }
    }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setAccount: (activeAccountId) => set({ activeAccountId }),

  toggleArchiveThread: (threadId) => {
    const inThread = threadMessages(get().messages, threadId)
    const anyInbox = inThread.some((m) => m.folder === 'inbox')
    if (anyInbox) {
      remoteAction(
        inThread.filter((m) => m.folder === 'inbox'),
        'archive'
      )
    } else {
      remoteAction(
        inThread.filter((m) => m.folder === 'archive'),
        'unarchive'
      )
    }
  },
  archiveThreads: (threadIds) => {
    const ids = new Set(threadIds)
    const affected = get().messages.filter((m) => ids.has(threadRootId(m)) && m.folder === 'inbox')
    remoteAction(affected, 'archive')
  },
  toggleFlagged: (threadId) => {
    const inThread = threadMessages(get().messages, threadId)
    const anyFlagged = inThread.some((m) => m.flags.flagged)
    remoteAction(inThread, 'flagged', !anyFlagged)
  },
  toggleSeen: (threadId) => {
    const inThread = threadMessages(get().messages, threadId)
    const anyUnseen = inThread.some((m) => !m.flags.seen)
    remoteAction(inThread, 'seen', anyUnseen)
  },
  moveThread: (threadId, folder) => {
    const affected = threadMessages(get().messages, threadId).filter(
      (m) => m.folder !== 'sent' && m.folder !== 'drafts'
    )
    remoteAction(affected, folder)
  },
  deleteDraft: (messageId) => {
    const draft = get().messages.find((m) => m.messageId === messageId)
    if (!draft) return
    window.api.deleteLocalMessage(draft.accountId, messageId).catch(logFailure('delete draft'))
  },
  sendMessage: ({ to, subject, body, html, accountId, draftId }) => {
    const s0 = get()
    const account = s0.accounts.find((a) => a.id === accountId) ?? s0.accounts[0]
    if (!account || !s0.connected) return
    // Sending a draft keeps its threading chain (In-Reply-To/References) and
    // category, exactly as saveDraft preserved them.
    const existing = draftId ? s0.messages.find((m) => m.messageId === draftId) : undefined
    const input: LocalMessageInput = {
      accountId: account.id,
      messageIdHdr: draftId ?? makeMessageId(),
      to: parseAddressList(to),
      cc: [],
      subject: subject || '(no subject)',
      text: withSignatureText(body, s0.signature),
      html: html ? withSignatureHtml(html, s0.signature) : undefined,
      inReplyTo: existing?.inReplyTo,
      references: existing?.references ?? [],
      threadId: existing?.threadId,
      category: existing?.category ?? 'people'
    }
    set({ composer: { open: false, draftId: null } })
    // Composer sends go out immediately (the reply toast's Undo is the delayed path)
    window.api.queueSend(input, Date.now()).catch(logFailure('send'))
  },
  saveDraft: ({ to, subject, body, html, accountId, draftId }) => {
    const s = get()
    const account = s.accounts.find((a) => a.id === accountId) ?? s.accounts[0]
    if (!account || !s.connected) return
    const existing = draftId ? s.messages.find((m) => m.messageId === draftId) : undefined
    const input: LocalMessageInput = {
      accountId: account.id,
      messageIdHdr: draftId ?? makeMessageId(),
      to: parseAddressList(to),
      cc: [],
      subject: subject || '(no subject)',
      text: toParagraphs(body).join('\n\n'),
      html,
      inReplyTo: existing?.inReplyTo,
      references: existing?.references ?? [],
      threadId: existing?.threadId,
      category: existing?.category ?? 'people'
    }
    set({ composer: { open: false, draftId: null } })
    window.api.saveDraft(input).catch(logFailure('save draft'))
  },
  sendReply: (threadId, body, html) => queueReply(get(), threadId, body, html, UNDO_SEND_MS),
  unsend: (messageId) => {
    const target = get().messages.find((m) => m.messageId === messageId)
    if (!target) return
    window.api.cancelSend(target.accountId, messageId, false).catch(logFailure('undo send'))
  },
  scheduleReply: (threadId, body, html, delayMs) => {
    queueReply(get(), threadId, body, html, delayMs)
  },
  cancelScheduled: (messageId) => {
    const target = get().messages.find((m) => m.messageId === messageId)
    if (!target) return
    window.api.cancelSend(target.accountId, messageId, true).catch(logFailure('cancel send'))
  },
  retrySend: (messageId) => {
    const target = get().messages.find((m) => m.messageId === messageId)
    if (!target) return
    window.api.retrySend(target.accountId, messageId).catch(logFailure('retry send'))
  },
  retryOutbox: () => {
    window.api.retryOutbox().catch(logFailure('retry outbox'))
  },
  discardOutbox: () => {
    window.api.discardOutbox().catch(logFailure('discard outbox'))
  },
  refreshInbox: () => {
    if (!get().connected) return
    void window.api.refresh().catch(logFailure('refresh'))
    set((s) => ({ refreshCount: s.refreshCount + 1 }))
  },

  toggleHideDone: () => {
    const hideDone = !get().hideDone
    set({ hideDone })
    persistSetting(SETTING_KEYS.hideDone, String(hideDone))
  },
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openCompose: (draftId = null) => set({ composer: { open: true, draftId } }),
  closeCompose: () => set({ composer: { open: false, draftId: null } }),
  setSignature: (signature) => {
    set({ signature })
    persistSetting(SETTING_KEYS.signature, signature)
  },
  toggleShowWordCount: () => {
    const showWordCount = !get().showWordCount
    set({ showWordCount })
    persistSetting(SETTING_KEYS.showWordCount, String(showWordCount))
  }
}))

function persistSetting(key: string, value: string): void {
  if (!hasMailApi()) return
  window.api.setSetting(key, value).catch(logFailure('save setting'))
}

/**
 * Build a reply to the latest counterpart in a thread and queue it to leave
 * after `delayMs`. Recipients and body are fixed now and persisted with the
 * message, so later activity in the thread cannot change where it goes.
 */
function queueReply(
  s: AppState,
  threadId: string,
  body: string,
  html: string | undefined,
  delayMs: number
): string | null {
  if (!body.trim() || !s.connected) return null
  const inThread = threadMessages(s.messages, threadId)
  if (inThread.length === 0) return null
  const latest = inThread[inThread.length - 1]
  // Reply targets the latest counterpart message: its Reply-To/From, unless
  // that is us (replying on our own sent thread) — then keep writing to its To.
  const counterpart = [...inThread].reverse().find((m) => !isOwnAddress(m.from.address))
  const target = counterpart ?? latest
  const recipients = isOwnAddress(target.from.address) ? target.to : [target.replyTo ?? target.from]
  const account = s.accounts.find((a) => a.id === target.accountId) ?? s.accounts[0]
  if (!account) return null
  const messageIdHdr = makeMessageId()
  const input: LocalMessageInput = {
    accountId: account.id,
    messageIdHdr,
    to: recipients,
    cc: [],
    subject: latest.subject.match(/^re:/i) ? latest.subject : `Re: ${latest.subject}`,
    text: withSignatureText(body, s.signature),
    html: html ? withSignatureHtml(html, s.signature) : undefined,
    inReplyTo: latest.messageId,
    references: [...latest.references, latest.messageId],
    threadId: [...inThread].reverse().find((m) => m.threadId)?.threadId,
    category: latest.category
  }
  window.api.queueSend(input, Date.now() + delayMs).catch(logFailure('send reply'))
  return messageIdHdr
}

/** Messages visible under the current account filter */
export function filterByAccount(messages: Message[], activeAccountId: string): Message[] {
  if (activeAccountId === 'all') return messages
  return messages.filter((m) => m.accountId === activeAccountId)
}
