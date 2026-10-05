// @ts-check
/**
 * One Codex turn: `codex exec --json` with every permission, resuming the CLI's
 * own thread, reading the prompt from stdin. Codex asks the user in plain text,
 * so a question is just its reply and the member's next message answers it.
 */

/**
 * The arguments of one Codex turn.
 * @param {{ thread?: string | null, model?: string | null, cwd: string }} options
 * @returns {string[]}
 */
export function codexArgs({ thread, model, cwd }) {
  return [
    'exec', ...thread ? ['resume'] : [], '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    ...thread ? [] : ['-C', cwd],
    ...model && model !== 'default' ? ['-m', model] : [],
    ...thread ? [thread] : [], '-',
  ]
}

/**
 * What one Codex event shows: reply text, reasoning, or a progress line.
 * @param {Record<string, unknown>} event
 * @returns {{ kind: 'text' | 'reasoning', text: string } | { kind: 'thread', id: string } | { kind: 'done', usage: { input: number, output: number, cached: number } } | { kind: 'error', message: string } | null}
 */
export function readCodexEvent(event) {
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') return { kind: 'thread', id: event.thread_id }
  if (event.type === 'turn.completed') {
    const usage = /** @type {{ input_tokens?: number, output_tokens?: number, cached_input_tokens?: number }} */ (event.usage ?? {})
    return { kind: 'done', usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cached: usage.cached_input_tokens ?? 0 } }
  }
  if (event.type === 'turn.failed' || event.type === 'error') {
    const error = /** @type {{ message?: string } | undefined} */ (event.error)
    return { kind: 'error', message: error?.message ?? (typeof event.message === 'string' ? event.message : 'Codex 运行失败') }
  }
  const item = /** @type {{ type?: string, text?: string, command?: string, changes?: { path?: string }[], query?: string, tool?: string } | undefined} */ (event.item)
  if (item === undefined) return null
  if (event.type === 'item.completed' && item.type === 'agent_message' && item.text) return { kind: 'text', text: item.text }
  if (event.type === 'item.completed' && item.type === 'reasoning' && item.text) return { kind: 'reasoning', text: `${item.text}\n` }
  if (event.type === 'item.started' && item.type === 'command_execution' && item.command) return { kind: 'reasoning', text: `▸ 执行 ${item.command.split('\n')[0]?.slice(0, 160)}\n` }
  if (event.type === 'item.completed' && item.type === 'file_change') return { kind: 'reasoning', text: `▸ 修改 ${(item.changes ?? []).map(c => c.path).filter(Boolean).join('、').slice(0, 200)}\n` }
  if (event.type === 'item.started' && item.type === 'web_search' && item.query) return { kind: 'reasoning', text: `▸ 搜索 ${item.query}\n` }
  if (event.type === 'item.started' && item.type === 'mcp_tool_call' && item.tool) return { kind: 'reasoning', text: `▸ ${item.tool}\n` }
  return null
}
