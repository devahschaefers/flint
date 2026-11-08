//! Flint's Google OAuth client, baked in so sign-in works out of the box
//!
//! Committing these is safe and standard for open-source desktop apps: for a
//! "Desktop app" OAuth client Google's docs state the client secret is not
//! treated as confidential. They only identify the app on the consent
//! screen; security comes from PKCE and the user consenting in their own
//! browser. The `google_client_id` / `google_client_secret` config rows
//! override them without rebuilding.

pub const GOOGLE_CLIENT_ID: &str = "255936841780-icrmofv34tp4to21aeghdrf343q4ktjl.apps.googleusercontent.com";
pub const GOOGLE_CLIENT_SECRET: &str = "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";
