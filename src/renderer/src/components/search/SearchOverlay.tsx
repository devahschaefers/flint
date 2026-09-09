import { useEffect, useMemo, useState } from 'react'
import type { SearchResult } from '../../../../preload/index.d'
import { formatMailbox, isValidAddress } from '../../lib/address'
import { shortDate } from '../../lib/dates'
import { resolveMailbox } from '../../lib/identity'
import { normalizeSubject } from '../../lib/threads'
import { useMailQuery } from '../../lib/useMailQuery'
import { cn } from '../../lib/utils'
import { accountScope, useAppStore } from '../../store'
import Avatar from '../ui/Avatar'
import { SearchIcon } from '../ui/icons'

const MIN_QUERY = 2
const DEBOUNCE_MS = 120
const RESULT_LIMIT = 30

/** ⌘K: full-text search over every folder, keyboard-first, with a compose shortcut. Store-driven. */
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
  const openCompose = useAppStore((s) => s.openCompose)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const contacts = useAppStore((s) => s.contacts)
  const connected = useAppStore((s) => s.connected)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const trimmed = useDebounced(query.trim(), DEBOUNCE_MS)
  const scope = accountScope(activeAccountId)

  // Full-text search over subject and body in main (FTS5, best match first);
  // results are whole conversations with the best-matching message's snippet.
  const { data, loading } = useMailQuery(
    () =>
      trimmed.length < MIN_QUERY
        ? Promise.resolve([])
        : window.api.search(trimmed, scope, RESULT_LIMIT),
    [trimmed, scope]
  )
  const results = useMemo(() => data ?? [], [data])
  const active = trimmed.length >= MIN_QUERY
  const sel = Math.min(selected, Math.max(0, results.length - 1))

  // Compose shortcut: to the top result's counterpart, or to a typed address
  const composeTarget = useMemo(() => {
    const top = results[0]?.counterpart
    if (top) return { to: formatMailbox(top), name: resolveMailbox(top, contacts).name }
    if (isValidAddress(trimmed)) return { to: trimmed, name: trimmed }
    return null
  }, [results, trimmed, contacts])

  const open = (r: SearchResult): void => {
    openThread(r)
    setSearchOpen(false)
  }
  const compose = (): void => {
    if (!composeTarget) return
    setSearchOpen(false)
    openCompose(null, { to: composeTarget.to })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(Math.min(sel + 1, Math.max(0, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(Math.max(0, sel - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[sel]
      if (r) open(r)
      else if (composeTarget) compose()
    }
  }

  return (
    // Above the composer (z-[60]) so ⌘K works while composing; menus are z-[80]
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-16">
      <div className="absolute inset-0 bg-black/35" onClick={() => setSearchOpen(false)} />
      <div className="enter relative flex max-h-[70vh] w-[560px] max-w-[92%] flex-col overflow-hidden rounded-[14px] border border-edge bg-panel shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-[18px] py-1">
          <span className="shrink-0 text-label">
            <SearchIcon />
          </span>
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={connected ? 'Search mail…' : 'No account connected'}
            disabled={!connected}
            className="select-text h-11 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-label"
          />
          <span className="shrink-0 text-[11px] text-hint">esc</span>
        </div>

        <div className="min-h-0 overflow-y-auto">
          {active && results.length > 0 && (
            <>
              <div className="px-[18px] pb-0.5 pt-2 text-[10px] tracking-[0.14em] text-hint uppercase">
                Conversations
              </div>
              <div className="px-2.5 pb-2">
                {results.map((r, i) => {
                  const mailbox = r.counterpart ?? r.latest.to[0] ?? r.latest.from
                  const identity = resolveMailbox(mailbox, contacts)
                  const current = i === sel
                  return (
                    <div
                      key={`${r.accountId}:${r.threadKey}`}
                      role="option"
                      aria-selected={current}
                      onClick={() => open(r)}
                      onMouseEnter={() => setSelected(i)}
                      title={r.match.snippet}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 py-[7px]',
                        current && 'bg-hover-strong'
                      )}
                    >
                      <Avatar initials={identity.initials} color={identity.color} size={22} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        <span
                          className={cn(
                            current ? 'text-ink' : 'text-body',
                            r.unread > 0 && 'font-semibold'
                          )}
                        >
                          {r.counterpart ? identity.name : `To ${identity.name}`}
                        </span>
                        <span className="text-quiet">
                          {'  '}
                          {normalizeSubject(r.match.subject || r.subject) || '(no subject)'}
                        </span>
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[11.5px] text-label">
                        {shortDate(new Date(r.latestDateMs).toISOString())}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {active && results.length === 0 && !loading && (
            <div className="px-[18px] py-6 text-center text-[13px] text-label">
              No matches for &ldquo;{trimmed}&rdquo;
            </div>
          )}
          {composeTarget && (
            <>
              <div
                className={cn(
                  'px-[18px] pb-0.5 pt-1.5 text-[10px] tracking-[0.14em] text-hint uppercase',
                  results.length > 0 && 'border-t border-line'
                )}
              >
                Actions
              </div>
              <div className="px-2.5 pb-2">
                <div
                  role="option"
                  aria-selected={false}
                  onClick={compose}
                  className="flex cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13px] text-bright transition-colors hover:bg-hover-strong hover:text-ink"
                >
                  Compose to {composeTarget.name}
                  <span className="flex-1" />
                  <span className="text-[11px] text-hint">⌘N</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex shrink-0 gap-4 border-t border-line px-[18px] py-[9px] text-[11px] text-hint">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
        </div>
      </div>
    </div>
  )
}
