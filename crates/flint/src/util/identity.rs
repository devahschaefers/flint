//! Display identity and addresses, ported from `lib/identity.ts`,
//! `lib/address.ts`, and `lib/threads.ts`.
//!
//! Names resolve as real clients do: contact name > the display name on the
//! message > the bare address (never a name made up from the address).
//! Avatar color is hashed from the address so a person keeps their color.

use flint_core::{Mailbox, WireContact};
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

/// One oklch family (same lightness and chroma, 36° hue steps)
const AVATAR_COLORS: [u32; 10] = [
    0xa3575f, 0x9f5f37, 0x8b6d1f, 0x677b34, 0x33835c, 0x008384, 0x207ba1, 0x576fac, 0x7d62a2,
    0x975985,
];

/// Same hash as the TS (`hash * 31 + charCode`, int32 wraparound, over UTF-16 units)
pub fn color_for_address(address: &str) -> u32 {
    let key = address.to_lowercase();
    let mut hash: i32 = 0;
    for unit in key.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    AVATAR_COLORS[(hash.unsigned_abs() as usize) % AVATAR_COLORS.len()]
}

fn initials_of(name: &str, bare: bool) -> String {
    if bare {
        return name.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or("?".into());
    }
    let initials: String = name
        .split_whitespace()
        .take(2)
        .filter_map(|p| p.chars().next())
        .flat_map(|c| c.to_uppercase())
        .collect();
    if initials.is_empty() {
        "?".into()
    } else {
        initials
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub name: String,
    pub initials: String,
    pub color: u32,
    pub is_bare_address: bool,
}

/// The address book, keyed by lowercase address
#[derive(Default, Clone)]
pub struct Contacts {
    by_address: HashMap<String, String>,
}

impl Contacts {
    pub fn new(list: &[WireContact]) -> Self {
        let mut by_address = HashMap::with_capacity(list.len());
        for c in list {
            by_address.entry(c.address.to_lowercase()).or_insert_with(|| c.name.clone());
        }
        Contacts { by_address }
    }

    pub fn resolve(&self, m: &Mailbox) -> Identity {
        let contact = self.by_address.get(&m.address.to_lowercase());
        let name = contact.cloned().or_else(|| m.name.clone().filter(|n| !n.is_empty()));
        let bare = name.is_none();
        let display = name.unwrap_or_else(|| m.address.clone());
        Identity {
            initials: initials_of(&display, bare),
            name: display,
            color: color_for_address(&m.address),
            is_bare_address: bare,
        }
    }

    /// "Mom, Priya Raghavan"
    pub fn names(&self, list: &[Mailbox]) -> String {
        list.iter().map(|m| self.resolve(m).name).collect::<Vec<_>>().join(", ")
    }
}

/// Lowercased, Gmail "+tag" dropped, so aliases match their account
pub fn address_key(address: &str) -> String {
    static PLUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\+[^@]*@").unwrap());
    PLUS.replace(&address.to_lowercase(), "@").into_owned()
}

/// Subject without reply prefixes ("Re: Fwd: X" → "X")
pub fn normalize_subject(subject: &str) -> String {
    static PREFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(\s*(re|fwd?)\s*:\s*)+").unwrap());
    PREFIX.replace(subject, "").trim().to_string()
}

// ---------- RFC 5322 address lists (lib/address.ts) ----------

pub fn is_valid_address(address: &str) -> bool {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$"#).unwrap());
    RE.is_match(address)
}

fn split_list(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let (mut in_quotes, mut in_angle) = (false, false);
    for ch in input.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '<' if !in_quotes => in_angle = true,
            '>' if !in_quotes => in_angle = false,
            _ => {}
        }
        if ch == ',' && !in_quotes && !in_angle {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    parts.push(current);
    parts.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

pub fn parse_mailbox(input: &str) -> Option<Mailbox> {
    static ANGLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)<([^<>]+)>$").unwrap());
    static ESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(c) = ANGLE.captures(trimmed) {
        let address = c[2].trim().to_string();
        let mut name = c[1].trim().to_string();
        if name.len() >= 2 && name.starts_with('"') && name.ends_with('"') {
            name = ESC.replace_all(&name[1..name.len() - 1], "$1").trim().to_string();
        }
        let name = (!name.is_empty()).then_some(name);
        return is_valid_address(&address).then_some(Mailbox { name, address });
    }
    is_valid_address(trimmed).then(|| Mailbox { name: None, address: trimmed.to_string() })
}

pub fn parse_address_list(input: &str) -> Vec<Mailbox> {
    split_list(input).iter().filter_map(|p| parse_mailbox(p)).collect()
}

pub fn format_mailbox(m: &Mailbox) -> String {
    match &m.name {
        None => m.address.clone(),
        Some(name) => {
            let needs_quotes = name.chars().any(|c| ",<>@:;.\"\\".contains(c));
            if needs_quotes {
                let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
                format!("\"{escaped}\" <{}>", m.address)
            } else {
                format!("{name} <{}>", m.address)
            }
        }
    }
}

pub fn format_address_list(list: &[Mailbox]) -> String {
    list.iter().map(format_mailbox).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_matches_ts_hash() {
        // JS: for "a@b.co": computed with the same int32 wraparound
        let mut h: i32 = 0;
        for c in "a@b.co".encode_utf16() {
            h = h.wrapping_mul(31).wrapping_add(c as i32);
        }
        assert_eq!(color_for_address("A@B.co"), AVATAR_COLORS[(h.unsigned_abs() as usize) % 10]);
    }

    #[test]
    fn resolves_names_and_initials() {
        let contacts = Contacts::new(&[WireContact { address: "mom@x.com".into(), name: "Mom".into() }]);
        let id = contacts.resolve(&Mailbox::new(Some("Linda Smith".into()), "Mom@x.com"));
        assert_eq!((id.name.as_str(), id.initials.as_str()), ("Mom", "M"));
        let id = contacts.resolve(&Mailbox::new(Some("Priya Raghavan".into()), "p@x.com"));
        assert_eq!(id.initials, "PR");
        let id = contacts.resolve(&Mailbox::new(None, "zed@x.com"));
        assert!(id.is_bare_address);
        assert_eq!((id.name.as_str(), id.initials.as_str()), ("zed@x.com", "Z"));
    }

    #[test]
    fn address_lists_round_trip() {
        let list = parse_address_list(r#""Last, First" <a@b.com>, c@d.org, bad, Name <e@f.io>"#);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name.as_deref(), Some("Last, First"));
        assert_eq!(format_address_list(&list), r#""Last, First" <a@b.com>, c@d.org, Name <e@f.io>"#);
    }

    #[test]
    fn subjects_and_aliases() {
        assert_eq!(normalize_subject("Re: Fwd: RE:  Lunch"), "Lunch");
        assert_eq!(address_key("Me+news@Gmail.com"), "me@gmail.com");
    }
}
