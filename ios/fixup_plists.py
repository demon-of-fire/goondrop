#!/usr/bin/env python3
"""Inject keys that Xcode's builtin-infoPlistUtility drops from archived
Info.plists.

Xcode 15.4 `xcodebuild archive` produces binary Info.plists for the app and
its share extension that only contain derived/default keys - author-written
keys such as NSExtension, NSAppTransportSecurity and usage descriptions are
missing. This script deep-merges every key from the committed source
Info.plists back into the packaged product bundles before the IPA is zipped.

Usage:
    python3 fixup_plists.py <built.plist> <source.plist> [...]

It exits non-zero if the ShareExtension bundle still lacks the NSExtension
dictionary, so CI fails loudly instead of shipping a broken extension.
"""
import plistlib
import os
import sys

SUBSTITUTIONS = {
    "$(PRODUCT_MODULE_NAME)": "ShareExtension",
    "$(EXECUTABLE_NAME)": "ShareExtension",
    "$(PRODUCT_NAME)": "ShareExtension",
    "$(PRODUCT_BUNDLE_IDENTIFIER)": "com.goondrop.ios.ShareExtension",
    "$(DEVELOPMENT_LANGUAGE)": "en",
}


def describe(path):
    if not os.path.exists(path):
        return "MISSING"
    with open(path, "rb") as handle:
        data = handle.read()
    if not data:
        return "EMPTY (0 bytes)"
    try:
        keys = sorted(plistlib.loads(data).keys())
    except Exception as exc:  # noqa: BLE001 - diagnostics
        return f"UNREADABLE ({exc.__class__.__name__}: {exc})"
    return f"{len(data)} bytes, keys={keys}"


def expand(value):
    if isinstance(value, str):
        for key, replacement in SUBSTITUTIONS.items():
            value = value.replace(key, replacement)
        return value
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        return {key: expand(val) for key, val in value.items()}
    return value


def deep_merge(destination, source):
    added = 0
    for key, value in source.items():
        if key not in destination:
            destination[key] = expand(value)
            added += 1
        elif isinstance(value, dict) and isinstance(destination[key], dict):
            added += deep_merge(destination[key], value)
    return added


def main():
    argv = sys.argv[1:]
    pairs = [(argv[i], argv[i + 1]) for i in range(0, len(argv), 2)]

    saw_extension = False
    ok = True
    for built_path, source_path in pairs:
        print(f"FIXUP  {built_path}")
        print(f"  built  {describe(built_path)}")
        print(f"  source {describe(source_path)}")
        with open(built_path, "rb") as handle:
            built = plistlib.load(handle)
        with open(source_path, "rb") as handle:
            source = plistlib.load(handle)
        added = deep_merge(built, source)
        with open(built_path, "wb") as handle:
            plistlib.dump(built, handle)
        has_extension = "NSExtension" in built
        if "appex" in built_path.lower():
            saw_extension = True
            if not has_extension:
                print("ERROR: ShareExtension.appex still missing NSExtension after merge", file=sys.stderr)
                ok = False
        print(f"merged {added} missing keys into {built_path} (NSExtension={has_extension})")

    if not saw_extension:
        print("WARNING: no ShareExtension.appex plist was processed", file=sys.stderr)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()