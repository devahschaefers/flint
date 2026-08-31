import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Archive,
  ChevronRight,
  File,
  House,
  Inbox,
  PanelLeft,
  Pin,
  RefreshCw,
  Send,
  SquareX,
  Trash2
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import type { Account } from '../../data/types'
import type { RailItem } from './IconRail'

function accountInitials(account: Account): string {
  const key = `${account.name} ${account.identity.address}`.toLowerCase()
  if (key.includes('gmail')) return 'M'
  if (key.includes('icloud')) return 'DS'
  return account.name.charAt(0).toUpperCase()
}

function NavRow({
  label,
  icon,
  active = false,
  expandable = false,
  expanded = false,
  onClick,
  onToggle
}: {
  label: string
  icon: React.ReactNode
  active?: boolean
  expandable?: boolean
  expanded?: boolean
  onClick?: () => void
  /** Clicking the chevron expands/collapses without triggering the row's onClick */
  onToggle?: () => void
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex h-[38px] cursor-default items-center gap-2.5 rounded-[10px] pl-1 pr-2.5 text-[14px] text-text-primary',
        active ? 'bg-blue-4 text-white' : 'hover:bg-white/5'
      )}
    >
      <span
        className="flex w-[16px] shrink-0 items-center justify-center"
        onClick={
          expandable && onToggle
            ? (e): void => {
                e.stopPropagation()
                onToggle()
              }
            : undefined
        }
      >
        {expandable && (
          <ChevronRight
            size={13}
            className={cn(
              'transition-transform duration-150',
              active ? 'text-white' : 'text-text-muted',
              expanded && 'rotate-90'
            )}
          />
        )}
      </span>
      <span className={cn('shrink-0', active ? 'text-white' : 'text-text-bright')}>{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  )
}

function AccountRow({
  account,
  count,
  active = false,
  onClick
}: {
  account: Account
  count?: number
  active?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex h-[34px] cursor-default items-center gap-2.5 rounded-[10px] pl-[42px] pr-2.5 hover:bg-white/5',
        active && 'bg-white/5'
      )}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
        style={{ backgroundColor: account.color }}
      >
        {accountInitials(account)}
      </span>
      <span className={cn('truncate text-[14px]', active ? 'text-white' : 'text-text-primary')}>
        {account.name}
      </span>
      {count !== undefined && count > 0 && (
        <span className="ml-auto text-[13px] text-text-secondary">{count}</span>
      )}
    </div>
  )
}

function FolderGroup({
  label,
  icon,
  item,
  defaultExpanded = false
}: {
  label: string
  icon: React.ReactNode
  item: RailItem
  defaultExpanded?: boolean
}): React.JSX.Element {
  const setRailItem = useAppStore((s) => s.setRailItem)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const view = useAppStore((s) => s.view)
  const accounts = useAppStore((s) => s.accounts)
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div>
      <NavRow
        label={label}
        icon={icon}
        active={view.name === 'folder' && view.folder === item}
        expandable
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        onClick={() => {
          setRailItem(item)
          setSidebarOpen(false)
        }}
      />
      {expanded &&
        accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            active={activeAccountId === a.id}
            onClick={() => {
              setAccount(a.id)
              setRailItem(item)
              setSidebarOpen(false)
            }}
          />
        ))}
    </div>
  )
}

export default function SidebarPanel(): React.JSX.Element {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const railItem = useAppStore((s) => s.railItem)
  const setRailItem = useAppStore((s) => s.setRailItem)
  const messages = useAppStore((s) => s.messages)
  const accounts = useAppStore((s) => s.accounts)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const goInbox = useAppStore((s) => s.goInbox)
  const view = useAppStore((s) => s.view)
  const openFolder = useAppStore((s) => s.openFolder)
  const openSettings = useAppStore((s) => s.openSettings)
  const refreshInbox = useAppStore((s) => s.refreshInbox)
  const [inboxExpanded, setInboxExpanded] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Escape handling lives in App.tsx's single ordered handler (search > composer > sidebar > back)

  const unreadCount = (accountId: string): number =>
    messages.filter((m) => m.accountId === accountId && m.folder === 'inbox' && !m.flags.seen)
      .length

  return (
    <AnimatePresence>
      {sidebarOpen && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-40 bg-black/25"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSidebarOpen(false)}
          />
          <motion.div
            key="panel"
            className="fixed left-0 top-0 z-50 flex h-full w-[300px] flex-col rounded-r-[14px] border-r border-white/5 bg-[#26292d] shadow-[0_10px_60px_0_rgba(0,0,0,0.4)]"
            initial={{ x: -310 }}
            animate={{ x: 0 }}
            exit={{ x: -310 }}
            transition={{ duration: 0.22, ease: [0, 0, 0.2, 1] }}
          >
            <div className="drag-region flex h-[46px] shrink-0 items-center justify-end gap-3 px-3.5 text-text-bright">
              <button
                aria-label="Refresh"
                title="Refresh"
                onClick={() => {
                  refreshInbox()
                  setRefreshing(true)
                  window.setTimeout(() => setRefreshing(false), 700)
                }}
                className="no-drag hover:text-ink"
              >
                <RefreshCw size={15} className={cn(refreshing && 'animate-spin')} />
              </button>
              <button
                aria-label="Close Sidebar"
                onClick={() => setSidebarOpen(false)}
                className="no-drag hover:text-ink"
              >
                <PanelLeft size={15} />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-[10px] pb-2">
              <NavRow
                label="Home Screen"
                icon={<House size={17} />}
                active={view.name === 'inbox' && railItem === 'home'}
                onClick={() => {
                  setRailItem('home')
                  setSidebarOpen(false)
                }}
              />

              <NavRow
                label="Inbox"
                icon={<Inbox size={17} />}
                active={view.name === 'inbox' && railItem !== 'home'}
                expandable
                expanded={inboxExpanded}
                onToggle={() => setInboxExpanded((v) => !v)}
                onClick={() => {
                  setAccount('all')
                  goInbox()
                  setSidebarOpen(false)
                }}
              />
              {inboxExpanded &&
                accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    count={unreadCount(a.id)}
                    active={activeAccountId === a.id}
                    onClick={() => {
                      setAccount(a.id)
                      goInbox()
                      setSidebarOpen(false)
                    }}
                  />
                ))}

              <div className="h-3" />

              <FolderGroup label="Pins" icon={<Pin size={17} />} item="pins" />
              <FolderGroup label="Drafts" icon={<File size={17} />} item="drafts" />
              <FolderGroup label="Sent" icon={<Send size={17} />} item="sent" />
              <FolderGroup label="Trash" icon={<Trash2 size={17} />} item="trash" defaultExpanded />
              <FolderGroup label="Spam" icon={<SquareX size={17} />} item="spam" defaultExpanded />
              <NavRow
                label="Archive"
                icon={<Archive size={17} />}
                active={view.name === 'folder' && view.folder === 'archive'}
                onClick={() => {
                  openFolder('archive')
                  setSidebarOpen(false)
                }}
              />
            </nav>

            <div className="mt-auto shrink-0 border-t border-white/5 px-[10px] pb-3 pt-1">
              <div
                onClick={() => {
                  openSettings()
                  setSidebarOpen(false)
                }}
                className="flex h-[38px] cursor-default items-center gap-2.5 rounded-[10px] pl-1 pr-2.5 text-[14px] text-text-primary hover:bg-white/5"
              >
                <span className="w-[16px] shrink-0" />
                <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[#2E7D32] text-[10px] font-semibold text-white">
                  DS
                </span>
                <span>Settings</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
