import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { announceSuccess } from '../utils/accessibility';

export function LiveBridge() {
  const { state, sendMessage, addToast, peerConnections } = useAppContext();
  const { paired, connectionStatus, deviceId, devices } = state;
  const isConnected = connectionStatus === 'connected' && paired;
  
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [bridgeMode, setBridgeMode] = useState<'camera' | 'mic'>('camera');
  
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Listen for WebRTC signaling messages
  useEffect(() => {
    const handleSignal = async (e: any) => {
      const { type, payload } = e.detail;
      if (!pcRef.current) return;

      if (type === 'webrtc_answer' && payload.targetDeviceId === deviceId) {
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          setStatus('live');
          announceSuccess('Live Bridge connection established!');
        } catch (err) {
          console.error('Failed to set remote description:', err);
          setStatus('idle');
        }
      } else if (type === 'webrtc_ice_candidate' && payload.targetDeviceId === deviceId) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate({
            candidate: payload.candidate,
            sdpMid: payload.sdpMid,
            sdpMLineIndex: payload.sdpMLineIndex
          }));
        } catch (err) {
          console.error('Failed to add ICE candidate:', err);
        }
      }
    };

    window.addEventListener('goondrop_ws_message', handleSignal);
    return () => window.removeEventListener('goondrop_ws_message', handleSignal);
  }, [deviceId]);

  const startBridge = useCallback(async () => {
    if (!isConnected) return;

    try {
      setStatus('connecting');
      
      // 1. Capture Media
      let stream: MediaStream;
      if (bridgeMode === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      streamRef.current = stream;

      // 2. Create Peer Connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      pcRef.current = pc;

      // Register in AppContext so other components can see it
      peerConnections.set(deviceId, pc);

      // Add tracks
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          peerConnections.delete(deviceId);
          stream.getTracks().forEach(track => track.stop());
          pcRef.current = null;
          streamRef.current = null;
          setStatus('idle');
        }
      };

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const pcDevice = devices.find(d => d.type === 'windows');
          if (pcDevice) {
            sendMessage({
              type: 'webrtc_ice_candidate',
              payload: {
                targetDeviceId: pcDevice.id,
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid,
                sdpMLineIndex: event.candidate.sdpMLineIndex
              }
            });
          }
        }
      };

      // 3. Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 4. Send Offer to PC
      const pcDevice = devices.find(d => d.type === 'windows');
      if (!pcDevice) {
        addToast('No Windows PC found to bridge to.', 'error');
        setStatus('idle');
        return;
      }

       sendMessage({
        type: 'webrtc_offer',
        payload: {
          targetDeviceId: pcDevice.id,
          senderDeviceId: deviceId,
          sdp: offer.sdp,
          type: 'offer'
        }
      });

      addToast(`Initiating ${bridgeMode} bridge...`, 'info');

    } catch (err: any) {
      console.error('Bridge error:', err);
      addToast(`Bridge failed: ${err.message}`, 'error');
      setStatus('idle');
    }
  }, [isConnected, bridgeMode, sendMessage, devices, deviceId, addToast, peerConnections]);

  const stopBridge = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    peerConnections.delete(deviceId);
    setStatus('idle');
    addToast('Live Bridge disconnected', 'info');
  }, [deviceId, peerConnections, addToast]);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">🌉 Live Bridge (Mobile → PC)</span>
      </div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
        Turn your iPhone into a live webcam or microphone for your PC.
      </p>
      
       <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
         {(['camera', 'mic'] as const).map(mode => (
           <button
             key={mode}
             className={`btn ${bridgeMode === mode ? 'btn-primary' : 'btn-secondary'}`}
             onClick={() => {
               if (status === 'idle') setBridgeMode(mode);
             }}
             style={{ flex: 1, fontSize: 'var(--text-xs)', textTransform: 'capitalize' }}
           >
             {mode}
           </button>
         ))}
       </div>

      {status === 'live' ? (
        <button className="btn btn-error" onClick={stopBridge} style={{ width: '100%', minHeight: '44px' }}>
          🛑 Stop Live Stream
        </button>
      ) : status === 'connecting' ? (
        <button className="btn btn-secondary" disabled style={{ width: '100%', minHeight: '44px' }}>
          ⌛ Connecting...
        </button>
      ) : (
        <button 
          className="btn btn-primary" 
          onClick={startBridge} 
          disabled={!isConnected}
          style={{ width: '100%', minHeight: '44px' }}
        >
          🚀 Start {bridgeMode} Bridge
        </button>
      )}
    </div>
  );
}
