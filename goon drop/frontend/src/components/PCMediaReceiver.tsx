import React, { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../contexts/AppContext';

export function PCMediaReceiver() {
  const { state } = useAppContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const [activeStream, setActiveStream] = useState<{ stream: MediaStream; sourceDeviceId: string } | null>(null);

  useEffect(() => {
    const handleStream = (e: any) => {
      const { stream, sourceDeviceId } = e.detail;
      if (!stream || !sourceDeviceId) return;

      // Stop previous stream if any
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      }

      stream.getTracks().forEach((track: MediaStreamTrack) => {
        track.onended = () => {
          if (activeStreamRef.current === stream) {
            setActiveStream(null);
            activeStreamRef.current = null;
          }
        };
      });

      setActiveStream({ stream, sourceDeviceId });
      activeStreamRef.current = stream;
      
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        if (audioRef.current) {
          audioRef.current.srcObject = stream;
        }
      });
    };

    window.addEventListener('goondrop_webrtc_stream', handleStream);
    return () => {
      window.removeEventListener('goondrop_webrtc_stream', handleStream);
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        activeStreamRef.current = null;
      }
    };
  }, []);

  if (!activeStream) return null;

  const sender = state.devices.find(d => d.id === activeStream.sourceDeviceId);
  const senderName = sender ? sender.name : 'Unknown Device';

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: '320px',
      height: '240px',
      background: '#000',
      borderRadius: 'var(--radius-lg)',
      border: '2px solid var(--color-accent)',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
      zIndex: 10000,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      transition: 'all 0.3s ease'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '8px 12px', 
        background: 'rgba(0,0,0,0.7)', 
        color: 'white',
        fontSize: 'var(--text-xs)'
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-success)', animation: 'pulse 2s infinite' }} />
          🔴 {senderName}
        </span>
        <button 
          onClick={() => { setActiveStream(null); activeStreamRef.current = null; }}
          style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '16px' }}
        >
          ✕
        </button>
      </div>
      
      <div style={{ flex: 1, position: 'relative', background: '#000' }}>
        {activeStream.stream.getVideoTracks().length > 0 ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ 
            height: '100%', 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center', 
            color: 'var(--color-accent)',
            textAlign: 'center',
            padding: '20px'
          }}>
            <div style={{ fontSize: '3rem', marginBottom: '8px' }}>🎙️</div>
            <p style={{ fontSize: 'var(--text-xs)' }}>Listening to {senderName}'s Mic...</p>
          </div>
        )}
        <audio ref={audioRef} autoPlay playsInline />
      </div>

      <style>{`
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.4; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
