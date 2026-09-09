import type { Contact, Message } from '../../data/types'
import { shortDate } from '../../lib/dates'
import { resolveMailbox, resolveNames } from '../../lib/identity'
import Avatar from '../ui/Avatar'
import RowAction from './RowAction'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../ui/context-menu'

interface DraftRowProps {
  draft: Message
  contacts: Contact[]
  onOpen: () => void
  onDelete: () => void
}

/** Drafts are individual messages, not conversations — one line each */
export default function DraftRow({
  draft,
  contacts,
  onOpen,
  onDelete
}: DraftRowProps): React.JSX.Element {
  const recipient = draft.to[0]
  const resolved = recipient ? resolveMailbox(recipient, contacts) : null
  const name = draft.to.length > 0 ? resolveNames(draft.to, contacts) : '(no recipient)'
  const subject = draft.subject && draft.subject !== '(no subject)' ? draft.subject : 'Untitled'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          onClick={onOpen}
          className="group -mx-3 flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-[10px] transition-colors hover:bg-row"
        >
          <Avatar initials={resolved?.initials ?? '?'} color={resolved?.color ?? '#3a3a3a'} />
          <span className="flex min-w-0 flex-1 items-center gap-[9px]">
            <span className="flex min-w-0 flex-1 items-baseline gap-[9px] overflow-hidden">
              <span className="shrink-0 whitespace-nowrap text-[13.5px] text-dim">{name}</span>
              <span className="min-w-0 truncate text-[13.5px] text-quiet">{subject}</span>
            </span>
            <span className="hidden shrink-0 items-center gap-0.5 text-[12.5px] text-strong group-hover:flex">
              <RowAction onClick={onDelete}>Delete</RowAction>
              <RowAction accent onClick={onOpen}>
                Open
              </RowAction>
            </span>
            <span className="shrink-0 whitespace-nowrap text-[12px] text-meta group-hover:hidden">
              {shortDate(draft.date)}
            </span>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>Edit draft</ContextMenuItem>
        <ContextMenuItem onSelect={onDelete}>Delete draft</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
