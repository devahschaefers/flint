import { Check, Search, PenLine } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'

/**
 * The right-side header cluster used on every list view:
 * hide-done toggle, search, compose. All fully wired to the store.
 * `showDoneToggle` hides the done toggle on views where it has no effect (Archive).
 */
export default function HeaderControls({
  showDoneToggle = true
}: {
  showDoneToggle?: boolean
}): React.JSX.Element {
  const hideDone = useAppStore((s) => s.hideDone)
  const toggleHideDone = useAppStore((s) => s.toggleHideDone)
  const setSearchOpen = useAppStore((s) => s.setSearchOpen)
  const openCompose = useAppStore((s) => s.openCompose)

  return (
    <div className="no-drag flex items-center gap-4 text-text-bright">
      {showDoneToggle && (
        <button
          aria-label={hideDone ? 'Show done emails' : 'Hide done emails'}
          title={hideDone ? 'Show done emails' : 'Hide done emails'}
          onClick={toggleHideDone}
          className={cn(
            'relative h-[18px] w-[34px] rounded-full transition-colors duration-150',
            hideDone ? 'bg-elevation-3' : 'bg-blue-4'
          )}
        >
          <span
            className={cn(
              'absolute top-[2px] flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white transition-all duration-150',
              hideDone ? 'left-[2px]' : 'left-[18px]'
            )}
          >
            <Check size={10} strokeWidth={3} className="text-elevation-2" />
          </span>
        </button>
      )}
      <button
        aria-label="Search"
        onClick={() => setSearchOpen(true)}
        className="transition-colors duration-150 hover:text-ink"
      >
        <Search size={19} strokeWidth={1.8} />
      </button>
      <button
        aria-label="Compose"
        onClick={() => openCompose()}
        className="transition-colors duration-150 hover:text-ink"
      >
        <PenLine size={19} strokeWidth={1.8} />
      </button>
    </div>
  )
}
