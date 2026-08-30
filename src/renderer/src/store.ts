import { create } from 'zustand'
import type { Account, Category, Contact, Folder, Mailbox, Message } from './data/types'
import { parseAddressList } from './lib/address'
import { threadRootId } from './lib/threads'
import { deriveContacts, wireToAccount, wireToMessage } from './lib/wire'
import type { MailAction } from '../../preload/index.d'
import type { RailItem } from './components/sidebar/IconRail'

/** Folder-style lists reachable from the rail/sidebar ('pins' = flagged, not a folder) */
export type FolderView = 'pins' | 'drafts' | 'sent' | 'trash' | 'spam' | 'archive'

export type View =
  | { name: 'inbox' }
  | { name: 'group'; category: Category }
  | { name: 'folder'; folder: FolderView }
  | { name: 'thread'; threadId: string }
  | { name: 'settings' }

export function makeMessageId(): string {
  return `<${crypto.randomUUID()}@sparkclone.local>`
}

/** Is this one of the user's own addresses? (used for sent rendering and reply targeting) */
export function isOwnAddress(address: string): boolean {
  const key = address.toLowerCase()
  return useAppStore.getState().accounts.some((a) => a.identity.address.toLowerCase() === key)
}

/** Cap on hydrated messages per account (server-side paged queries replace this later) */
const WINDOW_PER_ACCOUNT = 1500

function hasMailApi(): boolean {
  return typeof window.api?.listAccounts === 'function'
}

/** Push a UI action to Gmail for the affected synced messages (fire-and-forget) */
function remoteAction(affected: Message[], action: MailAction, value?: boolean): void {
  if (!useAppStore.getState().connected) return
  const byAccount = new Map<string, string[]>()
  for (const m of affected) {
    if (!m.gmailId) continue
    byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m.gmailId])
  }
  for (const [accountId, gmailIds] of byAccount) {
    window.api.mailAction({ accountId, gmailIds, action, value }).catch((err) => {
      console.error('mail action failed:', err)
    })
  }
}

let reloading = false
let reloadQueued = false
/** Re-hydrate messages/contacts from the local DB, keeping unsynced local messages */
async function reloadMail(): Promise<void> {
  if (reloading) {
    reloadQueued = true
    return
  }
  reloading = true
  try {
    const wires = await window.api.getMailWindow(WINDOW_PER_ACCOUNT)
    const s = useAppStore.getState()
    if (!s.connected) return
    const synced = wires.map(wireToMessage)
    // Locally-composed mail (sent/drafts without a gmailId) survives reloads
    const localOnly = s.messages.filter((m) => !m.gmailId)
    const own = new Set(s.accounts.map((a) => a.identity.address.toLowerCase()))
    useAppStore.setState({
      messages: [...localOnly, ...synced],
      contacts: deriveContacts(synced, own)
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

/** Auto-learn recipients into contacts (Gmail's "other contacts") without overwriting */
function collectContacts(contacts: Contact[], recipients: Mailbox[]): Contact[] {
  const known = new Set(contacts.map((c) => c.address))
  const learned: Contact[] = []
  for (const r of recipients) {
    const key = r.address.toLowerCase()
    if (!known.has(key) && r.name && !isOwnAddress(key)) {
      known.add(key)
      learned.push({ address: key, name: r.name, source: 'collected' })
    }
  }
  return learned.length ? [...contacts, ...learned] : contacts
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
  /** When true (default) archived threads are hidden from the inbox lists */
  hideDone: boolean
  searchOpen: boolean
  composer: { open: boolean; draftId: string | null }
  signature: string
  refreshCount: number

  /** Hydrate accounts + mail from the local DB (empty state when no account) */
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
  /** Returns the sent reply's Message-ID (for undo), or null when nothing was sent */
  sendReply: (threadId: string, body: string, html?: string) => string | null
  /** Remove a just-sent message and revert the parent's \Answered flag (toast Undo) */
  unsend: (messageId: string) => void
  /** "Send later": fires sendReply after the delay (in-session scheduler) */
  scheduleReply: (threadId: string, body: string, html: string | undefined, delayMs: number) => void
  refreshInbox: () => void

  // ui state
  toggleHideDone: () => void
  setSearchOpen: (open: boolean) => void
  openCompose: (draftId?: string | null) => void
  closeCompose: () => void
  setSignature: (signature: string) => void
  showWordCount: boolean
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
  hideDone: true,
  searchOpen: false,
  composer: { open: false, draftId: null },
  signature: 'Devah',
  refreshCount: 0,

  init: async () => {
    if (!hasMailApi()) return
    const wireAccounts = await window.api.listAccounts()
    if (wireAccounts.length === 0) {
      set({
        connected: false,
        accounts: [],
        messages: [],
        contacts: [],
        activeAccountId: 'all'
      })
      return
    }
    const accs = wireAccounts.map(wireToAccount)
    set((s) => ({
      connected: true,
      accounts: accs,
      // Drop whatever was on screen; reload refills
      messages: [],
      contacts: [],
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
      prevView: s.view.name === 'thread' || s.view.name === 'settings' ? s.prevView : s.view,
      messages: s.messages.map((m) =>
        threadRootId(m) === threadId && !m.flags.seen
          ? { ...m, flags: { ...m.flags, seen: true } }
          : m
      )
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
    set((s) => ({
      messages: s.messages.map((m) => {
        if (threadRootId(m) !== threadId) return m
        if (anyInbox && m.folder === 'inbox') return { ...m, folder: 'archive' as Folder }
        if (!anyInbox && m.folder === 'archive') return { ...m, folder: 'inbox' as Folder }
        return m
      })
    }))
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
    const affected = get().messages.filter(
      (m) => ids.has(threadRootId(m)) && m.folder === 'inbox'
    )
    set((s) => ({
      messages: s.messages.map((m) =>
        ids.has(threadRootId(m)) && m.folder === 'inbox' ? { ...m, folder: 'archive' } : m
      )
    }))
    remoteAction(affected, 'archive')
  },
  toggleFlagged: (threadId) => {
    const inThread = threadMessages(get().messages, threadId)
    const anyFlagged = inThread.some((m) => m.flags.flagged)
    set((s) => ({
      messages: s.messages.map((m) =>
        threadRootId(m) === threadId ? { ...m, flags: { ...m.flags, flagged: !anyFlagged } } : m
      )
    }))
    remoteAction(inThread, 'flagged', !anyFlagged)
  },
  toggleSeen: (threadId) => {
    const inThread = threadMessages(get().messages, threadId)
    const anyUnseen = inThread.some((m) => !m.flags.seen)
    set((s) => ({
      messages: s.messages.map((m) =>
        threadRootId(m) === threadId ? { ...m, flags: { ...m.flags, seen: anyUnseen } } : m
      )
    }))
    remoteAction(inThread, 'seen', anyUnseen)
  },
  moveThread: (threadId, folder) => {
    const affected = threadMessages(get().messages, threadId).filter(
      (m) => m.folder !== 'sent' && m.folder !== 'drafts'
    )
    set((s) => ({
      messages: s.messages.map((m) =>
        threadRootId(m) === threadId && m.folder !== 'sent' && m.folder !== 'drafts'
          ? { ...m, folder }
          : m
      )
    }))
    remoteAction(affected, folder)
  },
  deleteDraft: (messageId) =>
    set((s) => ({ messages: s.messages.filter((m) => m.messageId !== messageId) })),
  sendMessage: ({ to, subject, body, html, accountId, draftId }) =>
    set((s) => {
      const account = s.accounts.find((a) => a.id === accountId) ?? s.accounts[0]
      if (!account) return {}
      const recipients = parseAddressList(to)
      // Sending a draft keeps its threading chain (In-Reply-To/References) and
      // category, exactly as saveDraft preserved them.
      const existing = draftId ? s.messages.find((m) => m.messageId === draftId) : undefined
      const message: Message = {
        messageId: makeMessageId(),
        inReplyTo: existing?.inReplyTo,
        references: existing?.references ?? [],
        from: account.identity,
        to: recipients,
        cc: [],
        subject: subject || '(no subject)',
        date: new Date().toISOString(),
        body: [...toParagraphs(body), s.signature],
        bodyHtml: html ? withSignatureHtml(html, s.signature) : undefined,
        accountId: account.id,
        folder: 'sent',
        flags: { seen: true, flagged: false, answered: false },
        category: existing?.category ?? 'people',
        important: false
      }
      return {
        messages: [
          message,
          ...s.messages
            .filter((m) => m.messageId !== draftId)
            .map((m) =>
              existing?.inReplyTo && m.messageId === existing.inReplyTo
                ? { ...m, flags: { ...m.flags, answered: true } }
                : m
            )
        ],
        contacts: collectContacts(s.contacts, recipients),
        composer: { open: false, draftId: null }
      }
    }),
  saveDraft: ({ to, subject, body, html, accountId, draftId }) =>
    set((s) => {
      const account = s.accounts.find((a) => a.id === accountId) ?? s.accounts[0]
      if (!account) return {}
      const existing = draftId ? s.messages.find((m) => m.messageId === draftId) : undefined
      const draft: Message = {
        messageId: draftId ?? makeMessageId(),
        inReplyTo: existing?.inReplyTo,
        references: existing?.references ?? [],
        from: account.identity,
        to: parseAddressList(to),
        cc: [],
        subject: subject || '(no subject)',
        date: new Date().toISOString(),
        body: toParagraphs(body),
        bodyHtml: html,
        accountId: account.id,
        folder: 'drafts',
        flags: { seen: true, flagged: false, answered: false },
        category: 'people',
        important: false
      }
      return {
        messages: [draft, ...s.messages.filter((m) => m.messageId !== draftId)],
        composer: { open: false, draftId: null }
      }
    }),
  sendReply: (threadId, body, html) => {
    const s = get()
    if (!body.trim()) return null
    const inThread = threadMessages(s.messages, threadId)
    if (inThread.length === 0) return null
    const latest = inThread[inThread.length - 1]
    // Reply targets the latest counterpart message: its Reply-To/From, unless
    // that is us (replying on our own sent thread) — then keep writing to its To.
    const counterpart = [...inThread].reverse().find((m) => !isOwnAddress(m.from.address))
    const target = counterpart ?? latest
    const recipients = isOwnAddress(target.from.address)
      ? target.to
      : [target.replyTo ?? target.from]
    const account = s.accounts.find((a) => a.id === target.accountId) ?? s.accounts[0]
    if (!account) return null
    const reply: Message = {
      messageId: makeMessageId(),
      inReplyTo: latest.messageId,
      references: [...latest.references, latest.messageId],
      from: account.identity,
      to: recipients,
      cc: [],
      subject: latest.subject.match(/^re:/i) ? latest.subject : `Re: ${latest.subject}`,
      date: new Date().toISOString(),
      body: [...toParagraphs(body), s.signature],
      bodyHtml: html ? withSignatureHtml(html, s.signature) : undefined,
      accountId: account.id,
      folder: 'sent',
      flags: { seen: true, flagged: false, answered: false },
      category: latest.category,
      important: false
    }
    set({
      messages: [
        reply,
        ...s.messages.map((m) =>
          m.messageId === target.messageId ? { ...m, flags: { ...m.flags, answered: true } } : m
        )
      ],
      contacts: collectContacts(s.contacts, recipients)
    })
    return reply.messageId
  },
  unsend: (messageId) =>
    set((s) => {
      const target = s.messages.find((m) => m.messageId === messageId)
      if (!target || target.folder !== 'sent') return {}
      const rest = s.messages.filter((m) => m.messageId !== messageId)
      const parentId = target.inReplyTo
      if (!parentId) return { messages: rest }
      // \Answered stays only if another of our replies still points at the parent
      const stillAnswered = rest.some(
        (m) => m.inReplyTo === parentId && isOwnAddress(m.from.address)
      )
      return {
        messages: rest.map((m) =>
          m.messageId === parentId && !stillAnswered
            ? { ...m, flags: { ...m.flags, answered: false } }
            : m
        )
      }
    }),
  scheduleReply: (threadId, body, html, delayMs) => {
    window.setTimeout(() => get().sendReply(threadId, body, html), delayMs)
  },
  refreshInbox: () => {
    if (!get().connected) return
    void window.api.refresh().catch((err) => console.error('refresh failed:', err))
    set((s) => ({ refreshCount: s.refreshCount + 1 }))
  },

  toggleHideDone: () => set((s) => ({ hideDone: !s.hideDone })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openCompose: (draftId = null) => set({ composer: { open: true, draftId } }),
  closeCompose: () => set({ composer: { open: false, draftId: null } }),
  setSignature: (signature) => set({ signature }),
  showWordCount: true,
  toggleShowWordCount: () => set((s) => ({ showWordCount: !s.showWordCount }))
}))

/** Messages visible under the current account filter */
export function filterByAccount(messages: Message[], activeAccountId: string): Message[] {
  if (activeAccountId === 'all') return messages
  return messages.filter((m) => m.accountId === activeAccountId)
}
