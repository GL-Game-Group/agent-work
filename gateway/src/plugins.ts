/**
 * The company's plugin catalog: plugin packages (DeepSeek Harness bundles,
 * npm-pack tarballs on OSS) an administrator registered, which GL Work lists
 * for members to install by hand. The service reads each tarball once when it
 * is registered: it must be a bundle, must not run install scripts, and its
 * sha512 is recorded so the desktop can check what it downloads.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Refusal } from './errors.ts'
import type { Store } from './db.ts'

/** Plugins carry their frpc-sized binaries; anything far larger is a mistake. */
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000
/** Scripts pnpm runs on install; company plugins may not have them (the install would stop for approval). */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

export interface PluginPackage {
  name: string
  version: string
  description: string | null
  /** npm-style subresource integrity: sha512-<base64>. */
  integrity: string
  size: number
  dependencies: number
}

export interface Plugin {
  name: string
  displayName: string
  description: string | null
  version: string
  url: string
  integrity: string
  size: number
  permissions: string[]
  status: 'published' | 'hidden'
  /** Ships with GL Work; listed for its updates. */
  preinstalled: boolean
  createdAt: number
  updatedAt: number
}

interface PluginRow {
  name: string; display_name: string; description: string | null; version: string; url: string; integrity: string; size: number
  permissions: string; status: 'published' | 'hidden'; preinstalled: number; created_at: number; updated_at: number
}

function toPlugin(row: PluginRow): Plugin {
  return {
    name: row.name, displayName: row.display_name, description: row.description, version: row.version, url: row.url, integrity: row.integrity,
    size: row.size, permissions: JSON.parse(row.permissions) as string[], status: row.status, preinstalled: row.preinstalled === 1,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

/** A download address: https, or http on this machine (local development and tests). */
export function packageUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try { url = new URL(raw) } catch { throw new Refusal(400, '请填写插件包的下载地址') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Refusal(400, '下载地址必须使用 https')
  if (url.username !== '' || url.password !== '') throw new Refusal(400, '下载地址不能带账号')
  return url.href
}

/** The entries of a tar archive, by path (ustar, as npm and pnpm pack write it). */
function untar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  let longName: string | null = null
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    const name = longName ?? (prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`)
    const body = archive.subarray(offset + 512, offset + 512 + size)
    longName = null
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/su, '')
    else if (type === '0' || type === '') files.set(name, body)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

/** A minimal bundle manifest and patch, for tests and the development seed. */
export function sampleBundle(name: string, version: string, extra: Record<string, unknown> = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name, version, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra }),
    'cordis.patch.yml': '[]\n',
    'index.js': 'export const name = "sample"\nexport function apply() {}\n',
  }
}

/** A minimal npm-pack-style tarball (everything under package/), for tests and the development seed. */
export function packTarball(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = []
  for (const [path, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? Buffer.from(content) : content
    const header = Buffer.alloc(512)
    header.write(`package/${path}`, 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(`${[...header].reduce((n, byte) => n + byte, 0).toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** Read a packed plugin: what it is, and whether the catalog may carry it. */
export function readPackage(tarball: Buffer): PluginPackage {
  let files: Map<string, Buffer>
  try { files = untar(gunzipSync(tarball)) } catch { throw new Refusal(400, '不是 npm pack 打出的 .tgz 插件包') }
  // npm pack puts everything under package/; take the shallowest package.json.
  const manifestPath = [...files.keys()].filter(p => /^[^/]+\/package\.json$/u.test(p)).sort((a, b) => a.length - b.length)[0]
  if (manifestPath === undefined) throw new Refusal(400, '插件包里没有 package.json')
  let manifest: { name?: unknown; version?: unknown; description?: unknown; dsh?: { bundle?: { patch?: unknown } | null }; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown> }
  try { manifest = JSON.parse(files.get(manifestPath)!.toString('utf8')) as typeof manifest } catch { throw new Refusal(400, '插件包的 package.json 不是有效的 JSON') }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Refusal(400, '插件包缺少 name 或 version')
  if (typeof manifest.dsh?.bundle !== 'object' || manifest.dsh.bundle === null) throw new Refusal(400, `${manifest.name} 不是 DeepSeek Harness 插件（package.json 没有 dsh.bundle）`)
  // The Plugin Manager refuses a bundle without its patch file(s); refuse it here, before anyone installs it.
  const root = manifestPath.slice(0, -'package.json'.length)
  const patches = typeof manifest.dsh.bundle.patch === 'string' ? [manifest.dsh.bundle.patch] : Array.isArray(manifest.dsh.bundle.patch) ? manifest.dsh.bundle.patch : null
  if (patches === null || patches.length === 0 || !patches.every(p => typeof p === 'string')) throw new Refusal(400, `${manifest.name} 没有声明插件配置（dsh.bundle.patch）`)
  const missing = (patches as string[]).filter(p => !files.has(root + p.replace(/^\.\//u, '')))
  if (missing.length > 0) throw new Refusal(400, `${manifest.name} 声明的插件配置不在包里：${missing.join('、')}`)
  const scripts = INSTALL_SCRIPTS.filter(script => typeof manifest.scripts?.[script] === 'string')
  if (scripts.length > 0) throw new Refusal(400, `${manifest.name} 带有安装脚本（${scripts.join('、')}），公司插件不能在成员电脑上执行安装脚本`)
  return {
    name: manifest.name, version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description : null,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    size: tarball.length,
    dependencies: Object.keys(manifest.dependencies ?? {}).length,
  }
}

/** Download a plugin package (bounded) and read it. */
export async function fetchPackage(url: string, fetchImpl: typeof fetch = fetch): Promise<PluginPackage> {
  let response: Response
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch {
    throw new Refusal(502, `无法下载 ${new URL(url).host} 上的插件包`)
  }
  if (!response.ok || response.body === null) throw new Refusal(502, `下载插件包失败（${String(response.status)}）`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_PACKAGE_BYTES) throw new Refusal(413, '插件包太大')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > MAX_PACKAGE_BYTES) throw new Refusal(413, '插件包太大')
    chunks.push(Buffer.from(chunk))
  }
  return readPackage(Buffer.concat(chunks))
}

export class PluginCatalog {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(store: Store, now: () => number = Date.now) {
    this.db = store.db
    this.now = now
  }

  list(): Plugin[] {
    return (this.db.prepare('select * from plugins order by preinstalled desc, display_name').all() as unknown as PluginRow[]).map(toPlugin)
  }

  get(name: string): Plugin | undefined {
    const row = this.db.prepare('select * from plugins where name = ?').get(name) as PluginRow | undefined
    return row === undefined ? undefined : toPlugin(row)
  }

  /** What GL Work lists: published plugins only. */
  published(): Plugin[] {
    return this.list().filter(p => p.status === 'published')
  }

  /**
   * Register a package, or a new version of a registered one.
   * @param expect - when given, the package must be this plugin (updating it).
   */
  save(pkg: PluginPackage, url: string, meta: { displayName: string; permissions: string[]; preinstalled: boolean; status?: 'published' | 'hidden' }, expect?: string): Plugin {
    if (expect !== undefined && expect !== pkg.name) throw new Refusal(409, `新的插件包是 ${pkg.name}，不是 ${expect}`)
    const now = this.now()
    this.db.prepare(`insert into plugins (name, display_name, description, version, url, integrity, size, permissions, status, preinstalled, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (name) do update set display_name = excluded.display_name, description = excluded.description, version = excluded.version,
        url = excluded.url, integrity = excluded.integrity, size = excluded.size, permissions = excluded.permissions,
        status = coalesce(?, plugins.status), preinstalled = excluded.preinstalled, updated_at = excluded.updated_at`)
      .run(pkg.name, meta.displayName, pkg.description, pkg.version, url, pkg.integrity, pkg.size, JSON.stringify(meta.permissions), meta.status ?? 'hidden',
        meta.preinstalled ? 1 : 0, now, now, meta.status ?? null)
    return this.get(pkg.name) as Plugin
  }

  /** Edit what members read about a plugin, without a new package. */
  describe(name: string, meta: { displayName: string; permissions: string[]; preinstalled: boolean }): Plugin {
    if (Number(this.db.prepare('update plugins set display_name = ?, permissions = ?, preinstalled = ?, updated_at = ? where name = ?')
      .run(meta.displayName, JSON.stringify(meta.permissions), meta.preinstalled ? 1 : 0, this.now(), name).changes) === 0) throw new Refusal(404, `没有插件 ${name}`)
    return this.get(name) as Plugin
  }

  setStatus(name: string, status: unknown): Plugin {
    if (status !== 'published' && status !== 'hidden') throw new Refusal(400, '状态只能是上架或下架')
    if (Number(this.db.prepare('update plugins set status = ?, updated_at = ? where name = ?').run(status, this.now(), name).changes) === 0) throw new Refusal(404, `没有插件 ${name}`)
    return this.get(name) as Plugin
  }

  delete(name: string): Plugin {
    const plugin = this.get(name)
    if (plugin === undefined) throw new Refusal(404, `没有插件 ${name}`)
    this.db.prepare('delete from plugins where name = ?').run(name)
    return plugin
  }

  /** A desktop's report of the catalog plugins it has installed; the rest of its list is not kept. */
  report(credential: string, installed: unknown): number {
    const known = new Set(this.list().map(p => p.name))
    const entries = (Array.isArray(installed) ? installed : []).flatMap((entry: unknown) => {
      const { name, version } = (typeof entry === 'object' && entry !== null ? entry : {}) as { name?: unknown; version?: unknown }
      return typeof name === 'string' && known.has(name) && typeof version === 'string' && version.length <= 64 ? [{ name, version }] : []
    })
    this.db.exec('begin')
    try {
      this.db.prepare('delete from device_plugins where credential = ?').run(credential)
      const insert = this.db.prepare('insert into device_plugins (credential, plugin, version, reported_at) values (?, ?, ?, ?)')
      for (const { name, version } of entries) insert.run(credential, name, version, this.now())
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
    return entries.length
  }

  /** Installed catalog plugins per live desktop device. */
  installs(): { credential: string; plugin: string; version: string; reportedAt: number }[] {
    const rows = this.db.prepare(`select d.credential, d.plugin, d.version, d.reported_at as reportedAt from device_plugins d
      join credentials c on c.id = d.credential where c.revoked_at is null and c.kind = 'device'`).all() as unknown as { credential: string; plugin: string; version: string; reportedAt: number }[]
    return rows.map(row => ({ ...row }))
  }
}
