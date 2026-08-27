import { House, Inbox, Pin, File, Send, Trash2, SquareX, Menu, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'

export type RailItem =
  | 'home'
  | 'inbox'
  | 'calendar'
  | 'pins'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'spam'

interface IconRailProps {
  active: RailItem
  onSelect: (item: RailItem) => void
  onOpenSidebar: () => void
}

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

function CalendarIcon(): React.JSX.Element {
  const day = new Date().getDate()
  return (
    <span className="relative flex h-[19px] w-[19px] items-end justify-center rounded-[4px] border-[1.5px] border-current">
      <span className="absolute -top-[3.5px] left-[3px] h-[3px] w-[1.5px] rounded-full bg-current" />
      <span className="absolute -top-[3.5px] right-[3px] h-[3px] w-[1.5px] rounded-full bg-current" />
      <span className="pb-px text-[9px] font-semibold leading-none">{day}</span>
    </span>
  )
}

export default function IconRail({
  active,
  onSelect,
  onOpenSidebar
}: IconRailProps): React.JSX.Element {
  const iconProps = { size: 19, strokeWidth: 1.8 }
  return (
    <nav className="drag-region flex h-full w-[72px] shrink-0 flex-col items-center pt-[37px] pb-5">
      <RailButton label="Home Screen" active={active === 'home'} onClick={() => onSelect('home')}>
        <House {...iconProps} />
      </RailButton>

      <div className="mt-5 flex flex-col items-center gap-0.5">
        <RailButton label="Inbox" active={active === 'inbox'} onClick={() => onSelect('inbox')}>
          <Inbox {...iconProps} />
        </RailButton>
        <RailButton
          label="Calendar"
          active={active === 'calendar'}
          onClick={() => onSelect('calendar')}
        >
          <CalendarIcon />
        </RailButton>
      </div>

      <div className="mt-5 flex flex-col items-center gap-0.5">
        <RailButton label="Pins" active={active === 'pins'} onClick={() => onSelect('pins')}>
          <Pin {...iconProps} />
        </RailButton>
        <RailButton label="Drafts" active={active === 'drafts'} onClick={() => onSelect('drafts')}>
          <File {...iconProps} />
        </RailButton>
        <RailButton label="Sent" active={active === 'sent'} onClick={() => onSelect('sent')}>
          <Send {...iconProps} />
        </RailButton>
        <RailButton label="Trash" active={active === 'trash'} onClick={() => onSelect('trash')}>
          <Trash2 {...iconProps} />
        </RailButton>
        <RailButton label="Spam" active={active === 'spam'} onClick={() => onSelect('spam')}>
          <SquareX {...iconProps} />
        </RailButton>
        <RailButton label="Open Sidebar" onClick={onOpenSidebar}>
          <Menu {...iconProps} />
        </RailButton>
      </div>

      <div className="mt-auto flex flex-col items-center gap-3">
        <button
          aria-label="AI Agents"
          className="no-drag flex h-[30px] w-12 items-center justify-center rounded-lg text-text-bright transition-colors duration-150 hover:bg-white/10"
        >
          <Sparkles size={18} strokeWidth={1.8} />
        </button>
        <button
          aria-label="Settings"
          className="no-drag flex h-[30px] w-[30px] items-center justify-center rounded-full bg-green-3/80 text-[11px] font-semibold text-white"
        >
          DS
        </button>
      </div>
    </nav>
  )
}
