/** Server configuration with sensible defaults for LAN operation */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { randomInt } from 'crypto';

export interface AppConfig {
  port: number;
  host: string;
  localIp: string;
  pairingCode: string;
  maxFileSize: number;
  chunkSize: number;
  tempDir: string;
  cleanupIntervalMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxClipboardHistory: number;
  maxLinkHistory: number;
}

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];

  const ignoreList = ['vpn', 'proton', 'docker', 'virtualbox', 'vbox', 'vmware', 'virtual', 'loopback', 'vethernet'];

  for (const name of Object.keys(interfaces)) {
    const nameLower = name.toLowerCase();
    // Skip known virtual/VPN adapters
    if (ignoreList.some(ignore => nameLower.includes(ignore))) {
      continue;
    }

    const netInterface = interfaces[name];
    if (!netInterface) continue;
    for (const addr of netInterface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ name: nameLower, address: addr.address });
      }
    }
  }

  // Prefer Wi-Fi / Ethernet adapters (including "wifi" without hyphen)
  const preferOrder = ['wi-fi', 'wifi', 'wlan', 'wireless', 'ethernet'];
  for (const preferred of preferOrder) {
    const match = candidates.find(c => c.name.includes(preferred));
    if (match) return match.address;
  }

  // Fall back to first non-internal IPv4 candidate
  if (candidates.length > 0) return candidates[0].address;

  return '127.0.0.1';
}

function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomInt(chars.length));
  }
  return code;
}

function getPersistentPairingCode(): string {
  const configPath = path.join(__dirname, '..', 'goondrop-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data && data.pairingCode && typeof data.pairingCode === 'string') {
        return data.pairingCode;
      }
    }
  } catch (err) {
    // Ignore and regenerate
  }

  const newCode = generatePairingCode();
  try {
    fs.writeFileSync(configPath, JSON.stringify({ pairingCode: newCode }, null, 2), 'utf8');
  } catch (err) {
    // Ignore
  }
  return newCode;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3941', 10),
    host: process.env.HOST || '0.0.0.0',
    localIp: getLocalIp(),
    pairingCode: getPersistentPairingCode(),
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '5368709120', 10), // 5GB default limit!
    chunkSize: parseInt(process.env.CHUNK_SIZE || '65536', 10), // 64KB chunks
    tempDir: process.env.TEMP_DIR || './temp',
    cleanupIntervalMs: 300000, // 5 minutes
    heartbeatIntervalMs: 10000, // 10 seconds
    heartbeatTimeoutMs: 30000, // 30 seconds
    maxClipboardHistory: 50,
    maxLinkHistory: 50,
  };
}
