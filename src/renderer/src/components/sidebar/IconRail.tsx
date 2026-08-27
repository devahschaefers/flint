import { House, Inbox, Pin, File, Send, Trash2, SquareX, Menu } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'

export type RailItem = 'home' | 'inbox' | 'pins' | 'drafts' | 'sent' | 'trash' | 'spam'

function RailButton({
  label,
  active = false,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={cn(
        'no-drag flex h-[30px] w-[30px] items-center justify-center rounded-lg text-text-bright',
        'transition-colors duration-150 hover:bg-white/10',
        active && 'bg-blue-5 text-white hover:bg-blue-5'
      )}
    >
      {children}
    </button>
  )
}

export default function IconRail(): React.JSX.Element {
  const view = useAppStore((s) => s.view)
  const railItem = useAppStore((s) => s.railItem)
  const setRailItem = useAppStore((s) => s.setRailItem)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const openSettings = useAppStore((s) => s.openSettings)

  const isActive = (item: RailItem): boolean => {
    if (railItem !== item) return false
    if (view.name === 'inbox' || view.name === 'group') return item === 'home' || item === 'inbox'
    if (view.name === 'folder') return view.folder === item
    return false
  }

  const iconProps = { size: 19, strokeWidth: 1.8 }
  return (
    <nav className="drag-region flex h-full w-[72px] shrink-0 flex-col items-center pt-[37px] pb-5">
      <RailButton label="Home Screen" active={isActive('home')} onClick={() => setRailItem('home')}>
        <House {...iconProps} />
      </RailButton>

      <div className="mt-5 flex flex-col items-center gap-0.5">
        <RailButton label="Inbox" active={isActive('inbox')} onClick={() => setRailItem('inbox')}>
          <Inbox {...iconProps} />
        </RailButton>
      </div>

      <div className="mt-5 flex flex-col items-center gap-0.5">
        <RailButton label="Pins" active={isActive('pins')} onClick={() => setRailItem('pins')}>
          <Pin {...iconProps} />
        </RailButton>
        <RailButton label="Drafts" active={isActive('drafts')} onClick={() => setRailItem('drafts')}>
          <File {...iconProps} />
        </RailButton>
        <RailButton label="Sent" active={isActive('sent')} onClick={() => setRailItem('sent')}>
          <Send {...iconProps} />
        </RailButton>
        <RailButton label="Trash" active={isActive('trash')} onClick={() => setRailItem('trash')}>
          <Trash2 {...iconProps} />
        </RailButton>
        <RailButton label="Spam" active={isActive('spam')} onClick={() => setRailItem('spam')}>
          <SquareX {...iconProps} />
        </RailButton>
        <RailButton label="Open Sidebar" onClick={() => setSidebarOpen(true)}>
          <Menu {...iconProps} />
        </RailButton>
      </div>

      <div className="mt-auto flex flex-col items-center gap-3">
        <button
          aria-label="Settings"
          onClick={openSettings}
          className={cn(
            'no-drag flex h-[30px] w-[30px] items-center justify-center rounded-full bg-green-3/80 text-[11px] font-semibold text-white',
            view.name === 'settings' && 'ring-2 ring-blue-4'
          )}
        >
          DS
        </button>
      </div>
    </nav>
  )
}
