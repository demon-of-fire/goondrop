/** WebSocket connection manager - handles all real-time messaging */
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { AppConfig } from './config';
import { generateId, hashText, getMachineName } from './utils';

export interface Client {
  ws: WebSocket;
  id: string;
  name: string;
  deviceType: string;
  paired: boolean;
  token: string;
  connectedAt: number;
  lastSeen: number;
  ip: string;
}

interface MessageHandler {
  (client: Client, payload: unknown, messageId: string): void;
}

export class ConnectionManager {
  private clients: Map<string, Client> = new Map();
  private handlers: Map<string, MessageHandler> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: AppConfig) {}

  /** Attach WebSocket server to an HTTP server */
  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const ip = req.socket.remoteAddress || 'unknown';
      const clientId = generateId();
      const token = generateId();

      const client: Client = {
        ws,
        id: clientId,
        name: `Device-${clientId.substring(0, 6)}`,
        deviceType: 'unknown',
        paired: false,
        token,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ip,
      };

      // ⚠️ CRITICAL: Add client to the map so it appears in device lists
      this.clients.set(client.id, client);

      ws.on('message', (raw: Buffer) => {
        this.handleMessage(client, raw.toString());
      });

      ws.on('close', () => {
        this.removeClient(client.id);
      });

      ws.on('error', () => {
        this.removeClient(client.id);
      });

      // Send handshake with assigned ID and pairing code
      this.send(client, {
        type: 'handshake',
        payload: {
          clientId: client.id,
          token: client.token,
          pairingCode: this.config.pairingCode,
          serverName: getMachineName(),
        },
        id: generateId(),
        timestamp: Date.now(),
      });
    });

    // Heartbeat interval
    this.heartbeatTimer = setInterval(() => {
      this.broadcastSystem({ type: 'heartbeat', payload: { timestamp: Date.now() }, id: generateId(), timestamp: Date.now() });
    }, this.config.heartbeatIntervalMs);

    // Cleanup handled by FileTransferManager.cleanup — no duplicate timer needed here
  }

  /** Register a message type handler */
  on(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  /** Handle an incoming message */
  private handleMessage(client: Client, raw: string): void {
    try {
      const msg = JSON.parse(raw);
      client.lastSeen = Date.now();

      if (!msg || typeof msg.type !== 'string') {
        throw new Error('Invalid message');
      }

      // Only pairing and keep-alive traffic is allowed before a device is trusted.
      // Without this gate, anyone on the Wi-Fi could invoke PC control or read data.
      const unauthenticatedTypes = new Set(['pair_request', 'pair_confirm', 'heartbeat', 'heartbeat_ack']);
      if (!client.paired && !unauthenticatedTypes.has(msg.type)) {
        this.send(client, {
          type: 'error',
          payload: { code: 'NOT_PAIRED', message: 'Pair this device before using Goon Drop features.' },
          id: generateId(),
          timestamp: Date.now(),
        });
        return;
      }

      const handler = this.handlers.get(msg.type);
      if (handler) {
        handler(client, msg.payload, msg.id);
      }
    } catch (err) {
      console.warn(`[WARN] Malformed WebSocket message from ${client.id}: ${raw.substring(0, 100)}`);
    }
  }

  /** Send a message to a specific client */
  send(client: Client, message: unknown): void {
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  /** Send a message to a client by ID */
  sendTo(clientId: string, message: unknown): boolean {
    const client = this.clients.get(clientId);
    if (client) {
      this.send(client, message);
      return true;
    }
    return false;
  }

  /** Broadcast to all connected clients */
  broadcast(message: unknown, excludeId?: string): void {
    const data = JSON.stringify(message);
    for (const [id, client] of this.clients) {
      if (id !== excludeId && client.ws && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /** Broadcast to all paired clients */
  broadcastToPaired(message: unknown, excludeId?: string): void {
    const data = JSON.stringify(message);
    for (const [id, client] of this.clients) {
      if (id !== excludeId && client.paired && client.ws && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /** Broadcast system messages to paired clients only */
  private broadcastSystem(message: unknown): void {
    const data = JSON.stringify(message);
    for (const [, client] of this.clients) {
      if (client.paired && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /** Register a client after pairing */
  registerClient(id: string, name: string, deviceType: string, token: string): boolean {
    const client = this.clients.get(id);
    if (!client) return false;
    client.name = name;
    client.deviceType = deviceType;
    client.paired = true;
    client.token = token;
    this.clients.set(id, client);
    return true;
  }

  /** Associate a new socket with a previously paired device identity. */
  rekeyClient(currentId: string, persistentId: string, name: string, deviceType: string, token: string): Client | undefined {
    const client = this.clients.get(currentId);
    if (!client) return undefined;

    const existing = this.clients.get(persistentId);
    if (existing && existing !== client) {
      try { existing.ws.close(); } catch { }
      this.clients.delete(persistentId);
    }

    this.clients.delete(currentId);
    client.id = persistentId;
    client.name = name;
    client.deviceType = deviceType;
    client.token = token;
    client.paired = true;
    this.clients.set(persistentId, client);
    return client;
  }

  /** Forcefully add a client under a custom key */
  addClient(id: string, client: Client): void {
    this.clients.set(id, client);
  }

  /** Explicitly remove an old client key to prevent duplicates (Omega Clean!) */
  removeClientKey(id: string): void {
    this.clients.delete(id);
  }

  /** Remove a disconnected client */
  removeClient(id: string): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client?.paired) {
      this.broadcast({
        type: 'device_offline',
        payload: { deviceId: id, name: client.name, deviceType: client.deviceType, online: false },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
    this.broadcast({
      type: 'device_list',
      payload: this.getDeviceList(),
      id: generateId(),
      timestamp: Date.now(),
    });
  }

  /** Get list of all devices */
  getDeviceList(): Array<{ id: string; name: string; type: string; connected: boolean; lastSeen: number; paired: boolean }> {
    const list: Array<{ id: string; name: string; type: string; connected: boolean; lastSeen: number; paired: boolean }> = [];
    for (const [, client] of this.clients) {
      list.push({
        id: client.id,
        name: client.name,
        type: client.deviceType,
        connected: client.ws.readyState === WebSocket.OPEN,
        lastSeen: client.lastSeen,
        paired: client.paired,
      });
    }
    return list;
  }

  /** Get a client by ID */
  getClient(id: string): Client | undefined {
    return this.clients.get(id);
  }

  /** Get number of connected clients */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Stop the connection manager */
  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const [, client] of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
  }
}
