import type { InboxGroup } from '../../../../preload/index.d'
import { CATEGORY_LABELS, type Category } from '../../data/types'
import { resolveMailbox } from '../../lib/identity'
import { useAppStore } from '../../store'
import Avatar from '../ui/Avatar'
import RowAction from './RowAction'

interface BundleRowProps {
  group: InboxGroup
  onOpen: () => void
  /** "Mark all done" for every conversation in the group */
  onArchiveAll: () => void
}

const STACK_SHOWN = 3

/** One smart-inbox bundle as a quiet line: who it's from, what's new, an arrow */
export default function BundleRow({
  group,
  onOpen,
  onArchiveAll
}: BundleRowProps): React.JSX.Element {
  const contacts = useAppStore((s) => s.contacts)
  const label = CATEGORY_LABELS[group.category as Category] ?? group.category
  const shown = group.chips.slice(0, STACK_SHOWN)
  const more = group.chips.length - shown.length

  return (
    <div
      role="button"
      onClick={onOpen}
      className="group -mx-3 flex cursor-pointer items-center gap-2.5 rounded-[8px] px-3 py-1.5 text-[13px] text-dim transition-colors hover:bg-row hover:text-body"
    >
      <span className="flex shrink-0">
        {shown.map(({ mailbox }, i) => {
          const identity = resolveMailbox(mailbox, contacts)
          return (
            <Avatar
              key={mailbox.address.toLowerCase()}
              initials={identity.initials}
              color={identity.color}
              size={18}
              title={identity.name}
              className={i > 0 ? '-ml-[5px] ring-[1.5px] ring-bg' : 'ring-[1.5px] ring-bg'}
            />
          )
        })}
        {more > 0 && (
          <Avatar
            initials={`+${more}`}
            color="#3a3a3a"
            size={18}
            className="-ml-[5px] ring-[1.5px] ring-bg"
          />
        )}
      </span>
      <span className="whitespace-nowrap">{label}</span>
      {group.unread > 0 ? (
        <span className="whitespace-nowrap text-accent">{group.unread} new</span>
      ) : (
        <span className="whitespace-nowrap text-meta">{group.count}</span>
      )}
      <span className="flex-1" />
      <span className="hidden text-[12px] text-strong group-hover:inline">
        <RowAction onClick={onArchiveAll}>Mark all done</RowAction>
      </span>
      <span className="text-hint">→</span>
    </div>
  )
}
