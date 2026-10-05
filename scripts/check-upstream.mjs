/**
 * Gate: the upstream submodule is unmodified and checked out at the commit
 * pinned in upstream.json, and the pinned tag still names that commit.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UPSTREAM, fail, git, readPin } from './lib.mjs'

const pin = readPin()
if (!existsSync(join(UPSTREAM, '.git'))) fail('upstream/ is not initialized; run `git submodule update --init`')

const head = git(UPSTREAM, ['rev-parse', 'HEAD'])
if (head !== pin.commit) fail(`upstream/ is at ${head}, upstream.json pins ${pin.commit}`)

const tagged = git(UPSTREAM, ['rev-parse', `${pin.tag}^{commit}`])
if (tagged !== pin.commit) fail(`tag ${pin.tag} resolves to ${tagged}, upstream.json pins ${pin.commit}`)

const dirty = git(UPSTREAM, ['status', '--porcelain'])
if (dirty !== '') fail(`upstream/ has local changes; it is read-only — move them into patches/ or overlay/:\n${dirty}`)

console.log(`agent-work: upstream clean at ${pin.tag} (${pin.commit.slice(0, 10)})`)
