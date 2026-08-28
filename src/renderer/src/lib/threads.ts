import type { Category, Folder, Message } from '../data/types'

/**
 * Conversation threading derived from RFC 5322 In-Reply-To/References chains,
 * the way Gmail/Spark build conversations. Threads are always computed from
 * the flat message list — never stored.
 */

export interface Thread {
  /** Root Message-ID */
  id: string
  /** All messages, date ascending */
  messages: Message[]
  /** Newest message — what list rows display */
  latest: Message
  /** Subject with reply prefixes stripped ("Re: Re: X" → "X") */
  subject: string
  /** Any message unseen */
  unread: boolean
  /** Any message flagged (pinned) */
  flagged: boolean
  category: Category
  important: boolean
}

export function threadRootId(message: Message): string {
  return message.references[0] ?? message.messageId
}

export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?)\s*:\s*)+/i, '').trim()
}

/** Build threads from a flat message list, newest-latest first */
export function buildThreads(messages: Message[]): Thread[] {
  const byRoot = new Map<string, Message[]>()
  for (const m of messages) {
    const root = threadRootId(m)
    const list = byRoot.get(root) ?? []
    list.push(m)
    byRoot.set(root, list)
  }
  const threads: Thread[] = []
  for (const [id, list] of byRoot) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    const latest = list[list.length - 1]
    const root = list[0]
    threads.push({
      id,
      messages: list,
      latest,
      subject: normalizeSubject(root.subject) || '(no subject)',
      unread: list.some((m) => !m.flags.seen),
      flagged: list.some((m) => m.flags.flagged),
      category: latest.category,
      important: list.some((m) => m.important)
    })
  }
  threads.sort((a, b) => b.latest.date.localeCompare(a.latest.date))
  return threads
}

/**
 * Threads that belong in a folder list (Gmail semantics: a conversation shows
 * in a folder when any of its messages live there). The thread's `latest` may
 * be in another folder; lists should still render the thread once.
 */
export function threadsInFolder(threads: Thread[], folder: Folder): Thread[] {
  return threads.filter((t) => t.messages.some((m) => m.folder === folder))
}

/** Inbox visibility: in inbox, and (unless showing archived) not fully archived */
export function inboxThreads(threads: Thread[], includeArchived: boolean): Thread[] {
  return threads.filter((t) =>
    t.messages.some((m) => m.folder === 'inbox' || (includeArchived && m.folder === 'archive'))
  )
}
