import { motion } from 'motion/react'
import { ArrowLeft, Check } from 'lucide-react'
import DateSection from '../components/inbox/DateSection'
import ThreadRow from '../components/inbox/ThreadRow'
import HeaderControls from '../components/inbox/HeaderControls'
import { groupByBucket } from '../lib/dates'
import { useReachBottom, useThreadPages } from '../lib/useMailQuery'
import { accountScope, useAppStore } from '../store'
import { CATEGORY_LABELS, type Category } from '../data/types'
import { cn } from '../lib/utils'
import type { WireThread } from '../../../preload/index.d'

interface GroupListViewProps {
  category: Category
}

const isoDate = (t: WireThread): string => new Date(t.latestDateMs).toISOString()

/** One smart-inbox group opened as a full list */
export default function GroupListView({ category }: GroupListViewProps): React.JSX.Element {
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openThread = useAppStore((s) => s.openThread)
  const back = useAppStore((s) => s.back)
  const archiveGroup = useAppStore((s) => s.archiveGroup)

  const scope = accountScope(activeAccountId)
  const includeArchived = !hideDone
  const pages = useThreadPages(scope, { kind: 'inbox', includeArchived, category })
  const sentinel = useReachBottom(pages.loadMore, pages.hasMore)
  const buckets = groupByBucket(pages.threads, isoDate)

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
            onClick={() => archiveGroup(scope, category, includeArchived)}
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
        {pages.threads.length === 0 && !pages.loading ? (
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
                <ThreadRow
                  key={`${thread.accountId}:${thread.threadKey}`}
                  thread={thread}
                  onClick={() => openThread(thread)}
                />
              ))}
            </div>
          ))
        )}
        <div ref={sentinel} className="h-px" />
      </div>
    </motion.div>
  )
}
