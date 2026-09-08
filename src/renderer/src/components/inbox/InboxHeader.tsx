import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { useAppStore } from '../../store'
import HeaderControls from './HeaderControls'

interface InboxHeaderProps {
  title?: string
}

export default function InboxHeader({ title = 'Inbox' }: InboxHeaderProps): React.JSX.Element {
  const activeAccountId = useAppStore((s) => s.activeAccountId)
  const setAccount = useAppStore((s) => s.setAccount)
  const accounts = useAppStore((s) => s.accounts)

  const activeAccount = accounts.find((a) => a.id === activeAccountId)
  const subtitle =
    activeAccountId === 'all' ? 'Focused List' : (activeAccount?.name ?? 'Focused List')

  return (
    <div className="drag-region flex items-start justify-between px-[30px] pt-[40px] pb-2">
      <div className="pl-[50px]">
        <DropdownMenu>
          <DropdownMenuTrigger className="no-drag flex items-center gap-1 outline-none">
            <span className="text-[14px] font-semibold text-text-primary">{title}</span>
            <ChevronDown size={13} className="text-text-secondary" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setAccount('all')}>
              <span className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">All Accounts</span>
              {activeAccountId === 'all' && (
                <Check size={14} className="shrink-0 text-text-bright" />
              )}
            </DropdownMenuItem>
            {accounts.map((account) => (
              <DropdownMenuItem key={account.id} onSelect={() => setAccount(account.id)}>
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                  style={{ backgroundColor: account.color }}
                >
                  {account.name.charAt(0).toUpperCase()}
                </span>
                <span className="flex-1">{account.name}</span>
                {activeAccountId === account.id && (
                  <Check size={14} className="shrink-0 text-text-bright" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mt-0.5 text-[11px] text-text-secondary">{subtitle}</div>
      </div>

      <HeaderControls />
    </div>
  )
}
