import { useEffect } from 'react'
import Strip from './components/shell/Strip'
import SearchOverlay from './components/search/SearchOverlay'
import ComposerModal from './components/compose/ComposerModal'
import OutboxBanner from './components/inbox/OutboxBanner'
import Toast from './components/ui/Toast'
import InboxView from './views/InboxView'
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

      // Escape closes only the topmost layer: search > popovers > composer > back
      if (e.key === 'Escape') {
        if (s.searchOpen) {
          e.preventDefault()
          s.setSearchOpen(false)
        } else if (s.popover) {
          e.preventDefault()
          s.setPopover(null)
        } else if (s.composer.open) {
          // ComposerModal's own listener saves-or-closes; this branch only stops
          // the chain so Escape never also navigates the view behind the modal
        } else if (s.view.name === 'thread' || s.view.name === 'settings') {
          e.preventDefault()
          s.back()
        } else if (s.view.name === 'group') {
          e.preventDefault()
          s.goInbox()
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
      if (mod && e.key.toLowerCase() === 'n' && !s.composer.open && s.connected) {
        e.preventDefault()
        s.openCompose()
        return
      }
      if (s.composer.open) return
      if (mod && e.key === ',') {
        e.preventDefault()
        s.openSettings()
        return
      }
      // The header menu's shortcuts: ⇧P pins, ⇧D drafts, ⇧S sent
      if (e.shiftKey && !mod && !e.altKey) {
        const folder = { P: 'pins', D: 'drafts', S: 'sent' }[e.key] as
          'pins' | 'drafts' | 'sent' | undefined
        if (folder) {
          e.preventDefault()
          s.openFolder(folder)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return (): void => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="relative flex h-full flex-col">
      {/* The window has no title bar; this band under the traffic lights drags it */}
      <div className="drag-region h-[30px] shrink-0" />
      <Strip />
      <main className="relative min-h-0 flex-1">
        {view.name === 'inbox' && <InboxView />}
        {view.name === 'group' && <GroupListView key={view.category} category={view.category} />}
        {view.name === 'folder' && <FolderListView key={view.folder} folder={view.folder} />}
        {view.name === 'thread' && (
          <ThreadView key={`${view.ref.accountId}:${view.ref.threadKey}`} threadRef={view.ref} />
        )}
        {view.name === 'settings' && <SettingsView />}
      </main>
      <OutboxBanner />
      <ComposerModal />
      <SearchOverlay />
      <Toast />
    </div>
  )
}
