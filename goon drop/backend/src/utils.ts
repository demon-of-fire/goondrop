/** Shared backend utilities */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

/** Human-friendly machine name for this PC. `COMPUTERNAME` keeps Windows'
 *  display casing (e.g. "AARYAN"); `os.hostname()` is the fallback elsewhere. */
export function getMachineName(): string {
  return (process.env.COMPUTERNAME || os.hostname() || 'Goon Drop PC').trim();
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Simple FNV-1a-like hash for deduplication */
export function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function generateId(): string {
  return randomUUID();
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 255);
}

export function isUrl(text: string): boolean {
  return /^(https?:\/\/|www\.)[^\s]+$/i.test(text.trim());
}

export function cleanupOldFiles(dir: string, maxAgeMs: number): void {
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch { /* skip */ }
  }
}
