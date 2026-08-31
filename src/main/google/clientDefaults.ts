/**
 * Flint's Google OAuth client, baked in so sign-in works out of the box.
 *
 * Committing these is safe and standard for open-source desktop apps
 * (Thunderbird does the same): for a "Desktop app" OAuth client, Google's own
 * docs state the client secret is not treated as confidential — a shipped
 * binary cannot hold a secret. These values only identify the app on the
 * consent screen; they grant no mailbox access by themselves. Actual security
 * comes from PKCE and the user consenting in their own browser.
 *
 * Forks can swap these, or set the `google_client_id` / `google_client_secret`
 * rows in the local config table to override without rebuilding.
 */
export const GOOGLE_CLIENT_ID =
  '255936841780-icrmofv34tp4to21aeghdrf343q4ktjl.apps.googleusercontent.com'
export const GOOGLE_CLIENT_SECRET = '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'
