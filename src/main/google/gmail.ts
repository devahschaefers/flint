/**
 * Hand-rolled Gmail REST client (the API surface we need is small: list, get,
 * history, label modify). Token acquisition/refresh is injected so the sync
 * engine owns credential state.
 */

import type { Folder } from '../../preload/index.d'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

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

interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

export interface HistoryEntry {
  id: string
  messagesAdded?: { message: { id: string; threadId: string } }[]
  messagesDeleted?: { message: { id: string } }[]
  labelsAdded?: { message: GmailMessage }[]
  labelsRemoved?: { message: GmailMessage }[]
}

export type GetToken = (forceRefresh: boolean) => Promise<string>

const RETRIABLE = new Set([429, 500, 502, 503])

export class GmailApi {
  constructor(private getToken: GetToken) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let forceRefresh = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(forceRefresh)
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init?.headers
        }
      })
      if (res.ok) {
        const text = await res.text()
        return (text ? JSON.parse(text) : {}) as T
      }
      if (res.status === 401 && attempt === 0) {
        forceRefresh = true
        continue
      }
      if (RETRIABLE.has(res.status) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
      throw new GmailError(res.status, `Gmail ${path} failed: ${res.status} ${await res.text()}`)
    }
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.req('/profile')
  }

  async listMessageIds(
    pageToken?: string
  ): Promise<{ ids: string[]; nextPageToken?: string }> {
    const params = new URLSearchParams({ maxResults: '100', includeSpamTrash: 'true' })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await this.req<{
      messages?: { id: string }[]
      nextPageToken?: string
    }>(`/messages?${params}`)
    return { ids: (res.messages ?? []).map((m) => m.id), nextPageToken: res.nextPageToken }
  }

  async getMessage(id: string): Promise<ParsedMessage | null> {
    try {
      const res = await this.req<GmailMessage>(`/messages/${id}?format=full`)
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
    const params = new URLSearchParams({ startHistoryId, maxResults: '100' })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await this.req<{
      history?: HistoryEntry[]
      historyId?: string
      nextPageToken?: string
    }>(`/history?${params}`)
    return { history: res.history ?? [], historyId: res.historyId, nextPageToken: res.nextPageToken }
  }

  async batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.req('/messages/batchModify', {
      method: 'POST',
      body: JSON.stringify({ ids, addLabelIds, removeLabelIds })
    })
  }

  async trash(id: string): Promise<void> {
    await this.req(`/messages/${id}/trash`, { method: 'POST' })
  }

  async untrash(id: string): Promise<void> {
    await this.req(`/messages/${id}/untrash`, { method: 'POST' })
  }
}

// ---------- parsing ----------

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
function extractBodies(part: GmailPart | undefined): {
  text: string
  html: string | null
  hasCalendar: boolean
} {
  let text = ''
  let html: string | null = null
  let hasCalendar = false
  const walk = (p: GmailPart | undefined): void => {
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

export function parseGmailMessage(res: GmailMessage): ParsedMessage {
  const headers = new Map<string, string>()
  for (const h of res.payload?.headers ?? []) {
    const key = h.name.toLowerCase()
    if (!headers.has(key)) headers.set(key, h.value)
  }
  const labels = res.labelIds ?? []
  const { text, html, hasCalendar } = extractBodies(res.payload)
  const from = parseAddressList(headers.get('from'))[0] ?? { address: '' }
  const replyTo = parseAddressList(headers.get('reply-to'))[0] ?? null
  const references = (headers.get('references') ?? '')
    .split(/\s+/)
    .filter((r) => r.startsWith('<'))
  const state = labelsToState(labels)

  return {
    gmailId: res.id,
    threadId: res.threadId,
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
