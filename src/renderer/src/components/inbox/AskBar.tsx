import { Sparkles } from 'lucide-react'

export default function AskBar(): React.JSX.Element {
  return (
    <div
      className="absolute bottom-[17px] right-[17px] h-[42px] w-[240px] rounded-[24px] p-px shadow-[0_4px_15px_rgba(0,0,0,0.1)]"
      style={{ background: 'var(--gradient-border-colors)' }}
    >
      <div className="flex h-full w-full items-center gap-2 rounded-[24px] bg-elevation-0 pl-3">
        <Sparkles size={16} className="text-[#8c8aff]" />
        <span className="text-[13px] text-text-secondary">Ask me anything...</span>
      </div>
    </div>
  )
}
