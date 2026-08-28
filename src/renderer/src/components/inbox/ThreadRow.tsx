import { Check, Pin } from 'lucide-react'
import type { Message } from '../../data/types'
import { shortDate } from '../../lib/dates'
import { resolveMailbox, resolveNames } from '../../lib/identity'
import type { Thread } from '../../lib/threads'
import { cn } from '../../lib/utils'
import { isOwnAddress, useAppStore } from '../../store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'

interface ThreadRowProps {
  thread: Thread
  onClick?: () => void
}

/** Newest message from the other side; undefined when every message is ours */
function latestCounterpart(thread: Thread): Message | undefined {
  return [...thread.messages].reverse().find((m) => !isOwnAddress(m.from.address))
}

export default function ThreadRow({ thread, onClick }: ThreadRowProps): React.JSX.Element {
  const contacts = useAppStore((s) => s.contacts)
  const toggleArchiveThread = useAppStore((s) => s.toggleArchiveThread)
  const toggleFlagged = useAppStore((s) => s.toggleFlagged)
  const toggleSeen = useAppStore((s) => s.toggleSeen)
  const moveThread = useAppStore((s) => s.moveThread)

  const counterpart = latestCounterpart(thread)
  // Avatar identity is always address-keyed: the counterpart, or (pure sent
  // thread) the first recipient, or worst case our own identity.
  const avatarMailbox = counterpart?.from ?? thread.latest.to[0] ?? thread.latest.from
  const identity = resolveMailbox(avatarMailbox, contacts)
  const name = counterpart
    ? identity.name
    : `To ${resolveNames(thread.latest.to, contacts) || identity.name}`

  const preview = (thread.latest.body[0] ?? '').slice(0, 140)
  // "Done" = fully archived: nothing left in the inbox, something in archive
  const archived =
    !thread.messages.some((m) => m.folder === 'inbox') &&
    thread.messages.some((m) => m.folder === 'archive')
  const inTrashOrSpam = thread.messages.some((m) => m.folder === 'trash' || m.folder === 'spam')
  // moveThread only touches non-sent/non-draft messages — hide the items it can't act on
  const movable = thread.messages.some((m) => m.folder !== 'sent' && m.folder !== 'drafts')

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'group flex h-[42px] w-full items-center gap-[10px] rounded-[10px] px-[10px] text-left transition-colors hover:bg-elevation-1',
            archived && 'opacity-60'
          )}
        >
          <span className="flex w-[26px] shrink-0 items-center justify-center">
            {inTrashOrSpam ? (
              // Done is a no-op here — restore goes through "Move to Inbox"
              thread.unread && <span className="h-2 w-2 rounded-full bg-blue-3" />
            ) : archived ? (
              <span
                role="button"
                title="Move to Inbox"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleArchiveThread(thread.id)
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full bg-text-muted text-elevation-0 transition-colors hover:bg-blue-4 hover:text-white"
              >
                <Check size={10} strokeWidth={3} />
              </span>
            ) : (
              <>
                {thread.unread && (
                  <span className="h-2 w-2 rounded-full bg-blue-3 group-hover:hidden" />
                )}
                <span
                  role="button"
                  title="Done"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleArchiveThread(thread.id)
                  }}
                  className="hidden h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-text-muted text-text-muted transition-colors hover:border-green-3 hover:bg-green-3 hover:text-white group-hover:flex"
                >
                  <Check size={11} />
                </span>
              </>
            )}
          </span>

          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ backgroundColor: identity.color }}
          >
            {identity.initials}
          </span>

          <span className="w-[230px] shrink-0 truncate text-[13px] font-semibold text-text-primary">
            {name}
            {thread.messages.length > 1 && (
              <span className="font-normal text-[12px] text-text-secondary">
                {' '}
                {thread.messages.length}
              </span>
            )}
          </span>

          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="font-semibold text-text-primary">{thread.subject}</span>
            {thread.latest.folder === 'drafts' && (
              <span className="font-normal text-red-3">{'  Draft'}</span>
            )}
            <span className="font-normal text-text-secondary">{'  ' + preview}</span>
          </span>

          {thread.flagged && (
            <Pin size={11} className="shrink-0 text-yellow-3" fill="currentColor" />
          )}

          <span
            className={cn(
              'shrink-0 text-[12px] tabular-nums',
              thread.unread ? 'text-blue-3' : 'text-text-secondary'
            )}
          >
            {shortDate(thread.latest.date)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!inTrashOrSpam && (
          <ContextMenuItem onSelect={() => toggleArchiveThread(thread.id)}>
            {archived ? 'Move to Inbox' : 'Done'}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => toggleFlagged(thread.id)}>
          {thread.flagged ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => toggleSeen(thread.id)}>
          Mark as {thread.unread ? 'read' : 'unread'}
        </ContextMenuItem>
        {(inTrashOrSpam || movable) && <ContextMenuSeparator />}
        {inTrashOrSpam ? (
          <ContextMenuItem onSelect={() => moveThread(thread.id, 'inbox')}>
            Move to Inbox
          </ContextMenuItem>
        ) : movable ? (
          <>
            <ContextMenuItem onSelect={() => moveThread(thread.id, 'trash')}>
              Move to Trash
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => moveThread(thread.id, 'spam')}>
              Move to Spam
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
