import { cn } from '../../lib/utils'

interface DateSectionProps {
  label: string
  className?: string
}

export default function DateSection({ label, className }: DateSectionProps): React.JSX.Element {
  return <div className={cn('text-[13px] text-text-secondary', className)}>{label}</div>
}
