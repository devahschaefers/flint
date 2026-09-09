import type { Message, MessageState } from '../../data/types'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import { Spinner } from '../ui/icons'

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

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-[11px]',
        failed ? 'text-danger' : 'text-meta',
        className
      )}
      title={sendError ?? undefined}
    >
      {!failed && <Spinner />}
      {label}
      {message && failed && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation()
              retrySend(message)
            }}
            className="ml-1 rounded-[5px] px-1.5 py-[1px] text-strong transition-colors hover:bg-line-strong hover:text-accent"
          >
            Retry
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              revertToDraft(message)
              openCompose(message)
            }}
            className="rounded-[5px] px-1.5 py-[1px] text-strong transition-colors hover:bg-line-strong hover:text-accent"
          >
            Edit
          </button>
          {sendError && (
            <span className="ml-1 truncate text-label" title={sendError}>
              {sendError}
            </span>
          )}
        </>
      )}
    </span>
  )
}
