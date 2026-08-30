import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeft, Check, Loader2, Plus, X } from 'lucide-react'
import type { GoogleConfig, SyncStatus } from '../../../preload/index.d'
import { resolveMailbox } from '../lib/identity'
import { useAppStore } from '../store'
import { cn } from '../lib/utils'

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

interface SectionProps {
  label: string
  children: React.ReactNode
}

function Section({ label, children }: SectionProps): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="rounded-[12px] bg-elevation-1 border border-white/5 divide-y divide-white/5">
        {children}
      </div>
    </div>
  )
}

const inputClass =
  'select-text w-full rounded-[8px] border border-white/10 bg-elevation-0 p-2.5 text-[13px] text-text-primary outline-none placeholder:text-text-muted'

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

  const [config, setConfig] = useState<GoogleConfig>({ clientId: '', clientSecret: '' })
  const [showConfig, setShowConfig] = useState(false)
  const [configSaved, setConfigSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SyncStatus[]>([])

  useEffect(() => {
    if (!api) return
    void api.getGoogleConfig().then((cfg) => {
      setConfig(cfg)
      setShowConfig(!cfg.clientId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const saveConfig = async (): Promise<void> => {
    if (!api) return
    await api.setGoogleConfig(config)
    setConfigSaved(true)
    window.setTimeout(() => setConfigSaved(false), 1500)
  }

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
      <Section label="Accounts">
        {accounts.map((account) => {
          const st = connected ? statusFor(account.id) : undefined
          return (
            <div key={account.id} className="flex h-12 items-center gap-3 px-4">
              <span
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ backgroundColor: account.color }}
              >
                {initialsOf(account.identity.name ?? account.name)}
              </span>
              <span className="text-[13px] text-text-primary">
                {account.identity.name ?? account.name}
              </span>
              <span className="ml-auto text-[12px] text-text-secondary">
                {account.identity.address}
              </span>
              {st && (
                <span className="shrink-0 text-[11px] text-text-muted">
                  {st.messageCount.toLocaleString()} {st.backfillDone ? 'synced' : 'syncing…'}
                </span>
              )}
              {connected && (
                <button
                  aria-label={`Remove ${account.identity.address}`}
                  onClick={() => void removeAccount(account.id)}
                  className="shrink-0 text-text-muted transition-colors hover:text-red-3"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )
        })}

        {api && (
          <button
            onClick={() => void addAccount()}
            disabled={busy || !config.clientId}
            className={cn(
              'flex h-12 w-full items-center gap-3 px-4 text-[13px] transition-colors',
              busy || !config.clientId
                ? 'cursor-default text-text-muted'
                : 'text-text-bright hover:text-ink'
            )}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {busy
              ? 'Waiting for Google sign-in in your browser…'
              : config.clientId
                ? 'Add Gmail account'
                : 'Add Gmail account (configure the Google API client below first)'}
          </button>
        )}
        {error && <div className="px-4 py-3 text-[12px] text-red-3">{error}</div>}
        {!connected && (
          <div className="px-4 py-3 text-[11px] text-text-muted">
            No real account connected — the app is showing sample data.
          </div>
        )}
      </Section>

      {api && (
        <Section label="Google API client">
          <div className="flex flex-col gap-2.5 px-4 py-3">
            {showConfig ? (
              <>
                <span className="text-[12px] leading-[1.5] text-text-secondary">
                  One-time setup: create an OAuth client (type “Desktop app”) in Google Cloud
                  Console under APIs &amp; Services → Credentials, enable the Gmail API, and paste
                  the client ID and secret here.
                </span>
                <input
                  value={config.clientId}
                  onChange={(e) => setConfig((c) => ({ ...c, clientId: e.target.value }))}
                  placeholder="Client ID (…apps.googleusercontent.com)"
                  className={inputClass}
                />
                <input
                  value={config.clientSecret}
                  onChange={(e) => setConfig((c) => ({ ...c, clientSecret: e.target.value }))}
                  placeholder="Client secret"
                  className={inputClass}
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void saveConfig()}
                    className="rounded-[8px] bg-elevation-2 px-3 py-1.5 text-[12px] text-text-bright transition-colors hover:text-ink"
                  >
                    {configSaved ? 'Saved' : 'Save'}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center">
                <span className="text-[12px] text-text-secondary">
                  Configured · {config.clientId.slice(0, 24)}…
                </span>
                <button
                  onClick={() => setShowConfig(true)}
                  className="ml-auto text-[12px] text-text-bright transition-colors hover:text-ink"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        </Section>
      )}
    </>
  )
}

const CONTACTS_SHOWN = 8

export default function SettingsView(): React.JSX.Element {
  const back = useAppStore((s) => s.back)
  const connected = useAppStore((s) => s.connected)
  const hideDone = useAppStore((s) => s.hideDone)
  const toggleHideDone = useAppStore((s) => s.toggleHideDone)
  const showWordCount = useAppStore((s) => s.showWordCount)
  const toggleShowWordCount = useAppStore((s) => s.toggleShowWordCount)
  const signature = useAppStore((s) => s.signature)
  const setSignature = useAppStore((s) => s.setSignature)
  const contacts = useAppStore((s) => s.contacts)

  // Collected (auto-learned) contacts sort first so they are visible despite the cap
  const shownContacts = [...contacts]
    .sort((a, b) => (a.source === 'collected' ? -1 : 0) - (b.source === 'collected' ? -1 : 0))
    .slice(0, CONTACTS_SHOWN)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="relative h-full flex flex-col"
    >
      <div className="drag-region flex items-center px-[30px] pt-[40px] pb-2">
        <div className="no-drag flex items-center">
          <button
            aria-label="Back"
            onClick={back}
            className="flex h-[28px] w-[34px] items-center justify-center rounded-[8px] bg-elevation-2 text-text-bright transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="ml-3.5 text-[15px] font-semibold text-text-primary">Settings</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-[30px] pb-10">
        <div className="flex max-w-[640px] flex-col gap-8 pt-4">
          <AccountsSection />

          <Section label="Contacts">
            {shownContacts.map((contact) => {
              const resolved = resolveMailbox({ address: contact.address }, contacts)
              return (
                <div key={contact.address} className="flex h-12 items-center gap-3 px-4">
                  <span
                    className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                    style={{ backgroundColor: resolved.color }}
                  >
                    {resolved.initials}
                  </span>
                  <span className="truncate text-[13px] text-text-primary">{contact.name}</span>
                  {contact.source === 'collected' && (
                    <span className="shrink-0 text-[10px] text-text-muted">auto</span>
                  )}
                  <span className="ml-auto truncate text-[12px] text-text-secondary">
                    {contact.address}
                  </span>
                </div>
              )
            })}
            {contacts.length > shownContacts.length && (
              <div className="flex h-9 items-center px-4 text-[11px] text-text-muted">
                {contacts.length} contacts
              </div>
            )}
          </Section>

          <Section label="Preferences">
            <div className="flex h-12 items-center px-4">
              <span className="text-[13px] text-text-primary">Hide done emails</span>
              <button
                aria-label={hideDone ? 'Show done emails' : 'Hide done emails'}
                onClick={toggleHideDone}
                className={cn(
                  'relative ml-auto h-[18px] w-[34px] rounded-full transition-colors duration-150',
                  hideDone ? 'bg-blue-4' : 'bg-elevation-3'
                )}
              >
                <span
                  className={cn(
                    'absolute top-[2px] flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white transition-all duration-150',
                    hideDone ? 'left-[18px]' : 'left-[2px]'
                  )}
                >
                  <Check size={10} strokeWidth={3} className="text-elevation-2" />
                </span>
              </button>
            </div>
            <div className="flex h-12 items-center px-4">
              <span className="text-[13px] text-text-primary">Show word count while composing</span>
              <button
                aria-label={showWordCount ? 'Hide word count' : 'Show word count'}
                onClick={toggleShowWordCount}
                className={cn(
                  'relative ml-auto h-[18px] w-[34px] rounded-full transition-colors duration-150',
                  showWordCount ? 'bg-blue-4' : 'bg-elevation-3'
                )}
              >
                <span
                  className={cn(
                    'absolute top-[2px] flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white transition-all duration-150',
                    showWordCount ? 'left-[18px]' : 'left-[2px]'
                  )}
                >
                  <Check size={10} strokeWidth={3} className="text-elevation-2" />
                </span>
              </button>
            </div>
            <div className="flex flex-col items-start px-4 py-3">
              <span className="text-[13px] text-text-primary">Signature</span>
              <textarea
                aria-label="Signature"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                className="select-text mt-2 min-h-[64px] w-full resize-none rounded-[8px] border border-white/10 bg-elevation-0 p-2.5 text-[13px] text-text-primary outline-none"
              />
            </div>
          </Section>

          <Section label="About">
            <div className="flex h-12 items-center px-4 text-[12px] text-text-secondary">
              Spark clone · v0.1.0 · {connected ? 'live Gmail data' : 'mock data'}
            </div>
          </Section>
        </div>
      </div>
    </motion.div>
  )
}
