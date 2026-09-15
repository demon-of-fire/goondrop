/** Clipboard sync panel with iOS-aware limitations and manual fallback */
import React, { useState, useRef } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { isIOSPwa as checkIsIOSPwa, copyTextSync } from '../utils/clipboard';
import { announceSuccess, announceError } from '../utils/accessibility';

interface Snippet {
  label: string;
  text: string;
}

export function ClipboardPanel() {
  const { state, lastSyncedText, lastSyncFrom, lastSyncTime, clipboardHistory, pushClipboard, requestRemoteClipboard, clearClipboardHistory, isIOSPwa, addToast } = useAppContext();
  const { isIOS, paired, connectionStatus } = state;
  const [textInput, setTextInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Editable Snippets State (New!)
  const [snippets, setSnippets] = useState<Snippet[]>(() => {
    const saved = window.localStorage.getItem('goondrop_quick_snippets');
    if (saved) {
      try { return JSON.parse(saved); } catch { }
    }
    return [
      { label: '📧 My Email', text: 'my.email@gmail.com' },
      { label: '🏡 Home Address', text: '123 Goon Drop Lane, Windows PC' },
      { label: '📱 Phone Number', text: '+1 (555) 123-4567' },
      { label: '🔑 Home Wi-Fi', text: 'WIFI: GoonDropNet; PASS: dropitlikeitsloaded;' }
    ];
  });
  const [isEditingSnippets, setIsEditingSnippets] = useState(false);

  const saveSnippets = (updated: typeof snippets) => {
    setSnippets(updated);
    window.localStorage.setItem('goondrop_quick_snippets', JSON.stringify(updated));
  };

  // Read and pre-fill shared text from iOS Native Share Sheet dynamically!
  React.useEffect(() => {
    const loadSharedText = () => {
      const sharedText = window.sessionStorage.getItem('shared_content_text');
      if (sharedText) {
        setTextInput(sharedText);
        window.sessionStorage.removeItem('shared_content_text');
        addToast('Shared text pre-filled!', 'success');
      }
    };

    loadSharedText();

    // ⚠️ CRITICAL PWA FIX: Listen to our custom 'goondrop_shared_content' event to bypass W3C browser restrictions!
    const handleCustomShare = (e: any) => {
      if (e.detail && e.detail.type === 'text') {
        setTextInput(e.detail.content);
        window.sessionStorage.removeItem('shared_content_text');
        addToast('Shared text pre-filled!', 'success');
      }
    };

    window.addEventListener('goondrop_shared_content' as any, handleCustomShare);
    return () => window.removeEventListener('goondrop_shared_content' as any, handleCustomShare);
  }, [addToast]);

  const isConnected = connectionStatus === 'connected' && paired;
  const showIOSNotice = isIOS || isIOSPwa;

  const handlePushInput = () => {
    if (!textInput.trim()) return;
    pushClipboard(textInput.trim());
    setTextInput('');
    announceSuccess('Text sent to connected devices');
    addToast('Text sent to devices', 'success');
  };

  const handleCopyToClipboard = (text: string) => {
    const success = copyTextSync(text);
    if (success) {
      announceSuccess('Copied to clipboard');
      addToast('Copied to clipboard', 'success');
    } else {
      announceError('Failed to copy to clipboard');
      addToast('Failed to copy text', 'error');
    }
  };

  const handleManualSync = async () => {
    requestRemoteClipboard();
    addToast('Requesting clipboard from devices...', 'info');
  };

  const handleNativeShare = async (text: string) => {
    if (!navigator.share) {
      handleCopyToClipboard(text);
      return;
    }
    try {
      await navigator.share({ text });
    } catch (err: any) {
      if (err?.name !== 'AbortError') addToast('Could not open the system share sheet.', 'error');
    }
  };

  return (
    <section aria-labelledby="clipboard-heading">
      <h2 id="clipboard-heading" className="sr-only">Clipboard Sync</h2>

      {/* ✨ Universal Clipboard banner */}
      <div className="sync-bar">
        <div className="sync-bar-top">
          <span className="sync-bar-title">🔁 Universal Clipboard</span>
          <span className="sync-bar-status">
            {lastSyncedText ? 'Last sync ' + new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'No clips synced yet'}
          </span>
        </div>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0 }}>
          Copy on <strong>either</strong> device → paste on <strong>both</strong>. In the iOS Shortcuts app, wire <strong>"Universal Clipboard"</strong> to a <strong>Time of Day automation</strong> and it syncs even with this app closed and your phone locked.
        </p>
        <div className="sync-bar-actions">
          <button
            className="btn btn-primary"
            style={{ fontSize: 'var(--text-xs)', minHeight: 36, height: 36 }}
            onClick={() => {
              if (isIOSPwa || isIOS) {
                window.location.href = window.location.origin + '/ios-setup';
              } else {
                window.dispatchEvent(new CustomEvent('goondrop_navigate', { detail: { tab: 'shortcuts' } }));
              }
            }}
          >
            ⚡ Get the shortcut
          </button>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 'var(--text-xs)', minHeight: 36, height: 36 }}
            onClick={handleManualSync}
            disabled={!isConnected}
          >
            Sync now
          </button>
        </div>
        {lastSyncedText && (
          <div className="clipboard-preview" style={{ margin: '4px 0 0', maxHeight: 80, fontSize: 'var(--text-xs)' }}>{lastSyncedText}</div>
        )}
      </div>

      {/* iOS Limitations Notice */}
      {showIOSNotice && (
        <div className="iOS-notice" role="note" aria-label="iOS clipboard limitations">
          <p><strong>iOS Clipboard Note:</strong> iPhone PWAs cannot monitor the clipboard automatically in the background.
            Clipboard sync works while this app is open and focused.
            Use the manual sync buttons below if automatic sync doesn't work.</p>
        </div>
      )}

      <div className="responsive-grid">
        {/* Send Text */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Send Text</span>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); handlePushInput(); }}>
            <label htmlFor="clipboard-text-input" className="sr-only">Enter text to send to connected devices</label>
            <textarea
              ref={inputRef}
              id="clipboard-text-input"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type or paste text to send..."
              rows={3}
              disabled={!isConnected}
              aria-describedby="clipboard-send-hint"
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary" disabled={!isConnected || !textInput.trim()} aria-label="Send text to connected devices">
                Send to Devices
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleManualSync} disabled={!isConnected} aria-label="Request clipboard from other devices">
                Request Clipboard
              </button>
            </div>
            <span id="clipboard-send-hint" className="sr-only">Text you enter here will be sent to all connected devices</span>
          </form>
        </div>

        {/* Quick Snippets Card (New!) */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">⚡ Quick Snippets</span>
            <button
              className="btn btn-ghost"
              onClick={() => setIsEditingSnippets(!isEditingSnippets)}
              style={{ fontSize: 'var(--text-xs)', minHeight: '32px', height: '32px' }}
            >
              {isEditingSnippets ? 'Done' : 'Edit Snippets'}
            </button>
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {isEditingSnippets ? 'Customize your quick-paste snippets below:' : 'Tap any quick snippet to instantly copy and sync it across all your connected devices!'}
          </p>
          
          {isEditingSnippets ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {snippets.map((snippet, idx) => (
                <div key={`edit-snippet-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, background: '#1c1c1c', padding: '8px', borderRadius: 'var(--radius-md)' }}>
                  <input
                    type="text"
                    value={snippet.label}
                    onChange={(e) => {
                      const updated = [...snippets];
                      updated[idx].label = e.target.value;
                      saveSnippets(updated);
                    }}
                    placeholder="Snippet label (e.g. Email)"
                    style={{ minHeight: '32px', height: '32px', fontSize: 'var(--text-xs)' }}
                  />
                  <input
                    type="text"
                    value={snippet.text}
                    onChange={(e) => {
                      const updated = [...snippets];
                      updated[idx].text = e.target.value;
                      saveSnippets(updated);
                    }}
                    placeholder="Snippet text (e.g. my@email.com)"
                    style={{ minHeight: '32px', height: '32px', fontSize: 'var(--text-xs)' }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {snippets.map(snippet => (
                <button
                  key={snippet.label}
                  className="btn btn-secondary"
                  disabled={!isConnected}
                  onClick={() => {
                    pushClipboard(snippet.text);
                    handleCopyToClipboard(snippet.text);
                    addToast(`Snippet "${snippet.label}" synced!`, 'success');
                  }}
                  style={{ justifyContent: 'space-between', width: '100%', minHeight: '36px', height: '36px', padding: '0 12px' }}
                >
                  <span>{snippet.label}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Tap to sync</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Last Synced */}
        {lastSyncedText && (
          <div className="card" role="region" aria-label="Last synced clipboard content">
            <div className="card-header">
              <span className="card-title">Last Synced</span>
            </div>
            <div className="clipboard-preview">{lastSyncedText}</div>
            <div className="clipboard-source">
              From {lastSyncFrom} • {new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
            <div className="clipboard-actions" style={{ marginTop: 8 }}>
              <button className="btn btn-secondary" onClick={() => handleCopyToClipboard(lastSyncedText)} aria-label="Copy last synced text to your clipboard">
                Copy to My Clipboard
              </button>
              <button className="btn btn-ghost" onClick={() => pushClipboard(lastSyncedText)} aria-label="Resend clipboard to devices">
                Resend
              </button>
              {'share' in navigator && (
                <button className="btn btn-ghost" onClick={() => handleNativeShare(lastSyncedText)} aria-label="Share text natively">
                  📤 Share
                </button>
              )}
            </div>
          </div>
        )}

        {/* Clipboard History */}
        {clipboardHistory.length > 0 && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">Clipboard History ({clipboardHistory.length})</span>
              <button className="btn btn-ghost" onClick={clearClipboardHistory} aria-label="Clear clipboard history" style={{ fontSize: 'var(--text-xs)', minHeight: 32 }}>
                Clear
              </button>
            </div>
            <div role="list" aria-label="Clipboard history items">
              {clipboardHistory.slice(0, 20).map((entry, i) => (
                <div key={`${entry.hash}-${i}`} className="clipboard-history-item" role="listitem">
                  <div style={{ fontSize: 'var(--text-sm)', wordBreak: 'break-word', marginBottom: 4 }}>{entry.text.length > 100 ? entry.text.substring(0, 100) + '...' : entry.text}</div>
                  <div className="clipboard-source" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>From: {entry.sourceDeviceName}</span>
                    <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <button className="btn btn-ghost" onClick={() => handleCopyToClipboard(entry.text)} aria-label={`Copy clipboard item from ${entry.sourceDeviceName}`} style={{ fontSize: 'var(--text-xs)', padding: '2px 8px', minHeight: 28, marginTop: 4 }}>
                    Copy
                  </button>
                  {'share' in navigator && (
                    <button className="btn btn-ghost" onClick={() => handleNativeShare(entry.text)} aria-label={`Share clipboard item from ${entry.sourceDeviceName}`} style={{ fontSize: 'var(--text-xs)', padding: '2px 8px', minHeight: 28, marginTop: 4 }}>
                      Share
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {!lastSyncedText && clipboardHistory.length === 0 && (
          <div className="card">
            <div className="empty-state" role="status">
              <div className="empty-state-icon" aria-hidden="true">📋</div>
              <p className="empty-state-text">No clipboard items yet.<br />Copy something on any device to see it here.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
