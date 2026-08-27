import { motion } from 'motion/react'
import { Check, PenLine, Search } from 'lucide-react'
import DateSection from '../components/inbox/DateSection'
import EmailRow from '../components/inbox/EmailRow'
import { groupByBucket } from '../lib/dates'
import { filterByAccount, useAppStore, type FolderView } from '../store'
import type { Email } from '../data/types'
import { cn } from '../lib/utils'

const FOLDER_TITLES: Record<FolderView, string> = {
  pins: 'Pins',
  drafts: 'Drafts',
  sent: 'Sent',
  trash: 'Trash',
  spam: 'Spam'
}

interface FolderListViewProps {
  folder: FolderView
}

export default function FolderListView({ folder }: FolderListViewProps): React.JSX.Element {
  const emails = useAppStore((s) => s.emails)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const openEmail = useAppStore((s) => s.openEmail)

  const title = FOLDER_TITLES[folder]
  const list = filterByAccount(emails, activeAccountId)
    .filter((e) => (folder === 'pins' ? e.pinned && e.folder === 'inbox' : e.folder === folder))
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
          <span className="text-[15px] font-semibold text-text-primary">{title}</span>
        </div>

        <div className="no-drag flex items-center gap-4 text-text-bright">
          <button
            aria-label="Hide done emails"
            className="flex h-[18px] w-[34px] items-center rounded-full bg-elevation-3 px-[2px]"
          >
            <span className="flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white">
              <Check size={9} strokeWidth={3.5} className="text-elevation-0" />
            </span>
          </button>
          <button aria-label="Search" className="transition-colors hover:text-ink">
            <Search size={19} />
          </button>
          <button aria-label="Compose" className="transition-colors hover:text-ink">
            <PenLine size={19} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-[30px] pb-6">
        {list.length === 0 ? (
          <div className="flex h-[40%] items-end justify-center">
            <span className="text-[13px] text-text-muted">Nothing in {title}</span>
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
