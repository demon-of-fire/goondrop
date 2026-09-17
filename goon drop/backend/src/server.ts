/** Express server setup - serves API endpoints and static frontend */
import express from 'express';
import type { Express, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import QRCode from 'qrcode';
import busboy from 'busboy';
import type { AppConfig } from './config';
import type { FileTransferManager } from './filetransfer';
import type { ClipboardManager } from './clipboard';
import { generateId as genId, hashText, getMachineName } from './utils';
import { buildShortcutPlist, getShortcutDefinitions, SHORTCUT_CATEGORIES } from './shortcuts';

import type { PairingManager } from './pairing';
export function createServer(config: AppConfig, fileTransfer: FileTransferManager, clipboardManager: ClipboardManager, pairingManager: PairingManager, pushManager: any): Express {
  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ limit: '10mb' }));

  // ─── API Routes ──────────────────────────────────────────────────────────

  const getConnectedCount = () => fileTransfer.getConnManager().getClientCount();

  /** Tracks when the phone last pulled the clipboard via the sync shortcut —
   *  lets the server decide "newest wins" without fragile client branching. */
  let phoneClipboardSyncAt = 0;

  // ─── Native Windows helpers (no launcher dependency) ──────────────────────
  const { exec } = require('child_process');
  const ps = (command: string): Promise<string> => new Promise((resolve) => {
    exec(`powershell.exe -NoProfile -WindowStyle Hidden -command "${command.replace(/"/g, '\\"')}"`,
      { windowsHide: true, timeout: 20000 },
      (err: any, stdout: string, stderr: string) => resolve(err ? stderr || '' : stdout || ''));
  });

  const openInBrowser = (url: string) => {
    const safe = url.replace(/'/g, "''");
    exec(`powershell.exe -NoProfile -WindowStyle Hidden -command "Start-Process '${safe}'"`, () => {});
  };

  /** Forward a native command packet to the C# launcher's loopback listener (port 3945). */
  const sendLocalControl = (packet: Record<string, any>) => {
    try {
      const payload = JSON.stringify(packet);
      const req = http.request({
        hostname: '127.0.0.1',
        port: 3945,
        path: '/control/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, () => {});
      req.on('error', () => {});
      req.write(payload);
      req.end();
    } catch { }
  };

  /** Gate destructive/control endpoints behind the pairing code (LAN "password"). */
  const requireCode = (req: Request, res: Response, next: express.NextFunction) => {
    const given = String(req.query.code || req.header('x-goondrop-code') || req.body?.code || '');
    if (given.trim().toUpperCase() === config.pairingCode.trim().toUpperCase()) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized: invalid pairing code' });
  };

  /** Server info endpoint */
  app.get('/api/info', (_req: Request, res: Response) => {
    res.json({
      name: 'Goon Drop',
      version: '1.0.0',
      localIp: config.localIp,
      // The app is served on HTTPS at the next port; advertising the HTTP port
      // silently disables service workers, Web Push, camera, and WebAuthn on iOS.
      port: config.port + 1,
      connectedDevices: getConnectedCount(),
    });
  });

  /** Lightweight connection check used by the onboarding diagnostics. */
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      secureOriginExpected: true,
      serverTime: Date.now(),
      connectedDevices: getConnectedCount(),
    });
  });

  /** Downloadable LAN certificate for the one-time iPhone trust setup. */
  app.get('/api/certificate', (_req: Request, res: Response) => {
    const certPath = path.resolve(__dirname, '..', '..', 'cert.pem');
    if (!fs.existsSync(certPath)) {
      res.status(404).json({ error: 'Certificate is not available yet.' });
      return;
    }
    res.type('application/x-x509-ca-cert');
    res.download(certPath, 'GoonDrop-LAN-Certificate.pem');
  });

  /** Web Push: Public VAPID Key for client subscription */
  app.get('/api/push/public-key', (_req: Request, res: Response) => {
    const { publicKey } = require('./push');
    res.json({ publicKey });
  });

  /** Web Push: Register device subscription */
  app.post('/api/push/subscribe', (req: Request, res: Response) => {
    const { deviceId, subscription } = req.body;
    if (!deviceId || !subscription) {
      res.status(400).json({ error: 'deviceId and subscription are required' });
      return;
    }
    pushManager.registerSubscription(deviceId, subscription);
    res.json({ success: true });
  });

  /** Web Push: Handle action clicks from notifications */
  app.post('/api/push/action', (req: Request, res: Response) => {
    const { action, deviceId, fileId, payload } = req.body;
    if (!action || !deviceId) {
      res.status(400).json({ error: 'action and deviceId are required' });
      return;
    }

    console.log(`[PUSH ACTION] Device ${deviceId} performed: ${action}`);

    if (action === 'pair_accept') {
      pairingManager.handlePairActionConfirm(deviceId, payload.token, payload.deviceName);
    } else if (action === 'pair_decline') {
      pairingManager.handlePairReject(deviceId);
    } else if (action === 'clip_copy') {
      // The content is already in the server's history, we just need to tell the PC to copy it
      clipboardManager.handleClipboardPush({ 
        id: 'push-trigger', 
        name: 'Notification', 
        deviceType: 'system',
        paired: false,
        token: '',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ip: '127.0.0.1',
        ws: null as any
      }, { 
        text: payload.text, 
        hash: payload.hash, 
        type: 'text' 
      });
    } else if (action === 'file_accept') {
      fileTransfer.acceptFile(deviceId, fileId);
    } else if (action === 'file_decline') {
      fileTransfer.declineFile(deviceId, fileId);
    }

    res.json({ success: true });
  });

  /** Generate QR code for pairing URL */
  app.get('/api/qrcode', async (req: Request, res: Response) => {
    try {
      const useHttps = req.query.ssl === 'true';
      const pairingUrl = useHttps
        ? `https://${config.localIp}:${config.port + 1}?pair=${config.pairingCode}`
        : `http://${config.localIp}:${config.port}?pair=${config.pairingCode}`;

      const qrDataUrl = await QRCode.toDataURL(pairingUrl, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      res.json({ qrCode: qrDataUrl, pairingUrl, pairingCode: config.pairingCode, serverName: getMachineName() });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  /** Registry of every device this PC has paired with (online + remembered offline). */
  app.get('/api/devices', requireCode, (_req: Request, res: Response) => {
    res.json({
      serverName: getMachineName(),
      devices: pairingManager.listKnownDevices(),
      connectedDevices: getConnectedCount(),
    });
  });

  /** Revoke a paired device so it must pair again (e.g. lost/stolen phone). */
  app.post('/api/devices/:deviceId/revoke', requireCode, (req: Request, res: Response) => {
    const removed = pairingManager.revokeDevice(req.params.deviceId);
    res.json({ ok: removed, deviceId: req.params.deviceId });
  });

  /** Rename a remembered device from the PC side. */
  app.post('/api/devices/:deviceId/rename', requireCode, (req: Request, res: Response) => {
    const name = String(req.body?.name || '');
    if (!name.trim()) {
      res.status(400).json({ error: 'A device name is required' });
      return;
    }
    const ok = pairingManager.renameDevice(req.params.deviceId, name);
    res.json({ ok, deviceId: req.params.deviceId, name: name.trim().substring(0, 30) });
  });

  /** Serve uploaded files for download */
  app.get('/api/files/:fileId/:fileName', (req: Request, res: Response) => {    const { fileId, fileName } = req.params;
    const file = fileTransfer.getTransferFile(fileId);

    if (!file) {
      res.status(404).json({ error: 'File not found or expired' });
      return;
    }

    if (!fs.existsSync(file.path)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    let decodedName = fileName;
    try {
      decodedName = decodeURIComponent(fileName);
    } catch {
      // Fallback if filename has non-standard encoded characters (e.g. bare % symbols)
    }
    // Strip CR/LF to prevent HTTP header injection
    decodedName = decodedName.replace(/[\r\n]/g, '');
    const safeName = encodeURIComponent(decodedName).replace(/%0[ad]/gi, '');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(path.resolve(file.path));
  });

  // ─── Public LAN AirDrop & Apple Shortcuts Endpoints ───────────────────────

  /**
   * Universal High-Speed AirDrop Endpoint
   * Used by Apple Shortcuts ("AirDrop to PC"), PWA direct uploads, and local devices.
   * Auto-streams files directly into Downloads\GoonDrop and alerts Windows!
   */
  app.post('/api/drop', (req: Request, res: Response) => {
    const saveDir = path.join(os.homedir(), 'Downloads', 'GoonDrop');
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const contentType = req.header('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const bb = busboy({ headers: req.headers, limits: { fileSize: config.maxFileSize } });
      const uploadedFiles: Array<{ fileId: string; fileName: string; filePath: string; size: number }> = [];

      bb.on('file', (_name, file, info) => {
        const rawFileName = info.filename || `airdrop_${Date.now()}.bin`;
        const safeName = rawFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        let targetPath = path.join(saveDir, safeName);
        let counter = 1;
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        while (fs.existsSync(targetPath)) {
          targetPath = path.join(saveDir, `${base} (${counter})${ext}`);
          counter++;
        }

        const writeStream = fs.createWriteStream(targetPath);
        let bytes = 0;
        file.on('data', (data) => { bytes += data.length; });
        file.pipe(writeStream);

        writeStream.on('finish', () => {
          uploadedFiles.push({ fileId: genId(), fileName: path.basename(targetPath), filePath: targetPath, size: bytes });
        });
      });

      bb.on('close', () => {
        if (uploadedFiles.length === 0) {
          res.status(400).json({ error: 'No files received' });
          return;
        }

        for (const uf of uploadedFiles) {
          fileTransfer.registerLocalFile(uf.fileId, uf.filePath, uf.fileName, uf.size);
          console.log(`[NOTIFY] AirDropped from iPhone: ${uf.fileName}`);

          fileTransfer.getConnManager().broadcastToPaired({
            type: 'file_complete',
            payload: {
              fileId: uf.fileId,
              fileName: uf.fileName,
              fileSize: uf.size,
              mimeType: 'application/octet-stream',
              sourceDeviceId: 'shortcut-ios',
              sourceDeviceName: 'iPhone',
              downloadUrl: `/api/files/${uf.fileId}/${encodeURIComponent(uf.fileName)}`
            },
            id: genId(),
            timestamp: Date.now()
          });
        }

        res.json({
          success: true,
          count: uploadedFiles.length,
          files: uploadedFiles.map(f => ({ fileName: f.fileName, size: f.size, downloadUrl: `/api/files/${f.fileId}/${encodeURIComponent(f.fileName)}` })),
          message: `AirDrop complete: Saved to Downloads\\GoonDrop`
        });
      });

      req.pipe(bb);
      return;
    }

    if (contentType.includes('application/octet-stream') || req.header('x-filename')) {
      const rawFileName = req.header('x-filename') || (req.query.filename as string) || `airdrop_${Date.now()}.bin`;
      const safeName = rawFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      let targetPath = path.join(saveDir, safeName);
      let counter = 1;
      const ext = path.extname(safeName);
      const base = path.basename(safeName, ext);
      while (fs.existsSync(targetPath)) {
        targetPath = path.join(saveDir, `${base} (${counter})${ext}`);
        counter++;
      }

      const writeStream = fs.createWriteStream(targetPath);
      let bytes = 0;
      req.on('data', (chunk) => { bytes += chunk.length; });
      req.pipe(writeStream);

      writeStream.on('finish', () => {
        const fileId = genId();
        const finalName = path.basename(targetPath);
        fileTransfer.registerLocalFile(fileId, targetPath, finalName, bytes);
        console.log(`[NOTIFY] AirDropped from iPhone: ${finalName}`);

        fileTransfer.getConnManager().broadcastToPaired({
          type: 'file_complete',
          payload: {
            fileId,
            fileName: finalName,
            fileSize: bytes,
            mimeType: 'application/octet-stream',
            sourceDeviceId: 'shortcut-ios',
            sourceDeviceName: 'iPhone',
            downloadUrl: `/api/files/${fileId}/${encodeURIComponent(finalName)}`
          },
          id: genId(),
          timestamp: Date.now()
        });

        res.json({
          success: true,
          fileName: finalName,
          size: bytes,
          downloadUrl: `/api/files/${fileId}/${encodeURIComponent(finalName)}`,
          message: `AirDrop complete: Saved to Downloads\\GoonDrop\\${finalName}`
        });
      });
      return;
    }

    // JSON or Text drop fallback
    const text = (req.body && typeof req.body === 'object' ? req.body.text : req.body) || '';
    if (text && typeof text === 'string') {
      clipboardManager.handleClipboardPush({
        id: 'shortcut-ios',
        name: 'iPhone',
        deviceType: 'iphone',
        paired: true,
        token: '',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ip: req.socket.remoteAddress || '',
        ws: null as any
      }, { text, type: 'text' });
      res.json({ success: true, message: 'Copied to Windows clipboard' });
      return;
    }

    res.status(400).json({ error: 'Unsupported Content-Type for drop' });
  });

  /** Dedicated Apple Shortcut endpoint: Fetch latest Windows clipboard */
  app.get(['/api/clipboard', '/api/clipboard/latest'], (req: Request, res: Response) => {
    const history = clipboardManager.getHistory();
    const latest = history[0];
    const text = latest ? latest.text : '';

    if (req.header('accept')?.includes('text/plain') || req.query.format === 'text') {
      res.type('text/plain').send(text);
      return;
    }

    res.json({
      text,
      timestamp: latest ? latest.timestamp : Date.now(),
      sourceDeviceName: latest ? latest.sourceDeviceName : 'None'
    });
  });

  /** Dedicated Apple Shortcut endpoint: Send text from iPhone to Windows clipboard */
  app.post('/api/clipboard', (req: Request, res: Response) => {
    let text = '';
    if (typeof req.body === 'string') {
      text = req.body;
    } else if (req.body && req.body.text) {
      text = req.body.text;
    }

    if (text) {
      clipboardManager.handleClipboardPush({
        id: 'shortcut-ios',
        name: 'iPhone',
        deviceType: 'iphone',
        paired: true,
        token: '',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ip: req.socket.remoteAddress || '',
        ws: null as any
      }, { text, type: 'text' });
      console.log(`[NOTIFY] Clipboard from iPhone: ${text.length > 40 ? text.substring(0, 38) + '...' : text}`);
      res.json({ success: true, text });
      return;
    }
    res.status(400).json({ error: 'No text provided' });
  });

  /**
   * Universal Clipboard sync — ONE request, no client-side branching, no
   * dependency on other shortcuts. The phone POSTs its clipboard text and the
   * server replies (text/plain) with the text the iPhone should end up with:
   *
   *   - The PC clipboard is NEWER (set after the phone's last sync) → reply the
   *     PC text; the shortcut copies it onto the iPhone. The PC is left alone.
   *   - The iPhone text is newer/equal → store it on the PC (writes the real
   *     Windows clipboard) and echo it back → the iPhone set is a harmless no-op.
   *
   * Because the response is plain text, the shortcut is just:
   *   Get Clipboard → URL → POST → Set Clipboard → Notify. Import-safe.
   */
  app.post('/api/clipboard/sync', requireCode, (req: Request, res: Response) => {
    let text = '';
    if (typeof req.body === 'string') {
      text = req.body;
    } else if (req.body && req.body.text) {
      text = req.body.text;
    }
    text = (text || '').trim();

    const pcEntry = clipboardManager.getHistory()[0] || null;
    const pcText = pcEntry && typeof pcEntry.text === 'string' ? pcEntry.text : '';
    const pcNewerThanLastSync = !!pcEntry && (pcEntry.timestamp || 0) > phoneClipboardSyncAt;

    if (text === pcText) {
      phoneClipboardSyncAt = Date.now();
      res.type('text/plain').send(text);
      return;
    }

    if (pcNewerThanLastSync && pcText) {
      // PC clipboard was changed after the phone's last sync → PC wins.
      phoneClipboardSyncAt = Date.now();
      console.log(`[NOTIFY] Sync → PC wins: ${pcText.length > 40 ? pcText.substring(0, 38) + '...' : pcText}`);
      res.type('text/plain').send(pcText);
      return;
    }

    // iPhone text is newest → push it to the PC (writes the real Windows clipboard).
    if (text) {
      clipboardManager.handleClipboardPush({
        id: 'shortcut-ios',
        name: 'iPhone',
        deviceType: 'iphone',
        paired: true,
        token: '',
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ip: req.socket.remoteAddress || '',
        ws: null as any
      }, { text, type: 'text' });
      console.log(`[NOTIFY] Sync → iPhone wins: ${text.length > 40 ? text.substring(0, 38) + '...' : text}`);
    }
    phoneClipboardSyncAt = Date.now();
    res.type('text/plain').send(text);
  });

  app.post('/api/handoff', (req: Request, res: Response) => {
    let url = '';
    if (typeof req.body === 'string') {
      url = req.body.trim();
    } else if (req.body && req.body.url) {
      url = req.body.url.trim();
    }

    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      openInBrowser(url);
      console.log(`[NOTIFY] Handoff from iPhone: ${url}`);
      res.json({ success: true, url });
      return;
    }
    res.status(400).json({ error: 'Invalid URL for handoff' });
  });

  // ─── Go Wild: Remote Control & Sensor Shortcut Endpoints ────────────────

  /** Search the web — opens results in the Windows default browser. */
  app.post('/api/search', requireCode, (req: Request, res: Response) => {
    let q = '';
    if (typeof req.body === 'string') q = req.body.trim();
    else if (req.body && req.body.q) q = String(req.body.q).trim();
    if (!q) { res.status(400).json({ error: 'No search query provided' }); return; }
    openInBrowser(`https://www.bing.com/search?q=${encodeURIComponent(q)}`);
    res.json({ success: true, query: q });
  });

  /** Quick notes — appended to Desktop\GoonDrop_Backup\notes.txt + broadcast. */
  const noteBackupDir = path.join(os.homedir(), 'Desktop', 'GoonDrop_Backup');
  let recentNotes: Array<{ text: string; timestamp: number; sourceDeviceName: string }> = [];

  app.post('/api/note', (req: Request, res: Response) => {
    let text = '';
    if (typeof req.body === 'string') text = req.body.trim();
    else if (req.body && req.body.text) text = String(req.body.text).trim();
    if (!text) { res.status(400).json({ error: 'No note text provided' }); return; }

    try {
      if (!fs.existsSync(noteBackupDir)) fs.mkdirSync(noteBackupDir, { recursive: true });
      const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      fs.appendFileSync(path.join(noteBackupDir, 'notes.txt'), `[${stamp}] 📱 iOS: ${text}\n`, 'utf8');
    } catch { }

    recentNotes.unshift({ text, timestamp: Date.now(), sourceDeviceName: 'iPhone' });
    recentNotes = recentNotes.slice(0, 100);

    fileTransfer.getConnManager().broadcastToPaired({
      type: 'text_note',
      payload: { text, timestamp: Date.now(), sourceDeviceId: 'shortcut-ios', sourceDeviceName: 'iPhone' },
      id: genId(),
      timestamp: Date.now(),
    });

    console.log(`[NOTIFY] Quick note from iPhone: ${text.substring(0, 50)}`);
    res.json({ success: true, note: text });
  });

  app.get('/api/notes', (_req: Request, res: Response) => {
    res.json({ notes: recentNotes });
  });

  app.get('/api/notes/latest', (req: Request, res: Response) => {
    const latest = recentNotes[0];
    const text = latest ? latest.text : '';
    if (req.header('accept')?.includes('text/plain') || req.query.format === 'text') {
      res.type('text/plain').send(text);
      return;
    }
    res.json(latest || { text: '', timestamp: null, sourceDeviceName: 'None' });
  });

  /** Type text on the Windows keyboard — dictate from iPhone! */
  const escapeSendKeys = (text: string) => {
    const special = new Set(['+', '^', '%', '~', '(', ')', '{', '}', '[', ']']);
    return Array.from(text).map(c => special.has(c) ? `{${c}}` : c).join('');
  };

  app.post('/api/type', requireCode, (req: Request, res: Response) => {
    let text = '';
    if (typeof req.body === 'string') text = req.body;
    else if (req.body && req.body.text) text = String(req.body.text);
    if (!text) { res.status(400).json({ error: 'No text to type' }); return; }

    sendLocalControl({ type: 'keyboard', command: text });
    // Fallback: type directly via PowerShell if the launcher isn't listening.
    ps(`(New-Object -ComObject WScript.Shell).SendKeys('${escapeSendKeys(text).replace(/'/g, "''")}')`)
      .catch(() => {});
    console.log(`[NOTIFY] Typing on PC from iPhone: ${text.substring(0, 50)}`);
    res.json({ success: true, text });
  });

  /** Text-to-speech — your PC talks out loud. */
  app.post('/api/speak', requireCode, (req: Request, res: Response) => {
    let text = '';
    if (typeof req.body === 'string') text = req.body.trim();
    else if (req.body && req.body.text) text = String(req.body.text).trim();
    if (!text) { res.status(400).json({ error: 'No text to speak' }); return; }

    const escaped = text.replace(/'/g, "''");
    ps(`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${escaped}')`)
      .then(() => res.json({ success: true }))
      .catch(() => res.status(500).json({ success: false }));
  });

  /** Open a known app on Windows by name. */
  const APP_LAUNCH: Record<string, string> = {
    spotify: 'start spotify:',
    youtube: 'start https://www.youtube.com',
    netflix: 'start https://www.netflix.com',
    chrome: 'start chrome',
    edge: 'start msedge',
    firefox: 'start firefox',
    notepad: 'notepad',
    calculator: 'calc',
    calc: 'calc',
    cmd: 'cmd',
    'command prompt': 'cmd',
    terminal: 'wt',
    explorer: 'explorer',
    'file explorer': 'explorer',
    taskmgr: 'taskmgr',
    'task manager': 'taskmgr',
    paint: 'mspaint',
    word: 'winword',
    excel: 'excel',
    powerpoint: 'powerpnt',
    outlook: 'outlook',
    mail: 'start outlookmail:',
    settings: 'start ms-settings:',
    maps: 'start bingmaps:',
  };

  app.post('/api/open-app', requireCode, (req: Request, res: Response) => {
    let name = '';
    if (typeof req.body === 'string') name = req.body.trim().toLowerCase();
    else if (req.body && req.body.app) name = String(req.body.app).trim().toLowerCase();
    if (!name) { res.status(400).json({ error: 'No app name provided' }); return; }

    const launch = APP_LAUNCH[name] || (name.includes('.exe') ? `start "" "${name}"` : '');
    if (!launch) {
      res.status(404).json({ error: `Unknown app "${name}". Try: ${Object.keys(APP_LAUNCH).slice(0, 8).join(', ')}` });
      return;
    }
    openInBrowser(launch);
    console.log(`[NOTIFY] Opening app on PC from iPhone: ${name}`);
    res.json({ success: true, app: name, launch });
  });

  /** Power control: lock / sleep / restart / shutdown. */
  const SYSTEM_ACTIONS: Record<string, string> = {
    lock: 'rundll32.exe user32.dll,LockWorkStation',
    sleep: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
    restart: 'shutdown /r /t 5 /c "Goon Drop: restart requested from your iPhone"',
    shutdown: 'shutdown /s /t 5 /c "Goon Drop: shutdown requested from your iPhone"',
  };

  app.all(['/api/system/lock', '/api/system/sleep', '/api/system/restart', '/api/system/shutdown'], requireCode, (req: Request, res: Response) => {
    const action = req.path.split('/').pop() as string;
    const command = SYSTEM_ACTIONS[action];
    if (!command) { res.status(400).json({ error: 'Unknown system action' }); return; }

    // Respond FIRST so the shortcut gets a success, then fire the command.
    res.json({ success: true, action });
    setImmediate(() => { exec(command, () => {}); });
  });

  /** iPhone battery % — great for low-battery Automations. */
  let latestBattery: { level: number | null; charging?: boolean; timestamp: number } = { level: null, timestamp: 0 };

  app.post('/api/battery', (req: Request, res: Response) => {
    let level: number | null = null;
    if (typeof req.body === 'number') level = req.body;
    else if (typeof req.body === 'string') level = parseFloat(req.body.trim());
    else if (req.query.level) level = parseFloat(String(req.query.level));
    else if (req.body && req.body.level !== undefined) level = Number(req.body.level);

    if (level === null || isNaN(level)) { res.status(400).json({ error: 'No battery level provided' }); return; }

    latestBattery = { level: Math.max(0, Math.min(100, level)), charging: req.body?.charging, timestamp: Date.now() };
    fileTransfer.getConnManager().broadcastToPaired({
      type: 'battery_info',
      payload: { level: latestBattery.level, deviceName: 'iPhone', deviceId: 'shortcut-ios', timestamp: latestBattery.timestamp },
      id: genId(),
      timestamp: Date.now(),
    });

    if (level <= 20) {
      pushManager.broadcastNotification('🔋 Low Battery!', `Your iPhone is at ${Math.round(level)}% — plug it in!`).catch(() => {});
    }

    console.log(`[NOTIFY] iPhone battery ${level}% reported`);
    res.json({ success: true, level: latestBattery.level });
  });

  app.get('/api/battery/latest', (_req: Request, res: Response) => {
    res.json(latestBattery);
  });

  /** iPhone GPS location. */
  let latestLocation: { lat: number; lng: number; accuracy?: number; timestamp: number } | null = null;

  app.post('/api/location', (req: Request, res: Response) => {
    let lat: number | null = null;
    let lng: number | null = null;
    let accuracy: number | undefined;

    if (typeof req.body === 'string') {
      const parts = req.body.split(',').map(s => parseFloat(s.trim()));
      if (parts.length >= 2) { lat = parts[0]; lng = parts[1]; }
    } else if (req.query.lat && req.query.lng) {
      lat = parseFloat(String(req.query.lat));
      lng = parseFloat(String(req.query.lng));
    } else if (req.body) {
      lat = req.body.lat !== undefined ? Number(req.body.lat) : null;
      lng = req.body.lng !== undefined ? Number(req.body.lng) : null;
      accuracy = req.body.accuracy !== undefined ? Number(req.body.accuracy) : undefined;
    }

    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ error: 'No location provided (lat,lng)' });
      return;
    }

    latestLocation = { lat, lng, accuracy, timestamp: Date.now() };
    fileTransfer.getConnManager().broadcastToPaired({
      type: 'location_update',
      payload: { ...latestLocation, deviceName: 'iPhone', deviceId: 'shortcut-ios' },
      id: genId(),
      timestamp: Date.now(),
    });

    console.log(`[NOTIFY] iPhone location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    res.json({ success: true, ...latestLocation });
  });

  app.get('/api/location/latest', (_req: Request, res: Response) => {
    res.json(latestLocation || { error: 'No location reported yet' });
  });

  /** Find My Phone — pings every paired device (rings/vibrates the app + push). */
  app.all('/api/ping-phone', requireCode, (_req: Request, res: Response) => {
    fileTransfer.getConnManager().broadcastToPaired({
      type: 'ping_phone',
      id: genId(),
      timestamp: Date.now(),
    });
    pushManager.broadcastNotification('📱 Find My Phone!', 'Your iPhone should be ringing right now!').catch(() => {});
    res.json({ success: true, message: 'Ping sent to all Goon Drop devices' });
  });

  /** Find My PC — makes the Windows PC beep loudly + shows a balloon + speaks. */
  app.all('/api/ping-pc', requireCode, (_req: Request, res: Response) => {
    sendLocalControl({ type: 'ping_pc' });
    res.json({ success: true, message: 'Your PC is making noise right now!' });
  });

  /** Shortcuts metadata & installation guide endpoint (catalog-driven) */
  app.get('/api/shortcuts/suite', (_req: Request, res: Response) => {
    const baseUrl = `http://${config.localIp}:${config.port}`;
    const defs = getShortcutDefinitions(config);
    res.json({
      baseUrl,
      pairingCode: config.pairingCode,
      categories: SHORTCUT_CATEGORIES,
      shortcuts: defs.map(d => ({
        id: d.id,
        name: d.name,
        description: d.description,
        category: d.category,
        method: d.method,
        url: d.displayUrl,
        input: d.input,
        needsCode: d.needsCode,
        downloadUrl: `/api/shortcuts/${d.id}.download`,
      })),
    });
  });

  // ─── Downloadable Apple Shortcut Files (catalog-driven) ──────────────────

  app.get('/api/shortcuts/:name.download', (req: Request, res: Response) => {
    const defs = getShortcutDefinitions(config);
    const shortcut = defs.find(d => d.id === req.params.name || d.name.replace(/\s+/g, '-').toLowerCase() === req.params.name);
    if (!shortcut) {
      res.status(404).json({ error: 'Shortcut not found' });
      return;
    }

    const plist = buildShortcutPlist(shortcut);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${shortcut.name.replace(/\s+/g, '-')}.shortcut"`);
    res.send(plist);
  });

  /** Download all shortcuts as a bundle / list */
  app.get('/api/shortcuts/download-all', (_req: Request, res: Response) => {
    const defs = getShortcutDefinitions(config);
    res.json({
      message: 'Download individual shortcuts from /api/shortcuts/:id.download',
      shortcuts: defs.map(d => ({
        id: d.id,
        name: d.name,
        category: d.category,
        downloadUrl: `/api/shortcuts/${d.id}.download`,
        description: d.description,
      })),
    });
  });

  // ─── iPhone Setup Page ─────────────────────────────────────────────────────
  const iosSetupHtml = (baseUrl: string, pairingCode: string, defs: any[]) => {
    const categoryOrder = Object.keys(SHORTCUT_CATEGORIES);
    const groups = categoryOrder.map(cat => ({
      cat,
      label: SHORTCUT_CATEGORIES[cat],
      items: defs.filter(d => d.category === cat),
    })).filter(g => g.items.length > 0);

    const shortcutCards = groups.map(group => `
    <div class="card">
      <h2>${group.label}</h2>
      ${group.items.map(s => `
      <div class="shortcut-item">
        <h3>${s.name}</h3>
        <div class="desc">${s.description}</div>
        <a class="btn btn-primary" href="/api/shortcuts/${s.id}.download">Install ${s.name}</a>
      </div>`).join('\n')}
    </div>`).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Goon Drop - iPhone Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; padding: 20px; padding-top: env(safe-area-inset-top); padding-bottom: 60px; }
    .header { text-align: center; padding: 30px 0 20px; }
    .header h1 { font-size: 28px; color: #00e5a0; margin-bottom: 8px; }
    .header p { font-size: 14px; color: #888; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 16px; padding: 20px; margin-bottom: 16px; }
    .card h2 { font-size: 18px; color: #00e5a0; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .card p { font-size: 13px; color: #aaa; line-height: 1.5; margin-bottom: 12px; }
    .shortcut-item { background: #111; border: 1px solid #2a2a2a; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
    .shortcut-item h3 { font-size: 16px; color: #fff; margin-bottom: 6px; }
    .shortcut-item .desc { font-size: 12px; color: #888; margin-bottom: 12px; }
    .btn { display: block; width: 100%; padding: 14px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; text-decoration: none; text-align: center; margin-bottom: 8px; }
    .btn-primary { background: #00e5a0; color: #000; }
    .btn-secondary { background: #333; color: #fff; }
    .btn-small { display: inline-block; width: auto; padding: 8px 16px; font-size: 12px; margin-right: 6px; }
    .step { display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start; }
    .step-num { background: #00e5a0; color: #000; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 13px; flex-shrink: 0; }
    .step-text { font-size: 13px; color: #ccc; line-height: 1.5; padding-top: 3px; }
    .step-text code { background: #222; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #00e5a0; }
    .url-box { background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #00e5a0; word-break: break-all; margin: 8px 0; cursor: pointer; position: relative; }
    .url-box:active { background: #1a1a1a; }
    .copied-toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); background: #00e5a0; color: #000; padding: 10px 20px; border-radius: 20px; font-weight: 600; font-size: 14px; z-index: 999; display: none; }
    .pairing-code { font-size: 32px; font-weight: bold; color: #00e5a0; text-align: center; letter-spacing: 0.15em; padding: 16px; background: #111; border-radius: 12px; margin: 12px 0; }
    .tip { background: rgba(0, 229, 160, 0.1); border: 1px solid rgba(0, 229, 160, 0.3); border-radius: 10px; padding: 14px; margin: 12px 0; }
    .tip strong { color: #00e5a0; }
    .tip p { color: #aaa; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Goon Drop</h1>
    <p>iPhone Setup Guide — ${defs.length} shortcuts</p>
  </div>

  <div class="card">
    <h2>Server Info</h2>
    <div class="url-box" onclick="copyText('${baseUrl}')">${baseUrl}</div>
    <p style="font-size:12px;color:#666;text-align:center;">Tap to copy server URL</p>
    <div class="pairing-code">${pairingCode}</div>
    <p style="font-size:12px;color:#666;text-align:center;">Your pairing code</p>
  </div>

  <div class="card">
    <h2>Quick Start</h2>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">Open <strong>Safari</strong> on your iPhone and go to:<br><code>${baseUrl}</code></div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">Enter the pairing code once: <code>${pairingCode}</code></div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Tap the <strong>Share</strong> button → <strong>"Add to Home Screen"</strong> → <strong>Add</strong>. Home Screen apps keep their connection and support <strong>Push Notifications</strong> — saved link works too.</div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div class="step-text">Install the shortcuts below. <strong>Shortcuts run in the background — you never need to keep the Goon Drop app open!</strong></div>
    </div>
  </div>

  <div class="card">
    <h2>✨ Universal Clipboard (the magic one)</h2>
    <p>Copy on <strong>either</strong> device, paste on <strong>both</strong> — automatically, forever, with zero taps. ONE self-contained shortcut does the whole handshake: push your clipboard to the PC, and if the PC has something newer it pulls that back instead. No other shortcut needed.</p>
    <a class="btn btn-primary" href="/api/shortcuts/clipboard-sync.download">Install Universal Clipboard</a>
    <div class="step" style="margin-top:14px;">
      <div class="step-num">1</div>
      <div class="step-text">Install <strong>Universal Clipboard</strong> (button above).</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">Shortcuts app → <strong>Automation</strong> tab → <strong>+</strong> → <strong>Time of Day</strong> → pick a time (or several: 7:00, 7:30…) → <strong>Next</strong>.</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Search and pick <strong>Run Shortcut</strong> → choose <strong>Universal Clipboard</strong> → <strong>Done</strong>. Enable <strong>"Run Immediately"</strong> if prompted.</div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div class="step-text">Done. Your clipboards converge automatically. For <strong>INSTANT</strong> sync without waiting for the timer, set <strong>Back Tap</strong> (Settings → Accessibility → Touch → Back Tap): Double Tap = <strong>Send Clipboard to PC</strong>, Triple Tap = <strong>Paste from PC</strong>.</div>
    </div>
    <div class="tip">
      <strong>⚡ No timer needed when the app is open</strong>
      <p>The Goon Drop app is already connected live: copy on your PC and a push notification pops on your iPhone instantly (tap it → text is on your iPhone clipboard). Copy on iPhone → Back Tap "Send Clipboard to PC" → text is on your Windows clipboard in ~0.5s.</p>
    </div>
  </div>

  ${shortcutCards}

  <div class="card">
    <h2>🤖 Automation Recipes (set-and-forget)</h2>
    <div class="tip">
      <strong>⏰ Universal Clipboard — full auto</strong>
      <p>Shortcuts → Automation → Time of Day (pick one or several times a day, e.g. 7:00 / 12:00 / 18:00) → Run Shortcut "Universal Clipboard" → enable Run Immediately. Add as many times as you like — each one nudges both clipboards to match. For truly instant sync, rely on Back Tap or the live app.</p>
    </div>
    <div class="tip">
      <strong>Back Tap — instant clipboard</strong>
      <p>Settings → Accessibility → Touch → Back Tap. "Double Tap" = Send Clipboard to PC, "Triple Tap" = Paste from PC. Sync clipboards from the lock screen with zero app opens.</p>
    </div>
    <div class="tip">
      <strong>Low battery → warn your PC</strong>
      <p>Shortcuts app → Automation → "+" → "Battery Level" (falls below 20%) → Run "Send Battery to PC". Your PC notifies you to plug in.</p>
    </div>
    <div class="tip">
      <strong>🖼️ Screenshots auto-beamed to PC</strong>
      <p>Automation → "New Screenshot" → Run Shortcut "AirDrop to PC". Every iPhone screenshot instantly lands in Downloads\GoonDrop on Windows. (Works for photos via the Photo to PC shortcut too.)</p>
    </div>
    <div class="tip">
      <strong>🔍 Find My PC — the reverse Find My</strong>
      <p>"Hey Siri, find my PC" or tap the Find My PC shortcut: your Windows PC beeps loudly so you can find your lost laptop anywhere in the house.</p>
    </div>
    <div class="tip">
      <strong>Siri — hands free</strong>
      <p>"Hey Siri, type that on my PC" → answers with whatever is on your clipboard. "Hey Siri, lock my PC", "Hey Siri, find my phone", "Hey Siri, open Spotify on my PC".</p>
    </div>
    <div class="tip">
      <strong>Charging → open Spotify on PC</strong>
      <p>Automation: "When Charger is Connected" → Run "Open App on PC" with text "spotify". Walk in, plug in, music starts.</p>
    </div>
    <div class="tip">
      <strong>Push notifications (PC → iPhone)</strong>
      <p>Files, clipboards, pings and pairings can notify you even when the app is closed. Tap "Enable Notifications" in the Goon Drop app's Dashboard and allow notifications in iOS.</p>
    </div>
  </div>

  <div class="tip">
    <strong>No Developer Account Needed</strong>
    <p>Everything here is built into iOS. Shortcuts talk to your PC over your local Wi-Fi. No cloud, no accounts, no subscriptions.</p>
  </div>

  <div id="toast" class="copied-toast">Copied!</div>

  <script>
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { showToast(); }).catch(() => {});
      }
    }
    function showToast() {
      const toast = document.getElementById('toast');
      toast.style.display = 'block';
      setTimeout(() => toast.style.display = 'none', 1500);
    }
  </script>
</body>
</html>`;
  };

  app.get('/ios-setup', (_req: Request, res: Response) => {
    const baseUrl = `http://${config.localIp}:${config.port}`;
    const defs = getShortcutDefinitions(config);
    res.type('html').send(iosSetupHtml(baseUrl, config.pairingCode, defs));
  });

  // ─── Internal APIs for Native Windows Integration ──────────────────────────

  // Middleware to authorize internal control APIs
  const authorizeInternalApi = (req: Request, res: Response, next: express.NextFunction) => {
    const ip = req.socket.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || 
                    ip === '::1' || 
                    ip === '::ffff:127.0.0.1' ||
                    ip.includes('127.0.0.1') ||
                    ip.includes('::1') ||
                    ip.includes('localhost');

    const sharedSecret = req.header('X-GoonDrop-Secret');

    // Even localhost must provide the shared secret to use internal APIs
    if (sharedSecret && sharedSecret === config.pairingCode) {
      next();
      return;
    }

    if (isLocal) {
      // Allow localhost without secret only for legacy compat (will be required in future)
      next();
      return;
    }

    const clientId = req.header('X-Client-Id');
    const clientToken = req.header('X-Client-Token');

    if (!clientId || !clientToken) {
      res.status(401).json({ error: 'Unauthorized: Missing credentials' });
      return;
    }

    const client = fileTransfer.getConnManager().getClient(clientId);
    if (client && client.token === clientToken && client.paired) {
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized: Invalid client token or not paired' });
    }
  };

  app.use('/api/internal', authorizeInternalApi);

  app.post('/api/internal/clipboard', (req: Request, res: Response) => {
    const { text } = req.body;
    if (text) {
      const snippet = (typeof text === 'string' && text.length > 80) ? text.substring(0, 78) + '…' : text;
      fileTransfer.getConnManager().broadcastToPaired({
        type: 'clipboard_push',
        payload: { text, hash: hashText(text), type: 'text', sourceDeviceName: 'Windows PC' },
        id: genId(),
        timestamp: Date.now()
      });
      // 🔔 Forward to the iPhone even when the PWA is closed (Web Push with a
      // Copy action — taps open the app with the text ready to grab).
      pushManager.broadcastNotification(
        '📋 Clipboard from PC',
        `"${snippet}" — tap to copy`,
        [
          { label: 'Copy to iPhone', value: 'clip_copy' },
          { label: 'Ignore', value: 'clip_ignore' }
        ]
      ).catch(() => {});
    }
    res.sendStatus(200);
  });

  app.post('/api/internal/send-file', (req: Request, res: Response) => {
    const { filePath } = req.body;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > config.maxFileSize) {
        res.status(413).json({ error: 'File exceeds maximum size' });
        return;
      }
      const fileName = path.basename(filePath);
      const fileId = genId();
      
      fileTransfer.registerLocalFile(fileId, filePath, fileName, stats.size);
    }
    res.sendStatus(200);
  });

  /** Natively save uncompressed photo backups directly into Windows Desktop/GoonDrop_Backup/ */
  app.post('/api/internal/backup-photos', (req: Request, res: Response) => {
    try {
      const { fileName, data } = req.body;
      if (fileName && data) {
        const desktopDir = path.join(os.homedir(), 'Desktop', 'GoonDrop_Backup');
        if (!fs.existsSync(desktopDir)) {
          fs.mkdirSync(desktopDir, { recursive: true });
        }
        const filePath = path.join(desktopDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
        
        // Broadcast local file addition to the vault list
        const fileId = genId();
        fileTransfer.registerLocalFile(fileId, filePath, fileName, data.length);
      }
      res.sendStatus(200);
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  app.get('/api/internal/clipboard-history', (_req: Request, res: Response) => {
    res.json(clipboardManager.getHistory().slice(0, 5).map(h => ({
      text: h.text,
      timestamp: h.timestamp,
      sourceDeviceName: h.sourceDeviceName
    })));
  });

  /** Batch Zip Archive Downloader (New!) */
  app.get('/api/internal/zip-files', async (req: Request, res: Response) => {
    try {
      const ids = (req.query.ids as string || '').split(',').filter(id => id.trim() !== '');
      const files = ids.map(id => fileTransfer.getTransferFile(id)).filter(f => f !== null);

      if (files.length === 0) {
        res.status(404).send('No valid files found to zip.');
        return;
      }

      const tempZip = path.join(os.tmpdir(), `GoonDrop_Batch_${Date.now()}.zip`);
      
      // Use individual Compress-Archive calls piped together (safer than string-building paths)
      const { exec } = require('child_process');
      const commands = files.map(f => 
        `powershell.exe -NoProfile -WindowStyle Hidden -command "Compress-Archive -LiteralPath '${f!.path.replace(/'/g, "''")}' -DestinationPath '${tempZip.replace(/'/g, "''")}' -Update"`
      );

      // Run sequentially
      for (const cmd of commands) {
        await new Promise<void>((resolve, reject) => {
          exec(cmd, (err: any) => err ? reject(err) : resolve());
        });
      }

      res.download(tempZip, 'GoonDrop_Batch_Archive.zip', () => {
        try { fs.unlinkSync(tempZip); } catch { }
      });
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

  /** Trigger phone pinging (New!) */
  app.post('/api/internal/ping-phones', (req: Request, res: Response) => {
    // 1. Instant WebSocket broadcast for active sessions
    fileTransfer.getConnManager().broadcastToPaired({
      type: 'ping_phone',
      id: genId(),
      timestamp: Date.now()
    });

    // 2. Push Notification for background/suspended devices (iOS fix!)
    pushManager.broadcastNotification(
      'Goon Drop Ping!',
      'Your laptop is pinging your phone! Check the app for details.'
    ).catch((err: any) => console.error('[PING] Push failed:', err));

    res.sendStatus(200);
  });

  // Active Handoff State Storage (auto-expires after 5 minutes)
  let activeHandoffState: { url: string; title: string; timestamp: number } | null = null;

  setInterval(() => {
    if (activeHandoffState && Date.now() - activeHandoffState.timestamp > 300000) {
      activeHandoffState = null;
    }
  }, 60000);

  app.post('/api/internal/handoff', (req: Request, res: Response) => {
    const { url, title } = req.body;
    if (url) {
      activeHandoffState = { url, title: title || url, timestamp: Date.now() };
      
      // Broadcast handoff sync to all devices
      fileTransfer.getConnManager().broadcastToPaired({
        type: 'handoff_sync',
        payload: activeHandoffState,
        id: genId(),
        timestamp: Date.now()
      });
    }
    res.sendStatus(200);
  });

  app.get('/api/internal/handoff', (_req: Request, res: Response) => {
    res.json(activeHandoffState);
  });

  // ─── Remote File Explorer, Diagnostic Telemetry & Task Killer APIs ────────

  // Allowed root directories for file browser jail
  const allowedBrowseRoots = [os.homedir(), 'D:\\', 'E:\\'];

  const isPathAllowed = (target: string): boolean => {
    const resolved = path.resolve(target);
    return allowedBrowseRoots.some(root => {
      const relative = path.relative(path.resolve(root), resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  };

  // Helper to query the C# launcher's loopback-only control listener on port 3945.
  const queryLocalControl = (pathStr: string, method: 'GET' | 'POST', body: any = null): Promise<any> => {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request({
        // ⚠️ CRITICAL NETWORKING FIX: Query 127.0.0.1 explicitly to bypass slow/buggy Windows DNS localhost queries!
        hostname: '127.0.0.1',
        port: 3945,
        path: pathStr,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res: any) => {
        let raw = '';
        res.on('data', (chunk: any) => raw += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve({ success: true });
          }
        });
      });
      req.on('error', (err: any) => reject(err));
      if (body) req.write(payload);
      req.end();
    });
  };

  /** Browse Windows local filesystem (Parallel, Asynchronous & Non-blocking!) */
  app.get('/api/internal/browse', async (req: Request, res: Response) => {
    try {
      const homeDir = os.homedir();
      let targetPath = (req.query.path as string) || homeDir;

      // Resolve and jail to allowed roots
      targetPath = path.resolve(targetPath);
      if (!isPathAllowed(targetPath)) {
        res.status(403).json({ error: 'Access denied: path is outside allowed directories' });
        return;
      }

      if (!fs.existsSync(targetPath)) {
        res.status(404).json({ error: 'Directory not found' });
        return;
      }

      if (!fs.statSync(targetPath).isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }

      // Read directory asynchronously without blocking Node event loop
      const files = await fs.promises.readdir(targetPath);
      
      // Limit to 150 items to prevent rendering bottleneck in browser & ultra-fast load times!
      const limitedFiles = files.slice(0, 150);

      const promises = limitedFiles.map(async (file) => {
        try {
          const fullPath = path.join(targetPath, file);
          const stats = await fs.promises.stat(fullPath);
          return {
            name: file,
            path: fullPath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            mtime: stats.mtimeMs
          };
        } catch {
          return null; // Skip locked/system files safely
        }
      });

      const results = await Promise.all(promises);
      const list = results.filter(f => f !== null);

      res.json({
        currentPath: targetPath,
        parentPath: targetPath === homeDir || !isPathAllowed(path.dirname(targetPath)) ? null : path.dirname(targetPath),
        files: list.sort((a: any, b: any) => (b.isDirectory ? 1 : 0) - (a.isDirectory ? 1 : 0) || a.name.localeCompare(b.name))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Retrieve PC Diagnostic telemetry */
  app.get('/api/internal/pc-stats', async (_req: Request, res: Response) => {
    try {
      const stats = await queryLocalControl('/control/stats', 'GET');
      res.json(stats);
    } catch {
      res.status(503).json({ error: 'Control listener offline' });
    }
  });

  /** Retrieve active application tasks */
  app.get('/api/internal/processes', async (_req: Request, res: Response) => {
    try {
      const procs = await queryLocalControl('/control/processes', 'GET');
      res.json(procs);
    } catch {
      res.status(503).json({ error: 'Control listener offline' });
    }
  });

  /** Native Task Killer */
  app.post('/api/internal/kill', async (req: Request, res: Response) => {
    try {
      const { id } = req.body;
      const result = await queryLocalControl('/control/kill', 'POST', { id });
      res.json(result);
    } catch {
      res.status(503).json({ error: 'Control listener offline' });
    }
  });

  // ─── Static Frontend ─────────────────────────────────────────────────────

  // In production, serve built frontend
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    // SPA fallback
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  return app;
}
