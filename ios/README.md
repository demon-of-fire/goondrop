# Goon Drop for iOS (SwiftUI + Share Sheet Extension)

Native iOS client and AirDrop-like Share Sheet extension for Goon Drop.

## Features
- **Native iOS Share Sheet Extension** (Only 1 extension to ensure AltStore/SideStore compatibility):
  - Share Photos, Videos, Documents, PDFs directly from any app (Photos, Files) to your Windows PC `Downloads\GoonDrop`.
  - Share URLs from Safari, Chrome, YouTube directly to your PC browser (`/api/handoff`).
  - Share copied text to your PC clipboard (`/api/clipboard`).
- **Main App**:
  - Embedded Goon Drop Continuity dashboard.
  - PC server IP configuration and connection health check.
  - Quick action buttons for sending photos, files, and clipboard sync.
- **LAN Trust**:
  - Built-in support for Goon Drop's local self-signed SSL certificates.

## Sideloading via AltStore / SideStore / TrollStore / Sideloadly
1. Download `GoonDrop.ipa`.
2. Open AltStore / SideStore / Sideloadly on your device or computer.
3. Select `GoonDrop.ipa`.
4. AltStore will sign both `GoonDrop` and `ShareExtension` (2 App IDs total, within the 3-App-ID free account limit).
5. Open Goon Drop on your iPhone, enter your PC's Wi-Fi IP address (shown in the Windows launcher, e.g. `192.168.1.50:3942`), and tap Save.
6. Now go to Photos or Safari, tap Share, and select **Goon Drop**!
