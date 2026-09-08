import * as db from '../db'
import type { GmailApi, ParsedMessage } from '../google/gmail'
import type { WireMessage } from '../../preload/index.d'

/** A synced-message record with sensible defaults; override what the test cares about */
export function record(
  over: Partial<db.MsgRecord> & { gmailId: string; accountId: string }
): db.MsgRecord {
  return {
    threadId: `th-${over.gmailId}`,
    messageIdHdr: `<${over.gmailId}@example.com>`,
    inReplyTo: null,
    references: [],
    fromName: 'Sender',
    fromAddr: 'sender@example.com',
    to: [{ address: 'me@example.com' }],
    cc: [],
    replyTo: null,
    subject: `Subject ${over.gmailId}`,
    dateMs: 1_700_000_000_000,
    snippet: `snippet ${over.gmailId}`,
    bodyText: `body ${over.gmailId}`,
    bodyHtml: null,
    bodyState: 'full',
    folder: 'inbox',
    seen: false,
    flagged: false,
    category: 'people',
    important: false,
    ...over
  }
}

/** Same shape minus accountId (what GmailApi.getMessage hands back) */
export function parsed(over: Partial<ParsedMessage> & { gmailId: string }): ParsedMessage {
  const full: Partial<db.MsgRecord> = record({ accountId: 'unused', ...over })
  delete full.accountId
  return full as ParsedMessage
}

export function createAccount(id = 'acct', email = 'me@example.com'): void {
  db.createAccount({ id, email, name: 'Me', color: '#000' })
}

/** The renderer-facing row for a local message, by Message-ID header */
export function wire(accountId: string, messageIdHdr: string): WireMessage | undefined {
  return db
    .queryWindow(1000)
    .find((m) => m.accountId === accountId && m.messageIdHdr === messageIdHdr)
}

export type Call = { method: string; args: unknown[] }

export interface FakeGmail extends GmailApi {
  calls: Call[]
  /** Method names called so far, in order */
  called(): string[]
  /** Replace one method's behavior for the rest of the test */
  script<K extends keyof GmailApi>(method: K, impl: GmailApi[K]): void
}

/**
 * Hand-rolled GmailApi double. Every method resolves to a benign default and
 * records its call; tests script the interesting ones per case.
 */
export function fakeGmail(): FakeGmail {
  const calls: Call[] = []
  const impls: Record<string, (...args: never[]) => unknown> = {
    getProfile: async () => ({ emailAddress: 'me@example.com', historyId: '1' }),
    listMessageIds: async () => ({ ids: [] }),
    listAllMessageIds: async () => new Set<string>(),
    findByMessageId: async () => null,
    // Read-backs are a no-op unless a test scripts the returned record
    getMessage: async () => null,
    getMessageMetadata: async () => null,
    listHistory: async () => ({ history: [] }),
    batchModify: async () => undefined,
    send: async () => ({ id: 'gm-sent', threadId: 'th-sent' }),
    createDraft: async () => ({ draftId: 'dr-1', messageId: 'gm-dr-1', threadId: 'th-dr-1' }),
    updateDraft: async (draftId: string) => ({
      draftId,
      messageId: 'gm-dr-2',
      threadId: 'th-dr-1'
    }),
    deleteDraft: async () => undefined,
    findDraftIdForMessage: async () => null,
    trash: async () => undefined,
    untrash: async () => undefined
  }
  const fake: Record<string, unknown> = {
    calls,
    called: () => calls.map((c) => c.method),
    script: (method: string, impl: (...args: never[]) => unknown) => {
      impls[method] = impl
    }
  }
  for (const name of Object.keys(impls)) {
    fake[name] = (...args: never[]) => {
      calls.push({ method: name, args })
      return impls[name](...args)
    }
  }
  return fake as unknown as FakeGmail
}
