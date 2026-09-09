import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import { useLatest } from '../../lib/useLatest'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import { useComposeEditor } from './composeEditor'
import { RichEditorContent } from './RichEditor'
import Toolbar from './Toolbar'
import type { Message } from '../../data/types'

type Mode = 'collapsed' | 'open' | 'full'

interface ReplyComposerProps {
  /** The conversation being replied to (what the thread view has loaded) */
  thread: Message[]
  replyLabel: string
}

const cornerChip =
  'flex h-6 w-[26px] items-center justify-center rounded-[5px] text-[11px] text-quiet transition-colors hover:bg-white/10 hover:text-ink'

/**
 * Three layers at the end of a thread: a quiet pill → a docked rich composer
 * (auto-grows, drag-resizable) → fullscreen. The editor instance survives
 * collapse, so an unsent reply is still there when reopened.
 */
export default function ReplyComposer({
  thread,
  replyLabel
}: ReplyComposerProps): React.JSX.Element {
  const sendReply = useAppStore((s) => s.sendReply)
  const unsend = useAppStore((s) => s.unsend)
  const showToast = useAppStore((s) => s.showToast)
  const showWordCount = useAppStore((s) => s.showWordCount)

  const [mode, setMode] = useState<Mode>('collapsed')
  const [customHeight, setCustomHeight] = useState<number | null>(null)

  const slashOpenRef = useRef(false)

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

  const closeComposer = useCallback((): void => {
    setMode('collapsed')
    setCustomHeight(null)
  }, [])

  const send = (): void => {
    if (!editor || !editor.getText().trim()) return
    const html = editor.getHTML()
    const messageId = sendReply(thread, editor.getText(), html)
    if (!messageId) return
    const accountId = thread[0]?.accountId ?? ''
    editor.commands.clearContent()
    closeComposer()
    showToast('Message sent', () => {
      unsend(accountId, messageId)
      editor.commands.setContent(html)
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

  const hint = `${showWordCount && hasText ? `${wordCount} ${wordCount === 1 ? 'word' : 'words'} · ` : ''}# heading · / commands · ⌘↵ send`

  const card = (
    <div
      className={cn(
        'relative flex flex-col rounded-[14px] border border-edge bg-panel',
        full ? 'h-full w-[720px] max-w-[92%]' : 'mt-[30px] shadow-[0_4px_15px_rgba(0,0,0,0.25)]'
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
          {full ? '⤡' : '⤢'}
        </button>
        <button title="Close" className={cornerChip} onClick={closeComposer}>
          ✕
        </button>
      </div>

      <Toolbar editor={editor} className="pb-0.5 pl-2.5 pr-20 pt-3" />

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

      <div className="flex shrink-0 items-center gap-3 border-t border-line px-3.5 py-2.5">
        <button
          onClick={send}
          disabled={!hasText}
          className="rounded-[7px] bg-accent px-4 py-1.5 text-[12px] font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
        >
          Send
        </button>
        <button
          onClick={closeComposer}
          className="rounded-[6px] px-2 py-1 text-[12px] text-quiet transition-colors hover:bg-line-strong hover:text-body"
        >
          Cancel
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-hint">{hint}</span>
      </div>
    </div>
  )

  return (
    <>
      {mode === 'collapsed' && (
        <button
          onClick={() => setMode('open')}
          className="mt-9 flex h-11 w-full items-center rounded-[22px] border border-line-strong bg-pill px-4 text-[13px] text-meta shadow-[0_4px_15px_rgba(0,0,0,0.25)] transition-colors hover:bg-[#1e1e1e]"
        >
          {hasText ? (
            <span className="truncate">
              <span className="text-warn">Draft</span> — {text}
            </span>
          ) : (
            replyLabel
          )}
        </button>
      )}
      {mode === 'open' && card}
      {full &&
        createPortal(
          <div className="enter-fade fixed inset-0 z-[70] flex flex-col items-center bg-bg pb-5 pt-7">
            {card}
          </div>,
          document.body
        )}
    </>
  )
}
