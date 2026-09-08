import { useEffect } from 'react'
import { Node, useEditor, type Editor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { useLatest } from '../../lib/useLatest'

/**
 * Editor setup shared by the reply composer and the New Message modal: the
 * TipTap instance with StarterKit's marks/blocks and the markdown input rules
 * from the handoff (`#`, `##`, `-`, `1.`, `>`, ``` + space/enter), the
 * image-placeholder block, and the commands the toolbars and the `/` menu run.
 * The React parts (floating toolbar, slash menu) live in RichEditor.tsx.
 */

/** Non-editable stand-in block until real attachments land */
const ImagePlaceholder = Node.create({
  name: 'imagePlaceholder',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'div.imgph' }]
  },
  renderHTML() {
    return ['div', { class: 'imgph' }]
  }
})

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** text/plain paragraphs → minimal HTML, for editing legacy drafts rich */
export function paragraphsToHtml(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
}

export function useComposeEditor({
  placeholder,
  onSend
}: {
  placeholder: string
  /** ⌘/Ctrl+Enter inside the editor */
  onSend?: () => void
}): Editor | null {
  // handleKeyDown below is captured once by TipTap; the ref keeps it on the latest onSend
  const onSendRef = useLatest(onSend)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false }
      }),
      Placeholder.configure({ placeholder }),
      ImagePlaceholder
    ],
    editorProps: {
      attributes: { class: 'rt rt-editor' },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          onSendRef.current?.()
          return true
        }
        return false
      }
    }
  })

  // Dev-only handle so tooling can inspect/drive the editors
  useEffect(() => {
    if (!import.meta.env.DEV || !editor) return
    const w = window as unknown as { __editors?: Set<Editor> }
    w.__editors ??= new Set()
    w.__editors.add(editor)
    return (): void => {
      w.__editors?.delete(editor)
    }
  }, [editor])

  // Live placeholder updates (the reply label changes with the thread)
  useEffect(() => {
    if (!editor) return
    const ext = editor.extensionManager.extensions.find((e) => e.name === 'placeholder')
    if (ext && ext.options.placeholder !== placeholder) {
      ext.options.placeholder = placeholder
      editor.view.dispatch(editor.state.tr)
    }
  }, [editor, placeholder])

  return editor
}

export function promptForLink(editor: Editor): void {
  if (editor.isActive('link')) {
    editor.chain().focus().unsetLink().run()
    return
  }
  const url = window.prompt('Link URL', 'https://')
  if (url && url !== 'https://') editor.chain().focus().setLink({ href: url }).run()
}

export function insertImagePlaceholder(editor: Editor): void {
  editor
    .chain()
    .focus()
    .insertContent([{ type: 'imagePlaceholder' }, { type: 'paragraph' }])
    .run()
}
