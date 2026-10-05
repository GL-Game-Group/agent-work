/** Shared paths and helpers for the agent-work build scripts. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const UPSTREAM = join(ROOT, 'upstream')
export const STAGE = join(ROOT, 'build', 'upstream')
export const PATCHES = join(ROOT, 'patches')
export const OVERLAY = join(ROOT, 'overlay')
export const PLUGINS = join(ROOT, 'plugins')

/**
 * The pinned upstream release recorded in upstream.json.
 * @returns {{ repository: string, tag: string, commit: string }} the pin.
 */
export function readPin() {
  return JSON.parse(readFileSync(join(ROOT, 'upstream.json'), 'utf8'))
}

/**
 * Run git and return trimmed stdout; a non-zero exit throws.
 * @param {string} cwd - repository directory.
 * @param {string[]} args - git arguments.
 * @param {{ raw?: boolean }} [options] - `raw` returns stdout untrimmed (porcelain output starts with a status column).
 * @returns {string} stdout, trimmed unless `raw`.
 */
export function git(cwd, args, options = {}) {
  const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  return options.raw ? out : out.trim()
}

/**
 * Print a failure and exit with status 1.
 * @param {string} message - diagnostic shown to the operator.
 * @returns {never}
 */
export function fail(message) {
  console.error(`agent-work: ${message}`)
  process.exit(1)
}
