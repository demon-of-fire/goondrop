/** Link handoff component - send and receive URLs between devices */
import React, { useState } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { announceSuccess, announceError } from '../utils/accessibility';
import { copyTextSync } from '../utils/clipboard';
import { formatTime, truncate } from './shared-utils';

export function LinkHandoff() {
  const { state, sendLink, addToast } = useAppContext();
  const { links, paired, connectionStatus } = state;
  const [urlInput, setUrlInput] = useState('');

  // Read and pre-fill shared link from iOS Native Share Sheet dynamically!
  React.useEffect(() => {
    const loadSharedLink = () => {
      const sharedLink = window.sessionStorage.getItem('shared_content_link');
      if (sharedLink) {
        setUrlInput(sharedLink);
        window.sessionStorage.removeItem('shared_content_link');
        addToast('Shared link pre-filled!', 'success');
      }
    };

    loadSharedLink();

    // ⚠️ CRITICAL PWA FIX: Listen to our custom 'goondrop_shared_content' event to bypass W3C browser restrictions!
    const handleCustomShare = (e: any) => {
      if (e.detail && e.detail.type === 'link') {
        setUrlInput(e.detail.content);
        window.sessionStorage.removeItem('shared_content_link');
        addToast('Shared link pre-filled!', 'success');
      }
    };

    window.addEventListener('goondrop_shared_content' as any, handleCustomShare);
    return () => window.removeEventListener('goondrop_shared_content' as any, handleCustomShare);
  }, [addToast]);

  const isConnected = connectionStatus === 'connected' && paired;

  const isValidUrl = (url: string): boolean => {
    return /^(https?:\/\/|www\.)[^\s]+$/i.test(url.trim());
  };

  const handleSend = () => {
    const input = urlInput.trim();
    if (!input) return;

    let url = input;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    if (!isValidUrl(input) && !isValidUrl(url)) {
      addToast('Please enter a valid URL (e.g., https://example.com)', 'error');
      announceError('Invalid URL');
      return;
    }

    sendLink(url);
    setUrlInput('');
    announceSuccess('Link sent to connected devices');
  };

  const handleOpenLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleCopyLink = (url: string) => {
    const success = copyTextSync(url);
    if (success) {
      addToast('Link copied', 'success');
      announceSuccess('Link copied to clipboard');
    } else {
      addToast('Failed to copy link', 'error');
      announceError('Failed to copy link');
    }
  };

  const handleNativeShare = async (url: string, title?: string) => {
    if (!navigator.share) {
      handleCopyLink(url);
      return;
    }
    try {
      await navigator.share({ title: title || 'Shared from Goon Drop', url });
    } catch (err: any) {
      // Cancel is a normal share-sheet outcome; do not turn it into an error toast.
      if (err?.name !== 'AbortError') addToast('Could not open the system share sheet.', 'error');
    }
  };

  return (
    <section aria-labelledby="links-heading" className="responsive-grid">
      <h2 id="links-heading" className="sr-only">Link Handoff</h2>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Send Link</span>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }}>
          <label htmlFor="link-url-input" className="sr-only">Enter URL to send to connected devices</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id="link-url-input"
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com"
              disabled={!isConnected}
              style={{ flex: 1, minHeight: 44 }}
              aria-describedby="link-send-hint"
              autoComplete="url"
            />
            <button type="submit" className="btn btn-primary" disabled={!isConnected || !urlInput.trim()} aria-label="Send link to connected devices">
              Send
            </button>
          </div>
          <span id="link-send-hint" className="sr-only">Enter a URL and press Send to share it with all connected devices</span>
        </form>
      </div>

      {/* Recent Links */}
      {links.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Links ({links.length})</span>
          </div>
          <div role="list" aria-label="Recent links received from devices">
            {links.slice(0, 20).map((link, i) => (
              <div key={`link-${i}-${link.url}`} className="link-item" role="listitem">
                <a
                  href={link.url}
                  className="link-url"
                  onClick={(e) => { e.preventDefault(); handleOpenLink(link.url); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleOpenLink(link.url); }}
                  tabIndex={0}
                  aria-label={`Open link: ${link.title || link.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={link.url}
                >
                  {link.title || link.url}
                </a>
                <span className="link-source">
                  {link.sourceDeviceName ? `${link.sourceDeviceName} • ` : ''}{formatTime(link.timestamp)}
                </span>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => handleCopyLink(link.url)}
                  aria-label={`Copy link to clipboard`}
                  style={{ width: 36, height: 36, minWidth: 36, minHeight: 36, fontSize: 'var(--text-sm)' }}
                >
                  📋
                </button>
                {'share' in navigator && (
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => handleNativeShare(link.url, link.title)}
                    aria-label={`Share link using the system share sheet`}
                    style={{ width: 36, height: 36, minWidth: 36, minHeight: 36, fontSize: 'var(--text-sm)' }}
                  >
                    📤
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {links.length === 0 && (
        <div className="card">
          <div className="empty-state" role="status">
            <div className="empty-state-icon" aria-hidden="true">🔗</div>
            <p className="empty-state-text">No links received yet.<br />Send a link from any connected device to see it here.</p>
          </div>
        </div>
      )}
    </section>
  );
}
