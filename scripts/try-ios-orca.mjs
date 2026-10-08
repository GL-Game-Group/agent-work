/**
 * Try GL Work on Orca's phone app (orca/mobile, built with EXPO_PUBLIC_GLWORK_BUILD=1) on a phone without
 * TestFlight: generate the iOS project, build the Release app (its JavaScript inside, no Metro),
 * sign it with the Xcode account (development profile, created as needed), install it over the
 * cable and open it. It is com.glgwork.work, so it replaces the native GL Work for iOS
 * (mobile/ios) on that phone.
 *
 *   pnpm try:ios:orca                    # the one connected iPhone
 *   pnpm try:ios:orca --device <name|id> # pick one when several are connected
 *   pnpm try:ios:orca --skip-prebuild    # reuse orca/mobile/ios as generated last time
 *
 * macOS only; needs CocoaPods (brew install cocoapods), an Xcode that supports the phone's iOS
 * version, the phone registered in the developer account, and Developer Mode on.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installAndOpen, pickPhone } from './ios-devices.mjs'
import { ROOT, fail } from './lib.mjs'

const BUNDLE_ID = 'com.glgwork.work'
const MOBILE = join(ROOT, 'orca', 'mobile')
const DERIVED = join(ROOT, 'build', 'ios-orca')

const args = process.argv.slice(2)
let wanted
let prebuild = true
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device' && args[i + 1]) wanted = args[++i]
  else if (args[i] === '--skip-prebuild') prebuild = false
  else fail(`try:ios:orca: unknown option ${args[i]}`)
}
if (process.platform !== 'darwin') fail('try:ios:orca: macOS only')

// The signing team the native app uses, so both are signed the same way.
const team = /DEVELOPMENT_TEAM = (\w+);/u.exec(readFileSync(join(ROOT, 'mobile', 'ios', 'GLWork.xcodeproj', 'project.pbxproj'), 'utf8'))?.[1]
if (!team) fail('try:ios:orca: no DEVELOPMENT_TEAM in mobile/ios/GLWork.xcodeproj')

const phone = pickPhone('try:ios:orca', DERIVED, wanted)
const env = { ...process.env, EXPO_PUBLIC_GLWORK_BUILD: '1', CI: '1', EXPO_NO_TELEMETRY: '1' }
if (prebuild) {
  console.log('try:ios:orca: generating the iOS project (EXPO_PUBLIC_GLWORK_BUILD=1)')
  execFileSync('npx', ['expo', 'prebuild', '--platform', 'ios', '--clean'], { cwd: MOBILE, env, stdio: 'inherit' })
}
console.log(`try:ios:orca: building for ${phone.name}`)
execFileSync('xcodebuild', [
  '-workspace', 'ios/GLWork.xcworkspace', '-scheme', 'GLWork', '-configuration', 'Release',
  '-destination', `id=${phone.id}`, '-derivedDataPath', DERIVED, '-allowProvisioningUpdates', '-quiet',
  `DEVELOPMENT_TEAM=${team}`, 'CODE_SIGN_STYLE=Automatic',
  // Why: Xcode 27 rejects deployment targets below iOS 15, which some pods still declare.
  'IPHONEOS_DEPLOYMENT_TARGET=17.0',
  'build',
], { cwd: MOBILE, env, stdio: 'inherit' })
installAndOpen('try:ios:orca', phone, join(DERIVED, 'Build', 'Products', 'Release-iphoneos', 'GLWork.app'), BUNDLE_ID)
