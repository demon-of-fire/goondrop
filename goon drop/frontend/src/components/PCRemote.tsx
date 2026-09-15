/** PC Remote Control - Trackpad, Keyboard, Media keys, Diagnostic Telemetry & Task Killer */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { announce } from '../utils/accessibility';
import { CastController } from './CastController';
import { LiveBridge } from './LiveBridge';

interface PcStats {
  cpu: number;
  ram: number;
  battery: number;
}

interface ProcessItem {
  id: number;
  name: string;
  title: string;
  memory: number;
}

export function PCRemote() {
  const { state, sendMessage, addToast } = useAppContext();
  const { paired, connectionStatus, deviceId, pairingToken } = state;
  const isConnected = connectionStatus === 'connected' && paired;

  const padRef = useRef<HTMLDivElement>(null);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  const clickTimerRef = useRef<number>(0);

  // Diagnostic, Process, Keyboard, and Gyroscopic Mouse States
  const [stats, setStats] = useState<PcStats | null>(null);
  const [processes, setProcesses] = useState<ProcessItem[]>([]);
  const [keyboardText, setKeyboardText] = useState('');
  const [gyroActive, setGyroActive] = useState(false);
  const lastGyroTime = useRef(0);

  // Telemetry & Process polling
  useEffect(() => {
    if (!isConnected) return;

    const fetchStats = () => {
      fetch('/api/internal/pc-stats', {
        headers: {
          'X-Client-Id': deviceId,
          'X-Client-Token': pairingToken
        }
      })
        .then(res => res.json())
        .then(data => setStats(data))
        .catch(() => {});

      fetch('/api/internal/processes', {
        headers: {
          'X-Client-Id': deviceId,
          'X-Client-Token': pairingToken
        }
      })
        .then(res => res.json())
        .then(data => setProcesses(data))
        .catch(() => {});
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3500); // Poll every 3.5 seconds
    return () => clearInterval(interval);
  }, [isConnected, deviceId, pairingToken]);

  const handleKillProcess = (id: number, name: string) => {
    if (!isConnected) return;
    addToast(`Killing task natively: ${name}...`, 'info');

    fetch('/api/internal/kill', {
      method: 'POST',
      headers: {
        'X-Client-Id': deviceId,
        'X-Client-Token': pairingToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id })
    })
    .then(res => res.json())
    .then(() => {
      setProcesses(prev => prev.filter(p => p.id !== id));
      addToast(`Killed task: ${name}`, 'success');
      announce(`Task ${name} terminated successfully`);
    })
    .catch(() => addToast('Failed to kill process.', 'error'));
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isConnected) return;
    const touch = e.touches[0];
    lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isConnected || !lastTouchRef.current) return;
    e.preventDefault();

    const touch = e.touches[0];
    const dx = Math.round((touch.clientX - lastTouchRef.current.x) * 1.5);
    const dy = Math.round((touch.clientY - lastTouchRef.current.y) * 1.5);

    if (dx !== 0 || dy !== 0) {
      sendMessage({
        type: 'mouse_move',
        payload: { dx, dy }
      });
      lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!isConnected) return;
    lastTouchRef.current = null;

    const now = Date.now();
    if (now - clickTimerRef.current < 200) {
      sendMessage({
        type: 'mouse_click',
        payload: { clickType: 'right' }
      });
    } else {
      sendMessage({
        type: 'mouse_click',
        payload: { clickType: 'left' }
      });
    }
    clickTimerRef.current = now;
  };

  const sendMediaCommand = (command: string) => {
    if (!isConnected) return;
    sendMessage({
      type: 'media_command',
      payload: { command }
    });
  };

  const handleKeyboardType = (text: string) => {
    if (!isConnected) return;
    sendMessage({
      type: 'keyboard_type',
      payload: { text }
    });
  };

  const sendPowerCommand = (command: 'lock_pc' | 'sleep_pc') => {
    if (!isConnected) return;
    sendMessage({
      type: command,
      payload: {}
    });
    addToast(command === 'lock_pc' ? 'Locking Windows PC...' : 'Putting PC to Sleep...', 'warning');
  };

  // Gyroscopic Mouse Controller (Party Trick!)
  const toggleGyroMouse = () => {
    const DeviceMotionEventClass = (window as any).DeviceMotionEvent;
    if (DeviceMotionEventClass && typeof DeviceMotionEventClass.requestPermission === 'function') {
      DeviceMotionEventClass.requestPermission()
        .then((permissionState: string) => {
          if (permissionState === 'granted') {
            setGyroActive(!gyroActive);
            addToast(!gyroActive ? 'Gyroscopic Mouse Active!' : 'Gyroscopic Mouse Stopped.', 'success');
          } else {
            addToast('Gyroscope access denied.', 'error');
          }
        })
        .catch(() => addToast('Could not request gyroscope.', 'error'));
    } else {
      setGyroActive(!gyroActive);
      addToast(!gyroActive ? 'Gyroscopic Mouse Active!' : 'Gyroscopic Mouse Stopped.', 'success');
    }
  };

  useEffect(() => {
    if (!gyroActive || !isConnected) return;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const now = Date.now();
      if (now - lastGyroTime.current > 60) { // Limit mouse updates to 60ms intervals (prevents packet floods!)
        lastGyroTime.current = now;
        
        // Use Device Gamma & Beta angles for relative mouse movements!
        const dx = Math.round(e.gamma || 0) * 1.5;
        const dy = Math.round(e.beta || 0) * 1.5;
        
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          sendMessage({
            type: 'mouse_move',
            payload: { dx, dy }
          });
        }
      }
    };

    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, [gyroActive, isConnected, sendMessage]);

  return (
    <section aria-labelledby="remote-heading" className="responsive-grid">
      <h2 id="remote-heading" className="sr-only">PC Remote</h2>

      {/* Left Column: Trackpad, Keyboard & Media */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {/* Trackpad area */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Laptop Trackpad</span>
            <button
              className="btn btn-secondary"
              onClick={toggleGyroMouse}
              style={{ fontSize: 'var(--text-xs)', minHeight: '32px', height: '32px', borderColor: gyroActive ? 'var(--color-success)' : 'var(--color-border)', color: gyroActive ? 'var(--color-success)' : 'var(--color-text)' }}
            >
              {gyroActive ? 'Gyro Mouse Active' : 'Turn on Gyro Mouse'}
            </button>
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Slide your finger inside the box to move your PC mouse cursor. Tap to left-click, double-tap to right-click.
          </p>
          <div
            ref={padRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{
              width: '100%',
              height: '200px',
              background: 'var(--color-bg)',
              border: '2px dashed var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              userSelect: 'none',
              touchAction: 'none',
              cursor: 'crosshair'
            }}
          >
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', pointerEvents: 'none' }}>
              {isConnected ? '[ SWIPE TO CONTROL MOUSE ]' : 'Connect server to control'}
            </span>
          </div>
        </div>

         {/* Native Remote Keyboard Typing Card (New!) */}
         <div className="card">
           <div className="card-header">
             <span className="card-title">Remote Keyboard</span>
           </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Type or paste text. Characters will instantly type out natively on your laptop's focused window!
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <label htmlFor="remote-keyboard-box" className="sr-only">Type on PC</label>
            <input
              id="remote-keyboard-box"
              type="text"
              value={keyboardText}
              onKeyDown={(e) => {
                if (e.key === 'Backspace') {
                  handleKeyboardType('{BACKSPACE}');
                } else if (e.key === 'Enter') {
                  handleKeyboardType('{ENTER}');
                } else if (e.key === ' ') {
                  handleKeyboardType(' ');
                }
              }}
              onChange={(e) => {
                const val = e.target.value;
                if (val.length > 0) {
                  const lastChar = val.substring(val.length - 1);
                  // Ignore spaces since they are handled natively by keydown to prevent duplicates!
                  if (lastChar !== ' ') {
                    handleKeyboardType(lastChar);
                  }
                  setKeyboardText(''); // Instantly clear buffer for zero-duplication typing!
                }
              }}
              placeholder="Type to send keystrokes..."
              disabled={!isConnected}
              style={{ flex: 1, minHeight: '44px' }}
            />
            <button
              className="btn btn-secondary"
              onClick={() => setKeyboardText('')}
              style={{ minHeight: '44px' }}
            >
              Clear
            </button>
          </div>
        </div>

         {/* Media Controller card */}
         <div className="card">
           <div className="card-header">
             <span className="card-title">Volume & Media</span>
           </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={() => sendMediaCommand('volume_mute')} disabled={!isConnected} aria-label="Mute Volume">
              🔇 Mute
            </button>
            <button className="btn btn-secondary" onClick={() => sendMediaCommand('volume_down')} disabled={!isConnected} aria-label="Volume Down">
              🔉 Vol −
            </button>
            <button className="btn btn-secondary" onClick={() => sendMediaCommand('volume_up')} disabled={!isConnected} aria-label="Volume Up">
              🔊 Vol +
            </button>

            <button className="btn btn-secondary" onClick={() => sendMediaCommand('media_prev')} disabled={!isConnected} aria-label="Previous Track">
              ⏮️ Prev
            </button>
            <button className="btn btn-primary" onClick={() => sendMediaCommand('media_play')} disabled={!isConnected} aria-label="Play or Pause Media">
              ⏯️ Play/Pause
            </button>
            <button className="btn btn-secondary" onClick={() => sendMediaCommand('media_next')} disabled={!isConnected} aria-label="Next Track">
              ⏭️ Next
            </button>
          </div>
        </div>
      </div>

       {/* Right Column: Diagnostic, Processes & Power Control */}
       <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
         <CastController />
         {/* Telemetry Card */}
         <div className="card">

          <div className="card-header">
            <span className="card-title">📊 PC Hardware Monitor</span>
          </div>
          {isConnected && stats ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* CPU */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', marginBottom: '4px' }}>
                  <span>CPU Usage</span>
                  <span style={{ color: 'var(--color-accent)' }}>{stats.cpu}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${stats.cpu}%`, background: 'var(--color-accent)' }} />
                </div>
              </div>

              {/* RAM */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', marginBottom: '4px' }}>
                  <span>Physical RAM Load</span>
                  <span style={{ color: '#00bfff' }}>{stats.ram}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${stats.ram}%`, background: '#00bfff' }} />
                </div>
              </div>

              {/* Laptop Battery */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', marginBottom: '4px' }}>
                  <span>Laptop Battery</span>
                  <span style={{ color: '#ffd700' }}>{stats.battery}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${stats.battery}%`, background: '#ffd700' }} />
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', padding: '16px' }}>
              Connect server to view telemetry
            </div>
          )}
        </div>

        {/* Task Killer / Active Applications Card */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">💀 Active App Task Killer</span>
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            View open desktop windows on your laptop. Click the 💀 skull button next to any app to instantly terminate it!
          </p>

          {isConnected && processes.length > 0 ? (
            <div style={{ maxHeight: '120px', overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '4px' }}>
              {processes.map(proc => (
                <div
                  key={`process-${proc.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--color-border)',
                    fontSize: 'var(--text-xs)'
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', marginRight: '8px' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 'bold' }}>
                      {proc.title}
                    </span>
                    <span style={{ fontSize: '9px', color: 'var(--color-text-muted)' }}>
                      {proc.name}.exe • {proc.memory} MB RAM
                    </span>
                  </div>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleKillProcess(proc.id, proc.name)}
                    style={{ fontSize: 'var(--text-sm)', padding: '4px 8px', minHeight: 'auto', color: 'var(--color-error)' }}
                    title={`Terminate ${proc.name}`}
                    aria-label={`Terminate ${proc.name}`}
                  >
                    💀
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', padding: '16px' }}>
              {isConnected ? 'No active user window tasks detected.' : 'Connect server to view active tasks.'}
            </div>
          )}
        </div>

        {/* 💤 Native Windows Power Manager Card (New!) */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">⚡ Remote Windows Power Manager</span>
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Put your laptop to sleep or lock Windows natively from your phone securely (TouchID/FaceID required if enabled).
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn btn-secondary"
              onClick={() => sendPowerCommand('lock_pc')}
              disabled={!isConnected}
              style={{ flex: 1, minHeight: '40px', height: '40px', borderColor: 'var(--color-error)', color: 'var(--color-error)' }}
              aria-label="Lock Windows PC"
            >
              🔒 Lock Windows
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => sendPowerCommand('sleep_pc')}
              disabled={!isConnected}
              style={{ flex: 1, minHeight: '40px', height: '40px', borderColor: 'var(--color-warning)', color: 'var(--color-warning)' }}
              aria-label="Put Windows PC to Sleep"
            >
              💤 Sleep Laptop
            </button>
          </div>
        </div>
      </div>

      {/* Right Column: Audio Cast & Live Bridge */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <LiveBridge />
        <CastController />
      </div>
    </section>
  );
}
