/** Media Receiver - Displays WebRTC incoming streams (Screen/Audio) on Mobile */
import React, { useEffect, useRef, useState } from 'react';
import { useAppContext } from '../contexts/AppContext';

export function MediaReceiver() {
  const { state } = useAppContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    const handleStream = (e: any) => {
      const stream = e.detail.stream as MediaStream;
      const sourceDeviceId = e.detail.sourceDeviceId as string;
      if (!stream) return;

      // Stop previous stream if any
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
      }

      stream.getTracks().forEach(track => {
        track.onended = () => {
          if (activeStreamRef.current === stream) {
            setActiveStream(null);
            activeStreamRef.current = null;
          }
        };
      });

      setActiveStream(stream);
      activeStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    };

    window.addEventListener('goondrop_webrtc_stream', handleStream);
    return () => {
      window.removeEventListener('goondrop_webrtc_stream', handleStream);
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
        activeStreamRef.current = null;
      }
    };
  }, []);

  if (!activeStream) return null;

  const videoTrackCount = activeStream.getVideoTracks().length;
  const audioTrackCount = activeStream.getAudioTracks().length;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: '#000',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      <div style={{ position: 'absolute', top: '20px', right: '20px', zIndex: 10000, display: 'flex', gap: '8px' }}>
        <span style={{
          background: 'rgba(0,0,0,0.5)',
          color: 'var(--color-success)',
          padding: '6px 12px',
          borderRadius: '20px',
          fontSize: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px'
        }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-success)', animation: 'pulse 2s infinite' }} />
          {videoTrackCount > 0 ? '📹 Casting' : audioTrackCount > 0 ? '🎙️ Audio' : '📡 Stream'}
        </span>
        <button 
          onClick={() => { setActiveStream(null); activeStreamRef.current = null; }}
          style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '50%', width: '44px', height: '44px', color: 'white', fontSize: '20px', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>

      {videoTrackCount > 0 ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : (
        <div style={{ color: 'white', textAlign: 'center', padding: '40px' }}>
          <div style={{ fontSize: '4rem', marginBottom: '16px' }}>🔊</div>
          <p>Receiving System Audio...</p>
        </div>
      )}
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
