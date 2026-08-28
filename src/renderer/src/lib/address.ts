import type { Mailbox } from '../data/types'

/**
 * Minimal RFC 5322 address-list parsing/formatting. Handles the forms real
 * clients emit: `Name <addr>`, `"Last, First" <addr>`, bare `addr`, and
 * comma-separated lists. Not a full grammar (no groups, comments, or
 * encoded-words) — mock data never produces those.
 */

export function isValidAddress(address: string): boolean {
  return /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/.test(address)
}

/** Split on commas that are outside quotes and angle brackets */
function splitList(input: string): string[] {
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
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Parse one name-addr or bare address; returns null when no plausible address present */
export function parseMailbox(input: string): Mailbox | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const angle = trimmed.match(/^(.*?)<([^<>]+)>$/)
  if (angle) {
    const address = angle[2].trim()
    let name: string | undefined = angle[1].trim()
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1').trim()
    }
    if (!name) name = undefined
    return isValidAddress(address) ? { name, address } : null
  }
  return isValidAddress(trimmed) ? { address: trimmed } : null
}

/** Parse a To/Cc field's raw text into mailboxes, dropping invalid entries */
export function parseAddressList(input: string): Mailbox[] {
  return splitList(input)
    .map(parseMailbox)
    .filter((m): m is Mailbox => m !== null)
}

/** RFC 5322 name-addr serialization, quoting the display name when required */
export function formatMailbox(mailbox: Mailbox): string {
  if (!mailbox.name) return mailbox.address
  const needsQuotes = /[,<>@:;."\\]/.test(mailbox.name)
  const name = needsQuotes ? `"${mailbox.name.replace(/(["\\])/g, '\\$1')}"` : mailbox.name
  return `${name} <${mailbox.address}>`
}

export function formatAddressList(mailboxes: Mailbox[]): string {
  return mailboxes.map(formatMailbox).join(', ')
}
