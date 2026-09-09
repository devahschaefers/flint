import { useAppStore } from '../../store'
import { cn } from '../../lib/utils'

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
      className="enter fixed bottom-[26px] left-1/2 z-[50] flex -translate-x-1/2 items-center gap-3 rounded-[20px] border border-edge bg-hover-strong py-2 pl-4 pr-3 text-[12.5px] text-strong shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
      title={detail}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', parked > 0 ? 'bg-danger' : 'bg-warn')} />
      <span>{summary}</span>
      <button
        onClick={retryOutbox}
        className="-my-[3px] rounded-[6px] px-2 py-[3px] font-semibold text-accent transition-colors hover:bg-[#2f2f2f] hover:text-ink"
      >
        Retry
      </button>
      <button
        onClick={discardOutbox}
        title="Drop these changes and show what Gmail has"
        className="-my-[3px] rounded-[6px] px-2 py-[3px] text-quiet transition-colors hover:bg-[#2f2f2f] hover:text-strong"
      >
        Discard
      </button>
    </div>
  )
}
