import SectionLabel from '../components/inbox/SectionLabel'
import ThreadRow from '../components/inbox/ThreadRow'
import BackLink from '../components/shell/BackLink'
import { Empty, Page, TextAction } from '../components/shell/Page'
import { groupByBucket } from '../lib/dates'
import { useReachBottom, useThreadPages } from '../lib/useMailQuery'
import { accountScope, useAppStore } from '../store'
import { CATEGORY_LABELS, type Category } from '../data/types'
import type { WireThread } from '../../../preload/index.d'

interface GroupListViewProps {
  category: Category
}

const isoDate = (t: WireThread): string => new Date(t.latestDateMs).toISOString()

/** One smart-inbox bundle opened as a full list */
export default function GroupListView({ category }: GroupListViewProps): React.JSX.Element {
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openThread = useAppStore((s) => s.openThread)
  const archiveGroup = useAppStore((s) => s.archiveGroup)
  const goInbox = useAppStore((s) => s.goInbox)

  const scope = accountScope(activeAccountId)
  const includeArchived = !hideDone
  const pages = useThreadPages(scope, { kind: 'inbox', includeArchived, category })
  const sentinel = useReachBottom(pages.loadMore, pages.hasMore)
  const buckets = groupByBucket(pages.threads, isoDate)
  const title = CATEGORY_LABELS[category]

  return (
    <Page>
      <div className="no-drag flex items-baseline gap-2.5">
        <BackLink />
        <span className="ml-1 text-[15px] font-semibold text-ink">{title}</span>
        <span className="flex-1" />
        {pages.threads.length > 0 && (
          <TextAction
            onClick={() => {
              archiveGroup(scope, category, includeArchived)
              goInbox()
            }}
          >
            Mark all done
          </TextAction>
        )}
      </div>
      {pages.threads.length === 0 && !pages.loading ? (
        <Empty>Nothing in {title}</Empty>
      ) : (
        buckets.map(([bucket, items]) => (
          <section key={bucket}>
            <SectionLabel label={bucket} />
            {items.map((thread) => (
              <ThreadRow
                key={`${thread.accountId}:${thread.threadKey}`}
                thread={thread}
                onOpen={() => openThread(thread)}
              />
            ))}
          </section>
        ))
      )}
      <div ref={sentinel} className="h-px" />
    </Page>
  )
}
