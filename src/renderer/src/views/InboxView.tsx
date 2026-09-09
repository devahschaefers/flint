import BundleRow from '../components/inbox/BundleRow'
import SectionLabel from '../components/inbox/SectionLabel'
import ThreadRow from '../components/inbox/ThreadRow'
import ListHeader from '../components/shell/ListHeader'
import { Empty, Page } from '../components/shell/Page'
import { groupByBucket } from '../lib/dates'
import { useMailQuery, useReachBottom, useThreadPages } from '../lib/useMailQuery'
import { accountScope, useAppStore } from '../store'
import type { Category } from '../data/types'
import type { WireThread } from '../../../preload/index.d'

const isoDate = (t: WireThread): string => new Date(t.latestDateMs).toISOString()

/**
 * The smart inbox: one quiet line per bundle (computed by main), then the
 * important conversations as an infinite-scroll list under date labels.
 */
export default function InboxView(): React.JSX.Element {
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openThread = useAppStore((s) => s.openThread)
  const openGroup = useAppStore((s) => s.openGroup)
  const archiveGroup = useAppStore((s) => s.archiveGroup)
  const connected = useAppStore((s) => s.connected)
  const openSettings = useAppStore((s) => s.openSettings)
  const unread = useAppStore((s) => s.unread)

  const scope = accountScope(activeAccountId)
  const includeArchived = !hideDone
  const overview = useMailQuery(
    () => window.api.inboxOverview(scope, includeArchived),
    [scope, includeArchived]
  )
  const important = useThreadPages(scope, { kind: 'inbox', includeArchived, importantOnly: true })
  const sentinel = useReachBottom(important.loadMore, important.hasMore)

  const unreadCount = unread
    .filter((u) => scope === null || u.accountId === scope)
    .reduce((n, u) => n + u.inboxUnread, 0)

  if (!connected) {
    return (
      <Page>
        <ListHeader title="Inbox" />
        <div className="flex flex-col items-center gap-2 pt-[22vh] text-center">
          <span className="text-[15px] font-semibold text-ink">No account connected</span>
          <span className="max-w-[320px] text-[13px] leading-relaxed text-label">
            Connect your Gmail to start syncing mail into Flint.
          </span>
          <button
            onClick={openSettings}
            className="mt-3 rounded-[8px] bg-accent px-4 py-[7px] text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            Add account
          </button>
        </div>
      </Page>
    )
  }

  const groups = overview.data?.groups ?? []
  const buckets = groupByBucket(important.threads, isoDate)
  const empty = groups.length === 0 && important.threads.length === 0 && !important.loading

  return (
    <Page>
      <ListHeader title="Inbox" right={`${unreadCount} unread`} />
      {groups.length > 0 && (
        <div className="mt-3.5 flex flex-col gap-0.5">
          {groups.map((g) => (
            <BundleRow
              key={g.category}
              group={g}
              onOpen={() => openGroup(g.category as Category)}
              onArchiveAll={() => archiveGroup(scope, g.category, includeArchived)}
            />
          ))}
        </div>
      )}
      {buckets.map(([bucket, items]) => (
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
      ))}
      {empty && <Empty>Inbox zero — nothing left</Empty>}
      <div ref={sentinel} className="h-px" />
    </Page>
  )
}
