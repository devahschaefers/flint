import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

/**
 * The floating panels the chrome summons on demand (the header menu, the
 * account filter). Rendered into body at fixed coordinates next to the
 * anchor, over a transparent backdrop that closes them on any outside click.
 */

interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  /** Offset from the anchor's bottom-left corner */
  offset?: { x: number; y: number }
  width?: number
  children: React.ReactNode
}

export function Popover({
  anchorRef,
  onClose,
  offset = { x: 0, y: 8 },
  width = 220,
  children
}: PopoverProps): React.JSX.Element {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.min(rect.left + offset.x, window.innerWidth - width - 12)
    setPos({ top: rect.bottom + offset.y, left: Math.max(12, left) })
  }, [anchorRef, offset.x, offset.y, width])

  return createPortal(
    <>
      <div className="fixed inset-0 z-[40]" onClick={onClose} />
      {pos && (
        <div
          role="menu"
          className="enter fixed z-[41] rounded-[10px] border border-edge bg-popover py-2 text-[13px] shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
          style={{ top: pos.top, left: pos.left, width }}
        >
          {children}
        </div>
      )}
    </>,
    document.body
  )
}

export function PopoverLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-4 pb-2 pt-1 text-[10px] tracking-[0.14em] text-hint uppercase">
      {children}
    </div>
  )
}

interface PopoverItemProps {
  onSelect: () => void
  active?: boolean
  className?: string
  children: React.ReactNode
}

export function PopoverItem({
  onSelect,
  active = false,
  className,
  children
}: PopoverItemProps): React.JSX.Element {
  return (
    <div
      role="menuitem"
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-[9px] px-4 py-1.5 transition-colors hover:bg-hover-strong hover:text-ink',
        active ? 'text-ink' : 'text-muted',
        className
      )}
    >
      {children}
    </div>
  )
}

export function PopoverDivider(): React.JSX.Element {
  return <div className="my-2 h-px bg-line" />
}
