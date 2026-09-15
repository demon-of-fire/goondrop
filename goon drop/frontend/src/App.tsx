/** Main App component - tab-based navigation between features */
const APP_BUILD = '2026-05-28-v1';
import React, { useState } from 'react';
import { AppProvider, useAppContext } from './contexts/AppContext';
import { Dashboard } from './components/Dashboard';
import { ClipboardPanel } from './components/ClipboardPanel';
import { FileShare } from './components/FileShare';
import { LinkHandoff } from './components/LinkHandoff';
import { TextNotes } from './components/TextNotes';
import { ToastContainer } from './components/ToastContainer';
import { verifyBiometrics } from './utils/biometrics';
import { resumeGlobalAudio } from './utils/sound';

import { PCRemote } from './components/PCRemote';
import { ChatRoom } from './components/ChatRoom';
import { MediaReceiver } from './components/MediaReceiver';
import { PCMediaReceiver } from './components/PCMediaReceiver';
import { ShortcutsHub } from './components/ShortcutsHub';

type TabId = 'dashboard' | 'files' | 'clipboard' | 'links' | 'shortcuts' | 'remote' | 'notes' | 'chat';

interface Tab {
  id: TabId;
  label: string;
  icon: string;
}

const tabs: Tab[] = [
  { id: 'dashboard', label: 'Home', icon: '🏠' },
  { id: 'files', label: 'AirDrop', icon: '✈️' },
  { id: 'clipboard', label: 'Clipboard', icon: '📋' },
  { id: 'links', label: 'Handoff', icon: '🖇️' },
  { id: 'shortcuts', label: 'Shortcuts', icon: '⚡' },
  { id: 'remote', label: 'Remote', icon: '🖥️' },
  { id: 'notes', label: 'Notes', icon: '🗒️' },
  { id: 'chat', label: 'Chat', icon: '💬' },
];

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const { state, dispatch, reconnect, respondToPairRequest, addToast } = useAppContext();
  const { connectionStatus, pendingAuthPrompt, pairingStatus, paired } = state;

  console.log(`[GoonDrop] App build: ${APP_BUILD}, version: ${state.serverInfo?.version || '?'}, paired: ${state.paired}`);

  // Biometric FaceID/TouchID secure lock state!
  const [isLocked, setIsLocked] = useState(() => {
    return window.localStorage.getItem('biometric_lock_enabled') === 'true';
  });
  const [bypassCode, setBypassCode] = useState('');

  const isBiometricsSupported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

  const handleUnlockBiometrics = async () => {
    if (!isBiometricsSupported) {
      addToast('Biometrics are not supported on this browser or origin.', 'error');
      return;
    }
    const success = await verifyBiometrics();
    if (success) {
      setIsLocked(false);
      addToast('App unlocked via Biometrics!', 'success');
    } else {
      addToast('FaceID/Biometrics verification failed.', 'error');
    }
  };

  const handleBypassCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (state.pairingCode && bypassCode.trim().toUpperCase() === state.pairingCode.toUpperCase()) {
      setIsLocked(false);
      addToast('Bypassed lock using Laptop Pairing Code!', 'success');
      setBypassCode('');
    } else {
      addToast(state.pairingCode ? 'Invalid pairing passcode.' : 'Server offline. Cannot verify pairing code.', 'error');
    }
  };

  // Trigger FaceID prompt automatically on mount if locked!
  React.useEffect(() => {
    if (isLocked && isBiometricsSupported) {
      handleUnlockBiometrics();
    }
  }, []);

  // Handle PWA shortcuts, the share-in URL used by iOS Shortcuts, and iOS audio unlocking.
  React.useEffect(() => {
    const checkPwaIntents = () => {
      const params = new URLSearchParams(window.location.search);
      
      // 1. Long-press Home Screen App Shortcuts
      const tabParam = params.get('tab') as TabId;
      if (tabParam && tabs.some(t => t.id === tabParam)) {
        setActiveTab(tabParam);
      }

      // 1b. Web Share Target file/text result (redirected here by SW after processing)
      if (params.get('share') === 'received') {
        try {
          const lastShare = localStorage.getItem('goondrop_last_share');
          if (lastShare) {
            const shareData = JSON.parse(lastShare);
            if (shareData.fileStatuses && shareData.fileStatuses.length > 0) {
              const successCount = shareData.fileStatuses.filter((s: any) => s.status === 'success').length;
              addToast(`Shared ${successCount} file${successCount !== 1 ? 's' : ''} to PC!`, 'success');
              setActiveTab('files');
            } else if (shareData.url) {
              setActiveTab('links');
              window.sessionStorage.setItem('shared_content_link', shareData.url);
              window.dispatchEvent(new CustomEvent('goondrop_shared_content', { detail: { type: 'link', content: shareData.url } }));
            } else if (shareData.text) {
              setActiveTab('clipboard');
              window.sessionStorage.setItem('shared_content_text', shareData.text);
              window.dispatchEvent(new CustomEvent('goondrop_shared_content', { detail: { type: 'text', content: shareData.text } }));
            }
          }
        } catch (err) { }
      }

      // 2. Share-in route. Browsers with Web Share Target support can invoke this
      // directly; iPhone users can invoke it from an iOS Shortcut.
      const shareParam = params.get('share');
      if (shareParam && shareParam !== 'received') {
        const sharedTitle = params.get('title');
        const sharedText = params.get('text');
        const sharedUrl = params.get('url');

        const content = sharedUrl || sharedText || sharedTitle;
        if (content) {
          const isUrl = /^(https?:\/\/|www\.)[^\s]+$/i.test(content.trim()) || content.startsWith('http://') || content.startsWith('https://');
          
          if (isUrl) {
            setActiveTab('links');
            window.sessionStorage.setItem('shared_content_link', content);
            window.dispatchEvent(new CustomEvent('goondrop_shared_content', { detail: { type: 'link', content } }));
          } else {
            setActiveTab('clipboard');
            window.sessionStorage.setItem('shared_content_text', content);
            window.dispatchEvent(new CustomEvent('goondrop_shared_content', { detail: { type: 'text', content } }));
          }
        }
      }
    };

    checkPwaIntents();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkPwaIntents();
        // Re-prime audio when app returns to foreground (iOS suspends on background)
        resumeGlobalAudio();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('popstate', checkPwaIntents);

    // 3. ⚠️ CRITICAL IOS WEB AUDIO UNLOCK on first user interaction
    // Also request Notification permission here (must be from user gesture on iOS)
    const unlockAudio = () => {
      resumeGlobalAudio();
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('click', unlockAudio);
    window.addEventListener('touchstart', unlockAudio);

    // 4. iOS Diagnostic logging
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      console.log('[GoonDrop iOS] User Agent:', navigator.userAgent);
      console.log('[GoonDrop iOS] AudioContext support:', !!window.AudioContext);
      console.log('[GoonDrop iOS] Navigator.vibrate support:', !!navigator.vibrate);
      console.log('[GoonDrop iOS] Notification support:', 'Notification' in window);
      console.log('[GoonDrop iOS] Service Worker support:', 'serviceWorker' in navigator);
      console.log('[GoonDrop iOS] PWA display mode:', (window.navigator as any).standalone ? 'standalone' : 'browser');
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('popstate', checkPwaIntents);
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
  }, [addToast]);

  // Load saved theme accent on mount!
  React.useEffect(() => {
    const savedTheme = window.localStorage.getItem('goondrop_theme_color');
    if (savedTheme) {
      document.documentElement.style.setProperty('--color-accent', savedTheme);
      document.documentElement.style.setProperty('--color-border-focus', savedTheme);
    }
  }, []);

  // Shortcuts metadata connections
  React.useEffect(() => {
    const handleNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const target = detail?.tab as TabId;
      if (target && tabs.some(t => t.id === target)) {
        setActiveTab(target);
      }
    };
    window.addEventListener('goondrop_navigate' as any, handleNavigate);
    return () => window.removeEventListener('goondrop_navigate' as any, handleNavigate);
  }, []);

  // ⚠️ CRITICAL ACCESSIBILITY UPGRADE: Global Browser Keyboard Jump-Keys!
  // Allows screen-reader, motor-impaired, and power-users to jump between tabs instantly from anywhere.
  React.useEffect(() => {
    const handleGlobalKeys = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey) {
        const key = e.key;
        if (key === '1') { setActiveTab('dashboard'); addToast('Jumped to Home', 'info'); }
        else if (key === '2') { setActiveTab('clipboard'); addToast('Jumped to Clipboard', 'info'); }
        else if (key === '3') { setActiveTab('files'); addToast('Jumped to Files & Cam', 'info'); }
        else if (key === '4') { setActiveTab('links'); addToast('Jumped to Links', 'info'); }
        else if (key === '5') { setActiveTab('shortcuts'); addToast('Jumped to Shortcuts', 'info'); }
        else if (key === '6') { setActiveTab('notes'); addToast('Jumped to Notes & Tasks', 'info'); }
        else if (key === '7') { setActiveTab('remote'); addToast('Jumped to PC Remote', 'info'); }
        else if (key === '8') { setActiveTab('chat'); addToast('Jumped to Chat Room', 'info'); }
      }
    };
    window.addEventListener('keydown', handleGlobalKeys);
    return () => window.removeEventListener('keydown', handleGlobalKeys);
  }, [addToast]);

  const renderTab = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard />;
      case 'files': return <FileShare />;
      case 'clipboard': return <ClipboardPanel />;
      case 'links': return <LinkHandoff />;
      case 'shortcuts': return <ShortcutsHub />;
      case 'notes': return <TextNotes />;
      case 'remote': return <PCRemote />;
      case 'chat': return <ChatRoom />;
      default: return <Dashboard />;
    }
  };

  return (
    <div className="app-shell">
      {/* Native FaceID / TouchID Biometric Lock Screen */}
      {isLocked && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(10, 10, 10, 0.90)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          zIndex: 10002,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-lg)',
          textAlign: 'center',
          animation: 'fadeIn 0.3s ease'
        }} role="dialog" aria-modal="true">
          <div className="empty-state-icon" style={{ fontSize: '4rem', marginBottom: '24px', filter: 'drop-shadow(0 0 10px var(--color-accent))' }}>👤</div>
          <h2 style={{ color: 'var(--color-accent)', marginBottom: 'var(--space-sm)', fontSize: 'var(--text-xl)' }}>Goon Drop Locked</h2>
          <p style={{ maxWidth: '400px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-lg)', fontSize: 'var(--text-sm)' }}>
            {isBiometricsSupported ? (
              "Biometrics (FaceID / TouchID) verification is required to unlock your Goon Drop network."
            ) : (
              <span style={{ color: 'var(--color-error)', display: 'block', padding: '10px', background: 'rgba(255, 92, 92, 0.1)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255, 92, 92, 0.2)' }}>
                ⚠️ Biometrics are unsupported in this environment (requires HTTPS secure origin or device support). Please use the Laptop Pairing Code to unlock.
              </span>
            )}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', maxWidth: '300px' }}>
            <button 
              className="btn btn-primary" 
              onClick={handleUnlockBiometrics} 
              disabled={!isBiometricsSupported} 
              aria-label="Unlock app using FaceID" 
              style={{ width: '100%', opacity: isBiometricsSupported ? 1 : 0.5 }}
            >
              🔓 Unlock with FaceID / TouchID
            </button>
            
            <div style={{ display: 'flex', alignItems: 'center', margin: '8px 0' }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
              <span style={{ padding: '0 8px', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>OR BYPASS</span>
              <div style={{ flex: 1, height: '1px', background: 'var(--color-border)' }} />
            </div>

            <form onSubmit={handleBypassCodeSubmit} style={{ display: 'flex', gap: '8px' }}>
              <label htmlFor="bypass-code-input" className="sr-only">Laptop Pairing Code</label>
              <input
                id="bypass-code-input"
                type="text"
                value={bypassCode}
                onChange={(e) => setBypassCode(e.target.value)}
                placeholder="Laptop Pairing Code..."
                maxLength={6}
                style={{ flex: 1, minHeight: '44px', textAlign: 'center', letterSpacing: '0.1em', fontWeight: 'bold' }}
              />
              <button type="submit" className="btn btn-secondary" disabled={!bypassCode.trim()} style={{ minHeight: '44px' }}>
                Verify
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Incoming Connection Auth Prompt */}
      {pendingAuthPrompt && (
        <div className="card" style={{
          position: 'fixed',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'calc(100% - 40px)',
          maxWidth: '450px',
          zIndex: 10000,
          boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          border: '2px solid var(--color-accent)',
          background: 'var(--color-surface)',
          animation: 'slideUp 0.3s ease'
        }} role="dialog" aria-modal="true" aria-labelledby="prompt-title">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            <h3 id="prompt-title" style={{ color: 'var(--color-accent)', fontSize: 'var(--text-lg)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
              <span>🔔</span> Goon Drop Connect Request
            </h3>
            <p style={{ fontSize: 'var(--text-sm)', margin: '4px 0', color: 'var(--color-text)' }}>
              Device <strong>{pendingAuthPrompt.deviceName}</strong> ({pendingAuthPrompt.deviceType}) at {pendingAuthPrompt.ip} wants to join Goon Drop.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <button className="btn btn-primary" onClick={() => respondToPairRequest(pendingAuthPrompt.deviceId, true)} style={{ flex: 1 }}>
                Accept
              </button>
              <button className="btn btn-secondary" onClick={() => respondToPairRequest(pendingAuthPrompt.deviceId, false)} style={{ flex: 1, borderColor: 'var(--color-error)', color: 'var(--color-error)' }}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Waiting for Approval Overlay */}
      {pairingStatus === 'waiting' && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(10,10,10,0.96)',
          zIndex: 10001,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-lg)',
          textAlign: 'center'
        }} role="dialog" aria-modal="true">
          <div className="empty-state-icon" style={{ fontSize: 'var(--text-3xl)', animation: 'pulse 1.5s infinite', marginBottom: '16px' }}>📡</div>
          <h2 style={{ color: 'var(--color-accent)', marginBottom: 'var(--space-sm)', fontSize: 'var(--text-xl)' }}>Approval Pending</h2>
          <p style={{ maxWidth: '400px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-lg)', fontSize: 'var(--text-sm)' }}>
            Check your other connected Goon Drop devices (like your laptop) to authorize this device to join the network.
          </p>
          <button className="btn btn-secondary" onClick={() => { reconnect(); }} aria-label="Cancel connection">
            Cancel / Reconnect
          </button>
        </div>
      )}

      {/* 💻 Apple-Style "Resume from PC" Handoff Banner! (Omega Flex!) */}
      {state.activeHandoff && state.deviceType !== 'windows' && (
        <div className="card" style={{
          position: 'fixed',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'calc(100% - 40px)',
          maxWidth: '450px',
          zIndex: 9998,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          border: '1.5px solid var(--color-accent)',
          background: 'var(--color-surface)',
          animation: 'slideUp 0.3s ease',
          padding: '12px'
        }} role="alert">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '1.5rem' }}>💻</span>
            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--color-accent)', letterSpacing: '0.05em' }}>RESUME FROM LAPTOP</div>
              <div style={{ fontSize: '12px', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                {state.activeHandoff.title}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  window.open(state.activeHandoff!.url, '_blank');
                  dispatch({ type: 'SET_ACTIVE_HANDOFF', payload: null });
                }}
                style={{ fontSize: '11px', padding: '0 12px', minHeight: '32px', height: '32px' }}
              >
                Open
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  dispatch({ type: 'SET_ACTIVE_HANDOFF', payload: null });
                }}
                style={{ fontSize: '11px', padding: '0 8px', minHeight: '32px', height: '32px', color: 'var(--color-text-muted)' }}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rejected Overlay */}
      {pairingStatus === 'rejected' && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(10,10,10,0.96)',
          zIndex: 10001,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-lg)',
          textAlign: 'center'
        }} role="dialog" aria-modal="true">
          <div className="empty-state-icon" style={{ fontSize: 'var(--text-3xl)', marginBottom: '16px' }}>❌</div>
          <h2 style={{ color: 'var(--color-error)', marginBottom: 'var(--space-sm)', fontSize: 'var(--text-xl)' }}>Connection Denied</h2>
          <p style={{ maxWidth: '400px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-lg)', fontSize: 'var(--text-sm)' }}>
            Your connection request was declined by another device on the Goon Drop network.
          </p>
          <button className="btn btn-primary" onClick={() => { reconnect(); }} aria-label="Try again">
            Try Again
          </button>
        </div>
      )}

      <header className="app-header">
        <h1>
          <svg className="app-logo" viewBox="0 0 192 192" aria-hidden="true" role="img">
            <rect width="192" height="192" rx="32" fill="#0a0a0a" />
            <g stroke="#00e5a0" strokeWidth="6" fill="none" strokeLinecap="round">
              <path d="M56 96 L96 56 L136 96" />
              <path d="M96 56 L96 140" strokeWidth="5" />
              <circle cx="136" cy="136" r="18" strokeWidth="4" />
              <path d="M128 136 L144 136" strokeWidth="4" />
              <path d="M136 128 L136 144" strokeWidth="4" />
            </g>
          </svg>
          Goon Drop
        </h1>
        <div
          className="header-status"
          role="status"
          aria-live="polite"
          title={paired ? 'Connected and paired' : connectionStatus}
        >
          <span
            className={`connection-dot ${
              connectionStatus === 'connected'
                ? (paired ? 'connected' : 'connecting')
                : connectionStatus === 'connecting' ? 'connecting' : 'disconnected'
            }`}
          />
          {connectionStatus === 'connected'
            ? (paired ? 'Connected' : 'Not paired')
            : connectionStatus === 'connecting' ? 'Connecting…' : 'Offline'}
        </div>
      </header>

      {/* Connection Failed Banner */}
      {connectionStatus === 'failed' && (
        <div className="card" style={{ background: 'rgba(255, 92, 92, 0.1)', borderColor: 'var(--color-error)', marginBottom: 'var(--space-md)' }} role="alert">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-error)' }}>Could not connect to Goon Drop Server</span>
            <button className="btn btn-primary" onClick={reconnect} aria-label="Retry connection" style={{ fontSize: 'var(--text-sm)' }}>
              Retry
            </button>
          </div>
        </div>
      )}

       <main className="app-main" role="main" aria-label={`${activeTab} view`}>
         {renderTab()}
       </main>

       {state.deviceType !== 'windows' && <MediaReceiver />}
       {state.deviceType === 'windows' && <PCMediaReceiver />}
       
      {/* 🛠️ Accessible Bottom Navigation Bar */}
      <nav className="app-nav" role="navigation" aria-label="Main feature navigation">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            aria-label={`Go to ${tab.label}`}
          >
            <span className="nav-icon" aria-hidden="true">{tab.icon}</span>
            <span className="nav-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Toast notifications */}


       <ToastContainer />


      {/* Screen reader live region */}
      <div id="announcements" role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
