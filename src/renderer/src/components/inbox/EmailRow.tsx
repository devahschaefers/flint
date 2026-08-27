import { Check } from 'lucide-react'
import type { Email } from '../../data/types'
import { shortDate } from '../../lib/dates'
import { cn } from '../../lib/utils'

interface EmailRowProps {
  email: Email
  onClick?: () => void
}

export default function EmailRow({ email, onClick }: EmailRowProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="group flex h-[42px] w-full items-center gap-[10px] rounded-[10px] px-[10px] text-left transition-colors hover:bg-elevation-1"
    >
      <span className="flex w-[26px] shrink-0 items-center justify-center">
        {email.read ? (
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px] border-text-muted opacity-0 group-hover:opacity-100">
            <Check size={11} className="text-text-muted" />
          </span>
        ) : (
          <span className="h-2 w-2 rounded-full bg-blue-3" />
        )}
      </span>

      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ backgroundColor: email.sender.color }}
      >
        {email.sender.initials}
      </span>

      <span className="w-[230px] shrink-0 truncate text-[13px] font-semibold text-text-primary">
        {email.sender.name}
      </span>

      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-semibold text-text-primary">{email.subject}</span>
        <span className="font-normal text-text-secondary">{'  ' + email.preview}</span>
      </span>

      <span
        className={cn(
          'shrink-0 text-[12px] tabular-nums',
          email.read ? 'text-text-secondary' : 'text-blue-3'
        )}
      >
        {shortDate(email.date)}
      </span>
    </button>
  )
}
