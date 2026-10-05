/**
 * Put the pinned frpc for one target into a tunnel plugin directory, at
 * bin/<platform>-<arch>/frpc[.exe], where the plugin looks for it.
 *
 * The release archive comes from GitHub (cached in build/cache/frp) and must
 * match the sha256 pinned in plugins/tunnel/frpc-release.json, or nothing is
 * written. Only frpc is taken from the archive.
 *
 * Usage: node scripts/fetch-frpc.mjs [<platform>-<arch>] [<plugin dir>]
 *   defaults: this machine's target, plugins/tunnel.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { PLUGINS, ROOT, fail } from './lib.mjs'

const release = JSON.parse(readFileSync(join(PLUGINS, 'tunnel', 'frpc-release.json'), 'utf8'))

/**
 * @param {string} target - e.g. darwin-arm64, win32-x64.
 * @param {string} pluginDir
 * @param {{ declareBin?: boolean }} [options] - declareBin: also name frpc in the
 *   directory's package.json `bin`, the only files `pnpm pack` keeps executable
 *   (for the staged copy packaging packs; never the source plugin).
 * @returns {Promise<string>} the frpc written.
 */
export async function fetchFrpc(target, pluginDir, options = {}) {
  const entry = release.targets[target]
  if (entry === undefined) fail(`no frpc pinned for ${target} (have: ${Object.keys(release.targets).join(', ')})`)
  const cache = join(ROOT, 'build', 'cache', 'frp')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, entry.asset)
  const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  if (!existsSync(archive) || sha256(archive) !== entry.sha256) {
    const url = release.url.replace('{version}', release.version).replace('{asset}', entry.asset)
    console.log(`agent-work: downloading ${url}`)
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
    if (!response.ok) fail(`download failed (${response.status}): ${url}`)
    writeFileSync(`${archive}.part`, Buffer.from(await response.arrayBuffer()))
    const actual = sha256(`${archive}.part`)
    if (actual !== entry.sha256) {
      rmSync(`${archive}.part`)
      fail(`${entry.asset}: sha256 ${actual} does not match the pinned ${entry.sha256}`)
    }
    copyFileSync(`${archive}.part`, archive)
    rmSync(`${archive}.part`)
  }
  const windows = target.startsWith('win32-')
  const binary = windows ? 'frpc.exe' : 'frpc'
  const top = entry.asset.replace(/\.(tar\.gz|zip)$/u, '')
  const scratch = mkdtempSync(join(tmpdir(), 'aw-frpc-'))
  try {
    // bsdtar (macOS, Windows 10+) reads both .tar.gz and .zip.
    execFileSync('tar', ['-xf', archive, '-C', scratch, `${top}/${binary}`], { stdio: 'inherit' })
    const dest = join(pluginDir, 'bin', target)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    copyFileSync(join(scratch, top, binary), join(dest, binary))
    chmodSync(join(dest, binary), 0o755)
    writeFileSync(join(dest, 'VERSION'), `frp ${release.version} ${entry.asset} sha256:${entry.sha256}\n`)
    if (options.declareBin === true) {
      const manifest = join(pluginDir, 'package.json')
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      pkg.bin = { 'agent-work-frpc': `bin/${target}/${binary}` }
      writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
    }
    return join(dest, binary)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ?? `${process.platform}-${process.arch}`
  const pluginDir = resolve(process.argv[3] ?? join(PLUGINS, 'tunnel'))
  const written = await fetchFrpc(target, pluginDir)
  console.log(`agent-work: frpc ${release.version} for ${target} at ${relative(ROOT, written)}`)
}
