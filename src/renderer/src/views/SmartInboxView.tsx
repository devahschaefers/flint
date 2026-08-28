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
