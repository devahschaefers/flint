import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useEditorState } from '@tiptap/react'
import { ChevronDown, X } from 'lucide-react'
import { formatAddressList, parseAddressList } from '../../lib/address'
import { resolveMailbox } from '../../lib/identity'
import { useAppStore } from '../../store'
import { paragraphsToHtml, RichEditorContent, useComposeEditor } from './RichEditor'
import Toolbar from './Toolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/** Global compose window: opened from HeaderControls (pen) or a draft row. Store-driven. */
export default function ComposerModal(): React.JSX.Element | null {
  const composer = useAppStore((s) => s.composer)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const saveDraft = useAppStore((s) => s.saveDraft)
  const deleteDraft = useAppStore((s) => s.deleteDraft)
  const closeCompose = useAppStore((s) => s.closeCompose)
  const contacts = useAppStore((s) => s.contacts)
  const accounts = useAppStore((s) => s.accounts)
  const draft = useAppStore((s) =>
    s.composer.draftId ? s.messages.find((m) => m.messageId === s.composer.draftId) : undefined
  )

  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')

  const editor = useComposeEditor({
    placeholder: 'Write something...',
    onSend: () => handleSendRef.current()
  })
  const bodyText = useEditorState({ editor, selector: (ctx) => ctx.editor?.getText() ?? '' })

  // Prefill from the draft being edited, or reset for a fresh message, each time it opens
  useEffect(() => {
    if (!composer.open || !editor) return
    const { messages, activeAccountId, accounts } = useAppStore.getState()
    const editing = composer.draftId
      ? messages.find((m) => m.messageId === composer.draftId)
      : undefined
    if (editing) {
      setTo(formatAddressList(editing.to))
      setSubject(editing.subject)
      editor.commands.setContent(editing.bodyHtml ?? paragraphsToHtml(editing.body))
      setAccountId(editing.accountId)
    } else {
      setTo('')
      setSubject('')
      editor.commands.clearContent()
      setAccountId(activeAccountId !== 'all' ? activeAccountId : (accounts[0]?.id ?? ''))
    }
  }, [composer.open, composer.draftId, editor])

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
      saveDraft({ to, subject, ...richInput(), accountId, draftId: composer.draftId })
    } else {
      // Closing a draft after clearing every field deletes it, like real clients
      if (composer.draftId) deleteDraft(composer.draftId)
      closeCompose()
    }
  }
  const handleCloseRef = useRef(handleClose)
  handleCloseRef.current = handleClose

  // Escape saves-or-closes exactly like the X button / backdrop. App.tsx's Escape
  // chain defers to this listener while the composer is open (and preventDefaults
  // when a higher layer like search consumed the key, which skips this handler).
  useEffect(() => {
    if (!composer.open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      handleCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [composer.open])

  const handleSend = (): void => {
    if (!canSend) return
    sendMessage({ to, subject, ...richInput(), accountId, draftId: composer.draftId })
  }
  const handleSendRef = useRef(handleSend)
  handleSendRef.current = handleSend

  if (!composer.open) return null

  const fromAccount = accounts.find((a) => a.id === accountId) ?? accounts[0]
  // No connected account: nothing to compose from
  if (!fromAccount) return null

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={handleClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        onKeyDown={handleKeyDown}
        className="relative flex max-h-[80vh] w-[680px] flex-col overflow-hidden rounded-[14px] border border-white/10 bg-elevation-1 shadow-[0_10px_60px_0_rgba(0,0,0,0.5)]"
      >
        <div className="flex h-11 shrink-0 items-center justify-between px-4">
          <span className="text-[13px] font-semibold text-text-primary">
            {draft ? draft.subject : 'New Message'}
          </span>
          <button
            aria-label="Close"
            onClick={handleClose}
            className="text-text-secondary transition-colors duration-150 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-white/5 px-4">
          <span className="text-[13px] text-text-muted">From</span>
          {draft?.inReplyTo ? (
            // A reply draft stays on the account that owns its thread — switching
            // accounts would split the conversation across account filters.
            <div className="flex items-center gap-2 text-[13px] text-text-primary">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: fromAccount.color }}
              />
              {fromAccount.name}
              <span className="text-text-muted">· {fromAccount.identity.address}</span>
            </div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 text-[13px] text-text-primary outline-none">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: fromAccount.color }}
                  />
                  {fromAccount.name}
                  <span className="text-text-muted">· {fromAccount.identity.address}</span>
                  <ChevronDown size={14} className="text-text-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {accounts.map((account) => (
                  <DropdownMenuItem key={account.id} onSelect={() => setAccountId(account.id)}>
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: account.color }}
                    />
                    {account.name}
                    <span className="text-text-muted">· {account.identity.address}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="shrink-0 border-b border-white/5 px-4">
          <div className="flex h-10 items-center">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="To"
              className="select-text flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
          {recipients.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2.5">
              {recipients.map((mailbox, i) => {
                const identity = resolveMailbox(mailbox, contacts)
                return (
                  <span
                    key={`${mailbox.address}-${i}`}
                    className="flex items-center gap-1.5 rounded-full bg-elevation-2 py-[3px] pl-2 pr-2.5 text-[11px] text-text-secondary"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: identity.color }}
                    />
                    {identity.name}
                  </span>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex h-10 shrink-0 items-center border-b border-white/5 px-4">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="select-text flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        <Toolbar editor={editor} className="shrink-0" />
        <RichEditorContent editor={editor} className="min-h-[220px] flex-1" />

        <div className="flex h-14 shrink-0 items-center gap-3 px-4">
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="h-8 rounded-[8px] bg-blue-4 px-5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-blue-3 disabled:opacity-40"
          >
            Send
          </button>
          <button
            onClick={() =>
              saveDraft({ to, subject, ...richInput(), accountId, draftId: composer.draftId })
            }
            disabled={!hasContent}
            className="text-[13px] text-text-secondary transition-colors duration-150 hover:text-ink disabled:opacity-40 disabled:hover:text-text-secondary"
          >
            Save draft
          </button>
          <span className="flex-1" />
          <span className="text-[11px] text-text-muted"># heading · / commands · ⌘↵ send</span>
        </div>
      </motion.div>
    </div>
  )
}
