import { create } from 'zustand'
import type { Account, Category, Contact, Message } from './data/types'
import { parseAddressList } from './lib/address'
import { wireToAccount } from './lib/wire'
import type {
  LocalMessageInput,
  ThreadAction,
  ThreadCursor,
  ThreadRef,
  UnreadCount,
  WireOp
} from '../../preload/index.d'

/**
 * Renderer state: navigation, accounts, settings, and the small shared bits
 * every view needs (contacts, unread counts, outbox trouble). Mail itself is
 * never held here. Views query main for exactly what they show (see
 * lib/useMailQuery) and re-query when `mailVersion` ticks, which happens on
 * every `mail:changed` push. Mutations go over IPC and come back the same way.
 */

/** Folder-style lists reachable from the header menu ('pins' = flagged, not a folder) */
export type FolderView = 'pins' | 'drafts' | 'sent' | 'trash' | 'spam' | 'archive'

export type View =
  | { name: 'inbox' }
  | { name: 'group'; category: Category }
  | { name: 'folder'; folder: FolderView }
  | { name: 'thread'; ref: ThreadRef }
  | { name: 'settings' }

/** The floating panels summoned from the chrome: the header menu, the account filter */
export type Popover = 'menu' | 'filter' | null

export interface Toast {
  text: string
  undo?: () => void
}

export function makeMessageId(): string {
  return `<${crypto.randomUUID()}@flint.local>`
}

/** Is this one of the user's own addresses? (used for sent rendering and reply targeting) */
export function isOwnAddress(address: string): boolean {
  const key = address.toLowerCase()
  return useAppStore.getState().accounts.some((a) => a.identity.address.toLowerCase() === key)
}

/** Undo window before a reply actually leaves the machine */
const UNDO_SEND_MS = 5000
/** How long a toast stays up */
const TOAST_MS = 3200

function hasMailApi(): boolean {
  return typeof window.api?.listAccounts === 'function'
}

function logFailure(what: string): (err: unknown) => void {
  return (err) => console.error(`${what} failed:`, err)
}

/** Shared lookups every view leans on; cheap queries, refreshed on each change */
async function loadShared(): Promise<void> {
  const s = useAppStore.getState()
  if (!s.connected) return
  const scope = s.activeAccountId === 'all' ? null : s.activeAccountId
  const [contacts, outbox, unread] = await Promise.all([
    window.api.listContacts(scope),
    window.api.listOutbox(),
    window.api.unreadCounts()
  ])
  useAppStore.setState({
    contacts: contacts.map((c) => ({ address: c.address, name: c.name, source: 'collected' })),
    outbox,
    unread
  })
}

let subscribed = false
function subscribeOnce(): void {
  if (subscribed || !hasMailApi()) return
  subscribed = true
  window.api.onMailChanged(() => {
    useAppStore.setState((s) => ({ mailVersion: s.mailVersion + 1 }))
    void loadShared().catch(logFailure('reload'))
  })
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
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

export interface ComposerState {
  open: boolean
  /** The draft being edited, loaded by the opener */
  draftId: string | null
  draft: Message | null
  /** Fields for a fresh message (search's "Compose to …") */
  prefill: { to: string } | null
}

interface AppState {
  view: View
  prevView: View | null
  popover: Popover
  activeAccountId: string
  accounts: Account[]
  /** True once at least one account is connected */
  connected: boolean
  /** Bumped on every `mail:changed`; views re-query when it changes */
  mailVersion: number
  contacts: Contact[]
  /** Outbox operations that have hit at least one error (retrying or parked) */
  outbox: WireOp[]
  unread: UnreadCount[]
  /** When true (default) archived threads are hidden from the inbox lists */
  hideDone: boolean
  searchOpen: boolean
  composer: ComposerState
  signature: string
  showWordCount: boolean
  toast: Toast | null

  /** Hydrate accounts and settings from main (empty state when no account) */
  init: () => Promise<void>

  // navigation
  openGroup: (category: Category) => void
  openFolder: (folder: FolderView) => void
  openThread: (ref: ThreadRef) => void
  openSettings: () => void
  back: () => void
  goInbox: () => void
  setPopover: (popover: Popover) => void
  setAccount: (accountId: string) => void

  // mail actions (thread-level; main resolves the messages)
  threadAction: (refs: ThreadRef | ThreadRef[], action: ThreadAction) => void
  /** Archive a conversation with an undo toast ("Done") */
  done: (ref: ThreadRef) => void
  /** "Mark all done" for a smart-inbox group: every conversation in it, not just the loaded page */
  archiveGroup: (scope: string | null, category: string, includeArchived: boolean) => void
  deleteDraft: (draft: Message) => void
  sendMessage: (input: ComposerInput) => void
  saveDraft: (input: ComposerInput) => void
  /** Queues a reply to the conversation (undo window first); returns its Message-ID, or null */
  sendReply: (thread: Message[], body: string, html?: string) => string | null
  /** Pull a queued reply back before it leaves (toast Undo) */
  unsend: (accountId: string, messageId: string) => void
  /** Turn a failed send back into a draft so it can be edited */
  revertToDraft: (message: Message) => void
  /** Re-queue a failed send */
  retrySend: (message: Message) => void
  /** Outbox recovery: push every errored op again, or drop them and re-fetch from Gmail */
  retryOutbox: () => void
  discardOutbox: () => void
  refreshInbox: () => void

  // ui state
  toggleHideDone: () => void
  setSearchOpen: (open: boolean) => void
  /** Open the composer: blank, editing `draft`, or prefilled */
  openCompose: (draft?: Message | null, prefill?: { to: string } | null) => void
  closeCompose: () => void
  setSignature: (signature: string) => void
  toggleShowWordCount: () => void
  showToast: (text: string, undo?: () => void) => void
  dismissToast: () => void
}

const CLOSED_COMPOSER: ComposerState = { open: false, draftId: null, draft: null, prefill: null }

let toastTimer: number | undefined

export const useAppStore = create<AppState>()((set, get) => ({
  view: { name: 'inbox' },
  prevView: null,
  popover: null,
  activeAccountId: 'all',
  accounts: [],
  connected: false,
  mailVersion: 0,
  contacts: [],
  outbox: [],
  unread: [],
  hideDone: true,
  searchOpen: false,
  composer: CLOSED_COMPOSER,
  signature: '',
  showWordCount: true,
  toast: null,

  init: async () => {
    if (!hasMailApi()) return
    // Subscribe first so a change during the initial load is never missed
    subscribeOnce()
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
        contacts: [],
        outbox: [],
        unread: [],
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
          : s.activeAccountId,
      mailVersion: s.mailVersion + 1
    }))
    await loadShared()
  },

  openGroup: (category) => set({ view: { name: 'group', category }, popover: null }),
  openFolder: (folder) => set({ view: { name: 'folder', folder }, prevView: null, popover: null }),
  openThread: (ref) => {
    set((s) => ({
      view: { name: 'thread', ref },
      prevView: s.view.name === 'thread' || s.view.name === 'settings' ? s.prevView : s.view,
      popover: null
    }))
    get().threadAction(ref, 'markSeen')
  },
  openSettings: () =>
    set((s) => ({
      view: { name: 'settings' },
      prevView: s.view.name === 'thread' || s.view.name === 'settings' ? s.prevView : s.view,
      popover: null
    })),
  back: () =>
    set((s) => {
      if (s.view.name === 'thread' || s.view.name === 'settings') {
        return { view: s.prevView ?? { name: 'inbox' }, prevView: null }
      }
      return { view: { name: 'inbox' }, prevView: null }
    }),
  goInbox: () => set({ view: { name: 'inbox' }, prevView: null, popover: null }),
  setPopover: (popover) => set({ popover }),
  setAccount: (activeAccountId) => {
    set({ activeAccountId, popover: null })
    void loadShared().catch(logFailure('reload'))
  },

  threadAction: (refs, action) => {
    if (!get().connected) return
    const list = Array.isArray(refs) ? refs : [refs]
    if (list.length === 0) return
    window.api.threadAction(list, action).catch(logFailure(`thread ${action}`))
  },
  done: (ref) => {
    const s = get()
    s.threadAction(ref, 'archive')
    s.showToast('Marked done', () => get().threadAction(ref, 'toggleArchive'))
  },
  archiveGroup: (scope, category, includeArchived) => {
    if (!get().connected) return
    void (async () => {
      const refs: ThreadRef[] = []
      let cursor: ThreadCursor | null = null
      do {
        const page = await window.api.listThreads({
          accountId: scope,
          view: { kind: 'inbox', includeArchived, category },
          cursor,
          limit: 200
        })
        refs.push(...page.threads)
        cursor = page.nextCursor
      } while (cursor)
      if (refs.length === 0) return
      await window.api.threadAction(refs, 'archive')
      get().showToast('All done', () => get().threadAction(refs, 'toggleArchive'))
    })().catch(logFailure('archive group'))
  },
  deleteDraft: (draft) => {
    window.api
      .deleteLocalMessage(draft.accountId, draft.messageId)
      .catch(logFailure('delete draft'))
  },
  sendMessage: ({ to, subject, body, html, accountId, draftId }) => {
    const s0 = get()
    const account = s0.accounts.find((a) => a.id === accountId) ?? s0.accounts[0]
    if (!account || !s0.connected) return
    // Sending a draft keeps its threading chain (In-Reply-To/References) and
    // category, exactly as saveDraft preserved them.
    const existing = draftId && s0.composer.draftId === draftId ? s0.composer.draft : null
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
    set({ composer: CLOSED_COMPOSER })
    // Composer sends go out immediately (the reply toast's Undo is the delayed path)
    window.api.queueSend(input, Date.now()).catch(logFailure('send'))
    const first = input.to[0]
    s0.showToast(first ? `Message sent to ${first.name ?? first.address}` : 'Message sent')
  },
  saveDraft: ({ to, subject, body, html, accountId, draftId }) => {
    const s = get()
    const account = s.accounts.find((a) => a.id === accountId) ?? s.accounts[0]
    if (!account || !s.connected) return
    const existing = draftId && s.composer.draftId === draftId ? s.composer.draft : null
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
    set({ composer: CLOSED_COMPOSER })
    window.api.saveDraft(input).catch(logFailure('save draft'))
  },
  sendReply: (thread, body, html) => queueReply(get(), thread, body, html, UNDO_SEND_MS),
  unsend: (accountId, messageId) => {
    window.api.cancelSend(accountId, messageId, false).catch(logFailure('undo send'))
  },
  revertToDraft: (message) => {
    window.api
      .cancelSend(message.accountId, message.messageId, true)
      .catch(logFailure('revert to draft'))
  },
  retrySend: (message) => {
    window.api.retrySend(message.accountId, message.messageId).catch(logFailure('retry send'))
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
  },

  toggleHideDone: () => {
    const hideDone = !get().hideDone
    set({ hideDone })
    persistSetting(SETTING_KEYS.hideDone, String(hideDone))
  },
  setSearchOpen: (searchOpen) => set({ searchOpen, popover: null }),
  openCompose: (draft = null, prefill = null) =>
    set({
      composer: { open: true, draftId: draft?.messageId ?? null, draft, prefill },
      popover: null
    }),
  closeCompose: () => set({ composer: CLOSED_COMPOSER }),
  setSignature: (signature) => {
    set({ signature })
    persistSetting(SETTING_KEYS.signature, signature)
  },
  toggleShowWordCount: () => {
    const showWordCount = !get().showWordCount
    set({ showWordCount })
    persistSetting(SETTING_KEYS.showWordCount, String(showWordCount))
  },
  showToast: (text, undo) => {
    window.clearTimeout(toastTimer)
    const dismiss = get().dismissToast
    set({
      toast: {
        text,
        undo: undo
          ? () => {
              undo()
              dismiss()
            }
          : undefined
      }
    })
    toastTimer = window.setTimeout(dismiss, TOAST_MS)
  },
  dismissToast: () => {
    window.clearTimeout(toastTimer)
    set({ toast: null })
  }
}))

function persistSetting(key: string, value: string): void {
  if (!hasMailApi()) return
  window.api.setSetting(key, value).catch(logFailure('save setting'))
}

/**
 * Build a reply to the latest counterpart in a conversation and queue it to
 * leave after `delayMs` (the undo window). Recipients and body are fixed now
 * and persisted with the message, so nothing that happens in the meantime can
 * change where it goes.
 */
function queueReply(
  s: AppState,
  thread: Message[],
  body: string,
  html: string | undefined,
  delayMs: number
): string | null {
  if (!body.trim() || !s.connected) return null
  const inThread = [...thread].sort((a, b) => a.date.localeCompare(b.date))
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

/** Null when every account is shown; the id otherwise (what main's queries take) */
export function accountScope(activeAccountId: string): string | null {
  return activeAccountId === 'all' ? null : activeAccountId
}

/** Human title for a folder view */
export const FOLDER_TITLES: Record<FolderView, string> = {
  pins: 'Pins',
  drafts: 'Drafts',
  sent: 'Sent',
  trash: 'Trash',
  spam: 'Spam',
  archive: 'Archive'
}
