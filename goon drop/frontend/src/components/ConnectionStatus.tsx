/** Connection status badge with screen reader support */
import React from 'react';
import { useAppContext } from '../contexts/AppContext';

export function ConnectionStatusBadge() {
  const { state, reconnect, disconnect } = useAppContext();
  const { connectionStatus, serverInfo } = state;

  const statusLabels: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting...',
    failed: 'Connection Failed',
  };

  const label = statusLabels[connectionStatus] || 'Unknown';

  return (
    <div
      className={`connection-badge ${connectionStatus}`}
      role="status"
      aria-label={`Goon Drop connection status: ${label}`}
      aria-live="polite"
    >
      <span className={`connection-dot ${connectionStatus}`} aria-hidden="true" />
      <span>{label}</span>
      {connectionStatus === 'failed' && (
        <button
          className="btn-ghost"
          onClick={reconnect}
          aria-label="Reconnect to Goon Drop Server"
          style={{ fontSize: 'var(--text-xs)', padding: '2px 8px', minHeight: 'auto' }}
        >
          Retry
        </button>
      )}
      {connectionStatus === 'connected' && (
        <button
          className="btn-ghost"
          onClick={disconnect}
          aria-label="Disconnect from Goon Drop Server"
          style={{ fontSize: 'var(--text-xs)', padding: '2px 8px', minHeight: 'auto' }}
        >
          Disconnect
        </button>
      )}
      {serverInfo && (
        <span className="sr-only">
          Server at {serverInfo.localIp}:{serverInfo.port}
        </span>
      )}
    </div>
  );
}
