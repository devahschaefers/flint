import type { WireAccount, WireMessage } from '../../../preload/index.d'
import type { Account, Category, Contact, Message } from '../data/types'

/** Mapping between the IPC wire shapes (SQLite rows) and the renderer's domain types */

function toParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export function wireToMessage(w: WireMessage): Message {
  return {
    messageId: w.messageIdHdr ?? `<gmail-${w.gmailId}@sync.local>`,
    inReplyTo: w.inReplyTo ?? undefined,
    references: w.references,
    from: w.from,
    to: w.to,
    cc: w.cc,
    replyTo: w.replyTo ?? undefined,
    subject: w.subject,
    date: new Date(w.dateMs).toISOString(),
    body: toParagraphs(w.bodyText || w.snippet),
    bodyHtml: w.bodyHtml ?? undefined,
    gmailId: w.gmailId,
    threadId: w.threadId,
    accountId: w.accountId,
    folder: w.folder,
    flags: { seen: w.seen, flagged: w.flagged, answered: w.answered },
    category: w.category as Category,
    important: w.important
  }
}

/** Label real accounts by address — with several Gmail accounts the email IS the name */
export function wireToAccount(a: WireAccount): Account {
  return {
    id: a.id,
    name: a.email,
    identity: { name: a.name, address: a.email },
    color: a.color
  }
}

const CONTACTS_CAP = 1000

/** Address book derived from correspondence (senders first, then recipients) */
export function deriveContacts(messages: Message[], ownAddresses: Set<string>): Contact[] {
  const byAddress = new Map<string, Contact>()
  const collect = (name: string | undefined, address: string): void => {
    const key = address.toLowerCase()
    if (!name || ownAddresses.has(key) || byAddress.has(key)) return
    if (byAddress.size >= CONTACTS_CAP) return
    byAddress.set(key, { address: key, name, source: 'collected' })
  }
  for (const m of messages) {
    collect(m.from.name, m.from.address)
  }
  for (const m of messages) {
    for (const r of [...m.to, ...m.cc]) collect(r.name, r.address)
  }
  return [...byAddress.values()]
}
