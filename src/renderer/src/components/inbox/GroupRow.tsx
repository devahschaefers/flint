import { Bell, CalendarDays, Check, ChevronRight, Users, type LucideIcon } from 'lucide-react'
import type { InboxGroup } from '../../../../preload/index.d'
import { CATEGORY_LABELS, type Category } from '../../data/types'
import { resolveMailbox } from '../../lib/identity'
import { cn } from '../../lib/utils'

interface GroupRowProps {
  group: InboxGroup
  onOpen: () => void
  /** "Mark all done" for every conversation in the group */
  onArchiveAll: () => void
}

const CATEGORY_STYLES: Record<Category, { chip: string; icon: string; Icon: LucideIcon }> = {
  notifications: { chip: 'bg-green-3/15', icon: 'text-green-3', Icon: Bell },
  people: { chip: 'bg-blue-3/15', icon: 'text-blue-3', Icon: Users },
  invites: { chip: 'bg-purple-3/15', icon: 'text-purple-3', Icon: CalendarDays }
}

/** One smart-inbox group: category, conversation count, and who they're with (from main) */
export default function GroupRow({
  group,
  onOpen,
  onArchiveAll
}: GroupRowProps): React.JSX.Element {
  const contacts = useAppStoreContacts()
  const category = (group.category in CATEGORY_STYLES ? group.category : 'people') as Category
  const { chip, icon, Icon } = CATEGORY_STYLES[category]

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
            onArchiveAll()
          }}
          className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-text-muted text-text-muted opacity-0 transition-colors hover:border-green-3 hover:bg-green-3 hover:text-white group-hover:opacity-100"
        >
          <Check size={11} />
        </span>
        {group.unread > 0 && <span className="h-2 w-2 rounded-full bg-blue-3" />}
        <span
          className={cn('flex h-[26px] w-[26px] items-center justify-center rounded-full', chip)}
        >
          <Icon size={14} strokeWidth={2} className={icon} />
        </span>
      </span>

      <span className="flex w-[265px] shrink-0 items-baseline">
        <span className="text-[13px] font-semibold text-text-primary">
          {CATEGORY_LABELS[category]}
        </span>
        <span className="ml-1.5 text-[13px] text-text-secondary">{group.count}</span>
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-[18px] overflow-hidden">
        {group.chips.map(({ mailbox, count, unread }) => {
          const identity = resolveMailbox(mailbox, contacts)
          return (
            <span
              key={mailbox.address.toLowerCase()}
              className="flex shrink-0 items-center gap-1.5"
            >
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

import { useAppStore } from '../../store'
function useAppStoreContacts(): ReturnType<typeof useAppStore.getState>['contacts'] {
  return useAppStore((s) => s.contacts)
}
