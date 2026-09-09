import { useAppStore } from '../../store'

/** One toast at a time, bottom center, with an optional Undo — driven by the store */
export default function Toast(): React.JSX.Element | null {
  const toast = useAppStore((s) => s.toast)
  const outbox = useAppStore((s) => s.outbox)
  if (!toast) return null
  // Sit above the outbox banner when both are up
  const lifted = outbox.some((op) => op.kind !== 'send')
  return (
    <div
      className="enter fixed left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-[20px] border border-edge bg-hover-strong py-2 pl-4 pr-3 text-[12.5px] text-strong shadow-[0_6px_20px_rgba(0,0,0,0.5)]"
      style={{ bottom: lifted ? 74 : 26 }}
    >
      {toast.text}
      {toast.undo && (
        <button
          onClick={toast.undo}
          className="-my-[3px] rounded-[6px] px-2 py-[3px] font-semibold text-accent transition-colors hover:bg-[#2f2f2f] hover:text-ink"
        >
          Undo
        </button>
      )}
    </div>
  )
}
