/**
 * 手机远程's relay: a signed-in phone's requests to one of its member's Macs,
 * passed to frps's HTTP port on the internal network under the Mac's
 * `remote` tunnel name (tunnels.ts), where the Mac's frpc picks them up.
 *
 * Only what the remote protocols need crosses: for GL Work on DSH, POST
 * /api/<method> and the /api/events.mux WebSocket; for GL Work on Orca, the
 * pairing request and Orca's end-to-end encrypted WebSocket. The phone's own credential never does, nor any
 * other header the Mac does not read.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

/** The Mac's remote API methods: `session.prompt`, `respond`, `fileReferences/list`, … (the Mac checks its own allowlist too). */
export const REMOTE_METHOD = /^[a-z][A-Za-z]{0,39}(?:[./][A-Za-z]{1,39})?$/u
/** Prompts carry images, so bodies may be large; nothing else is. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
const RESPONSE_TIMEOUT_MS = 120_000

export interface RemoteHop {
  /** frps's HTTP port on the internal network. */
  vhost: { host: string; port: number }
  /** The Mac's tunnel name, which frps routes on. */
  host: string
}

/** POST `path` (`/api/<method>`, `/glwork/remote/pair`) to the Mac; its answer goes back as is. */
export function relayRequest(req: IncomingMessage, res: ServerResponse, hop: RemoteHop, path: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const length = Number(req.headers['content-length'] ?? 'NaN')
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      fail(res, 413, '请求太大')
      req.resume()
      resolve()
      return
    }
    const upstream = httpRequest({
      host: hop.vhost.host, port: hop.vhost.port, method: 'POST', path,
      headers: {
        'host': hop.host,
        'content-type': req.headers['content-type'] ?? 'application/json',
        ...Number.isFinite(length) ? { 'content-length': String(length) } : {},
      },
      timeout: RESPONSE_TIMEOUT_MS,
    }, (answer) => {
      // frps answers 404 for a name with no running proxy: the Mac went away just now.
      const status = answer.statusCode ?? 502
      if (status === 404 && answer.headers['content-type']?.startsWith('text/html') === true) {
        answer.resume()
        fail(res, 503, '这台电脑现在不在线')
        resolve()
        return
      }
      res.writeHead(status, { ...headers, 'content-type': answer.headers['content-type'] ?? 'application/json' })
      answer.pipe(res)
      answer.on('end', resolve)
      answer.on('error', () => { res.destroy(); resolve() })
    })
    upstream.on('timeout', () => { upstream.destroy(new Error('timeout')) })
    upstream.on('error', () => {
      if (!res.headersSent) fail(res, 502, '暂时连不上这台电脑')
      else res.destroy()
      resolve()
    })
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        upstream.destroy()
        if (!res.headersSent) fail(res, 413, '请求太大')
        req.destroy()
      }
    })
    req.pipe(upstream)
  })

  function fail(response: ServerResponse, status: number, error: string): void {
    response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error }))
  }
}

/** Refuse an upgrade before it starts. */
export function refuseUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error })
  socket.end(`HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : 'Refused'}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`)
}

const WS_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'] as const

/**
 * A WebSocket to the Mac at `path` (`/api/events.mux`, or `/` for Orca): the handshake is replayed
 * with only the WebSocket headers, then bytes pass both ways untouched.
 * @returns a function that closes both sides (for revocation).
 */
export function relayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, hop: RemoteHop, path: string): () => void {
  const upstream = connect(hop.vhost.port, hop.vhost.host)
  const close = () => { upstream.destroy(); socket.destroy() }
  upstream.setNoDelay(true)
  upstream.on('connect', () => {
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${hop.host}`, 'Upgrade: websocket', 'Connection: Upgrade']
    for (const name of WS_HEADERS) {
      const value = req.headers[name]
      if (typeof value === 'string' && !/[\r\n]/u.test(value)) lines.push(`${name}: ${value}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => {
    if (socket.writable && upstream.bytesRead === 0) refuseUpgrade(socket, 502, '暂时连不上这台电脑')
    else socket.destroy()
  })
  socket.on('error', close)
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
  return close
}
