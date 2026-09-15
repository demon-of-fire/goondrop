/** Shared type definitions for Goon Drop frontend and backend */

// ─── Message Types ──────────────────────────────────────────────────────────

export enum MessageType {
  // System
  HANDSHAKE = 'handshake',
  HEARTBEAT = 'heartbeat',
  HEARTBEAT_ACK = 'heartbeat_ack',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
  ACK = 'ack',

  // Pairing
  PAIR_REQUEST = 'pair_request',
  PAIR_CONFIRM = 'pair_confirm',
  PAIR_REJECT = 'pair_reject',
  PAIRED = 'paired',
  UNPAIR = 'unpair',
  DEVICE_LIST = 'device_list',
  DEVICE_UPDATE = 'device_update',
  RENAME_DEVICE = 'rename_device',

  // Clipboard
  CLIPBOARD_PUSH = 'clipboard_push',
  CLIPBOARD_ACK = 'clipboard_ack',
  CLIPBOARD_REQUEST = 'clipboard_request',
  CLIPBOARD_HISTORY = 'clipboard_history',
  CLIPBOARD_CLEAR = 'clipboard_clear',

  // Link
  LINK_SEND = 'link_send',
  LINK_ACK = 'link_ack',
  LINK_HISTORY = 'link_history',

  // File
  FILE_META = 'file_meta',
  FILE_CHUNK = 'file_chunk',
  FILE_CHUNK_ACK = 'file_chunk_ack',
  FILE_COMPLETE = 'file_complete',
  FILE_CANCEL = 'file_cancel',
  FILE_REQUEST = 'file_request',
  FILE_PROGRESS = 'file_progress',

   // Text Note
   TEXT_NOTE = 'text_note',
   TEXT_NOTE_ACK = 'text_note_ack',

   // WebRTC Signaling (Screen Mirroring / Audio Casting)
   WEBRTC_OFFER = 'webrtc_offer',
   WEBRTC_ANSWER = 'webrtc_answer',
   WEBRTC_ICE_CANDIDATE = 'webrtc_ice_candidate',

   // Windows System Control
   LOCK_PC = 'lock_pc',
   SLEEP_PC = 'sleep_pc',
   SHUTDOWN_PC = 'shutdown_pc',
   RESTART_PC = 'restart_pc',
   UPDATE_PC = 'update_pc',
}

// ─── Payloads ───────────────────────────────────────────────────────────────

export interface TextNotePayload {
   text: string;
   timestamp: number;
   sourceDeviceId: string;
   sourceDeviceName: string;
 }

export interface WebRTCPayload {
   sdp: string;
   type: 'offer' | 'answer';
 }

export interface WebRTCIceCandidatePayload {
   candidate: string;
   sdpMid: string;
   sdpMLineIndex: number;
 }

export interface ErrorPayload {
  code: string;
  message: string;
}

// ─── Envelope ───────────────────────────────────────────────────────────────

export interface MessageEnvelope {
  type: MessageType;
  payload: unknown;
  deviceId?: string;
  targetDeviceId?: string;
  id: string;
  timestamp: number;
}

// ─── Device Types ───────────────────────────────────────────────────────────

export enum DeviceType {
  WINDOWS = 'windows',
  IPHONE = 'iphone',
  MAC = 'mac',
  LINUX = 'linux',
  ANDROID = 'android',
  UNKNOWN = 'unknown',
}

// ─── Connection State ───────────────────────────────────────────────────────

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
}

// ─── Server Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  port: number;
  host: string;
  localIp: string;
  pairingCode: string;
  maxFileSize: number; // bytes
  chunkSize: number; // bytes
  tempDir: string;
  cleanupInterval: number; // ms
  heartbeatInterval: number; // ms
  heartbeatTimeout: number; // ms
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export function detectContentType(text: string): 'url' | 'rich' | 'text' {
  const urlPattern = /^(https?:\/\/|www\.)[^\s]+$/i;
  if (urlPattern.test(text.trim())) return 'url';
  if (text.includes('\n') || text.length > 200) return 'rich';
  return 'text';
}

export function getDeviceType(): DeviceType {
  const ua = navigator.userAgent;
  if (/windows/i.test(ua)) return DeviceType.WINDOWS;
  if (/iphone|ipad|ipod/i.test(ua)) return DeviceType.IPHONE;
  if (/mac/i.test(ua)) return DeviceType.MAC;
  if (/linux/i.test(ua)) return DeviceType.LINUX;
  if (/android/i.test(ua)) return DeviceType.ANDROID;
  return DeviceType.UNKNOWN;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatFileSize(bytesPerSecond)}/s`;
}
