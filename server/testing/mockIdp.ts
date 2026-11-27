// A mocked OAuth 2.0 / OIDC identity provider for the A2A login tests: token endpoint (authorization_code with the
// PKCE check, and refresh_token), userinfo, revocation and a JWKS that signs id_tokens. It listens on loopback, so
// tests run the guard with A2A_ALLOW_INSECURE_LOCAL=1. Every request is recorded.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

export interface Idp {
  url: string
  host: string
  requests: { path: string; body: URLSearchParams; authorization: string | null }[]
  /** what userinfo answers for the access token */
  identity: { sub: string; email: string; email_verified: boolean }
  revoked: string[]
  failRefresh: boolean
  /** the code_challenge the last authorization request carried (set by the test from the URL) */
  challenge: string
  close: () => Promise<void>
  sign: (claims: Record<string, unknown>) => Promise<string>
}

export async function startIdp(email = 'ana@example.com'): Promise<Idp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const idp = { requests: [], identity: { sub: 'user-1', email, email_verified: true }, revoked: [], failRefresh: false, challenge: '' } as unknown as Idp
  let issued = 0
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    const path = (req.url || '').split('?')[0] as string
    idp.requests.push({ path, body, authorization: (req.headers.authorization as string | undefined) ?? null })
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v))
    if (path === '/token') {
      if (body.get('grant_type') === 'authorization_code') {
        // PKCE: the verifier sent now must hash to the challenge the login started with
        const digest = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url')
        if (digest !== idp.challenge) return json(400, { error: 'invalid_grant' })
        issued++
        return json(200, { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600, scope: 'openid email', token_type: 'Bearer' })
      }
      if (body.get('grant_type') === 'refresh_token') {
        if (idp.failRefresh) return json(400, { error: 'invalid_grant' })
        issued++
        return json(200, { access_token: `at-${issued}`, refresh_token: body.get('refresh_token'), expires_in: 3600, scope: 'openid email', token_type: 'Bearer' })
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (path === '/userinfo') return json(200, idp.identity)
    if (path === '/revoke') {
      idp.revoked.push(body.get('token') || '')
      return json(200, {})
    }
    if (path === '/jwks') return json(200, { keys: [jwk] })
    return json(404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  idp.url = `http://127.0.0.1:${port}`
  idp.host = `127.0.0.1:${port}`
  idp.close = () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r())))
  idp.sign = (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(privateKey)
  return idp
}

