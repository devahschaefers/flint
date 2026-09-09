import InboxHeader from '../components/inbox/InboxHeader'
import DateSection from '../components/inbox/DateSection'
import GroupRow from '../components/inbox/GroupRow'
import ThreadRow from '../components/inbox/ThreadRow'
import { groupByBucket } from '../lib/dates'
import { useMailQuery, useReachBottom, useThreadPages } from '../lib/useMailQuery'
import { accountScope, useAppStore } from '../store'
import type { Category } from '../data/types'
import type { WireThread } from '../../../preload/index.d'

const isoDate = (t: WireThread): string => new Date(t.latestDateMs).toISOString()

/**
 * The smart inbox: one row per category group (computed by main), then the
 * important conversations as an infinite-scroll list.
 */
export default function SmartInboxView(): React.JSX.Element {
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openThread = useAppStore((s) => s.openThread)
  const openGroup = useAppStore((s) => s.openGroup)
  const archiveGroup = useAppStore((s) => s.archiveGroup)
  const connected = useAppStore((s) => s.connected)
  const openSettings = useAppStore((s) => s.openSettings)

  const scope = accountScope(activeAccountId)
  const includeArchived = !hideDone
  const overview = useMailQuery(
    () => window.api.inboxOverview(scope, includeArchived),
    [scope, includeArchived]
  )
  const important = useThreadPages(scope, { kind: 'inbox', includeArchived, importantOnly: true })
  const sentinel = useReachBottom(important.loadMore, important.hasMore)

  if (!connected) {
    return (
      <div className="relative h-full flex flex-col">
        <InboxHeader />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-24">
          <span className="text-[15px] font-semibold text-text-primary">No account connected</span>
          <span className="max-w-[340px] text-center text-[13px] leading-[1.5] text-text-secondary">
            Connect your Gmail to start syncing your mail into the app.
          </span>
          <button
            onClick={openSettings}
            className="mt-2 rounded-[10px] bg-blue-4 px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Add account
          </button>
        </div>
      </div>
    )
  }

  const groups = overview.data?.groups ?? []
  const buckets = groupByBucket(important.threads, isoDate)
  const empty = groups.length === 0 && important.threads.length === 0 && !important.loading

  return (
    <div className="relative h-full flex flex-col">
      <InboxHeader />
      <div className="flex-1 overflow-y-auto px-[30px] pb-6">
        <DateSection label="Today" className="pl-[50px] mb-2 mt-1" />
        {groups.map((g) => (
          <GroupRow
            key={g.category}
            group={g}
            onOpen={() => openGroup(g.category as Category)}
            onArchiveAll={() => archiveGroup(scope, g.category, includeArchived)}
          />
        ))}
        {buckets.map(([bucket, items]) =>
          bucket === 'Today' ? (
            <div key={bucket} className="mt-1">
              {items.map((thread) => (
                <ThreadRow
                  key={`${thread.accountId}:${thread.threadKey}`}
                  thread={thread}
                  onClick={() => openThread(thread)}
                />
              ))}
            </div>
          ) : (
            <div key={bucket}>
              <DateSection label={bucket} className="pl-[50px] mt-5 mb-2" />
              {items.map((thread) => (
                <ThreadRow
                  key={`${thread.accountId}:${thread.threadKey}`}
                  thread={thread}
                  onClick={() => openThread(thread)}
                />
              ))}
            </div>
          )
        )}
        {empty && (
          <div className="flex h-[40%] items-end justify-center">
            <span className="text-[13px] text-text-muted">You&rsquo;re all caught up</span>
          </div>
        )}
        <div ref={sentinel} className="h-px" />
      </div>
    </div>
  )
}
