/** Accessible toast notification container */
import React from 'react';
import { useAppContext } from '../contexts/AppContext';

export function ToastContainer() {
  const { toasts, removeToast } = useAppContext();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="status" aria-live="polite" aria-label="Notifications">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast ${toast.type}`}
          role="alert"
        >
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button
            className="btn-ghost btn-icon"
            onClick={() => removeToast(toast.id)}
            aria-label="Dismiss notification"
            style={{ width: 32, height: 32, minWidth: 32, minHeight: 32 }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
