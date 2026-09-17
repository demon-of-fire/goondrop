/**
 * Goon Drop Server Entry Point
 * 
 * Starts the Express HTTP server and WebSocket server.
 * Initializes all handlers for clipboard sync, file transfer, and device pairing.
 * Designed for LAN operation with minimal resource usage.
 */
import http from 'http';
import https from 'https';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import dgram from 'dgram';
import { loadConfig } from './config';
import { ConnectionManager } from './websocket';
import { PairingManager } from './pairing';
import { ClipboardManager } from './clipboard';
import { FileTransferManager } from './filetransfer';
import { createServer } from './server';
import { generateId, getMachineName } from './utils';
import { getOrCreateCertificates } from './certs';
import { PushManager } from './pushManager';
import { createShortcutFiles } from './shortcuts';

function shutdown(): void {
  console.log('[NOTIFY] Shutting down server...');
  process.exit(0);
}

/**
 * ⚠️ CRITICAL iOS FIX: Auto-create Windows Firewall inbound rules for GoonDrop ports.
 * When Node.js is launched by the C# launcher with CreateNoWindow=true, Windows Firewall
 * never shows an interactive prompt — it silently blocks ALL inbound LAN connections.
 * This means iPhones on the same Wi-Fi literally cannot reach the server at all.
 * Safari shows "server has stopped responding" because the packets are being dropped.
 */
async function ensureFirewallRules(port: number): Promise<void> {
  if (process.platform !== 'win32') return;

  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  const rules = [
    { name: 'GoonDrop HTTP', port: port },
    { name: 'GoonDrop HTTPS', port: port + 1 },
    { name: 'GoonDrop UDP Discovery', port: 3943, protocol: 'UDP' },
  ];

  for (const rule of rules) {
    const protocol = rule.protocol || 'TCP';
    // Check if rule exists, create if not. Uses PowerShell for reliability.
    const cmd = `powershell -NoProfile -Command "if (-not (Get-NetFirewallRule -DisplayName '${rule.name}' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName '${rule.name}' -Direction Inbound -Protocol ${protocol} -LocalPort ${rule.port} -Action Allow -Profile Private,Domain,Public -Description 'GoonDrop LAN server access' | Out-Null; Write-Output 'CREATED' } else { Write-Output 'EXISTS' }"`;
    
    try {
      const { stdout } = await execAsync(cmd);
      const result = stdout.trim();
      if (result === 'CREATED') {
        console.log(`[FIREWALL] ✅ Created rule "${rule.name}" (port ${rule.port}/${protocol})`);
      } else {
        console.log(`[FIREWALL] ✓ Rule "${rule.name}" already exists`);
      }
    } catch (err: any) {
      // Most likely: not running as admin. Try netsh as fallback.
      const netshCmd = `netsh advfirewall firewall add rule name="${rule.name}" dir=in action=allow protocol=${protocol} localport=${rule.port} profile=private,domain,public`;
      try {
        await execAsync(netshCmd);
        console.log(`[FIREWALL] ✅ Created rule "${rule.name}" (port ${rule.port}/${protocol}) via netsh`);
      } catch (err2: any) {
        console.log(`[FIREWALL] ⚠️ Could not create rule "${rule.name}" on port ${rule.port}. iPhone may not be able to connect!`);
        console.log(`[FIREWALL] Run this app as Administrator once, OR manually allow Node.js through Windows Firewall.`);
      }
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Generate downloadable Apple Shortcut files for iOS
  try {
    createShortcutFiles(config);
    console.log('[SHORTCUTS] Generated Apple Shortcut files into shortcuts/ folder.');
  } catch (err: any) {
    console.log(`[SHORTCUTS] Warning: could not generate Apple Shortcut files: ${err.message}`);
  }

  // Initialize core managers
  const connManager = new ConnectionManager(config);
  const pushManager = new PushManager();
  const clipboardManager = new ClipboardManager(connManager, pushManager, config.maxClipboardHistory);
  const pairingManager = new PairingManager(connManager, pushManager, () => clipboardManager.getHistory().slice(0, 20));
  const fileTransferManager = new FileTransferManager(connManager, pushManager, config.tempDir, config.maxFileSize, config.chunkSize);
  
  // Register WebSocket message handlers
  pairingManager.registerHandlers();
  clipboardManager.registerHandlers();
  fileTransferManager.registerHandlers();

  // Link handoff broadcaster
  connManager.on('link_send', (client, payload: any) => {
    console.log(`[NOTIFY] Link received from ${client.name}: ${payload.url}`);
    
    const linkItem = {
      url: payload.url,
      title: payload.title || '',
      timestamp: Date.now(),
      sourceDeviceName: client.name
    };
    pairingManager.addLink(linkItem);

    connManager.broadcastToPaired({
      type: 'link_send',
      payload: linkItem,
      id: generateId(),
      timestamp: Date.now(),
    }, client.id);

    sendLocalControlCommand({ type: 'open_url', url: payload.url });
  });

  // Text note broadcaster
  connManager.on('text_note', (client, payload: any) => {
    console.log(`[NOTIFY] Note received from ${client.name}`);
    connManager.broadcastToPaired({
      type: 'text_note',
      payload: {
        text: payload.text,
        timestamp: Date.now(),
        sourceDeviceId: client.id,
        sourceDeviceName: client.name,
      },
      id: generateId(),
      timestamp: Date.now(),
    }, client.id);
  });

  // Battery status alert listener
  connManager.on('battery_alert', (client, payload: any) => {
    console.log(`[NOTIFY] Your ${client.name} battery is low (${payload.level}%)! Please plug it in.`);
    connManager.broadcastToPaired({
      type: 'battery_info',
      payload: {
        level: payload.level,
        deviceName: client.name,
        deviceId: client.id,
        timestamp: Date.now(),
      },
      id: generateId(),
      timestamp: Date.now(),
    });
  });

  // Native Windows remote mouse / volume control forwarding!
  const sendLocalControlCommand = (payload: any) => {
    try {
      const data = JSON.stringify(payload);
      const req = http.request({
        hostname: 'localhost',
        port: 3945,
        path: '/control/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      });
      req.on('error', (err) => {
        console.log(`[NOTIFY] Local control command failed: ${err.message}. Companion app may not be running.`);
      });
      req.write(data);
      req.end();
    } catch { }
  };

  // Native Windows remote mouse tracking over high-speed UDP!
  const udpClientSocket = dgram.createSocket('udp4');
  const sendLocalUdpCommand = (payload: any) => {
    try {
      const data = Buffer.from(JSON.stringify(payload));
      udpClientSocket.send(data, 0, data.length, 3944, '127.0.0.1');
    } catch { }
  };

  connManager.on('mouse_move', (client, payload: any) => {
    sendLocalUdpCommand({ type: 'mouse_move', dx: payload.dx, dy: payload.dy });
  });

  connManager.on('mouse_click', (client, payload: any) => {
    sendLocalUdpCommand({ type: 'mouse_click', clickType: payload.clickType });
  });

  connManager.on('media_command', (client, payload: any) => {
    sendLocalControlCommand({ type: 'media', command: payload.command });
  });

  // Native Windows remote keyboard tying forwarding!
  connManager.on('keyboard_type', (client, payload: any) => {
    sendLocalControlCommand({ type: 'keyboard', command: payload.text });
  });

   // Native Windows lock PC command forwarding!
   connManager.on('lock_pc', (client) => {
     sendLocalControlCommand({ type: 'lock_pc' });
   });

   // Native Windows sleep PC command forwarding!
   connManager.on('sleep_pc', (client) => {
     sendLocalControlCommand({ type: 'sleep_pc' });
   });

   // Native Windows shutdown PC command forwarding!
   connManager.on('shutdown_pc', (client) => {
     sendLocalControlCommand({ type: 'shutdown_pc' });
   });

   // Native Windows restart PC command forwarding!
   connManager.on('restart_pc', (client) => {
     sendLocalControlCommand({ type: 'restart_pc' });
   });

   // Native Windows update PC command forwarding!
   connManager.on('update_pc', (client) => {
     sendLocalControlCommand({ type: 'update_pc' });
   });

  // Checklist updates synchronization (New!)
  connManager.on('checklist_update', (client, payload: any) => {
    pairingManager.updateChecklist(payload);
    connManager.broadcastToPaired({
      type: 'checklist_update',
      payload: payload,
      id: generateId(),
      timestamp: Date.now(),
    }, client.id);
  });

  // Collaborative Drawing Sync (New!)
  const drawLineHistory: any[] = [];
  connManager.on('draw_line', (client, payload: any) => {
    drawLineHistory.push(payload);
    if (drawLineHistory.length > 100) {
      drawLineHistory.splice(0, drawLineHistory.length - 100);
    }
    connManager.broadcastToPaired({
      type: 'draw_line',
      payload: payload,
      id: generateId(),
      timestamp: Date.now(),
    }, client.id);
  });

  // Send draw history to freshly paired devices via init_state
  connManager.on('draw_history_request', (client) => {
    connManager.send(client, {
      type: 'draw_history',
      payload: drawLineHistory,
      id: generateId(),
      timestamp: Date.now(),
    });
  });

    // LAN Encrypted Chat Room Messaging (New!)
    connManager.on('chat_message', (client, payload: any) => {
      pairingManager.handleChatMessage(client, payload);
    });

    connManager.on('chat_history_request', (client) => {
      connManager.send(client, {
        type: 'chat_history',
        payload: pairingManager.getChatHistory(),
        id: generateId(),
        timestamp: Date.now(),
      });
    });

   // 🌐 WebRTC Signaling (Screen Mirroring / Audio Casting)
   connManager.on('webrtc_offer', (client, payload: any) => {
     connManager.sendTo(payload.targetDeviceId, {
       type: 'webrtc_offer',
       payload,
       id: generateId(),
       timestamp: Date.now(),
     });
   });

   connManager.on('webrtc_answer', (client, payload: any) => {
     connManager.sendTo(payload.targetDeviceId, {
       type: 'webrtc_answer',
       payload,
       id: generateId(),
       timestamp: Date.now(),
     });
   });

   connManager.on('webrtc_ice_candidate', (client, payload: any) => {
     connManager.sendTo(payload.targetDeviceId, {
       type: 'webrtc_ice_candidate',
       payload,
       id: generateId(),
       timestamp: Date.now(),
     });
   });

   // Force Unpair / Disconnect Device Handler (New!)
   connManager.on('unpair_device', (client, payload: any) => {
     const targetId = typeof payload?.deviceId === 'string' ? payload.deviceId : '';
     if (!targetId || targetId === client.id) return;
     pairingManager.revokeDevice(targetId);
     const target = connManager.getClient(targetId);
     if (target) {
       target.ws.close();
       connManager.removeClient(targetId);
     }
     connManager.broadcastToPaired({
       type: 'device_list',
       payload: connManager.getDeviceList(),
       id: generateId(),
       timestamp: Date.now(),
     });
   });

   // Cross-Device System-Wide Nuclear Wipe (New!)
   connManager.on('nuclear_wipe', (client) => {
     console.log(`[NOTIFY] System-Wide Nuclear Wipe triggered by ${client.name}!`);
     clipboardManager.clearHistory();
     pairingManager.updateChecklist([]);
     connManager.broadcastToPaired({
       type: 'nuclear_wipe',
       id: generateId(),
       timestamp: Date.now()
     });
   });

   // Clipboard request handler - asks the most recent active device to push their clipboard
   connManager.on('clipboard_request', (client) => {
     connManager.broadcastToPaired({
       type: 'clipboard_request',
       payload: { requestingDeviceId: client.id, requestingDeviceName: client.name },
       id: generateId(),
       timestamp: Date.now(),
     }, client.id);
   });

   // Create Express app
   const app = createServer(config, fileTransferManager, clipboardManager, pairingManager, pushManager);

   // Setup HTTPS certificates for Secure WebSocket (WSS) and PWA notifications.
   // HTTP remains available for the local Windows launcher, but iPhones must use HTTPS.
   const { cert, key } = await getOrCreateCertificates(config.localIp);

   // Write the *HTTP* port for the native launcher. It calls its loopback API with
   // http://127.0.0.1, so writing the HTTPS port here made "Send To Goon Drop" fail.
   const writePortFile = (port: number) => {
     try {
       fs.writeFileSync(path.join(__dirname, '..', '..', 'goondrop-port.txt'), port.toString(), 'utf8');
     } catch { }
   };

   const listen = (server: http.Server | https.Server, port: number): Promise<void> => new Promise((resolve, reject) => {
     const onError = (error: Error) => {
       server.off('listening', onListening);
       reject(error);
     };
     const onListening = () => {
       server.off('error', onError);
       resolve();
     };
     server.once('error', onError);
     server.once('listening', onListening);
     server.listen(port, config.host);
   });

   // A retry needs fresh server instances. Calling listen() again on an already
   // listening server throws ERR_SERVER_ALREADY_LISTEN and used to leave a stale
   // port in the QR code / launcher.
   const startServers = async () => {
     for (let basePort = config.port; basePort <= config.port + 20; basePort++) {
       const httpServer = http.createServer(app);
       const httpsServer = https.createServer({ cert, key }, app);
       const wss = new WebSocketServer({ server: httpsServer });
       const wsServer = new WebSocketServer({ server: httpServer });
       // ws forwards a failed underlying listen as an "error" event. Keep that
       // event handled so the retry logic below—not Node's unhandled-event
       // behaviour—decides what to do.
       wss.on('error', () => undefined);
       wsServer.on('error', () => undefined);
       connManager.attach(wss);
       connManager.attach(wsServer);

       try {
         await Promise.all([listen(httpServer, basePort), listen(httpsServer, basePort + 1)]);
         config.port = basePort;
         writePortFile(basePort);
         // Run firewall check in background so server binds and reports immediately
         ensureFirewallRules(basePort).catch(() => {});

         const localUrl = `http://localhost:${basePort}`;
         const httpNetworkUrl = `http://${config.localIp}:${basePort}`;
         const httpsNetworkUrl = `https://${config.localIp}:${basePort + 1}`;

       console.log();
       console.log('  ╭──────────────────────────────────────────╮');
       console.log('  │           Goon Drop Server                │');
       console.log('  │       Continuity Ecosystem               │');
       console.log('  ╰──────────────────────────────────────────╯');
       console.log();
       console.log(`  Local:   ${localUrl}`);
       console.log(`  Network: ${httpNetworkUrl} (Instant / No SSL warnings)`);
       console.log(`  Secure:  ${httpsNetworkUrl} (HTTPS for PWA Push)`);
       console.log(`  Pairing Code: ${config.pairingCode}`);
       console.log();
       console.log('  Open the URL on any device to connect.');
       console.log('  Scan QR code from the web UI to pair.');
       console.log();
         return;
       } catch (err: any) {
         await Promise.allSettled([
           new Promise<void>(resolve => httpServer.close(() => resolve())),
           new Promise<void>(resolve => httpsServer.close(() => resolve())),
         ]);
         wss.close();
         wsServer.close();
         if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
         console.log(`[NOTIFY] Ports ${basePort}/${basePort + 1} are unavailable; trying ${basePort + 1}/${basePort + 2}...`);
       }
     }
     throw new Error(`No available HTTP/HTTPS port pair found between ${config.port} and ${config.port + 21}.`);
   };

   await startServers();

   // 📡 Wi-Fi UDP Broadcast Auto-Discovery Beacon (Zero-QR Pairing!)
   const udpServer = dgram.createSocket('udp4');
   // MUST bind to UDP 3943 (not an ephemeral port): the iOS app broadcasts
   // `goondrop_discover` to 255.255.255.255:3943 and waits for a unicast reply.
   // Binding a random port meant no socket was ever listening on 3943, so the
   // PC silently never heard the phones (and the periodic beacon to 3943 was
   // sent into the void). See LANDiscovery.swift on the iOS side.
   udpServer.bind(3943, () => {
     try {
       udpServer.setBroadcast(true);
     } catch { }
   });
   udpServer.on('error', (err: any) => {
     console.error(`[UDP] Discovery bind on 3943 failed: ${err?.message ?? err}`);
   });

// 🛡️ ROUTER-RESILIENT HANDSHAKE: Listen to direct discovery pings from phones and reply via unicast!
   // This completely bypasses Google Nest / Mesh router multicast blocks!
   udpServer.on('message', (msg, rinfo) => {
     try {
       const text = msg.toString();
       console.log(`[UDP-DISCOVERY] Received ${msg.length} bytes from ${rinfo.address}:${rinfo.port}: ${text}`);
       if (text === 'goondrop_discover') {
         const reply = Buffer.from(JSON.stringify({
           ip: config.localIp,
           port: config.port + 1,
           pairingCode: config.pairingCode,
           serverName: getMachineName()
         }));
         udpServer.send(reply, 0, reply.length, rinfo.port, rinfo.address);
       }
     } catch { }
   });

   setInterval(() => {
     try {
       const message = Buffer.from(JSON.stringify({
         ip: config.localIp,
         port: config.port + 1,
         pairingCode: config.pairingCode,
         serverName: getMachineName()
       }));
       // Broadcast to local subnet on port 3943
       udpServer.send(message, 0, message.length, 3943, '255.255.255.255');
     } catch { }
   }, 3000);

   process.on('SIGINT', shutdown);
   process.on('SIGTERM', shutdown);

   // Self-Healing Dynamic IP change detector (New!)
   let lastKnownIp = config.localIp;
   setInterval(() => {
     try {
       const freshIp = loadConfig().localIp;
       if (freshIp !== lastKnownIp && freshIp !== '127.0.0.1') {
         lastKnownIp = freshIp;
         config.localIp = freshIp;
         console.log(`[NOTIFY] Laptop switched Wi-Fi! New IP address: https://${freshIp}:${config.port + 1}`);
       }
     } catch { }
   }, 10000);

   // Periodic file cleanup (every 30 minutes)
   setInterval(() => {
     fileTransferManager.cleanup(1800000);
   }, 1800000);
 }

  main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
