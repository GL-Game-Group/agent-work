// @ts-check
/**
 * 手机远程, Mac half: the remote protocol GL Work for iOS speaks, served on a
 * loopback port that only this Mac's frpc forwards to (the company service
 * relays the member's signed-in phone to it through frps).
 *
 * The protocol is DSHRemote's v1 (POST /api/<method>, POST /api/respond, and
 * the /api/events.mux WebSocket), ported from remote-v1.js in
 * chokwinlee/deepseek-harness-desktop (MIT License, Copyright (c) 2026
 * chokwinlee) to dsh 0.2: queues come from the `inbox` projection, subagent
 * lists from `subagentCatalog`, and `$events` opens with an uplink and peer.
 *
 * frpc adds {@link REMOTE_HEADER} with this Mac's secret to every request it
 * forwards; anything else that reaches the port (another account on the Mac)
 * gets 403. Only the methods in {@link METHODS} exist here.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/** The header frpc sets (requestHeaders.set) on what it forwards. */
export const REMOTE_HEADER = 'x-agent-work-remote'

/** The remote methods, as GL Work for iOS calls them. */
export const METHODS = new Set([
  'host.describe', 'workspace.list', 'session.list', 'session.create', 'session.history', 'session.attachment', 'session.models',
  'session.selectModel', 'session.prompt', 'session.updateQueue', 'session.cancel', 'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  // @-mentions in the composer: the Host's own Remote methods, scoped to the session ({ args: { agentId, query } }).
  'fileReferences/list', 'sessionReferenceResolver/candidates',
  // The modes (agent presets) a session can run, to name the session's mode on the phone.
  'agentPresets/list',
])
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * @typedef {object} Gateway - ctx.typertGateway, as used here.
 * @property {(request: { namespace: string, method: string, args: object, signal?: AbortSignal }) => Promise<any>} invoke
 * @property {(request: { namespace: string, method: string, args: object, signal?: AbortSignal }) => Promise<AsyncIterable<any>>} stream
 * @property {{ open: (endpoint: string, payload: object, uplink: AsyncIterable<unknown>, peer: undefined, signal: AbortSignal) => Promise<AsyncIterable<any>> }} wireStream
 */

/** @param {unknown} error */
const failure = error => {
  const e = /** @type {{ code?: string, message?: string }} */ (error)
  return { ok: false, error: { code: e?.code || 'desktop/remote-failed', message: e?.message || String(error), details: {} } }
}

/**
 * One answer per (session, request id), however often the phone retries: the
 * Host journals a prompt's message a moment after accepting it.
 * @param {number} [limit]
 */
export function promptReceipts(limit = 2048) {
  /** @type {Map<string, Promise<unknown>>} */
  const pending = new Map()
  /** @type {Map<string, unknown>} */
  const accepted = new Map()
  /** @param {string} sessionId @param {string} requestId @param {() => Promise<unknown>} admit */
  return (sessionId, requestId, admit) => {
    const key = JSON.stringify([sessionId, requestId])
    if (accepted.has(key)) return Promise.resolve(accepted.get(key))
    const waiting = pending.get(key)
    if (waiting !== undefined) return waiting
    const receipt = Promise.resolve().then(admit).then((value) => {
      accepted.set(key, value)
      if (accepted.size > limit) accepted.delete(/** @type {string} */ (accepted.keys().next().value))
      return value
    }).finally(() => pending.delete(key))
    pending.set(key, receipt)
    return receipt
  }
}

/**
 * The first frame of a stream (its baseline), then let the stream go.
 * @param {Gateway} gateway @param {string} namespace @param {string} method @param {object} args @param {AbortSignal} [signal]
 */
export async function firstFrame(gateway, namespace, method, args, signal) {
  const abort = new AbortController()
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const stream = await gateway.stream({ namespace, method, args, signal: combined })
  const iterator = stream[Symbol.asyncIterator]()
  try {
    const next = await iterator.next()
    if (next.done) throw new Error(`Missing ${namespace}/${method} baseline`)
    return next.value
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

/**
 * A session's queued messages as the phone lists them, from its `inbox` projection.
 * @param {{ 'next-turn'?: { id: string, content: unknown }[], 'next-step'?: { id: string, content: unknown }[] } | undefined} inbox
 */
export function queueItems(inbox) {
  /** @param {{ id: string, content: unknown }[] | undefined} list @param {'queued' | 'steering'} placement */
  const items = (list, placement) => (list ?? []).map(m => ({ id: m.id, placement, message: { content: m.content }, content: m.content }))
  return [...items(inbox?.['next-step'], 'steering'), ...items(inbox?.['next-turn'], 'queued')]
}

/**
 * One remote method.
 * @param {Gateway} gateway
 * @param {string} endpoint
 * @param {Record<string, any>} payload
 * @param {{ version: string, attachedSessions: () => number }} host
 * @param {AbortSignal} [signal]
 */
export async function invokeRemote(gateway, endpoint, payload, host, signal) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Remote payload')
  /** @param {string} namespace @param {string} method @param {object} args */
  const invoke = (namespace, method, args) => gateway.invoke({ namespace, method, args, ...signal ? { signal } : {} })
  switch (endpoint) {
    case 'host.describe': return { version: host.version, attachedSessions: host.attachedSessions() }
    case 'workspace.list': return (await firstFrame(gateway, 'workspace', 'follow', {}, signal)).value
    case 'session.list': return invoke('session', 'list', { _request: payload })
    case 'session.history':
    case 'subagent.history': {
      const address = endpoint === 'session.history'
        ? { kind: 'session', sessionId: payload.sessionId }
        : { kind: 'subagent', parentSessionId: payload.parentSessionId, childSessionId: payload.childSessionId, mode: payload.mode }
      const request = { address, ...payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages } }
      const snapshot = await firstFrame(gateway, 'session', 'follow', { request }, signal)
      return { events: snapshot.records, hasMore: snapshot.hasMore, projections: snapshot.projections }
    }
    case 'session.models': {
      const catalog = await invoke('session', 'modelCatalog', {})
      const snapshot = await firstFrame(gateway, 'session', 'follow', { request: { address: { kind: 'session', sessionId: payload.sessionId }, maxMessages: 1 } }, signal)
      const current = snapshot.projections.values.modelSelection?.next ?? catalog.default
      return { current, routable: catalog.routableProviders.includes(current.provider), groups: catalog.groups, failures: catalog.failures }
    }
    case 'subagent.list': {
      // dsh 0.2 lists a parent's children in its subagentCatalog projection.
      const parent = await invoke('session', 'projections', { request: { sessionId: payload.parentSessionId } })
      if (parent === null) return { entries: [], parentAvailable: false }
      const catalog = /** @type {{ id: string, mode: string, label?: string }[]} */ (parent.values.subagentCatalog ?? [])
      const entries = await Promise.all(catalog.map(async (entry) => {
        const child = await invoke('session', 'projections', { request: { sessionId: entry.id } }).catch(() => null)
        if (child === null) return { kind: 'diagnostic', id: entry.id, reason: 'missing' }
        return {
          kind: 'child', id: entry.id, mode: entry.mode, label: entry.label,
          activity: child.values.subagentTiming?.active === undefined ? 'inactive' : 'running',
          hasChildren: (child.values.subagentCatalog ?? []).length > 0,
        }
      }))
      return { entries, parentAvailable: true }
    }
    case 'subagent.prompt': return invoke('subagents', 'prompt', { request: payload })
    case 'subagent.interrupt': return invoke('subagents', 'interruptByParent', { childSessionId: payload.childSessionId, parentSessionId: payload.parentSessionId, mode: payload.mode })
    case 'session.prompt': return invoke('session', 'prompt', { request: { ...payload, requestId: payload.requestId ?? randomUUID() } })
    case 'agentPresets/list': return invoke('agentPresets', 'list', {})
    case 'fileReferences/list':
    case 'sessionReferenceResolver/candidates': {
      const [namespace = '', method = ''] = endpoint.split('/')
      const args = payload.args ?? {}
      return invoke(namespace, method, { agentId: String(args.agentId ?? ''), query: String(args.query ?? '') })
    }
    default: {
      if (!METHODS.has(endpoint)) throw new Error('Unsupported Remote method')
      return invoke('session', endpoint.slice('session.'.length), { request: payload })
    }
  }
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of /** @type {AsyncIterable<Buffer>} */ (req)) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Serve the remote protocol on 127.0.0.1.
 * @param {object} options
 * @param {Gateway} options.gateway - ctx.typertGateway.
 * @param {(request: Request) => Promise<Response>} options.sharedFetch - the Host's own /api handler (for $events/result).
 * @param {(listener: (session: { id: string }, event: unknown) => void) => () => void} options.onSessionEvent
 * @param {{ version: string, attachedSessions: () => number }} options.host
 * @param {string} options.secret - what frpc sends in {@link REMOTE_HEADER}.
 * @param {{ warn: (format: string, ...args: unknown[]) => void }} options.logger
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startRemoteServer({ gateway, sharedFetch, onSessionEvent, host, secret, logger }) {
  const admitPrompt = promptReceipts()
  const expected = Buffer.from(secret)
  /** @param {import('node:http').IncomingMessage} req */
  const fromFrpc = (req) => {
    const value = req.headers[REMOTE_HEADER]
    if (typeof value !== 'string') return false
    const actual = Buffer.from(value)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  /** Decisions the phone may make, by $events event id. */
  /** @type {Map<string, { clientId: string, kind: 'approval' | 'question', agentId: string, socket: import('ws').WebSocket }>} */
  const pending = new Map()
  /** @type {Set<import('ws').WebSocket>} */
  const sockets = new Set()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

  /** @param {import('ws').WebSocket} socket @param {object} payload @param {string} [rpcId] */
  const send = (socket, payload, rpcId = randomUUID()) => {
    if (socket.readyState === 1 && socket.bufferedAmount < 4 * 1024 * 1024) socket.send(JSON.stringify({ rpcId, payload }))
    else if (socket.readyState === 1) socket.close(1013, 'Slow Remote client; reconnect')
  }
  const stopEvents = onSessionEvent((session, event) => { for (const socket of sockets) send(socket, { type: 'session/event', sessionId: session.id, event }) })

  /**
   * Projections (and queues, from the inbox projection) for as long as the socket lives.
   * @param {import('ws').WebSocket} socket @param {AbortSignal} signal
   */
  async function controls(socket, signal) {
    const stream = await gateway.stream({ namespace: 'session', method: 'control', args: {}, signal })
    for await (const frame of stream) {
      if (frame.type === 'baseline') {
        for (const [id, value] of Object.entries(/** @type {Record<string, any>} */ (frame.value.projections))) {
          send(socket, { type: 'session/projection', sessionId: id, projections: value })
          send(socket, { type: 'session/queue', sessionId: id, items: queueItems(value?.values?.inbox) })
        }
      } else if (frame.type === 'projection') {
        send(socket, { type: 'session/projection', sessionId: frame.sessionId, key: frame.key, value: frame.value, seq: frame.seq })
        if (frame.key === 'inbox') send(socket, { type: 'session/queue', sessionId: frame.sessionId, items: queueItems(frame.value) })
      }
    }
  }

  /** @param {string} clientId @param {string} eventId @param {object} outcome */
  async function result(clientId, eventId, outcome) {
    const response = await sharedFetch(new Request('http://dsh.internal/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId, eventId, outcome } } }),
    }))
    const body = /** @type {{ result?: { ok?: boolean, error?: { message?: string } } }} */ (await response.json())
    if (!body.result?.ok) throw new Error(body.result?.error?.message || 'Remote decision was rejected')
  }

  /**
   * Approvals and questions, offered to the phone; any client may settle them first.
   * @param {import('ws').WebSocket} socket @param {AbortSignal} signal
   */
  async function events(socket, signal) {
    /** @type {string} */
    let clientId = ''
    const stream = await gateway.wireStream.open('$events', { args: {} }, (async function* () { /* the phone sends nothing upstream */ })(), undefined, signal)
    for await (const frame of stream) {
      if (frame.type === 'ready') clientId = frame.clientId
      else if (frame.type === 'waterfall') {
        const kind = frame.event === 'approval/request' ? 'approval' : frame.event === 'user-questions/request' ? 'question' : undefined
        if (kind === undefined) { await result(clientId, frame.eventId, { kind: 'next' }); continue }
        pending.set(frame.eventId, { clientId, kind, agentId: frame.agentId, socket })
        send(socket, { ...frame.request, type: `${kind}/requested`, sessionId: frame.agentId, ...kind === 'approval' ? { approvalId: frame.eventId } : {} }, frame.eventId)
      } else if (frame.type === 'cancel') {
        const entry = pending.get(frame.eventId)
        pending.delete(frame.eventId)
        if (entry) send(socket, { type: `${entry.kind}/resolved`, sessionId: entry.agentId, approvalId: frame.eventId, questionRpcId: frame.eventId }, frame.eventId)
      }
    }
  }

  /** @param {Record<string, any>} envelope */
  async function respond(envelope) {
    const entry = pending.get(envelope.rpcId)
    if (envelope.type !== 'client-response' || !entry) throw new Error('Decision is no longer pending')
    const value = envelope.result?.value
    /** @type {object} */
    let outcome
    if (envelope.result?.ok === false && entry.kind === 'question') outcome = { kind: 'rejected', error: { name: 'Error', code: 'cancelled', message: 'User cancelled the question' } }
    else {
      if (value?.sessionId !== entry.agentId) throw new Error('Decision session mismatch')
      if (entry.kind === 'approval') {
        if (value.approvalId !== envelope.rpcId || !['allowed-once', 'rejected'].includes(value.outcome)) throw new Error('Invalid approval decision')
        outcome = { kind: 'result', value: value.outcome }
      } else {
        if (!Array.isArray(value.answer?.answers)) throw new Error('Invalid question answer')
        outcome = { kind: 'result', value: value.answer }
      }
    }
    await result(entry.clientId, envelope.rpcId, outcome)
    pending.delete(envelope.rpcId)
    send(entry.socket, { type: `${entry.kind}/resolved`, sessionId: entry.agentId, approvalId: envelope.rpcId, questionRpcId: envelope.rpcId }, envelope.rpcId)
  }

  const server = createServer((req, res) => {
    /** @param {number} status @param {unknown} body */
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body)) }
    if (!fromFrpc(req)) { reply(403, { error: 'Forbidden' }); req.resume(); return }
    const endpoint = req.method === 'POST' && req.url?.startsWith('/api/') ? req.url.slice('/api/'.length) : ''
    if (endpoint === 'respond') {
      readBody(req).then(respond).then(() => reply(200, { accepted: true }), error => reply(200, { accepted: false, reason: error instanceof Error ? error.message : String(error) }))
      return
    }
    if (!METHODS.has(endpoint)) { reply(404, { error: 'Unsupported Remote method' }); req.resume(); return }
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    /** @type {Record<string, any> | undefined} */
    let envelope
    readBody(req).then(async (body) => {
      envelope = body
      if (body?.type !== 'client-request' || body.method !== endpoint || typeof body.rpcId !== 'string' || !body.rpcId) { reply(400, { error: 'Invalid RPC envelope' }); return }
      const payload = endpoint === 'session.prompt' ? { ...body.payload, requestId: body.rpcId } : body.payload
      const run = () => invokeRemote(gateway, endpoint, payload, host, abort.signal)
      const value = endpoint === 'session.prompt' ? await admitPrompt(payload.sessionId, body.rpcId, run) : await run()
      reply(200, { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
    }).catch((error) => { if (!res.headersSent) reply(200, { type: 'server-response', rpcId: envelope?.rpcId, result: failure(error) }) })
  })

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    if (!fromFrpc(req) || req.url !== '/api/events.mux') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      sockets.add(websocket)
      websocket.on('error', () => abort.abort())
      websocket.on('close', () => {
        abort.abort()
        sockets.delete(websocket)
        for (const [id, entry] of pending) if (entry.socket === websocket) pending.delete(id)
      })
      Promise.all([controls(websocket, abort.signal), events(websocket, abort.signal)]).catch((error) => {
        if (!abort.signal.aborted) logger.warn('remote events stream ended: %s', error instanceof Error ? error.message : String(error))
        websocket.close(1011, 'Remote stream closed')
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    port: address.port,
    close: async () => {
      stopEvents()
      for (const socket of sockets) socket.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise(resolve => server.close(() => resolve(undefined)))
    },
  }
}
