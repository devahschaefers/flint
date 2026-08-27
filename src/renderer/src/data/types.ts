export type Category = 'notifications' | 'people' | 'invites'

export type Folder = 'inbox' | 'trash' | 'spam' | 'sent' | 'drafts'

export interface Account {
  id: string
  name: string
  email: string
  color: string
}

export interface Sender {
  name: string
  email: string
  color: string
  initials: string
}

export interface Email {
  id: string
  accountId: string
  /** For sent mail this is the recipient (what the list row should display) */
  sender: Sender
  subject: string
  preview: string
  /** Full message body as paragraphs; preview is the start of the first one */
  body: string[]
  /** ISO timestamp */
  date: string
  category: Category
  read: boolean
  /** Important emails surface directly in the Focused list instead of a group */
  important: boolean
  pinned: boolean
  folder: Folder
}

export const CATEGORY_LABELS: Record<Category, string> = {
  notifications: 'Notifications',
  people: 'People',
  invites: 'Invites'
}
