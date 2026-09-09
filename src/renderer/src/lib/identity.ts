import type { Contact, Mailbox } from '../data/types'

/**
 * Display-identity resolution, the way real clients do it:
 * 1. your contact's name for the address (address book wins)
 * 2. the display name carried on the message (RFC 5322 name-addr)
 * 3. the bare address — never a name fabricated from the address string
 * Avatar color is hashed from the ADDRESS, so an identity keeps its color
 * no matter which display name a given message carried.
 */

export interface ResolvedIdentity {
  name: string
  initials: string
  color: string
  /** True when we had nothing but the raw address to show */
  isBareAddress: boolean
}

/**
 * One oklch family (same lightness and chroma, hue steps of 36°) so people-color
 * reads as designed rather than random; every avatar sits at the same weight.
 */
const AVATAR_COLORS = [
  '#a3575f',
  '#9f5f37',
  '#8b6d1f',
  '#677b34',
  '#33835c',
  '#008384',
  '#207ba1',
  '#576fac',
  '#7d62a2',
  '#975985'
]

export function colorForAddress(address: string): string {
  const key = address.toLowerCase()
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function initialsOf(name: string, isBareAddress: boolean): string {
  if (isBareAddress) return name[0]?.toUpperCase() ?? '?'
  const parts = name.split(/\s+/).filter(Boolean)
  const initials = parts
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('')
  return initials || '?'
}

export function contactFor(address: string, contacts: Contact[]): Contact | undefined {
  const key = address.toLowerCase()
  return contacts.find((c) => c.address === key)
}

export function resolveMailbox(mailbox: Mailbox, contacts: Contact[]): ResolvedIdentity {
  const contact = contactFor(mailbox.address, contacts)
  const name = contact?.name ?? mailbox.name
  const isBareAddress = !name
  const display = name ?? mailbox.address
  return {
    name: display,
    initials: initialsOf(display, isBareAddress),
    color: colorForAddress(mailbox.address),
    isBareAddress
  }
}

/** "Mom, Priya Raghavan" — resolved display names for a recipient list */
export function resolveNames(mailboxes: Mailbox[], contacts: Contact[]): string {
  return mailboxes.map((m) => resolveMailbox(m, contacts).name).join(', ')
}
