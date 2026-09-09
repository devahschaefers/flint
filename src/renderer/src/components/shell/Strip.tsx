import { useRef } from 'react'
import { useAppStore } from '../../store'
import { cn } from '../../lib/utils'
import { ComposeIcon, FilterIcon, SearchIcon } from '../ui/icons'
import { Popover, PopoverItem, PopoverLabel } from '../ui/Popover'

const glyph =
  'flex h-7 w-7 items-center justify-center rounded-[7px] text-label transition-colors hover:bg-hover hover:text-muted'

/**
 * The quiet column under the traffic lights: account filter, search, compose.
 * Everything else in the app is reached from the header menu or ⌘K.
 */
export default function Strip(): React.JSX.Element {
  const popover = useAppStore((s) => s.popover)
  const setPopover = useAppStore((s) => s.setPopover)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const openCompose = useAppStore((s) => s.openCompose)
  const accounts = useAppStore((s) => s.accounts)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const connected = useAppStore((s) => s.connected)
  const filterRef = useRef<HTMLButtonElement>(null)

  const filterActive = activeAccountId !== 'all'
  const filterOpen = popover === 'filter'

  return (
    <div className="no-drag absolute left-[18px] top-[52px] z-[30] flex flex-col items-center gap-1.5">
      {accounts.length > 1 && (
        <button
          ref={filterRef}
          title="Filter by account"
          aria-label="Filter by account"
          onClick={() => setPopover(filterOpen ? null : 'filter')}
          className={cn(glyph, 'relative', filterOpen && 'bg-hover text-muted')}
        >
          <FilterIcon />
          {filterActive && (
            <span className="absolute right-[3px] top-[3px] h-1.5 w-1.5 rounded-full bg-accent" />
          )}
        </button>
      )}
      <button
        title="Search (⌘K)"
        aria-label="Search"
        onClick={() => setSearchOpen(true)}
        className={glyph}
      >
        <SearchIcon />
      </button>
      {connected && (
        <button
          title="Compose (⌘N)"
          aria-label="Compose"
          onClick={() => openCompose()}
          className={glyph}
        >
          <ComposeIcon />
        </button>
      )}

      {filterOpen && (
        <Popover anchorRef={filterRef} onClose={() => setPopover(null)} offset={{ x: 36, y: -28 }}>
          <PopoverLabel>Filter</PopoverLabel>
          <PopoverItem active={!filterActive} onSelect={() => setAccount('all')}>
            <span className="h-2 w-2 shrink-0 rounded-full border border-[#444]" />
            All accounts
            <span className="flex-1" />
            {!filterActive && <span className="text-accent">✓</span>}
          </PopoverItem>
          {accounts.map((a) => (
            <PopoverItem
              key={a.id}
              active={activeAccountId === a.id}
              onSelect={() => setAccount(a.id)}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: a.color }}
              />
              <span className="truncate">{a.name}</span>
              <span className="flex-1" />
              {activeAccountId === a.id && <span className="text-accent">✓</span>}
            </PopoverItem>
          ))}
        </Popover>
      )}
    </div>
  )
}
