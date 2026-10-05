/**
 * 手机远程's local server against a stand-in for the Host's typert gateway,
 * shaped as dsh 0.2 answers (inbox projection, subagentCatalog, $events).
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import WebSocket from 'ws'
import { frpcConfig } from '../frpc.js'
import { REMOTE_HEADER, queueItems, startRemoteServer } from '../remote.js'

const SECRET = 'remote-secret-for-tests'

describe('手机远程 on the Mac', () => {
  /** @type {{ namespace: string, method: string, args: any }[]} */
  const calls = []
  /** @type {any[]} */
  const results = []
  /** @type {((session: { id: string }, event: unknown) => void) | null} */
  let sessionListener = null
  /** Lets the test push $events frames. */
  /** @type {(frame: object) => void} */
  let pushEvent = () => {}

  /** An async iterable fed by push(), ending on abort. */
  function channel(signal) {
    const queue = []
    let wake = null
    signal?.addEventListener('abort', () => wake?.())
    return {
      push: (value) => { queue.push(value); wake?.() },
      async* [Symbol.asyncIterator]() {
        while (!signal?.aborted) {
          if (queue.length > 0) { yield queue.shift(); continue }
          await new Promise((resolve) => { wake = resolve })
          wake = null
        }
      },
    }
  }

  const gateway = {
    async invoke({ namespace, method, args }) {
      calls.push({ namespace, method, args })
      if (method === 'list') return { items: [{ id: 's1' }] }
      if (method === 'prompt') { await new Promise(r => setTimeout(r, 30)); return { accepted: args.request.requestId } }
      if (method === 'projections') {
        if (args.request.sessionId === 'parent') return { asOfSeq: 1, values: { subagentCatalog: [{ id: 'c1', mode: 'continuable', label: 'review', createdAt: 0 }, { id: 'gone', mode: 'one-shot', createdAt: 0 }] } }
        if (args.request.sessionId === 'c1') return { asOfSeq: 1, values: { subagentTiming: { settledMs: 0, active: { since: 0, through: 1 } }, subagentCatalog: [] } }
        return null
      }
      throw Object.assign(new Error(`unexpected ${namespace}/${method}`), { code: 'test/unexpected' })
    },
    async stream({ namespace, method, signal }) {
      const c = channel(signal)
      if (namespace === 'session' && method === 'control') {
        c.push({ type: 'baseline', value: { projections: { s1: { asOfSeq: 3, values: { inbox: { 'next-turn': [{ id: 'm1', content: [{ type: 'text', text: 'later' }] }], 'next-step': [] } } } } } })
        setTimeout(() => c.push({ type: 'projection', sessionId: 's1', key: 'inbox', value: { 'next-turn': [], 'next-step': [{ id: 'm2', content: [{ type: 'text', text: 'now' }] }] }, seq: 4 }), 20)
      }
      if (namespace === 'workspace') c.push({ type: 'baseline', value: { items: ['w'] } })
      return c
    },
    wireStream: {
      async open(endpoint, payload, uplink, peer, signal) {
        assert.equal(endpoint, '$events')
        assert.ok(uplink[Symbol.asyncIterator], 'uplink is an async iterable (dsh 0.2)')
        assert.ok(signal instanceof AbortSignal)
        const c = channel(signal)
        pushEvent = frame => c.push(frame)
        c.push({ type: 'ready', clientId: 'client-1' })
        return c
      },
    },
  }

  let server
  const base = () => `http://127.0.0.1:${server.port}`
  const rpc = (method, payload, headers = { [REMOTE_HEADER]: SECRET }) => fetch(`${base()}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', method, rpcId: `rpc-${method}-${Math.random()}`, payload }),
  })

  before(async () => {
    server = await startRemoteServer({
      gateway, secret: SECRET, logger: { warn() {} },
      sharedFetch: async (request) => { results.push(await request.json()); return Response.json({ type: 'server-response', result: { ok: true } }) },
      onSessionEvent: (listener) => { sessionListener = listener; return () => { sessionListener = null } },
      host: { version: 'GL Work test', attachedSessions: () => 2 },
    })
  })
  after(async () => { await server.close() })

  it('answers only what frpc forwards with this Mac\'s secret', async () => {
    assert.equal((await rpc('session.list', {}, {})).status, 403)
    assert.equal((await rpc('session.list', {}, { [REMOTE_HEADER]: 'wrong' })).status, 403)
    assert.equal((await rpc('session.delete', {})).status, 404)
    const ok = await (await rpc('session.list', { limit: 5 })).json()
    assert.deepEqual(ok.result, { ok: true, value: { items: [{ id: 's1' }] } })
    assert.deepEqual(calls.at(-1), { namespace: 'session', method: 'list', args: { _request: { limit: 5 } } })
    assert.deepEqual((await (await rpc('host.describe', {})).json()).result.value, { version: 'GL Work test', attachedSessions: 2 })
    assert.deepEqual((await (await rpc('workspace.list', {})).json()).result.value, { items: ['w'] })
  })

  it('reports Host errors in the envelope', async () => {
    const reply = await (await rpc('session.cancel', { sessionId: 's1' })).json()
    assert.equal(reply.result.ok, false)
    assert.equal(reply.result.error.code, 'test/unexpected')
  })

  it('accepts a retried prompt once', async () => {
    const body = JSON.stringify({ type: 'client-request', method: 'session.prompt', rpcId: 'same-rpc', payload: { sessionId: 's1', mode: 'queue', content: [] } })
    const send = () => fetch(`${base()}/api/session.prompt`, { method: 'POST', headers: { [REMOTE_HEADER]: SECRET }, body }).then(r => r.json())
    const before = calls.filter(c => c.method === 'prompt').length
    const [a, b] = await Promise.all([send(), send()])
    assert.deepEqual(a.result.value, { accepted: 'same-rpc' })
    assert.deepEqual(b.result.value, { accepted: 'same-rpc' })
    assert.equal(calls.filter(c => c.method === 'prompt').length, before + 1)
  })

  it('lists subagents from the parent\'s subagentCatalog', async () => {
    const reply = await (await rpc('subagent.list', { parentSessionId: 'parent' })).json()
    assert.deepEqual(reply.result.value, {
      parentAvailable: true,
      entries: [
        { kind: 'child', id: 'c1', mode: 'continuable', label: 'review', activity: 'running', hasChildren: false },
        { kind: 'diagnostic', id: 'gone', reason: 'missing' },
      ],
    })
    assert.deepEqual((await (await rpc('subagent.list', { parentSessionId: 'nope' })).json()).result.value, { entries: [], parentAvailable: false })
  })

  it('maps the inbox projection to the phone\'s queue', () => {
    assert.deepEqual(queueItems({ 'next-turn': [{ id: 'a', content: [] }], 'next-step': [{ id: 'b', content: [] }] }).map(i => [i.id, i.placement]), [['b', 'steering'], ['a', 'queued']])
    assert.deepEqual(queueItems(undefined), [])
  })

  it('streams projections, queues, events and decisions over events.mux', async () => {
    const refused = new WebSocket(`ws://127.0.0.1:${server.port}/api/events.mux`)
    await new Promise((resolve) => { refused.on('error', resolve); refused.on('unexpected-response', resolve) })

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/events.mux`, { headers: { [REMOTE_HEADER]: SECRET } })
    const frames = []
    const waitFor = (test) => new Promise((resolve) => {
      const check = () => { const hit = frames.find(test); if (hit) { resolve(hit); return true } return false }
      if (!check()) socket.on('message', () => check())
    })
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    await new Promise(resolve => socket.on('open', resolve))

    const queued = await waitFor(f => f.payload.type === 'session/queue' && f.payload.items.length === 1 && f.payload.items[0].id === 'm1')
    assert.equal(queued.payload.items[0].placement, 'queued')
    assert.equal(queued.payload.items[0].message.content[0].text, 'later')
    await waitFor(f => f.payload.type === 'session/queue' && f.payload.items[0]?.id === 'm2' && f.payload.items[0].placement === 'steering')
    assert.ok(frames.some(f => f.payload.type === 'session/projection' && f.payload.sessionId === 's1'))

    sessionListener?.({ id: 's1' }, { kind: 'x' })
    await waitFor(f => f.payload.type === 'session/event' && f.payload.sessionId === 's1')

    // An approval the phone allows; an unrelated waterfall is passed on.
    pushEvent({ type: 'waterfall', event: 'something/else', eventId: 'e0', agentId: 's1', request: {} })
    pushEvent({ type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's1', request: { toolName: 'bash', reason: 'run tests' } })
    const asked = await waitFor(f => f.payload.type === 'approval/requested')
    assert.deepEqual([asked.rpcId, asked.payload.approvalId, asked.payload.toolName], ['e1', 'e1', 'bash'])
    const respond = (body) => fetch(`${base()}/api/respond`, { method: 'POST', headers: { [REMOTE_HEADER]: SECRET }, body: JSON.stringify(body) }).then(r => r.json())
    assert.equal((await respond({ type: 'client-response', rpcId: 'e1', result: { ok: true, value: { sessionId: 'other', approvalId: 'e1', outcome: 'allowed-once' } } })).accepted, false)
    assert.deepEqual(await respond({ type: 'client-response', rpcId: 'e1', result: { ok: true, value: { sessionId: 's1', approvalId: 'e1', outcome: 'allowed-once' } } }), { accepted: true })
    await waitFor(f => f.payload.type === 'approval/resolved' && f.payload.approvalId === 'e1')
    assert.deepEqual(results.map(r => [r.payload.args.eventId, r.payload.args.outcome]), [['e0', { kind: 'next' }], ['e1', { kind: 'result', value: 'allowed-once' }]])
    assert.equal((await respond({ type: 'client-response', rpcId: 'e1', result: { ok: true, value: {} } })).accepted, false, 'settled once')

    // A question another client answered first.
    pushEvent({ type: 'waterfall', event: 'user-questions/request', eventId: 'q1', agentId: 's1', request: { questions: [{ id: 'q', question: '?' }] } })
    await waitFor(f => f.payload.type === 'question/requested')
    pushEvent({ type: 'cancel', eventId: 'q1' })
    await waitFor(f => f.payload.type === 'question/resolved' && f.payload.questionRpcId === 'q1')
    socket.close()
  })

  it('has frpc forward the relay\'s requests with the secret, on the internal name only', () => {
    const config = frpcConfig({
      server: { addr: 'frp.example.com', port: 443, protocol: 'wss' }, member: 'alice', tunnels: [], passwords: {}, visitors: [],
      remote: { id: 'tun_r', host: 'rabc.remote.internal', localPort: 50123, secret: 's3cret' }, remoteHeader: REMOTE_HEADER,
    }) ?? ''
    assert.match(config, /name = "tun_r"\ntype = "http"\nlocalIP = "127\.0\.0\.1"\nlocalPort = 50123\ncustomDomains = \["rabc\.remote\.internal"\]\nrequestHeaders\.set\.x-agent-work-remote = "s3cret"/u)
    assert.doesNotMatch(config, /httpUser/u)
  })
})
