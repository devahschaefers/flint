import { useEffect, useLayoutEffect, useState } from 'react'
import { EditorContent, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import {
  Bold,
  Code,
  Heading2,
  Image as ImageIcon,
  Italic,
  List,
  Quote,
  Underline
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { insertImagePlaceholder, promptForLink } from './composeEditor'

/**
 * Shared rich-text editor UI for the reply composer and the New Message modal:
 * the editor surface, the floating selection toolbar, and the `/` insert menu.
 * The TipTap instance itself comes from `useComposeEditor` in composeEditor.ts.
 */

/** 26px hover chip used by every editor toolbar (mousedown keeps the selection) */
export function EditorChip({
  title,
  onCmd,
  active = false,
  children
}: {
  title: string
  onCmd: () => void
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        onCmd()
      }}
      className={cn(
        'flex h-[24px] min-w-[26px] items-center justify-center rounded-[5px] px-1 text-text-bright transition-colors hover:bg-white/10 hover:text-ink',
        active && 'bg-white/10 text-ink'
      )}
    >
      {children}
    </button>
  )
}

const SLASH_ITEMS = [
  {
    label: 'Heading',
    icon: Heading2,
    apply: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run()
  },
  {
    label: 'Bulleted list',
    icon: List,
    apply: (e: Editor) => e.chain().focus().toggleBulletList().run()
  },
  { label: 'Quote', icon: Quote, apply: (e: Editor) => e.chain().focus().setBlockquote().run() },
  { label: 'Code block', icon: Code, apply: (e: Editor) => e.chain().focus().setCodeBlock().run() },
  { label: 'Image', icon: ImageIcon, apply: insertImagePlaceholder }
] as const

interface RichEditorContentProps {
  editor: Editor | null
  className?: string
  style?: React.CSSProperties
  /** Kept current so ancestors' Escape handlers can defer while the slash menu is open */
  slashOpenRef?: React.MutableRefObject<boolean>
}

export function RichEditorContent({
  editor,
  className,
  style,
  slashOpenRef
}: RichEditorContentProps): React.JSX.Element | null {
  const [slashAt, setSlashAt] = useState<{ x: number; y: number } | null>(null)

  // Published right after commit so the ancestor's capture-phase Escape listener
  // reads the menu state before the next key event arrives
  useLayoutEffect(() => {
    if (slashOpenRef) slashOpenRef.current = slashAt !== null
  }, [slashOpenRef, slashAt])

  // Detect a lone "/" on an empty paragraph → open the insert menu at the caret
  useEffect(() => {
    if (!editor) return
    const update = (): void => {
      const { $from, empty } = editor.state.selection
      const isSlash =
        empty && $from.parent.type.name === 'paragraph' && $from.parent.textContent === '/'
      if (isSlash) {
        const coords = editor.view.coordsAtPos(editor.state.selection.from)
        setSlashAt({ x: coords.left, y: coords.bottom + 6 })
      } else {
        setSlashAt(null)
      }
    }
    editor.on('transaction', update)
    return (): void => {
      editor.off('transaction', update)
    }
  }, [editor])

  if (!editor) return null

  const applySlashItem = (apply: (e: Editor) => void): void => {
    const { $from } = editor.state.selection
    editor.chain().focus().deleteRange({ from: $from.start(), to: $from.end() }).run()
    apply(editor)
    setSlashAt(null)
  }

  return (
    <div
      className={cn('relative min-h-0 overflow-y-auto', className)}
      style={style}
      onMouseDown={(e) => {
        // Clicking the empty area below short content still lands the caret
        if (e.target === e.currentTarget) {
          e.preventDefault()
          editor.chain().focus('end').run()
        }
      }}
      onKeyDownCapture={(e) => {
        if (e.key === 'Escape' && slashAt) {
          e.preventDefault()
          e.stopPropagation()
          setSlashAt(null)
        }
      }}
    >
      <EditorContent editor={editor} className="px-4 pb-2 pt-3" />

      <BubbleMenu editor={editor} options={{ placement: 'top', offset: 8 }}>
        <div className="flex items-center gap-0.5 rounded-[8px] border border-white/10 bg-elevation-2 p-1 shadow-[0_6px_20px_rgba(0,0,0,0.5)]">
          <EditorChip
            title="Bold"
            active={editor.isActive('bold')}
            onCmd={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold size={13} />
          </EditorChip>
          <EditorChip
            title="Italic"
            active={editor.isActive('italic')}
            onCmd={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic size={13} />
          </EditorChip>
          <EditorChip
            title="Underline"
            active={editor.isActive('underline')}
            onCmd={() => editor.chain().focus().toggleUnderline().run()}
          >
            <Underline size={13} />
          </EditorChip>
          <span className="mx-0.5 h-[15px] w-px bg-white/10" />
          <EditorChip
            title="Heading"
            active={editor.isActive('heading', { level: 2 })}
            onCmd={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <span className="text-[11px] font-bold">H1</span>
          </EditorChip>
          <EditorChip
            title="Quote"
            active={editor.isActive('blockquote')}
            onCmd={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote size={13} />
          </EditorChip>
          <EditorChip
            title="Link"
            active={editor.isActive('link')}
            onCmd={() => promptForLink(editor)}
          >
            <span className="text-[11px] underline">a</span>
          </EditorChip>
        </div>
      </BubbleMenu>

      {slashAt && (
        <div
          className="fixed z-[80] w-[200px] rounded-[10px] border border-white/10 bg-elevation-2 py-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.55)]"
          style={{ left: slashAt.x, top: slashAt.y }}
        >
          <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Insert
          </div>
          {SLASH_ITEMS.map(({ label, icon: Icon, apply }) => (
            <button
              key={label}
              onMouseDown={(e) => {
                e.preventDefault()
                applySlashItem(apply)
              }}
              className="flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[12.5px] text-text-primary transition-colors hover:bg-blue-4 hover:text-white"
            >
              <Icon size={14} className="shrink-0 opacity-80" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
