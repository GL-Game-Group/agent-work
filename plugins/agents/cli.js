// @ts-check
/**
 * The command-line agents GL Work knows (Claude Code, Codex, Qoder CLI): where
 * they install, how they report a version and a sign-in, and how they are
 * installed. No Host services here, so it is tested on its own (test/cli.test.mjs).
 */
import { join } from 'node:path'

/**
 * @typedef {object} CliSpec
 * @property {'claude' | 'codex' | 'qoder'} id - also the company service's vendor id.
 * @property {string} name
 * @property {string} command - the executable name on PATH.
 * @property {(home: string, platform: NodeJS.Platform) => string[]} candidates - install locations to try after PATH.
 * @property {string[] | null} status - arguments reporting the sign-in, or null when the CLI has none.
 * @property {string[]} login - arguments starting the official sign-in.
 * @property {'script' | 'release'} install
 */

/** @type {CliSpec[]} */
export const CLIS = [
  {
    id: 'claude', name: 'Claude Code', command: 'claude',
    candidates: (home, platform) => platform === 'win32'
      ? [join(home, '.local', 'bin', 'claude.exe')]
      : [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
    status: ['auth', 'status'], login: ['auth', 'login'], install: 'script',
  },
  {
    id: 'codex', name: 'Codex', command: 'codex',
    candidates: (home, platform) => platform === 'win32'
      ? [join(home, '.local', 'bin', 'codex.exe')]
      : [join(home, '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    status: ['login', 'status'], login: ['login'], install: 'release',
  },
  {
    id: 'qoder', name: 'Qoder CLI', command: 'qodercli',
    candidates: (home, platform) => platform === 'win32'
      ? [join(home, '.local', 'bin', 'qodercli.exe')]
      : [join(home, '.local', 'bin', 'qodercli'), '/opt/homebrew/bin/qodercli', '/usr/local/bin/qodercli'],
    status: null, login: ['login'], install: 'script',
  },
]

/** Official install scripts (each verifies what it downloads). */
export const SCRIPTS = {
  claude: { posix: 'https://claude.ai/install.sh', windows: 'https://claude.ai/install.ps1', args: [] },
  // --skip-path: GL Work does not edit the member's shell configuration.
  qoder: { posix: 'https://qoder.com/install', windows: null, args: ['--skip-path', '--quiet'] },
}

/**
 * The version number in a `--version` line: `2.1.285 (Claude Code)`, `codex-cli 0.157.1`, `1.1.65`.
 * @param {string} text
 * @returns {string | null}
 */
export function parseVersion(text) {
  return /\b(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\b/u.exec(text)?.[1] ?? null
}

/**
 * Whether a CLI's sign-in report says it is signed in.
 * @param {'claude' | 'codex' | 'qoder'} id
 * @param {{ exitCode: number | null, stdout: string, stderr: string }} result
 * @returns {boolean | null} null when the report cannot tell.
 */
export function parseSignedIn(id, result) {
  const text = `${result.stdout}\n${result.stderr}`
  if (id === 'claude') {
    try { return /** @type {{ loggedIn?: unknown }} */ (JSON.parse(result.stdout)).loggedIn === true } catch { return result.exitCode === 0 ? null : false }
  }
  if (id === 'codex') {
    if (/not logged in/iu.test(text)) return false
    return /logged in/iu.test(text) ? true : null
  }
  return null
}

/**
 * The first web address a sign-in command prints, for the page to open.
 * @param {string} text
 * @returns {string | null}
 */
export function signInUrl(text) {
  return /https:\/\/[^\s"'<>]+/u.exec(text)?.[0] ?? null
}
