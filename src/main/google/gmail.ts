/**
 * Thin adapter over Google's official Gmail client (@googleapis/gmail).
 * Normalizes the SDK's nullable schema types into the concrete shapes the sync
 * engine consumes, and maps transport errors to GmailError so callers keep
 * status-code semantics (the history-expired 404 fallback relies on it).
 */

import { gmail, gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import type { Folder } from '../../preload/index.d'

export class GmailError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

interface Mailbox {
  name?: string
  address: string
}

/** Provider-agnostic parsed message (db.MsgRecord minus accountId) */
export interface ParsedMessage {
  gmailId: string
  threadId: string
  messageIdHdr: string | null
  inReplyTo: string | null
  references: string[]
  fromName: string | null
  fromAddr: string
  to: Mailbox[]
  cc: Mailbox[]
  replyTo: Mailbox | null
  subject: string
  dateMs: number
  snippet: string
  bodyText: string
  bodyHtml: string | null
  folder: Folder
  seen: boolean
  flagged: boolean
  category: string
  important: boolean
}

/** One history record, normalized (nulls dropped) */
export interface HistoryEntry {
  messagesAdded: { id: string }[]
  messagesDeleted: { id: string }[]
  labelChanges: { id: string; labelIds: string[] }[]
}

const RETRIABLE = new Set([429, 500, 502, 503])

function errorStatus(err: unknown): number {
  const e = err as { response?: { status?: number }; status?: number }
  return e.response?.status ?? e.status ?? 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class GmailApi {
  private g: gmail_v1.Gmail

  constructor(auth: OAuth2Client) {
    this.g = gmail({ version: 'v1', auth })
  }

  /** Run an SDK call with backoff on transient failures; rethrow as GmailError */
  private async call<T>(label: string, fn: () => Promise<{ data: T }>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await fn()).data
      } catch (err) {
        const status = errorStatus(err)
        if (RETRIABLE.has(status) && attempt < 3) {
          await sleep(1000 * 2 ** attempt)
          continue
        }
        throw new GmailError(status, `Gmail ${label} failed: ${(err as Error).message}`)
      }
    }
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    const p = await this.call('getProfile', () => this.g.users.getProfile({ userId: 'me' }))
    return { emailAddress: p.emailAddress ?? '', historyId: p.historyId ?? '' }
  }

  async listMessageIds(pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
    const res = await this.call('messages.list', () =>
      this.g.users.messages.list({
        userId: 'me',
        maxResults: 100,
        includeSpamTrash: true,
        pageToken
      })
    )
    return {
      ids: (res.messages ?? []).flatMap((m) => (m.id ? [m.id] : [])),
      nextPageToken: res.nextPageToken ?? undefined
    }
  }

  async getMessage(id: string): Promise<ParsedMessage | null> {
    try {
      const res = await this.call('messages.get', () =>
        this.g.users.messages.get({ userId: 'me', id, format: 'full' })
      )
      return parseGmailMessage(res)
    } catch (err) {
      // Messages can vanish between list and get (e.g. spam purge)
      if (err instanceof GmailError && err.status === 404) return null
      throw err
    }
  }

  async listHistory(
    startHistoryId: string,
    pageToken?: string
  ): Promise<{ history: HistoryEntry[]; historyId?: string; nextPageToken?: string }> {
    const res = await this.call('history.list', () =>
      this.g.users.history.list({ userId: 'me', startHistoryId, maxResults: 100, pageToken })
    )
    const history = (res.history ?? []).map(
      (h): HistoryEntry => ({
        messagesAdded: (h.messagesAdded ?? []).flatMap((m) =>
          m.message?.id ? [{ id: m.message.id }] : []
        ),
        messagesDeleted: (h.messagesDeleted ?? []).flatMap((m) =>
          m.message?.id ? [{ id: m.message.id }] : []
        ),
        labelChanges: [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])].flatMap((l) =>
          l.message?.id ? [{ id: l.message.id, labelIds: l.message.labelIds ?? [] }] : []
        )
      })
    )
    return {
      history,
      historyId: res.historyId ?? undefined,
      nextPageToken: res.nextPageToken ?? undefined
    }
  }

  async batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.call('messages.batchModify', () =>
      this.g.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids, addLabelIds, removeLabelIds }
      })
    )
  }

  async trash(id: string): Promise<void> {
    await this.call('messages.trash', () => this.g.users.messages.trash({ userId: 'me', id }))
  }

  async untrash(id: string): Promise<void> {
    await this.call('messages.untrash', () => this.g.users.messages.untrash({ userId: 'me', id }))
  }
}

// ---------- parsing (unchanged pipeline; mailparser adoption is a later phase) ----------

/** Minimal RFC 5322 address-list parser (same forms the renderer's lib handles) */
export function parseAddressList(input: string | undefined): Mailbox[] {
  if (!input) return []
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let inAngle = false
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === '<' && !inQuotes) inAngle = true
    else if (ch === '>' && !inQuotes) inAngle = false
    if (ch === ',' && !inQuotes && !inAngle) {
      parts.push(current)
      current = ''
    } else current += ch
  }
  parts.push(current)

  const out: Mailbox[] = []
  for (const raw of parts) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const angle = trimmed.match(/^(.*?)<([^<>]+)>\s*$/)
    if (angle) {
      const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim()
      const address = angle[2].trim().toLowerCase()
      if (address.includes('@')) out.push(name ? { name, address } : { address })
    } else if (trimmed.includes('@')) {
      out.push({ address: trimmed.replace(/^<|>$/g, '').toLowerCase() })
    }
  }
  return out
}

function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** Depth-first walk for the first text/plain and text/html parts + calendar detection */
function extractBodies(part: gmail_v1.Schema$MessagePart | undefined): {
  text: string
  html: string | null
  hasCalendar: boolean
} {
  let text = ''
  let html: string | null = null
  let hasCalendar = false
  const walk = (p: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!p) return
    const mime = p.mimeType ?? ''
    if (mime === 'text/calendar' || (p.filename ?? '').toLowerCase().endsWith('.ics')) {
      hasCalendar = true
    }
    if (mime === 'text/plain' && !text && p.body?.data) text = decodeBody(p.body.data)
    else if (mime === 'text/html' && !html && p.body?.data) html = decodeBody(p.body.data)
    for (const child of p.parts ?? []) walk(child)
  }
  walk(part)
  return { text, html, hasCalendar }
}

/** Gmail snippets are HTML-entity encoded */
function decodeSnippet(snippet: string): string {
  return snippet
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export function labelsToState(labels: string[]): {
  folder: Folder
  seen: boolean
  flagged: boolean
  important: boolean
} {
  const has = (l: string): boolean => labels.includes(l)
  let folder: Folder = 'archive'
  if (has('DRAFT')) folder = 'drafts'
  else if (has('SPAM')) folder = 'spam'
  else if (has('TRASH')) folder = 'trash'
  else if (has('INBOX')) folder = 'inbox'
  else if (has('SENT')) folder = 'sent'
  return {
    folder,
    seen: !has('UNREAD'),
    flagged: has('STARRED'),
    important: has('IMPORTANT')
  }
}

function categoryOf(labels: string[], hasCalendar: boolean): string {
  if (hasCalendar) return 'invites'
  if (labels.includes('CATEGORY_PERSONAL')) return 'people'
  if (
    labels.includes('CATEGORY_UPDATES') ||
    labels.includes('CATEGORY_PROMOTIONS') ||
    labels.includes('CATEGORY_SOCIAL') ||
    labels.includes('CATEGORY_FORUMS')
  ) {
    return 'notifications'
  }
  return 'people'
}

export function parseGmailMessage(res: gmail_v1.Schema$Message): ParsedMessage {
  const headers = new Map<string, string>()
  for (const h of res.payload?.headers ?? []) {
    const key = h.name?.toLowerCase()
    if (key && h.value != null && !headers.has(key)) headers.set(key, h.value)
  }
  const labels = res.labelIds ?? []
  const { text, html, hasCalendar } = extractBodies(res.payload ?? undefined)
  const from = parseAddressList(headers.get('from'))[0] ?? { address: '' }
  const replyTo = parseAddressList(headers.get('reply-to'))[0] ?? null
  const references = (headers.get('references') ?? '')
    .split(/\s+/)
    .filter((r) => r.startsWith('<'))
  const state = labelsToState(labels)

  return {
    gmailId: res.id ?? '',
    threadId: res.threadId ?? '',
    messageIdHdr: headers.get('message-id') ?? null,
    inReplyTo: headers.get('in-reply-to') ?? null,
    references,
    fromName: from.name ?? null,
    fromAddr: from.address,
    to: parseAddressList(headers.get('to')),
    cc: parseAddressList(headers.get('cc')),
    replyTo,
    subject: headers.get('subject') ?? '',
    dateMs: Number(res.internalDate ?? Date.now()),
    snippet: decodeSnippet(res.snippet ?? ''),
    bodyText: text,
    bodyHtml: html,
    ...state,
    category: categoryOf(labels, hasCalendar)
  }
}
