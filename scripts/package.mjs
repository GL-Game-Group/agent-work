/**
 * Install, build, and package the desktop app from build/upstream.
 *
 * Usage: node scripts/package.mjs <script> [--skip-build]
 *   <script>      an upstream root package script, e.g. package:desktop:mac:arm64:dir
 *                 (unpacked app) or package:desktop:mac:arm64 (installer).
 *   --skip-build  reuse the existing build outputs in build/upstream.
 *
 * Packaging reads apps/desktop/.env.macos or .env.windows inside the stage;
 * provide it through overlay/apps/desktop/ (Git ignored) before staging.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fetchFrpc } from './fetch-frpc.mjs'
import { ROOT, STAGE, fail } from './lib.mjs'

const [script, ...flags] = process.argv.slice(2)
if (script === undefined || !script.startsWith('package:desktop:')) {
  fail('usage: node scripts/package.mjs package:desktop:<target> [--skip-build]')
}
if (!existsSync(STAGE)) fail(`${relative(ROOT, STAGE)} is missing; run \`pnpm stage\` first`)
const envFile = join(STAGE, 'apps', 'desktop', script.includes(':win:') ? '.env.windows' : '.env.macos')
if (!existsSync(envFile)) fail(`${relative(ROOT, envFile)} is missing; copy the matching .example in overlay/apps/desktop/ and re-stage`)

/**
 * Run one pnpm command inside the stage with inherited output.
 * @param {string[]} args - pnpm arguments.
 */
function pnpm(args) {
  execFileSync('pnpm', args, { cwd: STAGE, stdio: 'inherit' })
}

if (!flags.includes('--skip-build')) {
  pnpm(['install', '--frozen-lockfile'])
  pnpm(['run', 'build'])
}
// The tunnel plugin ships the frpc for this target only.
const target = /:(mac|win):(arm64|x64)/u.exec(script)
const frpcTarget = target === null ? `${process.platform}-${process.arch}` : `${target[1] === 'mac' ? 'darwin' : 'win32'}-${target[2]}`
const tunnelDir = join(STAGE, 'agent-work', 'plugins', 'tunnel')
if (!existsSync(tunnelDir)) fail(`${relative(ROOT, tunnelDir)} is missing; re-stage`)
rmSync(join(tunnelDir, 'bin'), { recursive: true, force: true })
await fetchFrpc(frpcTarget, tunnelDir, { declareBin: true })

pnpm(['run', script])
