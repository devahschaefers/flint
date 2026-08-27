import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Check, Pin } from 'lucide-react'
import { shortDate } from '../lib/dates'
import { useAppStore } from '../store'
import { cn } from '../lib/utils'
import HeaderControls from '../components/inbox/HeaderControls'

interface EmailViewProps {
  emailId: string
}

export default function EmailView({ emailId }: EmailViewProps): React.JSX.Element | null {
  const emails = useAppStore((s) => s.emails)
  const back = useAppStore((s) => s.back)
  const toggleDone = useAppStore((s) => s.toggleDone)
  const togglePin = useAppStore((s) => s.togglePin)
  const sendReply = useAppStore((s) => s.sendReply)
  const openCompose = useAppStore((s) => s.openCompose)

  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')

  const email = emails.find((e) => e.id === emailId)
  const isDraft = email?.folder === 'drafts'

  /** Drafts always edit in the composer, never in the reading view */
  useEffect(() => {
    if (isDraft) {
      openCompose(emailId)
      back()
    }
  }, [isDraft, emailId, openCompose, back])

  if (!email || isDraft) return null

  const firstName = email.sender.name.split(' ')[0]
  /** For sent mail the contact on the email is the recipient, not the author */
  const outgoing = email.folder === 'sent'

  const canSend = replyText.trim().length > 0

  const handleSend = (): void => {
    if (!canSend) return
    sendReply(emailId, replyText)
    setReplyText('')
    setReplyOpen(false)
  }

  const handleCancel = (): void => {
    setReplyText('')
    setReplyOpen(false)
  }

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
            title="Back"
            onClick={back}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-l-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="h-[28px] w-px bg-transparent" />
          <button
            aria-label={email.done ? 'Mark not done' : 'Done'}
            title={email.done ? 'Mark not done' : 'Done'}
            onClick={() => {
              toggleDone(emailId)
              back()
            }}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-r-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <Check size={15} />
          </button>
        </div>

        <div className="no-drag flex items-center gap-4">
          <button
            aria-label={email.pinned ? 'Unpin' : 'Pin'}
            title={email.pinned ? 'Unpin' : 'Pin'}
            onClick={() => togglePin(emailId)}
            className={cn(
              'transition-colors duration-150',
              email.pinned ? 'text-yellow-3' : 'text-text-bright hover:text-ink'
            )}
          >
            <Pin size={19} strokeWidth={1.8} fill={email.pinned ? 'currentColor' : 'none'} />
          </button>
          <HeaderControls />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="select-text mx-auto w-full max-w-[860px] px-[30px] pt-6 pb-28">
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

          {email.replies.map((reply, i) => (
            <div key={i}>
              <div className="border-t border-white/5 my-5" />
              <div className="text-[12px] text-text-secondary mb-2">
                You · {shortDate(reply.date)}
              </div>
              {reply.body.map((paragraph, j) => (
                <p key={j} className="text-[14px] leading-[1.65] text-[#c6c9cd] mb-4">
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="absolute bottom-[22px] left-1/2 w-[calc(100%-60px)] max-w-[860px] -translate-x-1/2">
        {replyOpen ? (
          <div className="rounded-[14px] border border-white/10 bg-elevation-1 p-3 shadow-[0_4px_15px_rgba(0,0,0,0.25)]">
            <textarea
              autoFocus
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  handleSend()
                }
              }}
              placeholder={`Reply to ${firstName}...`}
              className="select-text min-h-[96px] w-full resize-none bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-secondary"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={handleCancel}
                className="h-7 rounded-[7px] px-3 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={cn(
                  'h-7 rounded-[7px] bg-blue-4 px-4 text-[12px] font-semibold text-white transition-colors hover:bg-blue-3',
                  !canSend && 'cursor-default opacity-40 hover:bg-blue-4'
                )}
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setReplyOpen(true)}
            className="flex h-[44px] w-full items-center rounded-[22px] border border-white/10 bg-elevation-1 px-4 text-[13px] text-text-secondary shadow-[0_4px_15px_rgba(0,0,0,0.25)] transition-colors hover:bg-elevation-2"
          >
            {`Reply to ${firstName}...`}
          </button>
        )}
      </div>
    </motion.div>
  )
}
