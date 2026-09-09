import { useEffect } from 'react'
import IconRail from './components/sidebar/IconRail'
import SidebarPanel from './components/sidebar/SidebarPanel'
import SearchOverlay from './components/search/SearchOverlay'
import ComposerModal from './components/compose/ComposerModal'
import OutboxBanner from './components/inbox/OutboxBanner'
import SmartInboxView from './views/SmartInboxView'
import GroupListView from './views/GroupListView'
import FolderListView from './views/FolderListView'
import ThreadView from './views/ThreadView'
import SettingsView from './views/SettingsView'
import { useAppStore } from './store'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
}

export default function App(): React.JSX.Element {
  const view = useAppStore((s) => s.view)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const s = useAppStore.getState()
      const mod = e.metaKey || e.ctrlKey

      // Escape closes only the topmost layer: search > composer > sidebar > back
      if (e.key === 'Escape') {
        if (s.searchOpen) {
          e.preventDefault()
          s.setSearchOpen(false)
        } else if (s.composer.open) {
          // ComposerModal's own listener saves-or-closes; this branch only stops
          // the chain so Escape never also navigates the view behind the modal
        } else if (s.sidebarOpen) {
          e.preventDefault()
          s.setSidebarOpen(false)
        } else if (s.view.name === 'thread' || s.view.name === 'settings') {
          e.preventDefault()
          s.back()
        }
        return
      }

      if (isEditableTarget(e.target)) return

      if ((mod && e.key.toLowerCase() === 'k') || (!mod && e.key === '/')) {
        e.preventDefault()
        s.setSearchOpen(true)
        return
      }
      // Inert while a compose window is open — re-opening would wipe unsaved edits
      if (mod && e.key.toLowerCase() === 'n' && !s.composer.open) {
        e.preventDefault()
        s.openCompose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return (): void => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex h-full">
      <div className="shrink-0 bg-[#17181b]">
        <IconRail />
      </div>
      <main className="relative flex-1 overflow-hidden">
        {view.name === 'inbox' && <SmartInboxView />}
        {view.name === 'group' && <GroupListView category={view.category} />}
        {view.name === 'folder' && <FolderListView folder={view.folder} />}
        {view.name === 'thread' && (
          <ThreadView key={`${view.ref.accountId}:${view.ref.threadKey}`} threadRef={view.ref} />
        )}
        {view.name === 'settings' && <SettingsView />}
        <OutboxBanner />
      </main>
      <SidebarPanel />
      <SearchOverlay />
      <ComposerModal />
    </div>
  )
}
