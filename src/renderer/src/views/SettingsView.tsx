import { motion } from 'motion/react'
import { ArrowLeft, Check } from 'lucide-react'
import { accounts } from '../data/mock'
import { useAppStore } from '../store'
import { cn } from '../lib/utils'

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

interface SectionProps {
  label: string
  children: React.ReactNode
}

function Section({ label, children }: SectionProps): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="rounded-[12px] bg-elevation-1 border border-white/5 divide-y divide-white/5">
        {children}
      </div>
    </div>
  )
}

export default function SettingsView(): React.JSX.Element {
  const back = useAppStore((s) => s.back)
  const hideDone = useAppStore((s) => s.hideDone)
  const toggleHideDone = useAppStore((s) => s.toggleHideDone)
  const signature = useAppStore((s) => s.signature)
  const setSignature = useAppStore((s) => s.setSignature)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative h-full flex flex-col"
    >
      <div className="drag-region flex items-center px-[30px] pt-[40px] pb-2">
        <div className="no-drag flex items-center">
          <button
            aria-label="Back"
            onClick={back}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="ml-3.5 text-[15px] font-semibold text-text-primary">Settings</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-[30px] pb-10">
        <div className="flex max-w-[640px] flex-col gap-8 pt-4">
          <Section label="Accounts">
            {accounts.map((account) => (
              <div key={account.id} className="flex h-12 items-center gap-3 px-4">
                <span
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  style={{ backgroundColor: account.color }}
                >
                  {initialsOf(account.name)}
                </span>
                <span className="text-[13px] text-text-primary">{account.name}</span>
                <span className="ml-auto text-[12px] text-text-secondary">{account.email}</span>
              </div>
            ))}
          </Section>

          <Section label="Preferences">
            <div className="flex h-12 items-center px-4">
              <span className="text-[13px] text-text-primary">Hide done emails</span>
              <button
                aria-label={hideDone ? 'Show done emails' : 'Hide done emails'}
                onClick={toggleHideDone}
                className={cn(
                  'relative ml-auto h-[18px] w-[34px] rounded-full transition-colors duration-150',
                  hideDone ? 'bg-blue-4' : 'bg-elevation-3'
                )}
              >
                <span
                  className={cn(
                    'absolute top-[2px] flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white transition-all duration-150',
                    hideDone ? 'left-[18px]' : 'left-[2px]'
                  )}
                >
                  <Check size={10} strokeWidth={3} className="text-elevation-2" />
                </span>
              </button>
            </div>
            <div className="flex flex-col items-start px-4 py-3">
              <span className="text-[13px] text-text-primary">Signature</span>
              <textarea
                aria-label="Signature"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                className="select-text mt-2 min-h-[64px] w-full resize-none rounded-[8px] border border-white/10 bg-elevation-0 p-2.5 text-[13px] text-text-primary outline-none"
              />
            </div>
          </Section>

          <Section label="About">
            <div className="flex h-12 items-center px-4 text-[12px] text-text-secondary">
              Spark clone · v0.1.0 · mock data
            </div>
          </Section>
        </div>
      </div>
    </motion.div>
  )
}
