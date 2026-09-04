import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { shell } from 'electron'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'

/**
 * OAuth 2.0 for native apps (RFC 8252): PKCE + loopback redirect. The system
 * browser handles the Google sign-in; we listen on an ephemeral 127.0.0.1 port
 * for the redirect carrying the authorization code. Token exchange and refresh
 * are google-auth-library's OAuth2Client; the desktop dance stays ours because
 * no official package provides it.
 */

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'openid', 'email', 'profile']
const FLOW_TIMEOUT_MS = 5 * 60 * 1000

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** unix ms when the access token expires */
  expiresAt: number
}

export interface AuthResult {
  tokens: TokenSet
  email: string
  /** Google profile display name */
  name: string
}

const LANDING_HTML = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;background:#1F2124;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>Account connected</h2><p>You can close this tab and return to the app.</p></div>`

export async function runAuthFlow(clientId: string, clientSecret: string): Promise<AuthResult> {
  const state = randomBytes(16).toString('base64url')

  // Start the loopback server first so we know the redirect port
  let resolveStart!: (v: { code: string }) => void
  let rejectStart!: (e: Error) => void
  const codePromise = new Promise<{ code: string }>((res, rej) => {
    resolveStart = res
    rejectStart = rej
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/oauth2callback') {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')
    const cbState = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(LANDING_HTML)
    clearTimeout(timer)
    server.close()
    if (error) rejectStart(new Error(`Google returned: ${error}`))
    else if (!code || cbState !== state) rejectStart(new Error('Invalid OAuth callback'))
    else resolveStart({ code })
  })
  const timer = setTimeout(() => {
    server.close()
    rejectStart(new Error('Sign-in timed out (5 minutes) — try again'))
  }, FLOW_TIMEOUT_MS)
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const port = (server.address() as { port: number }).port
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri })
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
    // Force the consent screen so Google always issues a refresh token,
    // including on account re-adds
    prompt: 'consent'
  })
  void shell.openExternal(authUrl)

  const { code } = await codePromise
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
  const accessToken = tokens.access_token
  const refreshToken = tokens.refresh_token
  if (!accessToken) throw new Error('Google did not return an access token — try again')
  if (!refreshToken) throw new Error('Google did not return a refresh token — try again')

  const infoRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!infoRes.ok) throw new Error(`Could not read Google profile (${infoRes.status})`)
  const info = (await infoRes.json()) as { email?: string; name?: string }
  if (!info.email) throw new Error('Google profile has no email address')

  return {
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: tokens.expiry_date ?? Date.now() + 3600 * 1000
    },
    email: info.email.toLowerCase(),
    name: info.name ?? info.email
  }
}
