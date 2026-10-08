/**
 * The company service's public HTTP surface: GitHub sign-in for the members'
 * desktop apps (and browsers, for the admin console), and the routes a
 * signed-in member calls.
 *
 * Two credentials authenticate a member:
 * - desktop device token, `Authorization: Bearer awd_…`, held by the member's
 *   local Host (browsers cannot attach it cross-site);
 * - browser session cookie, which browsers attach on their own, so every
 *   cookie-authenticated request also passes the cross-site checks below.
 *
 * GL Work for iOS signs in as a third kind, `Bearer awp_…`, which only lists
 * the member's own Macs and reaches them through the relay (remote-relay.ts).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import type { GatewayConfig } from './config.ts'
import type { Credential, Member, OAuthState, Store } from './db.ts'
import type { GitHub } from './github.ts'
import { forwardLlm, llmError } from './llm-proxy.ts'
import { SecretBox } from './secrets.ts'
import { codeChallenge, sameSecret } from './tokens.ts'
import { Refusal } from './errors.ts'
import { PluginCatalog } from './plugins.ts'
import { REMOTE_METHOD, refuseUpgrade, relayRequest, relayUpgrade } from './remote-relay.ts'
import { Tunnels } from './tunnels.ts'
import { Vendors, type Vendor } from './vendors.ts'
import { Voice } from './voice.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const BROWSER_SESSION_TTL_MS = 14 * DAY_MS
const DEVICE_TOKEN_TTL_MS = 90 * DAY_MS
const PHONE_TOKEN_TTL_MS = 90 * DAY_MS
/** How often an open remote WebSocket checks that its phone and Mac may still talk. */
const REMOTE_RECHECK_MS = 60 * 1000
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const LOGIN_CODE_TTL_MS = 60 * 1000
const DEFAULT_AUTH_RATE_LIMIT = { requests: 30, windowMs: 60 * 1000 }
const MAX_JSON_BODY_BYTES = 8 * 1024

const PREFIX = '/agent-work/'
/** Model gateway: /agent-work/llm/<vendor>/…, which Hosts use as each vendor's baseURL. */
const LLM_PREFIX = `${PREFIX}llm/`
const LLM_ROUTE = /^\/agent-work\/llm\/([a-z][a-z0-9-]{1,30})(\/.*)?$/u
/** The vendor served by the Host's own DeepSeek adapter (llm-deepseek); other key vendors become pi-ai routes. */
const DEEPSEEK_VENDOR = 'deepseek'
/** pi-ai route ids for company vendors, apart from pi-ai's own catalog names. */
const PI_AI_ROUTE_PREFIX = 'company-'
/** Capabilities of the official DeepSeek models the Host's built-in catalog declares, kept when the company narrows the list. */
const DEEPSEEK_MODEL_PROFILES: Record<string, Record<string, unknown>> = {
  'deepseek-flash': { inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' },
}
/** The old built-in console; the web console (admin/) replaced it. */
const OLD_ADMIN = `${PREFIX}admin`
/** System config for members' tools: GET /agent-work/config/system[/<key>]. */
const TUNNEL = /^\/agent-work\/tunnels\/(tun_[A-Za-z0-9]{1,32})$/u
const FRP_PLUGIN = /^\/agent-work\/frp\/([^/]{1,128})$/u
const SYSTEM_CONFIG = /^\/agent-work\/config\/system(?:\/([A-Za-z][A-Za-z0-9_.-]{0,63}))?$/u
/** 手机远程: /agent-work/remote/<tunnel id>/api/<method> (`session.list`, or a Host namespace's `fileReferences/list`). */
const REMOTE = /^\/agent-work\/remote\/(tun_[A-Za-z0-9]{1,32})\/api\/([^/]{1,64}(?:\/[^/]{1,64})?)$/u
/** GL Work on Orca: /agent-work/remote/<tunnel id>/orca (Orca's encrypted WebSocket) and …/orca/pair (a pairing for this phone). */
const REMOTE_ORCA = /^\/agent-work\/remote\/(tun_[A-Za-z0-9]{1,32})\/orca(\/pair)?$/u
/** Where the Mac's GL Work answers a relayed pairing request. */
const ORCA_PAIR_PATH = '/glwork/remote/pair'
/** Where the phone app's sign-in returns (ASWebAuthenticationSession's callback scheme). */
const PHONE_REDIRECT = 'glwork://auth'

/** Credential reference a Host stores its device token under for model requests. */
export const MODEL_KEY_REF = 'AGENT_WORK_MODEL_KEY'
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u
const CLIENT_STATE = /^[A-Za-z0-9_-]{16,128}$/u

export interface GatewayDeps {
  config: GatewayConfig
  store: Store
  github: GitHub
  now?: () => number
  /** Sign-in requests allowed per client address and window. */
  authRateLimit?: { requests: number; windowMs: number }
  /** Seals vendor keys; defaults to one from config.secretKey. */
  secrets?: SecretBox
  /** Shares the vendor store with the web console; created here when absent. */
  vendors?: Vendors
  /** The plugin catalog GL Work lists; created here when absent. */
  plugins?: PluginCatalog
  /** Members' frp tunnels; created here when absent. */
  tunnels?: Tunnels
  /** Voice vendors for the phone; created here when absent. */
  voice?: Voice
  /** Reaches vendors (voice tokens); injectable for tests. */
  fetch?: typeof fetch
  /** Refused web sign-ins go back to the web console's /login page rather than an error page here. */
  webLogin?: boolean
}

/** A browser session's name for people: "Chrome · macOS" rather than the raw User-Agent. */
export function browserLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//u.test(ua) ? 'Edge' : /Firefox\//u.test(ua) ? 'Firefox' : /Chrome\//u.test(ua) ? 'Chrome' : /Safari\//u.test(ua) ? 'Safari' : '浏览器'
  const system = /iPhone|iPad/u.test(ua) ? 'iOS' : /Android/u.test(ua) ? 'Android' : /Mac OS X|Macintosh/u.test(ua) ? 'macOS' : /Windows/u.test(ua) ? 'Windows' : /Linux/u.test(ua) ? 'Linux' : null
  return system === null ? browser : `${browser} · ${system}`
}

/** The session cookie: __Host- pins it to this exact origin (Secure, Path=/, no Domain). */
export function sessionCookieName(publicOrigin: string): string {
  return new URL(publicOrigin).protocol === 'https:' ? '__Host-aw_session' : 'aw_session'
}

/**
 * The client's address. The edge's own header (config.clientIpHeader) when it
 * holds one address; behind the reverse proxy (Traefik), the last
 * X-Forwarded-For entry is the client it saw; earlier entries are client-supplied.
 */
export function clientAddress(config: Pick<GatewayConfig, 'trustProxy' | 'clientIpHeader'>, forwardedFor: string | string[] | undefined, peer: string | undefined, edge?: string | string[] | null): string {
  if (config.clientIpHeader !== undefined && typeof edge === 'string' && isIP(edge.trim()) !== 0) return edge.trim()
  if (config.trustProxy && typeof forwardedFor === 'string') return forwardedFor.split(',').at(-1)?.trim() ?? peer ?? ''
  return peer ?? ''
}

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

interface Principal {
  member: Member
  credential: Credential
}

type Authentication =
  | { kind: 'none' }
  | { kind: 'rejected' }
  | { kind: 'ok'; principal: Principal; via: 'device' | 'browser' | 'key' | 'phone' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, c => `&#${String(c.charCodeAt(0))};`)
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

function page(res: ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d2129}@media(prefers-color-scheme:dark){body{background:#17181b;color:#e6e7ea}}h1{font-size:1.25rem}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></html>`)
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return undefined
}

/** A same-origin path to return to after sign-in, never back into the sign-in routes; anything else becomes '/'. */
function safeReturnPath(value: string | null): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  return value.startsWith(`${PREFIX}auth/`) ? '/' : value
}

/** The company service's own routes (everything under /agent-work/), as a request handler to mount. */
export interface GatewayHandler {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** WebSocket upgrades under /agent-work/; false when the path is not the service's. */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  vendors: Vendors
}

export function createGateway(deps: GatewayDeps): Server {
  const { handle, upgrade } = createGatewayHandler(deps)
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('gateway: request failed', error)
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.destroy()
    })
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => { if (!upgrade(req, socket, head)) socket.destroy() })
  return server
}

/** Bring DEEPSEEK_API_KEY from the environment (the pre-console setup) into the vendor store once. */
export async function importLegacyKey(config: GatewayConfig, store: Store, vendors: Vendors, sealing: boolean): Promise<void> {
  if (await vendors.importLegacyDeepSeek(config.deepseek, (await store.listMembers()).map(m => m.name))) {
    await store.audit({ actor: null, action: 'key-import', target: DEEPSEEK_VENDOR, detail: 'DEEPSEEK_API_KEY from the environment', ip: null })
    console.log('gateway: imported DEEPSEEK_API_KEY into the vendor store; manage keys in the admin console from now on')
  } else if (config.deepseek !== undefined && !sealing) {
    console.warn('gateway: DEEPSEEK_API_KEY is set but AGENT_WORK_SECRET_KEY is not, so the key cannot be imported; the model gateway stays off')
  }
}

export function createGatewayHandler(deps: GatewayDeps): GatewayHandler {
  const { config, store, github } = deps
  const now = deps.now ?? Date.now
  const secure = new URL(config.publicOrigin).protocol === 'https:'
  const sessionCookie = sessionCookieName(config.publicOrigin)
  const callbackUrl = new URL(`${PREFIX}auth/github/callback`, config.publicOrigin).href
  const rateLimit = deps.authRateLimit ?? DEFAULT_AUTH_RATE_LIMIT
  let ready: Promise<void> = Promise.resolve()
  const vendors = deps.vendors ?? ownVendors()
  const catalog = deps.plugins ?? new PluginCatalog(store, now)
  const tunnels = deps.tunnels ?? new Tunnels(store, config, now)
  const voice = deps.voice ?? new Voice(store, vendors, now)
  const fetchImpl = deps.fetch ?? fetch
  function ownVendors(): Vendors {
    const secrets = deps.secrets ?? (config.secretKey === undefined ? undefined : SecretBox.fromEncoded(config.secretKey))
    const created = new Vendors(store, secrets, now)
    // Requests wait for the one-time import (the handler itself is created synchronously).
    ready = importLegacyKey(config, store, created, secrets !== undefined)
    return created
  }
  const rateWindows = new Map<string, { start: number; count: number }>()

  function clientIp(req: IncomingMessage): string {
    return clientAddress(config, req.headers['x-forwarded-for'], req.socket.remoteAddress, config.clientIpHeader === undefined ? undefined : req.headers[config.clientIpHeader])
  }

  function rateLimited(req: IncomingMessage): boolean {
    const ip = clientIp(req)
    const at = now()
    const window = rateWindows.get(ip)
    if (window === undefined || at - window.start >= rateLimit.windowMs) {
      rateWindows.set(ip, { start: at, count: 1 })
      if (rateWindows.size > 10_000) rateWindows.clear()
      return false
    }
    window.count += 1
    return window.count > rateLimit.requests
  }

  async function authenticate(req: IncomingMessage): Promise<Authentication> {
    const authorization = req.headers.authorization
    if (authorization !== undefined) {
      const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
      const result = await store.authenticate(token, ['device', 'key', 'phone'], clientIp(req))
      return result === undefined ? { kind: 'rejected' } : { kind: 'ok', principal: result, via: result.credential.kind as 'device' | 'key' | 'phone' }
    }
    const token = cookieValue(req, sessionCookie)
    if (token === undefined) return { kind: 'none' }
    const result = await store.authenticate(token, 'browser', clientIp(req))
    return result === undefined ? { kind: 'rejected' } : { kind: 'ok', principal: result, via: 'browser' }
  }

  /**
   * Cross-site defense for cookie-authenticated requests. Sibling subdomains
   * (`same-site`, e.g. sites deployed under glgwork.com) count as foreign.
   */
  function crossSite(req: IncomingMessage): boolean {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) return req.headers.origin !== config.publicOrigin
    const site = req.headers['sec-fetch-site']
    // Following a link in is fine; foreign subresource or script reads are not.
    return (site === 'cross-site' || site === 'same-site') && req.headers['sec-fetch-mode'] !== 'navigate'
  }

  async function audit(req: IncomingMessage, actor: string | null, action: string, target: string | null, detail: string | null = null): Promise<void> {
    await store.audit({ actor, action, target, detail, ip: clientIp(req) })
  }

  /**
   * A refused sign-in: browsers using the web console go back to its sign-in
   * page, which explains the reason; the desktop flow and headless setups get a page here.
   */
  function refuse(res: ServerResponse, state: OAuthState | undefined, status: number, reason: string, title: string, message: string, login?: string): void {
    if (state?.kind === 'web' && deps.webLogin === true) {
      const target = new URLSearchParams({ error: reason, ...login === undefined ? {} : { login } })
      res.writeHead(303, { ...SECURITY_HEADERS, location: `/login?${target.toString()}` })
      res.end()
      return
    }
    page(res, status, title, message)
  }

  async function signInCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const state = await store.takeOAuthState(url.searchParams.get('state') ?? '')
    if (state === undefined) { page(res, 400, '登录已过期', '请回到应用重新登录。'); return }
    if (url.searchParams.has('error')) { refuse(res, state, 403, 'cancelled', '已取消授权', '没有完成 GitHub 授权，请回到应用重新登录。'); return }
    let signedIn: Awaited<ReturnType<GitHub['signIn']>>
    try {
      signedIn = await github.signIn(url.searchParams.get('code') ?? '', callbackUrl)
    } catch {
      refuse(res, state, 502, 'github', '无法完成登录', 'GitHub 暂时无法确认你的身份，请稍后重试。')
      return
    }
    const { user, inOrg } = signedIn
    const member = await store.memberByGithubId(user.id)
    if (member === undefined || member.status !== 'active') {
      await audit(req, null, 'login-denied', user.login, member === undefined ? 'not a member' : 'member disabled')
      refuse(res, state, 403, member === undefined ? 'not-member' : 'disabled', '没有访问权限', `GitHub 账号 ${user.login} 还没有开通，请联系管理员。`, user.login)
      return
    }
    if (!inOrg) {
      await audit(req, member.name, 'login-denied', user.login, `not in organization ${config.github.org}`)
      refuse(res, state, 403, 'not-in-org', '没有访问权限', `需要先加入 GitHub 组织 ${config.github.org}，并允许本应用读取组织成员身份。`, user.login)
      return
    }
    if (member.githubLogin !== user.login) await store.updateGithubLogin(member.name, user.login)
    if (state.kind === 'web') {
      const label = browserLabel(req.headers['user-agent'])
      const { credential, token } = await store.issueCredential(member.name, 'browser', label, BROWSER_SESSION_TTL_MS)
      await audit(req, member.name, 'login', credential.id, 'browser')
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        'location': safeReturnPath(state.returnTo),
        'set-cookie': `${sessionCookie}=${token}; Path=/; Max-Age=${String(BROWSER_SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
      })
      res.end()
      return
    }
    if (state.kind === 'phone') {
      const code = await store.saveLoginCode(member.name, state.codeChallenge as string, LOGIN_CODE_TTL_MS, 'phone')
      await audit(req, member.name, 'login-code', null, 'phone')
      const target = new URL(PHONE_REDIRECT)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state.clientState as string)
      res.writeHead(303, { ...SECURITY_HEADERS, location: target.href })
      res.end()
      return
    }
    const code = await store.saveLoginCode(member.name, state.codeChallenge as string, LOGIN_CODE_TTL_MS)
    await audit(req, member.name, 'login-code', null, 'desktop')
    // The member's local Host serves this route while its sign-in attempt waits (the upstream account contract).
    const target = new URL(`http://127.0.0.1:${String(state.redirectPort)}/oauth/callback`)
    target.searchParams.set('code', code)
    target.searchParams.set('state', state.clientState as string)
    res.writeHead(303, { ...SECURITY_HEADERS, location: target.href })
    res.end()
  }

  /** Trade a one-time sign-in code (PKCE) for the desktop's device token or the phone's token. */
  async function desktopToken(req: IncomingMessage, res: ServerResponse, kind: 'desktop' | 'phone' = 'desktop'): Promise<void> {
    const body = await readJson(req)
    const code = body?.code
    const verifier = body?.code_verifier
    if (typeof code !== 'string' || typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) {
      json(res, 400, { error: 'invalid_request' })
      return
    }
    const login = await store.takeLoginCode(code)
    if (login === undefined || login.kind !== kind || !sameSecret(codeChallenge(verifier), login.codeChallenge)) {
      json(res, 400, { error: 'invalid_grant' })
      return
    }
    const member = await store.member(login.member)
    if (member === undefined || member.status !== 'active') { json(res, 403, { error: 'access_denied' }); return }
    const label = typeof body?.device_name === 'string' && body.device_name.trim() !== '' ? body.device_name.trim().slice(0, 64) : kind === 'phone' ? 'iPhone' : 'desktop'
    const { credential, token } = kind === 'phone'
      ? await store.issueCredential(member.name, 'phone', label, PHONE_TOKEN_TTL_MS)
      : await store.issueCredential(member.name, 'device', label, DEVICE_TOKEN_TTL_MS)
    await audit(req, member.name, 'login', credential.id, `${kind === 'phone' ? 'phone' : 'device'} ${label}`)
    json(res, 200, { token, member: member.name, displayName: member.displayName, role: member.role, expiresAt: credential.expiresAt })
  }

  /** The model gateway: device token in x-api-key or as Bearer (as each Host adapter sends its key), the member's company key upstream. */
  async function llm(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const [, vendorId = '', rest = '/'] = LLM_ROUTE.exec(url.pathname) ?? []
    const vendor = await vendors.vendor(vendorId)
    if (vendor === undefined || vendor.auth !== 'key' || vendor.baseUrl === null || (vendor.protocol !== 'anthropic' && vendor.protocol !== 'openai')) {
      llmError(res, 'anthropic', 404, 'not_found_error', '公司模型网关没有这个厂商。')
      return
    }
    const protocol = vendor.protocol
    const header = req.headers['x-api-key']
    const bearer = req.headers.authorization?.startsWith('Bearer ') === true ? req.headers.authorization.slice('Bearer '.length) : undefined
    const token = typeof header === 'string' ? header : bearer
    // Desktop Hosts send their device token; members' own tools an internal key.
    const principal = token === undefined ? undefined : await store.authenticate(token, ['device', 'key'], clientIp(req))
    if (principal === undefined) {
      llmError(res, protocol, 401, 'authentication_error', '登录已失效或内部 Key 已吊销，请重新登录或换一个 Key。')
      return
    }
    const assignment = await vendors.assignment(principal.member.name, vendor.id)
    if (assignment === undefined) { llmError(res, protocol, 403, 'permission_error', `你还没有开通 ${vendor.name}，请联系管理员。`); return }
    const key = assignment.apiKey === null ? undefined : await vendors.key(assignment.apiKey)
    if (key?.status !== 'active') { llmError(res, protocol, 503, 'api_error', `公司还没有可用的 ${vendor.name} Key，请联系管理员。`); return }
    let apiKey: string
    try { apiKey = await vendors.keySecret(key.id) } catch {
      llmError(res, protocol, 503, 'api_error', `公司的 ${vendor.name} Key 暂时无法使用，请联系管理员。`)
      return
    }
    const usage = await forwardLlm(req, res, {
      baseUrl: vendor.baseUrl, apiKey, protocol: protocol, models: new Set(vendor.models.map(m => m.id)),
    }, rest + url.search)
    if (usage !== undefined) await store.recordUsage(principal.member.name, principal.credential.id, usage, { vendor: vendor.id, apiKey: key.id })
  }

  /** One key vendor as the Host's settings: the DeepSeek adapter, or a pi-ai route. */
  function vendorSettings(vendor: Vendor): { ns: string; path: string[]; value: unknown }[] {
    const baseURL = `${config.publicOrigin}${LLM_PREFIX}${vendor.id}`
    if (vendor.id === DEEPSEEK_VENDOR && vendor.protocol === 'anthropic') {
      return [
        { ns: 'llm-deepseek', path: ['baseURL'], value: baseURL },
        { ns: 'llm-deepseek', path: ['apiKeyEnv'], value: MODEL_KEY_REF },
        { ns: 'llm-deepseek', path: ['models'], value: vendor.models.map(m => ({ ...DEEPSEEK_MODEL_PROFILES[m.id], ...m })) },
      ]
    }
    return [{
      ns: 'llm-pi-ai',
      path: ['providers', `${PI_AI_ROUTE_PREFIX}${vendor.id}`],
      value: {
        displayName: vendor.name,
        api: vendor.protocol === 'openai' ? 'openai-completions' : 'anthropic-messages',
        baseURL,
        apiKeyEnv: MODEL_KEY_REF,
        models: vendor.models,
        ...vendor.compat === null ? {} : { compat: vendor.compat },
      },
    }]
  }

  /**
   * What a signed-in Host applies locally (see plugins/team-bundle/config-sync.js):
   * the member's key vendors through the gateway, the company accounts the
   * member signs in to CLI tools with, and public config for client plugins.
   */
  async function managedConfig(member: Member): Promise<object> {
    const settings: { ns: string; path: string[]; value: unknown }[] = []
    const cli: { vendor: string; name: string; protocol: string; baseUrl: string; keyRef: string }[] = []
    const accounts: { vendor: string; name: string; account: string }[] = []
    for (const assignment of await vendors.assignments(member.name)) {
      const vendor = await vendors.vendor(assignment.vendor)
      if (vendor === undefined) continue
      if (vendor.auth === 'account') {
        const account = assignment.cliAccount === null ? undefined : await vendors.account(assignment.cliAccount)
        if (account !== undefined) accounts.push({ vendor: vendor.id, name: vendor.name, account: account.account })
        continue
      }
      // Voice vendors are the phone's, through /agent-work/phone/voice.
      if (vendor.type === 'voice') continue
      // Nothing to offer until the member holds an active key.
      if (assignment.apiKey === null || (await vendors.key(assignment.apiKey))?.status !== 'active' || vendor.protocol === null || vendor.models.length === 0) continue
      if (vendor.type === 'api') settings.push(...vendorSettings(vendor))
      else cli.push({ vendor: vendor.id, name: vendor.name, protocol: vendor.protocol, baseUrl: `${config.publicOrigin}${LLM_PREFIX}${vendor.id}`, keyRef: MODEL_KEY_REF })
    }
    const credentials = settings.length > 0 || cli.length > 0 ? [{ ref: MODEL_KEY_REF, from: 'device-token' }] : []
    return { version: 2, settings, credentials, cli, accounts, public: await vendors.publicValues() }
  }

  /**
   * The company models a member's GL Work (on Orca) may run its coding CLIs on: every key vendor
   * the member holds an active key for, with the gateway address to call it at (the device token
   * is the key there) and the models offered.
   */
  async function memberModels(member: Member) {
    const offered: { vendor: string; name: string; protocol: 'anthropic' | 'openai'; baseUrl: string; models: { id: string; name: string }[] }[] = []
    for (const assignment of await vendors.assignments(member.name)) {
      const vendor = await vendors.vendor(assignment.vendor)
      if (vendor === undefined || vendor.auth !== 'key' || vendor.type === 'voice' || assignment.apiKey === null) continue
      if ((vendor.protocol !== 'anthropic' && vendor.protocol !== 'openai') || vendor.models.length === 0) continue
      if ((await vendors.key(assignment.apiKey))?.status !== 'active') continue
      offered.push({
        vendor: vendor.id, name: vendor.name, protocol: vendor.protocol, baseUrl: `${config.publicOrigin}${LLM_PREFIX}${vendor.id}`,
        models: vendor.models.map(m => ({ id: m.id, name: m.name ?? m.id })),
      })
    }
    return { vendors: offered }
  }

  /** Routes under /agent-work/, answered by the gateway itself. */
  async function ownRoute(req: IncomingMessage, res: ServerResponse, url: URL, auth: Authentication): Promise<void> {
    if (url.pathname.startsWith(LLM_PREFIX)) { await llm(req, res, url); return }
    if (url.pathname === OLD_ADMIN || url.pathname.startsWith(`${OLD_ADMIN}/`)) {
      res.writeHead(301, { ...SECURITY_HEADERS, location: '/' })
      res.end()
      return
    }
    const route = `${req.method ?? ''} ${url.pathname}`
    if (url.pathname.startsWith(`${PREFIX}auth/`) && rateLimited(req)) {
      json(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' })
      return
    }
    switch (route) {
      case `GET ${PREFIX}auth/github/start`: {
        const state = await store.saveOAuthState({ kind: 'web', returnTo: safeReturnPath(url.searchParams.get('return_to')), redirectPort: null, codeChallenge: null, clientState: null }, OAUTH_STATE_TTL_MS)
        res.writeHead(302, { ...SECURITY_HEADERS, location: github.authorizeUrl(state, callbackUrl) })
        res.end()
        return
      }
      case `GET ${PREFIX}auth/desktop/start`: {
        const port = Number(url.searchParams.get('port'))
        const challenge = url.searchParams.get('code_challenge') ?? ''
        const clientState = url.searchParams.get('state') ?? ''
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || !PKCE_CHALLENGE.test(challenge) || !CLIENT_STATE.test(clientState)) {
          page(res, 400, '登录请求无效', '请回到桌面客户端重新登录。')
          return
        }
        const state = await store.saveOAuthState({ kind: 'desktop', returnTo: null, redirectPort: port, codeChallenge: challenge, clientState }, OAUTH_STATE_TTL_MS)
        res.writeHead(302, { ...SECURITY_HEADERS, location: github.authorizeUrl(state, callbackUrl) })
        res.end()
        return
      }
      // GL Work for iOS: the same GitHub sign-in, returning to the app with a one-time code.
      case `GET ${PREFIX}auth/phone/start`: {
        const challenge = url.searchParams.get('code_challenge') ?? ''
        const clientState = url.searchParams.get('state') ?? ''
        if (!PKCE_CHALLENGE.test(challenge) || !CLIENT_STATE.test(clientState)) {
          page(res, 400, '登录请求无效', '请回到 GL Work 重新登录。')
          return
        }
        const state = await store.saveOAuthState({ kind: 'phone', returnTo: null, redirectPort: null, codeChallenge: challenge, clientState }, OAUTH_STATE_TTL_MS)
        res.writeHead(302, { ...SECURITY_HEADERS, location: github.authorizeUrl(state, callbackUrl) })
        res.end()
        return
      }
      case `POST ${PREFIX}auth/phone/token`:
        await desktopToken(req, res, 'phone')
        return
      case `GET ${PREFIX}auth/github/callback`:
        await signInCallback(req, res, url)
        return
      case `POST ${PREFIX}auth/desktop/token`:
        await desktopToken(req, res)
        return
      // The Host sends the browser here once it holds the device token.
      case `GET ${PREFIX}auth/desktop/done`:
        page(res, 200, '登录成功', '已登录桌面客户端，可以关闭此页面并回到应用。')
        return
      // For the deployment's health checks: the process answers and its database reads.
      case `GET ${PREFIX}healthz`:
        await store.sql.one('select 1')
        json(res, 200, { ok: true }, { 'cache-control': 'no-store' })
        return
      // Account links in the desktop app (where Platform shows usage and top-up).
      case `GET ${PREFIX}account`:
        page(res, 200, '公司账号', '账号、模型和额度由公司统一管理。如有问题请联系管理员。')
        return
      default:
    }
    // frps asks about every frpc login, tunnel and heartbeat, on a path only it knows.
    const frp = FRP_PLUGIN.exec(url.pathname)
    if (frp !== null) { await frpPlugin(req, res, url, frp[1] as string); return }
    // The remaining routes act for a signed-in principal.
    if (auth.kind !== 'ok') { json(res, 401, { error: 'unauthenticated' }, { 'www-authenticate': 'Bearer' }); return }
    if (auth.via === 'browser' && crossSite(req)) { json(res, 403, { error: 'cross_site' }); return }
    const { member, credential } = auth.principal
    if (auth.via === 'phone') { await phoneRoute(req, res, url, route, auth.principal); return }
    const system = req.method === 'GET' ? SYSTEM_CONFIG.exec(url.pathname) : null
    if (system !== null) {
      const values = await vendors.publicValues(system[1], true)
      if (system[1] === undefined) { json(res, 200, values); return }
      if (!(system[1] in values)) { json(res, 404, { error: 'not_found' }); return }
      json(res, 200, { key: system[1], value: values[system[1]] })
      return
    }
    switch (route) {
      case `POST ${PREFIX}auth/logout`:
        await store.revokeCredential(credential.id)
        await audit(req, member.name, 'logout', credential.id)
        res.writeHead(204, auth.via === 'browser'
          ? { ...SECURITY_HEADERS, 'set-cookie': `${sessionCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` }
          : SECURITY_HEADERS)
        res.end()
        return
      // GL Work on Orca: the company models its CLIs may use (device tokens only).
      case `GET ${PREFIX}models`:
        if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
        json(res, 200, await memberModels(member))
        return
      case `GET ${PREFIX}config`:
        // What a Host applies: device tokens only (it names the device token as the model key).
        if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
        json(res, 200, await managedConfig(member))
        return
      // The company plugins GL Work lists for members to install by hand.
      case `GET ${PREFIX}plugins`:
        if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
        json(res, 200, {
          plugins: (await catalog.published()).map(p => ({
            name: p.name, displayName: p.displayName, description: p.description, version: p.version, url: p.url,
            integrity: p.integrity, size: p.size, permissions: p.permissions, preinstalled: p.preinstalled,
          })),
        })
        return
      // Which of them this desktop has installed, for the console's overview.
      case `POST ${PREFIX}plugins/installed`: {
        if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
        const body = await readJson(req)
        if (body === undefined) { json(res, 400, { error: 'invalid_request' }); return }
        json(res, 200, { recorded: await catalog.report(credential.id, body.plugins) })
        return
      }
      // The member's tunnels, for GL Work's tunnel plugin (which runs frpc).
      case `GET ${PREFIX}tunnels`:
        if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
        json(res, 200, await tunnels.forMember(member, credential.id))
        return
      case `POST ${PREFIX}tunnels`: {
        if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
        const body = await readJson(req)
        if (body === undefined) { json(res, 400, { error: 'invalid_request' }); return }
        await refusing(res, async () => {
          const tunnel = await tunnels.create(member, credential, body)
          await audit(req, member.name, 'tunnel-create', tunnel.id, `${tunnel.type} ${tunnel.name}`)
          json(res, 201, tunnel)
        })
        return
      }
      case `GET ${PREFIX}whoami`:
        json(res, 200, {
          member: member.name, githubId: member.githubId, githubLogin: member.githubLogin, role: member.role,
          credential: { id: credential.id, kind: credential.kind, expiresAt: credential.expiresAt },
        })
        return
      default: {
        const tunnel = TUNNEL.exec(url.pathname)
        if (tunnel !== null && (req.method === 'PATCH' || req.method === 'DELETE')) {
          if (auth.via !== 'device') { json(res, 403, { error: 'device_only' }); return }
          const id = tunnel[1] as string
          if (req.method === 'DELETE') {
            await refusing(res, async () => {
              const deleted = await tunnels.delete(id, member)
              await audit(req, member.name, 'tunnel-delete', id, `${deleted.type} ${deleted.name}`)
              res.writeHead(204, SECURITY_HEADERS)
              res.end()
            })
            return
          }
          const body = await readJson(req)
          if (body === undefined) { json(res, 400, { error: 'invalid_request' }); return }
          await refusing(res, async () => { json(res, 200, await tunnels.update(member, id, body)) })
          return
        }
        json(res, 404, { error: 'not_found' })
      }
    }
  }

  /** What a phone may do: list the member's Macs, reach them, use 语音, and sign out. */
  async function phoneRoute(req: IncomingMessage, res: ServerResponse, url: URL, route: string, { member, credential }: Principal): Promise<void> {
    switch (route) {
      case `POST ${PREFIX}auth/logout`:
        await store.revokeCredential(credential.id)
        await audit(req, member.name, 'logout', credential.id)
        res.writeHead(204, SECURITY_HEADERS)
        res.end()
        return
      case `GET ${PREFIX}whoami`:
        json(res, 200, {
          member: member.name, displayName: member.displayName, githubLogin: member.githubLogin, role: member.role,
          credential: { id: credential.id, kind: credential.kind, expiresAt: credential.expiresAt },
        })
        return
      case `GET ${PREFIX}remote/hosts`:
        json(res, 200, { hosts: await tunnels.remotes(member) })
        return
      // 语音: what the phone may use, and what to authenticate to the vendor with.
      case `GET ${PREFIX}phone/voice`:
        json(res, 200, await voice.forMember(member.name))
        return
      case `POST ${PREFIX}phone/voice/token`: {
        const body = await readJson(req)
        if (body === undefined) { json(res, 400, { error: 'invalid_request' }); return }
        try {
          json(res, 200, await voice.issueToken(member.name, body.vendor, fetchImpl))
        } catch (error) {
          if (!Refusal.is(error)) throw error
          json(res, error.status, { error: error.message })
        }
        return
      }
      default:
    }
    const remote = REMOTE.exec(url.pathname)
    const orca = remote === null ? REMOTE_ORCA.exec(url.pathname) : null
    if (remote === null && orca === null) { json(res, 403, { error: 'phone_not_allowed' }); return }
    const [, id = '', method = ''] = remote ?? orca ?? []
    // Orca's WebSocket is an upgrade (below); over plain HTTP only its pairing request crosses.
    const allowed = remote !== null ? REMOTE_METHOD.test(method) : orca?.[2] === '/pair'
    if (req.method !== 'POST' || !allowed) { json(res, 404, { error: 'not_found' }); return }
    const vhost = config.frps?.vhost ?? null
    if (vhost === null) { json(res, 503, { error: '公司服务没有配置手机远程' }); return }
    let host: string
    try {
      ({ host } = await tunnels.remoteTarget(member, id, orca !== null ? 'orca' : 'dsh'))
    } catch (error) {
      if (!Refusal.is(error)) throw error
      json(res, error.status, { error: error.message })
      return
    }
    if (orca !== null) {
      await audit(req, member.name, 'remote-pair', id, credential.label)
      await relayRequest(req, res, { vhost, host }, ORCA_PAIR_PATH, SECURITY_HEADERS)
      return
    }
    if (method === 'session.prompt' || method === 'respond') await audit(req, member.name, `remote-${method === 'respond' ? 'respond' : 'prompt'}`, id, credential.label)
    await relayRequest(req, res, { vhost, host }, `/api/${method}`, SECURITY_HEADERS)
  }

  /** The remote protocols' WebSockets: …/api/events.mux (DSH) and …/orca (Orca), from the phone to its member's Mac. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', config.publicOrigin)
    if (!url.pathname.startsWith(`${PREFIX}remote/`)) return false
    socket.on('error', () => { socket.destroy() })
    const remote = REMOTE.exec(url.pathname)
    const orca = REMOTE_ORCA.exec(url.pathname)
    const target = remote !== null && remote[2] === 'events.mux' ? { id: remote[1] as string, path: '/api/events.mux' }
      : orca !== null && orca[2] === undefined ? { id: orca[1] as string, path: '/' } : null
    if (req.method !== 'GET' || target === null || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      refuseUpgrade(socket, 404, 'not_found')
      return true
    }
    // The path is the service's: the rest is checked against the database, then relayed or refused.
    connectRemote(req, socket, head, target.id, target.path).catch((error: unknown) => {
      console.error('gateway: remote upgrade failed', error)
      refuseUpgrade(socket, 500, 'internal')
    })
    return true
  }

  async function connectRemote(req: IncomingMessage, socket: Duplex, head: Buffer, id: string, path: string): Promise<void> {
    await ready
    const authorization = req.headers.authorization ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
    const principal = await store.authenticate(token, 'phone', clientIp(req))
    if (principal === undefined) { refuseUpgrade(socket, 401, 'unauthenticated'); return }
    const vhost = config.frps?.vhost ?? null
    if (vhost === null) { refuseUpgrade(socket, 503, '公司服务没有配置手机远程'); return }
    let host: string
    try {
      ({ host } = await tunnels.remoteTarget(principal.member, id, path === '/' ? 'orca' : 'dsh'))
    } catch (error) {
      if (!Refusal.is(error)) throw error
      refuseUpgrade(socket, error.status, error.message)
      return
    }
    await audit(req, principal.member.name, 'remote-connect', id, principal.credential.label)
    if (socket.destroyed) return
    const close = relayUpgrade(req, socket, head, { vhost, host }, path)
    // A phone signed out or revoked, or 手机远程 closed, ends the stream within a minute.
    const recheck = setInterval(() => {
      void (async () => {
        const still = await store.authenticate(token, 'phone')
        let allowed = still !== undefined
        if (still !== undefined) try { await tunnels.remoteTarget(still.member, id, path === '/' ? 'orca' : 'dsh') } catch { allowed = false }
        if (!allowed) close()
      })().catch((error: unknown) => { console.error('gateway: remote recheck failed', error) })
    }, REMOTE_RECHECK_MS)
    recheck.unref()
    socket.on('close', () => { clearInterval(recheck) })
  }

  /** Answer a refusal as { error } with its status. */
  async function refusing(res: ServerResponse, run: () => unknown): Promise<void> {
    try {
      await run()
    } catch (error) {
      if (!Refusal.is(error)) throw error
      json(res, error.status, { error: error.message })
    }
  }

  /** One frps server-plugin call: POST ?op=<op> with { version, op, content }. */
  async function frpPlugin(req: IncomingMessage, res: ServerResponse, url: URL, secret: string): Promise<void> {
    if (req.method !== 'POST' || !tunnels.pluginPath(secret)) { json(res, 404, { error: 'not_found' }); return }
    const body = await readJson(req)
    const op = typeof body?.op === 'string' ? body.op : url.searchParams.get('op') ?? ''
    const content = body?.content
    if (typeof content !== 'object' || content === null) { json(res, 400, { error: 'invalid_request' }); return }
    json(res, 200, await tunnels.frp(op, content as Record<string, unknown>))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', config.publicOrigin)
    await ready
    if (url.pathname.startsWith(PREFIX)) { await ownRoute(req, res, url, await authenticate(req)); return }
    // Standalone (no web console mounted in front): a landing page, nothing else.
    if (req.method === 'GET' && url.pathname === '/') {
      page(res, 200, '公司 AI 工作台服务', '请在桌面客户端中使用 GitHub 账号登录。')
      return
    }
    json(res, 404, { error: 'not_found' })
  }

  return { handle, upgrade, vendors }
}
