// @ts-check
/**
 * One long-lived Claude Code process for one GL Work session, driven over its
 * stream-json protocol (the protocol Anthropic's Agent SDK speaks, without the
 * SDK and its bundled binaries): user messages in, events out, and control
 * requests for the questions Claude asks the user.
 *
 * Claude runs with every permission (`bypassPermissions`); only questions that
 * need the user (`requires_user_interaction`, e.g. AskUserQuestion) arrive as
 * `can_use_tool` requests, answered with `updatedInput.answers`.
 */
import { createInterface } from 'node:readline'

/**
 * @typedef {object} Handle
 * @property {NodeJS.WritableStream | undefined} [stdin]
 * @property {NodeJS.ReadableStream | undefined} [stdout]
 * @property {NodeJS.ReadableStream | undefined} [stderr]
 * @property {Promise<{ exitCode: number | null }>} done
 * @property {() => void} terminate
 */

/**
 * The arguments a Claude-compatible CLI runs with.
 * @param {{ resume?: string | null, model?: string | null, permissionTool: boolean, skipPermissionsFlag?: string[] }} options
 * @returns {string[]}
 */
export function streamArgs({ resume, model, permissionTool, skipPermissionsFlag }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...permissionTool ? ['--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions'] : skipPermissionsFlag ?? [],
    ...resume ? ['--resume', resume] : [],
    ...model && model !== 'default' ? ['--model', model] : [],
  ]
}

/** Async queue of parsed protocol lines, with the process exit as its end. */
export class StreamSession {
  /**
   * @param {Handle} handle - the spawned CLI (stdin and stdout piped).
   * @param {{ model: string | null }} meta
   */
  constructor(handle, meta) {
    this.handle = handle
    this.model = meta.model
    /** @type {Record<string, unknown>[]} */
    this.buffer = []
    /** @type {((value: Record<string, unknown> | null) => void)[]} */
    this.waiters = []
    this.exited = false
    this.stderr = ''
    /** @type {string | null} */
    this.sessionId = null
    this.lastUsed = Date.now()
    createInterface({ input: /** @type {NodeJS.ReadableStream} */ (handle.stdout) }).on('line', (line) => {
      /** @type {Record<string, unknown>} */
      let message
      try { message = JSON.parse(line) } catch { return }
      if (typeof message.session_id === 'string') this.sessionId = message.session_id
      const waiter = this.waiters.shift()
      if (waiter !== undefined) waiter(message)
      else this.buffer.push(message)
    })
    handle.stderr?.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-4000) })
    void handle.done.then(() => this.end(), () => this.end())
    this.write({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
  }

  end() {
    this.exited = true
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  /** @param {unknown} message */
  write(message) {
    if (this.exited) throw new Error('the command-line agent has exited')
    this.handle.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * The next protocol message, or null once the process has exited.
   * @param {AbortSignal} [signal] - resolves null when aborted.
   * @returns {Promise<Record<string, unknown> | null>}
   */
  next(signal) {
    const buffered = this.buffer.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.exited) return Promise.resolve(null)
    return new Promise((resolve) => {
      const waiter = (/** @type {Record<string, unknown> | null} */ value) => { signal?.removeEventListener('abort', onAbort); resolve(value) }
      const onAbort = () => { this.waiters = this.waiters.filter(w => w !== waiter); resolve(null) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** @param {string} text */
  sendUser(text) {
    this.lastUsed = Date.now()
    this.write({ type: 'user', message: { role: 'user', content: text } })
  }

  /**
   * Allow a tool use, optionally with changed input (answers to a question).
   * @param {string} requestId @param {Record<string, unknown>} input
   */
  allow(requestId, input) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } } })
  }

  /** @param {string} requestId @param {string} message */
  deny(requestId, message) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } })
  }

  /** @param {string} requestId */
  acknowledge(requestId) {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } })
  }

  interrupt() {
    if (!this.exited) this.write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } })
  }

  close() {
    this.exited = true
    this.handle.terminate()
  }
}

/**
 * Claude's AskUserQuestion input as GL Work's ask_user_question arguments.
 * @param {{ questions?: { question: string, header?: string, options?: { label: string, description?: string }[], multiSelect?: boolean }[] }} input
 */
export function toAskArgs(input) {
  return {
    questions: (input.questions ?? []).map((q, i) => ({
      id: `q${i + 1}`, question: q.question, ...q.header ? { header: q.header } : {},
      ...q.options ? { options: q.options.map(o => ({ label: o.label, ...o.description ? { description: o.description } : {} })) } : {},
      multi_select: q.multiSelect === true,
    })),
  }
}

/**
 * GL Work's ask_user_question result as Claude's `answers` (question text → answer text).
 * @param {{ questions?: { question: string }[] }} input - the original AskUserQuestion input.
 * @param {string} resultText - the tool result GL Work recorded.
 * @returns {Record<string, string> | null} null when the user gave no answer (cancelled, failed).
 */
export function toClaudeAnswers(input, resultText) {
  let parsed
  try { parsed = JSON.parse(resultText) } catch { return null }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.answers) ? parsed.answers : null
  if (items === null) return null
  /** @type {Record<string, string>} */
  const answers = {}
  ;(input.questions ?? []).forEach((q, i) => {
    const item = items.find((/** @type {{ id?: string }} */ a) => a.id === `q${i + 1}`) ?? items[i]
    if (item === undefined) return
    const parts = [...Array.isArray(item.selected) ? item.selected : [], ...typeof item.custom === 'string' && item.custom !== '' ? [item.custom] : []]
    if (parts.length > 0) answers[q.question] = parts.join(', ')
  })
  return answers
}

/**
 * A short progress line for a tool Claude used, shown in the reasoning fold.
 * @param {string} name @param {Record<string, unknown>} input
 */
export function toolLine(name, input) {
  const detail = [input.file_path, input.path, input.command, input.pattern, input.url, input.description]
    .find(value => typeof value === 'string' && value !== '')
  return `▸ ${name}${detail ? ` ${String(detail).split('\n')[0]?.slice(0, 160)}` : ''}\n`
}
