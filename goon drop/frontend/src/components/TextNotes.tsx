/** Quick text notes & Shared Checklist - send notes and tick items off together in real-time */
import React, { useState } from 'react';
import { useAppContext, ChecklistItem } from '../contexts/AppContext';
import { announceSuccess, announceError } from '../utils/accessibility';
import { copyTextSync } from '../utils/clipboard';
import { encryptText, decryptText } from '../utils/crypto';
import { formatTime } from './shared-utils';

export function TextNotes() {
  const { state, sendMessage, addToast, dispatch } = useAppContext();
  const { paired, connectionStatus, deviceName, notes, checklist } = state;
  const [note, setNote] = useState('');
  const [todoText, setTodoText] = useState('');

  const isConnected = connectionStatus === 'connected' && paired;

  const handleSend = () => {
    if (!note.trim()) return;

    const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
    const encryptedText = encryptText(note.trim(), key);

    sendMessage({
      type: 'text_note',
      payload: {
        text: encryptedText,
        timestamp: Date.now(),
        sourceDeviceId: state.deviceId,
        sourceDeviceName: deviceName,
      },
    });

    addToast('Note sent', 'success');
    announceSuccess('Note sent to devices');
    setNote('');
  };

  const handleCopyNote = (text: string) => {
    const success = copyTextSync(text);
    if (success) {
      addToast('Note copied', 'success');
      announceSuccess('Note copied to clipboard');
    } else {
      addToast('Failed to copy note', 'error');
      announceError('Failed to copy note');
    }
  };

  // Checklist Actions
  const handleAddTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (!todoText.trim() || !isConnected) return;

    const newItem: ChecklistItem = {
      id: `todo-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      text: todoText.trim(),
      completed: false
    };

    const updatedChecklist = [...checklist, newItem];
    sendChecklistUpdate(updatedChecklist);
    setTodoText('');
  };

  const handleToggleTodo = (id: string) => {
    if (!isConnected) return;
    const updatedChecklist = checklist.map(item =>
      item.id === id ? { ...item, completed: !item.completed } : item
    );
    sendChecklistUpdate(updatedChecklist);
  };

  const handleDeleteTodo = (id: string) => {
    if (!isConnected) return;
    const updatedChecklist = checklist.filter(item => item.id !== id);
    sendChecklistUpdate(updatedChecklist);
  };

  const sendChecklistUpdate = (updatedChecklist: ChecklistItem[]) => {
    // Optimistically update locally via dispatch (with raw plain text)
    dispatch({ type: 'SET_CHECKLIST', payload: updatedChecklist });
    
    // Encrypt each todo item's text natively before sending over local network!
    const key = window.localStorage.getItem('goondrop_e2ee_key') || '';
    const encryptedChecklist = updatedChecklist.map(item => ({
      ...item,
      text: encryptText(item.text, key)
    }));

    sendMessage({
      type: 'checklist_update',
      payload: encryptedChecklist
    });
  };

  return (
    <section aria-labelledby="notes-heading" className="responsive-grid">
      <h2 id="notes-heading" className="sr-only">Quick Notes</h2>

      {/* Left Column: Quick Notes */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {/* Send Note Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Quick Note</span>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); handleSend(); }}>
            <label htmlFor="note-input" className="sr-only">Type a quick note to send to connected devices</label>
            <textarea
              id="note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Type a quick note..."
              rows={3}
              disabled={!isConnected}
              aria-describedby="note-hint"
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={!isConnected || !note.trim()} aria-label="Send note">
                Send Note
              </button>
            </div>
            <span id="note-hint" className="sr-only">Notes are temporary messages sent to all connected devices</span>
          </form>
        </div>

        {/* Received Notes Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Notes ({notes.length})</span>
          </div>
          {notes.length === 0 ? (
            <div className="empty-state" role="status">
              <div className="empty-state-icon" aria-hidden="true">📝</div>
              <p className="empty-state-text">No notes received yet.<br />Send a quick note from another device.</p>
            </div>
          ) : (
            <div role="list" aria-label="Recent notes received from devices" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              {notes.slice(0, 20).map((n, i) => (
                <div key={`note-${i}-${n.timestamp}`} className="clipboard-history-item" role="listitem" style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--space-sm)', cursor: 'default' }}>
                  <div style={{ fontSize: 'var(--text-sm)', wordBreak: 'break-word', marginBottom: 4, whiteSpace: 'pre-wrap' }}>{n.text}</div>
                  <div className="clipboard-source" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>From: {n.sourceDeviceName} • {formatTime(n.timestamp)}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {navigator.share && (
                        <button
                          className="btn btn-ghost btn-icon"
                          onClick={() => navigator.share({ text: n.text })}
                          aria-label="Share note natively"
                          style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, fontSize: 'var(--text-sm)' }}
                        >
                          📤
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-icon"
                        onClick={() => handleCopyNote(n.text)}
                        aria-label="Copy note content"
                        style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, fontSize: 'var(--text-sm)' }}
                      >
                        📋
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Shared Real-Time Shopping Checklist! (Omega Flex!) */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">🛒 Shared To-Do & Shopping Checklist</span>
        </div>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Add tasks or grocery items. Tapping a checkbox updates all connected devices in real-time!
        </p>

        {/* Add Todo Form */}
        <form onSubmit={handleAddTodo} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <label htmlFor="todo-input" className="sr-only">Add checklist item</label>
          <input
            id="todo-input"
            type="text"
            value={todoText}
            onChange={(e) => setTodoText(e.target.value)}
            placeholder="Add butter, eggs, slides..."
            disabled={!isConnected}
            style={{ flex: 1, minHeight: 44 }}
          />
          <button type="submit" className="btn btn-primary" disabled={!isConnected || !todoText.trim()} aria-label="Add item">
            Add
          </button>
        </form>

        {/* Todo List */}
        {checklist.length === 0 ? (
          <div className="empty-state" role="status" style={{ padding: 'var(--space-md)' }}>
            <div className="empty-state-icon" aria-hidden="true">✅</div>
            <p className="empty-state-text">Checklist is empty!<br />Type an item above to sync it.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {checklist.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 8, borderBottom: '1px solid var(--color-border)' }}>
                <input
                  type="checkbox"
                  checked={item.completed}
                  onChange={() => handleToggleTodo(item.id)}
                  style={{ width: '22px', height: '22px', cursor: 'pointer', accentColor: 'var(--color-accent)' }}
                  aria-label={`Toggle complete for ${item.text}`}
                />
                <span style={{
                  flex: 1,
                  fontSize: 'var(--text-sm)',
                  textDecoration: item.completed ? 'line-through' : 'none',
                  color: item.completed ? 'var(--color-text-muted)' : 'var(--color-text)'
                }}>
                  {item.text}
                </span>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => handleDeleteTodo(item.id)}
                  aria-label={`Delete ${item.text}`}
                  style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, fontSize: 'var(--text-sm)' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
