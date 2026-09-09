import { useEffect, useState } from 'react'
import type { SyncStatus } from '../../../preload/index.d'
import BackLink from '../components/shell/BackLink'
import { Page } from '../components/shell/Page'
import Avatar from '../components/ui/Avatar'
import Toggle from '../components/ui/Toggle'
import { Spinner } from '../components/ui/icons'
import { useAppStore } from '../store'

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-1.5 mt-6 text-[11px] text-label">{children}</div>
}

/** IPC error messages arrive wrapped ("Error invoking remote method '…': Error: …") */
function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

function mailApi(): Window['api'] | null {
  return typeof window.api?.listAccounts === 'function' ? window.api : null
}

function AccountsSection(): React.JSX.Element {
  const accounts = useAppStore((s) => s.accounts)
  const connected = useAppStore((s) => s.connected)
  const init = useAppStore((s) => s.init)
  const api = mailApi()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SyncStatus[]>([])

  // Poll backfill progress while settings is open
  useEffect(() => {
    if (!api || !connected) return undefined
    let cancelled = false
    const tick = (): void => {
      void api.syncStatus().then((s) => {
        if (!cancelled) setStatus(s)
      })
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const addAccount = async (): Promise<void> => {
    if (!api || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.addAccount()
      await init()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const removeAccount = async (id: string): Promise<void> => {
    if (!api) return
    await api.removeAccount(id)
    await init()
  }

  const statusFor = (id: string): SyncStatus | undefined => status.find((s) => s.accountId === id)

  return (
    <>
      <SectionLabel>Accounts</SectionLabel>
      {accounts.map((account) => {
        const st = connected ? statusFor(account.id) : undefined
        const name = account.identity.name ?? account.name
        return (
          <div key={account.id} className="group flex items-center gap-3 py-[9px]">
            <Avatar initials={initialsOf(name)} color={account.color} />
            <span className="truncate text-[13.5px] text-strong">{name}</span>
            <span className="flex-1" />
            <span className="truncate text-[12px] text-meta">{account.identity.address}</span>
            {st && (
              <span className="shrink-0 text-[12px] text-label">
                {st.messageCount.toLocaleString()} {st.backfillDone ? 'synced' : 'syncing…'}
              </span>
            )}
            {connected && (
              <button
                aria-label={`Remove ${account.identity.address}`}
                title="Remove account"
                onClick={() => void removeAccount(account.id)}
                className="-my-1 rounded-[5px] px-1.5 py-0.5 text-[12px] text-label opacity-0 transition-all hover:bg-hover hover:text-danger group-hover:opacity-100"
              >
                ✕
              </button>
            )}
          </div>
        )
      })}

      {api && (
        <button
          onClick={() => void addAccount()}
          disabled={busy}
          className="-mx-3 flex items-center gap-2 rounded-[8px] px-3 py-[9px] text-[13px] text-accent transition-colors hover:bg-row disabled:text-label"
        >
          {busy ? (
            <>
              <Spinner /> Waiting for Google sign-in in your browser…
            </>
          ) : (
            '+ Add Gmail account'
          )}
        </button>
      )}
      {error && <div className="py-2 text-[12px] text-danger">{error}</div>}
      {!connected && !busy && (
        <div className="py-1 text-[12px] text-label">
          No account connected yet — add your Gmail to start syncing.
        </div>
      )}
    </>
  )
}

export default function SettingsView(): React.JSX.Element {
  const connected = useAppStore((s) => s.connected)
  const hideDone = useAppStore((s) => s.hideDone)
  const toggleHideDone = useAppStore((s) => s.toggleHideDone)
  const showWordCount = useAppStore((s) => s.showWordCount)
  const toggleShowWordCount = useAppStore((s) => s.toggleShowWordCount)
  const signature = useAppStore((s) => s.signature)
  const setSignature = useAppStore((s) => s.setSignature)

  return (
    <Page tight>
      <BackLink />
      <div className="mt-[18px] text-[15px] font-semibold text-ink">Settings</div>

      <div className="max-w-[640px]">
        <AccountsSection />

        <SectionLabel>Preferences</SectionLabel>
        <div className="flex items-center py-[9px]">
          <span className="text-[13.5px] text-strong">Hide done emails</span>
          <span className="flex-1" />
          <Toggle on={hideDone} onToggle={toggleHideDone} label="Hide done emails" />
        </div>
        <div className="flex items-center py-[9px]">
          <span className="text-[13.5px] text-strong">Show word count while composing</span>
          <span className="flex-1" />
          <Toggle
            on={showWordCount}
            onToggle={toggleShowWordCount}
            label="Show word count while composing"
          />
        </div>
        <div className="pb-1 pt-[9px] text-[13.5px] text-strong">Signature</div>
        <textarea
          aria-label="Signature"
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          placeholder="— Your name"
          className="select-text block min-h-[44px] w-full resize-y rounded-[8px] border border-line-strong bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-dim outline-none placeholder:text-hint focus:border-edge"
        />

        <SectionLabel>About</SectionLabel>
        <div className="py-[9px] text-[12px] text-meta">
          Flint · v0.1.0 · {connected ? 'live Gmail data' : 'no account connected'}
        </div>
      </div>
    </Page>
  )
}
