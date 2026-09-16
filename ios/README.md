# Goon Drop for iOS (Native SwiftUI + Share Sheet Extension)

Native iOS client and AirDrop-like Share Sheet extension for Goon Drop — a fully
local, zero-cloud continuity ecosystem between your Windows PC and iPhone.

## Your 2 App IDs (all you need)

| Bundle ID                       | Type            |
|---------------------------------|-----------------|
| `com.goondrop.ios`              | Main app        |
| `com.goondrop.ios.ShareExtension` | Share extension |

No App Group (or any other capability) is used, specifically so the app signs and
installs cleanly on free Apple IDs via SideStore / AltStore — app groups cannot be
provisioned on free accounts. Any other App IDs listed under "used" are leftovers
from old experiments — delete them at developer.apple.com/account/resources/identifiers.

## Main App (native, no WebView)

Built with SwiftUI — no web view wrapper. Four tabs:

- **Devices** — taps **"Scan Wi-Fi Network"** to find your PC automatically. The PC
  broadcasts itself on UDP port 3943; tap the found PC and it connects + pairs in
  one step. No website, no QR code, no typing IPs. Shows the live device list and
  pairing code once connected.
- **Send** — drop photos, files, clipboard text, and links straight onto the PC.
- **Clipboard** — real-time shared clipboard history; tap an item to copy it.
- **Handoff** — links relayed from your PC browser; tap to open on your iPhone,
  or push a URL back to the PC.

### How discovery + pairing works

1. The app broadcasts `goondrop_discover` on UDP 3943.
2. The PC backend replies `{ ip, port, pairingCode, serverName }`.
3. The app connects over `wss://` (trusts the PC's local self-signed certificate)
   and pairs automatically with the returned pairing code.

Manual fallback: Settings → Manual server.

## Share Sheet Extension (1 extension)

From **any** app's share sheet, choose **Goon Drop**:

- Photos / videos / documents / PDFs → dropped onto the PC
  (`Downloads\GoonDrop` on the PC).
- URLs → opened in the PC's browser (`/api/handoff`).
- Copied text → written to the PC clipboard (`/api/clipboard`).

Share settings live in a shared App Group when you build from Xcode, so picking a
PC in the app points the share sheet at it automatically. On a free-account
sideload (no App Group), the extension simply **discovers your PC itself** via the
UDP broadcast whenever you share — no prior pairing needed.

## Sideloading via AltStore / SideStore / Sideloadly

1. Download `GoonDrop.ipa` from the latest GitHub Actions build.
2. Open AltStore / SideStore / Sideloadly and sign `GoonDrop.ipa`.
3. AltStore / SideStore / Sideloadly sign both `GoonDrop` and `ShareExtension`.
   When SideStore pops **"App Contains Extensions"**, choose **"Keep App
   Extensions"** — this keeps the share sheet instead of stripping it.
4. Open Goon Drop, tap **Scan Wi-Fi**, and connect to your PC. Then share anything
   from Photos, Safari, or Files via the Goon Drop share sheet.

## Building

The GitHub Actions workflow (`build-ipa.yml`) regenerates the Xcode project with
[xcodegen](https://github.com/yonaskolb/XcodeGen) from `project.yml`, archives both
targets, and uploads an unsigned, sideload-ready IPA. Trigger it with "Run
workflow" on GitHub, and the IPA appears in the workflow's artifacts.