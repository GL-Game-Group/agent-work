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
import { join } from 'node:path'
import { installAndOpen, pickPhone } from './ios-devices.mjs'
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

const phone = pickPhone('try:ios', DERIVED, wanted)
console.log(`try:ios: building for ${phone.name}`)

run('xcodebuild', [
  '-project', 'mobile/ios/GLWork.xcodeproj', '-scheme', 'GLWork', '-configuration', 'Debug',
  '-destination', `id=${phone.id}`, '-derivedDataPath', DERIVED, '-allowProvisioningUpdates', '-quiet', 'build',
])
installAndOpen('try:ios', phone, join(DERIVED, 'Build', 'Products', 'Debug-iphoneos', 'GLWork.app'), BUNDLE_ID)
