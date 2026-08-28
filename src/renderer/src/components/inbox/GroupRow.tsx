import { Bell, CalendarDays, Check, ChevronRight, Users, type LucideIcon } from 'lucide-react'
import { CATEGORY_LABELS, type Category, type Mailbox } from '../../data/types'
import { resolveMailbox } from '../../lib/identity'
import type { Thread } from '../../lib/threads'
import { cn } from '../../lib/utils'
import { isOwnAddress, useAppStore } from '../../store'

interface GroupRowProps {
  category: Category
  threads: Thread[]
  onOpen: () => void
}

const CATEGORY_STYLES: Record<Category, { chip: string; icon: string; Icon: LucideIcon }> = {
  notifications: { chip: 'bg-green-3/15', icon: 'text-green-3', Icon: Bell },
  people: { chip: 'bg-blue-3/15', icon: 'text-blue-3', Icon: Users },
  invites: { chip: 'bg-purple-3/15', icon: 'text-purple-3', Icon: CalendarDays }
}

interface Chip {
  mailbox: Mailbox
  /** Threads this identity spans */
  count: number
  unread: boolean
}

/**
 * One chip per counterpart identity across threads, deduped by address
 * (newest first — input threads are already newest-first). A pure-sent thread
 * falls back to its first recipient.
 */
function counterpartChips(threads: Thread[]): Chip[] {
  const byAddress = new Map<string, Chip>()
  for (const thread of threads) {
    const counterpart = [...thread.messages].reverse().find((m) => !isOwnAddress(m.from.address))
    const mailbox = counterpart?.from ?? thread.latest.to[0]
    if (!mailbox) continue
    const key = mailbox.address.toLowerCase()
    const chip = byAddress.get(key)
    if (chip) {
      chip.count += 1
      chip.unread = chip.unread || thread.unread
    } else {
      byAddress.set(key, { mailbox, count: 1, unread: thread.unread })
    }
  }
  return [...byAddress.values()].slice(0, 6)
}

export default function GroupRow({ category, threads, onOpen }: GroupRowProps): React.JSX.Element {
  const contacts = useAppStore((s) => s.contacts)
  const archiveThreads = useAppStore((s) => s.archiveThreads)
  const { chip, icon, Icon } = CATEGORY_STYLES[category]
  const hasUnread = threads.some((t) => t.unread)
  const chips = counterpartChips(threads)

  return (
    <button
      onClick={onOpen}
      className={cn(
        'group relative flex h-[41px] w-full items-center rounded-[15px] border border-transparent',
        'pl-[90px] pr-[30px] text-left transition-colors hover:bg-elevation-1'
      )}
    >
      <span className="absolute left-[10px] flex items-center gap-[7px]">
        <span
          role="button"
          title="Mark all done"
          onClick={(e) => {
            e.stopPropagation()
            archiveThreads(threads.map((thread) => thread.id))
          }}
          className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-text-muted text-text-muted opacity-0 transition-colors hover:border-green-3 hover:bg-green-3 hover:text-white group-hover:opacity-100"
        >
          <Check size={11} />
        </span>
        {hasUnread && <span className="h-2 w-2 rounded-full bg-blue-3" />}
        <span className={cn('flex h-[26px] w-[26px] items-center justify-center rounded-full', chip)}>
          <Icon size={14} strokeWidth={2} className={icon} />
        </span>
      </span>

      <span className="flex w-[265px] shrink-0 items-baseline">
        <span className="text-[13px] font-semibold text-text-primary">
          {CATEGORY_LABELS[category]}
        </span>
        <span className="ml-1.5 text-[13px] text-text-secondary">{threads.length}</span>
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-[18px] overflow-hidden">
        {chips.map(({ mailbox, count, unread }) => {
          const identity = resolveMailbox(mailbox, contacts)
          return (
            <span key={mailbox.address.toLowerCase()} className="flex shrink-0 items-center gap-1.5">
              {unread && <span className="h-[6px] w-[6px] rounded-full bg-blue-3" />}
              <span
                className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-white ring-1 ring-elevation-1"
                style={{ backgroundColor: identity.color }}
              >
                {identity.initials}
              </span>
              <span className="whitespace-nowrap text-[13px] text-text-primary">
                {identity.name}
                {count > 1 && <span className="text-xs text-text-secondary"> {count}</span>}
              </span>
            </span>
          )
        })}
      </span>

      <ChevronRight size={15} className="absolute right-[12px] text-text-secondary" />
    </button>
  )
}
