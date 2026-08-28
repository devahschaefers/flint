import { create } from 'zustand'
import type { Category, Contact, Folder, Mailbox, Message } from './data/types'
import { accounts, messages as mockMessages, seedContacts, makeIncomingMessage } from './data/mock'
import { parseAddressList } from './lib/address'
import { threadRootId } from './lib/threads'
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
  return accounts.some((a) => a.identity.address.toLowerCase() === key)
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
  body: string
  accountId: string
  draftId?: string | null
}

interface AppState {
  view: View
  prevView: View | null
  railItem: RailItem
  sidebarOpen: boolean
  activeAccountId: string
  messages: Message[]
  contacts: Contact[]
  /** When true (default) archived threads are hidden from the inbox lists */
  hideDone: boolean
  searchOpen: boolean
  composer: { open: boolean; draftId: string | null }
  signature: string
  refreshCount: number

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
  sendReply: (threadId: string, body: string) => void
  refreshInbox: () => void

  // ui state
  toggleHideDone: () => void
  setSearchOpen: (open: boolean) => void
  openCompose: (draftId?: string | null) => void
  closeCompose: () => void
  setSignature: (signature: string) => void
}

export const useAppStore = create<AppState>()((set) => ({
  view: { name: 'inbox' },
  prevView: null,
  railItem: 'inbox',
  sidebarOpen: false,
  activeAccountId: 'all',
  messages: mockMessages,
  contacts: seedContacts,
  hideDone: true,
  searchOpen: false,
  composer: { open: false, draftId: null },
  signature: 'Devah',
  refreshCount: 0,

  openGroup: (category) => set({ view: { name: 'group', category } }),
  openFolder: (folder) => set({ view: { name: 'folder', folder } }),
  openThread: (threadId) =>
    set((s) => ({
      view: { name: 'thread', threadId },
      prevView: s.view.name === 'thread' || s.view.name === 'settings' ? s.prevView : s.view,
      messages: s.messages.map((m) =>
        threadRootId(m) === threadId && !m.flags.seen
          ? { ...m, flags: { ...m.flags, seen: true } }
          : m
      )
    })),
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

  toggleArchiveThread: (threadId) =>
    set((s) => {
      const inThread = threadMessages(s.messages, threadId)
      const anyInbox = inThread.some((m) => m.folder === 'inbox')
      return {
        messages: s.messages.map((m) => {
          if (threadRootId(m) !== threadId) return m
          if (anyInbox && m.folder === 'inbox') return { ...m, folder: 'archive' as Folder }
          if (!anyInbox && m.folder === 'archive') return { ...m, folder: 'inbox' as Folder }
          return m
        })
      }
    }),
  archiveThreads: (threadIds) =>
    set((s) => {
      const ids = new Set(threadIds)
      return {
        messages: s.messages.map((m) =>
          ids.has(threadRootId(m)) && m.folder === 'inbox' ? { ...m, folder: 'archive' } : m
        )
      }
    }),
  toggleFlagged: (threadId) =>
    set((s) => {
      const anyFlagged = threadMessages(s.messages, threadId).some((m) => m.flags.flagged)
      return {
        messages: s.messages.map((m) =>
          threadRootId(m) === threadId ? { ...m, flags: { ...m.flags, flagged: !anyFlagged } } : m
        )
      }
    }),
  toggleSeen: (threadId) =>
    set((s) => {
      const anyUnseen = threadMessages(s.messages, threadId).some((m) => !m.flags.seen)
      return {
        messages: s.messages.map((m) =>
          threadRootId(m) === threadId ? { ...m, flags: { ...m.flags, seen: anyUnseen } } : m
        )
      }
    }),
  moveThread: (threadId, folder) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        threadRootId(m) === threadId && m.folder !== 'sent' && m.folder !== 'drafts'
          ? { ...m, folder }
          : m
      )
    })),
  deleteDraft: (messageId) =>
    set((s) => ({ messages: s.messages.filter((m) => m.messageId !== messageId) })),
  sendMessage: ({ to, subject, body, accountId, draftId }) =>
    set((s) => {
      const account = accounts.find((a) => a.id === accountId) ?? accounts[0]
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
  saveDraft: ({ to, subject, body, accountId, draftId }) =>
    set((s) => {
      const account = accounts.find((a) => a.id === accountId) ?? accounts[0]
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
  sendReply: (threadId, body) =>
    set((s) => {
      if (!body.trim()) return {}
      const inThread = threadMessages(s.messages, threadId)
      if (inThread.length === 0) return {}
      const latest = inThread[inThread.length - 1]
      // Reply targets the latest counterpart message: its Reply-To/From, unless
      // that is us (replying on our own sent thread) — then keep writing to its To.
      const counterpart = [...inThread].reverse().find((m) => !isOwnAddress(m.from.address))
      const target = counterpart ?? latest
      const recipients = isOwnAddress(target.from.address)
        ? target.to
        : [target.replyTo ?? target.from]
      const account = accounts.find((a) => a.id === target.accountId) ?? accounts[0]
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
        accountId: account.id,
        folder: 'sent',
        flags: { seen: true, flagged: false, answered: false },
        category: latest.category,
        important: false
      }
      return {
        messages: [
          reply,
          ...s.messages.map((m) =>
            m.messageId === target.messageId ? { ...m, flags: { ...m.flags, answered: true } } : m
          )
        ],
        contacts: collectContacts(s.contacts, recipients)
      }
    }),
  refreshInbox: () =>
    set((s) => ({
      messages: [makeIncomingMessage(s.messages.length), ...s.messages],
      refreshCount: s.refreshCount + 1
    })),

  toggleHideDone: () => set((s) => ({ hideDone: !s.hideDone })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openCompose: (draftId = null) => set({ composer: { open: true, draftId } }),
  closeCompose: () => set({ composer: { open: false, draftId: null } }),
  setSignature: (signature) => set({ signature })
}))

/** Messages visible under the current account filter */
export function filterByAccount(messages: Message[], activeAccountId: string): Message[] {
  if (activeAccountId === 'all') return messages
  return messages.filter((m) => m.accountId === activeAccountId)
}
