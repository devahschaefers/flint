//! Body codec: how `messages.body_text` / `messages.body_html` are stored
//! (port of `src/main/storage/bodies.ts`).
//!
//! Every row carries a `body_codec` naming the codec both of its bodies were
//! written with. `'none'` rows hold plain TEXT (the pre-v3 shape); `'zstd'`
//! rows hold standard zstd frames as BLOBs (what Node's `zstdCompressSync`
//! writes, so rows from either app decode in both). SQLite keeps the storage
//! class per value, so [`decode_body`] accepts either shape whatever the codec
//! says a row is.

use anyhow::{bail, Result};
use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::ToSql;

/// What new rows are written with
pub const DEFAULT_CODEC: &str = "zstd";

/// zstd level (see bodies.ts for the measurements behind 9)
const ZSTD_LEVEL: i32 = 9;

/// A body value as SQLite holds it
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredBody {
    Text(String),
    Blob(Vec<u8>),
}

impl ToSql for StoredBody {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            StoredBody::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
            StoredBody::Blob(b) => ToSqlOutput::Borrowed(ValueRef::Blob(b)),
        })
    }
}

impl StoredBody {
    /// Read a column value; NULL becomes None
    pub fn from_ref(v: ValueRef<'_>) -> Option<StoredBody> {
        match v {
            ValueRef::Null => None,
            ValueRef::Text(t) => Some(StoredBody::Text(String::from_utf8_lossy(t).into_owned())),
            ValueRef::Blob(b) => Some(StoredBody::Blob(b.to_vec())),
            ValueRef::Integer(i) => Some(StoredBody::Text(i.to_string())),
            ValueRef::Real(f) => Some(StoredBody::Text(f.to_string())),
        }
    }
}

pub fn is_body_codec(value: &str) -> bool {
    value == "none" || value == "zstd" || value.starts_with("zstd-dict:")
}

/// Encode a body for storage under `codec`. None stays None (no HTML part).
pub fn encode_body_with(text: Option<&str>, codec: &str) -> Result<Option<StoredBody>> {
    let Some(text) = text else { return Ok(None) };
    match codec {
        "none" => Ok(Some(StoredBody::Text(text.to_string()))),
        "zstd" => Ok(Some(StoredBody::Blob(zstd::bulk::compress(text.as_bytes(), ZSTD_LEVEL)?))),
        other => bail!("Unknown body codec: {other}"),
    }
}

/// Encode with the default codec
pub fn encode_body(text: Option<&str>) -> Option<StoredBody> {
    encode_body_with(text, DEFAULT_CODEC).expect("default codec encodes")
}

/// Decode a stored body. Text comes back as-is whatever the codec says (TEXT
/// can only have been written plain); a BLOB is decoded per `codec`.
pub fn decode_body(stored: Option<&StoredBody>, codec: &str) -> Result<Option<String>> {
    match stored {
        None => Ok(None),
        Some(StoredBody::Text(s)) => Ok(Some(s.clone())),
        Some(StoredBody::Blob(b)) => match codec {
            "none" => Ok(Some(String::from_utf8_lossy(b).into_owned())),
            "zstd" => {
                let mut out = Vec::new();
                zstd::stream::copy_decode(&b[..], &mut out)?;
                Ok(Some(String::from_utf8_lossy(&out).into_owned()))
            }
            other => bail!("Unknown body codec: {other}"),
        },
    }
}

/// Bytes a stored value occupies (for progress reporting)
pub fn stored_size(stored: Option<&StoredBody>) -> u64 {
    match stored {
        None => 0,
        Some(StoredBody::Text(s)) => s.len() as u64,
        Some(StoredBody::Blob(b)) => b.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLES: &[&str] = &[
        "",
        "hello",
        "Grüße aus Köln — 日本語のテキスト 🚀",
        "line1\r\nline2\n\ttabbed",
        "{\"nested\":[\"a\",\"b\",{\"c\":1}]}",
    ];

    #[test]
    fn round_trips_through_zstd_as_a_blob() {
        let long = "x".repeat(100_000);
        for s in SAMPLES.iter().copied().chain([long.as_str()]) {
            let stored = encode_body(Some(s)).unwrap();
            assert!(matches!(stored, StoredBody::Blob(_)));
            assert_eq!(decode_body(Some(&stored), "zstd").unwrap().as_deref(), Some(s));
        }
    }

    #[test]
    fn compresses_repetitive_text() {
        let stored = encode_body(Some(&"<p>the same paragraph</p>\n".repeat(2000)));
        assert!(stored_size(stored.as_ref()) < 2000);
    }

    #[test]
    fn keeps_null_as_null() {
        assert_eq!(encode_body(None), None);
        assert_eq!(decode_body(None, "zstd").unwrap(), None);
        assert_eq!(stored_size(None), 0);
    }

    #[test]
    fn none_stores_plain_text() {
        let stored = encode_body_with(Some("plain"), "none").unwrap().unwrap();
        assert_eq!(stored, StoredBody::Text("plain".into()));
        assert_eq!(decode_body(Some(&stored), "none").unwrap().as_deref(), Some("plain"));
    }

    #[test]
    fn decodes_legacy_text_whatever_the_codec() {
        let stored = StoredBody::Text("legacy text".into());
        assert_eq!(decode_body(Some(&stored), "zstd").unwrap().as_deref(), Some("legacy text"));
    }

    #[test]
    fn rejects_unknown_codecs() {
        let e = encode_body_with(Some("x"), "brotli").unwrap_err();
        assert!(e.to_string().contains("Unknown body codec"));
        let e = decode_body(Some(&StoredBody::Blob(b"x".to_vec())), "brotli").unwrap_err();
        assert!(e.to_string().contains("Unknown body codec"));
    }

    #[test]
    fn recognises_codec_ids() {
        assert!(is_body_codec("none"));
        assert!(is_body_codec("zstd"));
        assert!(is_body_codec("zstd-dict:2026-09"));
        assert!(!is_body_codec("gzip"));
    }

    /// A frame written by Node's zlib.zstdCompressSync (standard zstd, with the
    /// content size in the header) must decode
    #[test]
    fn decodes_a_standard_frame_with_checksum() {
        let mut enc = zstd::stream::Encoder::new(Vec::new(), 3).unwrap();
        enc.include_checksum(true).unwrap();
        std::io::Write::write_all(&mut enc, "from node".as_bytes()).unwrap();
        let frame = enc.finish().unwrap();
        let stored = StoredBody::Blob(frame);
        assert_eq!(decode_body(Some(&stored), "zstd").unwrap().as_deref(), Some("from node"));
    }
}
