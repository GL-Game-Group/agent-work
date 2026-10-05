/**
 * Model gateway: forwards a member's Host requests to a vendor's API
 * unchanged (Anthropic Messages or OpenAI-compatible), with the company key in
 * place of the member's device token.
 *
 * Nothing is translated, so vendors' own protocol extensions (reasoning,
 * caching) pass through intact. JSON request bodies are read once to refuse
 * models the company has not offered. Responses stream back as they arrive;
 * the gateway only reads the `usage` fields on the way to record them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type LlmProtocol = 'anthropic' | 'openai'

/** One upstream the gateway forwards to. */
export interface LlmUpstream {
  /** Upstream root, e.g. https://api.deepseek.com/anthropic. */
  baseUrl: string
  /** The company key: x-api-key for Anthropic Messages, a Bearer token for OpenAI-compatible APIs. */
  apiKey: string
  protocol?: LlmProtocol
  /** Model ids a request may name; undefined allows any. */
  models?: ReadonlySet<string>
}

export interface LlmUsage {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  status: number
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
/** Client credentials and connection facts that never reach the upstream. */
const CLIENT_ONLY = new Set(['host', 'x-api-key', 'authorization', 'cookie', 'origin', 'referer', 'content-length',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])
/** fetch decodes the body, so encoding and length no longer describe what the client receives. */
const RESPONSE_DROPPED = new Set(['content-encoding', 'content-length', 'set-cookie'])
/** Long conversations with images run to tens of megabytes. */
const MAX_JSON_REQUEST_BYTES = 64 * 1024 * 1024

/** An error in the shape the member's Host adapter for that protocol surfaces. */
export function llmError(res: ServerResponse, protocol: LlmProtocol, status: number, type: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(protocol === 'openai' ? { error: { message, type, code: type } } : { type: 'error', error: { type, message } }))
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Accumulates usage from a Messages response, JSON or event stream. */
class UsageReader {
  usage: LlmUsage

  constructor(status: number) {
    this.usage = { model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, status }
  }

  /** A Messages object (JSON body or the `message` of message_start). */
  message(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const message = value as { model?: unknown; usage?: unknown }
    if (typeof message.model === 'string') this.usage.model = message.model
    this.counts(message.usage)
  }

  /** Usage counts; stream deltas carry running totals, so the latest value wins. */
  counts(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const usage = value as Record<string, unknown>
    if ('input_tokens' in usage) this.usage.inputTokens = numberOf(usage.input_tokens)
    if ('output_tokens' in usage) this.usage.outputTokens = numberOf(usage.output_tokens)
    if ('cache_read_input_tokens' in usage) this.usage.cacheReadTokens = numberOf(usage.cache_read_input_tokens)
    if ('cache_creation_input_tokens' in usage) this.usage.cacheWriteTokens = numberOf(usage.cache_creation_input_tokens)
  }

  /** OpenAI usage: prompt tokens include cached ones, which are counted apart here as on Anthropic. */
  openaiCounts(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null }
    const cached = numberOf(usage.prompt_tokens_details?.cached_tokens)
    this.usage.inputTokens = Math.max(0, numberOf(usage.prompt_tokens) - cached)
    this.usage.outputTokens = numberOf(usage.completion_tokens)
    this.usage.cacheReadTokens = cached
  }

  /** A chat completion or one of its stream chunks. */
  completion(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const chunk = value as { model?: unknown; usage?: unknown }
    if (typeof chunk.model === 'string') this.usage.model = chunk.model
    if (chunk.usage !== undefined && chunk.usage !== null) this.openaiCounts(chunk.usage)
  }

  /** One server-sent event's data. */
  event(data: string, protocol: LlmProtocol): void {
    if (data === '[DONE]') return
    let value: unknown
    try { value = JSON.parse(data) } catch { return }
    if (typeof value !== 'object' || value === null) return
    if (protocol === 'openai') { this.completion(value); return }
    const event = value as { type?: unknown; message?: unknown; usage?: unknown }
    if (event.type === 'message_start') this.message(event.message)
    else if (event.type === 'message_delta') this.counts(event.usage)
  }
}

/** Passes chunks through untouched while feeding complete SSE lines to the reader. */
function sseTap(reader: UsageReader, protocol: LlmProtocol): Transform {
  let pending = ''
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString('utf8')
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/u, '')
        pending = pending.slice(newline + 1)
        if (line.startsWith('data:')) reader.event(line.slice('data:'.length).trim(), protocol)
        newline = pending.indexOf('\n')
      }
      // A line longer than any event the reader cares about is not buffered forever.
      if (pending.length > 1024 * 1024) pending = ''
      callback(null, chunk)
    },
  })
}

/** Collects a JSON body (bounded) while passing it through. */
function jsonTap(reader: UsageReader, protocol: LlmProtocol): Transform {
  const chunks: Buffer[] = []
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size <= 4 * 1024 * 1024) chunks.push(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (protocol === 'openai') reader.completion(value)
        else reader.message(value)
      } catch { /* not a response object */ }
      callback()
    },
  })
}

/** Read a whole request body, or undefined past the limit. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_JSON_REQUEST_BYTES) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** The metered call of each protocol: Messages, and chat completions. */
function metered(protocol: LlmProtocol, method: string | undefined, path: string): boolean {
  if (method !== 'POST') return false
  return protocol === 'openai' ? /^\/chat\/completions(?:\?|$)/u.test(path) : /^\/v1\/messages(?:\?|$)/u.test(path)
}

/**
 * Forward one request under the gateway prefix.
 * @param req - the member Host's request.
 * @param res - response to stream back.
 * @param upstream - where to forward and with which key.
 * @param path - the path below the gateway prefix, with its query, starting with "/".
 * @returns usage for metered calls (undefined for other endpoints, refusals, or a failed connection).
 */
export async function forwardLlm(req: IncomingMessage, res: ServerResponse, upstream: LlmUpstream, path: string): Promise<LlmUsage | undefined> {
  const protocol = upstream.protocol ?? 'anthropic'
  const target = upstream.baseUrl.replace(/\/+$/u, '') + path
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || CLIENT_ONLY.has(name) || HOP_BY_HOP.has(name)) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  if (protocol === 'openai') headers.set('authorization', `Bearer ${upstream.apiKey}`)
  else headers.set('x-api-key', upstream.apiKey)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  // JSON bodies are read whole to check the model they name; uploads (multipart) stream through.
  let body: Buffer | undefined
  if (hasBody && (req.headers['content-type'] ?? '').includes('application/json')) {
    body = await readBody(req)
    if (body === undefined) { llmError(res, protocol, 413, 'request_too_large', '请求内容过大。'); return undefined }
    if (upstream.models !== undefined) {
      let model: unknown
      try { model = (JSON.parse(body.toString('utf8')) as { model?: unknown } | null)?.model } catch { /* forwarded as is; the upstream rejects it */ }
      if (typeof model === 'string' && !upstream.models.has(model)) {
        llmError(res, protocol, 403, 'permission_error', `公司没有开放模型 ${model}，请联系管理员。`)
        return undefined
      }
    }
  }
  const abort = new AbortController()
  res.once('close', () => { if (!res.writableFinished) abort.abort() })
  let response: Response
  try {
    response = await fetch(target, {
      method: req.method,
      headers,
      signal: abort.signal,
      redirect: 'manual',
      ...!hasBody ? {} : body !== undefined ? { body } : { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' },
    } as RequestInit)
  } catch {
    if (!res.headersSent) llmError(res, protocol, 502, 'api_error', '公司模型网关无法连接上游服务，请稍后重试。')
    return undefined
  }
  const outgoing: Record<string, string> = {}
  response.headers.forEach((value, name) => { if (!RESPONSE_DROPPED.has(name) && !HOP_BY_HOP.has(name)) outgoing[name] = value })
  res.writeHead(response.status, outgoing)
  if (response.body === null) { res.end(); return undefined }
  const measured = metered(protocol, req.method, path)
  const reader = new UsageReader(response.status)
  const streaming = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
  try {
    if (measured) await pipeline(stream, streaming ? sseTap(reader, protocol) : jsonTap(reader, protocol), res)
    else await pipeline(stream, res)
  } catch {
    res.destroy()
  }
  return measured ? reader.usage : undefined
}
