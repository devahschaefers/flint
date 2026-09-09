import { useRef } from 'react'
import { FOLDER_TITLES, useAppStore, type FolderView } from '../../store'
import { cn } from '../../lib/utils'
import { Popover, PopoverDivider, PopoverItem, PopoverLabel } from '../ui/Popover'

interface ListHeaderProps {
  title: string
  /** Quiet text at the right edge ("3 unread") */
  right?: string
}

const FOLDER_KEYS: Partial<Record<FolderView, string>> = { pins: '⇧P', drafts: '⇧D', sent: '⇧S' }
const MENU_FOLDERS: FolderView[] = ['pins', 'drafts', 'sent', 'trash', 'spam', 'archive']

/**
 * The header is the menu: the title opens a floating panel with every place
 * the old sidebar held (folders, accounts, settings), then vanishes.
 */
export default function ListHeader({ title, right }: ListHeaderProps): React.JSX.Element {
  const view = useAppStore((s) => s.view)
  const popover = useAppStore((s) => s.popover)
  const setPopover = useAppStore((s) => s.setPopover)
  const goInbox = useAppStore((s) => s.goInbox)
  const openFolder = useAppStore((s) => s.openFolder)
  const openSettings = useAppStore((s) => s.openSettings)
  const refreshInbox = useAppStore((s) => s.refreshInbox)
  const accounts = useAppStore((s) => s.accounts)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const titleRef = useRef<HTMLButtonElement>(null)

  const menuOpen = popover === 'menu'
  const activeAccount = accounts.find((a) => a.id === activeAccountId)
  const isFolder = (f: FolderView): boolean => view.name === 'folder' && view.folder === f

  return (
    <div className="no-drag flex items-baseline gap-2">
      <button
        ref={titleRef}
        onClick={() => setPopover(menuOpen ? null : 'menu')}
        className={cn(
          'whitespace-nowrap border-b border-transparent text-[15px] font-semibold text-ink transition-colors hover:border-[#444]',
          menuOpen && 'border-[#444]'
        )}
      >
        {title} <span className="text-[11px] text-hint">{menuOpen ? '▴' : '▾'}</span>
      </button>
      {activeAccount && (
        <button
          onClick={() => setAccount('all')}
          title="Show all accounts"
          className="flex items-center gap-1.5 rounded-full bg-accent/12 px-[9px] py-[2px] text-[11px] text-accent-light transition-colors hover:bg-accent/20"
        >
          {activeAccount.name} ✕
        </button>
      )}
      <span className="flex-1" />
      {right && <span className="whitespace-nowrap text-[12px] text-meta">{right}</span>}

      {menuOpen && (
        <Popover anchorRef={titleRef} onClose={() => setPopover(null)} width={240}>
          <PopoverLabel>Go to</PopoverLabel>
          <PopoverItem active={view.name === 'inbox'} onSelect={goInbox}>
            Inbox
          </PopoverItem>
          {MENU_FOLDERS.map((f) => (
            <PopoverItem key={f} active={isFolder(f)} onSelect={() => openFolder(f)}>
              {FOLDER_TITLES[f]}
              <span className="flex-1" />
              {FOLDER_KEYS[f] && <span className="text-[11px] text-hint">{FOLDER_KEYS[f]}</span>}
            </PopoverItem>
          ))}
          <PopoverItem onSelect={openSettings}>
            Settings
            <span className="flex-1" />
            <span className="text-[11px] text-hint">⌘,</span>
          </PopoverItem>
          {accounts.length > 1 && (
            <>
              <PopoverDivider />
              <PopoverLabel>Accounts</PopoverLabel>
              {accounts.map((a) => (
                <PopoverItem
                  key={a.id}
                  active={activeAccountId === a.id}
                  onSelect={() => setAccount(a.id)}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: a.color }}
                  />
                  <span className="truncate">{a.name}</span>
                  <span className="flex-1" />
                  {activeAccountId === a.id && <span className="text-accent">✓</span>}
                </PopoverItem>
              ))}
              <PopoverItem active={activeAccountId === 'all'} onSelect={() => setAccount('all')}>
                <span className="h-2 w-2 shrink-0 rounded-full border border-[#444]" />
                All accounts
                <span className="flex-1" />
                {activeAccountId === 'all' && <span className="text-accent">✓</span>}
              </PopoverItem>
            </>
          )}
          {accounts.length > 0 && (
            <>
              <PopoverDivider />
              <PopoverItem
                onSelect={() => {
                  refreshInbox()
                  setPopover(null)
                }}
              >
                Refresh
              </PopoverItem>
            </>
          )}
        </Popover>
      )}
    </div>
  )
}
