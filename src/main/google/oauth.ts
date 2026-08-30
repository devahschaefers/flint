import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { shell } from 'electron'

/**
 * OAuth 2.0 for native apps (RFC 8252): PKCE + loopback redirect. The system
 * browser handles the Google sign-in; we listen on an ephemeral 127.0.0.1 port
 * for the redirect carrying the authorization code.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const SCOPES = 'https://www.googleapis.com/auth/gmail.modify openid email profile'
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

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const LANDING_HTML = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;background:#1F2124;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>Account connected</h2><p>You can close this tab and return to the app.</p></div>`

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${json['error'] ?? res.status} ${json['error_description'] ?? ''}`)
  }
  return json
}

export async function runAuthFlow(clientId: string, clientSecret: string): Promise<AuthResult> {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))

  // Start the loopback server first so we know the redirect port
  let resolveStart!: (v: { code: string; port: number }) => void
  let rejectStart!: (e: Error) => void
  const codePromise = new Promise<{ code: string; port: number }>((res, rej) => {
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
    else resolveStart({ code, port })
  })
  const timer = setTimeout(() => {
    server.close()
    rejectStart(new Error('Sign-in timed out (5 minutes) — try again'))
  }, FLOW_TIMEOUT_MS)
  let port = 0
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  port = (server.address() as { port: number }).port

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
  const authUrl = new URL(AUTH_URL)
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    // Force the consent screen so Google always issues a refresh token,
    // including on account re-adds
    prompt: 'consent'
  }).toString()
  void shell.openExternal(authUrl.toString())

  const { code } = await codePromise
  const tokens = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  })
  const accessToken = tokens['access_token'] as string
  const refreshToken = tokens['refresh_token'] as string | undefined
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
      expiresAt: Date.now() + ((tokens['expires_in'] as number) ?? 3600) * 1000
    },
    email: info.email.toLowerCase(),
    name: info.name ?? info.email
  }
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const tokens = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  return {
    accessToken: tokens['access_token'] as string,
    expiresAt: Date.now() + ((tokens['expires_in'] as number) ?? 3600) * 1000
  }
}
