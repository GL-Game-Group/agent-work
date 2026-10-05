// @ts-check
/**
 * Company account: signs a member's local Host in to the company service with
 * GitHub, in place of the DeepSeek Platform account. It implements the
 * upstream `deepseekAccount` seam, so the desktop welcome window, the Settings
 * account section and every other consumer work unchanged.
 *
 * Browser sign-in follows the upstream loopback contract: the Host serves
 * `/oauth/callback` while an attempt waits, the company service sends the
 * browser there with a one-time code after GitHub approves the member, and the
 * Host trades that code plus its PKCE verifier for a device token, which it
 * keeps in the credential store. The token never reaches any page.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { arch, hostname, platform, release } from 'node:os'
import { promises as streamPromises } from 'node:stream'
import { Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { DeepSeekAccount, installAccountTaskCancellation } from '@deepseek-ai/dsh-deepseek-account'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').AccountView} AccountView */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').AccountDetails} AccountDetails */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').AccountClientMetadata} AccountClientMetadata */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').SignInAttemptView} SignInAttemptView */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').SignInAttemptId} SignInAttemptId */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').SignInErrorCode} SignInErrorCode */
/** @typedef {import('@deepseek-ai/dsh-deepseek-account').AccountUserId} AccountUserId */
/** @typedef {import('@deepseek-ai/dsh-authorization').AuthorizationSession} AuthorizationSession */

const KEY = credentialKey('agent-work-account', 'default')
const DEVICE = credentialKey('agent-work-account', 'device')
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * @typedef {object} Config
 * @property {string | { get(): string }} [serverOrigin] - The company service the member signs in to; live
 *   (the welcome window's server setting writes it through `settings/mutate`, saved in the member's profile).
 * @property {boolean} [allowLoopbackHttp] - Accept http://127.0.0.1 for a local development service.
 * @property {number} [requestTimeoutMs] - Deadline for each company service request.
 * @property {number} [attemptTimeoutMs] - Upper bound for one browser sign-in attempt.
 */
export const Config = Schema.object({
  serverOrigin: Schema.string().pattern(/^https?:\/\/[^\s/?#]+\/?$/).default('https://agent.glgwork.com').volatile(),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
})

/** A failure carrying one of the codes the account UIs know how to render. */
class AccountError extends Error {
  /** @param {SignInErrorCode} code */
  constructor(code) {
    super(`company account: ${code}`)
    this.code = code
  }
}

/** The service rejected the stored device token (revoked, expired, member disabled). */
class TokenRejectedError extends Error {}

/**
 * @param {string} value
 * @param {boolean} allowLoopbackHttp
 * @returns {string} a bare origin.
 */
function serviceOrigin(value, allowLoopbackHttp) {
  const url = new URL(value)
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('company account: serverOrigin must be an https origin')
  }
  return url.origin
}

/**
 * The Host origin the browser returns to; the upstream callers pass the Host's own loopback origin.
 * @param {string} value
 * @returns {URL}
 */
function callbackOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.port === '' || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash) {
    throw new AccountError('protocol')
  }
  return url
}

/**
 * @param {unknown} payload
 * @returns {{ version: 1, token: string, issuer: string, member: string } | undefined}
 */
function parseGrant(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = /** @type {Record<string, unknown>} */ (payload)
  return value.version === 1 && typeof value.token === 'string' && value.token !== '' && typeof value.issuer === 'string'
    && typeof value.member === 'string'
    ? { version: 1, token: value.token, issuer: value.issuer, member: value.member }
    : undefined
}

function deviceOsVersion() {
  return `${platform()} ${release()}`
}

/**
 * @typedef {object} Attempt
 * @property {SignInAttemptView} view
 * @property {AbortController} controller
 * @property {Promise<void>} done
 * @property {Promise<void>} running
 * @property {URL} origin
 * @property {(() => Promise<void>) | undefined} [disposeCallback]
 * @property {import('node:http').ServerResponse | undefined} [callback]
 */

export class CompanyAccount extends DeepSeekAccount {
  static inject = ['credentials', 'authorization']
  static Config = Config

  /** @type {Set<() => void>} */
  _listeners = new Set()
  /** @type {Attempt | undefined} */
  _attempt
  /** @type {Promise<AccountView> | undefined} */
  _removing
  /** @type {Set<Promise<void>>} */
  _background = new Set()
  _closed = false
  _lifetime = new AbortController()
  /** @type {string} */
  _origin
  /** @type {() => string} */
  _configuredOrigin
  /** @type {boolean} */
  _allowLoopbackHttp
  /** @type {number} */
  _requestTimeout
  /** @type {number} */
  _attemptTimeout

  /**
   * @param {Context} ctx - Host with credentials and authorization services.
   * @param {Config} [config]
   */
  constructor(ctx, config = {}) {
    super(ctx)
    installAccountTaskCancellation(ctx)
    // The Loader hands the validated config with live fields as refs; a bare object (tests) is validated here.
    const resolved = typeof config.serverOrigin === 'object' ? config : Config(/** @type {{ serverOrigin?: string }} */ (config))
    const origin = resolved.serverOrigin
    this._configuredOrigin = () => (typeof origin === 'object' ? origin.get() : origin ?? 'https://agent.glgwork.com')
    this._allowLoopbackHttp = resolved.allowLoopbackHttp ?? false
    this._origin = serviceOrigin(this._configuredOrigin(), this._allowLoopbackHttp)
    this._requestTimeout = resolved.requestTimeoutMs ?? 30_000
    this._attemptTimeout = resolved.attemptTimeoutMs ?? 600_000
    // The server is chosen in the welcome window, not on a generated Settings page.
    ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
    // Emitted by the Loader after a live field changes (type declared by @deepseek-ai/cordis-plugin-loader).
    const loaderEvents = /** @type {{ on: (name: 'loader/volatile-update', listener: () => void) => () => void }} */ (/** @type {unknown} */ (ctx))
    loaderEvents.on('loader/volatile-update', () => { this._inBackground(this._serverChanged()) })
    ctx.authorization.registerFlow({
      key: KEY, label: 'GitHub', methods: [{ id: 'browser', label: 'GitHub' }],
      run: (session) => {
        const attempt = this._attempt
        if (attempt === undefined) return Promise.reject(new AccountError('protocol'))
        attempt.running = this._run(session, attempt)
        return attempt.running
      },
    })
    ctx.on('credentials/record-updated', (key) => { if (key === KEY) this._changed() })
    ctx.effect(() => async () => {
      this._closed = true
      this._lifetime.abort()
      const active = this._attempt
      if (active !== undefined) {
        if (active.view.phase !== 'committing') active.controller.abort()
        await active.done
      }
      await this._removing
      await Promise.all(this._background)
      this._changed()
    }, 'company account: lifetime')
  }

  async [Service.init]() {
    // A grant issued by another company service (say, a development one) is never sent to this one.
    const stored = await this._readGrant()
    if (stored !== undefined && stored.issuer !== this._origin) await this.ctx.credentials.deleteRecord(KEY)
  }

  /** @returns {Promise<AccountView>} */
  async getState() {
    const stored = await this._readGrant()
    const attempt = this._attempt?.view ?? null
    const account = new URL('/agent-work/account', this._origin).href
    return {
      status: stored === undefined ? 'signed-out' : 'credential-stored',
      attempt: stored === undefined && attempt?.phase === 'succeeded' ? null : attempt,
      links: { usageUrl: account, topUpUrl: account },
    }
  }

  /**
   * @param {AccountClientMetadata} _client
   * @returns {Promise<AccountDetails['profile'] | null>}
   */
  async getProfile(_client) {
    const stored = await this._currentGrant()
    if (stored === undefined) return null
    try {
      const me = /** @type {{ member: string, githubId: number, githubLogin: string }} */ (await this._request('GET', '/agent-work/whoami', stored.token))
      return {
        status: 'ready',
        value: {
          id: /** @type {AccountUserId} */ (me.member),
          name: me.member,
          // Shown under the name; an empty contact would read as "profile unavailable".
          contact: `GitHub @${me.githubLogin}`,
          avatarUrl: `https://avatars.githubusercontent.com/u/${String(me.githubId)}`,
        },
      }
    } catch (error) {
      if (error instanceof TokenRejectedError) await this._expire(stored.token)
      return { status: 'failed' }
    }
  }

  /**
   * No wallets: models are paid for by the company through its gateway.
   * @returns {Promise<AccountDetails['balance'] | null>}
   */
  async getBalance() {
    return (await this._currentGrant()) === undefined ? null : { status: 'ready', value: [], bonusWallets: [] }
  }

  async getUnnotifiedBonuses() { return null }

  async ackBonusNotified() { return false }

  /**
   * @param {AccountClientMetadata} _client
   * @param {string} origin - the Host origin the browser returns to.
   * @param {'web' | 'desktop'} _loginSource
   * @returns {Promise<AccountView>}
   */
  async startSignIn(_client, origin, _loginSource) {
    if (this._removing !== undefined) await this._removing
    const returnTo = callbackOrigin(origin)
    if (this._closed) throw new AccountError('protocol')
    const current = this._attempt
    if (current !== undefined && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(current.view.phase)) {
      return this.getState()
    }
    if (current !== undefined) {
      await current.done
      if (this._closed) throw new AccountError('protocol')
      if (this._attempt !== current) return this.getState()
    }
    /** @type {Attempt} */
    const attempt = {
      origin: returnTo,
      view: { id: /** @type {SignInAttemptId} */ (randomUUID()), phase: 'initializing' },
      controller: new AbortController(), done: Promise.resolve(), running: Promise.resolve(),
    }
    this._attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: KEY, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new AccountError('protocol')) },
    }).then((outcome) => {
      this._update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
      if (outcome.status === 'authorized') {
        attempt.callback?.writeHead(302, { 'location': new URL('/agent-work/auth/desktop/done', this._origin).href, 'cache-control': 'no-store' }).end()
      } else {
        attempt.callback?.writeHead(204, { 'cache-control': 'no-store' }).end()
      }
    }).catch((/** @type {unknown} */ error) => {
      const code = error instanceof AccountError ? error.code : 'protocol'
      console.info('[company-account] sign-in failed', { errorCode: code })
      this._update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
      attempt.callback?.writeHead(204, { 'cache-control': 'no-store' }).end()
    }).then(async () => {
      await attempt.running.catch(() => undefined)
      if (attempt.callback !== undefined) await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      await attempt.disposeCallback?.()
    })
    this._changed()
    return this.getState()
  }

  /**
   * @param {SignInAttemptId} id
   * @returns {Promise<AccountView>}
   */
  async cancelSignIn(id) {
    const attempt = this._attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  /**
   * @param {AccountClientMetadata} _client
   * @returns {Promise<AccountView>}
   */
  signOut(_client) {
    this._removing ??= (async () => {
      if (this._closed) throw new AccountError('protocol')
      if (this._attempt !== undefined) await this.cancelSignIn(this._attempt.view.id)
      const stored = await this._readGrant()
      if (stored !== undefined) {
        await this.ctx.credentials.deleteRecord(KEY)
        // Revoke on the service in the background; the local sign-out never waits for the network.
        this._inBackground(this._request('POST', '/agent-work/auth/logout', stored.token).then(() => undefined, () => undefined))
      }
      this._attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this._changed()
      return this.getState()
    })().finally(() => { this._removing = undefined })
    return this._removing
  }

  /**
   * @param {AbortSignal} signal
   * @returns {AsyncIterable<AccountView>}
   */
  async *watch(signal) {
    let dirty = true
    /** @type {(() => void) | undefined} */
    let wake
    const changed = () => { dirty = true; wake?.() }
    this._listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this._closed && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise((resolve) => { wake = () => { resolve(undefined) } })
      }
    } finally {
      this._listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  /** The device token authenticates the company service only; no inference origin accepts it. */
  async resolveToken() { return undefined }

  async rejectToken() {}

  /** There is no embedded Platform document to open. */
  async getPlatformSession() { return null }

  async getDeviceIdentity() {
    const [device, stored] = await Promise.all([this.ctx.credentials.readRecord(DEVICE), this._readGrant()])
    const id = device?.kind === 'grant' ? /** @type {{ id?: unknown }} */ (device.payload).id : undefined
    return {
      ...typeof id === 'string' ? { deviceId: id } : {},
      ...stored === undefined ? {} : { userId: /** @type {AccountUserId} */ (stored.member) },
      osVersion: deviceOsVersion(),
    }
  }

  /** @returns the company service origin this account signs in to. */
  companyServer() {
    return this._origin
  }

  /**
   * Follow a changed server setting: a sign-in in progress is cancelled and the old server's
   * grant is forgotten (it is never sent to another server), so the member signs in again.
   * An unusable value keeps the current server.
   */
  async _serverChanged() {
    let next
    try { next = serviceOrigin(this._configuredOrigin(), this._allowLoopbackHttp) }
    catch (error) {
      this.ctx.logger('company-account').warn('ignoring server setting: %s', error instanceof Error ? error.message : String(error))
      return
    }
    if (next === this._origin || this._closed) return
    const attempt = this._attempt
    if (attempt !== undefined) await this.cancelSignIn(attempt.view.id).catch(() => undefined)
    // Forget the old grant before the new server becomes visible, so no reader sees both.
    const stored = await this._readGrant().catch(() => undefined)
    const forget = stored !== undefined && stored.issuer !== next
    if (forget) await this.ctx.credentials.deleteRecord(KEY)
    this._origin = next
    if (forget) this.ctx.emit('deepseek-account/signed-out')
    this._changed()
  }

  /**
   * The member's device token, for other team plugins that call the company service.
   * @returns {Promise<string | undefined>}
   */
  async companyToken() {
    return (await this._currentGrant())?.token
  }

  /**
   * The browser half of one attempt: serve the loopback callback, wait for the code, trade it for a token.
   * @param {AuthorizationSession} session
   * @param {Attempt} attempt
   */
  async _run(session, attempt) {
    const webServer = /** @type {import('@deepseek-ai/dsh-host-webserver').WebServer | undefined} */ (this.ctx.get('webServer'))
    if (webServer === undefined) throw new AccountError('protocol')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    /** @type {PromiseWithResolvers<string>} */
    const code = Promise.withResolvers()
    void code.promise.catch(() => undefined)
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort() }, this._attemptTimeout)
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const abort = () => { code.reject(new AccountError('expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      attempt.disposeCallback = this.ctx.effect(() => webServer.register({
        kind: 'exact', path: '/oauth/callback', handler: (req, res) => {
          /** @type {URL} */
          let url
          try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return }
          const receivedCode = url.searchParams.get('code')
          const receivedState = url.searchParams.get('state') ?? ''
          const validState = Buffer.byteLength(receivedState) === Buffer.byteLength(state)
            && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
          if (req.method !== 'GET' || !validState || receivedCode === null
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
            res.writeHead(400, { 'cache-control': 'no-store' }).end()
            return
          }
          if (signal.aborted || attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
            res.writeHead(410, { 'cache-control': 'no-store' }).end()
            return
          }
          attempt.callback = res
          code.resolve(receivedCode)
        },
      }), 'company account: browser callback')
      signal.throwIfAborted()
      const authorize = new URL('/agent-work/auth/desktop/start', this._origin)
      authorize.searchParams.set('port', attempt.origin.port)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('state', state)
      this._update(attempt, { phase: 'waiting-browser', authorizeUrl: authorize.href, expiresAt: Date.now() + this._attemptTimeout })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this._update(attempt, { phase: 'exchanging' })
      await this.ctx.credentials.modifyRecord(DEVICE, current => Promise.resolve(current === undefined
        ? { kind: 'grant', payload: { id: randomUUID() } } : undefined))
      const result = /** @type {{ token?: unknown, member?: unknown }} */ (await this._request('POST', '/agent-work/auth/desktop/token', undefined, {
        code: receivedCode, code_verifier: verifier, device_name: `${hostname()} (${platform()}-${arch()})`,
      }, signal))
      if (typeof result.token !== 'string' || typeof result.member !== 'string') throw new AccountError('protocol')
      signal.throwIfAborted()
      this._update(attempt, { phase: 'committing' })
      clearTimeout(timer)
      try {
        await session.commit({ kind: 'grant', payload: { version: 1, token: result.token, issuer: this._origin, member: result.member } })
      } catch { throw new AccountError('storage') }
    } catch (error) {
      if (deadline.signal.aborted) throw new AccountError('expired')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  /**
   * Call the company service.
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {string | undefined} token - device token, when the route needs one.
   * @param {unknown} [body]
   * @param {AbortSignal} [signal]
   * @returns {Promise<unknown>}
   */
  async _request(method, path, token, body, signal) {
    /** @type {Response} */
    let response
    try {
      response = await fetch(new URL(path, this._origin), {
        method,
        redirect: 'error',
        headers: {
          ...body === undefined ? {} : { 'content-type': 'application/json' },
          ...token === undefined ? {} : { authorization: `Bearer ${token}` },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.any([this._lifetime.signal, AbortSignal.timeout(this._requestTimeout), ...signal === undefined ? [] : [signal]]),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new AccountError('network')
    }
    if (response.status === 401 && token !== undefined) throw new TokenRejectedError()
    if (response.status === 204) return undefined
    if (!response.ok) throw new AccountError('protocol')
    try { return await response.json() } catch { throw new AccountError('protocol') }
  }

  /** @returns {Promise<{ version: 1, token: string, issuer: string, member: string } | undefined>} */
  async _readGrant() {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return undefined
    const parsed = record.kind === 'grant' ? parseGrant(record.payload) : undefined
    if (parsed === undefined) throw new AccountError('storage')
    return parsed
  }

  /** A stored grant this service issued, unless the provider is closing or signing out. */
  async _currentGrant() {
    if (this._closed || this._removing !== undefined) return undefined
    const stored = await this._readGrant()
    return stored?.issuer === this._origin ? stored : undefined
  }

  /**
   * The service rejected the token: forget it, and tell the UIs the session expired.
   * @param {string} token - the rejected token; a newer one stored meanwhile is kept.
   */
  async _expire(token) {
    this._removing ??= (async () => {
      const stored = await this._readGrant()
      if (stored?.token !== token) return this.getState()
      await this.ctx.credentials.deleteRecord(KEY)
      this.ctx.emit('deepseek-account/session-expired')
      this._attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this._changed()
      return this.getState()
    })().finally(() => { this._removing = undefined })
    await this._removing
  }

  /** @param {Promise<void>} task */
  _inBackground(task) {
    const tracked = task.finally(() => { this._background.delete(tracked) })
    this._background.add(tracked)
  }

  _changed() { for (const listener of this._listeners) listener() }

  /**
   * @param {Attempt} attempt
   * @param {Partial<SignInAttemptView>} value
   */
  _update(attempt, value) {
    const { authorizeUrl: _url, ...rest } = attempt.view
    attempt.view = { ...rest, ...value }
    this._changed()
  }
}

export default CompanyAccount
