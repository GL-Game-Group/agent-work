/**
 * 直连模式 with Claude Code: the conversions, and the adapter against a stand-in
 * CLI speaking the same stream-json protocol (test/fixtures/claude-stand-in.mjs).
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CliAdapter, newestInput, titleFrom } from '../adapter.js'
import { streamArgs, toAskArgs, toClaudeAnswers, toolLine } from '../claude.js'
import { codexArgs, readCodexEvent } from '../codex.js'

const STAND_IN = join(import.meta.dirname, 'fixtures', 'claude-stand-in.mjs')
const CODEX_STAND_IN = join(import.meta.dirname, 'fixtures', 'codex-stand-in.mjs')

describe('Claude Code conversions', () => {
  const input = { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }], multiSelect: false }] }

  it('runs Claude with every permission and questions on stdio, resuming its own session', () => {
    assert.deepEqual(streamArgs({ resume: 'abc', model: 'opus', permissionTool: true }).slice(-8),
      ['--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions', '--resume', 'abc', '--model', 'opus'])
    assert.equal(streamArgs({ model: 'default', permissionTool: true }).includes('--model'), false)
  })

  it('turns AskUserQuestion into ask_user_question and the answer back', () => {
    assert.deepEqual(toAskArgs(input), { questions: [{ id: 'q1', question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }], multi_select: false }] })
    assert.deepEqual(toClaudeAnswers(input, '[{"id":"q1","selected":["Blue"]}]'), { 'Which color?': 'Blue' })
    assert.deepEqual(toClaudeAnswers(input, '{"answers":[{"id":"q1","selected":[],"custom":"Green"}]}'), { 'Which color?': 'Green' })
    assert.equal(toClaudeAnswers(input, 'Error: ask_user_question was aborted before the user answered'), null)
  })

  it('shows one line per tool', () => {
    assert.equal(toolLine('Edit', { file_path: '/repo/src/app.ts' }), '▸ Edit /repo/src/app.ts\n')
    assert.equal(toolLine('Bash', { command: 'npm test\nmore' }), '▸ Bash npm test\n')
  })
})

describe('Claude Code as a model', () => {
  /** An adapter whose CLI is the stand-in. */
  function adapter() {
    const saved = new Map()
    const spawned = []
    const a = new CliAdapter({
      spawn: ({ argv, cwd }) => {
        spawned.push(argv)
        const child = spawn(process.execPath, [argv[0] === '/stand-in/codex' ? CODEX_STAND_IN : STAND_IN, ...argv.slice(1)], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        return {
          stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
          done: new Promise(done => child.on('exit', code => done({ exitCode: code }))),
          terminate: () => child.kill(),
        }
      },
      locate: async cli => `/stand-in/${cli}`,
      cwdOf: () => process.cwd(),
      sessions: { get: id => saved.get(id), set: (id, value) => saved.set(id, value) },
      logger: { info() {}, warn() {} },
    })
    return { a, saved, spawned }
  }
  const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
  async function collect(iterable) {
    const chunks = []
    for await (const chunk of iterable) chunks.push(chunk)
    return chunks
  }
  const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')

  it('streams one turn and remembers the CLI session', async () => {
    const { a, saved, spawned } = adapter()
    try {
      const chunks = await collect(a.stream({ provider: 'claude-code', model: 'default', sessionId: 's1', messages: [user('hello')] }))
      assert.equal(textOf(chunks), 'echo: hello')
      assert.match(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), /▸ Read README\.md/u)
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
      assert.equal(chunks.find(c => c.type === 'usage').usage.outputTokens, 5)
      assert.equal(saved.get('claude-code:s1'), 'stand-in-session')
      // The next turn reuses the same process; only the newest input is sent.
      const second = await collect(a.stream({ provider: 'claude-code', model: 'default', sessionId: 's1', messages: [user('hello'), { role: 'assistant', content: [] }, user('again')] }))
      assert.equal(textOf(second), 'echo: again')
      assert.equal(spawned.length, 1)
    } finally { a.dispose() }
  })

  it('asks the member on GL Work\'s question card and hands the answer back', async () => {
    const { a } = adapter()
    try {
      const asking = await collect(a.stream({ provider: 'claude-code', model: 'default', sessionId: 's2', messages: [user('ask me')] }))
      const call = asking.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block
      assert.equal(call.name, 'ask_user_question')
      assert.deepEqual(JSON.parse(call.arguments).questions[0].options.map(o => o.label), ['Red', 'Blue'])
      assert.deepEqual(asking.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
      const answered = await collect(a.stream({
        provider: 'claude-code', model: 'default', sessionId: 's2',
        messages: [user('ask me'), { role: 'assistant', content: [call] }, { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: '[{"id":"q1","selected":["Blue"]}]' }] }],
      }))
      assert.equal(textOf(answered), 'You chose Blue')
    } finally { a.dispose() }
  })

  it('interrupts the CLI turn without ending its session', async () => {
    const { a, spawned } = adapter()
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      await assert.rejects(collect(a.stream({ provider: 'claude-code', model: 'default', sessionId: 's3', messages: [user('slow')], signal: controller.signal })), /已中断/u)
      const after = await collect(a.stream({ provider: 'claude-code', model: 'default', sessionId: 's3', messages: [user('hello')] }))
      assert.equal(textOf(after), 'echo: hello')
      assert.equal(spawned.length, 1, 'same process')
    } finally { a.dispose() }
  })

  it('answers GL Work\'s own title and compaction calls without starting a CLI', async () => {
    const { a, spawned } = adapter()
    const prompt = 'Generate the session title from this JSON array of human messages:\n[{"seq":9,"text":"修复 登录   页面的样式问题"}]'
    const title = await collect(a.stream({ provider: 'claude-code', model: 'default', purpose: 'session-title', messages: [user(prompt)] }))
    assert.equal(textOf(title), '修复 登录 页面的样式问题')
    assert.equal(spawned.length, 0)
    assert.equal(titleFrom([user('unexpected')]), '直连会话')
  })

  it('sends the member\'s own message, not the reminders GL Work appends after it', () => {
    const human = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const reminder = { role: 'user', source: { kind: 'skill-reminder' }, content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] }
    assert.deepEqual(newestInput([{ role: 'system', content: [] }, human('first'), reminder], new Map()), { kind: 'message', text: 'first' })
    assert.throws(() => newestInput([human('first'), { role: 'assistant', content: [] }, reminder], new Map()), /没有新的输入/u)
    assert.deepEqual(newestInput([human('q'), { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '[]' }] }, reminder], new Map([['c1', {}]])), { kind: 'answer', callId: 'c1', text: '[]' })
  })

  it('runs Codex one turn at a time, resuming its thread', async () => {
    const { a, saved, spawned } = adapter()
    const first = await collect(a.stream({ provider: 'codex-cli', model: 'default', sessionId: 's4', messages: [user('hi')] }))
    assert.equal(textOf(first), 'new: hi')
    assert.match(first.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), /▸ 执行 ls -la/u)
    assert.equal(first.find(c => c.type === 'usage').usage.cacheReadTokens, 4)
    assert.equal(saved.get('codex-cli:s4'), 'thread-1')
    const second = await collect(a.stream({ provider: 'codex-cli', model: 'default', sessionId: 's4', messages: [user('hi'), { role: 'assistant', content: [] }, user('more')] }))
    assert.equal(textOf(second), 'resumed: more')
    assert.deepEqual(spawned.at(-1).slice(1, 3), ['exec', 'resume'])
  })
})

describe('Codex', () => {
  it('runs with every permission in the workspace, resuming by thread id', () => {
    assert.deepEqual(codexArgs({ cwd: '/w' }), ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', '/w', '-'])
    assert.deepEqual(codexArgs({ thread: 't1', model: 'gpt-x', cwd: '/w' }), ['exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-x', 't1', '-'])
  })
  it('reads its events', () => {
    assert.deepEqual(readCodexEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } }), { kind: 'reasoning', text: '▸ 修改 a.ts、b.ts\n' })
    assert.deepEqual(readCodexEvent({ type: 'turn.failed', error: { message: 'quota' } }), { kind: 'error', message: 'quota' })
    assert.equal(readCodexEvent({ type: 'turn.started' }), null)
  })
})
