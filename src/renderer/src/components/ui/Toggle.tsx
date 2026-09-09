import { cn } from '../../lib/utils'

interface ToggleProps {
  on: boolean
  onToggle: () => void
  label: string
}

/** 32×18 switch: accent when on, dark when off */
export default function Toggle({ on, onToggle, label }: ToggleProps): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        'relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors duration-150',
        on ? 'bg-accent' : 'bg-off'
      )}
    >
      <span
        className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-[left] duration-150"
        style={{ left: on ? 16 : 2 }}
      />
    </button>
  )
}
