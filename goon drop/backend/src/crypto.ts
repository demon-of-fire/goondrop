import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** AES-256-GCM at-rest encryption for sensitive Goon Drop state files. */

// Key lives in backend/config alongside the files it protects (runtime config
// dir is local and never synced by OneDrive, unlike the repo root).
const KEY_PATH = path.join(__dirname, '..', 'config', '.goondrop.key');

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;
  try {
    if (fs.existsSync(KEY_PATH)) {
      _key = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'base64');
      return _key;
    }
  } catch { }

  const freshKey = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, freshKey.toString('base64'), { encoding: 'utf8' });
  } catch (err) {
    console.error('[CRYPTO] Could not persist encryption key:', err);
  }
  _key = freshKey;
  return _key;
}

/** Serialize + encrypt. Output is base64(iv || gcmTag || ciphertext). */
export function encryptJson(data: any): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Decrypt + parse; returns null when the blob is not valid encrypted JSON. */
export function decryptJson<T>(blob: string): T | null {
  try {
    const key = getKey();
    const buf = Buffer.from(blob.trim(), 'base64');
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}