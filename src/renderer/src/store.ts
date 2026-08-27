import { create } from 'zustand'
import type { Category, Email } from './data/types'
import { emails as mockEmails } from './data/mock'
import type { RailItem } from './components/sidebar/IconRail'

export type View = { name: 'inbox' } | { name: 'group'; category: Category }

interface AppState {
  view: View
  railItem: RailItem
  sidebarOpen: boolean
  selectedEmailId: string | null
  emails: Email[]

  openGroup: (category: Category) => void
  backToInbox: () => void
  setRailItem: (item: RailItem) => void
  setSidebarOpen: (open: boolean) => void
  selectEmail: (id: string | null) => void
}

export const useAppStore = create<AppState>()((set) => ({
  view: { name: 'inbox' },
  railItem: 'inbox',
  sidebarOpen: false,
  selectedEmailId: null,
  emails: mockEmails,

  openGroup: (category) => set({ view: { name: 'group', category }, selectedEmailId: null }),
  backToInbox: () => set({ view: { name: 'inbox' }, selectedEmailId: null }),
  setRailItem: (railItem) => set({ railItem, view: { name: 'inbox' } }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  selectEmail: (selectedEmailId) => set({ selectedEmailId })
}))
