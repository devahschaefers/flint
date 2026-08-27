import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ChevronDown, X } from 'lucide-react'
import { accounts } from '../../data/mock'
import { useAppStore } from '../../store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/** Global compose window: opened from HeaderControls (pen) or a draft row. Store-driven. */
export default function ComposerModal(): React.JSX.Element | null {
  const composer = useAppStore((s) => s.composer)
  const sendEmail = useAppStore((s) => s.sendEmail)
  const saveDraft = useAppStore((s) => s.saveDraft)
  const closeCompose = useAppStore((s) => s.closeCompose)
  const draft = useAppStore((s) =>
    s.composer.draftId ? s.emails.find((e) => e.id === s.composer.draftId) : undefined
  )

  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [accountId, setAccountId] = useState('gmail')

  // Prefill from the draft being edited, or reset for a fresh message, each time it opens
  useEffect(() => {
    if (!composer.open) return
    const { emails, activeAccountId } = useAppStore.getState()
    const editing = composer.draftId ? emails.find((e) => e.id === composer.draftId) : undefined
    if (editing) {
      setTo(editing.sender.email)
      setSubject(editing.subject)
      setBody(editing.body.join('\n\n'))
      setAccountId(editing.accountId)
    } else {
      setTo('')
      setSubject('')
      setBody('')
      setAccountId(activeAccountId !== 'all' ? activeAccountId : 'gmail')
    }
  }, [composer.open, composer.draftId])

  const hasContent = to.trim() !== '' || subject.trim() !== '' || body.trim() !== ''

  const handleClose = (): void => {
    if (hasContent) {
      saveDraft({ to, subject, body, accountId, draftId: composer.draftId })
    } else {
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

  if (!composer.open) return null

  const fromAccount = accounts.find((a) => a.id === accountId) ?? accounts[0]

  const handleSend = (): void => {
    if (!hasContent) return
    sendEmail({ to, subject, body, accountId, draftId: composer.draftId })
  }

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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 text-[13px] text-text-primary outline-none">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: fromAccount.color }}
                />
                {fromAccount.name}
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
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex h-10 shrink-0 items-center border-b border-white/5 px-4">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To"
            className="select-text flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        <div className="flex h-10 shrink-0 items-center border-b border-white/5 px-4">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="select-text flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write something..."
          className="select-text min-h-[220px] flex-1 resize-none bg-transparent p-4 text-[13px] text-text-primary outline-none placeholder:text-text-muted"
        />

        <div className="flex h-14 shrink-0 items-center gap-3 px-4">
          <button
            onClick={handleSend}
            disabled={!hasContent}
            className="h-8 rounded-[8px] bg-blue-4 px-5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-blue-3 disabled:opacity-40"
          >
            Send
          </button>
          <button
            onClick={() => saveDraft({ to, subject, body, accountId, draftId: composer.draftId })}
            disabled={!hasContent}
            className="text-[13px] text-text-secondary transition-colors duration-150 hover:text-ink disabled:opacity-40 disabled:hover:text-text-secondary"
          >
            Save draft
          </button>
        </div>
      </motion.div>
    </div>
  )
}
