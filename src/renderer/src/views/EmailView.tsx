import { motion } from 'motion/react'
import { ArrowLeft, Check, PenLine, Search } from 'lucide-react'
import { shortDate } from '../lib/dates'
import { useAppStore } from '../store'

interface EmailViewProps {
  emailId: string
}

export default function EmailView({ emailId }: EmailViewProps): React.JSX.Element | null {
  const emails = useAppStore((s) => s.emails)
  const back = useAppStore((s) => s.back)

  const email = emails.find((e) => e.id === emailId)
  if (!email) return null

  const firstName = email.sender.name.split(' ')[0]
  /** For sent/drafts the contact on the email is the recipient, not the author */
  const outgoing = email.folder === 'sent' || email.folder === 'drafts'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative h-full flex flex-col"
    >
      <div className="drag-region flex items-center justify-between px-[30px] pt-[40px] pb-2">
        <div className="no-drag flex items-center">
          <button
            aria-label="Back"
            onClick={back}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-l-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="h-[28px] w-px bg-transparent" />
          <button
            aria-label="Mark done"
            className="flex h-[28px] w-[34px] items-center justify-center rounded-r-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <Check size={15} />
          </button>
        </div>

        <div className="no-drag flex items-center gap-4 text-text-bright">
          <button
            aria-label="Hide done emails"
            className="flex h-[18px] w-[34px] items-center rounded-full bg-elevation-3 px-[2px]"
          >
            <span className="flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white">
              <Check size={9} strokeWidth={3.5} className="text-elevation-0" />
            </span>
          </button>
          <button aria-label="Search" className="transition-colors hover:text-ink">
            <Search size={19} />
          </button>
          <button aria-label="Compose" className="transition-colors hover:text-ink">
            <PenLine size={19} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-[30px] pt-6 pb-28">
          <h1 className="text-[20px] font-semibold leading-snug text-text-primary">
            {email.subject}
          </h1>

          <div className="mt-5 flex items-center gap-3">
            <span
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
              style={{ backgroundColor: email.sender.color }}
            >
              {email.sender.initials}
            </span>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold text-text-primary">
                {outgoing ? `To ${email.sender.name}` : email.sender.name}
              </span>
              <span className="text-[12px] text-text-secondary">{email.sender.email}</span>
            </div>
            <span className="ml-auto text-[12px] text-text-secondary">
              {shortDate(email.date)}
            </span>
          </div>

          <div className="my-5 border-b border-white/5" />

          {email.body.map((paragraph, i) => (
            <p key={i} className="text-[14px] leading-[1.65] text-[#c6c9cd] mb-4">
              {paragraph}
            </p>
          ))}
        </div>
      </div>

      <div className="absolute bottom-[22px] left-1/2 w-[calc(100%-60px)] max-w-[860px] -translate-x-1/2">
        <div className="flex h-[44px] items-center rounded-[22px] border border-white/10 bg-elevation-1 px-4 text-[13px] text-text-secondary shadow-[0_4px_15px_rgba(0,0,0,0.25)]">
          {email.folder === 'drafts' ? 'Continue draft...' : `Reply to ${firstName}...`}
        </div>
      </div>
    </motion.div>
  )
}
