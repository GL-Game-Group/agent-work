// @ts-check
/**
 * Workspace management helpers without Host services, tested on their own
 * (test/git.test.mjs): repository identity, worktree and branch naming, and
 * reading what git and gh print.
 */
import { basename, dirname, join } from 'node:path'

/**
 * A remote URL's repository identity, so different spellings of one GitHub
 * repository compare equal: `git@github.com:Org/Repo.git`, `ssh://git@github.com/org/repo`
 * and `https://github.com/org/repo` all become `github.com/org/repo`.
 * @param {string} url
 * @returns {string | undefined} lower-cased `host/owner/repo`, or undefined for anything else.
 */
export function repoIdentity(url) {
  const value = url.trim()
  let host
  let path
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/u.exec(value)
  if (scp !== null) {
    host = scp[1]
    path = scp[2]
  } else {
    let parsed
    try { parsed = new URL(value) } catch { return undefined }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined
    host = parsed.hostname
    path = parsed.pathname
  }
  const parts = (path ?? '').replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '').split('/')
  if (parts.length !== 2 || parts.some(part => part === '')) return undefined
  return `${host}/${parts[0]}/${parts[1]}`.toLowerCase()
}

/** Names members type for a new workspace: letters, digits, `.`, `_`, `-`, CJK. */
export const NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,62}$/u

/**
 * Where a repository's worktrees live: beside it, in `<repo>.worktrees/<name>`.
 * @param {string} mainRoot - the main working tree's top-level directory.
 * @param {string} name
 * @returns {string}
 */
export function worktreeDir(mainRoot, name) {
  if (!NAME.test(name)) throw new Error('名字只能用字母、数字、中文和 . _ -（最长 63 个字符）')
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`, name)
}

/**
 * The branch a new worktree starts: `<login>/<name>`, or `<name>` without a login.
 * @param {string | null} login - the member's GitHub login, when known.
 * @param {string} name
 * @returns {string}
 */
export function branchFor(login, name) {
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '-')
  return login === null ? slug : `${login.toLowerCase()}/${slug}`
}

/**
 * Whether git accepts a branch name (a subset of `git check-ref-format --branch`).
 * @param {string} branch
 * @returns {boolean}
 */
export function validBranch(branch) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._/-]{0,199}$/u.test(branch)
    && !/\.\.|\/\/|@\{|\.lock(\/|$)|\/$|\.$|\/\./u.test(branch)
}

/**
 * The one-time code `gh auth login --web` prints for the browser.
 * @param {string} text - gh's output so far.
 * @returns {string | undefined}
 */
export function deviceCode(text) {
  return /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u.exec(text)?.[1]
}

/**
 * The percentage of a `git clone --progress` line, weighted so receiving
 * objects fills most of the bar and resolving deltas the rest.
 * @param {string} line
 * @returns {{ percent: number, stage: string } | undefined}
 */
export function cloneProgress(line) {
  const m = /(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files):\s+(\d+)%/u.exec(line)
  if (m === null) return undefined
  const stage = m[1] ?? ''
  const percent = Number(m[2])
  const weighted = stage === 'Receiving objects' ? percent * 0.8
    : stage === 'Resolving deltas' ? 80 + percent * 0.15
      : stage === 'Updating files' ? 95 + percent * 0.05 : 0
  return { percent: Math.round(weighted), stage }
}

/**
 * Directories a member must not turn into a repository by accident.
 * @param {string} path - canonical directory.
 * @param {string} home
 * @returns {boolean}
 */
export function refusesInit(path, home) {
  const normalized = path.replace(/[\\/]+$/u, '')
  return normalized === '' || normalized === home.replace(/[\\/]+$/u, '') || /^[A-Za-z]:$/u.test(normalized) || dirname(normalized) === normalized
}

/**
 * Where members keep their code, searched for clones made outside GL Work
 * (GL Work's own clone root first). Relative to the home directory.
 */
export const SEARCH_ROOTS = ['GLWork', 'Documents', 'Desktop', 'Downloads', 'code', 'Code', 'src', 'dev', 'work', 'Work',
  'projects', 'Projects', 'repos', 'workspace', 'workspaces', 'github', 'GitHub', 'git']

/** How deep below a search root a repository may sit (`~/Documents/work/team/<repo>` is 3). */
export const SEARCH_DEPTH = 4

/**
 * Directories never searched: hidden ones, dependencies and build output, and
 * macOS's media and app data folders.
 * @param {string} name
 */
export function skipsDir(name) {
  return name.startsWith('.') || ['node_modules', 'vendor', 'dist', 'build', 'target', 'Library', 'Applications',
    'Pictures', 'Movies', 'Music', 'Photos Library.photoslibrary'].includes(name) || name.endsWith('.worktrees') || name.endsWith('.app')
}

/**
 * The repository a `.git/config` points at through its `origin` remote, as {@link repoIdentity}.
 * @param {string} text - the config file.
 * @returns {string | undefined}
 */
export function originOfConfig(text) {
  let inOrigin = false
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/u.test(line); continue }
    const url = inOrigin ? /^url\s*=\s*(.+)$/u.exec(line) : null
    if (url !== null) return repoIdentity(url[1] ?? '')
  }
  return undefined
}
