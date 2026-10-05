#!/bin/sh
# Archive GL Work for iOS and upload it to TestFlight (internal testing only).
# Uses the App Store Connect API key the desktop notarization uses
# (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER in overlay/apps/desktop/.env.macos);
# Xcode signs with a cloud-managed distribution certificate, so none needs installing.
#
#   mobile/ios/testflight.sh            # build number = UTC timestamp
set -eu
cd "$(dirname "$0")"
ENV_FILE=../../overlay/apps/desktop/.env.macos
read_env() { sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$ENV_FILE" | tail -1; }
KEY=$(read_env APPLE_API_KEY); KEY_ID=$(read_env APPLE_API_KEY_ID); ISSUER=$(read_env APPLE_API_ISSUER)
[ -n "$KEY" ] && [ -n "$KEY_ID" ] && [ -n "$ISSUER" ] || { echo "testflight: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER in $ENV_FILE" >&2; exit 1; }
case "$KEY" in /*) ;; *) KEY="$(cd "$(dirname "$ENV_FILE")" && pwd)/$KEY" ;; esac
BUILD=$(date -u +%Y%m%d%H%M)
OUT=${TMPDIR:-/tmp}/glwork-ios-$BUILD
AUTH="-allowProvisioningUpdates -authenticationKeyPath $KEY -authenticationKeyID $KEY_ID -authenticationKeyIssuerID $ISSUER"
# shellcheck disable=SC2086
xcodebuild -project GLWork.xcodeproj -scheme GLWork -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/GLWork.xcarchive" CURRENT_PROJECT_VERSION="$BUILD" $AUTH archive
# shellcheck disable=SC2086
xcodebuild -exportArchive -archivePath "$OUT/GLWork.xcarchive" -exportOptionsPlist ExportOptions.plist -exportPath "$OUT/export" $AUTH
echo "testflight: uploaded build $BUILD; it appears in App Store Connect → TestFlight after processing (about 10–30 minutes)."
