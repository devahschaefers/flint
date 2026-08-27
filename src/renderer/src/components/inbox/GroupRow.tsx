import { Bell, CalendarDays, Check, ChevronRight, Users, type LucideIcon } from 'lucide-react'
import { CATEGORY_LABELS, type Category, type Email, type Sender } from '../../data/types'
import { cn } from '../../lib/utils'

interface GroupRowProps {
  category: Category
  emails: Email[]
  onOpen: () => void
  focused?: boolean
}

const CATEGORY_STYLES: Record<Category, { chip: string; icon: string; Icon: LucideIcon }> = {
  notifications: { chip: 'bg-green-3/15', icon: 'text-green-3', Icon: Bell },
  people: { chip: 'bg-blue-3/15', icon: 'text-blue-3', Icon: Users },
  invites: { chip: 'bg-purple-3/15', icon: 'text-purple-3', Icon: CalendarDays }
}

interface Chip {
  sender: Sender
  count: number
  unread: boolean
}

/** Dedupe by sender name keeping the newest email's sender (input is newest-first). */
function senderChips(emails: Email[]): Chip[] {
  const byName = new Map<string, Chip>()
  for (const email of emails) {
    const chip = byName.get(email.sender.name)
    if (chip) {
      chip.count += 1
      chip.unread = chip.unread || !email.read
    } else {
      byName.set(email.sender.name, { sender: email.sender, count: 1, unread: !email.read })
    }
  }
  return [...byName.values()].slice(0, 6)
}

export default function GroupRow({
  category,
  emails,
  onOpen,
  focused = false
}: GroupRowProps): React.JSX.Element {
  const { chip, icon, Icon } = CATEGORY_STYLES[category]
  const hasUnread = emails.some((e) => !e.read)
  const chips = senderChips(emails)

  return (
    <button
      onClick={onOpen}
      className={cn(
        'group relative flex h-[41px] w-full items-center rounded-[15px] border border-transparent',
        'pl-[90px] pr-[30px] text-left transition-colors',
        focused ? 'bg-blue-0' : 'hover:bg-elevation-1'
      )}
    >
      <span className="absolute left-[10px] flex items-center gap-[7px]">
        <span
          className={cn(
            'flex items-center justify-center rounded-full',
            focused
              ? 'h-[22px] w-[22px] bg-white/10'
              : 'h-[18px] w-[18px] border-[1.5px] border-text-muted'
          )}
        >
          <Check
            size={focused ? 13 : 11}
            className={cn(
              focused
                ? 'text-[#5d9df8]'
                : 'opacity-0 text-text-muted group-hover:opacity-100'
            )}
          />
        </span>
        {hasUnread && (
          <span className={cn('h-2 w-2 rounded-full', focused ? 'bg-[#5d9df8]' : 'bg-blue-3')} />
        )}
        <span className={cn('flex h-[26px] w-[26px] items-center justify-center rounded-full', chip)}>
          <Icon size={14} strokeWidth={2} className={icon} />
        </span>
      </span>

      <span className="flex w-[265px] shrink-0 items-baseline">
        <span className="text-[13px] font-semibold text-text-primary">
          {CATEGORY_LABELS[category]}
        </span>
        <span className="ml-1.5 text-[13px] text-text-secondary">{emails.length}</span>
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-[18px] overflow-hidden">
        {chips.map(({ sender, count, unread }) => (
          <span key={sender.name} className="flex shrink-0 items-center gap-1.5">
            {unread && <span className="h-[6px] w-[6px] rounded-full bg-blue-3" />}
            <span
              className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-white ring-1 ring-elevation-1"
              style={{ backgroundColor: sender.color }}
            >
              {sender.initials}
            </span>
            <span className="whitespace-nowrap text-[13px] text-text-primary">
              {sender.name}
              {count > 1 && <span className="text-xs text-text-secondary"> {count}</span>}
            </span>
          </span>
        ))}
      </span>

      <ChevronRight size={15} className="absolute right-[12px] text-text-secondary" />
    </button>
  )
}
