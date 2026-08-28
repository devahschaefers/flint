import { useMemo } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Check } from 'lucide-react'
import DateSection from '../components/inbox/DateSection'
import ThreadRow from '../components/inbox/ThreadRow'
import HeaderControls from '../components/inbox/HeaderControls'
import { groupByBucket } from '../lib/dates'
import { buildThreads, inboxThreads } from '../lib/threads'
import { filterByAccount, useAppStore } from '../store'
import { CATEGORY_LABELS, type Category } from '../data/types'
import { cn } from '../lib/utils'

interface GroupListViewProps {
  category: Category
}

export default function GroupListView({ category }: GroupListViewProps): React.JSX.Element {
  const messages = useAppStore((s) => s.messages)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openThread = useAppStore((s) => s.openThread)
  const back = useAppStore((s) => s.back)
  const archiveThreads = useAppStore((s) => s.archiveThreads)

  const threads = useMemo(
    () => buildThreads(filterByAccount(messages, activeAccountId)),
    [messages, activeAccountId]
  )
  const list = inboxThreads(threads, !hideDone).filter(
    (t) => t.category === category && !t.important
  )
  const buckets = groupByBucket(list, (t) => t.latest.date)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative h-full flex flex-col"
    >
      <div className="drag-region flex items-center justify-between px-[30px] pt-[40px] pb-2">
        <div className="no-drag flex items-center">
          <button
            aria-label="Back to inbox"
            onClick={back}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-l-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="h-[28px] w-px bg-transparent" />
          <button
            aria-label="Mark all done"
            title="Mark all done"
            onClick={() => archiveThreads(list.map((t) => t.id))}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-r-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <Check size={15} />
          </button>
          <span className="ml-3.5 text-[15px] font-semibold text-text-primary">
            {CATEGORY_LABELS[category]}
          </span>
        </div>

        <HeaderControls />
      </div>

      <div className="flex-1 overflow-y-auto px-[30px] pb-6">
        {list.length === 0 ? (
          <div className="flex h-[40%] items-end justify-center">
            <span className="text-[13px] text-text-muted">
              Nothing in {CATEGORY_LABELS[category]}
            </span>
          </div>
        ) : (
          buckets.map(([bucket, items], i) => (
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
