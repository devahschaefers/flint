import { useMemo } from 'react'
import InboxHeader from '../components/inbox/InboxHeader'
import DateSection from '../components/inbox/DateSection'
import GroupRow from '../components/inbox/GroupRow'
import ThreadRow from '../components/inbox/ThreadRow'
import { groupByBucket } from '../lib/dates'
import { buildThreads, inboxThreads } from '../lib/threads'
import { filterByAccount, useAppStore } from '../store'
import type { Category } from '../data/types'

const GROUP_ORDER: Category[] = ['notifications', 'people', 'invites']

export default function SmartInboxView(): React.JSX.Element {
  const messages = useAppStore((s) => s.messages)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openThread = useAppStore((s) => s.openThread)
  const openGroup = useAppStore((s) => s.openGroup)
  const connected = useAppStore((s) => s.connected)
  const openSettings = useAppStore((s) => s.openSettings)

  const threads = useMemo(
    () => buildThreads(filterByAccount(messages, activeAccountId)),
    [messages, activeAccountId]
  )
  const visible = inboxThreads(threads, !hideDone)

  const groups = GROUP_ORDER.map((category) => ({
    category,
    threads: visible.filter((t) => t.category === category && !t.important)
  })).filter((g) => g.threads.length > 0)

  const important = visible.filter((t) => t.important)
  const buckets = groupByBucket(important, (t) => t.latest.date)

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

  return (
    <div className="relative h-full flex flex-col">
      <InboxHeader />
      <div className="flex-1 overflow-y-auto px-[30px] pb-6">
        <DateSection label="Today" className="pl-[50px] mb-2 mt-1" />
        {groups.map((g) => (
          <GroupRow
            key={g.category}
            category={g.category}
            threads={g.threads}
            onOpen={() => openGroup(g.category)}
          />
        ))}
        {buckets.map(([bucket, items]) =>
          bucket === 'Today' ? (
            <div key={bucket} className="mt-1">
              {items.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} onClick={() => openThread(thread.id)} />
              ))}
            </div>
          ) : (
            <div key={bucket}>
              <DateSection label={bucket} className="pl-[50px] mt-5 mb-2" />
              {items.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} onClick={() => openThread(thread.id)} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
