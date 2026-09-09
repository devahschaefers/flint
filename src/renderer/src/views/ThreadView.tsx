import { useMemo, useState } from 'react'
import { shortDate } from '../lib/dates'
import { sanitizeMailHtml } from '../lib/sanitizeMail'
import { normalizeSubject } from '../lib/threads'
import { resolveMailbox, resolveNames } from '../lib/identity'
import { useMailQuery } from '../lib/useMailQuery'
import { wireToMessage } from '../lib/wire'
import { isOwnAddress, useAppStore } from '../store'
import { cn } from '../lib/utils'
import Avatar from '../components/ui/Avatar'
import BackLink from '../components/shell/BackLink'
import { Page, TextAction } from '../components/shell/Page'
import SendStatus from '../components/inbox/SendStatus'
import ReplyComposer from '../components/compose/ReplyComposer'
import type { Contact, Message } from '../data/types'
import type { ThreadRef } from '../../../preload/index.d'

interface ThreadViewProps {
  threadRef: ThreadRef
}

/**
 * The message's text/html part. Real synced mail flows through here, so it is
 * always sanitized (scripts, event handlers, forms stripped) and remote images
 * are blocked until the reader opts in for this one message.
 */
function HtmlBody({ html }: { html: string }): React.JSX.Element {
  const [allowRemoteImages, setAllowRemoteImages] = useState(false)
  const sanitized = useMemo(
    () => sanitizeMailHtml(html, { allowRemoteImages }),
    [html, allowRemoteImages]
  )

  return (
    <>
      {sanitized.blockedImages > 0 && (
        <div className="mt-2.5 text-[12px] text-label">
          Images hidden ·{' '}
          <button
            type="button"
            onClick={(e) => {
              // A draft's block opens the composer on click; loading images is not that.
              e.stopPropagation()
              setAllowRemoteImages(true)
            }}
            className="text-accent transition-colors hover:text-accent-light"
          >
            Load images
          </button>
        </div>
      )}
      <div
        className="rt mt-2.5 overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: sanitized.html }}
      />
    </>
  )
}

/** "to you", "to you +2", "to Priya, Jake" */
function recipientsLabel(message: Message, contacts: Contact[]): string {
  const others = message.to.filter((r) => !isOwnAddress(r.address))
  const toMe = others.length < message.to.length
  if (toMe) return others.length > 0 ? `to you +${others.length}` : 'to you'
  if (message.to.length === 0) return 'to (no recipient)'
  return `to ${resolveNames(message.to, contacts)}`
}

interface MessageBlockProps {
  message: Message
  contacts: Contact[]
  first: boolean
  isDraft?: boolean
}

/** One fully-expanded message: avatar, sender, recipients, time, body */
function MessageBlock({ message, contacts, first, isDraft }: MessageBlockProps): React.JSX.Element {
  const resolved = resolveMailbox(message.from, contacts)
  const own = isOwnAddress(message.from.address)
  const ccLabel = message.cc.length > 0 ? `, cc ${resolveNames(message.cc, contacts)}` : ''

  return (
    <div
      className={cn(
        'flex gap-3 select-text',
        first ? 'mt-[22px]' : 'mt-[22px] border-t border-line pt-5'
      )}
    >
      <Avatar initials={resolved.initials} color={own ? '#2f2f2f' : resolved.color} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
            {own ? 'You' : resolved.name}{' '}
            <span className="text-[12px] font-normal text-label" title={message.from.address}>
              {recipientsLabel(message, contacts)}
              {ccLabel}
            </span>
            {isDraft && <span className="ml-2 text-[11px] font-normal text-warn">Draft</span>}
            <SendStatus
              state={message.state}
              sendError={message.sendError}
              message={message}
              className="ml-2 align-baseline font-normal"
            />
          </span>
          <span className="shrink-0 text-[12px] text-label">{shortDate(message.date)}</span>
        </div>
        {message.bodyHtml ? (
          <HtmlBody html={message.bodyHtml} />
        ) : (
          <div className="rt mt-2.5">
            {message.body.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface CollapsedMessageProps {
  message: Message
  contacts: Contact[]
  onExpand: () => void
}

/** Older messages fold to one clickable line: sender + first body line */
function CollapsedMessage({
  message,
  contacts,
  onExpand
}: CollapsedMessageProps): React.JSX.Element {
  const resolved = resolveMailbox(message.from, contacts)
  const own = isOwnAddress(message.from.address)

  return (
    <button
      onClick={onExpand}
      className="-mx-3 mt-3 flex w-[calc(100%+24px)] min-w-0 items-center gap-3 rounded-[8px] px-3 py-1.5 text-left text-[13px] text-label transition-colors hover:bg-row hover:text-body"
    >
      <Avatar
        initials={resolved.initials}
        color={own ? '#2f2f2f' : resolved.color}
        size={28}
        className="opacity-60"
      />
      <span className="shrink-0 font-semibold">{own ? 'You' : resolved.name}</span>
      <span className="min-w-0 flex-1 truncate">{message.body[0] ?? ''}</span>
      <span className="shrink-0 text-[12px]">{shortDate(message.date)}</span>
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
  const done = useAppStore((s) => s.done)
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
      <Page tight>
        <BackLink />
      </Page>
    )
  }

  const latest = messages[messages.length - 1]
  const subject = normalizeSubject(messages[0].subject) || '(no subject)'
  const flagged = messages.some((m) => m.flags.flagged)
  const inInbox = messages.some((m) => m.folder === 'inbox')

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
  const replyLabel = replyName ? `Reply to ${replyName}…` : 'Reply…'

  const expandMessage = (messageId: string): void => {
    setExpandedIds((prev) => new Set([...prev, messageId]))
  }

  return (
    <Page tight>
      <div className="no-drag flex items-baseline">
        <BackLink />
        <span className="flex-1" />
        <span className="flex gap-1">
          {inInbox && (
            <TextAction
              className="hover:text-accent"
              onClick={() => {
                done(threadRef)
                back()
              }}
            >
              Done
            </TextAction>
          )}
          <TextAction
            className="hover:text-accent"
            onClick={() => threadAction(threadRef, 'toggleFlagged')}
          >
            {flagged ? 'Unpin' : 'Pin'}
          </TextAction>
        </span>
      </div>

      <h1 className="mt-[18px] select-text text-[20px] font-semibold leading-[1.3] text-ink">
        {subject}
      </h1>

      {messages.map((message, i) => {
        const alwaysExpanded = messages.length <= 2 || i >= messages.length - 2
        const expanded = alwaysExpanded || expandedIds.has(message.messageId)
        const isDraft = message.folder === 'drafts'
        if (!expanded) {
          return (
            <CollapsedMessage
              key={message.messageId}
              message={message}
              contacts={contacts}
              onExpand={() => expandMessage(message.messageId)}
            />
          )
        }
        if (isDraft) {
          // An unsent draft opens in the composer instead of reading as sent mail
          return (
            <div
              key={message.messageId}
              role="button"
              title="Edit draft"
              onClick={() => openCompose(message)}
              className="-mx-3 cursor-pointer rounded-[10px] px-3 pb-2 transition-colors hover:bg-row"
            >
              <MessageBlock message={message} contacts={contacts} first={i === 0} isDraft />
            </div>
          )
        }
        return (
          <MessageBlock
            key={message.messageId}
            message={message}
            contacts={contacts}
            first={i === 0}
          />
        )
      })}

      <ReplyComposer thread={messages} replyLabel={replyLabel} />
    </Page>
  )
}
