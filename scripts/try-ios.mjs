/**
 * Try GL Work for iOS on a phone without TestFlight: build the debug app,
 * sign it with the Xcode account (development profile, created as needed),
 * install it on the phone over the cable and open it. The phone keeps its
 * sign-in, since it is the same app (com.glgwork.work).
 *
 *   pnpm try:ios                    # the one connected iPhone
 *   pnpm try:ios --device <name|id> # pick one when several are connected
 *
 * macOS only. Needs an Xcode that supports the phone's iOS version, the phone
 * registered in the developer account, and Developer Mode on.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, fail } from './lib.mjs'

const BUNDLE_ID = 'com.glgwork.work'
const DERIVED = join(ROOT, 'build', 'ios')

const args = process.argv.slice(2)
let wanted
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device' && args[i + 1]) wanted = args[++i]
  else fail(`try:ios: unknown option ${args[i]}`)
}
if (process.platform !== 'darwin') fail('try:ios: macOS only')

/** @param {string} command @param {string[]} argv */
function run(command, argv) {
  execFileSync(command, argv, { cwd: ROOT, stdio: 'inherit' })
}

/** Physical iPhones that devicectl can reach now. */
function phones() {
  const file = join(DERIVED, 'devices.json')
  execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', file], { stdio: 'ignore' })
  const { result } = JSON.parse(readFileSync(file, 'utf8'))
  rmSync(file)
  return result.devices
    .filter(d => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties?.platform === 'iOS')
    .filter(d => d.connectionProperties?.tunnelState !== 'unavailable')
    .map(d => ({ id: d.hardwareProperties.udid, name: d.deviceProperties.name, coreId: d.identifier }))
}

execFileSync('mkdir', ['-p', DERIVED])
const found = phones()
const picked = wanted ? found.filter(d => d.name === wanted || d.id === wanted || d.coreId === wanted) : found
if (picked.length === 0) fail(wanted ? `try:ios: no connected iPhone named or with id ${wanted}` : 'try:ios: no iPhone connected; plug it in, unlock it and trust this Mac')
if (picked.length > 1) fail(`try:ios: several iPhones connected, pick one with --device:\n${picked.map(d => `  ${d.name}  ${d.id}`).join('\n')}`)
const phone = picked[0]
console.log(`try:ios: building for ${phone.name}`)

run('xcodebuild', [
  '-project', 'mobile/ios/GLWork.xcodeproj', '-scheme', 'GLWork', '-configuration', 'Debug',
  '-destination', `id=${phone.id}`, '-derivedDataPath', DERIVED, '-allowProvisioningUpdates', '-quiet', 'build',
])
run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', phone.id, join(DERIVED, 'Build', 'Products', 'Debug-iphoneos', 'GLWork.app')])
run('xcrun', ['devicectl', 'device', 'process', 'launch', '--terminate-existing', '--device', phone.id, BUNDLE_ID])
console.log(`try:ios: GL Work is open on ${phone.name}`)
