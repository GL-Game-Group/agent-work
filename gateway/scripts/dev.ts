/**
 * The company service alone (no web console) for developing the desktop
 * sign-in: a fake GitHub whose authorize page lets you pick a seeded member.
 * For the web console use `pnpm admin:dev`, which mounts the same service.
 *
 *   pnpm --filter @agent-work/gateway dev            # http://127.0.0.1:8787
 *   AGENT_WORK_DEV_PORT=8788 pnpm --filter @agent-work/gateway dev
 *
 * With DEEPSEEK_API_KEY in gateway/.env (read when present) the model gateway forwards to DeepSeek.
 * Point a desktop profile at it (in $DSH_HOME/profiles/desktop/cordis.patch.yml):
 *   - id: company-account
 *     config: { serverOrigin: 'http://127.0.0.1:8787', allowLoopbackHttp: true }
 */
import { createServer } from 'node:http'
import { startDevRuntime } from '../src/dev-runtime.ts'

const port = Number(process.env.AGENT_WORK_DEV_PORT ?? '8787')
const origin = `http://127.0.0.1:${String(port)}`
const { runtime, close } = await startDevRuntime({ publicOrigin: origin, ...process.env.AGENT_WORK_DEV_DB ? { databasePath: process.env.AGENT_WORK_DEV_DB } : {} })
const server = createServer((req, res) => {
  runtime.gateway(req, res).catch((error: unknown) => {
    console.error('dev: request failed', error)
    if (!res.headersSent) res.writeHead(500).end()
  })
})
server.listen(port, '127.0.0.1', () => { console.log(`agent-work dev service: ${origin} (fake GitHub; pick a member on its sign-in page)`) })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); close(); process.exit(0) })
