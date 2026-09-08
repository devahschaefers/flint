import { useEditorState, type Editor } from '@tiptap/react'
import {
  Bold,
  Code,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Underline
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { insertImagePlaceholder, promptForLink } from './composeEditor'
import { EditorChip } from './RichEditor'

function Divider(): React.JSX.Element {
  return <span className="mx-1 h-[15px] w-px bg-white/10" />
}

/** Persistent formatting toolbar shown above every rich compose editor. */
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
    <div className={cn('flex items-center gap-0.5 border-b border-white/5 py-1.5 pl-3', className)}>
      <EditorChip
        title="Text"
        active={active.paragraph}
        onCmd={() => editor.chain().focus().setParagraph().run()}
      >
        <span className="text-[11.5px]">¶</span>
      </EditorChip>
      <EditorChip
        title="Heading"
        active={active.h2}
        onCmd={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <span className="text-[11px] font-bold">H1</span>
      </EditorChip>
      <EditorChip
        title="Subheading"
        active={active.h3}
        onCmd={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <span className="text-[11px] font-bold">H2</span>
      </EditorChip>
      <Divider />
      <EditorChip
        title="Bold ⌘B"
        active={active.bold}
        onCmd={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={13} />
      </EditorChip>
      <EditorChip
        title="Italic ⌘I"
        active={active.italic}
        onCmd={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={13} />
      </EditorChip>
      <EditorChip
        title="Underline ⌘U"
        active={active.underline}
        onCmd={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline size={13} />
      </EditorChip>
      <Divider />
      <EditorChip
        title="Bulleted list"
        active={active.bulletList}
        onCmd={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={14} />
      </EditorChip>
      <EditorChip
        title="Numbered list"
        active={active.orderedList}
        onCmd={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={14} />
      </EditorChip>
      <Divider />
      <EditorChip
        title="Quote"
        active={active.blockquote}
        onCmd={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={13} />
      </EditorChip>
      <EditorChip
        title="Code block"
        active={active.codeBlock}
        onCmd={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Code size={13} />
      </EditorChip>
      <Divider />
      <EditorChip title="Link" active={active.link} onCmd={() => promptForLink(editor)}>
        <LinkIcon size={13} />
      </EditorChip>
      <EditorChip title="Image" onCmd={() => insertImagePlaceholder(editor)}>
        <ImageIcon size={13} />
      </EditorChip>
    </div>
  )
}
