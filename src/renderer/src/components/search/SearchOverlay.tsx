import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Search, X } from 'lucide-react'
import type { Email } from '../../data/types'
import { filterByAccount, useAppStore } from '../../store'
import EmailRow from '../inbox/EmailRow'

/** Global search across all mail (every folder, done included). Store-driven. */
export default function SearchOverlay(): React.JSX.Element | null {
  const searchOpen = useAppStore((s) => s.searchOpen)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const openEmail = useAppStore((s) => s.openEmail)
  const openCompose = useAppStore((s) => s.openCompose)
  const emails = useAppStore((s) => s.emails)
  const activeAccountId = useAppStore((s) => s.activeAccountId)

  const [query, setQuery] = useState('')

  // Fresh query each time the overlay opens
  useEffect(() => {
    if (searchOpen) setQuery('')
  }, [searchOpen])

  const trimmed = query.trim()

  const results = useMemo((): Email[] => {
    if (trimmed.length < 2) return []
    const q = trimmed.toLowerCase()
    return filterByAccount(emails, activeAccountId)
      .filter((e) =>
        [e.subject, e.sender.name, e.sender.email, e.preview, e.body.join(' ')].some((text) =>
          text.toLowerCase().includes(q)
        )
      )
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 50)
  }, [emails, activeAccountId, trimmed])

  if (!searchOpen) return null

  return (
    <div className="fixed inset-0 z-[60]">
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
            results.map((email) => (
              <EmailRow
                key={email.id}
                email={email}
                onClick={() => {
                  if (email.folder === 'drafts') openCompose(email.id)
                  else openEmail(email.id)
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
