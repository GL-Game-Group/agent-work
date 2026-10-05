/**
 * GitHub OAuth App sign-in. The access token is used once to read the user's
 * identity (and organization membership) and is then discarded.
 */
import type { GitHubConfig } from './config.ts'

export interface GitHubUser {
  id: number
  login: string
}

export class GitHub {
  private readonly config: GitHubConfig
  private readonly request: typeof fetch

  constructor(config: GitHubConfig, request: typeof fetch = fetch) {
    this.config = config
    this.request = request
  }

  /** Authorization page; `read:org` only when membership must be checked. */
  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL('/login/oauth/authorize', this.config.webUrl)
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    url.searchParams.set('scope', this.config.org === '' ? '' : 'read:org')
    url.searchParams.set('allow_signup', 'false')
    return url.href
  }

  /**
   * Exchange the callback code and read who signed in.
   * @returns the user, and whether they are an active member of the configured organization
   *   (always true when no organization is configured).
   */
  async signIn(code: string, redirectUri: string): Promise<{ user: GitHubUser; inOrg: boolean }> {
    const tokenResponse = await this.request(new URL('/login/oauth/access_token', this.config.webUrl), {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: redirectUri }),
    })
    const token = (await tokenResponse.json() as { access_token?: unknown }).access_token
    if (!tokenResponse.ok || typeof token !== 'string') throw new Error('GitHub rejected the authorization code')
    const user = await this.user(token)
    return { user, inOrg: this.config.org === '' || await this.isOrgMember(token) }
  }

  /** Public profile lookup by login, used when an administrator adds a member. */
  async lookup(login: string): Promise<GitHubUser> {
    const response = await this.request(new URL(`/users/${encodeURIComponent(login)}`, this.config.apiUrl), { headers: this.headers() })
    if (response.status === 404) throw new Error(`GitHub user ${login} does not exist`)
    return this.parseUser(response)
  }

  private async user(token: string): Promise<GitHubUser> {
    return this.parseUser(await this.request(new URL('/user', this.config.apiUrl), { headers: this.headers(token) }))
  }

  private async isOrgMember(token: string): Promise<boolean> {
    const response = await this.request(new URL(`/user/memberships/orgs/${encodeURIComponent(this.config.org)}`, this.config.apiUrl), { headers: this.headers(token) })
    if (!response.ok) return false
    return (await response.json() as { state?: unknown }).state === 'active'
  }

  private async parseUser(response: Response): Promise<GitHubUser> {
    if (!response.ok) throw new Error(`GitHub API answered ${String(response.status)}`)
    const body = await response.json() as { id?: unknown; login?: unknown }
    if (typeof body.id !== 'number' || typeof body.login !== 'string') throw new Error('GitHub API returned an unexpected user')
    return { id: body.id, login: body.login }
  }

  private headers(token?: string): Record<string, string> {
    return {
      'accept': 'application/vnd.github+json',
      'user-agent': 'agent-work-gateway',
      'x-github-api-version': '2022-11-28',
      ...token === undefined ? {} : { authorization: `Bearer ${token}` },
    }
  }
}
