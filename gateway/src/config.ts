/** Company service configuration from the environment. */
import { SecretBox } from './secrets.ts'

export interface GitHubConfig {
  clientId: string
  clientSecret: string
  /** Organization login members must belong to; empty disables the check. */
  org: string
  /** Overridable for tests. */
  webUrl: string
  apiUrl: string
}

export interface GatewayConfig {
  /** Product name shown in the admin console. */
  productName?: string
  /** Public origin clients reach, e.g. https://agent.glwork.net. */
  publicOrigin: string
  listenHost: string
  listenPort: number
  /** Behind a reverse proxy (Traefik): take the client address from the last X-Forwarded-For entry. */
  trustProxy: boolean
  /**
   * A header naming the client's address, set by the edge in front of everything
   * (AGENT_WORK_CLIENT_IP_HEADER, e.g. cf-connecting-ip behind Cloudflare, when
   * frp's TLS passthrough hides the address from Traefik). It wins over
   * X-Forwarded-For; used for audit and rate limits only, never to authorize.
   */
  clientIpHeader?: string
  databasePath: string
  github: GitHubConfig
  /** Master key sealing vendor API keys and secret public config (AGENT_WORK_SECRET_KEY, 32 bytes base64 or hex). */
  secretKey?: string
  /**
   * frps, the tunnel server: where GL Work's frpc connects (AGENT_WORK_FRPS_ADDR,
   * _PORT, _PROTOCOL), the secret path frps calls back on (AGENT_WORK_FRP_PLUGIN_SECRET),
   * the server's public address domains must resolve to (AGENT_WORK_TUNNEL_IP), and
   * frps's HTTP port as this service reaches it on the internal network
   * (AGENT_WORK_FRPS_VHOST, e.g. http://frps:8080), which 手机远程 relays through.
   * Absent, tunnels are off; without the vhost, 手机远程 is.
   */
  frps?: { addr: string; port: number; protocol: 'wss' | 'tcp'; pluginSecret: string; publicIp: string | null; vhost: { host: string; port: number } | null }
  /** DEEPSEEK_API_KEY from before keys were managed in the console; imported into the vendor store once. */
  deepseek?: { baseUrl: string; apiKey: string }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`gateway: ${name} is required`)
  return value
}

function origin(value: string, name: string): string {
  const url = new URL(value)
  if (url.origin !== value.replace(/\/$/u, '')) throw new Error(`gateway: ${name} must be a bare origin, got ${value}`)
  return url.origin
}

function secretKey(value: string): string {
  SecretBox.fromEncoded(value)
  return value
}

function frpsConfig(env: NodeJS.ProcessEnv): { frps?: NonNullable<GatewayConfig['frps']> } {
  if (!env.AGENT_WORK_FRPS_ADDR) return {}
  const port = Number(env.AGENT_WORK_FRPS_PORT ?? '443')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('gateway: AGENT_WORK_FRPS_PORT must be a port number')
  const protocol = env.AGENT_WORK_FRPS_PROTOCOL ?? 'wss'
  if (protocol !== 'wss' && protocol !== 'tcp') throw new Error('gateway: AGENT_WORK_FRPS_PROTOCOL must be wss or tcp')
  const pluginSecret = required(env, 'AGENT_WORK_FRP_PLUGIN_SECRET')
  if (pluginSecret.length < 24) throw new Error('gateway: AGENT_WORK_FRP_PLUGIN_SECRET must be at least 24 characters')
  let vhost: { host: string; port: number } | null = null
  if (env.AGENT_WORK_FRPS_VHOST) {
    const url = new URL(env.AGENT_WORK_FRPS_VHOST)
    if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '') throw new Error('gateway: AGENT_WORK_FRPS_VHOST must be http://<host>:<port>')
    vhost = { host: url.hostname, port: Number(url.port || '80') }
  }
  return { frps: { addr: env.AGENT_WORK_FRPS_ADDR, port, protocol, pluginSecret, publicIp: env.AGENT_WORK_TUNNEL_IP || null, vhost } }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env.AGENT_WORK_GATEWAY_PORT ?? '8787')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('gateway: AGENT_WORK_GATEWAY_PORT must be a port number')
  return {
    productName: env.AGENT_WORK_PRODUCT_NAME || 'GL Work',
    publicOrigin: origin(required(env, 'AGENT_WORK_PUBLIC_ORIGIN'), 'AGENT_WORK_PUBLIC_ORIGIN'),
    listenHost: env.AGENT_WORK_GATEWAY_HOST ?? '127.0.0.1',
    listenPort: port,
    trustProxy: env.AGENT_WORK_TRUST_PROXY === '1',
    ...env.AGENT_WORK_CLIENT_IP_HEADER ? { clientIpHeader: env.AGENT_WORK_CLIENT_IP_HEADER.trim().toLowerCase() } : {},
    databasePath: env.AGENT_WORK_DB ?? '/data/gateway.db',
    ...frpsConfig(env),
    ...env.AGENT_WORK_SECRET_KEY === undefined || env.AGENT_WORK_SECRET_KEY === '' ? {} : { secretKey: secretKey(env.AGENT_WORK_SECRET_KEY) },
    ...env.DEEPSEEK_API_KEY === undefined || env.DEEPSEEK_API_KEY === '' ? {} : {
      deepseek: { baseUrl: env.DEEPSEEK_UPSTREAM ?? 'https://api.deepseek.com/anthropic', apiKey: env.DEEPSEEK_API_KEY },
    },
    github: {
      clientId: required(env, 'GITHUB_CLIENT_ID'),
      clientSecret: required(env, 'GITHUB_CLIENT_SECRET'),
      org: env.GITHUB_ORG ?? '',
      webUrl: origin(env.GITHUB_WEB_URL ?? 'https://github.com', 'GITHUB_WEB_URL'),
      apiUrl: origin(env.GITHUB_API_URL ?? 'https://api.github.com', 'GITHUB_API_URL'),
    },
  }
}
