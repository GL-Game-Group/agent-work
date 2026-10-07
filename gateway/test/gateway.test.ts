/** Company service sign-in end to end against a fake GitHub. */
import assert from 'node:assert/strict'
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { GatewayConfig } from '../src/config.ts'
import type { Store } from '../src/db.ts'
import { memoryStore } from './memory.ts'
import { GitHub } from '../src/github.ts'
import { createGateway } from '../src/server.ts'
import { codeChallenge, randomSecret } from '../src/tokens.ts'

const ORG = 'GL-Game-Group'

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => { server.listen(port, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }) })
}

async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => { probe.close(resolve) })
  return port
}

class FakeGitHub {
  server: Server
  users = new Map<string, { id: number; login: string; inOrg: boolean }>()

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://github.invalid')
      const user = this.users.get(req.headers.authorization?.replace('Bearer tok-', '') ?? '')
      const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => { send(200, { access_token: `tok-${(JSON.parse(body) as { code: string }).code}` }) })
        return
      }
      if (url.pathname === '/user') { if (user === undefined) send(401, {}); else send(200, { id: user.id, login: user.login }); return }
      if (url.pathname === `/user/memberships/orgs/${ORG}`) { if (user?.inOrg === true) send(200, { state: 'active' }); else send(404, {}); return }
      send(404, {})
    })
  }
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function startGateway(github: FakeGitHub, store: Store, authRateLimit = { requests: 1000, windowMs: 60_000 }, webLogin = false): Promise<{ gateway: Server; port: number; origin: string }> {
  const githubPort = await listen(github.server)
  const port = await freePort()
  const origin = `http://127.0.0.1:${String(port)}`
  const fake = `http://127.0.0.1:${String(githubPort)}`
  const config: GatewayConfig = {
    publicOrigin: origin, listenHost: '127.0.0.1', listenPort: port, trustProxy: false,
    github: { clientId: 'id', clientSecret: 'secret', org: ORG, webUrl: fake, apiUrl: fake },
  }
  const gateway = createGateway({ config, store, github: new GitHub(config.github), authRateLimit, webLogin })
  await listen(gateway, port)
  return { gateway, port, origin }
}

describe('company service sign-in', () => {
  const github = new FakeGitHub()
  const store = memoryStore()
  let gateway: Server
  let port = 0
  let origin = ''

  before(async () => {
    github.users.set('alice', { id: 101, login: 'alice-gh', inOrg: true })
    github.users.set('bob', { id: 102, login: 'bob-gh', inOrg: true })
    github.users.set('mallory', { id: 666, login: 'mallory', inOrg: true })
    github.users.set('outsider', { id: 103, login: 'outsider', inOrg: false })
    github.users.set('carol', { id: 104, login: 'carol', inOrg: true })
    await store.addMember({ name: 'alice', githubId: 101, githubLogin: 'old-alice-login', role: 'admin' })
    await store.addMember({ name: 'bob', githubId: 102, githubLogin: 'bob-gh', role: 'member' })
    await store.addMember({ name: 'outsider', githubId: 103, githubLogin: 'outsider', role: 'member' })
    await store.addMember({ name: 'carol', githubId: 104, githubLogin: 'carol', role: 'member' })
    ;({ gateway, port, origin } = await startGateway(github, store))
  })

  after(async () => {
    gateway.close()
    github.server.close()
    await store.close()
  })

  async function browserLogin(githubUser: string): Promise<{ cookie: string; reply: Reply }> {
    const start = await send(port, 'GET', '/agent-work/auth/github/start?return_to=/agent-work/whoami')
    assert.equal(start.status, 302)
    const authorize = new URL(start.headers.location as string)
    assert.equal(authorize.searchParams.get('redirect_uri'), `${origin}/agent-work/auth/github/callback`)
    assert.equal(authorize.searchParams.get('scope'), 'read:org')
    const state = authorize.searchParams.get('state') as string
    const reply = await send(port, 'GET', `/agent-work/auth/github/callback?code=${githubUser}&state=${encodeURIComponent(state)}`)
    const cookie = reply.status === 303 ? (reply.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '' : ''
    return { cookie, reply }
  }

  async function desktopLogin(githubUser: string, verifier = randomSecret()): Promise<string> {
    const clientState = randomSecret()
    const start = await send(port, 'GET', `/agent-work/auth/desktop/start?port=49152&code_challenge=${codeChallenge(verifier)}&state=${clientState}`)
    assert.equal(start.status, 302)
    const state = new URL(start.headers.location as string).searchParams.get('state') as string
    const callback = await send(port, 'GET', `/agent-work/auth/github/callback?code=${githubUser}&state=${encodeURIComponent(state)}`)
    assert.equal(callback.status, 303)
    const loopback = new URL(callback.headers.location as string)
    assert.equal(loopback.origin, 'http://127.0.0.1:49152')
    assert.equal(loopback.pathname, '/oauth/callback')
    assert.equal(loopback.searchParams.get('state'), clientState)
    const token = await send(port, 'POST', '/agent-work/auth/desktop/token', { 'content-type': 'application/json' },
      JSON.stringify({ code: loopback.searchParams.get('code'), code_verifier: verifier, device_name: 'test-mac' }))
    assert.equal(token.status, 200, token.body)
    return (JSON.parse(token.body) as { token: string }).token
  }

  async function whoami(headers: Record<string, string>): Promise<Reply> {
    return send(port, 'GET', '/agent-work/whoami', headers)
  }

  it('serves a landing page and nothing else outside its routes', async () => {
    assert.equal((await send(port, 'GET', '/')).status, 200)
    assert.equal((await send(port, 'GET', '/agent-work/auth/desktop/done')).status, 200)
    assert.equal((await send(port, 'GET', '/agent-work/account')).status, 200)
    assert.equal((await send(port, 'GET', '/agent-work/healthz')).status, 200, 'health checks need no sign-in')
    assert.equal((await send(port, 'GET', '/api/x')).status, 404)
    assert.equal((await whoami({})).status, 401)
  })

  it('signs a browser in with an HttpOnly session', async () => {
    const { cookie, reply } = await browserLogin('alice')
    assert.equal(reply.status, 303)
    assert.equal(reply.headers.location, '/agent-work/whoami')
    assert.match(reply.headers['set-cookie']?.[0] ?? '', /HttpOnly; SameSite=Lax/u)
    assert.equal((await store.member('alice'))?.githubLogin, 'alice-gh', 'renamed GitHub login is refreshed')
    const me = JSON.parse((await whoami({ cookie })).body) as { member: string; role: string; credential: { kind: string } }
    assert.deepEqual([me.member, me.role, me.credential.kind], ['alice', 'admin', 'browser'])
  })

  it('refuses GitHub accounts that are not members, disabled, or outside the organization', async () => {
    assert.equal((await browserLogin('mallory')).reply.status, 403)
    assert.equal((await browserLogin('outsider')).reply.status, 403)
    await store.setStatus('carol', 'disabled')
    assert.equal((await browserLogin('carol')).reply.status, 403)
    await store.setStatus('carol', 'active')
    assert.ok((await store.recentAudit()).some(entry => entry.action === 'login-denied' && entry.target === 'mallory'))
  })

  it('rejects replayed OAuth state and never returns into the sign-in routes', async () => {
    const start = await send(port, 'GET', '/agent-work/auth/github/start?return_to=/agent-work/auth/github/start')
    const state = new URL(start.headers.location as string).searchParams.get('state') as string
    const first = await send(port, 'GET', `/agent-work/auth/github/callback?code=alice&state=${encodeURIComponent(state)}`)
    assert.equal(first.headers.location, '/')
    assert.equal((await send(port, 'GET', `/agent-work/auth/github/callback?code=alice&state=${encodeURIComponent(state)}`)).status, 400)
  })

  it('issues desktop device tokens through PKCE', async () => {
    const aliceToken = await desktopLogin('alice')
    const bobToken = await desktopLogin('bob')
    const me = JSON.parse((await whoami({ authorization: `Bearer ${bobToken}` })).body) as { member: string; githubId: number; role: string; credential: { kind: string } }
    assert.deepEqual([me.member, me.githubId, me.role, me.credential.kind], ['bob', 102, 'member', 'device'])
    assert.equal((JSON.parse((await whoami({ authorization: `Bearer ${aliceToken}` })).body) as { member: string }).member, 'alice')
    assert.equal((await whoami({ authorization: 'Bearer awd_forged' })).status, 401)
    assert.equal((await whoami({ authorization: `Bearer ${aliceToken}`, cookie: 'aw_session=whatever' })).status, 200, 'a bearer token is judged on its own')
  })

  it('rejects a wrong PKCE verifier, a reused login code, and malformed starts', async () => {
    const verifier = randomSecret()
    const start = await send(port, 'GET', `/agent-work/auth/desktop/start?port=49152&code_challenge=${codeChallenge(verifier)}&state=${randomSecret()}`)
    const state = new URL(start.headers.location as string).searchParams.get('state') as string
    const callback = await send(port, 'GET', `/agent-work/auth/github/callback?code=alice&state=${encodeURIComponent(state)}`)
    const code = new URL(callback.headers.location as string).searchParams.get('code')
    const exchange = (v: string): Promise<Reply> => send(port, 'POST', '/agent-work/auth/desktop/token', { 'content-type': 'application/json' }, JSON.stringify({ code, code_verifier: v }))
    assert.equal((await exchange(randomSecret())).status, 400)
    assert.equal((await exchange(verifier)).status, 400, 'the code was consumed by the failed attempt')
    assert.equal((await send(port, 'GET', '/agent-work/auth/desktop/start?port=80&code_challenge=x&state=y')).status, 400)
  })

  it('blocks cross-site use of a browser session', async () => {
    const { cookie } = await browserLogin('alice')
    assert.equal((await send(port, 'POST', '/agent-work/auth/logout', { cookie, origin: 'https://evil.example' })).status, 403)
    assert.equal((await send(port, 'POST', '/agent-work/auth/logout', { cookie })).status, 403, 'unsafe methods need an Origin')
    assert.equal((await whoami({ cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).status, 403)
    assert.equal((await whoami({ cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })).status, 403, 'sibling subdomains are foreign')
    assert.equal((await whoami({ cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status, 200, 'following a link in is allowed')
  })

  it('cuts off revoked credentials, logged-out sessions, and disabled members', async () => {
    const token = await desktopLogin('bob')
    const id = (JSON.parse((await whoami({ authorization: `Bearer ${token}` })).body) as { credential: { id: string } }).credential.id
    await store.revokeCredential(id)
    assert.equal((await whoami({ authorization: `Bearer ${token}` })).status, 401)

    const { cookie } = await browserLogin('alice')
    assert.equal((await send(port, 'POST', '/agent-work/auth/logout', { cookie, origin })).status, 204)
    assert.equal((await whoami({ cookie })).status, 401)

    const fresh = await desktopLogin('bob')
    await store.setStatus('bob', 'disabled')
    assert.equal((await whoami({ authorization: `Bearer ${fresh}` })).status, 401)
    await store.setStatus('bob', 'active')
  })
})

describe('company service rate limit', () => {
  it('limits sign-in attempts per client address', async () => {
    const store = memoryStore()
    const github = new FakeGitHub()
    const { gateway, port } = await startGateway(github, store, { requests: 3, windowMs: 60_000 })
    try {
      const statuses = []
      for (let i = 0; i < 4; i += 1) statuses.push((await send(port, 'GET', '/agent-work/auth/github/start')).status)
      assert.deepEqual(statuses, [302, 302, 302, 429])
      assert.equal((await send(port, 'GET', '/agent-work/whoami')).status, 401, 'only sign-in routes are limited')
    } finally {
      gateway.close()
      github.server.close()
      await store.close()
    }
  })
})

describe('sign-in with the web console mounted', () => {
  const github = new FakeGitHub()
  const store = memoryStore()
  let gateway: Server
  let port = 0

  before(async () => {
    await store.addMember({ name: 'alice', githubId: 101, githubLogin: 'alice-gh', role: 'admin' })
    github.users.set('mallory', { id: 666, login: 'mallory', inOrg: true })
    ;({ gateway, port } = await startGateway(github, store, undefined, true))
  })

  after(async () => { gateway.close(); github.server.close(); await store.close() })

  async function callback(githubUser: string, start: string): Promise<Reply> {
    const begin = await send(port, 'GET', start)
    const state = new URL(begin.headers.location as string).searchParams.get('state') as string
    return send(port, 'GET', `/agent-work/auth/github/callback?code=${githubUser}&state=${encodeURIComponent(state)}`)
  }

  it('sends refused browsers back to the console sign-in page with the reason', async () => {
    const refused = await callback('mallory', '/agent-work/auth/github/start?return_to=/members')
    assert.equal(refused.status, 303)
    assert.equal(refused.headers.location, '/login?error=not-member&login=mallory')
    assert.equal(refused.headers['set-cookie'], undefined)
    const desktop = await callback('mallory', `/agent-work/auth/desktop/start?port=49152&code_challenge=${codeChallenge(randomSecret())}&state=${randomSecret()}`)
    assert.equal(desktop.status, 403, 'the desktop flow keeps its own page')
  })
})

