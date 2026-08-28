import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Search, X } from 'lucide-react'
import type { Mailbox } from '../../data/types'
import { resolveMailbox } from '../../lib/identity'
import { buildThreads, threadRootId, type Thread } from '../../lib/threads'
import { filterByAccount, useAppStore } from '../../store'
import ThreadRow from '../inbox/ThreadRow'

/** Global search across all mail (every folder, archive included). Store-driven. */
export default function SearchOverlay(): React.JSX.Element | null {
  const searchOpen = useAppStore((s) => s.searchOpen)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const openThread = useAppStore((s) => s.openThread)
  const messages = useAppStore((s) => s.messages)
  const contacts = useAppStore((s) => s.contacts)
  const activeAccountId = useAppStore((s) => s.activeAccountId)

  const [query, setQuery] = useState('')

  // Fresh query each time the overlay opens
  useEffect(() => {
    if (searchOpen) setQuery('')
  }, [searchOpen])

  const trimmed = query.trim()

  // Match subject, body, and every address/name a message carries — including the
  // resolved contact name, so "Mom" finds mail from linda.schaefers@comcast.net
  // as well as sent mail addressed to her. Results are whole conversations.
  const results = useMemo((): Thread[] => {
    if (trimmed.length < 2) return []
    const q = trimmed.toLowerCase()
    const visible = filterByAccount(messages, activeAccountId)
    const mailboxMatches = (m: Mailbox): boolean =>
      m.address.toLowerCase().includes(q) ||
      (m.name?.toLowerCase().includes(q) ?? false) ||
      resolveMailbox(m, contacts).name.toLowerCase().includes(q)
    const rootIds = new Set<string>()
    for (const message of visible) {
      if (
        message.subject.toLowerCase().includes(q) ||
        message.body.join(' ').toLowerCase().includes(q) ||
        mailboxMatches(message.from) ||
        message.to.some(mailboxMatches) ||
        message.cc.some(mailboxMatches)
      ) {
        rootIds.add(threadRootId(message))
      }
    }
    return buildThreads(visible)
      .filter((t) => rootIds.has(t.id))
      .slice(0, 50)
  }, [messages, contacts, activeAccountId, trimmed])

  if (!searchOpen) return null

  return (
    // Above the composer (z-[60]) so Cmd+K works while composing; menus are z-[80]
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/30" onClick={() => setSearchOpen(false)} />
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="relative mx-auto mt-[9vh] flex max-h-[70vh] w-[640px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-elevation-1 shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/5 px-4">
          <Search size={17} className="shrink-0 text-text-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail"
            className="select-text flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-muted"
          />
          <button
            aria-label={query ? 'Clear search' : 'Close search'}
            onClick={() => (query ? setQuery('') : setSearchOpen(false))}
            className="shrink-0 text-text-secondary transition-colors duration-150 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto px-2 py-2">
          {trimmed.length < 2 ? (
            <div className="py-8 text-center text-[13px] text-text-muted">Type to search</div>
          ) : results.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-text-muted">
              No results for &ldquo;{trimmed}&rdquo;
            </div>
          ) : (
            results.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                onClick={() => {
                  openThread(thread.id)
                  setSearchOpen(false)
                }}
              />
            ))
          )}
        </div>
      </motion.div>
    </div>
  )
}
