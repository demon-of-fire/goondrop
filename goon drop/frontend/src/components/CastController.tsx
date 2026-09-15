/** PC Cast Controller - Initiate WebRTC Screen/Audio Sharing to mobile */
import React, { useState, useRef } from 'react';
import { useAppContext } from '../contexts/AppContext';

export function CastController() {
  const { state, sendMessage, peerConnections, addToast } = useAppContext();
  const [isCasting, setIsCasting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state.paired || state.deviceType !== 'windows') return null;

  const startCast = async (mode: 'audio') => {
    try {
      setIsCasting(true);
      setError(null);

      // 1. Get the stream (Audio Only)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });


      // 2. Find the target device (the paired mobile device)
      const targetDevice = state.devices.find(d => d.type === 'iphone' || d.type === 'android');
      if (!targetDevice) {
        throw new Error('No mobile device found to cast to.');
      }

      // 3. Create Peer Connection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      
      peerConnections.set(state.deviceId, pc);

      // 4. Add tracks to the connection
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          stream.getTracks().forEach(track => track.stop());
          peerConnections.delete(state.deviceId);
          setIsCasting(false);
        }
      };

      // 5. Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendMessage({
            type: 'webrtc_ice_candidate',
            payload: {
              targetDeviceId: targetDevice.id,
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex
            }
          });
        }
      };

      // 6. Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 7. Send Offer to target device
       sendMessage({
         type: 'webrtc_offer',
         payload: {
           targetDeviceId: targetDevice.id,
           senderDeviceId: state.deviceId,
           sdp: offer.sdp,
           type: 'offer'
         }
       });

      addToast(`Casting ${mode} to ${targetDevice.name}...`, 'success');

      // Handle stream ending (e.g. user clicks "Stop Sharing" in browser bar)
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => stopCast();
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.onended = () => stopCast();
      }

    } catch (err: any) {
      console.error('[CastController] Error:', err);
      setError(err.message);
      addToast(`Cast failed: ${err.message}`, 'error');
      setIsCasting(false);
    }
  };

  const stopCast = () => {
    const pc = peerConnections.get(state.deviceId);
    if (pc) {
      pc.getSenders().forEach(sender => {
        const track = sender.track;
        if (track) track.stop();
      });
      pc.close();
      peerConnections.delete(state.deviceId);
    }
    setIsCasting(false);
    addToast('Casting stopped.', 'info');
  };

  return (
    <div className="card" style={{ border: '1px solid var(--color-accent)' }}>
      <div className="card-header">
        <span className="card-title">🚀 Audio Cast</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {!isCasting ? (
          <>
            <button
              className="btn btn-secondary"
              onClick={() => startCast('audio')}
              style={{ minHeight: '44px', height: '44px' }}
            >
              🔊 Share Audio Only
            </button>
          </>
        ) : (

          <button
            className="btn btn-error"
            onClick={stopCast}
            style={{ minHeight: '44px', height: '44px', color: 'var(--color-error)' }}
          >
            🛑 Stop Casting
          </button>
        )}
        {error && <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)' }}>{error}</div>}
      </div>
    </div>
  );
}
