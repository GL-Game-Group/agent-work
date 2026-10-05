// @ts-check
/**
 * 直连模式: Claude Code on the member's machine as a GL Work model
 * ("Claude Code（本机）"). The harness loop still owns the Session, but this
 * adapter forwards only the newest user input to the CLI, which keeps its own
 * conversation (resumed by its session id), runs its own tools with every
 * permission, and streams back text, thinking, and one progress line per tool.
 *
 * A question the CLI asks the user (AskUserQuestion) ends the step as a call of
 * GL Work's own ask_user_question tool, so the member answers on the native
 * question card; the next step carries that tool result, which goes back to the
 * CLI that has been waiting on it.
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/** Optional protocol trace for diagnosis: AW_AGENTS_DEBUG=<file>. @param {string} what @param {unknown} value */
const trace = (what, value) => {
  const file = process.env.AW_AGENTS_DEBUG
  if (file) appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), what, value })}\n`)
}
import { createInterface } from 'node:readline'
import { StreamSession, streamArgs, toAskArgs, toClaudeAnswers, toolLine } from './claude.js'
import { codexArgs, readCodexEvent } from './codex.js'

/** @typedef {import('@deepseek-ai/dsh-llm').GenerateOptions} GenerateOptions */
/** @typedef {import('@deepseek-ai/dsh-llm').StreamChunk} StreamChunk */
/** @typedef {import('@deepseek-ai/dsh-llm').ToolCallId} ToolCallId */

/**
 * The CLIs offered as models. `stream`: a long-lived Claude-compatible stream-json process
 * (questions on stdio only when `permissionTool`); `codex`: one `codex exec` per turn.
 */
export const PROVIDERS = {
  'claude-code': {
    name: 'Claude Code（本机）', cli: 'claude', label: 'Claude Code', driver: 'stream', permissionTool: true, skipPermissions: [],
    models: [
      { id: 'default', name: 'Claude Code 默认模型' },
      { id: 'opus', name: 'Claude Code · Opus' },
      { id: 'sonnet', name: 'Claude Code · Sonnet' },
      { id: 'haiku', name: 'Claude Code · Haiku' },
    ],
  },
  'codex-cli': {
    name: 'Codex（本机）', cli: 'codex', label: 'Codex', driver: 'codex', permissionTool: false, skipPermissions: [],
    models: [{ id: 'default', name: 'Codex 默认模型' }],
  },
  'qoder-cli': {
    name: 'Qoder CLI（本机）', cli: 'qoder', label: 'Qoder CLI', driver: 'stream', permissionTool: false, skipPermissions: ['--dangerously-skip-permissions'],
    models: [{ id: 'default', name: 'Qoder 默认模型' }],
  },
}

/** @param {string} provider */
function providerOf(provider) {
  const known = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (provider)]
  if (known === undefined) throw new Error(`没有这个命令行：${provider}`)
  return known
}

/** @param {readonly { type: string, text?: string }[] | string | undefined} content */
function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * What this step brings the CLI: the answer to a question it waits on, or the member's newest message.
 * GL Work adds user-role reminders (skills, runtime context) after the member's own message; only
 * messages whose source is the member (`user`) are input, and only one newer than the last reply.
 * @param {readonly { role: string, content?: unknown, source?: { kind?: string }, toolCallId?: unknown }[]} messages
 * @param {Map<string, unknown>} pending
 * @returns {{ kind: 'answer', callId: string, text: string } | { kind: 'message', text: string }}
 */
export function newestInput(messages, pending) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = /** @type {{ role: string, content?: unknown, toolCallId?: unknown }} */ (messages[i])
    if (message.role === 'tool' && pending.has(String(message.toolCallId))) {
      return { kind: 'answer', callId: String(message.toolCallId), text: textOf(/** @type {never} */ (message.content)) }
    }
  }
  let lastReply = -1
  let lastHuman = -1
  messages.forEach((message, i) => {
    if (message.role === 'assistant') lastReply = i
    if (message.role === 'user' && (message.source === undefined || message.source.kind === 'user')) lastHuman = i
  })
  // A request user input without a source is the caller's own input (tests, one-shot callers).
  if (lastHuman === -1 || lastHuman < lastReply) throw new Error('没有新的输入可以交给命令行')
  return { kind: 'message', text: textOf(/** @type {never} */ (messages[lastHuman]?.content)) }
}

/**
 * A session title from GL Work's title request, which lists the member's messages as JSON.
 * @param {readonly { content?: unknown }[]} messages
 */
export function titleFrom(messages) {
  const prompt = textOf(/** @type {never} */ (messages.at(-1)?.content))
  const json = prompt.slice(prompt.indexOf('['))
  try {
    const items = /** @type {{ text?: string }[]} */ (JSON.parse(json))
    const text = items.map(item => item.text ?? '').find(t => t.trim() !== '')
    if (text) return text.replace(/\s+/gu, ' ').trim().slice(0, 30)
  } catch { /* not the expected request */ }
  return '直连会话'
}

/**
 * @typedef {object} Pending - a question the CLI waits on, keyed by the tool call shown to the member.
 * @property {string} requestId
 * @property {Record<string, unknown>} input
 */

export class CliAdapter extends LlmAdapter {
  /**
   * @param {object} deps
   * @param {(options: { argv: string[], cwd: string }) => import('./claude.js').Handle} deps.spawn - starts a CLI with piped stdio.
   * @param {(cli: string) => Promise<string | undefined>} deps.locate
   * @param {(sessionId: string) => string} deps.cwdOf - the session's workspace directory.
   * @param {{ get(sessionId: string): string | undefined, set(sessionId: string, cliSession: string): void }} deps.sessions - CLI session ids, kept across restarts.
   * @param {{ info(...args: unknown[]): void, warn(...args: unknown[]): void }} deps.logger
   */
  constructor(deps) {
    super()
    this.deps = deps
    /** @type {Map<string, StreamSession>} */
    this.live = new Map()
    /** @type {Map<string, Pending>} */
    this.pending = new Map()
    /** @type {Map<string, { provider: string, model: string }>} The CLI each session used last, for its slash commands. */
    this.lastUsed = new Map()
  }

  /**
   * /clear: end the session's CLI processes and forget their sessions; the next message starts afresh.
   * @param {string} sessionId
   */
  reset(sessionId) {
    for (const provider of Object.keys(PROVIDERS)) {
      const key = `${provider}:${sessionId}`
      this.live.get(key)?.close()
      this.live.delete(key)
      this.deps.sessions.set(key, '')
    }
  }

  /**
   * /compact, /cli: hand text to the session's CLI outside the conversation and return its reply.
   * @param {string} sessionId @param {string} text
   * @returns {Promise<string>}
   */
  async raw(sessionId, text) {
    const used = this.lastUsed.get(sessionId)
    if (used === undefined) throw new Error('这个会话还没有用过本机命令行：先选择 Claude Code / Codex / Qoder（本机）发一条消息')
    /** @type {AsyncIterable<StreamChunk>} */
    let chunks
    if (providerOf(used.provider).driver === 'codex') chunks = this.codexTurn(sessionId, used.model, text, undefined)
    else {
      const cli = await this.session(used.provider, sessionId, used.model)
      cli.sendUser(text)
      chunks = this.relay(cli, `${used.provider}:${sessionId}`, undefined)
    }
    let reply = ''
    for await (const chunk of chunks) {
      if (chunk.type === 'text-delta') reply += chunk.text
      if (chunk.type === 'finish' && chunk.reason.kind === 'tool-calls') reply += '\n（命令行在等你回答一个问题，请在对话里继续）'
    }
    return reply.trim() || '（命令行没有输出文字）'
  }

  /** @param {string} provider */
  providerInfo(provider) {
    const known = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (provider)]
    return { id: provider, name: known?.name ?? provider }
  }

  /** @param {string} provider */
  listModels(provider) {
    return Promise.resolve((PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (provider)]?.models ?? []).map(m => ({ provider, ...m })))
  }

  /** @param {string} provider @param {string} model */
  resolveModel(provider, model) {
    const found = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (provider)]?.models.find(m => m.id === model)
    return Promise.resolve({ provider, id: model, name: found?.name ?? model })
  }

  /**
   * The CLI process for one GL Work session, started (or resumed) on demand.
   * @param {string} provider @param {string} sessionId @param {string} model
   */
  async session(provider, sessionId, model) {
    const key = `${provider}:${sessionId}`
    const current = this.live.get(key)
    if (current !== undefined && !current.exited && current.model === model) return current
    current?.close()
    const spec = providerOf(provider)
    const executable = await this.deps.locate(spec.cli)
    if (executable === undefined) throw new Error(`本机没有找到 ${spec.label}，请在 设置 > 模型 > 命令行 Agent 里安装`)
    const resume = current?.sessionId ?? this.deps.sessions.get(key) ?? null
    const argv = [executable, ...streamArgs({ resume, model, permissionTool: spec.permissionTool, skipPermissionsFlag: spec.skipPermissions })]
    const started = new StreamSession(this.deps.spawn({ argv, cwd: this.deps.cwdOf(sessionId) }), { model })
    this.live.set(key, started)
    this.deps.logger.info('started %s for session %s%s', spec.cli, sessionId, resume ? ` (resuming ${resume})` : '')
    return started
  }

  /**
   * One Codex turn for the member's newest message.
   * @param {string} sessionId @param {string} model @param {string} text @param {AbortSignal | undefined} signal
   * @returns {AsyncIterable<StreamChunk>}
   */
  async *codexTurn(sessionId, model, text, signal) {
    const key = `codex-cli:${sessionId}`
    const executable = await this.deps.locate('codex')
    if (executable === undefined) throw new Error('本机没有找到 Codex，请在 设置 > 模型 > 命令行 Agent 里安装')
    const cwd = this.deps.cwdOf(sessionId)
    const handle = this.deps.spawn({ argv: [executable, ...codexArgs({ thread: this.deps.sessions.get(key) ?? null, model, cwd })], cwd })
    handle.stdin?.end(text)
    let stderr = ''
    handle.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
    const onAbort = () => handle.terminate()
    signal?.addEventListener('abort', onAbort, { once: true })
    let index = -1
    let done = false
    try {
      for await (const line of createInterface({ input: /** @type {NodeJS.ReadableStream} */ (handle.stdout) })) {
        /** @type {Record<string, unknown>} */
        let event
        try { event = JSON.parse(line) } catch { continue }
        trace('codex', event)
        const read = readCodexEvent(event)
        if (read === null) continue
        if (read.kind === 'thread') { this.deps.sessions.set(key, read.id); continue }
        if (read.kind === 'error') throw new Error(`Codex：${read.message}`)
        if (read.kind === 'done') {
          yield { type: 'usage', usage: { inputTokens: read.usage.input, outputTokens: read.usage.output, ...read.usage.cached ? { cacheReadTokens: read.usage.cached } : {} } }
          done = true
          continue
        }
        index += 1
        yield { type: 'block-start', index, blockType: read.kind }
        yield read.kind === 'text' ? { type: 'text-delta', index, text: read.text } : { type: 'reasoning-delta', index, text: read.text }
        yield { type: 'block-end', index, block: { type: read.kind, text: read.text } }
      }
      await handle.done
      if (signal?.aborted) throw Object.assign(new Error('已中断'), { name: 'AbortError' })
      if (!done) throw new Error(`Codex 没有完成这一轮${stderr ? `：${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * @param {GenerateOptions} options
   * @returns {AsyncIterable<StreamChunk>}
   */
  async *stream(options) {
    // GL Work's own auxiliary calls never start a CLI.
    if (options.purpose !== undefined) {
      trace('auxiliary', { purpose: options.purpose, messages: options.messages })
      const text = options.purpose === 'session-title' ? titleFrom(options.messages) : '（直连会话，上下文由命令行自己管理）'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const sessionId = options.sessionId
    trace('request', { provider: options.provider, model: options.model, sessionId, roles: options.messages.map(m => m.role), last: options.messages.at(-1) })
    if (sessionId === undefined) throw new Error('直连模式需要在会话里使用')
    const input = newestInput(options.messages, this.pending)
    this.lastUsed.set(sessionId, { provider: options.provider, model: options.model })
    if (providerOf(options.provider).driver === 'codex') {
      if (input.kind !== 'message' || input.text.trim() === '') throw new Error('直连模式只支持文字输入')
      yield* this.codexTurn(sessionId, options.model, input.text, options.signal)
      return
    }
    const cli = await this.session(options.provider, sessionId, options.model)
    if (input.kind === 'answer') {
      const question = /** @type {Pending} */ (this.pending.get(input.callId))
      this.pending.delete(input.callId)
      const answers = toClaudeAnswers(/** @type {never} */ (question.input), input.text)
      if (answers === null || Object.keys(answers).length === 0) cli.deny(question.requestId, 'The user did not answer the question.')
      else cli.allow(question.requestId, { ...question.input, answers })
    } else {
      if (input.text.trim() === '') throw new Error('直连模式只支持文字输入')
      cli.sendUser(input.text)
    }
    yield* this.relay(cli, `${options.provider}:${sessionId}`, options.signal)
  }

  /**
   * Forward CLI events until its turn ends or it asks the user something.
   * @param {StreamSession} cli @param {string} key - `<provider>:<session>`, where the CLI session id is kept.
   * @param {AbortSignal | undefined} signal
   * @returns {AsyncIterable<StreamChunk>}
   */
  async *relay(cli, key, signal) {
    let index = -1
    /** @type {{ index: number, type: 'text' | 'reasoning', text: string } | null} */
    let open = null
    /** @returns {Iterable<StreamChunk>} */
    const close = function* () {
      if (open === null) return
      const block = open
      open = null
      yield { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }
    }
    /** @param {'text' | 'reasoning'} type @param {string} text @returns {Iterable<StreamChunk>} */
    const emit = function* (type, text) {
      if (open?.type !== type) {
        yield* close()
        index += 1
        open = { index, type, text: '' }
        yield { type: 'block-start', index, blockType: type }
      }
      const block = /** @type {{ index: number, type: 'text' | 'reasoning', text: string }} */ (open)
      block.text += text
      yield type === 'text' ? { type: 'text-delta', index: block.index, text } : { type: 'reasoning-delta', index: block.index, text }
    }
    let interrupted = false
    const onAbort = () => { interrupted = true; cli.interrupt() }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        const message = await cli.next()
        trace('event', message)
        if (message === null) throw new Error(`命令行已退出${cli.stderr ? `：${cli.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`)
        if (cli.sessionId !== null) this.deps.sessions.set(key, cli.sessionId)
        if (message.type === 'stream_event') {
          const event = /** @type {{ type?: string, delta?: { type?: string, text?: string, thinking?: string } }} */ (message.event ?? {})
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) yield* emit('text', event.delta.text)
          else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) yield* emit('reasoning', event.delta.thinking)
          continue
        }
        if (message.type === 'assistant') {
          const content = /** @type {{ type: string, name?: string, input?: Record<string, unknown> }[]} */ (/** @type {{ content?: unknown }} */ (message.message ?? {}).content ?? [])
          for (const block of content) if (block.type === 'tool_use' && block.name !== 'AskUserQuestion') yield* emit('reasoning', toolLine(block.name ?? 'tool', block.input ?? {}))
          continue
        }
        if (message.type === 'control_request') {
          const request = /** @type {{ subtype?: string, tool_name?: string, input?: Record<string, unknown> }} */ (message.request ?? {})
          const requestId = String(message.request_id)
          if (request.subtype === 'can_use_tool' && request.tool_name === 'AskUserQuestion') {
            yield* close()
            const callId = /** @type {ToolCallId} */ (`call_${randomUUID().replaceAll('-', '')}`)
            this.pending.set(callId, { requestId, input: request.input ?? {} })
            const args = JSON.stringify(toAskArgs(/** @type {never} */ (request.input ?? {})))
            index += 1
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id: callId, name: 'ask_user_question', argumentsDelta: args }
            yield { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          // Everything else is allowed: the member chose full permissions for 直连模式.
          if (request.subtype === 'can_use_tool') cli.allow(requestId, request.input ?? {})
          else cli.acknowledge(requestId)
          continue
        }
        if (message.type === 'result') {
          yield* close()
          const usage = /** @type {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number } | undefined} */ (message.usage)
          if (usage !== undefined) {
            yield {
              type: 'usage', usage: {
                inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
                outputTokens: usage.output_tokens ?? 0,
                ...usage.cache_read_input_tokens ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
                ...usage.cache_creation_input_tokens ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {},
              },
            }
          }
          if (interrupted) throw Object.assign(new Error('已中断'), { name: 'AbortError' })
          if (message.is_error === true && message.subtype !== 'error_during_execution') {
            throw new Error(`命令行返回错误：${typeof message.result === 'string' ? message.result : String(message.subtype)}`)
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Stop every CLI process (the plugin is unloading). */
  dispose() {
    for (const cli of this.live.values()) cli.close()
    this.live.clear()
  }

  /** Stop CLI processes idle for longer than `ms`; they resume on the next message. @param {number} ms */
  sweep(ms) {
    const now = Date.now()
    for (const [key, cli] of this.live) {
      if (now - cli.lastUsed > ms && this.pending.size === 0) { cli.close(); this.live.delete(key) }
    }
  }
}
