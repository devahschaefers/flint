import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Check, ImageOff, Pin } from 'lucide-react'
import { shortDate } from '../lib/dates'
import { sanitizeMailHtml } from '../lib/sanitizeMail'
import { normalizeSubject } from '../lib/threads'
import { resolveMailbox, resolveNames } from '../lib/identity'
import { useMailQuery } from '../lib/useMailQuery'
import { wireToMessage } from '../lib/wire'
import { isOwnAddress, useAppStore } from '../store'
import { cn } from '../lib/utils'
import HeaderControls from '../components/inbox/HeaderControls'
import SendStatus from '../components/inbox/SendStatus'
import ReplyComposer from '../components/compose/ReplyComposer'
import type { Contact, Message } from '../data/types'
import type { ThreadRef } from '../../../preload/index.d'

interface ThreadViewProps {
  threadRef: ThreadRef
}

interface MessageBlockProps {
  message: Message
  contacts: Contact[]
  isDraft?: boolean
}

interface HtmlBodyProps {
  html: string
}

/**
 * The message's text/html part. Real synced mail flows through here, so it is
 * always sanitized (scripts, event handlers, forms stripped) and remote images
 * are blocked until the reader opts in for this one message.
 */
function HtmlBody({ html }: HtmlBodyProps): React.JSX.Element {
  const [allowRemoteImages, setAllowRemoteImages] = useState(false)
  const sanitized = useMemo(
    () => sanitizeMailHtml(html, { allowRemoteImages }),
    [html, allowRemoteImages]
  )

  return (
    <>
      {sanitized.blockedImages > 0 && (
        <div className="mt-4 flex items-center gap-1.5 text-[12px] text-text-muted">
          <ImageOff size={13} strokeWidth={1.8} />
          <span>Images hidden</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={(e) => {
              // A draft's block opens the composer on click; loading images is not that.
              e.stopPropagation()
              setAllowRemoteImages(true)
            }}
            className="text-blue-3 transition-colors hover:underline"
          >
            Load images
          </button>
        </div>
      )}
      <div
        className="rt mt-4 overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: sanitized.html }}
      />
    </>
  )
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
            <SendStatus
              state={message.state}
              sendError={message.sendError}
              message={message}
              className="ml-2 align-middle"
            />
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

      {message.bodyHtml ? (
        <HtmlBody html={message.bodyHtml} />
      ) : (
        <div className="mt-4">
          {message.body.map((paragraph, i) => (
            <p key={i} className="text-[14px] leading-[1.65] text-[#c6c9cd] mb-4">
              {paragraph}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

interface CollapsedMessageProps {
  message: Message
  contacts: Contact[]
  onExpand: () => void
}

/** Older messages fold to one clickable line: sender name + first body line. */
function CollapsedMessage({
  message,
  contacts,
  onExpand
}: CollapsedMessageProps): React.JSX.Element {
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

/**
 * One conversation, fetched whole from main when opened (bodies included,
 * pulled from Gmail first if they were still missing) and re-fetched on every
 * mail change so replies and state badges stay current.
 */
export default function ThreadView({ threadRef }: ThreadViewProps): React.JSX.Element | null {
  const contacts = useAppStore((s) => s.contacts)
  const back = useAppStore((s) => s.back)
  const threadAction = useAppStore((s) => s.threadAction)
  const openCompose = useAppStore((s) => s.openCompose)

  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())

  const { data } = useMailQuery(
    () => window.api.getThread(threadRef),
    [threadRef.accountId, threadRef.threadKey]
  )
  const messages = useMemo(
    () => (data ?? []).map(wireToMessage).sort((a, b) => a.date.localeCompare(b.date)),
    [data]
  )

  if (messages.length === 0) {
    // Loading, or the conversation vanished (deleted elsewhere) — keep the chrome
    return (
      <div className="relative h-full flex flex-col">
        <div className="drag-region flex items-center justify-between px-[30px] pt-[40px] pb-2">
          <button
            aria-label="Back"
            title="Back"
            onClick={back}
            className="no-drag flex h-[28px] w-[34px] items-center justify-center rounded-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
        </div>
      </div>
    )
  }

  const latest = messages[messages.length - 1]
  const subject = normalizeSubject(messages[0].subject) || '(no subject)'
  const flagged = messages.some((m) => m.flags.flagged)

  /** Reply targets the latest counterpart; on a pure sent thread, its recipients. */
  const counterpart = [...messages].reverse().find((m) => !isOwnAddress(m.from.address))
  // Mirror sendReply's targeting: Reply-To wins over From when the sender set one
  const replyMailbox = counterpart ? (counterpart.replyTo ?? counterpart.from) : latest.to[0]
  const replyName = replyMailbox
    ? (() => {
        const resolved = resolveMailbox(replyMailbox, contacts)
        return resolved.isBareAddress ? resolved.name : resolved.name.split(' ')[0]
      })()
    : null
  const replyLabel = replyName ? `Reply to ${replyName}...` : 'Reply...'

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
              threadAction(threadRef, 'toggleArchive')
              back()
            }}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-r-[8px] bg-elevation-2 text-text-bright transition-colors hover:bg-green-3 hover:text-white"
          >
            <Check size={15} />
          </button>
        </div>

        <div className="no-drag flex items-center gap-4">
          <button
            aria-label={flagged ? 'Unpin' : 'Pin'}
            title={flagged ? 'Unpin' : 'Pin'}
            onClick={() => threadAction(threadRef, 'toggleFlagged')}
            className={cn(
              'transition-colors duration-150',
              flagged ? 'text-yellow-3' : 'text-text-bright hover:text-ink'
            )}
          >
            <Pin size={19} strokeWidth={1.8} fill={flagged ? 'currentColor' : 'none'} />
          </button>
          <HeaderControls />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-[30px] pt-6 pb-28">
          <h1 className="select-text text-[20px] font-semibold leading-snug text-text-primary">
            {subject}
          </h1>

          <div className="mt-5">
            {messages.map((message, i) => {
              const alwaysExpanded = messages.length <= 2 || i >= messages.length - 2
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
                        onClick={() => openCompose(message)}
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
        <ReplyComposer thread={messages} replyLabel={replyLabel} />
      </div>
    </motion.div>
  )
}
