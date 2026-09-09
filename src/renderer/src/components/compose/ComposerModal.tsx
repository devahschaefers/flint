import { useEffect, useMemo, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import { formatAddressList, parseAddressList } from '../../lib/address'
import { resolveMailbox } from '../../lib/identity'
import { useLatest } from '../../lib/useLatest'
import { useAppStore } from '../../store'
import { paragraphsToHtml, useComposeEditor } from './composeEditor'
import { RichEditorContent } from './RichEditor'
import Toolbar from './Toolbar'
import Avatar from '../ui/Avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/** New Message: a full screen with one card, opened from the strip (⌘N), a draft, or search. Store-driven. */
export default function ComposerModal(): React.JSX.Element | null {
  const composer = useAppStore((s) => s.composer)
  if (!composer.open) return null
  // The panel holds the fields and the editor and is keyed by the draft, so each
  // open (or switch to another draft) mounts fresh: prefilled from that draft, or
  // empty for a new message. Closing unmounts it, so nothing carries over.
  return <ComposerPanel key={composer.draftId ?? 'new'} draftId={composer.draftId} />
}

interface InitialFields {
  to: string
  subject: string
  /** Draft body to load into the editor; null for a new, empty message */
  html: string | null
  accountId: string
}

/** Fields for a freshly opened composer, read once from the store at mount */
function initialFields(draftId: string | null): InitialFields {
  const { composer, activeAccountId, accounts } = useAppStore.getState()
  // The opener loaded the draft being edited into the store alongside its id
  const editing = draftId && composer.draftId === draftId ? composer.draft : null
  if (editing) {
    return {
      to: formatAddressList(editing.to),
      subject: editing.subject,
      html: editing.bodyHtml ?? paragraphsToHtml(editing.body),
      accountId: editing.accountId
    }
  }
  return {
    to: composer.prefill?.to ?? '',
    subject: '',
    html: null,
    accountId: activeAccountId !== 'all' ? activeAccountId : (accounts[0]?.id ?? '')
  }
}

const field =
  'select-text block h-10 w-full bg-transparent text-[13px] text-strong outline-none placeholder:text-label'

function ComposerPanel({ draftId }: { draftId: string | null }): React.JSX.Element | null {
  const sendMessage = useAppStore((s) => s.sendMessage)
  const saveDraft = useAppStore((s) => s.saveDraft)
  const deleteDraft = useAppStore((s) => s.deleteDraft)
  const closeCompose = useAppStore((s) => s.closeCompose)
  const contacts = useAppStore((s) => s.contacts)
  const accounts = useAppStore((s) => s.accounts)
  const draft = useAppStore((s) => (draftId ? s.composer.draft : null))

  const [initial] = useState(() => initialFields(draftId))
  const [to, setTo] = useState(initial.to)
  const [subject, setSubject] = useState(initial.subject)
  const [accountId, setAccountId] = useState(initial.accountId)

  const editor = useComposeEditor({
    placeholder: 'Write something...',
    onSend: () => handleSendRef.current()
  })
  const bodyText = useEditorState({ editor, selector: (ctx) => ctx.editor?.getText() ?? '' })

  // The editor is outside React: load the draft body once the instance exists
  useEffect(() => {
    if (editor && initial.html !== null) editor.commands.setContent(initial.html)
  }, [editor, initial.html])

  // Live parse of the raw RFC 5322 To text — resolved chips preview the recipients
  const recipients = useMemo(() => parseAddressList(to), [to])

  const body = bodyText ?? ''
  const hasContent = to.trim() !== '' || subject.trim() !== '' || body.trim() !== ''
  /** Sending requires at least one parseable recipient; drafts don't. */
  const canSend = hasContent && recipients.length > 0

  const richInput = (): { body: string; html?: string } => ({
    body: editor?.getText() ?? '',
    html: editor && editor.getText().trim() ? editor.getHTML() : undefined
  })

  const handleClose = (): void => {
    if (hasContent) {
      saveDraft({ to, subject, ...richInput(), accountId, draftId })
    } else {
      // Closing a draft after clearing every field deletes it, like real clients
      if (draft) deleteDraft(draft)
      closeCompose()
    }
  }
  // The window listener below is attached once; the ref keeps it on the latest closure
  const handleCloseRef = useLatest(handleClose)

  // Escape saves-or-closes exactly like the ✕ button. App.tsx's Escape chain
  // defers to this listener while the composer is open (and preventDefaults
  // when a higher layer like search consumed the key, which skips this handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      handleCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [handleCloseRef])

  const handleSend = (): void => {
    if (!canSend) return
    sendMessage({ to, subject, ...richInput(), accountId, draftId })
  }
  // Same for the editor's ⌘↵ keymap, which TipTap captures at editor creation
  const handleSendRef = useLatest(handleSend)

  const fromAccount = accounts.find((a) => a.id === accountId) ?? accounts[0]
  // No connected account: nothing to compose from
  if (!fromAccount) return null

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
  }

  const fromLabel = (
    <>
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: fromAccount.color }}
      />
      <span className="truncate">{fromAccount.identity.name ?? fromAccount.name}</span>
      <span className="truncate text-label">· {fromAccount.identity.address}</span>
    </>
  )

  return (
    <div className="enter-fade fixed inset-0 z-[60] flex flex-col items-center bg-bg pb-5 pt-7">
      <div
        onKeyDown={handleKeyDown}
        className="relative flex min-h-0 w-[720px] max-w-[92%] flex-1 flex-col rounded-[14px] border border-edge bg-panel shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
      >
        <div className="flex shrink-0 items-center justify-between px-4 pb-1.5 pt-3.5">
          <span className="truncate text-[13px] font-semibold text-ink">
            {draft ? draft.subject : 'New Message'}
          </span>
          <button
            aria-label="Close"
            title="Close (esc)"
            onClick={handleClose}
            className="text-[13px] text-quiet transition-colors hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4 text-[13px]">
          <span className="text-label">From</span>
          {draft?.inReplyTo || accounts.length < 2 ? (
            // A reply draft stays on the account that owns its thread — switching
            // accounts would split the conversation across account filters.
            <div className="flex min-w-0 items-center gap-2 text-strong">{fromLabel}</div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex min-w-0 items-center gap-2 text-strong outline-none">
                  {fromLabel}
                  <span className="text-[11px] text-label">▾</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {accounts.map((account) => (
                  <DropdownMenuItem key={account.id} onSelect={() => setAccountId(account.id)}>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: account.color }}
                    />
                    <span className="truncate">{account.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="shrink-0 border-b border-line px-4">
          <input
            autoFocus={!initial.to}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To"
            className={field}
          />
          {recipients.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2.5">
              {recipients.map((mailbox, i) => {
                const identity = resolveMailbox(mailbox, contacts)
                return (
                  <span
                    key={`${mailbox.address}-${i}`}
                    title={mailbox.address}
                    className="flex items-center gap-1.5 rounded-full bg-line py-[3px] pl-1.5 pr-2.5 text-[11px] text-bright"
                  >
                    <Avatar initials={identity.initials} color={identity.color} size={16} />
                    {identity.name}
                  </span>
                )
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-b border-line px-4">
          <input
            autoFocus={!!initial.to}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className={field}
          />
        </div>

        <Toolbar editor={editor} className="shrink-0 border-b border-line px-2.5 pb-1 pt-2" />
        <RichEditorContent editor={editor} className="min-h-[180px] flex-1 pt-1.5" />

        <div className="flex shrink-0 items-center gap-3.5 border-t border-line px-4 pb-4 pt-3">
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="rounded-[8px] bg-accent px-[18px] py-[7px] text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
          >
            Send
          </button>
          <button
            onClick={() => saveDraft({ to, subject, ...richInput(), accountId, draftId })}
            disabled={!hasContent}
            className="rounded-[6px] px-2 py-1 text-[12.5px] text-quiet transition-colors hover:bg-line-strong hover:text-body disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Save draft
          </button>
          <span className="flex-1" />
          <span className="text-[11px] text-hint"># heading · / commands · ⌘↵ send</span>
        </div>
      </div>
    </div>
  )
}
