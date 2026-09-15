/** Main application context - manages all global state */
import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef, useState, ReactNode } from 'react';
import { useWebSocket, ConnectionStatus } from '../hooks/useWebSocket';
import { useClipboardSync } from '../hooks/useClipboardSync';
import { useToast, ToastType } from '../hooks/useToast';
import { announce, announceDeviceConnected, announceDeviceDisconnected, announceError } from '../utils/accessibility';
import { playChime } from '../utils/sound';
import { showNativeNotification } from '../utils/notifications';
import { decryptText, encryptText } from '../utils/crypto';
import { subscribeToPush } from '../utils/push';

// iOS-safe haptic feedback: uses navigator.vibrate where available, falls back to visual flash
function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function hapticFeedback(pattern: number | number[]): void {
  if (navigator.vibrate) {
    navigator.vibrate(pattern);
    return;
  }
  // iOS visual haptic fallback
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;border:4px solid var(--color-accent,#00e5a0);opacity:0.7;border-radius:0;transition:opacity 0.15s ease-out;';
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '0'; });
  setTimeout(() => el.remove(), 200);
}

// Determine device type from user agent
function getDeviceTypeStr(): string {
  const ua = navigator.userAgent;
  if (/windows/i.test(ua)) return 'windows';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iphone';
  if (/mac/i.test(ua)) return 'mac';
  if (/linux/i.test(ua)) return 'linux';
  if (/android/i.test(ua)) return 'android';
  return 'unknown';
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Device {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  lastSeen: number;
  paired: boolean;
}

export interface ServerInfo {
  name: string;
  version: string;
  localIp: string;
  port: number;
  pairingCode: string;
  connectedDevices: number;
}

export interface AuthPrompt {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  ip: string;
}

export interface FileTransfer {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  progress: number;
  status: 'queued' | 'sending' | 'receiving' | 'complete' | 'error' | 'cancelled';
  sourceDeviceName?: string;
  sourceDeviceId?: string;
  downloadUrl?: string;
}

export interface LinkEntry {
  url: string;
  title?: string;
  timestamp: number;
  sourceDeviceName?: string;
}

export interface TextNoteEntry {
  text: string;
  timestamp: number;
  sourceDeviceName?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface TransferRequest {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sourceDeviceName: string;
  sourceDeviceId: string;
}

interface AppState {
  connectionStatus: ConnectionStatus;
  deviceId: string;
  deviceName: string;
  deviceType: string;
  serverInfo: ServerInfo | null;
  devices: Device[];
  paired: boolean;
  pairingCode: string;
  qrCode: string;
  pairingUrl: string;
  fileTransfers: FileTransfer[];
  transferRequests: TransferRequest[];
  links: LinkEntry[];
  notes: TextNoteEntry[];
  checklist: ChecklistItem[];
  activeHandoff: { url: string; title: string } | null;
  isIOS: boolean;
  pendingAuthPrompt: AuthPrompt | null;
  pairingStatus: 'idle' | 'waiting' | 'rejected';
  pairingToken: string;
}

type AppAction =
  | { type: 'SET_CONNECTION_STATUS'; payload: ConnectionStatus }
  | { type: 'SET_DEVICE_ID'; payload: string }
  | { type: 'SET_DEVICE_NAME'; payload: string }
  | { type: 'SET_SERVER_INFO'; payload: ServerInfo }
  | { type: 'SET_DEVICES'; payload: Device[] }
  | { type: 'SET_PAIRED'; payload: boolean }
  | { type: 'SET_PAIRING_CODE'; payload: string }
  | { type: 'SET_QR_CODE'; payload: { qrCode: string; pairingUrl: string } }
  | { type: 'ADD_FILE_TRANSFER'; payload: FileTransfer }
  | { type: 'UPDATE_FILE_PROGRESS'; payload: { fileId: string; progress: number } }
  | { type: 'REMOVE_FILE_TRANSFER'; payload: string }
  | { type: 'SET_FILE_TRANSFER_STATUS'; payload: { fileId: string; status: FileTransfer['status']; downloadUrl?: string; sourceDeviceId?: string } }
  | { type: 'ADD_LINK'; payload: LinkEntry }
  | { type: 'SET_LINKS'; payload: LinkEntry[] }
  | { type: 'ADD_NOTE'; payload: TextNoteEntry }
  | { type: 'SET_CHECKLIST'; payload: ChecklistItem[] }
  | { type: 'SET_ACTIVE_HANDOFF'; payload: { url: string; title: string } | null }
  | { type: 'SET_PENDING_AUTH_PROMPT'; payload: AuthPrompt | null }
  | { type: 'SET_PAIRING_STATUS'; payload: AppState['pairingStatus'] }
  | { type: 'SET_PAIRING_TOKEN'; payload: string }
  | { type: 'ADD_TRANSFER_REQUEST'; payload: TransferRequest }
  | { type: 'ACCEPT_TRANSFER'; payload: string }
  | { type: 'DECLINE_TRANSFER'; payload: string };


const savedId = typeof window !== 'undefined' ? window.localStorage.getItem('goondrop_device_id') || '' : '';
const savedTok = typeof window !== 'undefined' ? window.localStorage.getItem('goondrop_token') || '' : '';

const initialState: AppState = {
  connectionStatus: 'disconnected',
  deviceId: savedId,
  deviceName: '',
  deviceType: getDeviceTypeStr(),
  serverInfo: null,
  devices: [],
  paired: savedId !== '' && savedTok !== '', // Pre-approve local state if we have saved credentials!
  pairingCode: '',
  qrCode: '',
  pairingUrl: '',
  fileTransfers: [],
  links: [],
  notes: [],
  checklist: [],
  activeHandoff: null,
  isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent),
  pendingAuthPrompt: null,
  pairingStatus: 'idle',
  transferRequests: [],
  pairingToken: savedTok,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONNECTION_STATUS':
      return { ...state, connectionStatus: action.payload };
    case 'SET_DEVICE_ID':
      return { ...state, deviceId: action.payload };
    case 'SET_DEVICE_NAME':
      return { ...state, deviceName: action.payload };
    case 'SET_SERVER_INFO':
      return { ...state, serverInfo: action.payload };
    case 'SET_DEVICES':
      return { ...state, devices: action.payload };
    case 'SET_PAIRED':
      return { ...state, paired: action.payload };
    case 'SET_PAIRING_CODE':
      return { ...state, pairingCode: action.payload };
    case 'SET_QR_CODE':
      return { ...state, qrCode: action.payload.qrCode, pairingUrl: action.payload.pairingUrl };
    case 'ADD_FILE_TRANSFER':
      return {
        ...state,
        fileTransfers: state.fileTransfers.some(ft => ft.fileId === action.payload.fileId)
          ? state.fileTransfers
          : [...state.fileTransfers, action.payload],
      };
    case 'UPDATE_FILE_PROGRESS':
      return {
        ...state,
        fileTransfers: state.fileTransfers.map(ft =>
          ft.fileId === action.payload.fileId ? { ...ft, progress: action.payload.progress } : ft
        ),
      };
    case 'REMOVE_FILE_TRANSFER':
      return { ...state, fileTransfers: state.fileTransfers.filter(ft => ft.fileId !== action.payload) };
    case 'SET_FILE_TRANSFER_STATUS':
      return {
        ...state,
        fileTransfers: state.fileTransfers.map(ft =>
          ft.fileId === action.payload.fileId 
            ? { 
                ...ft, 
                status: action.payload.status, 
                downloadUrl: action.payload.downloadUrl || ft.downloadUrl,
                sourceDeviceId: action.payload.sourceDeviceId || ft.sourceDeviceId 
              } 
            : ft
        ),
      };
    case 'ADD_LINK':
      return { ...state, links: [action.payload, ...state.links.filter(l => l.url !== action.payload.url)].slice(0, 50) };
    case 'SET_LINKS':
      return { ...state, links: action.payload };
    case 'ADD_NOTE':
      return { ...state, notes: [action.payload, ...state.notes].slice(0, 50) };
    case 'SET_CHECKLIST':
      return { ...state, checklist: action.payload };
    case 'SET_ACTIVE_HANDOFF':
      return { ...state, activeHandoff: action.payload };
    case 'SET_PENDING_AUTH_PROMPT':
      return { ...state, pendingAuthPrompt: action.payload };
    case 'SET_PAIRING_STATUS':
      return { ...state, pairingStatus: action.payload };
    case 'SET_PAIRING_TOKEN':
      return { ...state, pairingToken: action.payload };
    case 'ADD_TRANSFER_REQUEST':
      return { ...state, transferRequests: [...state.transferRequests, action.payload] };
    case 'ACCEPT_TRANSFER':
      return { ...state, transferRequests: state.transferRequests.filter(tr => tr.fileId !== action.payload) };
    case 'DECLINE_TRANSFER':
      return { ...state, transferRequests: state.transferRequests.filter(tr => tr.fileId !== action.payload) };
    default:
      return state;
  }
}

// ─── Context ───────────────────────────────────────────────────────────────

export interface AppContextType {
   state: AppState;
   dispatch: React.Dispatch<AppAction>;
   sendMessage: (data: unknown) => boolean;
   reconnect: () => void;
   disconnect: () => void;
   // Clipboard
   lastSyncedText: string;
   lastSyncFrom: string;
   lastSyncTime: number;
   clipboardHistory: any[];
   pushClipboard: (text: string) => void;
   requestRemoteClipboard: () => void;
   clearClipboardHistory: () => void;
   isIOSPwa: boolean;
   // Toast
   toasts: any[];
   addToast: (message: string, type?: ToastType) => void;
   removeToast: (id: string) => void;
   // Actions
   renameDevice: (name: string) => void;
   sendLink: (url: string, title?: string) => void;
    respondToPairRequest: (deviceId: string, approved: boolean) => void;
    acceptFile: (request: TransferRequest) => void;
    declineFile: (request: TransferRequest) => void;
  shakeToSyncEnabled: boolean;
  enableShakeToSync: () => void;
  refreshQrCode: () => void;
  clearSavedCredentials: () => void;
  peerConnections: Map<string, RTCPeerConnection>;
};

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  const deviceNameRef = useRef(state.deviceName);
  const sendMessageRef = useRef<((data: unknown) => boolean) | null>(null);
  const clipboardSyncRef = useRef<any>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const badgeCountRef = useRef(0);
  const { toasts, addToast, removeToast } = useToast();

  const incrementBadge = useCallback(() => {
    badgeCountRef.current += 1;
    const setAppBadge = (navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void> }).setAppBadge;
    if (setAppBadge) {
      setAppBadge.call(navigator, badgeCountRef.current).catch(() => {});
    }
  }, []);

  useEffect(() => {
    stateRef.current = state;
    deviceNameRef.current = state.deviceName;
  }, [state]);

  const handleMessage = useCallback((data: any) => {
    const { type, payload } = data;

    const customEvent = new CustomEvent('goondrop_ws_message', { detail: data });
    window.dispatchEvent(customEvent);

    switch (type) {
      case 'handshake': {
        const savedDeviceId = window.localStorage.getItem('goondrop_device_id');
        const savedToken = window.localStorage.getItem('goondrop_token');
        const savedName = window.localStorage.getItem('goondrop_saved_name');
        
        deviceNameRef.current = savedName || `My ${getDeviceTypeStr() === 'iphone' ? 'iPhone' : getDeviceTypeStr() === 'windows' ? 'PC' : 'Device'}`;
        dispatch({ type: 'SET_DEVICE_NAME', payload: deviceNameRef.current });
        dispatch({ type: 'SET_PAIRING_CODE', payload: payload.pairingCode });

        const urlParams = new URLSearchParams(window.location.search);
        const urlPairCode = urlParams.get('pair');
        // ⚠️ Always persist the FRESH pairing code sent by the server. Stale codes
        // are the #1 cause of "I have to pair again every time" — the fallback
        // pair_request needs the correct code to auto-confirm without prompting.
        if (urlPairCode) {
          window.localStorage.setItem('goondrop_pairing_code', urlPairCode);
        } else if (payload.pairingCode) {
          window.localStorage.setItem('goondrop_pairing_code', payload.pairingCode);
        }
        const effectivePairCode = urlPairCode || window.localStorage.getItem('goondrop_pairing_code') || payload.pairingCode;

        if (savedDeviceId && savedToken) {
          dispatch({ type: 'SET_DEVICE_ID', payload: savedDeviceId });
          if (sendMessageRef.current) {
            sendMessageRef.current({
              type: 'pair_confirm',
              payload: { deviceId: savedDeviceId, token: savedToken, deviceName: deviceNameRef.current }
            });
          }
        } else {
          dispatch({ type: 'SET_DEVICE_ID', payload: payload.clientId });
          if (sendMessageRef.current) {
            sendMessageRef.current({
              type: 'pair_request',
              payload: { 
                deviceName: deviceNameRef.current, 
                deviceType: getDeviceTypeStr(),
                pairingCode: effectivePairCode
              },
            });
          }
        }
        break;
      }

      case 'paired': {
        dispatch({ type: 'SET_PAIRED', payload: true });
        dispatch({ type: 'SET_PAIRING_STATUS', payload: 'idle' });
        dispatch({ type: 'SET_PAIRING_TOKEN', payload: payload.token });
        
        window.localStorage.setItem('goondrop_device_id', payload.deviceId);
        window.localStorage.setItem('goondrop_token', payload.token);
        window.localStorage.setItem('goondrop_saved_name', deviceNameRef.current);

        if (payload.devices) dispatch({ type: 'SET_DEVICES', payload: payload.devices });
        announce('Connected to Goon Drop Server');
        addToast('Connected to Goon Drop', 'success');
        playChime('success');
        hapticFeedback([80, 50, 80]);

        if (!/iphone|ipad|ipod/i.test(navigator.userAgent) && 'Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission();
        }
        break;
      }

      case 'pairing_pending':
        dispatch({ type: 'SET_PAIRING_STATUS', payload: 'waiting' });
        addToast('Connection pending approval on your other devices...', 'info');
        playChime('chirp');
        hapticFeedback([100]);
        break;

      case 'pair_rejected':
        dispatch({ type: 'SET_PAIRING_STATUS', payload: 'rejected' });
        dispatch({ type: 'SET_PAIRED', payload: false });
        addToast('Connection request was denied', 'error');
        playChime('chirp');
        hapticFeedback([200, 100, 200]);
        break;

      case 'pair_auth_prompt':
        dispatch({ type: 'SET_PENDING_AUTH_PROMPT', payload: payload });
        addToast(`Device "${payload.deviceName}" wants to connect!`, 'info');
        announce(`Device ${payload.deviceName} wants to connect to Goon Drop`);
        playChime('notify');
        hapticFeedback([150, 100, 150]);

        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          showNativeNotification("Goon Drop Connect Request", {
            body: `Device "${payload.deviceName}" wants to connect to your Goon Drop network.`,
            icon: "/icons/icon-192.svg"
          });
        }
        break;

      case 'pair_auth_resolved':
        dispatch({ type: 'SET_PENDING_AUTH_PROMPT', payload: null });
        if (payload.approved) {
          addToast(`Device approved by ${payload.approverName}`, 'success');
          playChime('success');
          hapticFeedback([80, 50, 80]);
        } else {
          addToast('Connection request was dismissed', 'info');
          playChime('chirp');
          hapticFeedback([100]);
        }
        break;

      case 'device_list': {
        const st = stateRef.current;
        const oldDevices = st.devices;
        const newDevices = payload as Device[];
        
        if (oldDevices.length > 0) {
          newDevices.forEach(newDev => {
            const oldDev = oldDevices.find(d => d.id === newDev.id);
            if (newDev.connected && (!oldDev || !oldDev.connected) && newDev.id !== st.deviceId) {
              addToast(`${newDev.name} connected`, 'success');
              announceDeviceConnected(newDev.name);
              playChime('success');
              hapticFeedback([80, 40, 80]);
            }
          });

          oldDevices.forEach(oldDev => {
            const newDev = newDevices.find(d => d.id === oldDev.id);
            if (oldDev.connected && (!newDev || !newDev.connected) && oldDev.id !== st.deviceId) {
              addToast(`${oldDev.name} disconnected`, 'info');
              announceDeviceDisconnected(oldDev.name);
              playChime('chirp');
              hapticFeedback([100]);
            }
          });
        }

        dispatch({ type: 'SET_DEVICES', payload: payload });
        break;
      }

      case 'clipboard_push':
        if (clipboardSyncRef.current) clipboardSyncRef.current.handleIncomingClipboard(payload);
        incrementBadge();
        playChime('notify');
        hapticFeedback([60, 40, 60]);

        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          showNativeNotification("Clipboard Synced", {
            body: `Copied to clipboard from ${payload.sourceDeviceName || 'device'}.`,
            icon: "/icons/icon-192.svg"
          });
        }
        break;

      case 'clipboard_history':
        if (clipboardSyncRef.current) clipboardSyncRef.current.handleClipboardHistory(payload);
        break;

      case 'clipboard_request':
        if (clipboardSyncRef.current) clipboardSyncRef.current.pushLocalClipboard();
        break;

      case 'link_send': {
        const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
        const decUrl = decryptText(payload.url, key);
        const decTitle = payload.title ? decryptText(payload.title, key) : decUrl;

        dispatch({ type: 'ADD_LINK', payload: { url: decUrl, title: decTitle, timestamp: payload.timestamp, sourceDeviceName: payload.sourceDeviceName } });
        addToast(`Link received from ${payload.sourceDeviceName || 'another device'}`, 'info');
        announce(`Link received from ${payload.sourceDeviceName || 'another device'}`);
        incrementBadge();
        playChime('notify');
        hapticFeedback([60, 40, 60]);

        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          showNativeNotification("Link Received", {
            body: `${payload.sourceDeviceName || 'Device'} sent a link: ${decUrl}`,
            icon: "/icons/icon-192.svg"
          });
        }
        break;
      }

      case 'link_history':
        if (Array.isArray(payload)) dispatch({ type: 'SET_LINKS', payload });
        break;

      case 'file_meta':
        dispatch({ 
          type: 'ADD_TRANSFER_REQUEST', 
          payload: { 
            fileId: payload.fileId, 
            fileName: payload.fileName, 
            fileSize: payload.fileSize, 
            mimeType: payload.mimeType, 
            sourceDeviceName: payload.sourceDeviceName, 
            sourceDeviceId: payload.sourceDeviceId 
          } 
        });
        addToast(`Incoming file: ${payload.fileName} from ${payload.sourceDeviceName}`, 'info');
        incrementBadge();
        playChime('chirp');
        hapticFeedback([100]);

        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          showNativeNotification("Incoming File", {
            body: `${payload.sourceDeviceName || 'Device'} wants to share: ${payload.fileName}`,
            icon: "/icons/icon-192.svg"
          });
        }
        break;

      case 'file_complete':
        dispatch({ type: 'SET_FILE_TRANSFER_STATUS', payload: { fileId: payload.fileId, status: 'complete', downloadUrl: payload.downloadUrl, sourceDeviceId: payload.sourceDeviceId } });
        if (payload.downloadUrl) {
          const a = document.createElement('a');
          a.href = payload.downloadUrl;
          a.download = payload.fileName;
          a.click();
        }
        addToast(`File received: ${payload.fileName}`, 'success');
        announce(`File received: ${payload.fileName}`);
        incrementBadge();
        playChime('success');
        hapticFeedback([150]);

        if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          showNativeNotification("File Transfer Complete", {
            body: `Successfully received: ${payload.fileName}`,
            icon: "/icons/icon-192.svg"
          });
        }
        break;

      case 'file_progress':
        dispatch({
          type: 'UPDATE_FILE_PROGRESS',
          payload: {
            fileId: payload.fileId,
            progress: typeof payload.progress === 'number'
              ? Math.max(0, Math.min(1, payload.progress / (payload.progress > 1 ? 100 : 1)))
              : payload.totalBytes > 0 ? payload.bytesReceived / payload.totalBytes : 0,
          },
        });
        break;

      case 'file_cancel':
        dispatch({ type: 'SET_FILE_TRANSFER_STATUS', payload: { fileId: payload.fileId, status: 'cancelled' } });
        addToast('File transfer cancelled', 'error');
        break;

      case 'text_note': {
        const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
        const decText = decryptText(payload.text, key);

        dispatch({ type: 'ADD_NOTE', payload: { text: decText, timestamp: payload.timestamp || Date.now(), sourceDeviceName: payload.sourceDeviceName || 'Another Device' } });
        addToast(`Note from ${payload.sourceDeviceName || 'another device'}`, 'info');
        announce(`New note received from ${payload.sourceDeviceName || 'another device'}`);
        incrementBadge();
        playChime('chirp');
        hapticFeedback([80]);
      }
      break;

      case 'webrtc_offer': {
        const senderDeviceId = payload.senderDeviceId || payload.deviceId;
        const receiverDeviceId = payload.targetDeviceId || payload.deviceId;
        (async () => {
          try {
            const pc = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });
            peerConnectionsRef.current.set(receiverDeviceId, pc);
            
            pc.ontrack = (event) => {
              window.dispatchEvent(new CustomEvent('goondrop_webrtc_stream', { 
                detail: { 
                  stream: event.streams[0],
                  sourceDeviceId: senderDeviceId
                } 
              }));
            };

            pc.onconnectionstatechange = () => {
              if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                peerConnectionsRef.current.delete(receiverDeviceId);
                pc.close();
              }
            };

            pc.onicecandidate = (event) => {
              if (event.candidate) {
                sendMessageRef.current!({
                  type: 'webrtc_ice_candidate',
                  payload: {
                    targetDeviceId: senderDeviceId,
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex
                  }
                });
              }
            };

            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendMessageRef.current!({
              type: 'webrtc_answer',
              payload: {
                targetDeviceId: senderDeviceId,
                sdp: answer.sdp
              }
            });
          } catch (err) {
            console.error('WebRTC offer handling error:', err);
          }
        })();
        break;
      }

      case 'webrtc_answer': {
        (async () => {
          const pc = peerConnectionsRef.current.get(payload.targetDeviceId || payload.deviceId);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          }
        })();
        break;
      }

      case 'webrtc_ice_candidate': {
        (async () => {
          const pc = peerConnectionsRef.current.get(payload.targetDeviceId || payload.deviceId);
          if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate({
              candidate: payload.candidate,
              sdpMid: payload.sdpMid,
              sdpMLineIndex: payload.sdpMLineIndex
            }));
          }
        })();
        break;
      }

      case 'checklist_update':
        if (Array.isArray(payload)) {
          const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
          const decryptedChecklist = payload.map((item: any) => ({
            ...item,
            text: decryptText(item.text, key)
          }));
          dispatch({ type: 'SET_CHECKLIST', payload: decryptedChecklist });
        }
        break;


      case 'ping_phone':
        addToast('🔊 LAPTOP IS PINGING YOUR PHONE!', 'warning');
        playChime('notify');
        hapticFeedback([300, 100, 300, 100, 300, 100, 300, 100, 300]);
        break;

      case 'battery_info':
        if (payload?.level !== undefined) {
          addToast(`🔋 ${payload.deviceName || 'iPhone'} battery: ${payload.level}%`, payload.level <= 20 ? 'warning' : 'info');
          playChime('chirp');
        }
        break;

      case 'location_update':
        if (payload?.lat !== undefined && payload?.lng !== undefined) {
          addToast(`📍 ${payload.deviceName || 'iPhone'} shared their location`, 'info');
          playChime('chirp');
        }
        break;

      case 'nuclear_wipe':
        addToast('⚠️ NUCLEAR WIPE TRIGGERED! CLEARING SYSTEM...', 'error');
        playChime('chirp');
        hapticFeedback([500, 200, 500]);
        
        setTimeout(() => {
          window.localStorage.clear();
          window.sessionStorage.clear();
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(regs => {
              for (const reg of regs) reg.unregister();
              window.location.reload();
            }).catch(() => {
              window.location.reload();
            });
          } else {
            window.location.reload();
          }
        }, 1500);
        break;

      case 'init_state': {
        const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
        
        if (payload.checklist && Array.isArray(payload.checklist)) {
          const decChecklist = payload.checklist.map((item: any) => ({
            ...item,
            text: decryptText(item.text, key)
          }));
          dispatch({ type: 'SET_CHECKLIST', payload: decChecklist });
        }
        
        if (payload.links && Array.isArray(payload.links)) {
          const decLinks = payload.links.map((link: any) => ({
            ...link,
            url: decryptText(link.url, key),
            title: link.title ? decryptText(link.title, key) : ''
          }));
          dispatch({ type: 'SET_LINKS', payload: decLinks });
        }

        if (payload.clipboardHistory && Array.isArray(payload.clipboardHistory)) {
          const decHistory = payload.clipboardHistory.map((h: any) => ({
            ...h,
            text: decryptText(h.text, key)
          }));
          if (clipboardSyncRef.current) {
            clipboardSyncRef.current.handleClipboardHistory(decHistory);
          }
        }
        break;
      }

      case 'heartbeat':
        if (sendMessageRef.current) {
          sendMessageRef.current({
            type: 'heartbeat_ack',
            payload: { timestamp: Date.now() },
          });
        }
        break;

      case 'error':
        addToast(`Error: ${payload.message}`, 'error');
        announceError(payload.message);
        if (payload.code === 'PAIR_FAILED') {
          window.localStorage.removeItem('goondrop_device_id');
          window.localStorage.removeItem('goondrop_token');
          if (sendMessageRef.current) {
            sendMessageRef.current({
              type: 'pair_request',
              payload: { deviceName: deviceNameRef.current, deviceType: getDeviceTypeStr() },
            });
          }
        }
        break;
    }
  }, [addToast, state.deviceId, state.deviceName, state.paired, state.pairingCode, state.devices, state.links, state.notes, state.checklist, state.activeHandoff, state.pendingAuthPrompt, state.pairingStatus, state.pairingToken, state.transferRequests, state.fileTransfers]);

  const { status, send, reconnect: wsReconnect, disconnect: wsDisconnect } = useWebSocket({
    url: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    onMessage: handleMessage,
  });

  // Update refs when send function changes
  useEffect(() => {
    sendMessageRef.current = send;
  }, [send]);

  // Update connection status in state
  useEffect(() => {
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: status });
  }, [status]);

  const clipboardSync = useClipboardSync({
    sendMessage: send,
    isConnected: status === 'connected' && state.paired,
    isIOS: state.isIOS,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    addToast: addToast,
  });

  clipboardSyncRef.current = clipboardSync;

  // Fetch QR code when connected
  useEffect(() => {
    if (status === 'connected') {
      fetch('/api/qrcode')
        .then(r => r.json())
        .then(data => {
          dispatch({ type: 'SET_QR_CODE', payload: { qrCode: data.qrCode, pairingUrl: data.pairingUrl } });
          dispatch({ type: 'SET_PAIRING_CODE', payload: data.pairingCode });
        })
        .catch(() => {});
    }
  }, [status]);

  // Announce connection state changes
  useEffect(() => {
    if (status === 'connected') {
      announce('Connected to Goon Drop');
    } else if (status === 'disconnected') {
      announce('Disconnected from Goon Drop');
    } else if (status === 'reconnecting') {
      announce('Reconnecting to Goon Drop');
    }
  }, [status]);

  // Cross-device Battery Continuity Alerts
  useEffect(() => {
    let cleanUpRef: (() => void) | null = null;

    if (status === 'connected' && state.paired) {
      const navBattery = (navigator as any).getBattery;
      if (navBattery) {
        navBattery().then((battery: any) => {
          const checkBattery = () => {
            if (battery.level <= 0.20 && !battery.charging) {
              send({
                type: 'battery_alert',
                payload: { level: Math.round(battery.level * 100) }
              });
            }
          };

          battery.addEventListener('levelchange', checkBattery);
          battery.addEventListener('chargingchange', checkBattery);
          checkBattery();

          cleanUpRef = () => {
            battery.removeEventListener('levelchange', checkBattery);
            battery.removeEventListener('chargingchange', checkBattery);
          };
        }).catch(() => {});
      }
    }

    return () => {
      if (cleanUpRef) cleanUpRef();
    };
  }, [status, state.paired, send]);

  // Auto-(re)subscribe to Web Push for installed iOS PWAs when permission is
  // already granted — so background notifications keep working across sessions
  // without forcing another tap.
  useEffect(() => {
    if (status !== 'connected' || !state.paired || !state.deviceId) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || (window.navigator as any).standalone === true;
    if (!isStandalone) return;

    let cancelled = false;
    (async () => {
      try {
        const existing = await navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription());
        if (existing || cancelled) return;
        const pub = await (await fetch('/api/push/public-key')).json();
        await subscribeToPush(pub.publicKey, state.deviceId);
      } catch { }
    })();
    return () => { cancelled = true; };
  }, [status, state.paired, state.deviceId]);

  // iOS Native Shake-To-Sync Acceleration Hook!
  const [shakeToSyncEnabled, setShakeToSyncEnabled] = useState(false);
  const lastTimeRef = useRef(0);
  const lastXRef = useRef(0);
  const lastYRef = useRef(0);
  const lastZRef = useRef(0);

  const enableShakeToSync = useCallback(() => {
    const DeviceMotionEventClass = (window as any).DeviceMotionEvent;
    
    if (!DeviceMotionEventClass) {
      addToast('Shake to Sync requires an HTTPS connection or an installed PWA due to browser security.', 'warning');
      return;
    }

    if (typeof DeviceMotionEventClass.requestPermission === 'function') {
      DeviceMotionEventClass.requestPermission()
        .then((permissionState: string) => {
          if (permissionState === 'granted') {
            setShakeToSyncEnabled(true);
            addToast('Shake to Sync activated!', 'success');
            playChime('success');
            hapticFeedback([100, 50, 100]);
          } else {
            addToast('Motion sensor access denied.', 'error');
          }
        })
        .catch(() => {
          addToast('Could not request motion sensors.', 'error');
        });
    } else {
      setShakeToSyncEnabled(true);
      addToast('Shake to Sync activated!', 'success');
      playChime('success');
      hapticFeedback([100, 50, 100]);
    }
  }, [addToast]);

  useEffect(() => {
    if (!shakeToSyncEnabled) return;

    const handleMotion = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      if (!acc) return;
      
      const currentTime = Date.now();
      if ((currentTime - lastTimeRef.current) > 1000) { // throttle pings to 1s
        const x = acc.x || 0;
        const y = acc.y || 0;
        const z = acc.z || 0;

        const deltaX = Math.abs(x - lastXRef.current);
        const deltaY = Math.abs(y - lastYRef.current);
        const deltaZ = Math.abs(z - lastZRef.current);

        if (deltaX > 16 || deltaY > 16 || deltaZ > 16) {
          lastTimeRef.current = currentTime;
          
          clipboardSyncRef.current?.requestRemoteClipboard();
          addToast('Shake detected! Pulling clipboard...', 'info');
          playChime('notify');
          hapticFeedback([60, 40, 60]);
        }

        lastXRef.current = x;
        lastYRef.current = y;
        lastZRef.current = z;
      }
    };

    window.addEventListener('devicemotion', handleMotion);
    return () => window.removeEventListener('devicemotion', handleMotion);
  }, [shakeToSyncEnabled, addToast]);

  const renameDevice = useCallback((name: string) => {
    dispatch({ type: 'SET_DEVICE_NAME', payload: name });
    window.localStorage.setItem('goondrop_saved_name', name);
    if (sendMessageRef.current) {
      sendMessageRef.current({ type: 'rename_device', payload: { name } });
    }
  }, []);

  const sendLink = useCallback((url: string, title?: string) => {
    const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
    const encryptedUrl = encryptText(url, key);
    const encryptedTitle = title ? encryptText(title, key) : encryptText(url, key);

    if (sendMessageRef.current) {
      sendMessageRef.current({
        type: 'link_send',
        payload: { url: encryptedUrl, title: encryptedTitle, timestamp: Date.now(), sourceDeviceId: state.deviceId, sourceDeviceName: state.deviceName },
      });
    }
    addToast('Link sent', 'success');
  }, [state.deviceId, state.deviceName, addToast]);

  const respondToPairRequest = useCallback((targetDeviceId: string, approved: boolean) => {
    if (sendMessageRef.current) {
      sendMessageRef.current({
        type: 'pair_auth_decision',
        payload: { deviceId: targetDeviceId, approved },
      });
    }
    dispatch({ type: 'SET_PENDING_AUTH_PROMPT', payload: null });
  }, []);

  const acceptFile = useCallback((request: TransferRequest) => {
    if (sendMessageRef.current) {
      sendMessageRef.current({
        type: 'file_accept',
        payload: { fileId: request.fileId },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
    dispatch({ 
      type: 'ADD_FILE_TRANSFER', 
      payload: { 
        fileId: request.fileId, 
        fileName: request.fileName, 
        fileSize: request.fileSize, 
        mimeType: request.mimeType, 
        progress: 0, 
        status: 'receiving', 
        sourceDeviceName: request.sourceDeviceName, 
        sourceDeviceId: request.sourceDeviceId 
      } 
    });
    dispatch({ type: 'ACCEPT_TRANSFER', payload: request.fileId });
    addToast(`Accepting ${request.fileName}...`, 'info');
  }, [addToast]);

  const declineFile = useCallback((request: TransferRequest) => {
    if (sendMessageRef.current) {
      sendMessageRef.current({
        type: 'file_decline',
        payload: { fileId: request.fileId },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
    dispatch({ type: 'DECLINE_TRANSFER', payload: request.fileId });
    addToast(`Declined transfer of ${request.fileName}`, 'info');
  }, [addToast]);

  const refreshQrCode = useCallback(() => {
    if (sendMessageRef.current) {
      sendMessageRef.current({ type: 'fetch_qrcode' });
    }
  }, []);

  const clearSavedCredentials = useCallback(() => {
    window.localStorage.removeItem('goondrop_device_id');
    window.localStorage.removeItem('goondrop_token');
    window.localStorage.removeItem('goondrop_saved_name');
    dispatch({ type: 'SET_PAIRED', payload: false });
    dispatch({ type: 'SET_PAIRING_STATUS', payload: 'idle' });
  }, []);

  const value: AppContextType = {
    state,
    dispatch,
    sendMessage: send,
    reconnect: wsReconnect,
    disconnect: wsDisconnect,
    // Clipboard
    lastSyncedText: clipboardSync.lastSyncedText,
    lastSyncFrom: clipboardSync.lastSyncFrom,
    lastSyncTime: clipboardSync.lastSyncTime,
    clipboardHistory: clipboardSync.clipboardHistory,
    pushClipboard: clipboardSync.pushClipboard,
    requestRemoteClipboard: clipboardSync.requestRemoteClipboard,
    clearClipboardHistory: clipboardSync.clearClipboardHistory,
    isIOSPwa: clipboardSync.isIOSPwa,
    // Toast
    toasts,
    addToast,
    removeToast,
    // Actions
    renameDevice,
    sendLink,
    respondToPairRequest,
    acceptFile,
    declineFile,
    shakeToSyncEnabled,
    enableShakeToSync,
    refreshQrCode,
    clearSavedCredentials,
    peerConnections: peerConnectionsRef.current,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
      {/* Toast container rendered at provider level */}
    </AppContext.Provider>
  );
}

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
};
