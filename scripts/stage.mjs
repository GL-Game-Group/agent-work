/**
 * Build the patched upstream copy at build/upstream.
 *
 * The copy is a git worktree of the submodule, detached at the pinned commit,
 * so upstream/ itself is never modified. Patches are applied with `git am` and
 * remain commits on top of the pin, which lets save-patches regenerate
 * patches/ after an edit or a conflict resolution. Overlay files are copied
 * over the result and stay uncommitted.
 *
 * Usage: node scripts/stage.mjs [--reset]
 *   --reset  discard every tracked change and untracked non-ignored file in an
 *            existing build/upstream (ignored build outputs such as
 *            node_modules are kept) and re-apply patches.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { OVERLAY, PATCHES, ROOT, STAGE, UPSTREAM, fail, git, readPin } from './lib.mjs'

execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-upstream.mjs')], { stdio: 'inherit' })
const pin = readPin()
const reset = process.argv.includes('--reset')

if (!existsSync(STAGE)) {
  git(UPSTREAM, ['worktree', 'add', '--detach', STAGE, pin.commit])
} else if (reset) {
  const amState = resolve(STAGE, git(STAGE, ['rev-parse', '--git-path', 'rebase-apply']))
  if (existsSync(amState)) git(STAGE, ['am', '--abort'])
  git(STAGE, ['reset', '--hard', pin.commit])
  git(STAGE, ['clean', '-fd'])
} else {
  fail(`${relative(ROOT, STAGE)} already exists; pass --reset to discard its changes and re-stage`)
}

const patches = readdirSync(PATCHES).filter(name => name.endsWith('.patch')).sort()
if (patches.length > 0) {
  try {
    git(STAGE, ['am', '--3way', '--keep-cr', ...patches.map(name => join(PATCHES, name))])
  } catch {
    fail([
      'a patch no longer applies to the pinned upstream.',
      `Resolve it in ${relative(ROOT, STAGE)} (git status, edit, git add, git am --continue),`,
      'then run `pnpm save-patches` to rewrite patches/.',
    ].join('\n'))
  }
}

cpSync(OVERLAY, STAGE, {
  recursive: true,
  filter: source => basename(source) !== '.gitkeep',
})

// Bundles preinstalled into the desktop app (patches/0004, DSH_DESKTOP_EXTRA_BUNDLE_DIRS).
// They sit outside the upstream pnpm workspace so its frozen lockfile stays untouched,
// and stay untracked so save-patches ignores them.
// The tunnel plugin's frpc (bin/) is fetched for the packaging target by scripts/package.mjs.
const PACKAGE_SOURCE_EXCLUDES = new Set(['node_modules', 'test', 'tsconfig.json', 'bin'])
for (const bundle of ['team-bundle', 'tunnel', 'workspace', 'agents']) {
  cpSync(join(ROOT, 'plugins', bundle), join(STAGE, 'agent-work', 'plugins', bundle), {
    recursive: true,
    filter: source => !PACKAGE_SOURCE_EXCLUDES.has(basename(source)),
  })
}

console.log(`agent-work: staged ${pin.tag} + ${patches.length} patch(es) + overlay + team bundle + tunnel, workspace and agents plugins at ${relative(ROOT, STAGE)}`)
