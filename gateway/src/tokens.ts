/** Random secrets and their stored digests. Plain secrets never reach the database. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes as base64url, optionally prefixed so a leaked token is recognizable. */
export function randomSecret(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url')
}

/** Hex SHA-256: the lookup key stored in place of a secret. */
export function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** RFC 7636 S256 code challenge of a PKCE verifier. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Constant-time string comparison. */
export function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
