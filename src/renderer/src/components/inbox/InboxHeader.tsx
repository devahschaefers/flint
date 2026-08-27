import { Check, ChevronDown, PenLine, Search } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

interface InboxHeaderProps {
  title?: string
}

export default function InboxHeader({ title = 'Inbox' }: InboxHeaderProps): React.JSX.Element {
  return (
    <div className="drag-region flex items-start justify-between px-[30px] pt-[40px] pb-2">
      <div className="pl-[50px]">
        <DropdownMenu>
          <DropdownMenuTrigger className="no-drag flex items-center gap-1 outline-none">
            <span className="text-[14px] font-semibold text-text-primary">{title}</span>
            <ChevronDown size={13} className="text-text-secondary" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>Focused List</DropdownMenuItem>
            <DropdownMenuItem>Classic List</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mt-0.5 text-[11px] text-text-secondary">Focused List</div>
      </div>

      <div className="no-drag flex items-center gap-4 text-text-primary">
        <button
          aria-label="Hide done emails"
          className="flex h-[18px] w-[34px] items-center rounded-full bg-elevation-3 px-[2px]"
        >
          <span className="flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white">
            <Check size={9} strokeWidth={3.5} className="text-elevation-0" />
          </span>
        </button>
        <button aria-label="Search" className="transition-colors hover:text-ink">
          <Search size={19} />
        </button>
        <button aria-label="Compose" className="transition-colors hover:text-ink">
          <PenLine size={19} />
        </button>
      </div>
    </div>
  )
}
