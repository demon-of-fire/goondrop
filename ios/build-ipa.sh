#!/usr/bin/env bash
set -e

echo "==> Building Goon Drop iOS App and Share Extension..."

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

ARCHIVE_PATH="$PROJECT_DIR/build/GoonDrop.xcarchive"
IPA_DIR="$PROJECT_DIR/build/ipa"
PAYLOAD_DIR="$IPA_DIR/Payload"

rm -rf "$PROJECT_DIR/build"
mkdir -p "$PAYLOAD_DIR"

echo "==> Running xcodebuild archive..."
xcodebuild archive \
  -project GoonDrop.xcodeproj \
  -scheme GoonDrop \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO

echo "==> Packaging into IPA..."
cp -r "$ARCHIVE_PATH/Products/Applications/GoonDrop.app" "$PAYLOAD_DIR/"

# Remove existing code signature directory so AltStore / SideStore can sign cleanly
rm -rf "$PAYLOAD_DIR/GoonDrop.app/_CodeSignature"
if [ -d "$PAYLOAD_DIR/GoonDrop.app/PlugIns/ShareExtension.appex" ]; then
  rm -rf "$PAYLOAD_DIR/GoonDrop.app/PlugIns/ShareExtension.appex/_CodeSignature"
  echo "==> Verified ShareExtension.appex is embedded inside GoonDrop.app/PlugIns"
fi

cd "$IPA_DIR"
zip -qr "$PROJECT_DIR/GoonDrop.ipa" Payload

echo "==> ✅ Successfully created GoonDrop.ipa at $PROJECT_DIR/GoonDrop.ipa"
