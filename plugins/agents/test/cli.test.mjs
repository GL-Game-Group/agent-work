/** Command-line agents: versions, sign-in reports, sign-in addresses, install locations. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLIS, parseSignedIn, parseVersion, signInUrl } from '../cli.js'

describe('command-line agents', () => {
  it('reads the version each CLI prints', () => {
    assert.equal(parseVersion('2.1.285 (Claude Code)'), '2.1.285')
    assert.equal(parseVersion('codex-cli 0.157.1'), '0.157.1')
    assert.equal(parseVersion('1.1.65\n'), '1.1.65')
    assert.equal(parseVersion('no version here'), null)
  })

  it('reads sign-in reports', () => {
    assert.equal(parseSignedIn('claude', { exitCode: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' }), true)
    assert.equal(parseSignedIn('claude', { exitCode: 0, stdout: '{"loggedIn": false}', stderr: '' }), false)
    assert.equal(parseSignedIn('claude', { exitCode: 1, stdout: 'Error', stderr: '' }), false)
    assert.equal(parseSignedIn('codex', { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' }), true)
    assert.equal(parseSignedIn('codex', { exitCode: 1, stdout: '', stderr: 'Not logged in' }), false)
    assert.equal(parseSignedIn('qoder', { exitCode: 0, stdout: 'anything', stderr: '' }), null)
  })

  it('finds the address a sign-in command prints', () => {
    assert.equal(signInUrl('Open this link: https://auth.openai.com/oauth/authorize?x=1 to continue'), 'https://auth.openai.com/oauth/authorize?x=1')
    assert.equal(signInUrl('nothing'), null)
  })

  it('looks where each official installer puts its CLI', () => {
    const where = Object.fromEntries(CLIS.map(c => [c.id, c.candidates('/Users/a', 'darwin')[0]]))
    assert.deepEqual(where, { claude: '/Users/a/.local/bin/claude', codex: '/Users/a/.local/bin/codex', qoder: '/Users/a/.local/bin/qodercli' })
  })

  it('ships every local file the plugin imports', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(import.meta.dirname, '..')
    const files = new Set(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).files)
    for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
      if (!files.has(file)) continue
      for (const [, local] of readFileSync(join(dir, file), 'utf8').matchAll(/from '\.\/([^']+)'/gu)) assert.ok(files.has(local), `${file} imports ${local}, which package.json files leaves out`)
    }
    for (const json of readFileSync(join(dir, 'index.js'), 'utf8').matchAll(/new URL\('\.\/([^']+)'/gu)) assert.ok(files.has(json[1]), `${json[1]} is read at runtime`)
  })
})
