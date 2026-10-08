/** The iPhones connected to this Mac, for the try:ios scripts. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './lib.mjs'

/** @param {string} scratch a directory for devicectl's JSON output */
function phones(scratch) {
  mkdirSync(scratch, { recursive: true })
  const file = join(scratch, 'devices.json')
  execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', file], { stdio: 'ignore' })
  const { result } = JSON.parse(readFileSync(file, 'utf8'))
  rmSync(file)
  return result.devices
    .filter(d => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties?.platform === 'iOS')
    .filter(d => d.connectionProperties?.tunnelState !== 'unavailable')
    .map(d => ({ id: d.hardwareProperties.udid, name: d.deviceProperties.name, coreId: d.identifier }))
}

/**
 * The one connected iPhone, or the one named by --device; fails with a hint otherwise.
 * @param {string} script the script's name for messages
 * @param {string} scratch
 * @param {string | undefined} wanted a name, UDID or devicectl id
 */
export function pickPhone(script, scratch, wanted) {
  const found = phones(scratch)
  const picked = wanted ? found.filter(d => d.name === wanted || d.id === wanted || d.coreId === wanted) : found
  if (picked.length === 0) fail(wanted ? `${script}: no connected iPhone named or with id ${wanted}` : `${script}: no iPhone connected; plug it in, unlock it and trust this Mac`)
  if (picked.length > 1) fail(`${script}: several iPhones connected, pick one with --device:\n${picked.map(d => `  ${d.name}  ${d.id}`).join('\n')}`)
  return picked[0]
}

/**
 * Install an app on the phone and open it (iOS opens apps only on an unlocked phone).
 * @param {string} script @param {{ id: string, name: string }} phone @param {string} app @param {string} bundleId
 */
export function installAndOpen(script, phone, app, bundleId) {
  execFileSync('xcrun', ['devicectl', 'device', 'install', 'app', '--device', phone.id, app], { stdio: 'inherit' })
  try {
    execFileSync('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', phone.id, bundleId], { stdio: 'pipe' })
    console.log(`${script}: GL Work is open on ${phone.name}`)
  } catch {
    console.log(`${script}: installed on ${phone.name}; unlock the phone and open GL Work`)
  }
}
