// @ts-check
/**
 * Company config sync: applies what the company service hands a signed-in
 * Host (GET /agent-work/config) without overriding the member's own edits.
 *
 * Settings are written by path, never by replacing a section, and only in the
 * namespaces listed below. The last value applied to each path is remembered;
 * a path is updated only while its current value is still the one applied
 * last (or, the first time, while the member has not set it), so a member who
 * changes a value in Settings keeps it. Credentials the config names are set
 * to the Host's own device token, and removed again on sign-out.
 */
import Schema from '@deepseek-ai/schemastery'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/** @typedef {{ ns: string, path: string[], value: unknown }} ManagedSetting */
/** @typedef {{ ref: string, from: 'device-token' }} ManagedCredential */
/** @typedef {{ settings: ManagedSetting[], credentials: string[] }} AppliedState */

const STATE = credentialKey('agent-work-account', 'managed')
/** The only settings namespaces the company service may write. */
const MANAGED_NAMESPACES = new Set(['llm-deepseek', 'llm-pi-ai', 'agent-default-model'])
const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u

export const name = 'agent-work-config-sync'
export const inject = ['deepseekAccount', 'settings', 'credentials']

/**
 * @typedef {object} Config
 * @property {number} [intervalMs] - How often a signed-in Host re-reads the company config.
 * @property {number} [requestTimeoutMs] - Deadline for one config request.
 */
export const Config = Schema.object({
  intervalMs: Schema.number().min(1000).default(30 * 60 * 1000),
  requestTimeoutMs: Schema.number().min(1).default(30_000),
})

/** @param {unknown} a @param {unknown} b */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** @param {unknown} value @param {readonly string[]} path */
function at(value, path) {
  let node = value
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = /** @type {Record<string, unknown>} */ (node)[key]
  }
  return node
}

/**
 * Keep only well-formed entries the Host allows the company to manage.
 * @param {unknown} body
 * @returns {{ settings: ManagedSetting[], credentials: ManagedCredential[] }}
 */
function parseConfig(body) {
  const value = /** @type {{ settings?: unknown, credentials?: unknown }} */ (typeof body === 'object' && body !== null ? body : {})
  const settings = (Array.isArray(value.settings) ? value.settings : []).filter(
    /** @returns {entry is ManagedSetting} */
    (entry) => typeof entry === 'object' && entry !== null && MANAGED_NAMESPACES.has(entry.ns)
      && Array.isArray(entry.path) && entry.path.length > 0 && entry.path.every((/** @type {unknown} */ key) => typeof key === 'string') && 'value' in entry,
  )
  const credentials = (Array.isArray(value.credentials) ? value.credentials : []).filter(
    /** @returns {entry is ManagedCredential} */
    (entry) => typeof entry === 'object' && entry !== null && typeof entry.ref === 'string' && REFERENCE.test(entry.ref) && entry.from === 'device-token',
  )
  return { settings, credentials }
}

/**
 * @param {Context} ctx
 * @param {Required<Config>} config
 */
export function apply(ctx, config) {
  const account = /** @type {{ companyServer?: () => string, companyToken?: () => Promise<string | undefined>, watch: (signal: AbortSignal) => AsyncIterable<{ status: string }> }} */ (/** @type {unknown} */ (ctx.deepseekAccount))
  const logger = ctx.logger('agent-work-config-sync')
  /** @type {Promise<void> | undefined} */
  let running
  let again = false

  /** @returns {Promise<AppliedState>} */
  async function readState() {
    const record = await ctx.credentials.readRecord(STATE)
    const payload = record?.kind === 'grant' ? /** @type {Partial<AppliedState>} */ (record.payload) : {}
    return { settings: Array.isArray(payload.settings) ? payload.settings : [], credentials: Array.isArray(payload.credentials) ? payload.credentials : [] }
  }

  /** @param {AppliedState} state */
  async function writeState(state) {
    await ctx.credentials.modifyRecord(STATE, () => Promise.resolve({ kind: 'grant', payload: state }))
  }

  /** Signed out: the device token is gone, so are the credentials holding it. */
  async function forgetCredentials() {
    const state = await readState()
    if (state.credentials.length === 0) return
    for (const ref of state.credentials) await ctx.credentials.unset(credentialRef(ref)).catch(() => undefined)
    await writeState({ ...state, credentials: [] })
    logger.info('removed company model credentials after sign-out')
  }

  /**
   * Apply one namespace's managed paths with the three-way rule.
   * @param {string} ns
   * @param {ManagedSetting[]} desired
   * @param {ManagedSetting[]} last
   * @returns {Promise<ManagedSetting[]>} the entries this Host now holds as company-applied.
   */
  async function applyNamespace(ns, desired, last) {
    for (let attempt = 0; ; attempt += 1) {
      const descriptor = ctx.settings.describe().find(row => row.ns === ns)
      if (descriptor === undefined) return last
      /** @type {import('@deepseek-ai/dsh-settings').SettingsPathOp[]} */
      const ops = []
      /** @type {ManagedSetting[]} */
      const held = []
      for (const entry of desired) {
        // The user layer holds what was written; the resolved value fills in schema defaults, so objects would never compare equal.
        const current = at(descriptor.user, entry.path)
        const previous = last.find(item => same(item.path, entry.path))
        const untouched = previous === undefined ? current === undefined : same(current, previous.value)
        if (same(current, entry.value)) held.push(entry)
        else if (untouched) { ops.push({ op: 'set', path: entry.path, value: entry.value }); held.push(entry) }
        else if (previous !== undefined) held.push(previous) // The member changed it: keep their value, remember ours.
      }
      for (const previous of last) {
        if (desired.some(entry => same(entry.path, previous.path))) continue
        // The company retired this path; undo it unless the member has changed it since.
        if (same(at(descriptor.user, previous.path), previous.value)) ops.push({ op: 'unset', path: previous.path })
      }
      if (ops.length === 0) return held
      try {
        await ctx.settings.mutate(ns, ops, descriptor.revision)
        logger.info('applied %d company setting(s) to %s', ops.length, ns)
        return held
      } catch (error) {
        // A concurrent edit moved the revision; read it again once.
        if (attempt > 0) throw error
      }
    }
  }

  async function sync() {
    const token = await account.companyToken?.()
    const server = account.companyServer?.()
    if (token === undefined || server === undefined) { await forgetCredentials(); return }
    let response
    try {
      response = await fetch(new URL('/agent-work/config', server), {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
    } catch (error) {
      logger.warn('company config unavailable: %s', error instanceof Error ? error.message : String(error))
      return
    }
    if (!response.ok) { logger.warn('company config request answered %d', response.status); return }
    const desired = parseConfig(await response.json().catch(() => undefined))
    const state = await readState()
    /** @type {ManagedSetting[]} */
    const settings = []
    for (const ns of new Set([...desired.settings, ...state.settings].map(entry => entry.ns))) {
      if (!MANAGED_NAMESPACES.has(ns)) continue
      try {
        settings.push(...await applyNamespace(ns, desired.settings.filter(entry => entry.ns === ns), state.settings.filter(entry => entry.ns === ns)))
      } catch (error) {
        logger.warn('could not apply company settings to %s: %s', ns, error instanceof Error ? error.message : String(error))
        settings.push(...state.settings.filter(entry => entry.ns === ns))
      }
    }
    /** @type {string[]} */
    const credentials = []
    for (const { ref } of desired.credentials) {
      try {
        const current = await ctx.credentials.resolve(credentialRef(ref))
        if (current?.value !== token) await ctx.credentials.set(credentialRef(ref), token)
        credentials.push(ref)
      } catch (error) {
        // For example a variable of that name exported in the member's shell, which the Host cannot override.
        logger.warn('could not store the company model key as %s: %s', ref, error instanceof Error ? error.message : String(error))
      }
    }
    for (const ref of state.credentials) {
      if (!credentials.includes(ref)) await ctx.credentials.unset(credentialRef(ref)).catch(() => undefined)
    }
    await writeState({ settings, credentials })
  }

  /** Run a sync, coalescing triggers that arrive while one is running. */
  function trigger() {
    if (running !== undefined) { again = true; return }
    running = sync().catch((error) => {
      logger.warn('company config sync failed: %s', error instanceof Error ? error.message : String(error))
    }).finally(() => {
      running = undefined
      if (again) { again = false; trigger() }
    })
  }

  ctx.effect(() => {
    const lifetime = new AbortController()
    void (async () => {
      // Every account change (sign-in, sign-out, expiry) re-syncs; the first item is the current state.
      for await (const _view of account.watch(lifetime.signal)) trigger()
    })().catch(() => undefined)
    const timer = setInterval(trigger, config.intervalMs)
    return async () => {
      lifetime.abort()
      clearInterval(timer)
      await running
    }
  }, 'agent-work config sync')
}
