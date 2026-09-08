import { AlertCircle, Loader2 } from 'lucide-react'
import type { Message } from '../../data/types'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'

/** Compact lifecycle label for a message that hasn't reached Gmail (or failed to) */
function sendStatusLabel(m: Message): string | null {
  switch (m.state) {
    case 'failed':
      return 'Failed to send'
    case 'queued':
    case 'sending':
      return 'Sending…'
    case 'sent':
    case 'synced':
    case 'draft':
    default:
      return null
  }
}

interface SendStatusProps {
  message: Message
  /** Show Retry / Edit controls (thread view); list rows stay label-only */
  withActions?: boolean
  className?: string
}

/**
 * Inline badge for outgoing mail in flight: queued (undo window), sending, or
 * failed. Failed messages expose their recovery actions here; the rest is
 * informational.
 */
export default function SendStatus({
  message,
  withActions = false,
  className
}: SendStatusProps): React.JSX.Element | null {
  const retrySend = useAppStore((s) => s.retrySend)
  const revertToDraft = useAppStore((s) => s.revertToDraft)
  const openCompose = useAppStore((s) => s.openCompose)

  const label = sendStatusLabel(message)
  if (!label) return null
  const failed = message.state === 'failed'

  const Icon = failed ? AlertCircle : Loader2
  const tone = failed ? 'text-red-3' : 'text-text-muted'

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', tone, className)}
      title={message.sendError ?? undefined}
    >
      <Icon size={11} className={cn(!failed && 'animate-spin')} />
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
              revertToDraft(message.messageId)
              openCompose(message.messageId)
            }}
            className="rounded-[5px] bg-elevation-2 px-1.5 py-[1px] text-text-primary transition-colors hover:bg-elevation-3"
          >
            Edit
          </button>
          {message.sendError && (
            <span className="ml-1 truncate font-normal text-text-muted" title={message.sendError}>
              {message.sendError}
            </span>
          )}
        </>
      )}
    </span>
  )
}
