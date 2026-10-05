/** The client's address for audit and rate limits, behind Traefik and, optionally, Cloudflare. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clientAddress } from '../src/server.ts'

describe('client address', () => {
  it('takes the edge header only when configured and holding one address', () => {
    const behindCloudflare = { trustProxy: true, clientIpHeader: 'cf-connecting-ip' }
    assert.equal(clientAddress(behindCloudflare, '198.51.100.1, 172.18.0.1', '172.18.0.5', '203.0.113.9'), '203.0.113.9')
    assert.equal(clientAddress(behindCloudflare, '198.51.100.1, 172.18.0.1', '172.18.0.5', '2001:db8::1'), '2001:db8::1')
    // Not an address (or a list someone forged): fall back to what Traefik saw.
    assert.equal(clientAddress(behindCloudflare, '198.51.100.1, 172.18.0.1', '172.18.0.5', '203.0.113.9, 10.0.0.1'), '172.18.0.1')
    assert.equal(clientAddress(behindCloudflare, '172.18.0.1', '172.18.0.5', 'evil'), '172.18.0.1')
    assert.equal(clientAddress(behindCloudflare, '172.18.0.1', '172.18.0.5', undefined), '172.18.0.1')
  })

  it('ignores the header when the deployment does not name it', () => {
    assert.equal(clientAddress({ trustProxy: true }, '172.18.0.1', '172.18.0.5', '203.0.113.9'), '172.18.0.1')
    assert.equal(clientAddress({ trustProxy: false }, '198.51.100.1', '127.0.0.1', '203.0.113.9'), '127.0.0.1')
  })
})
