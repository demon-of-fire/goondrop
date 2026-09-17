/** Clipboard sync handler - manages clipboard text sharing between devices */
import type { ConnectionManager, Client } from './websocket';
import { generateId, hashText, isUrl } from './utils';
import { PushManager } from './pushManager';
import { exec } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { loadJson, saveJson } from './storage';

interface ClipboardEntry {
  text: string;
  hash: string;
  timestamp: number;
  sourceDeviceId: string;
  sourceDeviceName: string;
  /** Pinned entries are never auto-trimmed out of the history. */
  pinned?: boolean;
}

export class ClipboardManager {
  private history: ClipboardEntry[] = [];
  private recentHashes: Map<string, number> = new Map(); // hash → timestamp
  private readonly hashTtlMs = 300000; // 5 minutes
  private maxHistory: number;
  private pushManager: PushManager;

  constructor(private conn: ConnectionManager, pushManager: PushManager, maxHistory = 50) {
    this.maxHistory = maxHistory;
    this.pushManager = pushManager;
    this.history = loadJson('clipboard_history.json', []);
    
    // Rebuild recentHashes from loaded history to prevent immediate duplicate syncs
    this.history.forEach(entry => {
      this.recentHashes.set(entry.hash, entry.timestamp);
    });
  }

  /** Evict expired hash entries */
  private evictExpiredHashes(): void {
    const cutoff = Date.now() - this.hashTtlMs;
    for (const [hash, ts] of this.recentHashes) {
      if (ts < cutoff) this.recentHashes.delete(hash);
    }
  }

  /** Register WebSocket message handlers */
  registerHandlers(): void {
    this.conn.on('clipboard_push', (client, payload: any) => {
      this.handleClipboardPush(client, payload);
    });

    this.conn.on('clipboard_request', (client) => {
      this.handleClipboardRequest(client);
    });

    this.conn.on('clipboard_clear', () => {
      this.handleClipboardClear();
    });

    this.conn.on('clipboard_pin', (client, payload: any) => {
      const { hash, pinned } = payload || {};
      if (typeof hash !== 'string') return;
      this.pinEntry(hash, pinned !== false);
      this.conn.send(client, {
        type: 'clipboard_history',
        payload: this.search(''),
        id: generateId(),
        timestamp: Date.now(),
      });
    });
  }

  /** Pin/unpin a history entry so it is protected from auto-trimming. */
  public pinEntry(hash: string, pinned: boolean): boolean {
    const entry = this.history.find(e => e.hash === hash);
    if (!entry) return false;
    entry.pinned = pinned;
    saveJson('clipboard_history.json', this.history);
    this.conn.broadcastToPaired({
      type: 'clipboard_pinned',
      payload: { hash, pinned },
      id: generateId(),
      timestamp: Date.now(),
    });
    return true;
  }

  /** Case-insensitive search over history text, newest first. */
  public search(query: string): ClipboardEntry[] {
    const q = (query || '').trim().toLowerCase();
    const list = q
      ? this.history.filter(e => e.text.toLowerCase().includes(q) || e.sourceDeviceName.toLowerCase().includes(q))
      : this.history;
    // Pinned entries float to the top, otherwise newest-first.
    return [...list].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return b.timestamp - a.timestamp;
    });
  }

  /** Put a specific history entry back onto the PC clipboard. */
  public restore(hash: string): boolean {
    const entry = this.history.find(e => e.hash === hash);
    if (!entry) return false;
    try {
      const tempFile = path.join(os.tmpdir(), `goondrop-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(tempFile, entry.text, 'utf8');
      exec(
        `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Content -Raw -LiteralPath '${tempFile}' -Encoding UTF8 | Set-Clipboard"`,
        () => {
          try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        }
      );
    } catch { /* ignore */ }
    return true;
  }

  /** Handle incoming clipboard push from a device */
  public handleClipboardPush(client: Client, payload: any): void {
    const { text, hash, type } = payload;

    if (!text || typeof text !== 'string') return;

    const textHash = hash || hashText(text);
    const now = Date.now();

    this.evictExpiredHashes();

    // Deduplicate: skip if we've seen this content within TTL
    if (this.recentHashes.has(textHash)) {
      this.conn.send(client, {
        type: 'clipboard_ack',
        payload: { hash: textHash, timestamp: now },
        id: generateId(),
        timestamp: now,
      });
      return;
    }

    this.recentHashes.set(textHash, now);
    
    // 🔔 Trigger background push notification for others
    this.pushManager.broadcastNotification(
      `Clipboard Synced`, 
      `New text synced from ${client.name}`,
      [
        { label: 'Copy', value: 'clip_copy' },
        { label: 'Ignore', value: 'clip_ignore' }
      ],
      client.id
    );

    const entry: ClipboardEntry = {
      text,
      hash: textHash,
      timestamp: now,
      sourceDeviceId: client.id,
      sourceDeviceName: client.name,
    };

    this.history.unshift(entry);
    // Trim oldest *unpinned* entries once over capacity — pinned items stay.
    while (this.history.length > this.maxHistory) {
      const idx = [...this.history].reverse().findIndex(e => !e.pinned);
      if (idx === -1) break; // everything pinned; keep them all
      const realIndex = this.history.length - 1 - idx;
      const [removed] = this.history.splice(realIndex, 1);
      if (removed) this.recentHashes.delete(removed.hash);
    }

    saveJson('clipboard_history.json', this.history);

    // Native Windows Clipboard Integration — the text is written to a temp file
    // and piped through `Get-Content -Raw | Set-Clipboard`. Piping to the
    // process's stdin with a bare `Set-Clipboard` does NOT bind the text (it
    // silently leaves the clipboard unchanged), so the file-pipe form is used.
    try {
      const tempFile = path.join(os.tmpdir(), `goondrop-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(tempFile, text, 'utf8');
      exec(
        `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Content -Raw -LiteralPath '${tempFile}' -Encoding UTF8 | Set-Clipboard"`,
        () => {
          try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
        }
      );
    } catch { /* ignore */ }

    // Broadcast to all other paired devices
    this.conn.broadcastToPaired({
      type: 'clipboard_push',
      payload: {
        text,
        hash: textHash,
        timestamp: entry.timestamp,
        sourceDeviceId: client.id,
        sourceDeviceName: client.name,
        type: type || (isUrl(text) ? 'url' : 'text'),
      },
      id: generateId(),
      timestamp: Date.now(),
    }, client.id);

    console.log(`[NOTIFY] Clipboard copied from ${client.name}`);

    // Send acknowledgment to sender
    this.conn.send(client, {
      type: 'clipboard_ack',
      payload: { hash: textHash, timestamp: Date.now() },
      id: generateId(),
      timestamp: Date.now(),
    });
  }

  /** Handle request for clipboard history */
  private handleClipboardRequest(client: Client): void {
    this.conn.send(client, {
      type: 'clipboard_history',
      payload: this.search('').slice(0, 30),
      id: generateId(),
      timestamp: Date.now(),
    });
  }

  /** Clear clipboard history (Public interface!) */
  public clearHistory(): void {
    this.history = [];
    this.recentHashes.clear();
    saveJson('clipboard_history.json', []);
  }

  /** Trim recentHashes to match history size */
  private trimHashes(): void {
    const validHashes = new Set(this.history.map(e => e.hash));
    for (const hash of this.recentHashes.keys()) {
      if (!validHashes.has(hash)) this.recentHashes.delete(hash);
    }
  }

  /** Handle clipboard clear request */
  private handleClipboardClear(): void {
    this.clearHistory();

    this.conn.broadcastToPaired({
      type: 'clipboard_clear',
      payload: { timestamp: Date.now() },
      id: generateId(),
      timestamp: Date.now(),
    });
  }

  /** Get clipboard history */
  getHistory(): ClipboardEntry[] {
    return [...this.history];
  }
}
