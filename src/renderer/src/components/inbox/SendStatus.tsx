import { AlertCircle, Clock, Loader2 } from 'lucide-react'
import { isScheduled, type Message } from '../../data/types'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'

function whenLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** Compact lifecycle label for a message that hasn't reached Gmail (or failed to) */
function sendStatusLabel(m: Message): string | null {
  switch (m.state) {
    case 'failed':
      return 'Failed to send'
    case 'sending':
      return 'Sending…'
    case 'queued':
      return isScheduled(m) && m.sendAfter ? `Scheduled · ${whenLabel(m.sendAfter)}` : 'Sending…'
    case 'sent':
    case 'synced':
    case 'draft':
    default:
      return null
  }
}

interface SendStatusProps {
  message: Message
  /** Show Retry / Edit / Cancel controls (thread view); list rows stay label-only */
  withActions?: boolean
  className?: string
}

/**
 * Inline badge for outgoing mail in flight: queued (undo window), scheduled,
 * sending, or failed. Failed and scheduled messages expose their recovery
 * actions here; everything else is informational.
 */
export default function SendStatus({
  message,
  withActions = false,
  className
}: SendStatusProps): React.JSX.Element | null {
  const retrySend = useAppStore((s) => s.retrySend)
  const cancelScheduled = useAppStore((s) => s.cancelScheduled)
  const openCompose = useAppStore((s) => s.openCompose)

  const label = sendStatusLabel(message)
  if (!label) return null
  const failed = message.state === 'failed'
  const scheduled = message.state === 'queued' && isScheduled(message)

  const Icon = failed ? AlertCircle : scheduled ? Clock : Loader2
  const tone = failed ? 'text-red-3' : scheduled ? 'text-yellow-3' : 'text-text-muted'

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', tone, className)}
      title={message.sendError ?? undefined}
    >
      <Icon size={11} className={cn(!failed && !scheduled && 'animate-spin')} />
      {label}
      {withActions && failed && (
        <>
          <button
            onClick={() => retrySend(message.messageId)}
            className="ml-1 rounded-[5px] bg-elevation-2 px-1.5 py-[1px] text-text-primary transition-colors hover:bg-elevation-3"
          >
            Retry
          </button>
          <button
            onClick={() => {
              cancelScheduled(message.messageId)
              openCompose(message.messageId)
            }}
            className="rounded-[5px] bg-elevation-2 px-1.5 py-[1px] text-text-primary transition-colors hover:bg-elevation-3"
          >
            Edit
          </button>
        </>
      )}
      {withActions && scheduled && (
        <button
          onClick={() => cancelScheduled(message.messageId)}
          className="ml-1 rounded-[5px] bg-elevation-2 px-1.5 py-[1px] text-text-primary transition-colors hover:bg-elevation-3"
        >
          Cancel
        </button>
      )}
      {withActions && failed && message.sendError && (
        <span className="ml-1 truncate font-normal text-text-muted" title={message.sendError}>
          {message.sendError}
        </span>
      )}
    </span>
  )
}
