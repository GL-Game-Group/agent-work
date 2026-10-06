/** Workspace helpers: repository identity, naming, and reading git and gh output. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { branchFor, cloneProgress, deviceCode, refusesInit, repoIdentity, validBranch, worktreeDir, originOfConfig, skipsDir } from '../git.js'

describe('repository identity', () => {
  it('treats every spelling of one GitHub repository as the same', () => {
    for (const url of ['git@github.com:GL-Game-Group/Agent-Work.git', 'https://github.com/gl-game-group/agent-work', 'https://github.com/GL-Game-Group/agent-work.git/',
      'ssh://git@github.com/GL-Game-Group/agent-work.git']) assert.equal(repoIdentity(url), 'github.com/gl-game-group/agent-work', url)
  })
  it('refuses what is not owner/repo on a host', () => {
    for (const url of ['/local/path', 'file:///tmp/repo', 'https://github.com/only-owner', 'https://github.com/a/b/c', 'nonsense']) assert.equal(repoIdentity(url), undefined, url)
  })
})

describe('naming', () => {
  it('puts worktrees beside the repository', () => {
    assert.equal(worktreeDir('/Users/a/GLWork/org/repo', 'fix-login'), '/Users/a/GLWork/org/repo.worktrees/fix-login')
    assert.throws(() => worktreeDir('/r', '../escape'), /名字只能/u)
    assert.throws(() => worktreeDir('/r', ''), /名字只能/u)
  })
  it('prefixes branches with the GitHub login', () => {
    assert.equal(branchFor('EvaShow', 'Fix Login'), 'evashow/fix-login')
    assert.equal(branchFor(null, '修复登录'), '修复登录')
    assert.equal(validBranch('evashow/fix-login'), true)
    for (const bad of ['a..b', 'a/', 'a.lock', '-a', 'a//b', 'a@{b', 'a/.b']) assert.equal(validBranch(bad), false, bad)
  })
  it('refuses to make the home directory or a drive root a repository', () => {
    assert.equal(refusesInit('/Users/a', '/Users/a'), true)
    assert.equal(refusesInit('/', '/Users/a'), true)
    assert.equal(refusesInit('C:', 'C:\\Users\\a'), true)
    assert.equal(refusesInit('/Users/a/notes', '/Users/a'), false)
  })
})

describe('reading output', () => {
  it('finds the device code gh prints', () => {
    assert.equal(deviceCode('! First copy your one-time code: 8F2D-5C70\nPress Enter'), '8F2D-5C70')
    assert.equal(deviceCode('! One-time code (AB12-CD34) copied to clipboard'), 'AB12-CD34')
    assert.equal(deviceCode('nothing yet'), undefined)
  })
  it('turns git clone progress into one bar', () => {
    assert.deepEqual(cloneProgress('Receiving objects:  50% (5/10), 1.2 MiB'), { percent: 40, stage: 'Receiving objects' })
    assert.deepEqual(cloneProgress('Resolving deltas: 100% (3/3), done.'), { percent: 95, stage: 'Resolving deltas' })
    assert.equal(cloneProgress('Cloning into \'repo\'...'), undefined)
  })

  it('reads the origin a clone points at, from .git/config', () => {
    const config = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/fork.git\n[remote "origin"]\n\turl = git@github.com:GL-Game-Group/Agent-Work.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    assert.equal(originOfConfig(config), 'github.com/gl-game-group/agent-work')
    assert.equal(originOfConfig('[remote "upstream"]\n\turl = https://github.com/a/b\n'), undefined)
    assert.equal(originOfConfig(''), undefined)
  })

  it('does not search dependencies, build output, hidden or app folders', () => {
    for (const name of ['node_modules', '.cache', 'Library', 'dist', 'demo.worktrees', 'Xcode.app']) assert.equal(skipsDir(name), true, name)
    for (const name of ['work', 'agent-work', 'GLWork']) assert.equal(skipsDir(name), false, name)
  })
})
