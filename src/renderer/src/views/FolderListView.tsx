import { useMemo } from 'react'
import DraftRow from '../components/inbox/DraftRow'
import SectionLabel from '../components/inbox/SectionLabel'
import ThreadRow from '../components/inbox/ThreadRow'
import ListHeader from '../components/shell/ListHeader'
import { Empty, Page } from '../components/shell/Page'
import { groupByBucket } from '../lib/dates'
import { useMailQuery, useReachBottom, useThreadPages } from '../lib/useMailQuery'
import { wireToMessage } from '../lib/wire'
import { FOLDER_TITLES, accountScope, useAppStore, type FolderView } from '../store'
import type { ThreadListView, WireThread } from '../../../preload/index.d'

const isoDate = (t: WireThread): string => new Date(t.latestDateMs).toISOString()

function DraftsList({ scope }: { scope: string | null }): React.JSX.Element {
  const contacts = useAppStore((s) => s.contacts)
  const openCompose = useAppStore((s) => s.openCompose)
  const deleteDraft = useAppStore((s) => s.deleteDraft)
  const { data, loading } = useMailQuery(() => window.api.listDrafts(scope), [scope])
  const drafts = useMemo(() => (data ?? []).map(wireToMessage), [data])
  const count = drafts.length

  return (
    <>
      <ListHeader
        title="Drafts"
        right={count > 0 ? `${count} ${count === 1 ? 'draft' : 'drafts'}` : undefined}
      />
      {count === 0 ? (
        loading ? null : (
          <Empty>Nothing in Drafts</Empty>
        )
      ) : (
        groupByBucket(drafts, (m) => m.date).map(([bucket, items]) => (
          <section key={bucket}>
            <SectionLabel label={bucket} />
            {items.map((draft) => (
              <DraftRow
                key={draft.messageId}
                draft={draft}
                contacts={contacts}
                onOpen={() => openCompose(draft)}
                onDelete={() => deleteDraft(draft)}
              />
            ))}
          </section>
        ))
      )}
    </>
  )
}

function ThreadList({
  scope,
  view,
  title
}: {
  scope: string | null
  view: ThreadListView
  title: string
}): React.JSX.Element {
  const openThread = useAppStore((s) => s.openThread)
  const pages = useThreadPages(scope, view)
  const sentinel = useReachBottom(pages.loadMore, pages.hasMore)
  return (
    <>
      <ListHeader title={title} />
      {pages.threads.length === 0 && !pages.loading ? (
        <Empty>Nothing in {title}</Empty>
      ) : (
        groupByBucket(pages.threads, isoDate).map(([bucket, items]) => (
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
    </>
  )
}

interface FolderListViewProps {
  folder: FolderView
}

/** Pins, Drafts, Sent, Trash, Spam, Archive — the same page as the inbox, without bundles */
export default function FolderListView({ folder }: FolderListViewProps): React.JSX.Element {
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const scope = accountScope(activeAccountId)
  const title = FOLDER_TITLES[folder]
  const view: ThreadListView | null =
    folder === 'drafts' ? null : folder === 'pins' ? { kind: 'pins' } : { kind: 'folder', folder }

  return (
    <Page>
      {view ? (
        <ThreadList key={JSON.stringify(view)} scope={scope} view={view} title={title} />
      ) : (
        <DraftsList scope={scope} />
      )}
    </Page>
  )
}
