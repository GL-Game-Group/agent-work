// A stand-in Claude Code speaking the stream-json protocol the adapter drives:
// - "ask me": asks AskUserQuestion (Red/Blue) through a can_use_tool control request,
//   then answers "You chose <answer>";
// - "slow": streams slowly until interrupted;
// - anything else: reads README.md (a tool use) and echoes the input.
import { createInterface } from 'node:readline'

const out = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const SESSION = 'stand-in-session'
let pendingAsk = null
let slow = null

function text(t) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } })
}
function result() {
  out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: SESSION, usage: { input_tokens: 3, output_tokens: 5 } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.type === 'control_request' && m.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
    out({ type: 'system', subtype: 'init', session_id: SESSION })
    return
  }
  if (m.type === 'control_request' && m.request.subtype === 'interrupt') {
    clearInterval(slow)
    slow = null
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SESSION })
    return
  }
  if (m.type === 'control_response' && pendingAsk !== null && m.response.request_id === pendingAsk) {
    pendingAsk = null
    const answers = m.response.response.updatedInput?.answers ?? {}
    text(`You chose ${Object.values(answers)[0] ?? 'nothing'}`)
    result()
    return
  }
  if (m.type === 'user') {
    const input = m.message.content
    if (input === 'ask me') {
      pendingAsk = 'ask-1'
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] }, session_id: SESSION })
      out({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', requires_user_interaction: true,
        input: { questions: [{ question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] } } })
      return
    }
    if (input === 'slow') {
      slow = setInterval(() => text('.'), 50)
      return
    }
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] }, session_id: SESSION })
    text(`echo: ${input}`)
    result()
  }
})
