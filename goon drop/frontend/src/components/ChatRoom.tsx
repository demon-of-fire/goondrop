/** LAN Encrypted Chat Room - local encrypted messaging over Wi-Fi without the internet */
import React, { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { encryptText, decryptText } from '../utils/crypto';
import { formatTime } from './shared-utils';

interface ChatMessage {
  text: string;
  timestamp: number;
  sourceDeviceId: string;
  sourceDeviceName: string;
}

export function ChatRoom() {
  const { state, sendMessage, addToast } = useAppContext();
  const { paired, connectionStatus, deviceId } = state;
  const isConnected = connectionStatus === 'connected' && paired;

  const [chatInput, setChatInput] = useState('');
  
  // Persistent Chat History: Load from localStorage on startup! (Omega UX!)
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = window.localStorage.getItem('goondrop_chat_history');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Write chat logs to localStorage whenever messages are updated
  useEffect(() => {
    try {
      window.localStorage.setItem('goondrop_chat_history', JSON.stringify(messages.slice(-50)));
    } catch { }
  }, [messages]);

  // Load and listen to incoming chat messages over WebSocket
  useEffect(() => {
    const handleIncomingMessage = (e: CustomEvent) => {
      const { type, payload } = e.detail;
      if (type === 'chat_message') {
        const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
        const decText = decryptText(payload.text, key);
        
        const newMsg: ChatMessage = {
          text: decText,
          timestamp: payload.timestamp,
          sourceDeviceId: payload.sourceDeviceId,
          sourceDeviceName: payload.sourceDeviceName
        };
        setMessages(prev => [...prev, newMsg]);
      } else if (type === 'nuclear_wipe') {
        setMessages([]); // Clear chat instantly
      }
    };

    window.addEventListener('goondrop_ws_message' as any, handleIncomingMessage);
    return () => window.removeEventListener('goondrop_ws_message' as any, handleIncomingMessage);
  }, []);

  // Auto-scroll to the bottom of the chat list
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !isConnected) return;

    const text = chatInput.trim();
    const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
    const encText = encryptText(text, key);

    sendMessage({
      type: 'chat_message',
      payload: { text: encText }
    });

    // Optimistically add locally
    setMessages(prev => [...prev, {
      text,
      timestamp: Date.now(),
      sourceDeviceId: deviceId,
      sourceDeviceName: 'Me'
    }]);

    setChatInput('');
  };

  return (
    <section aria-labelledby="chat-heading" className="responsive-grid">
      <h2 id="chat-heading" className="sr-only">Encrypted Chat</h2>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '420px', padding: 'var(--space-md)' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: '8px', marginBottom: '8px' }}>
          <span className="card-title">💬 LAN Encrypted Chat Messenger</span>
        </div>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
          Secure, real-time messaging on your local Wi-Fi. (E2EE encryption applies automatically if passcode is set).
        </p>

        {/* Message Log */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px', marginBottom: '12px' }}>
          {messages.length === 0 ? (
            <div className="empty-state" role="status" style={{ padding: 'var(--space-lg)' }}>
              <div className="empty-state-icon" aria-hidden="true">💬</div>
              <p className="empty-state-text">No messages yet.<br />Say hello to your connected devices!</p>
            </div>
          ) : (
            messages.map((msg, i) => {
              const isMe = msg.sourceDeviceId === deviceId;
              return (
                <div
                  key={`chat-msg-${i}`}
                  style={{
                    alignSelf: isMe ? 'flex-end' : 'flex-start',
                    maxWidth: '80%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isMe ? 'flex-end' : 'flex-start'
                  }}
                >
                  <span style={{ fontSize: '9px', color: 'var(--color-text-muted)', marginBottom: '2px' }}>
                    {msg.sourceDeviceName} • {formatTime(msg.timestamp)}
                  </span>
                  <div style={{
                    background: isMe ? 'var(--color-accent)' : 'var(--color-surface-hover)',
                    color: isMe ? '#000000' : 'var(--color-text)',
                    padding: '8px 12px',
                    borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    fontSize: 'var(--text-sm)',
                    wordBreak: 'break-word',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                  }}>
                    {msg.text}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Send Input Form */}
        <form onSubmit={handleSend} style={{ display: 'flex', gap: '8px' }}>
          <label htmlFor="chat-input-box" className="sr-only">Type message</label>
          <input
            id="chat-input-box"
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Type a secure message..."
            disabled={!isConnected}
            style={{ flex: 1, minHeight: '44px' }}
          />
          <button type="submit" className="btn btn-primary" disabled={!isConnected || !chatInput.trim()} aria-label="Send message" style={{ minHeight: '44px' }}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
