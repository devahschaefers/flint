import { motion } from 'motion/react'
import { ArrowLeft, Check } from 'lucide-react'
import DateSection from '../components/inbox/DateSection'
import EmailRow from '../components/inbox/EmailRow'
import HeaderControls from '../components/inbox/HeaderControls'
import { groupByBucket } from '../lib/dates'
import { useAppStore, visibleEmails } from '../store'
import { CATEGORY_LABELS, type Category, type Email } from '../data/types'
import { cn } from '../lib/utils'

interface GroupListViewProps {
  category: Category
}

export default function GroupListView({ category }: GroupListViewProps): React.JSX.Element {
  const emails = useAppStore((s) => s.emails)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openEmail = useAppStore((s) => s.openEmail)
  const back = useAppStore((s) => s.back)
  const markDone = useAppStore((s) => s.markDone)

  const list = visibleEmails(emails, activeAccountId, hideDone)
    .filter((e) => e.folder === 'inbox' && e.category === category && !e.important)
    .sort((a: Email, b: Email) => b.date.localeCompare(a.date))
  const buckets = groupByBucket(list, (e) => e.date)

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
            onClick={() => markDone(list.map((e) => e.id))}
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
              {items.map((email) => (
                <EmailRow key={email.id} email={email} onClick={() => openEmail(email.id)} />
              ))}
            </div>
          ))
        )}
      </div>
    </motion.div>
  )
}
