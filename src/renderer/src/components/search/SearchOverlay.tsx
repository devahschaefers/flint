import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Search, X } from 'lucide-react'
import { useMailQuery } from '../../lib/useMailQuery'
import { accountScope, useAppStore } from '../../store'
import ThreadRow from '../inbox/ThreadRow'

const MIN_QUERY = 2
const DEBOUNCE_MS = 120
const RESULT_LIMIT = 50

/** Global search across all mail (every folder, archive included). Store-driven. */
export default function SearchOverlay(): React.JSX.Element | null {
  const searchOpen = useAppStore((s) => s.searchOpen)
  // The panel owns the query and unmounts on close, so every open starts empty
  return searchOpen ? <SearchPanel /> : null
}

/** The typed value, settled: only changes once typing pauses */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return settled
}

function SearchPanel(): React.JSX.Element {
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const openThread = useAppStore((s) => s.openThread)
  const activeAccountId = useAppStore((s) => s.activeAccountId)

  const [query, setQuery] = useState('')
  const trimmed = useDebounced(query.trim(), DEBOUNCE_MS)
  const scope = accountScope(activeAccountId)

  // Full-text search over subject and body in main (FTS5, best match first);
  // results are whole conversations with the best-matching message's snippet.
  const { data: results, loading } = useMailQuery(
    () =>
      trimmed.length < MIN_QUERY
        ? Promise.resolve([])
        : window.api.search(trimmed, scope, RESULT_LIMIT),
    [trimmed, scope]
  )
  const list = results ?? []

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
          {trimmed.length < MIN_QUERY ? (
            <div className="py-8 text-center text-[13px] text-text-muted">Type to search</div>
          ) : list.length === 0 && !loading ? (
            <div className="py-8 text-center text-[13px] text-text-muted">
              No results for &ldquo;{trimmed}&rdquo;
            </div>
          ) : (
            list.map((result) => (
              <ThreadRow
                key={`${result.accountId}:${result.threadKey}`}
                thread={result}
                preview={result.match.snippet}
                onClick={() => {
                  openThread(result)
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
