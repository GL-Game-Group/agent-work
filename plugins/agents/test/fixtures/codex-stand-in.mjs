// A stand-in `codex exec --json`: reads the prompt from stdin, runs one command, answers.
let prompt = ''
process.stdin.on('data', (c) => { prompt += c })
process.stdin.on('end', () => {
  const resumed = process.argv.includes('resume')
  const out = m => process.stdout.write(`${JSON.stringify(m)}\n`)
  out({ type: 'thread.started', thread_id: 'thread-1' })
  out({ type: 'turn.started' })
  out({ type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'ls -la' } })
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: `${resumed ? 'resumed' : 'new'}: ${prompt}` } })
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } })
})
