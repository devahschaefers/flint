import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import type { GoogleConfig, LocalMessageInput, MailAction, WireMailbox } from '../preload/index.d'

/**
 * Runtime checks for everything that crosses the IPC boundary. TypeScript only
 * types the contract; a compromised renderer (or a stray frame that somehow
 * reached the bridge) can send anything, so each handler verifies the sender
 * and re-derives the payload shape before touching the database or Gmail.
 *
 * Every guard throws a plain Error naming the offending field so the
 * renderer's `invoke` promise rejects with a readable message.
 */

// ---------- sender ----------

/**
 * The renderer origin we load ourselves: the Vite dev server in development,
 * the packaged `out/renderer/index.html` otherwise. Computed lazily because
 * `__dirname` is only meaningful once the main bundle is running.
 */
let rendererOrigin: { kind: 'http'; origin: string } | { kind: 'file'; href: string } | null = null

function ownRendererOrigin(): NonNullable<typeof rendererOrigin> {
  if (rendererOrigin) return rendererOrigin
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    rendererOrigin = { kind: 'http', origin: new URL(devUrl).origin }
  } else {
    rendererOrigin = {
      kind: 'file',
      href: pathToFileURL(join(__dirname, '../renderer/index.html')).href
    }
  }
  return rendererOrigin
}

/** Drop query and fragment so `file:///.../index.html#/inbox` still matches. */
function stripQueryAndHash(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/**
 * Accept the call only when it comes from the top frame of one of our own
 * windows, loaded from our own renderer URL. Sub-frames (rendered mail) and
 * any navigated-away document are rejected.
 */
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (!frame) throw new Error('IPC rejected: sender frame is gone')

  const ownWindow = BrowserWindow.getAllWindows().some((w) => w.webContents === event.sender)
  if (!ownWindow) throw new Error('IPC rejected: sender is not an app window')
  if (frame !== event.sender.mainFrame) throw new Error('IPC rejected: sender is a sub-frame')

  const own = ownRendererOrigin()
  const ok =
    own.kind === 'http'
      ? new URL(frame.url).origin === own.origin
      : stripQueryAndHash(frame.url) === own.href
  if (!ok) throw new Error(`IPC rejected: untrusted sender ${frame.url}`)
}

// ---------- primitives ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v
}

export function asOptionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  return asString(v, name)
}

export function asBoolean(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${name} must be a boolean`)
  return v
}

export function asOptionalBoolean(v: unknown, name: string): boolean | undefined {
  if (v === undefined) return undefined
  return asBoolean(v, name)
}

export function asFiniteNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`${name} must be a finite number`)
  return v
}

export function asStringArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`)
  return v.map((item, i) => asString(item, `${name}[${i}]`))
}

/** `null` means "all" for the outbox bulk calls; otherwise an array of ids. */
export function asIdListOrNull(v: unknown, name: string): number[] | null {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v)) throw new Error(`${name} must be an array or null`)
  return v.map((item, i) => {
    const n = asFiniteNumber(item, `${name}[${i}]`)
    if (!Number.isInteger(n)) throw new Error(`${name}[${i}] must be an integer`)
    return n
  })
}

export function asObject(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${name} must be an object`)
  return v
}

// ---------- domain types ----------

const MAIL_ACTIONS: readonly MailAction[] = [
  'seen',
  'flagged',
  'archive',
  'unarchive',
  'trash',
  'spam',
  'inbox'
]

export function asMailAction(v: unknown, name: string): MailAction {
  if (typeof v !== 'string' || !(MAIL_ACTIONS as readonly string[]).includes(v)) {
    throw new Error(`${name} must be one of ${MAIL_ACTIONS.join(', ')}`)
  }
  return v as MailAction
}

export function asMailbox(v: unknown, name: string): WireMailbox {
  const o = asObject(v, name)
  const box: WireMailbox = { address: asString(o.address, `${name}.address`) }
  const mailboxName = asOptionalString(o.name, `${name}.name`)
  if (mailboxName !== undefined) box.name = mailboxName
  return box
}

export function asMailboxArray(v: unknown, name: string): WireMailbox[] {
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`)
  return v.map((item, i) => asMailbox(item, `${name}[${i}]`))
}

export function asGoogleConfig(v: unknown): GoogleConfig {
  const o = asObject(v, 'config')
  return {
    clientId: asString(o.clientId, 'config.clientId'),
    clientSecret: asString(o.clientSecret, 'config.clientSecret')
  }
}

/**
 * Rebuilds the input field by field rather than passing the renderer's object
 * through, so unexpected keys never reach the outbox.
 */
export function asLocalMessageInput(v: unknown, name = 'input'): LocalMessageInput {
  const o = asObject(v, name)
  const out: LocalMessageInput = {
    accountId: asString(o.accountId, `${name}.accountId`),
    to: asMailboxArray(o.to, `${name}.to`),
    cc: asMailboxArray(o.cc, `${name}.cc`),
    subject: asString(o.subject, `${name}.subject`),
    text: asString(o.text, `${name}.text`),
    references: asStringArray(o.references, `${name}.references`)
  }
  const optional = ['messageIdHdr', 'html', 'inReplyTo', 'threadId', 'category'] as const
  for (const key of optional) {
    const val = asOptionalString(o[key], `${name}.${key}`)
    if (val !== undefined) out[key] = val
  }
  return out
}
