//! Refresh-token sealing, readable and writable by both apps. The Electron
//! app stores `accounts.refresh_token` as `enc:<base64>` (Electron
//! `safeStorage`) or `plain:<token>` when encryption is unavailable.
//!
//! On macOS `safeStorage` is Chromium's OSCrypt: ciphertext is `v10` +
//! AES-128-CBC with PKCS#7 padding, IV = 16 spaces, key =
//! PBKDF2-HMAC-SHA1(keychain password, "saltysalt", 1003 iterations, 16
//! bytes). The password is a generic keychain item with service
//! "flint Safe Storage" (account "flint Key"; older Electron used another
//! account name, so lookups fall back to the service alone). When the item
//! does not exist it is created the way Chromium does: 16 random bytes,
//! base64-encoded, used as the password string.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use anyhow::{anyhow, bail, Result};
use base64::Engine as _;
use std::sync::Mutex;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

const SALT: &[u8] = b"saltysalt";
const ITERATIONS: u32 = 1003;
const IV: [u8; 16] = [b' '; 16];
const VERSION_PREFIX: &[u8] = b"v10";

pub const KEYCHAIN_SERVICE: &str = "flint Safe Storage";
pub const KEYCHAIN_ACCOUNT: &str = "flint Key";

/// How refresh tokens are sealed for the `accounts.refresh_token` column
pub trait SecretBox: Send + Sync {
    /// The stored form of `token` (`enc:...`, or `plain:...` when encryption is unavailable)
    fn seal(&self, token: &str) -> String;
    /// The token a stored value holds
    fn unseal(&self, stored: &str) -> Result<String>;
}

pub fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, SALT, ITERATIONS, &mut key);
    key
}

/// OSCrypt v10 encryption
pub fn encrypt_v10(key: &[u8; 16], plaintext: &[u8]) -> Vec<u8> {
    let body = Aes128CbcEnc::new(key.into(), &IV.into()).encrypt_padded_vec_mut::<Pkcs7>(plaintext);
    let mut out = VERSION_PREFIX.to_vec();
    out.extend_from_slice(&body);
    out
}

/// OSCrypt decryption: v10 ciphertext is decrypted; anything without the
/// prefix was never encrypted and comes back as-is (Chromium's rule)
pub fn decrypt_v10(key: &[u8; 16], data: &[u8]) -> Result<Vec<u8>> {
    let Some(body) = data.strip_prefix(VERSION_PREFIX) else { return Ok(data.to_vec()) };
    Aes128CbcDec::new(key.into(), &IV.into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|_| anyhow!("safeStorage decryption failed (wrong key or corrupt data)"))
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Shared stored-form logic over a key source
fn seal_with(key: Option<[u8; 16]>, token: &str) -> String {
    match key {
        Some(k) => format!("enc:{}", b64().encode(encrypt_v10(&k, token.as_bytes()))),
        None => format!("plain:{token}"),
    }
}

fn unseal_with(key: impl FnOnce() -> Option<[u8; 16]>, stored: &str) -> Result<String> {
    if let Some(enc) = stored.strip_prefix("enc:") {
        let data = b64().decode(enc.trim())?;
        let Some(k) = key() else {
            bail!("Stored credentials are encrypted but the keychain is unavailable")
        };
        return Ok(String::from_utf8(decrypt_v10(&k, &data)?)?);
    }
    Ok(stored.strip_prefix("plain:").unwrap_or(stored).to_string())
}

/// Encryption unavailable: everything is stored `plain:` (what the Electron
/// test setup does, and the fallback when there is no keychain)
pub struct PlainSecrets;

impl SecretBox for PlainSecrets {
    fn seal(&self, token: &str) -> String {
        seal_with(None, token)
    }
    fn unseal(&self, stored: &str) -> Result<String> {
        unseal_with(|| None, stored)
    }
}

/// A fixed keychain password (tests, or a caller that manages the key itself)
pub struct FixedKeySecrets {
    key: [u8; 16],
}

impl FixedKeySecrets {
    pub fn new(password: &[u8]) -> FixedKeySecrets {
        FixedKeySecrets { key: derive_key(password) }
    }
}

impl SecretBox for FixedKeySecrets {
    fn seal(&self, token: &str) -> String {
        seal_with(Some(self.key), token)
    }
    fn unseal(&self, stored: &str) -> Result<String> {
        unseal_with(|| Some(self.key), stored)
    }
}

/// The real thing: the Electron app's keychain item, read (or created) on
/// first use and cached for the life of the process
pub struct KeychainSecrets {
    /// None until first use; Some(None) once the keychain proved unavailable
    key: Mutex<Option<Option<[u8; 16]>>>,
}

impl Default for KeychainSecrets {
    fn default() -> Self {
        KeychainSecrets { key: Mutex::new(None) }
    }
}

impl KeychainSecrets {
    fn key(&self, create: bool) -> Option<[u8; 16]> {
        let mut slot = self.key.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(k) = *slot {
            if k.is_some() || !create {
                return k;
            }
        }
        let found = keychain::find_password();
        let k = match found {
            Ok(Some(pw)) => Some(derive_key(&pw)),
            Ok(None) if create => match keychain::create_password() {
                Ok(pw) => Some(derive_key(&pw)),
                Err(e) => {
                    log::warn!("[secrets] could not create the keychain item: {e}");
                    None
                }
            },
            Ok(None) => None,
            Err(e) => {
                log::warn!("[secrets] keychain unavailable: {e}");
                None
            }
        };
        // A missing item is not cached when we were only reading: a later
        // write may create it
        if k.is_some() || create {
            *slot = Some(k);
        }
        k
    }
}

impl SecretBox for KeychainSecrets {
    fn seal(&self, token: &str) -> String {
        seal_with(self.key(true), token)
    }
    fn unseal(&self, stored: &str) -> Result<String> {
        unseal_with(|| self.key(false), stored)
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::{KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};
    use anyhow::Result;
    use base64::Engine as _;
    use rand::RngCore;
    use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
    use security_framework::passwords::{get_generic_password, set_generic_password};

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// The Safe Storage password, by service + account, else by service alone
    pub fn find_password() -> Result<Option<Vec<u8>>> {
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(pw) => return Ok(Some(pw)),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {}
            Err(e) => return Err(e.into()),
        }
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(KEYCHAIN_SERVICE)
            .load_data(true)
            .limit(1)
            .search();
        match found {
            Ok(results) => Ok(results.into_iter().find_map(|r| match r {
                SearchResult::Data(d) => Some(d),
                _ => None,
            })),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Chromium's new-key rule: 16 random bytes, base64, as the password string
    pub fn create_password() -> Result<Vec<u8>> {
        let mut raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut raw);
        let pw = base64::engine::general_purpose::STANDARD.encode(raw).into_bytes();
        set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &pw)?;
        Ok(pw)
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use anyhow::{bail, Result};

    pub fn find_password() -> Result<Option<Vec<u8>>> {
        bail!("no keychain on this platform")
    }

    pub fn create_password() -> Result<Vec<u8>> {
        bail!("no keychain on this platform")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;
    use aes::cipher::KeyInit;

    #[test]
    fn key_derivation_matches_pbkdf2_sha1() {
        // PBKDF2-HMAC-SHA1("password", "salt", 1 iteration) — RFC 6070 vector,
        // checks the primitive the OSCrypt key is built from
        let mut out = [0u8; 20];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"password", b"salt", 1, &mut out);
        assert_eq!(
            out,
            [
                0x0c, 0x60, 0xc8, 0x0f, 0x96, 0x1f, 0x0e, 0x71, 0xf3, 0xa9, 0xb5, 0x24, 0xaf, 0x60,
                0x12, 0x06, 0x2f, 0xe0, 0x37, 0xa6
            ]
        );
    }

    /// A known vector computed independently in-test: CBC with a 16-space IV
    /// over one full block of padding is AES(key, IV ^ pad) for the last block
    #[test]
    fn v10_layout_is_prefix_plus_cbc_with_space_iv() {
        let key = derive_key(b"keychain-password");
        let plaintext = b"0123456789abcdef"; // exactly one block → second block is all padding
        let ct = encrypt_v10(&key, plaintext);
        assert_eq!(&ct[..3], b"v10");
        assert_eq!(ct.len(), 3 + 32);

        let cipher = aes::Aes128::new(&key.into());
        let mut block1 = [0u8; 16];
        for i in 0..16 {
            block1[i] = plaintext[i] ^ b' ';
        }
        let mut b1 = block1.into();
        cipher.encrypt_block(&mut b1);
        assert_eq!(&ct[3..19], b1.as_slice());
        let mut block2 = [0u8; 16];
        for i in 0..16 {
            block2[i] = 16 ^ b1[i];
        }
        let mut b2 = block2.into();
        cipher.encrypt_block(&mut b2);
        assert_eq!(&ct[19..35], b2.as_slice());
    }

    #[test]
    fn round_trips_through_the_stored_form() {
        let s = FixedKeySecrets::new(b"c29tZSByYW5kb20ga2V5IQ==");
        let stored = s.seal("1//refresh-token");
        assert!(stored.starts_with("enc:"));
        assert_eq!(s.unseal(&stored).unwrap(), "1//refresh-token");
        // plain values from a store without encryption read back too
        assert_eq!(s.unseal("plain:abc").unwrap(), "abc");
        // a wrong key fails instead of returning garbage
        let other = FixedKeySecrets::new(b"different");
        assert!(other.unseal(&stored).is_err());
    }

    #[test]
    fn plain_secrets_store_plain() {
        assert_eq!(PlainSecrets.seal("tok"), "plain:tok");
        assert_eq!(PlainSecrets.unseal("plain:tok").unwrap(), "tok");
        assert!(PlainSecrets.unseal("enc:AAAA").is_err());
    }

    #[test]
    fn unprefixed_ciphertext_is_returned_as_is() {
        let key = derive_key(b"x");
        assert_eq!(decrypt_v10(&key, b"not encrypted").unwrap(), b"not encrypted");
    }
}
