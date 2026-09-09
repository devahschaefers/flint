import { useEditorState, type Editor } from '@tiptap/react'
import { cn } from '../../lib/utils'
import { insertImagePlaceholder, promptForLink } from './composeEditor'
import { EditorChip } from './RichEditor'

function Divider(): React.JSX.Element {
  return <span className="mx-1 h-[14px] w-px bg-edge" />
}

/** Persistent formatting toolbar above every rich compose editor — glyphs, not icons */
export default function Toolbar({
  editor,
  className
}: {
  editor: Editor | null
  className?: string
}): React.JSX.Element | null {
  const active = useEditorState({
    editor,
    selector: (ctx) => ({
      paragraph: ctx.editor?.isActive('paragraph') ?? false,
      h2: ctx.editor?.isActive('heading', { level: 2 }) ?? false,
      h3: ctx.editor?.isActive('heading', { level: 3 }) ?? false,
      bold: ctx.editor?.isActive('bold') ?? false,
      italic: ctx.editor?.isActive('italic') ?? false,
      underline: ctx.editor?.isActive('underline') ?? false,
      bulletList: ctx.editor?.isActive('bulletList') ?? false,
      orderedList: ctx.editor?.isActive('orderedList') ?? false,
      blockquote: ctx.editor?.isActive('blockquote') ?? false,
      codeBlock: ctx.editor?.isActive('codeBlock') ?? false,
      link: ctx.editor?.isActive('link') ?? false
    })
  })

  if (!editor || !active) return null

  return (
    <div className={cn('flex items-center gap-0.5 text-[11px] text-quiet', className)}>
      <EditorChip
        title="Text"
        active={active.paragraph}
        onCmd={() => editor.chain().focus().setParagraph().run()}
      >
        ¶
      </EditorChip>
      <EditorChip
        title="Heading"
        active={active.h2}
        onCmd={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <b>H1</b>
      </EditorChip>
      <EditorChip
        title="Subheading"
        active={active.h3}
        onCmd={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <b>H2</b>
      </EditorChip>
      <Divider />
      <EditorChip
        title="Bold ⌘B"
        active={active.bold}
        onCmd={() => editor.chain().focus().toggleBold().run()}
      >
        <b>B</b>
      </EditorChip>
      <EditorChip
        title="Italic ⌘I"
        active={active.italic}
        onCmd={() => editor.chain().focus().toggleItalic().run()}
      >
        <i className="font-serif">I</i>
      </EditorChip>
      <EditorChip
        title="Underline ⌘U"
        active={active.underline}
        onCmd={() => editor.chain().focus().toggleUnderline().run()}
      >
        <u>U</u>
      </EditorChip>
      <Divider />
      <EditorChip
        title="Bulleted list"
        active={active.bulletList}
        onCmd={() => editor.chain().focus().toggleBulletList().run()}
      >
        ≡
      </EditorChip>
      <EditorChip
        title="Numbered list"
        active={active.orderedList}
        onCmd={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1.
      </EditorChip>
      <Divider />
      <EditorChip
        title="Quote"
        active={active.blockquote}
        onCmd={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </EditorChip>
      <EditorChip
        title="Code block"
        active={active.codeBlock}
        onCmd={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        {'</>'}
      </EditorChip>
      <Divider />
      <EditorChip title="Link" active={active.link} onCmd={() => promptForLink(editor)}>
        <u>a</u>
      </EditorChip>
      <EditorChip title="Image" onCmd={() => insertImagePlaceholder(editor)}>
        ▣
      </EditorChip>
    </div>
  )
}
