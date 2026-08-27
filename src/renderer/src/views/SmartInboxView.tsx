import InboxHeader from '../components/inbox/InboxHeader'
import DateSection from '../components/inbox/DateSection'
import GroupRow from '../components/inbox/GroupRow'
import EmailRow from '../components/inbox/EmailRow'
import { groupByBucket } from '../lib/dates'
import { useAppStore, visibleEmails } from '../store'
import type { Category, Email } from '../data/types'

const GROUP_ORDER: Category[] = ['notifications', 'people', 'invites']

export default function SmartInboxView(): React.JSX.Element {
  const emails = useAppStore((s) => s.emails)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openEmail = useAppStore((s) => s.openEmail)
  const openGroup = useAppStore((s) => s.openGroup)

  const inbox = visibleEmails(emails, activeAccountId, hideDone).filter((e) => e.folder === 'inbox')
  const byDateDesc = (a: Email, b: Email): number => b.date.localeCompare(a.date)

  const groups = GROUP_ORDER.map((category) => ({
    category,
    emails: inbox.filter((e) => e.category === category && !e.important).sort(byDateDesc)
  })).filter((g) => g.emails.length > 0)

  const important = inbox.filter((e) => e.important).sort(byDateDesc)
  const buckets = groupByBucket(important, (e) => e.date)

  return (
    <div className="relative h-full flex flex-col">
      <InboxHeader />
      <div className="flex-1 overflow-y-auto px-[30px] pb-6">
        <DateSection label="Today" className="pl-[50px] mb-2 mt-1" />
        {groups.map((g) => (
          <GroupRow
            key={g.category}
            category={g.category}
            emails={g.emails}
            onOpen={() => openGroup(g.category)}
          />
        ))}
        {buckets.map(([bucket, items]) =>
          bucket === 'Today' ? (
            <div key={bucket} className="mt-1">
              {items.map((email) => (
                <EmailRow key={email.id} email={email} onClick={() => openEmail(email.id)} />
              ))}
            </div>
          ) : (
            <div key={bucket}>
              <DateSection label={bucket} className="pl-[50px] mt-5 mb-2" />
              {items.map((email) => (
                <EmailRow key={email.id} email={email} onClick={() => openEmail(email.id)} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
