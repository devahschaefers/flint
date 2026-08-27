import { motion } from 'motion/react'
import DateSection from '../components/inbox/DateSection'
import EmailRow from '../components/inbox/EmailRow'
import HeaderControls from '../components/inbox/HeaderControls'
import { groupByBucket } from '../lib/dates'
import { filterByAccount, useAppStore, visibleEmails, type FolderView } from '../store'
import type { Email } from '../data/types'
import { cn } from '../lib/utils'

const FOLDER_TITLES: Record<FolderView, string> = {
  pins: 'Pins',
  drafts: 'Drafts',
  sent: 'Sent',
  trash: 'Trash',
  spam: 'Spam',
  archive: 'Archive'
}

interface FolderListViewProps {
  folder: FolderView
}

export default function FolderListView({ folder }: FolderListViewProps): React.JSX.Element {
  const emails = useAppStore((s) => s.emails)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const hideDone = useAppStore((s) => s.hideDone)
  const openEmail = useAppStore((s) => s.openEmail)
  const openCompose = useAppStore((s) => s.openCompose)

  const title = FOLDER_TITLES[folder]
  const list = (
    folder === 'archive'
      ? filterByAccount(emails, activeAccountId).filter((e) => e.done)
      : visibleEmails(emails, activeAccountId, hideDone).filter((e) =>
          folder === 'pins' ? e.pinned && e.folder === 'inbox' : e.folder === folder
        )
  ).sort((a: Email, b: Email) => b.date.localeCompare(a.date))
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

        <HeaderControls showDoneToggle={folder !== 'archive'} />
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
                <EmailRow
                  key={email.id}
                  email={email}
                  onClick={() =>
                    email.folder === 'drafts' ? openCompose(email.id) : openEmail(email.id)
                  }
                />
              ))}
            </div>
          ))
        )}
      </div>
    </motion.div>
  )
}
