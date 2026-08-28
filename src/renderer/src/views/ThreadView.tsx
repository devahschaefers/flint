import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Check, Pin } from 'lucide-react'
import { shortDate } from '../lib/dates'
import { buildThreads } from '../lib/threads'
import { resolveMailbox, resolveNames } from '../lib/identity'
import { isOwnAddress, useAppStore } from '../store'
import { cn } from '../lib/utils'
import HeaderControls from '../components/inbox/HeaderControls'
import type { Contact, Message } from '../data/types'

interface ThreadViewProps {
  threadId: string
}

interface MessageBlockProps {
  message: Message
  contacts: Contact[]
  isDraft?: boolean
}

/** One fully-expanded message: sender card, recipients line, body paragraphs. */
function MessageBlock({ message, contacts, isDraft }: MessageBlockProps): React.JSX.Element {
  const resolved = resolveMailbox(message.from, contacts)
  const own = isOwnAddress(message.from.address)

  return (
    <div className="select-text">
      <div className="flex items-center gap-3">
        <span
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
          style={{ backgroundColor: resolved.color }}
        >
          {resolved.initials}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold text-text-primary">
            {own ? 'You' : resolved.name}
            {isDraft && <span className="ml-2 text-[11px] font-semibold text-red-3">Draft</span>}
          </span>
          <span className="truncate text-[12px] text-text-secondary">{message.from.address}</span>
          <span className="truncate text-[11px] text-text-muted">
            to {message.to.length > 0 ? resolveNames(message.to, contacts) : '(no recipient)'}
          </span>
          {message.cc.length > 0 && (
            <span className="truncate text-[11px] text-text-muted">
              cc {resolveNames(message.cc, contacts)}
            </span>
          )}
        </div>
        <span className="ml-auto shrink-0 self-start pt-0.5 text-[12px] text-text-secondary">
          {shortDate(message.date)}
        </span>
      </div>

      <div className="mt-4">
        {message.body.map((paragraph, i) => (
          <p key={i} className="text-[14px] leading-[1.65] text-[#c6c9cd] mb-4">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  )
}

interface CollapsedMessageProps {
  message: Message
  contacts: Contact[]
  onExpand: () => void
}

/** Older messages fold to one clickable line: sender name + first body line. */
function CollapsedMessage({ message, contacts, onExpand }: CollapsedMessageProps): React.JSX.Element {
  const resolved = resolveMailbox(message.from, contacts)
  const name = isOwnAddress(message.from.address) ? 'You' : resolved.name

  return (
    <button
      onClick={onExpand}
      className="flex w-full min-w-0 items-baseline gap-2.5 py-1 text-left text-[13px] text-text-secondary transition-colors hover:text-text-bright"
    >
      <span className="shrink-0 font-semibold">{name}</span>
      <span className="min-w-0 flex-1 truncate">{message.body[0] ?? ''}</span>
      <span className="shrink-0 text-[12px] tabular-nums">{shortDate(message.date)}</span>
    </button>
  )
}

export default function ThreadView({ threadId }: ThreadViewProps): React.JSX.Element | null {
  const messages = useAppStore((s) => s.messages)
  const contacts = useAppStore((s) => s.contacts)
  const back = useAppStore((s) => s.back)
  const toggleArchiveThread = useAppStore((s) => s.toggleArchiveThread)
  const toggleFlagged = useAppStore((s) => s.toggleFlagged)
  const sendReply = useAppStore((s) => s.sendReply)
  const openCompose = useAppStore((s) => s.openCompose)

  const [replyOpen, setReplyOpen] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())

  const thread = useMemo(
    () => buildThreads(messages).find((t) => t.id === threadId),
    [messages, threadId]
  )

  if (!thread) return null

  /** Reply targets the latest counterpart; on a pure sent thread, its recipients. */
  const counterpart = [...thread.messages].reverse().find((m) => !isOwnAddress(m.from.address))
  // Mirror sendReply's targeting: Reply-To wins over From when the sender set one
  const replyMailbox = counterpart ? (counterpart.replyTo ?? counterpart.from) : thread.latest.to[0]
  const replyName = replyMailbox
    ? (() => {
        const resolved = resolveMailbox(replyMailbox, contacts)
        return resolved.isBareAddress ? resolved.name : resolved.name.split(' ')[0]
      })()
    : null
  const replyLabel = replyName ? `Reply to ${replyName}...` : 'Reply...'

  const canSend = replyText.trim().length > 0

  const handleSend = (): void => {
    if (!canSend) return
    sendReply(threadId, replyText)
    setReplyText('')
    setReplyOpen(false)
  }

  const handleCancel = (): void => {
    setReplyText('')
    setReplyOpen(false)
  }

  const expandMessage = (messageId: string): void => {
    setExpandedIds((prev) => new Set([...prev, messageId]))
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
            aria-label="Done"
            title="Done"
            onClick={() => {
              toggleArchiveThread(threadId)
              back()
            }}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-r-[8px] bg-elevation-2 text-text-bright transition-colors hover:bg-green-3 hover:text-white"
          >
            <Check size={15} />
          </button>
        </div>

        <div className="no-drag flex items-center gap-4">
          <button
            aria-label={thread.flagged ? 'Unpin' : 'Pin'}
            title={thread.flagged ? 'Unpin' : 'Pin'}
            onClick={() => toggleFlagged(threadId)}
            className={cn(
              'transition-colors duration-150',
              thread.flagged ? 'text-yellow-3' : 'text-text-bright hover:text-ink'
            )}
          >
            <Pin size={19} strokeWidth={1.8} fill={thread.flagged ? 'currentColor' : 'none'} />
          </button>
          <HeaderControls />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-[30px] pt-6 pb-28">
          <h1 className="select-text text-[20px] font-semibold leading-snug text-text-primary">
            {thread.subject}
          </h1>

          <div className="mt-5">
            {thread.messages.map((message, i) => {
              const alwaysExpanded =
                thread.messages.length <= 2 || i >= thread.messages.length - 2
              const expanded = alwaysExpanded || expandedIds.has(message.messageId)
              const isDraft = message.folder === 'drafts'
              return (
                <div key={message.messageId}>
                  {i > 0 && <div className="my-5 border-t border-white/5" />}
                  {expanded ? (
                    isDraft ? (
                      // An unsent draft opens in the composer instead of reading as sent mail
                      <div
                        role="button"
                        title="Edit draft"
                        onClick={() => openCompose(message.messageId)}
                        className="-mx-3 cursor-pointer rounded-[10px] px-3 py-2 transition-colors hover:bg-elevation-1"
                      >
                        <MessageBlock message={message} contacts={contacts} isDraft />
                      </div>
                    ) : (
                      <MessageBlock message={message} contacts={contacts} />
                    )
                  ) : (
                    <CollapsedMessage
                      message={message}
                      contacts={contacts}
                      onExpand={() => expandMessage(message.messageId)}
                    />
                  )}
                </div>
              )
            })}
          </div>
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
              placeholder={replyLabel}
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
            {replyLabel}
          </button>
        )}
      </div>
    </motion.div>
  )
}
