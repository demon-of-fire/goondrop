/** WebSocket connection hook with auto-reconnect and heartbeat */
import { useEffect, useRef, useCallback, useState } from 'react';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

interface UseWebSocketOptions {
  url: string;
  onMessage: (data: any) => void;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  heartbeatInterval?: number;
}

interface UseWebSocketReturn {
  status: ConnectionStatus;
  send: (data: unknown) => boolean;
  reconnect: () => void;
  disconnect: () => void;
  reconnectAttempts: number;
}

export function useWebSocket({
  url,
  onMessage,
  reconnectInterval = 3000,
  maxReconnectAttempts = 20,
  heartbeatInterval = 10000,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onMessageRef = useRef(onMessage);
  const urlRef = useRef(url);
  const mountedRef = useRef(true);
  const intentionalCloseRef = useRef(false);

  // ⚠️ CRITICAL STALE CLOSURE FIX: Use a mutable ref to track reconnection attempts asynchronously!
  const reconnectAttemptsRef = useRef(0);

  onMessageRef.current = onMessage;
  urlRef.current = url;

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    intentionalCloseRef.current = false;

    // Determine WebSocket URL (handle dev proxy vs production)
    let wsUrl = urlRef.current;
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}${wsUrl}`;
    }

    setStatus(prev => prev === 'disconnected' ? 'connecting' : 'reconnecting');

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        wsRef.current = ws;
        setStatus('connected');
        
        // Reset reconnect attempts on successful connection
        reconnectAttemptsRef.current = 0;
        setReconnectAttempts(0);

        // Start heartbeat
        heartbeatTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat', payload: { timestamp: Date.now() }, id: 'hb-' + Date.now(), timestamp: Date.now() }));
          }
        }, heartbeatInterval);
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current(data);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        wsRef.current = null;
        clearTimers();

        if (!mountedRef.current) return;

        if (intentionalCloseRef.current) {
          setStatus('disconnected');
          return;
        }

        setStatus('reconnecting');
        
        // Increment attempts using the mutable ref!
        reconnectAttemptsRef.current++;
        setReconnectAttempts(reconnectAttemptsRef.current);

        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectTimerRef.current = setTimeout(() => {
            if (mountedRef.current) connect();
          }, reconnectInterval);
        } else {
          setStatus('failed');
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      setStatus('failed');
    }
  }, [clearTimers, heartbeatInterval, maxReconnectAttempts, reconnectInterval]);

  const send = useCallback((data: unknown): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      return true;
    }
    return false;
  }, []);

  const reconnect = useCallback(() => {
    intentionalCloseRef.current = false;
    if (wsRef.current) {
      wsRef.current.close();
    }
    clearTimers();
    setReconnectAttempts(0);
    connect();
  }, [clearTimers, connect]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearTimers();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, [clearTimers]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearTimers]);

  return { status, send, reconnect, disconnect, reconnectAttempts };
}
