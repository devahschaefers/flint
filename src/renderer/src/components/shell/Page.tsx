import { cn } from '../../lib/utils'

interface PageProps {
  /** Thread/settings pages sit a little higher and end sooner */
  tight?: boolean
  children: React.ReactNode
}

/** The one layout: a scrolling column with generous side margins and no chrome */
export function Page({ tight = false, children }: PageProps): React.JSX.Element {
  return (
    <div className="enter-fade h-full overflow-y-auto">
      <div className={cn('px-[9%]', tight ? 'pb-12 pt-[26px]' : 'pb-[60px] pt-8')}>{children}</div>
    </div>
  )
}

/** Quiet centered notice for lists with nothing in them */
export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="py-[60px] text-center text-[13px] text-label">{children}</div>
}

/** Small text action ("Mark all done", "Done", "Pin") */
export function TextAction({
  onClick,
  children,
  className
}: {
  onClick: () => void
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'whitespace-nowrap rounded-[6px] px-2 py-1 text-[12px] text-label transition-colors hover:bg-hover hover:text-body',
        className
      )}
    >
      {children}
    </button>
  )
}
