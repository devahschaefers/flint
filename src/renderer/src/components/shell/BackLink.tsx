import { CATEGORY_LABELS } from '../../data/types'
import { FOLDER_TITLES, useAppStore } from '../../store'

/** "← Inbox" — or wherever the reader came from */
export default function BackLink(): React.JSX.Element {
  const back = useAppStore((s) => s.back)
  const prevView = useAppStore((s) => s.prevView)
  const label =
    prevView?.name === 'group'
      ? CATEGORY_LABELS[prevView.category]
      : prevView?.name === 'folder'
        ? FOLDER_TITLES[prevView.folder]
        : 'Inbox'
  return (
    <button
      onClick={back}
      className="no-drag -mx-2 -my-1 whitespace-nowrap rounded-[6px] px-2 py-1 text-[12px] text-label transition-colors hover:bg-hover hover:text-body"
    >
      ← {label}
    </button>
  )
}
