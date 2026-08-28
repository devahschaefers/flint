import { useMemo } from 'react'
import { motion } from 'motion/react'
import DateSection from '../components/inbox/DateSection'
import ThreadRow from '../components/inbox/ThreadRow'
import HeaderControls from '../components/inbox/HeaderControls'
import { groupByBucket, shortDate } from '../lib/dates'
import { buildThreads, threadsInFolder, type Thread } from '../lib/threads'
import { resolveMailbox, resolveNames } from '../lib/identity'
import { filterByAccount, useAppStore, type FolderView } from '../store'
import type { Contact, Message } from '../data/types'
import { cn } from '../lib/utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '../components/ui/context-menu'

const FOLDER_TITLES: Record<FolderView, string> = {
  pins: 'Pins',
  drafts: 'Drafts',
  sent: 'Sent',
  trash: 'Trash',
  spam: 'Spam',
  archive: 'Archive'
}

interface DraftRowProps {
  draft: Message
  contacts: Contact[]
  onClick: () => void
  onDelete: () => void
}

/** Drafts are individual messages, not conversations — a simple inline row. */
function DraftRow({ draft, contacts, onClick, onDelete }: DraftRowProps): React.JSX.Element {
  const recipient = draft.to[0]
  const resolved = recipient ? resolveMailbox(recipient, contacts) : null
  const name = draft.to.length > 0 ? resolveNames(draft.to, contacts) : '(no recipient)'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          className="group flex h-[42px] w-full items-center gap-[10px] rounded-[10px] px-[10px] text-left transition-colors hover:bg-elevation-1"
        >
          <span className="w-[26px] shrink-0" />
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ backgroundColor: resolved?.color ?? '#66707e' }}
          >
            {resolved?.initials ?? '?'}
          </span>
          <span className="w-[230px] shrink-0 truncate text-[13px] font-semibold text-text-primary">
            {name}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            <span className="font-semibold text-text-primary">{draft.subject}</span>
            <span className="font-normal text-text-secondary">{'  ' + (draft.body[0] ?? '')}</span>
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-text-secondary">
            {shortDate(draft.date)}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onClick}>Edit draft</ContextMenuItem>
        <ContextMenuItem onSelect={onDelete}>Delete draft</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface FolderListViewProps {
  folder: FolderView
}

export default function FolderListView({ folder }: FolderListViewProps): React.JSX.Element {
  const messages = useAppStore((s) => s.messages)
  const contacts = useAppStore((s) => s.contacts)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const openThread = useAppStore((s) => s.openThread)
  const openCompose = useAppStore((s) => s.openCompose)
  const deleteDraft = useAppStore((s) => s.deleteDraft)

  const title = FOLDER_TITLES[folder]
  const accountMessages = useMemo(
    () => filterByAccount(messages, activeAccountId),
    [messages, activeAccountId]
  )
  const threads = useMemo(() => buildThreads(accountMessages), [accountMessages])

  const isDrafts = folder === 'drafts'

  /** Drafts render as individual messages; every other list renders threads. */
  const drafts = isDrafts
    ? [...accountMessages.filter((m) => m.folder === 'drafts')].sort((a, b) =>
        b.date.localeCompare(a.date)
      )
    : []
  const list: Thread[] = isDrafts
    ? []
    : folder === 'pins'
      ? // Pinned conversations, excluding ones sitting in Trash/Spam
        threads.filter(
          (t) => t.flagged && !t.messages.some((m) => m.folder === 'trash' || m.folder === 'spam')
        )
      : threadsInFolder(threads, folder)

  const empty = isDrafts ? drafts.length === 0 : list.length === 0

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative h-full flex flex-col"
    >
      <div className="drag-region flex items-center justify-between px-[30px] pt-[40px] pb-2">
        <div className="no-drag flex items-center">
          <span className="text-[15px] font-semibold text-text-primary">{title}</span>
        </div>

        <HeaderControls showDoneToggle={folder !== 'archive'} />
      </div>

      <div className="flex-1 overflow-y-auto px-[30px] pb-6">
        {empty ? (
          <div className="flex h-[40%] items-end justify-center">
            <span className="text-[13px] text-text-muted">Nothing in {title}</span>
          </div>
        ) : isDrafts ? (
          groupByBucket(drafts, (m) => m.date).map(([bucket, items], i) => (
            <div key={bucket}>
              <DateSection
                label={bucket}
                className={cn('pl-[10px] mb-1.5', i === 0 ? 'mt-2' : 'mt-5')}
              />
              {items.map((draft) => (
                <DraftRow
                  key={draft.messageId}
                  draft={draft}
                  contacts={contacts}
                  onClick={() => openCompose(draft.messageId)}
                  onDelete={() => deleteDraft(draft.messageId)}
                />
              ))}
            </div>
          ))
        ) : (
          groupByBucket(list, (t) => t.latest.date).map(([bucket, items], i) => (
            <div key={bucket}>
              <DateSection
                label={bucket}
                className={cn('pl-[10px] mb-1.5', i === 0 ? 'mt-2' : 'mt-5')}
              />
              {items.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} onClick={() => openThread(thread.id)} />
              ))}
            </div>
          ))
        )}
      </div>
    </motion.div>
  )
}
