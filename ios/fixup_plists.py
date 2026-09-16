#!/usr/bin/env python3
"""Guarantee the packaged GoonDrop.app / ShareExtension.appex carry the
author-written Info.plist keys.

`xcodegen generate` (project.yml `info.path`) can replace committed
Info.plist files with generated 8-key defaults, so `builtin-infoPlistUtility`
produces bundles lacking NSExtension, ATS, usage descriptions, etc. rather than
relying on the (possibly clobbered) source files this script embeds the
canonical keys and deep-merges them into the bundle plists before the IPA is
zipped.

Usage:
    python3 fixup_plists.py <built.plist> <role1=app|role2=appex> [...]

Exits non-zero if the ShareExtension bundle still lacks the NSExtension
dictionary after the merge.
"""
import plistlib
import sys

APP_KEYS = {
    "CFBundleDisplayName": "Goon Drop",
    "LSRequiresIPhoneOS": True,
    "NSAppTransportSecurity": {
        "NSAllowsArbitraryLoads": True,
        "NSAllowsLocalNetworking": True,
    },
    "NSBonjourServices": ["_http._tcp", "_https._tcp"],
    "NSCameraUsageDescription": (
        "Goon Drop needs camera access to scan pairing QR codes from your PC."
    ),
    "NSLocalNetworkUsageDescription": (
        "Goon Drop connects to your Windows PC over local Wi-Fi for seamless "
        "file transfers, clipboard sync, and link handoff."
    ),
    "NSPhotoLibraryUsageDescription": (
        "Goon Drop needs access to photos to share them directly with your PC."
    ),
    "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False},
    "UILaunchScreen": {},
    "UISupportedInterfaceOrientations": [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
    ],
}

EXTENSION_KEYS = {
    "CFBundleDisplayName": "Goon Drop",
    "NSAppTransportSecurity": {
        "NSAllowsArbitraryLoads": True,
        "NSAllowsLocalNetworking": True,
    },
    "NSLocalNetworkUsageDescription": (
        "Goon Drop needs local network access to send shared items directly to "
        "your Windows PC over Wi-Fi."
    ),
    "NSExtension": {
        "NSExtensionAttributes": {
            "NSExtensionActivationRule": (
                'SUBQUERY ( extensionItems, $extensionItem, SUBQUERY ( '
                '$extensionItem.attachments, $attachment, ANY '
                '$attachment.registeredTypeIdentifiers UTI-CONFORMS-TO '
                '"public.data" || ANY $attachment.registeredTypeIdentifiers '
                'UTI-CONFORMS-TO "public.image" || ANY '
                '$attachment.registeredTypeIdentifiers UTI-CONFORMS-TO '
                '"public.movie" || ANY $attachment.registeredTypeIdentifiers '
                'UTI-CONFORMS-TO "public.url" || ANY '
                '$attachment.registeredTypeIdentifiers UTI-CONFORMS-TO '
                '"public.plain-text" ).@count > 0 ).@count > 0'
            ),
        },
        "NSExtensionPointIdentifier": "com.apple.share-services",
        "NSExtensionPrincipalClass": "ShareExtension.ShareViewController",
    },
}


def deep_merge(destination, source):
    added = 0
    for key, value in source.items():
        if key not in destination:
            destination[key] = value
            added += 1
        elif isinstance(value, dict) and isinstance(destination[key], dict):
            added += deep_merge(destination[key], value)
    return added


def main():
    argv = sys.argv[1:]
    pairs = [(argv[i], argv[i + 1]) for i in range(0, len(argv), 2)]

    ok = True
    saw_extension = False
    for built_path, role in pairs:
        canonical = EXTENSION_KEYS if role == "appex" else APP_KEYS
        with open(built_path, "rb") as handle:
            built = plistlib.load(handle)
        added = deep_merge(built, canonical)
        has_extension = "NSExtension" in built
        if role == "appex":
            saw_extension = True
            if not has_extension:
                print(f"ERROR: {built_path} missing NSExtension after merge", file=sys.stderr)
                ok = False
        with open(built_path, "wb") as handle:
            plistlib.dump(built, handle)
        print(f"fixup {built_path} (role={role}): merged {added} keys, NSExtension={has_extension}")

    if not saw_extension:
        print("WARNING: no appex plist processed", file=sys.stderr)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()