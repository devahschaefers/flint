import MailComposer from 'nodemailer/lib/mail-composer'
import type Mail from 'nodemailer/lib/mailer'

/**
 * Outgoing RFC 822 construction via nodemailer's MailComposer — encodings,
 * multipart alternatives, and header folding are its problem, not ours.
 */

export interface OutgoingMail {
  from: { name?: string; address: string }
  to: { name?: string; address: string }[]
  cc: { name?: string; address: string }[]
  subject: string
  text: string
  html?: string
  /** Parent Message-ID header, for reply threading */
  inReplyTo?: string
  references: string[]
}

export function buildMime(mail: OutgoingMail): Promise<Buffer> {
  const options: Mail.Options = {
    from: mail.from,
    to: mail.to,
    cc: mail.cc.length > 0 ? mail.cc : undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo,
    references: mail.references.length > 0 ? mail.references : undefined
  }
  return new Promise((resolve, reject) => {
    new MailComposer(options).compile().build((err, message) => {
      if (err) reject(err)
      else resolve(message)
    })
  })
}
