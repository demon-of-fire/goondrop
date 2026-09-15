import fs from 'fs';
import path from 'path';

/**
 * Simple JSON-based persistence utility for Goon Drop state
 */

export function saveJson(filename: string, data: any) {
  try {
    const filePath = path.join(__dirname, '..', '..', filename);
    // Use temporary file and rename to ensure atomic writes (no corruption on crash)
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[STORAGE] Failed to save ${filename}:`, err);
  }
}

export function loadJson<T>(filename: string, defaultValue: T): T {
  try {
    const filePath = path.join(__dirname, '..', '..', filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`[STORAGE] Failed to load ${filename}, using defaults:`, err);
    return defaultValue;
  }
}
