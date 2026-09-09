import { cn } from '../../lib/utils'

interface RowActionProps {
  onClick: () => void
  accent?: boolean
  children: React.ReactNode
}

/** A verb that lives under the cursor: appears on row hover in place of the date */
export default function RowAction({
  onClick,
  accent = false,
  children
}: RowActionProps): React.JSX.Element {
  return (
    <span
      role="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'cursor-pointer rounded-[5px] px-[7px] py-[2px] transition-colors hover:bg-line-strong hover:text-accent',
        accent && 'text-accent'
      )}
    >
      {children}
    </span>
  )
}
