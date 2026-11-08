//! Outgoing RFC 822 construction via
//! mail-builder: encodings, multipart/alternative, and header folding are
//! its problem. We set our own Message-ID so the copy Gmail hands back can
//! be matched to the local row it came from.

use crate::types::Mailbox;
use anyhow::Result;
use mail_builder::headers::address::Address;
use mail_builder::headers::message_id::MessageId;
use mail_builder::MessageBuilder;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct OutgoingMail {
    pub from: Mailbox,
    pub to: Vec<Mailbox>,
    pub cc: Vec<Mailbox>,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
    /// Parent Message-ID header, for reply threading
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    /// Our own Message-ID header (`<uuid@flint.local>`)
    pub message_id: Option<String>,
}

/// `<id@host>` → `id@host` (mail-builder adds the brackets)
fn bare_id(id: &str) -> String {
    id.trim().trim_start_matches('<').trim_end_matches('>').to_string()
}

fn address(m: &Mailbox) -> Address<'static> {
    Address::new_address(m.name.clone().filter(|n| !n.is_empty()), m.address.clone())
}

fn address_list(list: &[Mailbox]) -> Address<'static> {
    Address::new_list(list.iter().map(address).collect())
}

pub fn build_mime(mail: &OutgoingMail) -> Result<Vec<u8>> {
    let mut b = MessageBuilder::new().from(address(&mail.from)).subject(mail.subject.clone());
    if !mail.to.is_empty() {
        b = b.to(address_list(&mail.to));
    }
    if !mail.cc.is_empty() {
        b = b.cc(address_list(&mail.cc));
    }
    if let Some(id) = &mail.message_id {
        b = b.message_id(MessageId::new(bare_id(id)));
    }
    if let Some(parent) = mail.in_reply_to.as_deref().filter(|p| !p.is_empty()) {
        b = b.in_reply_to(MessageId::new(bare_id(parent)));
    }
    if !mail.references.is_empty() {
        b = b.references(MessageId::new_list(mail.references.iter().map(|r| bare_id(r))));
    }
    b = b.text_body(mail.text.clone());
    if let Some(html) = &mail.html {
        b = b.html_body(html.clone());
    }
    Ok(b.write_to_vec()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail() -> OutgoingMail {
        OutgoingMail {
            from: Mailbox { name: Some("Me Myself".into()), address: "me@example.com".into() },
            to: vec![Mailbox { name: None, address: "you@example.com".into() }],
            cc: vec![],
            subject: "Grüße".into(),
            text: "hello there".into(),
            html: None,
            in_reply_to: Some("<p@x>".into()),
            references: vec!["<a@x>".into(), "<p@x>".into()],
            message_id: Some("<abc@flint.local>".into()),
        }
    }

    #[test]
    fn builds_headers_and_a_plain_body() {
        let raw = String::from_utf8(build_mime(&mail()).unwrap()).unwrap();
        assert!(raw.contains("Message-ID: <abc@flint.local>"), "{raw}");
        assert!(raw.contains("In-Reply-To: <p@x>"), "{raw}");
        assert!(raw.contains("<a@x>") && raw.contains("References:"), "{raw}");
        assert!(raw.contains("you@example.com"));
        assert!(raw.contains("me@example.com"));
        assert!(raw.contains("hello there"));
        assert!(!raw.contains("Cc:"));
        assert!(!raw.contains("multipart/alternative"));
    }

    #[test]
    fn html_makes_it_multipart_alternative() {
        let mut m = mail();
        m.html = Some("<p>hello</p>".into());
        m.cc = vec![Mailbox { name: Some("C".into()), address: "c@example.com".into() }];
        let raw = String::from_utf8(build_mime(&m).unwrap()).unwrap();
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("text/html"));
        assert!(raw.contains("Cc:"));
    }
}
