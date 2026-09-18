import fs from 'fs';
import path from 'path';
import { encryptJson, decryptJson } from './crypto';

/**
 * JSON persistence for Goon Drop state, rooted at backend/config — a plain
 * local runtime dir (OneDrive never hydrates/mangles it, unlike the repo root
 * which clipboard state historically used). Files are encrypted at rest with
 * AES-256-GCM; legacy plaintext or root-level files migrate in place.
 */

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const LEGACY_DIR = path.join(__dirname, '..', '..');

function legacyCanMigrate(filename: string, legacyPath: string): boolean {
  if (!fs.existsSync(legacyPath)) return false;
  try {
    const content = fs.readFileSync(legacyPath, 'utf8').trim();
    // Carried forward only when it's readable: encrypted under the current key,
    // or still-legacy plaintext. Stale ciphertext from a retired key is dropped
    // so the server never boots on unreadable state.
    if (decryptJson(content) !== null) return true;
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function migrateIfNeeded(filename: string): string {
  const filePath = path.join(CONFIG_DIR, filename);
  if (fs.existsSync(filePath)) return filePath;

  const legacyPath = path.join(LEGACY_DIR, filename);
  if (filename === 'clipboard_history.json' && legacyCanMigrate(filename, legacyPath)) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.copyFileSync(legacyPath, filePath);
      // Only migrate the first time; keep the old copy as a backup.
      return filePath;
    } catch { }
  }
  return filePath;
}

export function saveJson(filename: string, data: any) {
  try {
    const filePath = migrateIfNeeded(filename);
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Use temporary file and rename to ensure atomic writes (no corruption on crash)
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, encryptJson(data), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[STORAGE] Failed to save ${filename}:`, err);
  }
}

export function loadJson<T>(filename: string, defaultValue: T): T {
  try {
    const filePath = migrateIfNeeded(filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    // Encrypted form first, then plaintext migration fallback.
    const decrypted = decryptJson<T>(content);
    if (decrypted !== null) return decrypted;
    return JSON.parse(content) as T;
  } catch (err) {
    console.error(`[STORAGE] Failed to load ${filename}, using defaults:`, err);
    return defaultValue;
  }
}