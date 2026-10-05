/**
 * Rewrite patches/ from the commits on top of the pin in build/upstream.
 *
 * Workflow: edit files in build/upstream, `git commit` there (one commit per
 * concern), then run this script. Uncommitted changes are refused so an edit
 * is never silently left out. Paths that overlay/ overwrites are exempt.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { OVERLAY, PATCHES, ROOT, STAGE, fail, git, readPin } from './lib.mjs'

const pin = readPin()
const pending = git(STAGE, ['status', '--porcelain', '--untracked-files=no'], { raw: true })
  .split('\n')
  .filter(line => line !== '' && !isOverlayPath(line.slice(3)))
if (pending.length > 0) fail(`commit or discard these changes in ${relative(ROOT, STAGE)} first:\n${pending.join('\n')}`)

const count = Number(git(STAGE, ['rev-list', '--count', `${pin.commit}..HEAD`]))
mkdirSync(PATCHES, { recursive: true })
for (const name of readdirSync(PATCHES)) {
  if (name.endsWith('.patch')) rmSync(join(PATCHES, name))
}
if (count > 0) {
  git(STAGE, ['format-patch', '--zero-commit', '--no-signature', '--no-stat', '-o', PATCHES, `${pin.commit}..HEAD`])
}
console.log(`agent-work: wrote ${count} patch(es) to ${relative(ROOT, PATCHES)}`)

/**
 * Whether a tracked path in the stage is overwritten by overlay/ and therefore
 * expected to differ from its commit.
 * @param {string} path - stage-relative path from git status.
 * @returns {boolean} true when overlay/ owns the path.
 */
function isOverlayPath(path) {
  return existsSync(join(OVERLAY, path))
}
