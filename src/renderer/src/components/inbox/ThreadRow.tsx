import type { WireThread } from '../../../../preload/index.d'
import { shortDate } from '../../lib/dates'
import { resolveMailbox, resolveNames } from '../../lib/identity'
import { normalizeSubject } from '../../lib/threads'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import Avatar from '../ui/Avatar'
import RowAction from './RowAction'
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
  onOpen: () => void
}

/**
 * One conversation: avatar, sender, subject, date. Hovering swaps the date for
 * the row's verbs (Done · Pin · Open); right-click has the rest. Everything
 * shown was computed in SQL by main.
 */
export default function ThreadRow({ thread, onOpen }: ThreadRowProps): React.JSX.Element {
  const contacts = useAppStore((s) => s.contacts)
  const threadAction = useAppStore((s) => s.threadAction)
  const done = useAppStore((s) => s.done)
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
  const subject = normalizeSubject(thread.subject) || '(no subject)'

  const primary = inTrashOrSpam
    ? { label: 'Restore', run: () => threadAction(ref, 'inbox') }
    : archived
      ? { label: 'To inbox', run: () => threadAction(ref, 'toggleArchive') }
      : folders.inbox > 0
        ? { label: 'Done', run: () => done(ref) }
        : null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          onClick={onOpen}
          className={cn(
            'group -mx-3 flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-[10px] transition-colors hover:bg-row',
            archived && 'opacity-45'
          )}
        >
          <Avatar initials={identity.initials} color={identity.color} />
          <span className="flex min-w-0 flex-1 items-center gap-[9px]">
            <span className="flex min-w-0 flex-1 items-baseline gap-[9px] overflow-hidden">
              <span
                className={cn(
                  'shrink-0 whitespace-nowrap text-[13.5px]',
                  unread ? 'font-semibold text-ink' : 'text-dim'
                )}
              >
                {name}
                {thread.count > 1 && (
                  <span className="ml-1.5 text-[12px] font-normal text-meta">{thread.count}</span>
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 truncate text-[13.5px]',
                  unread ? 'text-strong' : 'text-quiet'
                )}
              >
                {subject}
              </span>
              {thread.latest.folder === 'drafts' && (
                <span className="shrink-0 text-[11px] text-warn">Draft</span>
              )}
              <SendStatus state={thread.latest.state} sendError={thread.latest.sendError} />
            </span>

            <span className="hidden shrink-0 items-center gap-0.5 text-[12.5px] text-strong group-hover:flex">
              {primary && <RowAction onClick={primary.run}>{primary.label}</RowAction>}
              <RowAction onClick={() => threadAction(ref, 'toggleFlagged')}>
                {thread.flagged ? 'Unpin' : 'Pin'}
              </RowAction>
              <RowAction accent onClick={onOpen}>
                Open
              </RowAction>
            </span>
            <span className="flex shrink-0 items-center gap-2 group-hover:hidden">
              {thread.flagged && (
                <span className="text-[9px] text-meta" title="Pinned">
                  ◆
                </span>
              )}
              {unread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              <span className="whitespace-nowrap text-[12px] text-meta">{shortDate(date)}</span>
            </span>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!inTrashOrSpam && (
          <ContextMenuItem
            onSelect={() => (archived ? threadAction(ref, 'toggleArchive') : done(ref))}
          >
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
