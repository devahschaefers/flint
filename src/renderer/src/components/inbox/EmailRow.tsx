import { Check, Pin } from 'lucide-react'
import type { Email } from '../../data/types'
import { shortDate } from '../../lib/dates'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'

interface EmailRowProps {
  email: Email
  onClick?: () => void
}

export default function EmailRow({ email, onClick }: EmailRowProps): React.JSX.Element {
  const toggleDone = useAppStore((s) => s.toggleDone)
  const togglePin = useAppStore((s) => s.togglePin)
  const toggleRead = useAppStore((s) => s.toggleRead)
  const moveTo = useAppStore((s) => s.moveTo)
  const deleteDraft = useAppStore((s) => s.deleteDraft)

  const inTrashOrSpam = email.folder === 'trash' || email.folder === 'spam'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'group flex h-[42px] w-full items-center gap-[10px] rounded-[10px] px-[10px] text-left transition-colors hover:bg-elevation-1',
            email.done && 'opacity-60'
          )}
        >
          <span className="flex w-[26px] shrink-0 items-center justify-center">
            {email.done ? (
              <span
                role="button"
                title="Mark not done"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleDone(email.id)
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full bg-text-muted"
              >
                <Check size={10} strokeWidth={3} className="text-elevation-0" />
              </span>
            ) : (
              <>
                {!email.read && (
                  <span className="h-2 w-2 rounded-full bg-blue-3 group-hover:hidden" />
                )}
                <span
                  role="button"
                  title="Done"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleDone(email.id)
                  }}
                  className="hidden h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-text-muted hover:border-text-secondary group-hover:flex"
                >
                  <Check size={11} className="text-text-muted" />
                </span>
              </>
            )}
          </span>

          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ backgroundColor: email.sender.color }}
          >
            {email.sender.initials}
          </span>

          <span className="w-[230px] shrink-0 truncate text-[13px] font-semibold text-text-primary">
            {email.sender.name}
          </span>

          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="font-semibold text-text-primary">{email.subject}</span>
            <span className="font-normal text-text-secondary">{'  ' + email.preview}</span>
          </span>

          {email.pinned && (
            <Pin size={11} className="shrink-0 text-yellow-3" fill="currentColor" />
          )}

          <span
            className={cn(
              'shrink-0 text-[12px] tabular-nums',
              email.read ? 'text-text-secondary' : 'text-blue-3'
            )}
          >
            {shortDate(email.date)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => toggleDone(email.id)}>
          {email.done ? 'Mark not done' : 'Done'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => togglePin(email.id)}>
          {email.pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleRead(email.id)}>
          Mark as {email.read ? 'unread' : 'read'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {inTrashOrSpam ? (
          <ContextMenuItem onSelect={() => moveTo(email.id, 'inbox')}>Move to Inbox</ContextMenuItem>
        ) : email.folder === 'drafts' ? (
          <ContextMenuItem onSelect={() => deleteDraft(email.id)}>Delete draft</ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onSelect={() => moveTo(email.id, 'trash')}>
              Move to Trash
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => moveTo(email.id, 'spam')}>Move to Spam</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
