import { cn } from '../../lib/utils'

/** "Today", "Yesterday" — whitespace above does the separating */
export default function SectionLabel({
  label,
  className
}: {
  label: string
  className?: string
}): React.JSX.Element {
  return <div className={cn('mb-1.5 mt-7 text-[11px] text-label', className)}>{label}</div>
}
