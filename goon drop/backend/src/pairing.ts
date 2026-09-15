/** Device pairing handler - manages pairing flow, tokens, and device registry */
import type { ConnectionManager, Client } from './websocket';
import { generateId } from './utils';
import { PushManager } from './pushManager';
import { loadJson, saveJson } from './storage';
import fs from 'fs';
import path from 'path';

interface PairedDevice {
  id: string;
  name: string;
  deviceType: string;
  token: string;
  pairedAt: number;
}

interface PendingPairing {
  name: string;
  deviceType: string;
  timestamp: number;
}

const PAIRED_DEVICES_PATH = 'paired_devices.json';
// ⚠️ cwd-independent path: rooted at the backend folder so pairing survives
// however the server is launched (launcher exe, npm start, dev server, etc).
const CONFIG_DIR = path.join(__dirname, '..', 'config');

export class PairingManager {
  private conn: ConnectionManager;
  private pushManager: PushManager;
  private getClipboardHistory: () => any[];
  private pairedDevices = new Map<string, PairedDevice>();
  private pendingPairings = new Map<string, PendingPairing>();
  private pairingCode: string;
  private configPath: string;
  private recentLinks: any[] = [];
  private currentChecklist: any[] = [];
  private chatHistory: any[] = [];

  constructor(conn: ConnectionManager, pushManager: PushManager, getClipboardHistory: () => any[]) {
    this.conn = conn;
    this.pushManager = pushManager;
    this.getClipboardHistory = getClipboardHistory;
    this.configPath = path.join(CONFIG_DIR, PAIRED_DEVICES_PATH);
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch { }
    this.pairingCode = '';
    this.loadPairedDevices();
    this.currentChecklist = loadJson('checklist.json', []);
    this.recentLinks = loadJson('links.json', []);
    this.chatHistory = loadJson('chat_history.json', []);
  }

  private evictStalePending(): void {
    const cutoff = Date.now() - 120000; // 2 minutes
    for (const [id, entry] of this.pendingPairings) {
      if (entry.timestamp < cutoff) this.pendingPairings.delete(id);
    }
  }

  public updateChecklist(list: any[]): void {
    this.currentChecklist = list;
    saveJson('checklist.json', list);
  }

  public handleChatMessage(client: any, payload: any): void {
    const message = {
      text: payload.text,
      timestamp: Date.now(),
      sourceDeviceId: client.id,
      sourceDeviceName: client.name,
    };
    this.chatHistory.push(message);
    this.chatHistory = this.chatHistory.slice(-100);
    saveJson('chat_history.json', this.chatHistory);
    
    this.conn.broadcastToPaired({
      type: 'chat_message',
      payload: message,
      id: generateId(),
      timestamp: Date.now(),
    }, client.id);
  }

  public getChatHistory(): any[] {
    return this.chatHistory;
  }

  public addLink(link: any): void {
    this.recentLinks.unshift(link);
    this.recentLinks = this.recentLinks.slice(0, 50);
    saveJson('links.json', this.recentLinks);
  }

  /** Load previously paired devices from local config */
  private loadPairedDevices(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (data && data.pairingCode) this.pairingCode = data.pairingCode;
        if (data && data.pairedDevices && Array.isArray(data.pairedDevices)) {
          data.pairedDevices.forEach((dev: PairedDevice) => {
            this.pairedDevices.set(dev.id, dev);
            // Only mark as pre-paired if client is actually connected
            const client = this.conn.getClient(dev.id);
            if (client) {
              client.paired = true;
              client.token = dev.token;
            }
          });
        }
      }
    } catch { }
  }

  /** Save current paired devices to local config */
  private savePairedDevices(): void {
    try {
      const list = Array.from(this.pairedDevices.values());
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify({ 
        pairingCode: this.pairingCode, 
        pairedDevices: list 
      }, null, 2), 'utf8');
    } catch { }
  }

  /** Register WebSocket message handlers */
  registerHandlers(): void {
    this.conn.on('pair_request', (client, payload: any) => {
      const { deviceName, deviceType, pairingCode } = payload || {};
      this.handlePairRequest(client, deviceName || 'Unknown', deviceType || 'unknown', pairingCode);
    });

    this.conn.on('pair_confirm', (client, payload: any) => {
      const { deviceId, token, deviceName } = payload;
      this.handlePairConfirm(client, deviceId, token, deviceName);
    });

    this.conn.on('pair_auth_decision', (client, payload: any) => {
      const { deviceId, approved } = payload;
      this.handlePairAuthDecision(client, deviceId, approved);
    });

    this.conn.on('unpair', (client) => {
      this.unpairDevice(client);
    });

    this.conn.on('rename_device', (client, payload: any) => {
      this.handleRename(client, payload.name);
    });
  }

  /** Handle a pair request from a client */
  private handlePairRequest(client: Client, deviceName: string, deviceType: string, pairingCode?: string): void {
    // 🛡️ SECURITY / HOST AUTO-TRUST POLICY: Local loopback clients are implicitly trusted "Admin" hosts.
    const isLocalHost = client.ip === '127.0.0.1' || 
                        client.ip === '::1' || 
                        client.ip.includes('localhost') || 
                        client.ip.includes('::ffff:127.0.0.1');

    const isCodeMatch = !!(pairingCode && this.pairingCode && pairingCode.trim().toUpperCase() === this.pairingCode.trim().toUpperCase());
    const wasPreviouslyPaired = this.pairedDevices.has(client.id);

    // If pairing code matches, or previously paired, or localhost: auto-confirm immediately!
    if (isLocalHost || isCodeMatch || wasPreviouslyPaired) {
      console.log(`[PAIR] Auto-confirming trusted device: ${deviceName} (${client.ip})`);
      this.autoConfirm(client, deviceName, deviceType);
      return;
    }

    // Rate limit: max 10 pending pairings
    if (this.pendingPairings.size >= 10) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'RATE_LIMITED', message: 'Too many pending pairing requests. Try again later.' },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    // Evict stale entries before adding new one
    this.evictStalePending();

    // Check if there are any already paired AND currently active connected devices (excluding this one)
    const activePairedDevices = this.conn.getDeviceList().filter(d => d.paired && d.connected && d.id !== client.id);

    this.pendingPairings.set(client.id, {
      name: deviceName,
      deviceType,
      timestamp: Date.now(),
    });

    // Auto-confirm on private LAN if no other active device is online
    if (activePairedDevices.length === 0) {
      console.log(`[PAIR] Auto-confirming first device: ${deviceName} (${client.ip})`);
      this.autoConfirm(client, deviceName, deviceType);
    } else {
      // Broadcast authorization prompt to active devices
      this.conn.broadcastToPaired({
        type: 'pair_auth_prompt',
        payload: {
          deviceId: client.id,
          deviceName,
          deviceType,
          ip: client.ip,
        },
        id: generateId(),
        timestamp: Date.now(),
      }, client.id);

      // 🔔 Trigger background push notification with actions
      this.pushManager.broadcastNotification(
        `Pairing Request`, 
        `Device "${deviceName}" wants to connect to your Goon Drop network.`,
        [
          { label: 'Accept', value: 'pair_accept' },
          { label: 'Decline', value: 'pair_decline' }
        ],
        client.id
      );

      // Tell the requesting device that they are waiting for approval
      this.conn.send(client, {
        type: 'pairing_pending',
        payload: {
          message: 'Waiting for authorization from an active device...',
          deviceId: client.id,
        },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
  }

  /** Handle pairing decision (approve/reject) from an active device */
  private handlePairAuthDecision(approverClient: Client, targetDeviceId: string, approved: boolean): void {
    const pending = this.pendingPairings.get(targetDeviceId);
    if (!pending) return;

    const targetClient = this.conn.getClient(targetDeviceId);

    if (approved) {
      this.pendingPairings.delete(targetDeviceId);
      
      // Confirm the target client
      if (targetClient) {
        this.autoConfirm(targetClient, pending.name, pending.deviceType);
      }
      
      // Notify other active devices that the request was approved and they can close prompts
      this.conn.broadcastToPaired({
        type: 'pair_auth_resolved',
        payload: {
          deviceId: targetDeviceId,
          approved: true,
          approverName: approverClient.name,
        },
        id: generateId(),
        timestamp: Date.now(),
      });
    } else {
      this.pendingPairings.delete(targetDeviceId);

      if (targetClient) {
        this.conn.send(targetClient, {
          type: 'pair_rejected',
          payload: {
            message: 'Pairing request denied by Goon Drop network.',
          },
          id: generateId(),
          timestamp: Date.now(),
        });
      }

      // Notify other devices to dismiss prompt
      this.conn.broadcastToPaired({
        type: 'pair_auth_resolved',
        payload: {
          deviceId: targetDeviceId,
          approved: false,
          approverName: approverClient.name,
        },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
  }

  /** Auto-confirm pairing on local network */
  private autoConfirm(client: Client, deviceName: string, deviceType: string): void {
    const token = generateId();
    this.conn.registerClient(client.id, deviceName, deviceType, token);

    this.pairedDevices.set(client.id, {
      id: client.id,
      name: deviceName,
      deviceType,
      token,
      pairedAt: Date.now(),
    });

    // 💾 Save newly paired device list
    this.savePairedDevices();

    // Confirm to the new device
    this.conn.send(client, {
      type: 'paired',
      payload: {
        deviceId: client.id,
        token,
        serverName: `Goon Drop`,
        devices: this.conn.getDeviceList(),
      },
      id: generateId(),
      timestamp: Date.now(),
    });

    // 🚀 OMEGA SYNC: Push the active clipboard history, checklist, recent links, and active browser tab so they catch up instantly!
    // Query active handoff state from server (safe and decoupled)
    let activeHandoff = null;
    try {
      const { createServer } = require('./server');
      // We can easily fetch the active handoff directly from the server or expose a small getter
    } catch { }

    this.conn.send(client, {
      type: 'init_state',
      payload: {
        checklist: this.currentChecklist,
        links: this.recentLinks,
        clipboardHistory: this.getClipboardHistory()
      },
      id: generateId(),
      timestamp: Date.now()
    });

    // Broadcast updated device list
    this.conn.broadcast({
      type: 'device_list',
      payload: this.conn.getDeviceList(),
      id: generateId(),
      timestamp: Date.now(),
    });
  }

/** Handle pair confirmation from an existing device (with support for silent re-authentication!) */
public handlePairConfirm(client: Client, deviceId: string, token: string, deviceName: string): void {
  // 1. Check if this is a previously paired device reconnecting
  const existing = this.pairedDevices.get(deviceId);
  if (existing && existing.token === token) {
    // Token matches known paired device -- silently re-authenticate
    const reconnected = this.conn.rekeyClient(client.id, deviceId, deviceName || existing.name, existing.deviceType, token);
    if (!reconnected) return;

    // Send paired confirmation
    this.conn.send(client, {
      type: 'paired',
      payload: {
        deviceId,
        token,
        serverName: 'Goon Drop',
        devices: this.conn.getDeviceList()
      },
      id: generateId(),
      timestamp: Date.now(),
    });

    this.conn.broadcast({
      type: 'device_list',
      payload: this.conn.getDeviceList(),
      id: generateId(),
      timestamp: Date.now(),
    });
    return;
  }

  // 2. Fall back to verifying pending pairings (try both deviceId and temp client.id)
  const pending = this.pendingPairings.get(deviceId) || this.pendingPairings.get(client.id);
  if (pending) {
    const reconnected = this.conn.rekeyClient(client.id, deviceId, deviceName || pending.name, pending.deviceType, token);
    if (!reconnected) return;
    this.pendingPairings.delete(deviceId);
    this.pendingPairings.delete(client.id);

    this.pairedDevices.set(deviceId, {
      id: deviceId,
      name: deviceName || pending.name,
      deviceType: pending.deviceType,
      token,
      pairedAt: Date.now(),
    });

    this.savePairedDevices();

    this.conn.send(client, {
      type: 'paired',
      payload: {
        deviceId,
        token,
        serverName: 'Goon Drop',
        devices: this.conn.getDeviceList()
      },
      id: generateId(),
      timestamp: Date.now()
    });

    this.conn.broadcast({
      type: 'device_list',
      payload: this.conn.getDeviceList(),
      id: generateId(),
      timestamp: Date.now(),
    });
    return;
  }

  // 3. Fall back to initiating a fresh pairing flow (handles server restart with stale client tokens)
  this.handlePairRequest(client, deviceName || client.name, client.deviceType);
}

  public handlePairReject(deviceId: string): void {
    this.pendingPairings.delete(deviceId);
    console.log(`[NOTIFY] Pairing request from ${deviceId} was declined.`);
  }

  /** Handle push notification pair accept (no live WebSocket client) */
  public handlePairActionConfirm(deviceId: string, token: string, deviceName: string): void {
    const pending = this.pendingPairings.get(deviceId);
    if (pending) {
      this.pairedDevices.set(deviceId, {
        id: deviceId,
        name: deviceName || pending.name,
        deviceType: pending.deviceType,
        token,
        pairedAt: Date.now(),
      });
      this.savePairedDevices();
      this.pendingPairings.delete(deviceId);
      this.conn.broadcast({
        type: 'device_list',
        payload: this.conn.getDeviceList(),
        id: generateId(),
        timestamp: Date.now(),
      });
    }
  }

  public unpairDevice(client: Client): void {
    this.revokeDevice(client.id);
    client.paired = false;
    this.conn.broadcast({
      type: 'device_list',
      payload: this.conn.getDeviceList(),
      id: generateId(),
      timestamp: Date.now(),
    });
  }

  /** Permanently revoke a device, rather than merely dropping its current socket. */
  public revokeDevice(deviceId: string): boolean {
    const removed = this.pairedDevices.delete(deviceId);
    this.pendingPairings.delete(deviceId);
    if (removed) this.savePairedDevices();
    return removed;
  }

  private handleRename(client: Client, name: string): void {
    const sanitized = name.trim().substring(0, 30) || client.name;
    client.name = sanitized;

    const device = this.pairedDevices.get(client.id);
    if (device) {
      device.name = sanitized;
      this.pairedDevices.set(client.id, device);
      this.savePairedDevices();
    }
  }

  /** Get all paired devices */
  getPairedDevices(): PairedDevice[] {
    return Array.from(this.pairedDevices.values());
  }
}
