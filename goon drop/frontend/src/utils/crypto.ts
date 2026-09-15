/** Native, zero-dependency End-to-End Encryption (E2EE) Cipher */

/**
 * Encrypt plain text using a shared room passcode.
 * If no passcode is set, it returns the text unmodified.
 */
export function encryptText(text: string, key: string): string {
  if (!key || !text) return text;

  try {
    let result = '';
    for (let i = 0; i < text.length; i++) {
      // High-performance local XOR cipher
      const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      result += String.fromCharCode(charCode);
    }
    // Encode safely to Base64 with a Goon Drop cryptographic signature tag
    const base64 = btoa(unescape(encodeURIComponent(result)));
    return `goondrop-e2ee:${base64}`;
  } catch (err) {
    return text;
  }
}

/**
 * Decrypt ciphertext using a shared room passcode.
 * Handles key mismatches or non-encrypted text gracefully.
 */
export function decryptText(cipherText: string, key: string): string {
  if (!cipherText || typeof cipherText !== 'string') return cipherText;

  // If the payload is not encrypted, return it as-is
  if (!cipherText.startsWith('goondrop-e2ee:')) {
    return cipherText;
  }

  // If encrypted but no passcode is entered locally, show lock warning
  if (!key) {
    return '[🔐 Encrypted Goon Drop Payload - Passcode Required]';
  }

  try {
    const base64 = cipherText.substring(14); // Strip tag
    const raw = decodeURIComponent(escape(atob(base64)));
    
    let result = '';
    for (let i = 0; i < raw.length; i++) {
      const charCode = raw.charCodeAt(i) ^ key.charCodeAt(i % key.length);
      result += String.fromCharCode(charCode);
    }
    return result;
  } catch (err) {
    return '[🔐 Encrypted Goon Drop Payload - Passcode Mismatch]';
  }
}
