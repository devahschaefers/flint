import { describe, expect, it } from 'vitest'
import type { gmail_v1 } from '@googleapis/gmail'
import { extractBodies, parseGmailMessage } from '../google/gmail'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

function part(mimeType: string, data: string): gmail_v1.Schema$MessagePart {
  return { mimeType, body: { data: b64(data) } }
}

function message(payload: gmail_v1.Schema$MessagePart): gmail_v1.Schema$Message {
  return {
    id: 'g1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1700000000000',
    snippet: 'snip &amp; more',
    payload: {
      ...payload,
      headers: [
        { name: 'From', value: 'Sender <sender@example.com>' },
        { name: 'Subject', value: 'Hello' },
        { name: 'Message-ID', value: '<m1@example.com>' }
      ]
    }
  }
}

describe('extractBodies / parseGmailMessage', () => {
  it('keeps a real text/plain part alongside the HTML', () => {
    const m = message({
      mimeType: 'multipart/alternative',
      parts: [
        part('text/plain', 'The plain version of this message.'),
        part('text/html', '<p>The <b>HTML</b> version</p>')
      ]
    })
    const parsed = parseGmailMessage(m)
    expect(parsed.bodyText).toBe('The plain version of this message.')
    expect(parsed.bodyHtml).toBe('<p>The <b>HTML</b> version</p>')
    expect(parsed.bodyState).toBe('full')
  })

  it('derives text from HTML-only mail', () => {
    const m = message(
      part(
        'text/html',
        '<html><head><style>p{}</style></head><body><h1>Invoice #42</h1><p>Amount due: &euro;12</p></body></html>'
      )
    )
    const parsed = parseGmailMessage(m)
    expect(parsed.bodyText).toBe('Invoice #42\nAmount due: €12')
    expect(parsed.bodyHtml).toContain('<h1>Invoice #42</h1>')
  })

  it('replaces a token text part with text derived from the HTML', () => {
    const m = message({
      mimeType: 'multipart/alternative',
      parts: [
        part('text/plain', 'View online'),
        part('text/html', '<p>Your order has shipped and will arrive Tuesday.</p>')
      ]
    })
    expect(parseGmailMessage(m).bodyText).toBe('Your order has shipped and will arrive Tuesday.')
  })

  it('finds nested parts and flags calendar invites', () => {
    const res = extractBodies({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            part('text/plain', 'Meeting at ten, bring the slides.'),
            part('text/html', '<p>x</p>')
          ]
        },
        {
          mimeType: 'text/calendar',
          filename: 'invite.ics',
          body: { data: b64('BEGIN:VCALENDAR') }
        }
      ]
    })
    expect(res).toEqual({
      text: 'Meeting at ten, bring the slides.',
      html: '<p>x</p>',
      hasCalendar: true
    })
  })

  it('marks a metadata-only fetch as missing its bodies', () => {
    const meta = message({ mimeType: 'multipart/alternative', parts: [] })
    const parsed = parseGmailMessage(meta, 'missing')
    expect(parsed).toMatchObject({
      gmailId: 'g1',
      threadId: 't1',
      subject: 'Hello',
      fromAddr: 'sender@example.com',
      snippet: 'snip & more',
      bodyText: '',
      bodyHtml: null,
      bodyState: 'missing',
      folder: 'inbox',
      seen: false
    })
  })
})
