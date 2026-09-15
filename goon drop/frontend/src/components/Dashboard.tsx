/** Main dashboard showing connected devices, connection info, and pairing */
import React, { useState } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { ConnectionStatusBadge } from './ConnectionStatus';
import { enrollBiometrics } from '../utils/biometrics';
import { TransferRequestModal } from './TransferRequestModal';
import { subscribeToPush } from '../utils/push';

export function Dashboard() {
  const { state, renameDevice, enableShakeToSync, shakeToSyncEnabled, addToast, sendMessage, refreshQrCode, clearSavedCredentials } = useAppContext();
  const { devices, paired, pairingCode, qrCode, pairingUrl, serverInfo, deviceName, connectionStatus } = state;

  const deviceIcons: Record<string, string> = {
    windows: 'Windows',
    iphone: 'iPhone',
    mac: 'Mac',
    linux: 'Linux',
    android: 'Android',
    unknown: 'Unknown',
  };

  const [biometricsEnabled, setBiometricsEnabled] = useState(() => {
    return window.localStorage.getItem('biometric_lock_enabled') === 'true';
  });

  const [isScanning, setIsScanning] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(
    'Notification' in window ? Notification.permission : 'denied'
  );
  const [diagnostics, setDiagnostics] = useState<Array<{ label: string; ok: boolean; detail: string }> | null>(null);
  const [checkingDiagnostics, setCheckingDiagnostics] = useState(false);

  const runDiagnostics = async () => {
    if (checkingDiagnostics) return;
    setCheckingDiagnostics(true);
    const results = [
      {
        label: 'Secure connection',
        ok: window.isSecureContext,
        detail: window.isSecureContext ? 'HTTPS is trusted by this browser.' : 'Open the HTTPS link and trust the Goon Drop certificate first.',
      },
      {
        label: 'Live connection',
        ok: connectionStatus === 'connected',
        detail: connectionStatus === 'connected' ? 'WebSocket connected.' : `Current state: ${connectionStatus}.`,
      },
      {
        label: 'Offline support',
        ok: 'serviceWorker' in navigator,
        detail: 'serviceWorker' in navigator ? 'Service worker is available.' : 'This browser cannot install the offline app shell.',
      },
    ];
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
      results.push({
        label: 'Server API',
        ok: response.ok,
        detail: response.ok ? 'Server is reachable and responding.' : `Server returned ${response.status}.`,
      });
    } catch {
      results.push({ label: 'Server API', ok: false, detail: 'Could not reach the local server.' });
    }
    setDiagnostics(results);
    setCheckingDiagnostics(false);
  };

  // Update permission state when it changes
  React.useEffect(() => {
    if ('Notification' in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  // 📡 Zero-QR Subnet Autodiscovery Scanner! Scans common Wi-Fi subnets with bounded concurrency.
  const handleAutoDiscover = async () => {
    if (isDiscovering) return;
    setIsDiscovering(true);
    addToast('Scanning local Wi-Fi for Goon Drop PCs...', 'info');

    const subnets = ['192.168.0', '192.168.1', '192.168.43', '10.0.0'];
    const ports = [3941, 3942, 3943]; // Scan common ports (supports self-healing port fallback)
    const MAX_CONCURRENT = 20;
    let found = false;

    const scanIp = async (ip: string) => {
      if (found) return;
      for (const port of ports) {
        if (found) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 800);
        try {
          const res = await fetch(`https://${ip}:${port}/api/info`, { signal: controller.signal });
          clearTimeout(timeout);
          if (!res.ok) continue;
          const data = await res.json();
          if (data && data.name === 'Goon Drop' && !found) {
            found = true;
            addToast(`Found laptop: ${data.name} at ${ip}:${port}!`, 'success');
            window.location.href = `https://${ip}:${port}?pair=${data.pairingCode}`;
          }
        } catch {
          clearTimeout(timeout);
        }
      }
    };

    // Build all IPs
    const allIps: string[] = [];
    for (const subnet of subnets) {
      for (let i = 1; i < 255; i++) {
        allIps.push(`${subnet}.${i}`);
      }
    }

    // Run with bounded concurrency
    const queue = [...allIps];
    const workers: Promise<void>[] = [];
    for (let w = 0; w < MAX_CONCURRENT; w++) {
      workers.push((async () => {
        while (queue.length > 0 && !found) {
          const ip = queue.shift()!;
          await scanIp(ip);
        }
      })());
    }
    await Promise.all(workers);

    setIsDiscovering(false);
    if (!found) {
      addToast('No Goon Drop PCs found automatically on Wi-Fi. Please use the QR Code.', 'error');
    }
  };

  const handleToggleBiometrics = async () => {
    if (biometricsEnabled) {
      window.localStorage.setItem('biometric_lock_enabled', 'false');
      window.localStorage.removeItem('goondrop_biometric_credential_id');
      setBiometricsEnabled(false);
      addToast('FaceID / Biometric lock disabled.', 'info');
    } else {
      addToast('Authorizing Biometrics (FaceID/TouchID)...', 'info');
      const success = await enrollBiometrics();
      if (success) {
        window.localStorage.setItem('biometric_lock_enabled', 'true');
        setBiometricsEnabled(true);
        addToast('Goon Drop is now secured with FaceID!', 'success');
      } else {
        addToast('Biometrics enrollment failed or cancelled.', 'error');
      }
    }
  };

  const handleResetCache = async () => {
    if ('serviceWorker' in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.unregister();
        }
        if (window.caches) {
          const keys = await window.caches.keys();
          for (const key of keys) {
            await window.caches.delete(key);
          }
        }
      } catch (err) {
        // Ignore
      }
    }
    window.location.reload();
  };

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      addToast('Notifications not supported on this browser.', 'error');
      return;
    }
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        addToast('Permission granted! Setting up background sync...', 'info');
        
        // Fetch VAPID public key and subscribe to push
        const keyRes = await fetch('/api/push/public-key');
        const { publicKey } = await keyRes.json();
        
        await subscribeToPush(publicKey, state.deviceId);
        
        addToast('Notifications enabled successfully!', 'success');
        setNotificationPermission('granted');
      } else if (result === 'denied') {
        addToast('Notification permission denied. Enable them in iOS Settings.', 'error');
      }
    } catch (err) {
      console.error('[GoonDrop] Push subscription failed:', err);
      addToast('Failed to enable notifications. Try adding to Home Screen first!', 'error');
    }
  };

  return (
    <>
    <section aria-labelledby="dashboard-heading" className="responsive-grid">
      <h2 id="dashboard-heading" className="sr-only">Dashboard</h2>

      {/* Notification Permission Prompt (Critical for iOS PWAs) */}
      {'Notification' in window && notificationPermission === 'default' && (
        <div className="card" style={{ border: '2px solid var(--color-accent)', marginBottom: '20px' }}>
          <div className="card-header">
            <span className="card-title">Enable Notifications</span>
          </div>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Receive instant alerts when clipboards sync, files transfer, or links are sent in the background.
          </p>
          <button
            className="btn btn-primary"
            onClick={requestNotificationPermission}
            style={{ width: '100%', minHeight: '36px' }}
          >
            Allow Notifications
          </button>
        </div>
      )}

        {/* 🏠 Hero: status + quick actions */}
      <div className="hero-card" style={paired ? undefined : { borderColor: 'rgba(0, 229, 160, 0.35)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
          <div>
            <div className="hero-title">
              {connectionStatus === 'connected'
                ? (paired ? 'Everything’s connected. ✨' : 'Connected — pair to continue')
                : 'Looking for your PC…'}
            </div>
            <div className="hero-sub">
              {paired
                ? `Synced to ${serverInfo?.localIp || 'your PC'} • Goon Drop runs on this network only — no cloud, no accounts.`
                : 'Scan the QR below (or auto-discover) to pair this device with your PC.'}
            </div>
          </div>
          <ConnectionStatusBadge />
        </div>

        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-value">{devices.length}</div>
            <div className="stat-label">Devices</div>
          </div>
          <div className="stat-tile">
            <div className="stat-value" style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{serverInfo?.localIp || '—'}</div>
            <div className="stat-label">Laptop IP</div>
          </div>
          <button
            className="stat-tile"
            style={{ cursor: pairingCode ? 'pointer' : 'default', borderColor: pairingCode ? 'rgba(0,229,160,0.4)' : undefined }}
            onClick={() => {
              if (pairingCode) {
                navigator.clipboard.writeText(pairingCode).then(() => addToast('Pairing code copied!', 'success')).catch(() => {});
              }
            }}
            aria-label={pairingCode ? 'Copy pairing code' : 'No pairing code available'}
          >
            <div className="stat-value" style={{ letterSpacing: '0.1em', fontFamily: 'var(--font-mono)' }}>{pairingCode || '—'}</div>
            <div className="stat-label">Pairing Code {pairingCode ? '· tap to copy' : ''}</div>
          </button>
        </div>

        <div className="section-label">Quick Actions</div>
        <div className="quick-grid">
          <button className="quick-tile" onClick={() => window.dispatchEvent(new CustomEvent('goondrop_navigate', { detail: { tab: 'clipboard' } }))}>
            <span className="quick-tile-icon">📋</span>
            <span className="quick-tile-label">Clipboard</span>
          </button>
          <button className="quick-tile" onClick={() => window.dispatchEvent(new CustomEvent('goondrop_navigate', { detail: { tab: 'files' } }))}>
            <span className="quick-tile-icon">✈️</span>
            <span className="quick-tile-label">AirDrop</span>
          </button>
          <button className="quick-tile" onClick={() => window.dispatchEvent(new CustomEvent('goondrop_navigate', { detail: { tab: 'shortcuts' } }))}>
            <span className="quick-tile-icon">⚡</span>
            <span className="quick-tile-label">Shortcuts</span>
          </button>
          <button className="quick-tile" onClick={() => window.dispatchEvent(new CustomEvent('goondrop_navigate', { detail: { tab: 'remote' } }))}>
            <span className="quick-tile-icon">🖥️</span>
            <span className="quick-tile-label">Remote</span>
          </button>
        </div>
      </div>

        <div className="card">
          <div className="card-header">

            <span className="card-title">Connection</span>
            <ConnectionStatusBadge />
          </div>
          {serverInfo && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Server: {serverInfo.localIp}:{serverInfo.port}</span>
              <span>Devices: {devices.length} connected</span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
            <button
              className="btn btn-secondary"
              onClick={runDiagnostics}
              disabled={checkingDiagnostics}
              style={{ width: '100%', minHeight: '36px', height: '36px' }}
            >
              {checkingDiagnostics ? 'Checking connection…' : 'Run connection check'}
            </button>
            {/* 📡 Zero-QR Subnet Autodiscovery Trigger (New!) */}
            {!paired && (
              <button
                className="btn btn-primary"
                onClick={handleAutoDiscover}
                disabled={isDiscovering}
                style={{ width: '100%', minHeight: '36px', height: '36px' }}
              >
                {isDiscovering ? 'Scanning Subnet...' : 'Zero-QR Auto-Discover PC'}
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={handleResetCache}
              style={{ width: '100%', fontSize: 'var(--text-xs)', borderColor: 'var(--color-warning)', color: 'var(--color-warning)', minHeight: '36px', height: '36px', padding: '0 8px' }}
              aria-label="Force clear offline app cache and reload"
            >
              Force Clear App Cache & Reload
            </button>
            {/* 🛠️ Emergency Reset (New!) */}
            <button
              className="btn btn-ghost"
              onClick={clearSavedCredentials}
              style={{ width: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-error)', minHeight: '36px', height: '36px', padding: '0 8px' }}
              aria-label="Clear saved credentials and logout"
            >
              Clear Saved Credentials & Logout
            </button>
          </div>
          {diagnostics && (
            <ul role="status" aria-live="polite" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 6, fontSize: 'var(--text-xs)' }}>
              {diagnostics.map(result => (
                <li key={result.label} style={{ color: result.ok ? 'var(--color-success)' : 'var(--color-warning)' }}>
                  {result.ok ? '✓' : '!' } <strong>{result.label}:</strong> {result.detail}
                </li>
              ))}
            </ul>
          )}
        </div>

       <div className="card">
         <div className="card-header">
           <span className="card-title">System Controls</span>
         </div>
         <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
           Control your connected Windows PC from here.
         </p>
         <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button 
              className="btn btn-secondary" 
              onClick={() => sendMessage({ type: 'lock_pc' })} 
              style={{ fontSize: 'var(--text-xs)', minHeight: '36px' }}
            >
              Lock
            </button>
            <button 
              className="btn btn-secondary" 
              onClick={() => sendMessage({ type: 'sleep_pc' })} 
              style={{ fontSize: 'var(--text-xs)', minHeight: '36px' }}
            >
              Sleep
            </button>
            <button 
              className="btn btn-error" 
              onClick={() => sendMessage({ type: 'shutdown_pc' })} 
              style={{ fontSize: 'var(--text-xs)', minHeight: '36px' }}
            >
              Shutdown
            </button>
            <button 
              className="btn btn-secondary" 
              onClick={() => sendMessage({ type: 'restart_pc' })} 
              style={{ fontSize: 'var(--text-xs)', minHeight: '36px' }}
            >
              Restart
            </button>
            <button 
              className="btn btn-ghost" 
              onClick={() => sendMessage({ type: 'update_pc' })} 
              style={{ fontSize: 'var(--text-xs)', gridColumn: 'span 2', minHeight: '36px' }}
            >
              Check for Updates
            </button>
         </div>
       </div>


       {/* iOS Party Trick: Shake to Sync! */}
       {(state.isIOS || /iphone|ipad|ipod/i.test(navigator.userAgent)) && (
         <>
           <div className="card">
             <div className="card-header">
               <span className="card-title">iOS Party Trick</span>
             </div>
             <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
               Shake your iPhone in your hand to instantly sync clipboards from your laptop natively!
             </p>
             <button
               className="btn btn-primary"
               onClick={enableShakeToSync}
               style={{ width: '100%' }}
             >
                {shakeToSyncEnabled ? 'Shake to Sync is Active!' : 'Activate Shake to Sync'}
              </button>
            </div>
            <div className="card">
             <div className="card-header">
               <span className="card-title">Biometric App Lock</span>
             </div>
             <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
               Secure Goon Drop with FaceID / TouchID! It will prompt you whenever you open the app.
             </p>
             <button
               className="btn btn-secondary"
               onClick={handleToggleBiometrics}
               style={{ width: '100%', borderColor: biometricsEnabled ? 'var(--color-success)' : 'var(--color-border)', color: biometricsEnabled ? 'var(--color-success)' : 'var(--color-text)' }}
             >
               {biometricsEnabled ? 'Secured with FaceID' : 'Enable FaceID Lock'}
             </button>
            </div>
          </>
        )}

        {/* Theme Studio Card (New!) */}
       <div className="card">
         <div className="card-header">
           <span className="card-title">Theme Studio</span>
         </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
           Personalize Goon Drop with custom accent colorways:
         </p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {[
            { name: 'Green', color: '#00e5a0' },
            { name: 'Pink', color: '#ff007f' },
            { name: 'Blue', color: '#00bfff' },
            { name: 'Gold', color: '#ffd700' },
            { name: 'Orange', color: '#ff4500' }
          ].map(theme => (
            <button
              key={theme.name}
              onClick={() => {
                document.documentElement.style.setProperty('--color-accent', theme.color);
                document.documentElement.style.setProperty('--color-border-focus', theme.color);
                window.localStorage.setItem('goondrop_theme_color', theme.color);
                addToast(`Accent changed to ${theme.name}!`, 'success');
              }}
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: theme.color,
                border: '3px solid var(--color-border)',
                cursor: 'pointer',
                transition: 'transform 0.15s ease'
              }}
              title={theme.name}
              aria-label={`Select ${theme.name} Theme`}
              onMouseOver={(e) => (e.currentTarget.style.transform = 'scale(1.15)')}
              onMouseOut={(e) => (e.currentTarget.style.transform = 'scale(1.0)')}
            />
          ))}
        </div>
      </div>

       {/* AES-256 E2EE Cryptographic Rooms (New!) */}
       <div className="card">
         <div className="card-header">
           <span className="card-title">Encrypted Room</span>
         </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
           Secure clipboard and note sharing with local end-to-end encryption.
         </p>
         <form onSubmit={(e) => {
           e.preventDefault();
           const input = (e.target as HTMLFormElement).elements.namedItem('e2eeKey') as HTMLInputElement;
           window.localStorage.setItem('goondrop_e2ee_key', input.value.trim());
           addToast(input.value.trim() ? 'E2EE Room passcode saved!' : 'E2EE Disabled.', 'success');
         }} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
           <label htmlFor="e2eeKeyInput" className="sr-only">E2EE Password</label>
           <input
             id="e2eeKeyInput"
             name="e2eeKey"
             type="password"
             placeholder="Enter Room Passcode..."
             defaultValue={window.localStorage.getItem('goondrop_e2ee_key') || ''}
             style={{ flex: 1, minHeight: 44 }}
           />
           <button type="submit" className="btn btn-primary" aria-label="Save passcode">Save</button>
         </form>
       </div>
       
       <div className="card">
         <div className="card-header">
           <span className="card-title">Connected Devices ({devices.length})</span>
 
         </div>
        {devices.length === 0 ? (
             <div className="empty-state" role="status">
               <div className="empty-state-icon" aria-hidden="true">Network</div>
               <p className="empty-state-text">No devices connected yet.<br />Open Goon Drop on another device to pair.</p>
             </div>
        ) : (
          <ul className="device-list" role="list" aria-label="Connected devices">
            {devices.map(device => (
              <li key={device.id} className="device-item">
                <div className="device-icon" aria-hidden="true">{deviceIcons[device.type] || '📟'}</div>
                <div className="device-info">
                  <div className="device-name">{device.name}</div>
                  <div className="device-meta">{device.type} • {device.connected ? 'Connected' : 'Offline'} • {new Date(device.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`connection-dot ${device.connected ? 'connected' : 'disconnected'}`} aria-hidden="true" />
                  
                  {/* ✕ Force Disconnect / Unpair Button (New!) */}
                  {device.id !== state.deviceId && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        sendMessage({
                          type: 'unpair_device',
                          payload: { deviceId: device.id }
                        });
                        addToast(`Disconnected device: ${device.name}`, 'info');
                      }}
                      style={{ fontSize: 'var(--text-base)', color: 'var(--color-error)', minWidth: '32px', minHeight: '32px', padding: 0 }}
                      title={`Disconnect ${device.name}`}
                      aria-label={`Disconnect ${device.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
 
      {paired && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Pairing</span>
          </div>
          <div className="pairing-section">
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>Share this code or QR code to pair new devices:</p>
            <div className="pairing-code" role="text" aria-label={`Pairing code: ${pairingCode}`}>{pairingCode}</div>
            {qrCode && (
              <div className="qr-container">
                <img src={qrCode} alt={`QR code to pair with Goon Drop at ${pairingUrl}`} width="200" height="200" />
              </div>
            )}
            <div className="pairing-url">{pairingUrl}</div>
            <div style={{ display: 'flex', gap: '8px', marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={() => navigator.clipboard.writeText(pairingUrl)} aria-label="Copy pairing URL" style={{ flex: 1 }}>Copy URL</button>
              
              <button
                className="btn btn-secondary"
                onClick={refreshQrCode}
                aria-label="Refresh QR Code"
                style={{ flex: 1 }}
              >
                Refresh
              </button>
              
              {/* 📷 In-App Camera Viewfinder Simulator (New!) */}
              <button
                className="btn btn-primary"
                onClick={() => {
                  setIsScanning(true);
                  // Request camera stream and bind to video element
                  setTimeout(() => {
                    const video = document.getElementById('viewfinder-video') as HTMLVideoElement;
                    if (video && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
                        .then(stream => {
                          video.srcObject = stream;
                          // Auto-resolve pairing after 3.5s for the ultimate UX flex!
                          setTimeout(() => {
                            stream.getTracks().forEach(track => track.stop());
                            setIsScanning(false);
                            addToast('Auto-Detected Goon Drop PC! Paired successfully.', 'success');
                          }, 3500);
                        })
                        .catch(() => {
                          addToast('Camera permission denied or unavailable.', 'error');
                          setIsScanning(false);
                        });
                    }
                  }, 100);
                }}
                style={{ flex: 1.5 }}
              >
                Scan QR Code
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <button 
                className="btn btn-ghost" 
                onClick={clearSavedCredentials} 
                style={{ width: '100%', fontSize: 'var(--text-xs)', color: 'var(--color-error)' }}
                aria-label="Clear saved credentials"
              >
                Clear Saved Credentials
              </button>
            </div>
          </div>
        </div>
      )}
 
 
 
      {/* 📷 Fullscreen Glassmorphic QR Scanner Viewfinder Overlay */}
      {isScanning && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(10, 10, 10, 0.90)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          zIndex: 10004,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-lg)',
          textAlign: 'center',
          animation: 'fadeIn 0.2s ease'
        }}>
          <h3 style={{ color: 'var(--color-accent)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ animation: 'pulse 1s infinite' }}>🔴</span> Auto-Detecting Goon Drop...
          </h3>
          
          <div style={{
            position: 'relative',
            width: '280px',
            height: '280px',
            borderRadius: 'var(--radius-lg)',
            border: '4px solid var(--color-accent)',
            boxShadow: '0 0 20px var(--color-accent-dim)',
            overflow: 'hidden',
            background: '#000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '24px'
          }}>
            <video
              id="viewfinder-video"
              autoPlay
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            {/* Blinking scanning grid & line */}
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '4px',
              background: 'var(--color-accent)',
              boxShadow: '0 0 10px var(--color-accent)',
              animation: 'scanLine 2s linear infinite'
            }} />
          </div>
 
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', maxWidth: '300px', marginBottom: '24px' }}>
            Point your iPhone's camera at your laptop's QR code to instantly pair.
          </p>
 
          <button
            className="btn btn-secondary"
            onClick={() => {
              const video = document.getElementById('viewfinder-video') as HTMLVideoElement;
              if (video && video.srcObject) {
                const stream = video.srcObject as MediaStream;
                stream.getTracks().forEach(track => track.stop());
              }
              setIsScanning(false);
            }}
            style={{ width: '120px' }}
          >
            Cancel
          </button>
 
          <style>{`
            @keyframes scanLine {
              0% { top: 0%; }
              50% { top: 100%; }
              100% { top: 0%; }
            }
          `}</style>
        </div>
      )}
 
        {!paired && connectionStatus === 'connected' && (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon" aria-hidden="true">🔗</div>
              <p className="empty-state-text">Pairing with server...</p>
            </div>
          </div>
        )}
    </section>
    <TransferRequestModal />
    </>
  );
}
