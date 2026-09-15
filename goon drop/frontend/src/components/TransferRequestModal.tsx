import React from 'react';
import { useAppContext } from '../contexts/AppContext';
import { TransferRequest } from '../contexts/AppContext';

export function TransferRequestModal() {
  const { state, acceptFile, declineFile } = useAppContext();
  const request = state.transferRequests[0]; // Only handle one at a time for simplicity

  if (!request) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ 
        backgroundColor: 'var(--color-bg-card)', 
        border: '1px solid var(--color-border)', 
        borderRadius: '24px',
        padding: '24px',
        textAlign: 'center',
        maxWidth: '400px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.4)'
      }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>📦</div>
        <h3 style={{ fontSize: 'var(--text-lg)', marginBottom: '8px', color: 'var(--color-text)' }}>
          Incoming File
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: '24px' }}>
          <strong>{request.sourceDeviceName}</strong> wants to send you:<br/>
          <span style={{ color: 'var(--color-accent)', fontWeight: 'bold' }}>{request.fileName}</span><br/>
          ({(request.fileSize / 1024 / 1024).toFixed(2)} MB)
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <button 
            className="btn btn-secondary" 
            onClick={() => declineFile(request)}
            style={{ flex: 1 }}
          >
            Decline
          </button>
          <button 
            className="btn btn-primary" 
            onClick={() => acceptFile(request)}
            style={{ flex: 1 }}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
