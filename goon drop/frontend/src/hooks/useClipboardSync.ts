/** Clipboard sync hook - handles automatic and manual clipboard sync with iOS awareness */
import { useState, useCallback, useEffect, useRef } from 'react';
import { readClipboard, writeClipboard, hashClipboard, isIOSPwa } from '../utils/clipboard';
import { decryptText, encryptText } from '../utils/crypto';
import { announceClipboardSync } from '../utils/accessibility';

interface ClipboardEntry {
  text: string;
  hash: string;
  timestamp: number;
  sourceDeviceName: string;
  type: 'text' | 'url' | 'rich';
}

interface UseClipboardSyncOptions {
  sendMessage: (data: unknown) => boolean;
  isConnected: boolean;
  isIOS: boolean;
  deviceId: string;
  deviceName: string;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

interface UseClipboardSyncReturn {
  lastSyncedText: string;
  lastSyncFrom: string;
  lastSyncTime: number;
  clipboardHistory: ClipboardEntry[];
  pushClipboard: (text: string) => void;
  requestRemoteClipboard: () => void;
  handleIncomingClipboard: (payload: any) => void;
  handleClipboardHistory: (payload: ClipboardEntry[]) => void;
  pushLocalClipboard: () => void;
  clearClipboardHistory: () => void;
  isIOSPwa: boolean;

}

export function useClipboardSync({
  sendMessage,
  isConnected,
  isIOS,
  deviceId,
  deviceName,
  addToast,
}: UseClipboardSyncOptions): UseClipboardSyncReturn {
  const [lastSyncedText, setLastSyncedText] = useState('');
  const [lastSyncFrom, setLastSyncFrom] = useState('');
  const [lastSyncTime, setLastSyncTime] = useState(0);
  const [clipboardHistory, setClipboardHistory] = useState<ClipboardEntry[]>([]);
  const lastHashRef = useRef('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isIOSDevice = isIOS || isIOSPwa();

  /**
   * Push clipboard content to other devices.
   * Called either automatically (Windows) or manually (iOS).
   */
  const pushClipboard = useCallback((text: string) => {
    if (!text || !isConnected) return;

    const hash = hashClipboard(text);
    if (hash === lastHashRef.current) return; // Deduplicate

    lastHashRef.current = hash;

    const type = /^(https?:\/\/|www\.)[^\s]+$/i.test(text.trim()) ? 'url' : 'text';
    
    // Encrypt outgoing clipboard if passcode exists!
    const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
    const encryptedText = encryptText(text, key);

    sendMessage({
      type: 'clipboard_push',
      payload: { text: encryptedText, hash, type },
    });

    setLastSyncedText(text);
    setLastSyncFrom(deviceName);
    setLastSyncTime(Date.now());
  }, [sendMessage, isConnected, deviceName]);

  /**
   * Request clipboard from a remote device.
   * Triggers the other device to push its clipboard.
   */
  const requestRemoteClipboard = useCallback(() => {
    if (!isConnected) return;
    sendMessage({ type: 'clipboard_request', payload: {} });
  }, [sendMessage, isConnected]);

  /**
   * Handle incoming clipboard data from another device.
   */
  const handleIncomingClipboard = useCallback((payload: any) => {
    const { text, hash, sourceDeviceName, type } = payload;

    if (!text) return;

    // Decrypt incoming clipboard if locked!
    const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
    const decryptedText = decryptText(text, key);

    // Deduplicate
    const localHash = hashClipboard(decryptedText);
    if (localHash === lastHashRef.current) return;

    lastHashRef.current = hash || localHash;

    // Write to local clipboard with user feedback
    writeClipboard(decryptedText).then(res => {
      if (res.success) {
        addToast(`Clipboard auto-copied from ${sourceDeviceName || 'device'}!`, 'success');
      } else {
        // Fallback for browsers that block background writes (e.g. non-secure LAN IPs)
        addToast(`Clipboard synced from ${sourceDeviceName}! Tap "Copy" to save.`, 'info');
      }
    });

    setLastSyncedText(decryptedText);
    setLastSyncFrom(sourceDeviceName || 'Unknown');
    setLastSyncTime(Date.now());

    // Add to history
    setClipboardHistory(prev => {
      const entry: ClipboardEntry = {
        text: decryptedText,
        hash: hash || localHash,
        timestamp: Date.now(),
        sourceDeviceName: sourceDeviceName || 'Unknown',
        type: type || 'text',
      };
      const updated = [entry, ...prev.filter(e => e.hash !== entry.hash)].slice(0, 50);
      return updated;
    });

    announceClipboardSync(sourceDeviceName || 'another device');
  }, []);

  /**
   * Handle incoming clipboard history from server.
   */
  const handleClipboardHistory = useCallback((payload: ClipboardEntry[]) => {
    if (Array.isArray(payload)) {
      const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
      const decrypted = payload.map(e => ({
        ...e,
        text: decryptText(e.text, key),
      }));
      setClipboardHistory(decrypted);
    }
  }, []);

  /**
   * Read the local clipboard and push it (responsive to request).
   */
  const pushLocalClipboard = useCallback(async () => {
    const result = await readClipboard();
    if (result.success && result.text) {
      pushClipboard(result.text);
    }
  }, [pushClipboard]);

  /**
   * Clear clipboard history.
   */
  const clearClipboardHistory = useCallback(() => {
    setClipboardHistory([]);
    sendMessage({ type: 'clipboard_clear', payload: {} });
  }, [sendMessage]);

  /**
   * iOS PWA: Poll clipboard periodically while app is active/focused.
   * Windows: Poll is more aggressive but still respects focus.
   */
  useEffect(() => {
    if (!isConnected) return;

    // iOS PWAs cannot background-poll. Only poll while focused.
    const shouldPoll = isIOSDevice
      ? document.visibilityState === 'visible'
      : true;

    if (!shouldPoll) return;

    const pollInterval = isIOSDevice ? 3000 : 2000; // iOS polls less aggressively

    const pollClipboard = async () => {
      if (!isConnected) return;
      if (isIOSDevice && document.visibilityState !== 'visible') return;

      const result = await readClipboard();
      if (result.success && result.text) {
        const hash = hashClipboard(result.text);
        if (hash !== lastHashRef.current) {
          pushClipboard(result.text);
        }
      }
    };

    if (isIOSDevice) {
      // iOS: Only start polling when visibility is visible
      const handleVisibility = () => {
        if (document.visibilityState === 'visible') {
          pollTimerRef.current = setInterval(pollClipboard, pollInterval);
        } else {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      };

      handleVisibility();
      document.addEventListener('visibilitychange', handleVisibility);

      return () => {
        document.removeEventListener('visibilitychange', handleVisibility);
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      };
    } else {
      // Windows: Poll continuously (but less aggressively if not focused)
      pollTimerRef.current = setInterval(pollClipboard, pollInterval);

      return () => {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      };
    }
  }, [isConnected, isIOSDevice, pushClipboard]);

  return {
    lastSyncedText,
    lastSyncFrom,
    lastSyncTime,
    clipboardHistory,
    pushClipboard,
    requestRemoteClipboard,
    handleIncomingClipboard,
    handleClipboardHistory,
    pushLocalClipboard,
    clearClipboardHistory,
    isIOSPwa: isIOSDevice,
  };
}
