/**
 * Try GL Work on this Mac without making an installer: stage the working tree,
 * build the unpacked app (no DMG, no notarization), quit the GL Work that is
 * running, and open the new one. Sign-in, tunnels and settings live in the
 * member's home directory, so the new build picks them up.
 *
 *   pnpm try:desktop                # stage, build, open
 *   pnpm try:desktop --skip-stage   # build what is in build/upstream now (after editing there)
 *   pnpm try:desktop --open         # reopen the last unpacked build
 *
 * macOS only. Needs overlay/apps/desktop/.env.macos (as for `pnpm package`).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT, STAGE, fail } from './lib.mjs'

const flags = new Set(process.argv.slice(2))
for (const flag of flags) if (!['--skip-stage', '--open'].includes(flag)) fail(`try:desktop: unknown option ${flag}`)
if (process.platform !== 'darwin') fail('try:desktop: macOS only (Windows: pnpm package package:desktop:win:x64:dir)')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

// Electron refuses to start as an app when the terminal (VS Code, Claude Code) exported this.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

/** @param {string} script @param {string[]} args */
function node(script, args) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { cwd: ROOT, stdio: 'inherit', env })
}

if (!flags.has('--open')) {
  if (!flags.has('--skip-stage')) node('stage.mjs', ['--reset'])
  node('package.mjs', [`package:desktop:mac:${arch}:dir`])
}

/** The product name and app id the build was made with (the staged .env.macos). */
function identity() {
  const file = join(STAGE, 'apps', 'desktop', '.env.macos')
  if (!existsSync(file)) fail(`try:desktop: ${relative(ROOT, file)} is missing; copy overlay/apps/desktop/.env.macos.example to .env.macos and re-stage`)
  const text = readFileSync(file, 'utf8')
  const read = (/** @type {string} */ name) => new RegExp(`^${name}=["']?([^"'\\n]*)["']?$`, 'mu').exec(text)?.[1]?.trim() || undefined
  return { name: read('DSH_DESKTOP_PRODUCT_NAME') ?? 'DeepSeek Harness', appId: read('DSH_DESKTOP_APP_ID') }
}

/**
 * The newest `<name>.app` under the target's build directory (not one nested in another app).
 * @param {string} name
 */
function newestApp(name) {
  const root = join(STAGE, 'apps', 'desktop', '.desktop-build', 'targets', `mac-${arch}`)
  /** @type {{ path: string, time: number }[]} */
  const found = []
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 6 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === `${name}.app`) found.push({ path, time: statSync(path).mtimeMs })
      else if (!entry.name.endsWith('.app') && entry.name !== 'node_modules') walk(path, depth + 1)
    }
  }
  walk(root, 0)
  found.sort((a, b) => b.time - a.time)
  return found[0]?.path
}

const { name, appId } = identity()
const app = newestApp(name)
if (app === undefined) fail(`try:desktop: no ${name}.app under build/upstream; run pnpm try:desktop without --open`)

/** Whether any copy of the app (installed or built) is running. */
const running = () => spawnSync('pgrep', ['-f', `/${name}.app/Contents/MacOS/`]).status === 0

// Ask the running copy to quit as the member would (it may close its own windows first);
// two copies with one app id fight over the same profile and Host port.
if (running()) {
  console.log(`try:desktop: quitting the running ${name}`)
  spawnSync('osascript', ['-e', appId === undefined ? `tell application "${name}" to quit` : `tell application id "${appId}" to quit`], { stdio: 'ignore' })
  for (let i = 0; i < 60 && running(); i += 1) spawnSync('sleep', ['0.5'])
  if (running()) fail(`try:desktop: ${name} is still running; quit it (⌘Q) and run pnpm try:desktop --open`)
}

console.log(`try:desktop: opening ${relative(ROOT, app)}`)
execFileSync('open', ['-n', app], { env })
