import { cn } from '../../lib/utils'

interface AvatarProps {
  initials: string
  color: string
  /** Diameter in px; the type scales with it */
  size?: number
  className?: string
  title?: string
}

/** Initials disc — the one ornament in the whole language, so it carries a person's color */
export default function Avatar({
  initials,
  color,
  size = 26,
  className,
  title
}: AvatarProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white',
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.37 * 2) / 2,
        backgroundColor: color
      }}
    >
      {initials}
    </span>
  )
}
