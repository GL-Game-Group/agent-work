/**
 * agent-work-admin: administration from the server's shell
 * (`docker exec <container> node src/cli.ts …` on the cloud server).
 *
 *   member add <name> --github <login> [--admin]
 *   member list
 *   member disable|enable <name>
 *   member role <name> admin|member
 *   devices [<name>]
 *   revoke <credential-id>
 *   audit [<count>]
 *   usage [<days>]
 *
 * With PostgreSQL (DATABASE_URL) it runs beside the service. PGlite's data
 * directory belongs to one process at a time, so there the service must be
 * stopped first, and the command says so with --service-stopped.
 */
import { parseArgs } from 'node:util'
import { loadConfig } from './config.ts'
import { Store, type Role } from './db.ts'
import { GitHub } from './github.ts'
import { openDatabase } from './sql.ts'

function fail(message: string): never {
  console.error(`agent-work-admin: ${message}`)
  process.exit(1)
}

function date(ms: number | null): string {
  // sv-SE renders local time as YYYY-MM-DD HH:MM.
  return ms === null ? '-' : new Date(ms).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
}

function table(rows: string[][]): void {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => (row[column] ?? '').length))) ?? []
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd())
}

async function main(): Promise<void> {
  if (process.env.AGENT_WORK_ENV_FILE !== undefined) process.loadEnvFile(process.env.AGENT_WORK_ENV_FILE)
  const config = loadConfig()
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { 'github': { type: 'string' }, 'admin': { type: 'boolean' }, 'service-stopped': { type: 'boolean' } },
  })
  if (config.databaseUrl === undefined && values['service-stopped'] !== true) {
    fail(`the data is in PGlite (${config.dataDir ?? 'memory'}), which only one process may open: stop the service, then add --service-stopped`)
  }
  const store = await Store.open(await openDatabase(config))
  const audit = async (action: string, target: string, detail: string | null = null): Promise<void> => {
    await store.audit({ actor: `cli:${process.env.SUDO_USER ?? 'root'}`, action, target, detail, ip: null })
  }
  const [group, command, ...rest] = positionals

  try {
    // Single-word commands take their argument in the second position.
    const route = group === 'member' ? `member ${command ?? ''}` : group ?? ''
    switch (route) {
      case 'member add': {
        const name = rest[0] ?? fail('usage: member add <name> --github <login> [--admin]')
        const login = values.github ?? fail('--github <login> is required')
        if (login.includes('@')) fail('--github takes the GitHub username (github.com/<username>), not an email address')
        const user = await new GitHub(config.github).lookup(login)
        const holder = await store.memberByGithubId(user.id)
        if (holder !== undefined) fail(`GitHub account ${user.login} already belongs to member ${holder.name}`)
        if (await store.member(name) !== undefined) fail(`member ${name} already exists`)
        const role: Role = values.admin === true ? 'admin' : 'member'
        await store.addMember({ name, githubId: user.id, githubLogin: user.login, role })
        await audit('member-add', name, `github ${user.login} (${String(user.id)}), ${role}`)
        console.log(`${name}: GitHub ${user.login} (${String(user.id)}), ${role}. Sign in from the desktop app with that GitHub account.`)
        return
      }
      case 'member list': {
        const rows = [['NAME', 'GITHUB', 'ROLE', 'STATUS', 'CREATED']]
        for (const member of await store.listMembers()) rows.push([member.name, member.githubLogin, member.role, member.status, date(member.createdAt)])
        table(rows)
        return
      }
      case 'member disable':
      case 'member enable': {
        const name = rest[0] ?? fail(`usage: member ${command ?? ''} <name>`)
        const disable = command === 'disable'
        await store.setStatus(name, disable ? 'disabled' : 'active')
        await audit(`member-${command ?? ''}`, name)
        console.log(disable ? `${name} disabled and signed out everywhere` : `${name} enabled`)
        return
      }
      case 'member role': {
        const [name, role] = rest
        if (name === undefined || (role !== 'admin' && role !== 'member')) fail('usage: member role <name> admin|member')
        await store.setRole(name, role)
        await audit('member-role', name, role)
        console.log(`${name} is now ${role}`)
        return
      }
      case 'devices': {
        const rows = [['ID', 'MEMBER', 'KIND', 'LABEL', 'CREATED', 'LAST USED', 'EXPIRES']]
        for (const c of await store.listCredentials(rest[0] ?? command)) {
          rows.push([c.id, c.member, c.kind, c.label.slice(0, 40), date(c.createdAt), date(c.lastUsedAt), date(c.expiresAt)])
        }
        table(rows)
        return
      }
      case 'revoke': {
        const id = command ?? fail('usage: revoke <credential-id>')
        if (!await store.revokeCredential(id)) fail(`no active credential ${id}`)
        await audit('credential-revoke', id)
        console.log(`${id} revoked`)
        return
      }
      case 'usage': {
        const days = Number(command ?? '30')
        const rows = [['MEMBER', 'REQUESTS', 'INPUT', 'OUTPUT', 'CACHE READ', 'CACHE WRITE']]
        for (const u of await store.usageSince(Date.now() - days * 24 * 60 * 60 * 1000)) {
          rows.push([u.member, String(u.requests), String(u.inputTokens), String(u.outputTokens), String(u.cacheReadTokens), String(u.cacheWriteTokens)])
        }
        console.log(`model usage, last ${String(days)} days`)
        table(rows)
        return
      }
      case 'audit': {
        const rows = [['AT', 'ACTOR', 'ACTION', 'TARGET', 'DETAIL', 'IP']]
        for (const e of (await store.recentAudit(Number(command ?? '50'))).reverse()) {
          rows.push([date(e.at), e.actor ?? '-', e.action, e.target ?? '-', (e.detail ?? '-').slice(0, 60), e.ip ?? '-'])
        }
        table(rows)
        return
      }
      default:
        fail('unknown command; see the header of gateway/src/cli.ts')
    }
  } finally {
    await store.close()
  }
}

main().catch((error: unknown) => { fail(error instanceof Error ? error.message : String(error)) })
