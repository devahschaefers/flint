import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronRight,
  File,
  House,
  Inbox,
  PanelLeft,
  Pin,
  RefreshCw,
  Send,
  Sparkles,
  SquareX,
  Trash2
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../store'
import { accounts } from '../../data/mock'
import type { Account } from '../../data/types'
import type { RailItem } from './IconRail'

function accountInitials(account: Account): string {
  const key = `${account.name} ${account.email}`.toLowerCase()
  if (key.includes('gmail')) return 'M'
  if (key.includes('icloud')) return 'DS'
  return account.name.charAt(0).toUpperCase()
}

function CalendarGlyph(): React.JSX.Element {
  const day = new Date().getDate()
  return (
    <span className="relative flex h-[17px] w-[17px] items-end justify-center rounded-[4px] border-[1.5px] border-current">
      <span className="absolute -top-[3px] left-[2.5px] h-[2.5px] w-[1.5px] rounded-full bg-current" />
      <span className="absolute -top-[3px] right-[2.5px] h-[2.5px] w-[1.5px] rounded-full bg-current" />
      <span className="pb-px text-[8px] font-semibold leading-none">{day}</span>
    </span>
  )
}

function NavRow({
  label,
  icon,
  active = false,
  expandable = false,
  expanded = false,
  onClick
}: {
  label: string
  icon: React.ReactNode
  active?: boolean
  expandable?: boolean
  expanded?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex h-[38px] cursor-default items-center gap-2.5 rounded-[10px] pl-1 pr-2.5 text-[14px] text-text-primary',
        active ? 'bg-blue-4 text-white' : 'hover:bg-white/5'
      )}
    >
      <span className="flex w-[16px] shrink-0 items-center justify-center">
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
  const railItem = useAppStore((s) => s.railItem)
  const setRailItem = useAppStore((s) => s.setRailItem)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const [expanded] = useState(defaultExpanded)
  return (
    <div>
      <NavRow
        label={label}
        icon={icon}
        active={railItem === item}
        expandable
        expanded={expanded}
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
  const emails = useAppStore((s) => s.emails)
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const goInbox = useAppStore((s) => s.goInbox)
  const [inboxExpanded] = useState(true)

  useEffect(() => {
    if (!sidebarOpen) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebarOpen, setSidebarOpen])

  const unreadCount = (accountId: string): number =>
    emails.filter((e) => e.accountId === accountId && e.folder === 'inbox' && !e.read).length

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
              <button aria-label="Refresh" className="no-drag hover:text-ink">
                <RefreshCw size={15} />
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
                active={railItem === 'home'}
                onClick={() => {
                  setRailItem('home')
                  setSidebarOpen(false)
                }}
              />

              <NavRow
                label="Inbox"
                icon={<Inbox size={17} />}
                active={railItem === 'inbox'}
                expandable
                expanded={inboxExpanded}
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

              <NavRow
                label="Calendar"
                icon={<CalendarGlyph />}
                active={railItem === 'calendar'}
                onClick={() => setRailItem('calendar')}
              />

              <div className="h-3" />

              <FolderGroup label="Pins" icon={<Pin size={17} />} item="pins" />
              <FolderGroup label="Drafts" icon={<File size={17} />} item="drafts" />
              <FolderGroup label="Sent" icon={<Send size={17} />} item="sent" />
              <FolderGroup label="Trash" icon={<Trash2 size={17} />} item="trash" defaultExpanded />
              <FolderGroup label="Spam" icon={<SquareX size={17} />} item="spam" defaultExpanded />
            </nav>

            <div className="mt-auto shrink-0 border-t border-white/5 px-[10px] pb-3 pt-1">
              <NavRow label="AI Agents" icon={<Sparkles size={17} />} />
              <div className="flex h-[38px] cursor-default items-center gap-2.5 rounded-[10px] pl-1 pr-2.5 text-[14px] text-text-primary hover:bg-white/5">
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
