/** File sharing component - Batch share, Continuity Camera, and Whiteboard Signature Pad */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAppContext } from '../contexts/AppContext';
import { announceSuccess, announceError } from '../utils/accessibility';
import { formatFileSize } from './shared-utils';

export function FileShare() {
  const { state, dispatch, sendMessage, addToast } = useAppContext();
  const { fileTransfers, paired, connectionStatus, deviceId, pairingToken } = state;
  const isConnected = connectionStatus === 'connected' && paired;

  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isCameraMode, setIsCameraMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasCaptureRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setIsCameraMode(true);
      }
    } catch (err) {
      addToast('Camera access denied or unavailable.', 'error');
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream;
    stream?.getTracks().forEach(track => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraMode(false);
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasCaptureRef.current;
    if (video && canvas) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      canvas.toBlob(blob => {
        if (blob) {
          const file = new File([blob], `cam_${Date.now()}.png`, { type: 'image/png' });
          sendFile(file);
          stopCamera();
          addToast('Photo beamed to PC!', 'success');
        }
      }, 'image/png');
    }
  };

  // Whiteboard Canvas State
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // Remote File Explorer State (New!)
  const [showExplorer, setShowExplorer] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [explorerData, setExplorerData] = useState<{ parentPath: string | null; files: any[] } | null>(null);

  // File Preview Modal State (Omega UX!)
  const [previewFile, setPreviewFile] = useState<any>(null);

  // Offline File Vault History State (New!)
  const [vault, setVault] = useState<any[]>(() => {
    try {
      const saved = window.localStorage.getItem('goondrop_file_vault');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // Automatically lock completed transfers into the local history vault!
  useEffect(() => {
    const completed = fileTransfers.filter(ft => ft.status === 'complete' && ft.downloadUrl);
    if (completed.length > 0) {
      setVault(prev => {
        const updated = [...prev];
        completed.forEach(ft => {
          if (!updated.some(item => item.fileId === ft.fileId)) {
            updated.unshift({
              fileId: ft.fileId,
              fileName: ft.fileName,
              fileSize: ft.fileSize,
              mimeType: ft.mimeType,
              downloadUrl: ft.downloadUrl,
              timestamp: Date.now()
            });
          }
        });
        const trimmed = updated.slice(0, 30); // Keep last 30 files
        window.localStorage.setItem('goondrop_file_vault', JSON.stringify(trimmed));
        return trimmed;
      });
    }
  }, [fileTransfers]);

  const fetchDirectory = useCallback((path: string | null = null) => {
    if (!isConnected) return;
    const url = path ? `/api/internal/browse?path=${encodeURIComponent(path)}` : '/api/internal/browse';
    fetch(url, {
      headers: {
        'X-Client-Id': deviceId,
        'X-Client-Token': pairingToken
      }
    })
      .then(res => res.json())
      .then(data => {
        setExplorerData(data);
        setCurrentPath(data.currentPath);
      })
      .catch(() => addToast('Failed to load remote directory.', 'error'));
  }, [isConnected, deviceId, pairingToken, addToast]);

  const handleRemoteDownload = (filePath: string, fileName: string) => {
    if (!isConnected) return;
    addToast(`Requesting download: ${fileName}`, 'info');
    
    fetch('/api/internal/send-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': deviceId,
        'X-Client-Token': pairingToken
      },
      body: JSON.stringify({ filePath })
    })
    .catch(() => addToast('File request failed.', 'error'));
  };

  useEffect(() => {
    if (showExplorer) {
      fetchDirectory(currentPath);
    }
  }, [showExplorer, currentPath, fetchDirectory]);

  const CHUNK_SIZE = 65536; // 64KB
  const MAX_FILE_SIZE = 1073741824; // 1GB (backend must also allow this)

  // Configure Whiteboard Canvas on mount and auto-resize dynamically with High-DPI (Retina) support!
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const width = canvas.parentElement?.clientWidth || 300;
        const height = 160;
        const dpr = window.devicePixelRatio || 1;

        const ctx = canvas.getContext('2d');
        
        // Save existing drawing before resize (canvas resets on dimension change)
        let prevImageData: ImageData | null = null;
        if (ctx && canvas.width > 0 && canvas.height > 0) {
          prevImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        }

        // Set high-density pixel buffer size
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        
        // Scale back down CSS visual size
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        if (ctx) {
          // Use setTransform to replace (not multiply) the current transform matrix
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#00e5a0'; // Theme Accent Color
          ctx.lineWidth = 3;
          ctxRef.current = ctx;

          // Restore previous drawing scaled to new dimensions
          if (prevImageData) {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = prevImageData.width;
            tempCanvas.height = prevImageData.height;
            const tempCtx = tempCanvas.getContext('2d');
            if (tempCtx) {
              tempCtx.putImageData(prevImageData, 0, 0);
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
              ctx.restore();
            }
          }
        }
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const sendFile = useCallback((file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      addToast(`File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}`, 'error');
      announceError(`File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}`);
      return;
    }

    const fileId = `file-${crypto.randomUUID()}`;

    dispatch({
      type: 'ADD_FILE_TRANSFER',
      payload: {
        fileId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        progress: 0,
        status: 'sending',
        sourceDeviceId: deviceId,
        sourceDeviceName: state.deviceName,
      },
    });

    addToast(`AirDropping: ${file.name}`, 'info');

    const formData = new FormData();
    formData.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/drop', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const progress = e.loaded / e.total;
        dispatch({
          type: 'UPDATE_FILE_PROGRESS',
          payload: { fileId, progress }
        });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        dispatch({
          type: 'UPDATE_FILE_PROGRESS',
          payload: { fileId, progress: 1 }
        });
        dispatch({
          type: 'SET_FILE_TRANSFER_STATUS',
          payload: { fileId, status: 'complete' }
        });
        addToast(`✓ AirDropped to Windows: ${file.name}`, 'success');
        announceSuccess(`File sent: ${file.name}`);
      } else {
        dispatch({
          type: 'SET_FILE_TRANSFER_STATUS',
          payload: { fileId, status: 'error' }
        });
        addToast(`Upload failed: ${xhr.statusText || 'Server error'}`, 'error');
      }
    };

    xhr.onerror = () => {
      dispatch({
        type: 'SET_FILE_TRANSFER_STATUS',
        payload: { fileId, status: 'error' }
      });
      addToast(`Network error sending ${file.name}`, 'error');
    };

    xhr.send(formData);
    setSelectedFile(null);
  }, [addToast, deviceId, dispatch, state.deviceName]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      Array.from(files).forEach(file => {
        sendFile(file);
      });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      Array.from(files).forEach(file => {
        sendFile(file);
      });
    }
  };

  // Last drawing coordinates
  const lastXRef = useRef(0);
  const lastYRef = useRef(0);

  // Collaborative Drawing Sync Listener
  useEffect(() => {
    const handleDrawingMessage = (e: CustomEvent) => {
      const { type, payload } = e.detail;
      if (type === 'draw_line' && ctxRef.current) {
        const ctx = ctxRef.current;
        ctx.beginPath();
        ctx.moveTo(payload.lastX, payload.lastY);
        ctx.lineTo(payload.x, payload.y);
        ctx.stroke();
        ctx.closePath();
      }
    };
    window.addEventListener('goondrop_ws_message' as any, handleDrawingMessage);
    return () => window.removeEventListener('goondrop_ws_message' as any, handleDrawingMessage);
  }, []);

  // Whiteboard Canvas Drawing Logic
  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (!ctxRef.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    
    let x, y;
    if ('touches' in e) {
      x = e.touches[0].clientX - rect.left;
      y = e.touches[0].clientY - rect.top;
    } else {
      x = e.clientX - rect.left;
      y = e.clientY - rect.top;
    }

    ctxRef.current.beginPath();
    ctxRef.current.moveTo(x, y);
    
    lastXRef.current = x;
    lastYRef.current = y;
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || !ctxRef.current || !canvasRef.current) return;
    if ('touches' in e) {
      e.preventDefault(); // Prevent scrolling while signing
    }

    const rect = canvasRef.current.getBoundingClientRect();
    let x, y;
    if ('touches' in e) {
      x = e.touches[0].clientX - rect.left;
      y = e.touches[0].clientY - rect.top;
    } else {
      x = e.clientX - rect.left;
      y = e.clientY - rect.top;
    }

    ctxRef.current.lineTo(x, y);
    ctxRef.current.stroke();

    // Broadcast drawing coordinates over Wi-Fi in real-time! (Collaborative whiteboard!)
    sendMessage({
      type: 'draw_line',
      payload: { x, y, lastX: lastXRef.current, lastY: lastYRef.current }
    });

    lastXRef.current = x;
    lastYRef.current = y;
  };

  const stopDrawing = () => {
    if (!ctxRef.current) return;
    ctxRef.current.closePath();
    setIsDrawing(false);
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (canvas && ctxRef.current) {
      ctxRef.current.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const sendCanvasAsImage = () => {
    const canvas = canvasRef.current;
    if (!canvas || !isConnected) return;

    // Export canvas drawing as base64 PNG
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `signature_${Date.now()}.png`, { type: 'image/png' });
        sendFile(file);
        clearCanvas();
        addToast('Signature beamed to PC!', 'success');
      }
    }, 'image/png');
  };

  return (
    <section aria-labelledby="files-heading" className="responsive-grid">
      <h2 id="files-heading" className="sr-only">File Sharing</h2>

       {/* Drop Zone & Continuity Camera Column */}
       <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
         {/* Drop Zone */}
         <div
           ref={dropRef}
           className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
           onDragOver={handleDragOver}
           onDragLeave={handleDragLeave}
           onDrop={handleDrop}
           role="button"
           tabIndex={0}
           aria-label="Drop a file here or click to select"
           onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
           onClick={() => fileInputRef.current?.click()}
         >
           <div className="drop-zone-label">
             <span aria-hidden="true" style={{ fontSize: 'var(--text-2xl)' }}>📁</span>
             <span>Drop a file here, or click to select</span>
             <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Maximum file size: {formatFileSize(MAX_FILE_SIZE)}</span>
           </div>
         </div>
 
         <input
           ref={fileInputRef}
           type="file"
           multiple
           className="file-input-sr"
           onChange={handleFileSelect}
           aria-label="Select files to share"
           tabIndex={-1}
         />
 
         {/* 📷 Continuity Camera (iOS Only UI but works globally) */}
         <div className="card">
           <div className="card-header">
             <span className="card-title">📷 Goon Cam (Live Viewfinder)</span>
           </div>
           <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
             {isCameraMode 
               ? 'Live camera feed active. Tap the shutter to beam a photo instantly!' 
               : 'Open a live viewfinder to snap and beam photos directly from your camera.'}
           </p>
           
           {isCameraMode ? (
             <div style={{ position: 'relative', width: '100%', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: '#000', aspectRatio: '4/3' }}>
               <video
                 ref={videoRef}
                 autoPlay
                 playsInline
                 style={{ width: '100%', height: '100%', objectFit: 'cover' }}
               />
               <div style={{ position: 'absolute', bottom: '12px', left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: '16px' }}>
                 <button
                   className="btn btn-secondary"
                   onClick={stopCamera}
                   style={{ width: '44px', height: '44px', borderRadius: '50%', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   aria-label="Close camera"
                 >
                   ✕
                 </button>
                 <button
                   className="btn btn-primary"
                   onClick={capturePhoto}
                   style={{ width: '56px', height: '56px', borderRadius: '50%', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '4px solid var(--color-bg)', boxShadow: '0 0 10px rgba(0,0,0,0.5)' }}
                   aria-label="Capture photo"
                 >
                   📸
                 </button>
               </div>
               <canvas ref={canvasCaptureRef} style={{ display: 'none' }} />
             </div>
           ) : (
             <>
               <button
                 className="btn btn-primary"
                 style={{ width: '100%', minHeight: '44px', height: '44px' }}
                 disabled={!isConnected}
                 onClick={startCamera}
               >
                 📷 Open Goon Cam (Live)
               </button>
               <input
                 ref={cameraInputRef}
                 type="file"
                 accept="image/*"
                 capture="environment"
                 className="file-input-sr"
                 onChange={handleFileSelect}
                 tabIndex={-1}
               />
             </>
            )}
          </div>
        </div>

      {/* 🎨 Interactive Whiteboard & Signature Pad Card (New!) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {/* Remote File Explorer (Omega Flex!) */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📂 Remote File Explorer</span>
            <button
              className="btn btn-ghost"
              onClick={() => setShowExplorer(!showExplorer)}
              style={{ fontSize: 'var(--text-xs)', minHeight: 32 }}
            >
              {showExplorer ? 'Hide Explorer' : 'Open Explorer'}
            </button>
          </div>
          
          {showExplorer && isConnected && explorerData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Path: {currentPath}
              </div>
              
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="btn btn-secondary"
                  disabled={!explorerData.parentPath}
                  onClick={() => fetchDirectory(explorerData.parentPath)}
                  style={{ flex: 1, minHeight: '36px', height: '36px', fontSize: 'var(--text-xs)' }}
                >
                  ⬅️ Up Folder
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => fetchDirectory(currentPath)}
                  style={{ flex: 1, minHeight: '36px', height: '36px', fontSize: 'var(--text-xs)' }}
                >
                  🔄 Refresh
                </button>
              </div>

              <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '4px' }}>
                {explorerData.files.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', padding: '16px' }}>
                    Empty directory
                  </div>
                ) : (
                  explorerData.files.map((file, i) => (
                    <div
                      key={`file-explorer-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 8px',
                        borderBottom: '1px solid var(--color-border)',
                        fontSize: 'var(--text-xs)'
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px', color: file.isDirectory ? 'var(--color-accent)' : 'var(--color-text)' }}>
                        {file.isDirectory ? '📁 ' : '📄 '}{file.name}
                      </span>
                      {file.isDirectory ? (
                        <button
                          className="btn btn-ghost"
                          onClick={() => fetchDirectory(file.path)}
                          style={{ fontSize: 'var(--text-xs)', padding: '4px 8px', minHeight: 'auto', color: 'var(--color-accent)' }}
                        >
                          Open
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary"
                          onClick={() => handleRemoteDownload(file.path, file.name)}
                          style={{ fontSize: 'var(--text-xs)', padding: '4px 8px', minHeight: 'auto' }}
                        >
                          Get File
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {!isConnected && (
            <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', padding: '12px' }}>
              Connect server to browse files
            </div>
          )}
        </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Whiteboard / Signature Pad</span>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
              Draw a sketch or sign with your finger. Tapping "Beam Signature" sends it instantly as a transparent PNG!
            </p>
          
          <canvas
            ref={canvasRef}
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
            style={{
              background: '#0d0d0d',
              border: '2px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              width: '100%',
              height: '160px',
              display: 'block',
              cursor: 'crosshair',
              touchAction: 'none'
            }}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-secondary" onClick={clearCanvas} style={{ flex: 1, minHeight: '36px', height: '36px' }}>
              Clear
            </button>
             <button className="btn btn-primary" disabled={!isConnected} onClick={sendCanvasAsImage} style={{ flex: 2, minHeight: '36px', height: '36px' }}>
               Beam Signature
             </button>
          </div>
        </div>

        {/* Active Transfers */}
        {fileTransfers.length > 0 && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">Transfers</span>
            </div>
            <div role="list" aria-label="Active file transfers">
              {fileTransfers.map(ft => (
                <div key={ft.fileId} className="transfer-progress" role="listitem">
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
                    {ft.status === 'complete' ? (
                      <button
                        onClick={() => setPreviewFile(ft)}
                        style={{ fontWeight: 'bold', textDecoration: 'underline', color: 'var(--color-accent)', cursor: 'pointer', textAlign: 'left', background: 'none', border: 'none', padding: 0 }}
                        title="Click to preview file"
                      >
                        {ft.fileName}
                      </button>
                    ) : (
                      <span>{ft.fileName}</span>
                    )}
                    <span style={{ color: 'var(--color-text-muted)' }}>{formatFileSize(ft.fileSize)}</span>
                  </div>
                  {(ft.status === 'queued' || ft.status === 'sending' || ft.status === 'receiving') && (
                    <>
                      <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(ft.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Transfer progress for ${ft.fileName}`}>
                        <div className="progress-fill" style={{ width: `${ft.progress * 100}%` }} />
                      </div>
                      <div className="progress-text">
                        <span>{Math.round(ft.progress * 100)}%</span>
                        <span>
                          {ft.status === 'sending' ? 'Sending securely…' : ft.status === 'queued' ? 'Waiting to start…' : ft.sourceDeviceName ? `From: ${ft.sourceDeviceName}` : 'Receiving…'}
                        </span>
                      </div>
                      {ft.status === 'sending' && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => {
                            sendMessage({ type: 'file_cancel', payload: { fileId: ft.fileId } });
                            dispatch({ type: 'SET_FILE_TRANSFER_STATUS', payload: { fileId: ft.fileId, status: 'cancelled' } });
                          }}
                          style={{ marginTop: 8, color: 'var(--color-error)' }}
                        >
                          Cancel transfer
                        </button>
                      )}
                    </>
                  )}
                  {ft.status === 'complete' && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginTop: '8px' }}>
                      <div style={{ color: 'var(--color-success)', fontSize: 'var(--text-sm)' }}>
                        {ft.sourceDeviceId === state.deviceId || (state.deviceType === 'windows' && ft.sourceDeviceId === 'local-windows-pc')
                          ? '✓ Sent Successfully'
                          : '✓ Complete (Click name to preview)'}
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {ft.downloadUrl && !(ft.sourceDeviceId === state.deviceId || (state.deviceType === 'windows' && ft.sourceDeviceId === 'local-windows-pc')) && (
                         <a
                           href={ft.downloadUrl}
                           download={ft.fileName}
                           className="btn btn-primary"
                           style={{ fontSize: 'var(--text-xs)', padding: '4px 8px', minHeight: '32px', height: '32px', textDecoration: 'none' }}
                         >
                           Save File
                         </a>
                        )}
                        {'share' in navigator && (
                           <button
                             className="btn btn-ghost"
                             style={{ fontSize: 'var(--text-xs)', padding: '4px 8px', minHeight: '32px', height: '32px' }}
                             onClick={async () => {
                               if (!ft.downloadUrl) return;
                               try {
                                 const res = await fetch(ft.downloadUrl);
                                 const blob = await res.blob();
                                 const fileObj = new File([blob], ft.fileName, { type: ft.mimeType || 'application/octet-stream' });
                                 if ('canShare' in navigator && (navigator as any).canShare({ files: [fileObj] })) {
                                   await navigator.share({ files: [fileObj], title: ft.fileName });
                                 } else {
                                   await navigator.share({ title: ft.fileName, url: window.location.origin + ft.downloadUrl });
                                 }
                               } catch (e: any) {
                                 if (e?.name !== 'AbortError') {
                                   window.open(ft.downloadUrl, '_blank');
                                 }
                               }
                             }}
                           >
                             Share to iOS
                           </button>
                        )}
                      </div>
                    </div>
                  )}
                  {ft.status === 'error' && (
                    <div style={{ color: 'var(--color-error)', fontSize: 'var(--text-sm)' }}>✗ Error</div>
                  )}
                  {ft.status === 'cancelled' && (
                    <div style={{ color: 'var(--color-warning)', fontSize: 'var(--text-sm)' }}>− Cancelled</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {fileTransfers.length === 0 && (
          <div className="card">
             <div className="empty-state" role="status">
               <div className="empty-state-icon" aria-hidden="true">File Folder</div>
               <p className="empty-state-text">No file transfers yet.<br />Drop a file above to share with connected devices.</p>
             </div>
          </div>
        )}

        {/* 📁 Persistent Offline File History Vault Card (New!) */}
        <div className="card">
           <div className="card-header">
             <span className="card-title">File Vault History ({vault.length})</span>
             {vault.length > 0 && (
               <button
                 className="btn btn-ghost"
                 onClick={() => {
                   setVault([]);
                   window.localStorage.removeItem('goondrop_file_vault');
                 }}
                 style={{ fontSize: 'var(--text-xs)', minHeight: '32px', height: '32px' }}
               >
                 Clear History
               </button>
             )}
           </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Persistent history of received files. You can redownload or preview any previous files from this device!
          </p>

          {vault.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', padding: '16px' }}>
              No vaulted files yet.
            </div>
          ) : (
            <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {vault.map((f, i) => (
                <div
                  key={`vault-item-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--color-border)',
                    fontSize: 'var(--text-xs)'
                  }}
                >
                  <button
                    onClick={() => setPreviewFile(f)}
                    style={{ fontWeight: 'bold', textDecoration: 'underline', color: 'var(--color-accent)', cursor: 'pointer', textAlign: 'left', background: 'none', border: 'none', padding: 0 }}
                    title="Click to preview file"
                  >
                    {f.fileName}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: 'var(--color-text-muted)' }}>{formatFileSize(f.fileSize)}</span>
                     <a
                       href={f.downloadUrl}
                       download={f.fileName}
                       className="btn btn-secondary"
                       style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', minHeight: '28px', height: '28px', display: 'flex', alignItems: 'center', textDecoration: 'none' }}
                     >
                       Save
                     </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 🖼️ Gorgeous Glassmorphic File Preview Modal Overlay (New!) */}
      {previewFile && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(10, 10, 10, 0.85)',
          backdropFilter: 'blur(15px)',
          WebkitBackdropFilter: 'blur(15px)',
          zIndex: 10003,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-lg)',
          animation: 'fadeIn 0.2s ease'
        }} role="dialog" aria-modal="true">
          <div className="card" style={{ width: '100%', maxWidth: '450px', background: 'var(--color-surface)', border: '2px solid var(--color-accent)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid var(--color-border)', paddingBottom: '8px' }}>
              <span style={{ fontWeight: 'bold', fontSize: 'var(--text-base)', color: 'var(--color-accent)' }}>📄 File Preview</span>
              <button onClick={() => setPreviewFile(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 'var(--text-base)', color: 'var(--color-text-muted)' }}>✕</button>
            </div>

            {/* Detect and Render Image Preview */}
            {(previewFile.fileName.toLowerCase().endsWith('.png') ||
              previewFile.fileName.toLowerCase().endsWith('.jpg') ||
              previewFile.fileName.toLowerCase().endsWith('.jpeg') ||
              previewFile.fileName.toLowerCase().endsWith('.webp') ||
              previewFile.fileName.toLowerCase().endsWith('.gif') ||
              previewFile.fileName.toLowerCase().endsWith('.svg')) ? (
              <div style={{ margin: '16px 0', background: '#080808', padding: '8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <img
                  src={previewFile.downloadUrl}
                  alt={previewFile.fileName}
                  style={{ maxWidth: '100%', maxHeight: '240px', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }}
                />
              </div>
            ) : (
             <div style={{ margin: '32px 0' }}>
               <div style={{ fontSize: '4rem', marginBottom: '12px' }}>File</div>
               <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Non-image file type</div>
             </div>
            )}

            {/* Metadata */}
            <div style={{ textAlign: 'left', fontSize: 'var(--text-sm)', color: 'var(--color-text)', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '20px' }}>
              <div><strong>Name:</strong> {previewFile.fileName}</div>
              <div><strong>Size:</strong> {formatFileSize(previewFile.fileSize)}</div>
              <div><strong>Type:</strong> {previewFile.mimeType || 'application/octet-stream'}</div>
              {previewFile.sourceDeviceName && <div><strong>From:</strong> {previewFile.sourceDeviceName}</div>}
            </div>

            {/* Actions */}
             <div style={{ display: 'flex', gap: '8px' }}>
               {previewFile.downloadUrl && (
                 <a
                   href={previewFile.downloadUrl}
                   download={previewFile.fileName}
                   className="btn btn-primary"
                   onClick={() => setPreviewFile(null)}
                   style={{ flex: 2, textDecoration: 'none', minHeight: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                 >
                   Download File
                 </a>
               )}
              <button
                className="btn btn-secondary"
                onClick={() => setPreviewFile(null)}
                style={{ flex: 1, minHeight: '44px' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
