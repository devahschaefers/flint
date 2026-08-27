import { create } from 'zustand'
import type { Category, Email } from './data/types'
import { emails as mockEmails } from './data/mock'
import type { RailItem } from './components/sidebar/IconRail'

/** Folder-style lists reachable from the rail/sidebar (pins is a flag, not a folder) */
export type FolderView = 'pins' | 'drafts' | 'sent' | 'trash' | 'spam'

export type View =
  | { name: 'inbox' }
  | { name: 'group'; category: Category }
  | { name: 'folder'; folder: FolderView }
  | { name: 'email'; emailId: string }

interface AppState {
  view: View
  /** List view to return to when closing an open email */
  prevView: View | null
  railItem: RailItem
  sidebarOpen: boolean
  /** 'all' or an account id — filters every list */
  activeAccountId: string
  emails: Email[]

  openGroup: (category: Category) => void
  openFolder: (folder: FolderView) => void
  openEmail: (emailId: string) => void
  back: () => void
  goInbox: () => void
  setRailItem: (item: RailItem) => void
  setSidebarOpen: (open: boolean) => void
  setAccount: (accountId: string) => void
}

export const useAppStore = create<AppState>()((set) => ({
  view: { name: 'inbox' },
  prevView: null,
  railItem: 'inbox',
  sidebarOpen: false,
  activeAccountId: 'all',
  emails: mockEmails,

  openGroup: (category) => set({ view: { name: 'group', category } }),
  openFolder: (folder) => set({ view: { name: 'folder', folder } }),
  openEmail: (emailId) =>
    set((s) => ({
      view: { name: 'email', emailId },
      prevView: s.view.name === 'email' ? s.prevView : s.view,
      emails: s.emails.map((e) => (e.id === emailId && !e.read ? { ...e, read: true } : e))
    })),
  back: () =>
    set((s) => {
      if (s.view.name === 'email') {
        return { view: s.prevView ?? { name: 'inbox' }, prevView: null }
      }
      return { view: { name: 'inbox' }, prevView: null }
    }),
  goInbox: () => set({ view: { name: 'inbox' }, prevView: null, railItem: 'inbox' }),
  setRailItem: (item) =>
    set(() => {
      // Calendar is intentionally inert for now; home shows the smart inbox
      if (item === 'calendar') return {}
      const base = { railItem: item, prevView: null }
      if (item === 'home' || item === 'inbox') return { ...base, view: { name: 'inbox' } as View }
      return { ...base, view: { name: 'folder', folder: item } as View }
    }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setAccount: (activeAccountId) => set({ activeAccountId })
}))

/** Emails visible under the current account filter */
export function filterByAccount(emails: Email[], activeAccountId: string): Email[] {
  if (activeAccountId === 'all') return emails
  return emails.filter((e) => e.accountId === activeAccountId)
}
