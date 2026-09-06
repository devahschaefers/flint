import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '../../store'

/**
 * Surfaces outbox operations that couldn't reach Gmail. Local state keeps the
 * user's intent (the archive stays archived); this is where they decide to
 * push again or give up and take Gmail's version.
 */
export default function OutboxBanner(): React.JSX.Element | null {
  const outbox = useAppStore((s) => s.outbox)
  const retryOutbox = useAppStore((s) => s.retryOutbox)
  const discardOutbox = useAppStore((s) => s.discardOutbox)

  // Sends have their own inline Retry / Edit on the message; this banner is for label actions and drafts
  const ops = outbox.filter((op) => op.kind !== 'send')
  if (ops.length === 0) return null

  const parked = ops.filter((op) => op.state === 'failed').length
  const retrying = ops.length - parked
  const summary =
    parked > 0
      ? `${parked} ${parked === 1 ? 'change' : 'changes'} couldn't sync to Gmail`
      : `${retrying} ${retrying === 1 ? 'change' : 'changes'} waiting to sync`
  const detail = ops.find((op) => op.lastError)?.lastError ?? undefined

  return (
    <div
      className="absolute bottom-4 left-1/2 z-[50] flex -translate-x-1/2 items-center gap-3 rounded-[12px] border border-white/10 bg-elevation-2 py-2 pl-3.5 pr-2.5 text-[12.5px] text-text-primary shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
      title={detail}
    >
      <AlertTriangle size={14} className={parked > 0 ? 'text-red-3' : 'text-yellow-3'} />
      <span>{summary}</span>
      <button
        onClick={retryOutbox}
        className="rounded-[7px] bg-blue-4 px-2.5 py-[3px] text-[12px] font-semibold text-white transition-colors hover:bg-blue-3"
      >
        Retry
      </button>
      <button
        onClick={discardOutbox}
        title="Drop these changes and show what Gmail has"
        className="px-1.5 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
      >
        Discard
      </button>
    </div>
  )
}
