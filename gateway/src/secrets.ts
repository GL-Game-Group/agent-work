/**
 * Encryption at rest for vendor API keys and secret public config values:
 * AES-256-GCM under the master key in AGENT_WORK_SECRET_KEY (32 bytes,
 * base64 or hex; `openssl rand -base64 32`). Losing the master key makes the
 * stored secrets unreadable, so back it up with the database.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'

export class SecretBox {
  private readonly key: Buffer

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('gateway: AGENT_WORK_SECRET_KEY must be 32 bytes (base64 or hex)')
    this.key = key
  }

  /** @param encoded - 32 bytes as base64 or 64 hex digits. */
  static fromEncoded(encoded: string): SecretBox {
    const value = encoded.trim()
    return new SecretBox(/^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64'))
  }

  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':')
  }

  /** @throws when the value was sealed under another key or altered. */
  open(sealed: string): string {
    const [version, iv, tag, body] = sealed.split(':')
    if (version !== VERSION || iv === undefined || tag === undefined || body === undefined) throw new Error('gateway: unknown secret format')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  }
}
