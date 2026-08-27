import { create } from 'zustand'
import type { Category, Email, Sender } from './data/types'
import { emails as mockEmails, makeIncomingEmail } from './data/mock'
import type { RailItem } from './components/sidebar/IconRail'

/** Folder-style lists reachable from the rail/sidebar (pins/archive are flags, not folders) */
export type FolderView = 'pins' | 'drafts' | 'sent' | 'trash' | 'spam' | 'archive'

export type View =
  | { name: 'inbox' }
  | { name: 'group'; category: Category }
  | { name: 'folder'; folder: FolderView }
  | { name: 'email'; emailId: string }
  | { name: 'settings' }

const AVATAR_COLORS = [
  '#6623FF', '#2196F3', '#EC00AF', '#C56BDA', '#43A047', '#FF7043',
  '#0288D1', '#7B1FA2', '#00897B', '#5C6BC0', '#D81B60', '#F4511E'
]

/** Build a Sender for a typed-in recipient like "Priya Raghavan" or "priya@kcl.ac.uk" */
export function senderFromRecipient(to: string): Sender {
  const trimmed = to.trim()
  const isEmail = trimmed.includes('@')
  const name = isEmail
    ? trimmed
        .split('@')[0]
        .split(/[._-]/)
        .filter(Boolean)
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join(' ')
    : trimmed
  const email = isEmail ? trimmed : `${trimmed.toLowerCase().replace(/\s+/g, '.')}@gmail.com`
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return { name, email, initials: initials || '?', color: AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] }
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export interface ComposerDraftInput {
  to: string
  subject: string
  body: string
  accountId: string
  /** When set, sending/saving replaces this existing draft */
  draftId?: string | null
}

interface AppState {
  view: View
  /** List view to return to when closing an open email or settings */
  prevView: View | null
  railItem: RailItem
  sidebarOpen: boolean
  /** 'all' or an account id — filters every list */
  activeAccountId: string
  emails: Email[]
  /** When true (default, like Spark) done emails are hidden from lists */
  hideDone: boolean
  searchOpen: boolean
  composer: { open: boolean; draftId: string | null }
  signature: string
  /** Bumped by refreshInbox so views can show a brief refresh state */
  refreshCount: number

  // navigation
  openGroup: (category: Category) => void
  openFolder: (folder: FolderView) => void
  openEmail: (emailId: string) => void
  openSettings: () => void
  back: () => void
  goInbox: () => void
  setRailItem: (item: RailItem) => void
  setSidebarOpen: (open: boolean) => void
  setAccount: (accountId: string) => void

  // mail actions
  toggleDone: (emailId: string) => void
  /** Mark many emails done at once (group check button) */
  markDone: (emailIds: string[]) => void
  togglePin: (emailId: string) => void
  toggleRead: (emailId: string) => void
  moveTo: (emailId: string, folder: 'inbox' | 'trash' | 'spam') => void
  deleteDraft: (emailId: string) => void
  /** Create a sent email from the composer (appends signature) */
  sendEmail: (input: ComposerDraftInput) => void
  /** Save composer contents as a draft */
  saveDraft: (input: ComposerDraftInput) => void
  /** Append a reply to a thread and drop a copy in Sent (appends signature) */
  sendReply: (emailId: string, body: string) => void
  /** Simulate mail sync: a fresh unread email arrives in the inbox */
  refreshInbox: () => void

  // ui state
  toggleHideDone: () => void
  setSearchOpen: (open: boolean) => void
  openCompose: (draftId?: string | null) => void
  closeCompose: () => void
  setSignature: (signature: string) => void
}

let sendCounter = 0

export const useAppStore = create<AppState>()((set) => ({
  view: { name: 'inbox' },
  prevView: null,
  railItem: 'inbox',
  sidebarOpen: false,
  activeAccountId: 'all',
  emails: mockEmails,
  hideDone: true,
  searchOpen: false,
  composer: { open: false, draftId: null },
  signature: 'Devah',
  refreshCount: 0,

  openGroup: (category) => set({ view: { name: 'group', category } }),
  openFolder: (folder) => set({ view: { name: 'folder', folder } }),
  openEmail: (emailId) =>
    set((s) => ({
      view: { name: 'email', emailId },
      prevView: s.view.name === 'email' || s.view.name === 'settings' ? s.prevView : s.view,
      emails: s.emails.map((e) => (e.id === emailId && !e.read ? { ...e, read: true } : e))
    })),
  openSettings: () =>
    set((s) => ({
      view: { name: 'settings' },
      prevView: s.view.name === 'email' || s.view.name === 'settings' ? s.prevView : s.view
    })),
  back: () =>
    set((s) => {
      if (s.view.name === 'email' || s.view.name === 'settings') {
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

  toggleDone: (emailId) =>
    set((s) => ({ emails: s.emails.map((e) => (e.id === emailId ? { ...e, done: !e.done } : e)) })),
  markDone: (emailIds) =>
    set((s) => {
      const ids = new Set(emailIds)
      return { emails: s.emails.map((e) => (ids.has(e.id) ? { ...e, done: true } : e)) }
    }),
  togglePin: (emailId) =>
    set((s) => ({ emails: s.emails.map((e) => (e.id === emailId ? { ...e, pinned: !e.pinned } : e)) })),
  toggleRead: (emailId) =>
    set((s) => ({ emails: s.emails.map((e) => (e.id === emailId ? { ...e, read: !e.read } : e)) })),
  moveTo: (emailId, folder) =>
    set((s) => ({
      emails: s.emails.map((e) => (e.id === emailId ? { ...e, folder, done: false } : e))
    })),
  deleteDraft: (emailId) => set((s) => ({ emails: s.emails.filter((e) => e.id !== emailId) })),
  sendEmail: ({ to, subject, body, accountId, draftId }) =>
    set((s) => {
      const sent: Email = {
        id: `sent-${++sendCounter}-${Date.now()}`,
        accountId: accountId === 'all' ? 'gmail' : accountId,
        sender: senderFromRecipient(to || 'New Message'),
        subject: subject || '(no subject)',
        preview: toParagraphs(body)[0]?.slice(0, 140) ?? '',
        body: [...toParagraphs(body), s.signature],
        date: new Date().toISOString(),
        category: 'people',
        read: true,
        important: false,
        pinned: false,
        folder: 'sent',
        done: false,
        replies: []
      }
      return {
        emails: [sent, ...s.emails.filter((e) => e.id !== draftId)],
        composer: { open: false, draftId: null }
      }
    }),
  saveDraft: ({ to, subject, body, accountId, draftId }) =>
    set((s) => {
      const draft: Email = {
        id: draftId ?? `draft-${++sendCounter}-${Date.now()}`,
        accountId: accountId === 'all' ? 'gmail' : accountId,
        sender: senderFromRecipient(to || 'New Message'),
        subject: subject || '(no subject)',
        preview: toParagraphs(body)[0]?.slice(0, 140) ?? '',
        body: toParagraphs(body),
        date: new Date().toISOString(),
        category: 'people',
        read: true,
        important: false,
        pinned: false,
        folder: 'drafts',
        done: false,
        replies: []
      }
      return {
        emails: [draft, ...s.emails.filter((e) => e.id !== draftId)],
        composer: { open: false, draftId: null }
      }
    }),
  sendReply: (emailId, body) =>
    set((s) => {
      const target = s.emails.find((e) => e.id === emailId)
      if (!target || !body.trim()) return {}
      const paragraphs = [...toParagraphs(body), s.signature]
      const reply = { date: new Date().toISOString(), body: paragraphs }
      const sent: Email = {
        ...target,
        id: `sent-${++sendCounter}-${Date.now()}`,
        subject: target.subject.startsWith('Re:') ? target.subject : `Re: ${target.subject}`,
        preview: paragraphs[0]?.slice(0, 140) ?? '',
        body: paragraphs,
        date: reply.date,
        read: true,
        important: false,
        pinned: false,
        folder: 'sent',
        done: false,
        replies: []
      }
      return {
        emails: [
          sent,
          ...s.emails.map((e) => (e.id === emailId ? { ...e, replies: [...e.replies, reply] } : e))
        ]
      }
    }),
  refreshInbox: () =>
    set((s) => ({
      emails: [makeIncomingEmail(s.emails.length), ...s.emails],
      refreshCount: s.refreshCount + 1
    })),

  toggleHideDone: () => set((s) => ({ hideDone: !s.hideDone })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openCompose: (draftId = null) => set({ composer: { open: true, draftId } }),
  closeCompose: () => set({ composer: { open: false, draftId: null } }),
  setSignature: (signature) => set({ signature })
}))

/** Emails visible under the current account filter */
export function filterByAccount(emails: Email[], activeAccountId: string): Email[] {
  if (activeAccountId === 'all') return emails
  return emails.filter((e) => e.accountId === activeAccountId)
}

/** Standard list filter: account + done-visibility (done emails hidden while hideDone) */
export function visibleEmails(emails: Email[], activeAccountId: string, hideDone: boolean): Email[] {
  const scoped = filterByAccount(emails, activeAccountId)
  return hideDone ? scoped.filter((e) => !e.done) : scoped
}
