/**
 * Email primitives modeled on the real standards:
 * - RFC 5322 name-addr mailboxes and message headers (From/To/Cc, Message-ID,
 *   In-Reply-To, References)
 * - IMAP-style flags (\Seen, \Flagged, \Answered) and folder placement
 * Client-side concepts (smart-inbox category, importance) live alongside but
 * are clearly separated from wire-format fields.
 */

/** RFC 5322 name-addr: optional display name + required address ("Mom <linda@comcast.net>") */
export interface Mailbox {
  name?: string
  address: string
}

export type Category = 'notifications' | 'people' | 'invites'

/** IMAP-style mailbox placement. Archive is a real folder (what "done" moves mail to). */
export type Folder = 'inbox' | 'archive' | 'sent' | 'drafts' | 'trash' | 'spam'

/** IMAP-style per-message flags */
export interface MessageFlags {
  /** \Seen — read */
  seen: boolean
  /** \Flagged — surfaced in the UI as "pinned" */
  flagged: boolean
  /** \Answered — a reply was sent */
  answered: boolean
}

/** One RFC 5322 message. Threads are derived from inReplyTo/references, never stored. */
export interface Message {
  /** Message-ID header, globally unique, "<unique@domain>" */
  messageId: string
  /** Message-ID of the direct parent, when this is a reply */
  inReplyTo?: string
  /** Ancestor Message-IDs, oldest first; thread root = references[0] ?? messageId */
  references: string[]
  from: Mailbox
  to: Mailbox[]
  cc: Mailbox[]
  replyTo?: Mailbox
  subject: string
  /** Date header, ISO */
  date: string
  /** text/plain body as paragraphs */
  body: string[]
  /** text/html alternative part, when the message was composed rich */
  bodyHtml?: string

  // provider identity (present on synced mail, absent on locally-composed messages)
  /** Gmail message id — the handle remote actions are addressed with */
  gmailId?: string
  /** Provider conversation id; when present it overrides References-based threading */
  threadId?: string

  // client-side state (not wire headers)
  accountId: string
  folder: Folder
  flags: MessageFlags
  /** Spark-style smart-inbox classification */
  category: Category
  important: boolean
  /** Lifecycle: synced from Gmail, or a local draft / outgoing message in flight */
  state: MessageState
  /** Earliest send time (ISO) for a queued message: undo window or scheduled send */
  sendAfter?: string
  /** Last send error, for queued (retrying) and failed messages */
  sendError?: string
}

export type MessageState = 'synced' | 'draft' | 'queued' | 'sending' | 'sent' | 'failed'

/** A queued message whose send time is far enough out to count as "scheduled" rather than an undo window */
export function isScheduled(m: Message): boolean {
  return m.state === 'queued' && !!m.sendAfter && Date.parse(m.sendAfter) - Date.now() > 30_000
}

/**
 * Address-book entry. Keyed by lowercase address. `seed` = pre-existing contact;
 * `collected` = auto-learned from correspondence (like Gmail's "other contacts").
 */
export interface Contact {
  address: string
  name: string
  source: 'seed' | 'collected'
}

export interface Account {
  id: string
  /** Short UI label ("Gmail") */
  name: string
  /** What outgoing mail is From: ("Devah Schaefers <devah.schaefers@gmail.com>") */
  identity: Mailbox
  color: string
}

export const CATEGORY_LABELS: Record<Category, string> = {
  notifications: 'Notifications',
  people: 'People',
  invites: 'Invites'
}
