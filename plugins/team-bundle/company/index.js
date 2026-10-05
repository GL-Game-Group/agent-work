// @ts-check
/**
 * Company plugins, Host half (its own package beside the team bundle: a
 * package with a client module may have only one Loader row): the plugins the
 * company service lists for this member, with what this profile has installed,
 * for the "公司插件" page the client half draws; and their installation when
 * the member asks for it.
 *
 * Installing downloads the package the company registered, checks it against
 * the sha512 the company recorded, keeps it under $DSH_HOME/agent-work/plugins,
 * and hands that file to the Plugin Manager; packages that want to run install
 * scripts are refused. Preinstalled plugins ship with GL Work and update with it.
 *
 * The page reaches it at /api/agent-work/company-plugins[/install], routes of
 * the Host's client connection: only the signed-in GL Work window may call them.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @typedef {import('@deepseek-ai/cordis').Context} Context */
/**
 * @typedef {object} CatalogPlugin
 * @property {string} name
 * @property {string} displayName
 * @property {string | null} description
 * @property {string} version
 * @property {string} url
 * @property {string} integrity
 * @property {number} size
 * @property {string[]} permissions
 * @property {boolean} preinstalled
 */
/**
 * @typedef {object} PluginManager
 * @property {() => Promise<{ name: string, version?: string, enabled: boolean }[]>} listBundles
 * @property {(spec: string, options?: { enabled?: boolean }) => Promise<ChangeResult>} installBundle
 * @property {(name: string, enabled: boolean) => Promise<ChangeResult>} setBundleEnabled
 */
/**
 * @typedef {object} ChangeResult
 * @property {'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'} application
 * @property {{ code: string, diagnostic?: string }} [error]
 * @property {string[]} [pendingBuilds]
 * @property {string} [bundle]
 */

export const name = 'agent-work-company-plugins'
export const inject = ['deepseekAccount', 'connection']

const ROUTE = '/api/agent-work/company-plugins'
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** A refusal shown to the member as is. */
class Refusal extends Error {}

/** Why the Plugin Manager did not install, as members read it. */
/** @param {ChangeResult} result */
function failure(result) {
  if (result.pendingBuilds !== undefined && result.pendingBuilds.length > 0) return `插件要执行安装脚本（${result.pendingBuilds.join('、')}），公司插件不允许，已停止安装`
  switch (result.error?.code) {
    case 'incompatible-version': return '这个插件和当前版本的 GL Work 不兼容，请先更新 GL Work'
    case 'not-bundle': return '下载到的不是 GL Work 插件'
    case 'read-only': case 'readonly': return '当前配置是只读的，不能安装插件'
    default: return `安装失败（${result.error?.code ?? result.application}）${result.error?.diagnostic ? `：${result.error.diagnostic.slice(-300)}` : ''}`
  }
}

/** @param {Context} ctx */
export function apply(ctx) {
  const account = /** @type {{ companyServer?: () => string, companyToken?: () => Promise<string | undefined> }} */ (/** @type {unknown} */ (ctx.deepseekAccount))
  const logger = ctx.logger('agent-work-company-plugins')
  const packages = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agent-work', 'plugins')
  /** One installation at a time. */
  /** @type {Promise<unknown>} */
  let installing = Promise.resolve()

  /** @returns {PluginManager | undefined} */
  function manager() {
    return /** @type {PluginManager | undefined} */ (ctx.get('pluginManager'))
  }

  async function installed() {
    const plugins = manager()
    if (plugins === undefined) return new Map()
    return new Map((await plugins.listBundles()).map(b => [b.name, b]))
  }

  /** The company service, signed in; undefined when signed out. */
  async function company() {
    const token = await account.companyToken?.()
    const server = account.companyServer?.()
    if (token === undefined || server === undefined) return undefined
    return { server, headers: { authorization: `Bearer ${token}` } }
  }

  /** @param {{ server: string, headers: Record<string, string> }} service @returns {Promise<CatalogPlugin[]>} */
  async function catalog(service) {
    const response = await fetch(new URL('/agent-work/plugins', service.server), { headers: service.headers, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Refusal(`公司服务返回 ${response.status}`)
    return /** @type {{ plugins: CatalogPlugin[] }} */ (await response.json()).plugins
  }

  /** Tell the console which catalog plugins run here (best effort). */
  /** @param {{ server: string, headers: Record<string, string> }} service @param {{ name: string, version: string }[]} plugins */
  function report(service, plugins) {
    fetch(new URL('/agent-work/plugins/installed', service.server), {
      method: 'POST', headers: { ...service.headers, 'content-type': 'application/json' }, body: JSON.stringify({ plugins }), signal: AbortSignal.timeout(15_000),
    }).catch((error) => { logger.debug('could not report installed plugins: %s', error instanceof Error ? error.message : String(error)) })
  }

  async function list() {
    const service = await company()
    if (service === undefined) return json({ signedIn: false, plugins: [] })
    let plugins
    try { plugins = await catalog(service) } catch (error) {
      return json({ signedIn: true, error: error instanceof Refusal ? error.message : '暂时连不上公司服务', plugins: [] })
    }
    const local = await installed()
    const merged = plugins.map((p) => {
      const bundle = local.get(p.name)
      return { ...p, installedVersion: bundle?.version ?? null, enabled: bundle?.enabled ?? false }
    })
    report(service, merged.flatMap(p => p.installedVersion === null ? [] : [{ name: p.name, version: p.installedVersion }]))
    return json({ signedIn: true, canInstall: manager() !== undefined, plugins: merged })
  }

  /** Download a package, refusing anything but the bytes the company registered. */
  /** @param {CatalogPlugin} plugin */
  async function download(plugin) {
    let response
    try { response = await fetch(plugin.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) }) } catch {
      throw new Refusal(`下载失败：连不上 ${new URL(plugin.url).host}`)
    }
    if (!response.ok || response.body === null) throw new Refusal(`下载失败（${response.status}）`)
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body))) {
      size += chunk.length
      if (size > MAX_PACKAGE_BYTES) throw new Refusal('插件包太大')
      chunks.push(Buffer.from(chunk))
    }
    const tarball = Buffer.concat(chunks)
    if (`sha512-${createHash('sha512').update(tarball).digest('base64')}` !== plugin.integrity) {
      throw new Refusal('下载到的插件包和公司登记的不一致（sha512 不符），已停止安装，请联系管理员')
    }
    await mkdir(packages, { recursive: true })
    const file = join(packages, `${plugin.name.replace(/^@/u, '').replace(/\//gu, '__')}-${plugin.version}.tgz`)
    await writeFile(file, tarball)
    return file
  }

  /** @param {Request} request */
  async function install(request) {
    /** @type {{ name?: unknown }} */
    let body
    try { body = /** @type {{ name?: unknown }} */ (await request.json()) } catch { return json({ error: '请求格式不正确' }, 400) }
    const plugins = manager()
    if (plugins === undefined) return json({ error: '这个 GL Work 不能安装插件' }, 409)
    const service = await company()
    if (service === undefined) return json({ error: '请先登录公司账号' }, 401)
    const run = installing.then(async () => {
      // The catalog as of now: only a published plugin, at the version the company lists.
      const plugin = (await catalog(service)).find(p => p.name === body.name)
      if (plugin === undefined) throw new Refusal('公司没有上架这个插件')
      if (plugin.preinstalled) throw new Refusal('这个插件随 GL Work 安装，跟着 GL Work 更新')
      const file = await download(plugin)
      logger.info('installing company plugin %s %s', plugin.name, plugin.version)
      const result = await plugins.installBundle(file, { enabled: false })
      if (result.application === 'failed' || result.application === 'cancelled') throw new Refusal(failure(result))
      const enabled = await plugins.setBundleEnabled(plugin.name, true)
      if (enabled.application === 'failed') throw new Refusal(failure(enabled))
      const local = await installed()
      report(service, [...local.values()].map(b => ({ name: b.name, version: b.version ?? '' })))
      const restart = result.application === 'restart-required' || enabled.application === 'restart-required'
      return { installed: plugin.name, version: plugin.version, restart }
    })
    installing = run.catch(() => undefined)
    try {
      return json(await run)
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, 409)
      logger.warn('company plugin installation failed: %s', error instanceof Error ? error.message : String(error))
      return json({ error: '安装失败，请稍后重试' }, 500)
    }
  }

  const connection = /** @type {{ fetch: { register: (route: { path: string, methods: string[], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }) => () => Promise<void> } }} */ (/** @type {unknown} */ (ctx.get('connection')))
  const guard = /** @param {() => Promise<Response>} handler */ handler => handler().catch((error) => {
    logger.warn('company plugins failed: %s', error instanceof Error ? error.message : String(error))
    return json({ error: '读取插件列表失败' }, 500)
  })
  ctx.effect(() => connection.fetch.register({ path: ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: () => guard(list) }), 'agent-work company plugins route')
  ctx.effect(() => connection.fetch.register({ path: `${ROUTE}/install`, methods: ['POST'], requestBody: 'buffered', fetch: request => guard(() => install(request)) }), 'agent-work company plugin install route')
}
