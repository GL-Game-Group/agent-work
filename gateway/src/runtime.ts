/**
 * One company service process: the store, the vendor store, the services the
 * web console calls, and the handler for the service's own routes. The web
 * console (admin/, SvelteKit) runs in the same process and reaches it through
 * {@link getRuntime}: its server code is bundled separately from the code
 * that starts the process, so the instance is shared on globalThis rather
 * than through a module singleton.
 */
import type { GatewayConfig } from './config.ts'
import { Store } from './db.ts'
import { GitHub } from './github.ts'
import { SecretBox } from './secrets.ts'
import { PluginCatalog } from './plugins.ts'
import { createGatewayHandler, importLegacyKey, sessionCookieName, type GatewayHandler } from './server.ts'
import { Tunnels } from './tunnels.ts'
import { AdminService, SelfService } from './services.ts'
import { Vendors } from './vendors.ts'

export interface Runtime {
  config: GatewayConfig
  store: Store
  github: GitHub
  vendors: Vendors
  plugins: PluginCatalog
  tunnels: Tunnels
  admin: AdminService
  self: SelfService
  /** Handles everything under /agent-work/. */
  gateway: GatewayHandler['handle']
  /** WebSocket upgrades under /agent-work/ (手机远程); false for other paths. */
  upgrade: GatewayHandler['upgrade']
  sessionCookie: string
}

export interface RuntimeOptions {
  store?: Store
  github?: GitHub
  now?: () => number
  authRateLimit?: { requests: number; windowMs: number }
  /** Downloads plugin packages; injectable for tests. */
  fetch?: typeof fetch
}

const KEY = Symbol.for('agent-work.runtime')

export function createRuntime(config: GatewayConfig, options: RuntimeOptions = {}): Runtime {
  const store = options.store ?? new Store(config.databasePath)
  const github = options.github ?? new GitHub(config.github)
  const secrets = config.secretKey === undefined ? undefined : SecretBox.fromEncoded(config.secretKey)
  const vendors = new Vendors(store, secrets, options.now)
  importLegacyKey(config, store, vendors, secrets !== undefined)
  const plugins = new PluginCatalog(store, options.now)
  const tunnels = new Tunnels(store, config, options.now)
  const { handle, upgrade } = createGatewayHandler({
    config, store, github, vendors, plugins, tunnels, webLogin: true,
    ...options.now === undefined ? {} : { now: options.now },
    ...options.authRateLimit === undefined ? {} : { authRateLimit: options.authRateLimit },
  })
  const deps = {
    config, store, github, vendors, plugins, tunnels,
    ...options.now === undefined ? {} : { now: options.now },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  }
  return {
    config, store, github, vendors, plugins, tunnels,
    admin: new AdminService(deps),
    self: new SelfService(deps),
    gateway: handle,
    upgrade,
    sessionCookie: sessionCookieName(config.publicOrigin),
  }
}

export function setRuntime(runtime: Runtime): void {
  (globalThis as Record<symbol, unknown>)[KEY] = runtime
}

export function getRuntime(): Runtime {
  const runtime = (globalThis as Record<symbol, unknown>)[KEY] as Runtime | undefined
  if (runtime === undefined) throw new Error('agent-work: the company service runtime is not started (start the server through admin/server.js or the dev plugin)')
  return runtime
}
