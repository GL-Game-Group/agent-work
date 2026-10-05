/**
 * The company service without its web console: sign-in, the model gateway and
 * the desktop's config only. The full service (with the console) starts from
 * admin/server.js; this entry suits testing the desktop protocol alone.
 */
import { loadConfig } from './config.ts'
import { Store } from './db.ts'
import { GitHub } from './github.ts'
import { createGateway } from './server.ts'

if (process.env.AGENT_WORK_ENV_FILE !== undefined) process.loadEnvFile(process.env.AGENT_WORK_ENV_FILE)
const config = loadConfig()
if (config.secretKey === undefined) console.warn('agent-work: AGENT_WORK_SECRET_KEY is not set; API keys and secret public config cannot be stored (openssl rand -base64 32)')
const store = new Store(config.databasePath)
const server = createGateway({ config, store, github: new GitHub(config.github) })

const purge = setInterval(() => { store.purge() }, 60 * 60 * 1000)
purge.unref()

server.listen(config.listenPort, config.listenHost, () => {
  console.log(`agent-work: ${config.publicOrigin} served on ${config.listenHost}:${String(config.listenPort)}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => { store.close(); process.exit(0) })
    server.closeAllConnections()
  })
}
