import Foundation

/// Wire-compatible reimplementation of the web app's Goon Drop E2EE text cipher
/// (`frontend/src/utils/crypto.ts`).
///
/// The scheme is a repeating-key XOR over UTF-16 code units, base64 wrapped in a
/// `goondrop-e2ee:` tag. The native iOS app has to speak exactly the same dialect
/// or the phone and the browser will show each other ciphertext.
///
/// Two behaviours are deliberately preserved from the JavaScript original:
/// * an empty passcode means "no encryption" and the text passes straight through;
/// * a mismatch yields a readable lock marker instead of throwing, so a wrong
///   passcode degrades into an obvious warning rather than silent garbage.
enum E2EECipher {
    static let tag = "goondrop-e2ee:"
    static let lockedPlaceholder = "[🔐 Encrypted Goon Drop Payload - Passcode Required]"
    static let mismatchPlaceholder = "[🔐 Encrypted Goon Drop Payload - Passcode Mismatch]"

    static func encrypt(_ text: String, key: String) -> String {
        guard !key.isEmpty, !text.isEmpty else { return text }

        let plain = Array(text.utf16)
        let passcode = Array(key.utf16)
        guard !passcode.isEmpty else { return text }

        var ciphered = [UInt16]()
        ciphered.reserveCapacity(plain.count)
        for (index, unit) in plain.enumerated() {
            ciphered.append(unit ^ passcode[index % passcode.count])
        }

        // JavaScript strings are UTF-16 code-unit sequences and happily contain
        // lone surrogates, which `encodeURIComponent` then rejects — the original
        // catches that and returns the plaintext untouched. Swift cannot build a
        // String containing lone surrogates at all, so detect the same case up
        // front and mirror the fallback.
        guard !containsLoneSurrogate(ciphered) else { return text }

        let cipheredString = String(decoding: ciphered, as: UTF16.self)
        guard let data = cipheredString.data(using: .utf8) else { return text }
        return tag + data.base64EncodedString()
    }

    static func decrypt(_ cipherText: String, key: String) -> String {
        guard !cipherText.isEmpty else { return cipherText }
        guard cipherText.hasPrefix(tag) else { return cipherText }
        guard !key.isEmpty else { return lockedPlaceholder }

        let encoded = String(cipherText.dropFirst(tag.count))
        guard let data = Data(base64Encoded: encoded),
              let cipheredString = String(data: data, encoding: .utf8) else {
            return mismatchPlaceholder
        }

        let ciphered = Array(cipheredString.utf16)
        let passcode = Array(key.utf16)
        var plain = [UInt16]()
        plain.reserveCapacity(ciphered.count)
        for (index, unit) in ciphered.enumerated() {
            plain.append(unit ^ passcode[index % passcode.count])
        }
        guard !containsLoneSurrogate(plain) else { return mismatchPlaceholder }

        return String(decoding: plain, as: UTF16.self)
    }

    /// True when the code-unit run contains a surrogate that is not part of a
    /// well-formed pair, which cannot round-trip through UTF-8.
    private static func containsLoneSurrogate(_ units: [UInt16]) -> Bool {
        var index = 0
        while index < units.count {
            let unit = units[index]
            if unit >= 0xD800 && unit <= 0xDBFF {
                guard index + 1 < units.count else { return true }
                let next = units[index + 1]
                guard next >= 0xDC00 && next <= 0xDFFF else { return true }
                index += 2
                continue
            }
            if unit >= 0xDC00 && unit <= 0xDFFF { return true }
            index += 1
        }
        return false
    }
}
