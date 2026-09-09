import { Check, Pin } from 'lucide-react'
import type { WireThread } from '../../../../preload/index.d'
import { shortDate } from '../../lib/dates'
import { resolveMailbox, resolveNames } from '../../lib/identity'
import { normalizeSubject } from '../../lib/threads'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import SendStatus from './SendStatus'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'

interface ThreadRowProps {
  thread: WireThread
  onClick?: () => void
  /** Text to show in place of the preview (search results show the matched snippet) */
  preview?: string
}

/** One conversation in a list. Everything shown was computed in SQL by main. */
export default function ThreadRow({ thread, onClick, preview }: ThreadRowProps): React.JSX.Element {
  const contacts = useAppStore((s) => s.contacts)
  const threadAction = useAppStore((s) => s.threadAction)
  const ref = { accountId: thread.accountId, threadKey: thread.threadKey }

  // Avatar identity is always address-keyed: the counterpart, or (pure sent
  // thread) the first recipient, or worst case our own identity.
  const avatarMailbox = thread.counterpart ?? thread.latest.to[0] ?? thread.latest.from
  const identity = resolveMailbox(avatarMailbox, contacts)
  const name = thread.counterpart
    ? identity.name
    : thread.latest.to.length > 0
      ? `To ${resolveNames(thread.latest.to, contacts)}`
      : 'To (no recipient)'

  const date = new Date(thread.latestDateMs).toISOString()
  const unread = thread.unread > 0
  const { folders } = thread
  // "Done" = fully archived: nothing left in the inbox, something in archive
  const archived = folders.inbox === 0 && folders.archive > 0
  const inTrashOrSpam = folders.trash > 0 || folders.spam > 0
  // Moves only touch non-sent/non-draft messages — hide the items that would do nothing
  const movable = thread.count > folders.sent + folders.drafts

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
              unread && <span className="h-2 w-2 rounded-full bg-blue-3" />
            ) : archived ? (
              <span
                role="button"
                title="Move to Inbox"
                onClick={(e) => {
                  e.stopPropagation()
                  threadAction(ref, 'toggleArchive')
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full bg-text-muted text-elevation-0 transition-colors hover:bg-blue-4 hover:text-white"
              >
                <Check size={10} strokeWidth={3} />
              </span>
            ) : (
              <>
                {unread && <span className="h-2 w-2 rounded-full bg-blue-3 group-hover:hidden" />}
                <span
                  role="button"
                  title="Done"
                  onClick={(e) => {
                    e.stopPropagation()
                    threadAction(ref, 'toggleArchive')
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
            {thread.count > 1 && (
              <span className="font-normal text-[12px] text-text-secondary"> {thread.count}</span>
            )}
          </span>

          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="font-semibold text-text-primary">
              {normalizeSubject(thread.subject) || '(no subject)'}
            </span>
            {thread.latest.folder === 'drafts' && (
              <span className="font-normal text-red-3">{'  Draft'}</span>
            )}
            <SendStatus
              state={thread.latest.state}
              sendError={thread.latest.sendError}
              className="ml-2 align-middle"
            />
            <span className="font-normal text-text-secondary">
              {'  ' + (preview ?? thread.latest.snippet).slice(0, 140)}
            </span>
          </span>

          {thread.flagged && (
            <Pin size={11} className="shrink-0 text-yellow-3" fill="currentColor" />
          )}

          <span
            className={cn(
              'shrink-0 text-[12px] tabular-nums',
              unread ? 'text-blue-3' : 'text-text-secondary'
            )}
          >
            {shortDate(date)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!inTrashOrSpam && (
          <ContextMenuItem onSelect={() => threadAction(ref, 'toggleArchive')}>
            {archived ? 'Move to Inbox' : 'Done'}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => threadAction(ref, 'toggleFlagged')}>
          {thread.flagged ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => threadAction(ref, 'toggleSeen')}>
          Mark as {unread ? 'read' : 'unread'}
        </ContextMenuItem>
        {(inTrashOrSpam || movable) && <ContextMenuSeparator />}
        {inTrashOrSpam ? (
          <ContextMenuItem onSelect={() => threadAction(ref, 'inbox')}>
            Move to Inbox
          </ContextMenuItem>
        ) : movable ? (
          <>
            <ContextMenuItem onSelect={() => threadAction(ref, 'trash')}>
              Move to Trash
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => threadAction(ref, 'spam')}>
              Move to Spam
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
