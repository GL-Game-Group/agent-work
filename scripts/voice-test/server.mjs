/**
 * A local page for trying the company's voice vendors by hand — Qwen (DashScope) and Volcengine,
 * speech recognition and read-aloud — with the same protocols the phone uses
 * (orca/mobile/src/eva/glwork/voice/). Browsers cannot put headers on a WebSocket, so this server
 * relays: the page streams 16 kHz PCM here, the server talks to the vendor with the key the page
 * sends, and prints every refusal with its HTTP status and body.
 *
 *   pnpm voice:test        # http://127.0.0.1:8799
 *
 * Keys are typed into the page and kept only in that tab and this process; nothing is written.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

// Why: the tunnel plugin already ships ws, which reports a refused handshake's status and body.
const require = createRequire(new URL('../../plugins/tunnel/package.json', import.meta.url))
const { WebSocket, WebSocketServer } = require('ws')

const PORT = Number(process.env.VOICE_TEST_PORT ?? 8799)
const PAGE = new URL('./index.html', import.meta.url)
const QWEN_ASR = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const QWEN_TTS = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
const QWEN_TOKEN = 'https://dashscope.aliyuncs.com/api/v1/tokens'
const VOLC_ASR = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const VOLC_TTS = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const QWEN_TTS_REALTIME = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const VOLC_TTS_BIDIRECTION = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
/** Streaming read-aloud comes as 16 kHz 16-bit mono PCM, what the phone's audio engine plays. */
const STREAM_RATE = 16000

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Qwen's short-lived key, as the company service hands one to the phone. */
async function qwenTemporaryKey(key) {
  const response = await fetch(`${QWEN_TOKEN}?expire_in_seconds=300`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` }
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`换临时 Key 失败 ${response.status}: ${body.slice(0, 300)}`)
  return JSON.parse(body).token
}

async function qwenSpeech({ key, model, voice, text }) {
  const response = await fetch(QWEN_TTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: { text, voice, language_type: 'Chinese' } })
  })
  const body = await response.text()
  log('qwen tts', response.status, body.slice(0, 300))
  if (!response.ok) throw new Error(`千问合成失败 ${response.status}: ${body.slice(0, 500)}`)
  const url = JSON.parse(body)?.output?.audio?.url
  if (typeof url !== 'string') throw new Error(`千问没有返回音频地址: ${body.slice(0, 500)}`)
  const audio = await fetch(url)
  return { type: audio.headers.get('content-type') ?? 'audio/wav', bytes: Buffer.from(await audio.arrayBuffer()) }
}

async function volcSpeech({ key, model, voice, text, rate }) {
  const requestId = randomUUID()
  const response = await fetch(VOLC_TTS, {
    method: 'POST',
    headers: { 'x-api-key': key, 'x-api-resource-id': model, 'x-api-request-id': requestId, 'content-type': 'application/json' },
    body: JSON.stringify({
      user: { uid: 'glwork-voice-test' },
      req_params: { text, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: Number(rate) || 0 } }
    })
  })
  const raw = await response.text()
  const parts = []
  let failure = ''
  for (const piece of raw.split(/\r?\n|(?<=\})(?=\{)/u)) {
    try {
      const item = JSON.parse(piece.trim())
      if (typeof item.data === 'string' && item.data) parts.push(Buffer.from(item.data, 'base64'))
      if (item.code !== undefined && item.code !== 0 && item.code !== 20000000) failure = `${item.code} ${item.message ?? ''}`
    } catch {}
  }
  log('volc tts', response.status, failure || `${parts.length} chunks`, response.headers.get('x-tt-logid') ?? '')
  if (!response.ok || failure || parts.length === 0) {
    throw new Error(`火山合成失败 ${response.status} ${failure}: ${raw.slice(0, 500)}`)
  }
  return { type: 'audio/mpeg', bytes: Buffer.concat(parts) }
}

/** 16-bit mono PCM in a WAV header, so the page's <audio> can play a streamed reading. */
function wav(pcm, rate = STREAM_RATE) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

/** Runs one streamed reading: resolves with all PCM, logging how soon the first audio came. */
function streamed(name, open) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const parts = []
    let first = 0
    const timer = setTimeout(() => done(new Error(`${name} 30 秒没有结束`)), 30_000)
    const done = (error) => {
      clearTimeout(timer)
      if (error) return reject(error)
      log(name, `首包 ${first ? first - started : '-'} ms，共 ${Date.now() - started} ms，${parts.length} 段`)
      if (parts.length === 0) return reject(new Error(`${name} 没有返回音频`))
      resolve({ type: 'audio/wav', bytes: wav(Buffer.concat(parts)) })
    }
    open({
      audio: (chunk) => {
        first ||= Date.now()
        parts.push(chunk)
      },
      done
    })
  })
}

/** Qwen-TTS Realtime: session.update, the text, session.finish; audio as response.audio.delta. */
function qwenStreamSpeech({ key, model, voice, text }) {
  return streamed('qwen 实时播报', ({ audio, done }) => {
    const socket = new WebSocket(`${QWEN_TTS_REALTIME}?model=${encodeURIComponent(model)}`, {
      headers: { authorization: `Bearer ${key}` }
    })
    const send = (body) => socket.send(JSON.stringify({ event_id: randomUUID(), ...body }))
    socket.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => done(new Error(`千问实时播报握手被拒 ${res.statusCode}: ${body.slice(0, 300)}`)))
    })
    socket.on('open', () => {
      send({
        type: 'session.update',
        session: { mode: 'server_commit', voice, language_type: 'Chinese', response_format: 'pcm', sample_rate: STREAM_RATE }
      })
      send({ type: 'input_text_buffer.append', text })
      send({ type: 'session.finish' })
    })
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString())
      if (event.type === 'response.audio.delta') audio(Buffer.from(event.delta, 'base64'))
      else if (event.type === 'error') done(new Error(`千问实时播报出错: ${JSON.stringify(event.error ?? event).slice(0, 300)}`))
      else if (event.type === 'session.finished') {
        socket.close()
        done()
      } else log('qwen tts event', event.type)
    })
    socket.on('error', (error) => done(error))
  })
}

/**
 * Volcengine's bidirectional TTS frames: a 4-byte header (full client request, "with event"), the
 * event number, the session id for session events, then the JSON payload.
 */
const VOLC_EVENT = { StartConnection: 1, FinishConnection: 2, StartSession: 100, FinishSession: 102, TaskRequest: 200 }
function volcEventFrame(event, sessionId, payload) {
  const parts = [Buffer.from([0x11, 0x14, 0x10, 0x00])]
  const number = Buffer.alloc(4)
  number.writeInt32BE(event)
  parts.push(number)
  if (sessionId) {
    const id = Buffer.from(sessionId)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(id.length)
    parts.push(size, id)
  }
  const body = Buffer.from(JSON.stringify(payload))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  parts.push(size, body)
  return Buffer.concat(parts)
}

function readVolcEvent(data) {
  const type = data[1] >> 4
  const flags = data[1] & 0x0f
  let offset = (data[0] & 0x0f) * 4
  if (type === 0b1111) {
    const code = data.readUInt32BE(offset)
    const size = data.readUInt32BE(offset + 4)
    return { error: `${code} ${data.subarray(offset + 8, offset + 8 + size).toString()}` }
  }
  let event = 0
  if (flags & 0x04) {
    event = data.readInt32BE(offset)
    offset += 4
  }
  // Connection events carry the connection id; session events the session id.
  if (event >= 50) {
    const idSize = data.readUInt32BE(offset)
    offset += 4 + idSize
  }
  const size = data.readUInt32BE(offset)
  const payload = data.subarray(offset + 4, offset + 4 + size)
  return { type, event, payload }
}

function volcStreamSpeech({ key, model, voice, text, rate }) {
  return streamed('volc 实时播报', ({ audio, done }) => {
    const sessionId = randomUUID()
    const socket = new WebSocket(VOLC_TTS_BIDIRECTION, {
      headers: { 'x-api-key': key, 'x-api-resource-id': model, 'x-api-connect-id': randomUUID() }
    })
    const req = {
      speaker: voice,
      audio_params: { format: 'pcm', sample_rate: STREAM_RATE, speech_rate: Number(rate) || 0 }
    }
    socket.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => done(new Error(`火山实时播报握手被拒 ${res.statusCode}: ${body.slice(0, 300)}`)))
    })
    socket.on('open', () => socket.send(volcEventFrame(VOLC_EVENT.StartConnection, null, {})))
    socket.on('message', (data) => {
      const frame = readVolcEvent(data)
      if (frame.error) return done(new Error(`火山实时播报出错: ${frame.error}`))
      if (frame.event === 50) {
        socket.send(volcEventFrame(VOLC_EVENT.StartSession, sessionId, {
          user: { uid: 'glwork-voice-test' }, event: VOLC_EVENT.StartSession, namespace: 'BidirectionalTTS', req_params: req
        }))
      } else if (frame.event === 150) {
        socket.send(volcEventFrame(VOLC_EVENT.TaskRequest, sessionId, {
          user: { uid: 'glwork-voice-test' }, event: VOLC_EVENT.TaskRequest, namespace: 'BidirectionalTTS', req_params: { ...req, text }
        }))
        socket.send(volcEventFrame(VOLC_EVENT.FinishSession, sessionId, {}))
      } else if (frame.event === 352 && frame.type === 0b1011) {
        audio(Buffer.from(frame.payload))
      } else if (frame.event === 152) {
        socket.send(volcEventFrame(VOLC_EVENT.FinishConnection, null, {}))
        socket.close()
        done()
      } else if (frame.event === 51 || frame.event === 153) {
        done(new Error(`火山实时播报失败 (${frame.event}): ${frame.payload.toString().slice(0, 300)}`))
      } else log('volc tts event', frame.event)
    })
    socket.on('error', (error) => done(error))
  })
}

/** Volcengine's sauc frames (see orca/mobile/src/eva/glwork/voice/volc-asr-frames.ts). */
function volcFrame(type, flags, serialization, sequence, payload) {
  const head = Buffer.alloc(12)
  head[0] = 0x11
  head[1] = (type << 4) | flags
  head[2] = serialization << 4
  head.writeInt32BE(sequence, 4)
  head.writeUInt32BE(payload.length, 8)
  return Buffer.concat([head, payload])
}

function readVolc(data) {
  const type = data[1] >> 4
  const flags = data[1] & 0x0f
  let offset = (data[0] & 0x0f) * 4
  if (type === 0b1111) {
    const code = data.readUInt32BE(offset)
    const size = data.readUInt32BE(offset + 4)
    return { kind: 'error', text: `${code} ${data.subarray(offset + 8, offset + 8 + size).toString()}` }
  }
  if (type !== 0b1001) return { kind: 'other' }
  if (flags & 1) offset += 4
  if (flags & 4) offset += 4
  const size = data.readUInt32BE(offset)
  const raw = data.subarray(offset + 4, offset + 4 + size).toString()
  let text = ''
  try {
    text = JSON.parse(raw)?.result?.text ?? ''
  } catch {}
  return { kind: 'result', text, last: (flags & 2) !== 0, raw }
}

/** One recognition: the page's first message names the vendor; then PCM; then "finish". */
function relayAsr(page) {
  let upstream = null
  let sequence = 1
  const tell = (body) => page.readyState === 1 && page.send(JSON.stringify(body))

  page.on('message', async (data, isBinary) => {
    if (!upstream && !isBinary) {
      const start = JSON.parse(data.toString())
      let key = start.key
      if (start.vendor === 'qwen' && start.temporary) {
        try {
          key = await qwenTemporaryKey(start.key)
          tell({ type: 'log', text: '已换成千问临时 Key（和手机一样）' })
        } catch (error) {
          tell({ type: 'error', text: String(error.message) })
          return
        }
      }
      const url = start.vendor === 'qwen' ? `${QWEN_ASR}?model=${encodeURIComponent(start.model)}` : VOLC_ASR
      const headers =
        start.vendor === 'qwen'
          ? { Authorization: `Bearer ${key}` }
          : { 'X-Api-Key': key, 'X-Api-Resource-Id': start.model, 'X-Api-Connect-Id': randomUUID() }
      upstream = new WebSocket(url, { headers })
      upstream.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          const logid = res.headers['x-tt-logid'] ?? ''
          log(start.vendor, 'asr handshake refused', res.statusCode, body, logid)
          tell({ type: 'error', text: `握手被拒绝 HTTP ${res.statusCode}: ${body}${logid ? `（logid ${logid}）` : ''}` })
        })
      })
      upstream.on('error', (error) => tell({ type: 'error', text: `连接出错: ${error.message}` }))
      upstream.on('close', (code, reason) => tell({ type: 'log', text: `厂商连接关闭 ${code} ${reason}` }))
      upstream.on('open', () => {
        log(start.vendor, 'asr open')
        tell({ type: 'log', text: '已连上厂商，开始说话' })
        if (start.vendor === 'qwen') {
          upstream.send(JSON.stringify({
            type: 'session.update',
            session: {
              input_audio_format: 'pcm',
              sample_rate: 16000,
              input_audio_transcription: { language: 'zh' },
              turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 400 }
            }
          }))
        } else {
          const request = {
            user: { uid: 'glwork-voice-test' },
            audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
            request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, result_type: 'full' }
          }
          upstream.send(volcFrame(0b0001, 0b0001, 0b0001, sequence, Buffer.from(JSON.stringify(request))))
        }
      })
      const done = []
      upstream.on('message', (raw, binary) => {
        if (start.vendor === 'qwen' && !binary) {
          const event = JSON.parse(raw.toString())
          tell({ type: 'event', event })
          if (event.type === 'conversation.item.input_audio_transcription.text') {
            tell({ type: 'text', text: done.join('') + (event.text ?? '') + (event.stash ?? '') })
          } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
            done.push(event.transcript ?? '')
            tell({ type: 'text', text: done.join('') })
          } else if (event.type === 'session.finished') {
            tell({ type: 'done', text: done.join('') })
          } else if (event.type === 'error') {
            tell({ type: 'error', text: JSON.stringify(event.error) })
          }
        } else if (start.vendor === 'volc' && binary) {
          const read = readVolc(raw)
          if (read.kind === 'error') tell({ type: 'error', text: `火山错误 ${read.text}` })
          if (read.kind === 'result') {
            tell({ type: 'event', event: read.raw })
            if (read.text) tell({ type: 'text', text: read.text })
            if (read.last) tell({ type: 'done', text: read.text })
          }
        }
      })
      return
    }
    if (!upstream || upstream.readyState !== 1) return
    if (isBinary) {
      if (upstream.url.startsWith(QWEN_ASR)) {
        upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(data).toString('base64') }))
      } else {
        sequence += 1
        upstream.send(volcFrame(0b0010, 0b0001, 0, sequence, Buffer.from(data)))
      }
    } else if (data.toString() === 'finish') {
      if (upstream.url.startsWith(QWEN_ASR)) {
        upstream.send(JSON.stringify({ type: 'session.finish' }))
      } else {
        sequence += 1
        upstream.send(volcFrame(0b0010, 0b0011, 0, -sequence, Buffer.alloc(0)))
      }
    }
  })
  page.on('close', () => upstream?.close())
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(readFileSync(PAGE))
    return
  }
  if (req.method === 'POST' && req.url === '/api/tts') {
    const body = await readBody(req)
    try {
      let key = body.key
      if (body.vendor === 'qwen' && body.temporary) key = await qwenTemporaryKey(body.key)
      const audio = body.stream
        ? body.vendor === 'qwen'
          ? await qwenStreamSpeech({ ...body, key })
          : await volcStreamSpeech(body)
        : body.vendor === 'qwen'
          ? await qwenSpeech({ ...body, key })
          : await volcSpeech(body)
      res.writeHead(200, { 'content-type': audio.type })
      res.end(audio.bytes)
    } catch (error) {
      json(res, 502, { error: String(error.message) })
    }
    return
  }
  res.writeHead(404)
  res.end()
})

new WebSocketServer({ server, path: '/api/asr' }).on('connection', relayAsr)
server.listen(PORT, '127.0.0.1', () => log(`语音测试页: http://127.0.0.1:${PORT}`))
