import React, { useEffect, useState } from 'react';
import { useAppContext } from '../contexts/AppContext';

interface SuiteShortcut {
  id: string;
  name: string;
  description: string;
  category: string;
  method: 'GET' | 'POST';
  url: string;
  input?: string;
  needsCode?: boolean;
  downloadUrl: string;
}

interface SuiteResponse {
  baseUrl: string;
  pairingCode: string;
  categories: Record<string, string>;
  shortcuts: SuiteShortcut[];
}

const CATEGORY_ORDER = ['share', 'clipboard', 'handoff', 'control', 'sensors'];

export function ShortcutsHub() {
  const { state, addToast } = useAppContext();
  const [suite, setSuite] = useState<SuiteResponse | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3941';
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/shortcuts/suite')
      .then(r => r.json())
      .then(data => { if (!cancelled) setSuite(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedUrl(label);
      addToast(`Copied ${label} to clipboard!`, 'success');
      setTimeout(() => setCopiedUrl(null), 2500);
    });
  };

  const groups = suite
    ? CATEGORY_ORDER
        .map(cat => ({ cat, label: suite.categories[cat] || cat, items: suite.shortcuts.filter(s => s.category === cat) }))
        .filter(g => g.items.length > 0)
    : [];

  return (
    <section aria-labelledby="shortcuts-heading" style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="card" style={{ marginBottom: 16, background: 'linear-gradient(135deg, rgba(0, 229, 160, 0.12), rgba(0, 150, 255, 0.08))', border: '1px solid rgba(0, 229, 160, 0.3)' }}>
        <h2 id="shortcuts-heading" style={{ fontSize: 'var(--text-lg)', fontWeight: 'bold', color: 'var(--color-accent)', marginBottom: 8 }}>
          Apple Shortcuts Continuity Suite
        </h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text)', lineHeight: 1.5, marginBottom: 12 }}>
          <strong>{suite ? suite.shortcuts.length : 20}+ shortcuts · No Apple Developer Account or IPA needed!</strong>
          Shortcuts run 100% in the background — so AirDropping a file, syncing a clipboard, locking your PC, or pinging your
          phone works even when the Goon Drop app on your iPhone is fully closed.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span className="badge badge-online">Server: {suite?.baseUrl || origin}</span>
          {(state.pairingCode || suite?.pairingCode) && (
            <span className="badge badge-online">Pairing Code: {state.pairingCode || suite?.pairingCode}</span>
          )}
        </div>
      </div>

      {isIOS && (
        <div className="card" style={{ marginBottom: 16, background: 'rgba(0, 229, 160, 0.08)', border: '1px solid rgba(0, 229, 160, 0.3)' }}>
          <h3 style={{ fontSize: 'var(--text-base)', color: 'var(--color-accent)', marginBottom: 8 }}>
            One-Tap Install
          </h3>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            Tap any install button below. iOS loads the file into the Shortcuts app — confirm and it's ready to use instantly.
          </p>
        </div>
      )}

      {!suite && (
        <div className="card">
          <div className="empty-state" role="status">
            <div className="empty-state-icon" aria-hidden="true">Shortcut</div>
            <p className="empty-state-text">Loading your shortcut suite…</p>
          </div>
        </div>
      )}

      {groups.map(group => (
        <div key={group.cat} style={{ marginBottom: 8 }}>
          <h3 style={{ fontSize: 'var(--text-base)', color: 'var(--color-accent)', margin: '16px 0 12px' }}>{group.label}</h3>
          <div style={{ display: 'grid', gap: 16 }}>
            {group.items.map(s => (
              <div key={s.id} className="card">
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <span className="card-title" style={{ fontSize: 'var(--text-base)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: '1.3em' }}>🔗</span>
                      {s.name}
                    </span>
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
                      {s.description}
                    </p>
                  </div>
                  <span className="badge" style={{ background: 'rgba(0,229,160,0.12)', color: 'var(--color-accent)', border: '1px solid rgba(0,229,160,0.3)', fontSize: 'var(--text-xs)' }}>
                    {s.method}
                  </span>
                </div>

                <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a
                    href={s.downloadUrl}
                    download
                    className="btn btn-primary"
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 16px', minHeight: 36, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={() => addToast(`Downloading ${s.name}...`, 'info')}
                  >
                    ⬇ Install Shortcut
                  </a>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 'var(--text-xs)', padding: '8px 16px', minHeight: 36, whiteSpace: 'nowrap' }}
                    onClick={() => copyToClipboard(s.url, `${s.name} URL`)}
                    title={s.url}
                  >
                    {copiedUrl === `${s.name} URL` ? '✓ Copied' : 'Copy Endpoint'}
                  </button>
                  {s.input && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', alignSelf: 'center' }}>
                      Input: {s.input}
                    </span>
                  )}
                  {s.needsCode && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)', alignSelf: 'center' }} title="Protected by your Goon Drop pairing code">
                      🔒 auto-configured
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Back Tap Pro-Tip Card */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <span className="card-title">
            <span style={{ fontSize: '1.1em' }}>📱</span> iPhone Back Tap Secret (Instant Clipboard)
          </span>
        </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          You can sync clipboards without unlocking your screen or opening any app:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 10 }}>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, border: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              Double Tap Back
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              Set to <strong>"Send Clipboard to PC"</strong>. Double tap the back of your phone, and whatever you just copied is instantly on your Windows laptop!
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, border: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              Triple Tap Back
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              Set to <strong>"Paste from PC"</strong>. Triple tap the back of your phone, and whatever is on your Windows laptop clipboard is pulled right into your iPhone clipboard!
            </div>
          </div>
        </div>
      </div>

      {/* Automation Recipes */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <span className="card-title">
            <span style={{ fontSize: '1.1em' }}>🤖</span> Automation Recipes (set-and-forget)
          </span>
        </div>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          In the Shortcuts app → Automation tab, wire these up once and they run themselves:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 10 }}>
          <div style={{ background: 'rgba(0,229,160,0.06)', padding: 12, borderRadius: 8, border: '1px solid rgba(0,229,160,0.25)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              ⏰ Universal Clipboard — full auto
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              Shortcuts → Automation → <strong>Time of Day</strong> (pick one or several times a day) → Run Shortcut <strong>"Universal Clipboard"</strong> → enable Run Immediately. Each run nudges both clipboards to match. Instant? Back Tap or the live app.
            </div>
          </div>
          <div style={{ background: 'rgba(0,229,160,0.06)', padding: 12, borderRadius: 8, border: '1px solid rgba(0,229,160,0.25)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              🖼️ Screenshots auto-beamed to PC
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              Automation → <strong>"New Screenshot"</strong> → Run Shortcut <strong>"AirDrop to PC"</strong>. Every screenshot from your phone instantly lands in <code>Downloads\GoonDrop</code> on Windows. Photo-to-PC works the same way for any new photo.
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, border: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              🔋 Low Battery → warn PC
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              "When Battery Level falls below 20%" → run <strong>Send Battery to PC</strong>. Your PC notifies you to plug in.
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, border: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              🎵 Charging → open Spotify
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              "When Charger is Connected" → run <strong>Open App on PC</strong> (text: "spotify"). Walk in, plug in, music starts.
            </div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, border: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 'bold', color: 'var(--color-accent)', fontSize: 'var(--text-sm)' }}>
              🗣️ Siri hands-free
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>
              "Hey Siri, type that on my PC", "Hey Siri, lock my PC", "Hey Siri, find my phone", "Hey Siri, find my PC". Lock your laptop by voice, or beep it across the house.
            </div>
          </div>
        </div>
      </div>

      {/* iPhone Setup Page Link */}
      <div className="card" style={{ marginTop: 16, textAlign: 'center' }}>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', marginBottom: 8 }}>
          Prefer the guided mobile page? Open this on your iPhone:
        </p>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 'var(--text-xs)', padding: '8px 16px', minHeight: 36 }}
          onClick={() => copyToClipboard(`${origin}/ios-setup`, 'iPhone Setup URL')}
        >
          {copiedUrl === 'iPhone Setup URL' ? '✓ Copied Setup URL' : '📋 Copy iPhone Setup URL'}
        </button>
      </div>
    </section>
  );
}