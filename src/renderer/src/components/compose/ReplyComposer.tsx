import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import { Maximize2, X } from 'lucide-react'
import { useLatest } from '../../lib/useLatest'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import { useComposeEditor } from './composeEditor'
import { RichEditorContent } from './RichEditor'
import Toolbar from './Toolbar'

type Mode = 'collapsed' | 'open' | 'full'

const TOAST_MS = 2600

interface ReplyComposerProps {
  threadId: string
  replyLabel: string
}

/**
 * The thread reply UI from the rich-compose handoff: collapsed pill → docked
 * rich composer (auto-grow, drag-resizable) → fullscreen. The editor instance
 * survives collapse, so an unsent reply is still there when reopened.
 */
export default function ReplyComposer({
  threadId,
  replyLabel
}: ReplyComposerProps): React.JSX.Element {
  const sendReply = useAppStore((s) => s.sendReply)
  const unsend = useAppStore((s) => s.unsend)
  const showWordCount = useAppStore((s) => s.showWordCount)

  const [mode, setMode] = useState<Mode>('collapsed')
  const [customHeight, setCustomHeight] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)

  const slashOpenRef = useRef(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const lastSent = useRef<{ messageId: string; html: string } | null>(null)

  // Read by the once-attached Escape listener below, which must see the current mode
  const modeRef = useLatest(mode)
  const composerShown = mode !== 'collapsed'

  const editor = useComposeEditor({ placeholder: replyLabel, onSend: () => sendRef.current() })

  const text = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.getText() ?? ''
  })
  const hasText = (text ?? '').trim().length > 0
  const wordCount = (text ?? '').trim().split(/\s+/).filter(Boolean).length

  const showToast = (text: string, undo?: () => void): void => {
    window.clearTimeout(toastTimer.current)
    setToast({ text, undo })
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }

  const closeComposer = useCallback((): void => {
    setMode('collapsed')
    setCustomHeight(null)
  }, [])

  const send = (): void => {
    if (!editor || !editor.getText().trim()) return
    const html = editor.getHTML()
    const messageId = sendReply(threadId, editor.getText(), html)
    if (!messageId) return
    lastSent.current = { messageId, html }
    editor.commands.clearContent()
    closeComposer()
    showToast('Message sent', () => {
      const sent = lastSent.current
      if (!sent) return
      unsend(sent.messageId)
      editor.commands.setContent(sent.html)
      setToast(null)
      setMode('open')
    })
  }
  // The editor's ⌘↵ keymap is captured once by TipTap; the ref keeps it on the latest send
  const sendRef = useLatest(send)

  // Focus when opening; keep focus through fullscreen toggles
  useEffect(() => {
    if (mode !== 'collapsed' && editor) {
      // The portal/DOM swap on mode change needs a beat before focusing
      const t = window.setTimeout(() => editor.commands.focus('end'), 30)
      return (): void => window.clearTimeout(t)
    }
    return undefined
  }, [mode, editor])

  // Escape steps down: slash menu (handled in the editor) → fullscreen → collapse.
  // Capture-phase so App.tsx's window listener never also navigates back.
  useEffect(() => {
    if (!composerShown) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || slashOpenRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (modeRef.current === 'full') setMode('open')
      else closeComposer()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return (): void => window.removeEventListener('keydown', onKey, { capture: true })
  }, [composerShown, closeComposer, modeRef])

  const full = mode === 'full'

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const editorEl = document.querySelector<HTMLElement>('[data-reply-editor]')
    if (!editorEl) return
    const startY = e.clientY
    const startH = editorEl.getBoundingClientRect().height
    const move = (ev: MouseEvent): void =>
      setCustomHeight(
        Math.min(Math.max(80, startH + (startY - ev.clientY)), window.innerHeight - 240)
      )
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const cornerChip =
    'flex h-6 w-[26px] items-center justify-center rounded-[5px] text-text-secondary transition-colors hover:bg-white/10 hover:text-ink'

  const card = (
    <div
      className={cn(
        'relative flex flex-col overflow-visible rounded-[14px] border border-white/10 bg-elevation-1',
        full ? 'h-full w-[720px] max-w-[92%]' : 'shadow-[0_4px_15px_rgba(0,0,0,0.25)]'
      )}
    >
      {!full && (
        <div
          onMouseDown={startDrag}
          className="absolute left-0 right-20 top-0 z-[4] flex h-2.5 cursor-ns-resize items-center justify-center"
        >
          <span className="h-1 w-9 rounded-full bg-white/15" />
        </div>
      )}
      <div className="absolute right-2 top-1.5 z-[5] flex items-center gap-0.5">
        <button
          title={full ? 'Exit fullscreen' : 'Fullscreen'}
          className={cornerChip}
          onClick={() => setMode(full ? 'open' : 'full')}
        >
          <Maximize2 size={12} />
        </button>
        <button title="Close" className={cornerChip} onClick={closeComposer}>
          <X size={13} />
        </button>
      </div>

      <Toolbar editor={editor} className="pr-24 pt-2.5" />

      <div data-reply-editor className={cn(full && 'flex min-h-0 flex-1 flex-col')}>
        <RichEditorContent
          editor={editor}
          slashOpenRef={slashOpenRef}
          className={cn(full && 'flex-1')}
          style={
            full
              ? undefined
              : customHeight
                ? { height: customHeight }
                : { minHeight: 110, maxHeight: '58vh' }
          }
        />
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-white/5 px-3.5 py-2.5">
        <button
          onClick={send}
          disabled={!hasText}
          className="h-7 rounded-[7px] bg-blue-4 px-4 text-[12px] font-semibold text-white transition-colors hover:bg-blue-3 disabled:opacity-40 disabled:hover:bg-blue-4"
        >
          Send
        </button>
        <button
          onClick={closeComposer}
          className="px-1.5 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
        >
          Cancel
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-text-muted">
          {showWordCount && hasText ? `${wordCount} ${wordCount === 1 ? 'word' : 'words'} · ` : ''}#
          heading · / commands · ⌘↵ send
        </span>
      </div>
    </div>
  )

  return (
    <>
      {mode === 'collapsed' && (
        <button
          onClick={() => setMode('open')}
          className="flex h-[44px] w-full items-center rounded-[22px] border border-white/10 bg-elevation-1 px-4 text-[13px] text-text-secondary shadow-[0_4px_15px_rgba(0,0,0,0.25)] transition-colors hover:bg-elevation-2"
        >
          {hasText ? (
            <span className="truncate">
              <span className="mr-1.5 text-[11px] font-semibold uppercase tracking-wide text-yellow-3">
                Draft
              </span>
              {text}
            </span>
          ) : (
            replyLabel
          )}
        </button>
      )}
      {mode === 'open' && card}
      {full &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex flex-col items-center bg-elevation-0 pb-6 pt-8">
            {card}
          </div>,
          document.body
        )}
      {toast &&
        createPortal(
          <div className="fixed bottom-[84px] left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-[20px] bg-elevation-2 py-2 pl-4 pr-3 text-[12.5px] text-text-primary shadow-[0_6px_20px_rgba(0,0,0,0.5)]">
            {toast.text}
            {toast.undo && (
              <button
                onClick={toast.undo}
                className="font-semibold text-blue-3 transition-colors hover:text-white"
              >
                Undo
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
