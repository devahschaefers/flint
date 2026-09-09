import { AlertCircle, Loader2 } from 'lucide-react'
import type { Message, MessageState } from '../../data/types'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'

/** Compact lifecycle label for a message that hasn't reached Gmail (or failed to) */
function sendStatusLabel(state: MessageState): string | null {
  switch (state) {
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
  state: MessageState
  sendError?: string | null
  /** The message itself, when Retry / Edit controls should be offered (thread view) */
  message?: Message
  className?: string
}

/**
 * Inline badge for outgoing mail in flight: queued (undo window), sending, or
 * failed. Failed messages expose their recovery actions when the full message
 * is at hand; list rows pass state only and stay label-only.
 */
export default function SendStatus({
  state,
  sendError,
  message,
  className
}: SendStatusProps): React.JSX.Element | null {
  const retrySend = useAppStore((s) => s.retrySend)
  const revertToDraft = useAppStore((s) => s.revertToDraft)
  const openCompose = useAppStore((s) => s.openCompose)

  const label = sendStatusLabel(state)
  if (!label) return null
  const failed = state === 'failed'

  const Icon = failed ? AlertCircle : Loader2
  const tone = failed ? 'text-red-3' : 'text-text-muted'

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold', tone, className)}
      title={sendError ?? undefined}
    >
      <Icon size={11} className={cn(!failed && 'animate-spin')} />
      {label}
      {message && failed && (
        <>
          <button
            onClick={() => retrySend(message)}
            className="ml-1 rounded-[5px] bg-elevation-2 px-1.5 py-[1px] text-text-primary transition-colors hover:bg-elevation-3"
          >
            Retry
          </button>
          <button
            onClick={() => {
              revertToDraft(message)
              openCompose(message)
            }}
            className="rounded-[5px] bg-elevation-2 px-1.5 py-[1px] text-text-primary transition-colors hover:bg-elevation-3"
          >
            Edit
          </button>
          {sendError && (
            <span className="ml-1 truncate font-normal text-text-muted" title={sendError}>
              {sendError}
            </span>
          )}
        </>
      )}
    </span>
  )
}
