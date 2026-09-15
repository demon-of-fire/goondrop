/** File transfer handler - manages chunked file transfers between devices */
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ConnectionManager, Client } from './websocket';
import { generateId, sanitizeFilename, ensureDir } from './utils';
import { PushManager } from './pushManager';

interface FileTransfer {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  chunkCount: number;
  receivedChunks: number;
  receivedChunkIndexes: Set<number>;
  sourceDeviceId: string;
  targetDeviceId?: string;
  status?: 'pending' | 'receiving' | 'declined' | 'completed';
  createdAt: number;
  tempPath: string;
}

export class FileTransferManager {
  private transfers: Map<string, FileTransfer> = new Map();
  private tempDir: string;
  private maxFileSize: number;
  private dropZonePath: string;
  private pushManager: PushManager;

  constructor(private conn: ConnectionManager, pushManager: PushManager, tempDir: string, maxFileSize: number, private chunkSize: number) {
    this.tempDir = tempDir;
    this.maxFileSize = maxFileSize;
    this.pushManager = pushManager;
    ensureDir(tempDir);

    const desktopPath = path.join(os.homedir(), 'Desktop');
    this.dropZonePath = path.join(desktopPath, 'GoonDrop_DropZone');
    ensureDir(this.dropZonePath);

    // 🧹 Startup Purge: Delete any stale files left over from previous crashes
    try {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(tempDir, file));
        } catch { }
      }
    } catch { }

    // 📁 Windows Directory Watcher (Drop Folder!)
    // The second you drag-and-drop any file into the Desktop/GoonDrop_DropZone folder,
    // Node.js instantly intercepts it, registers it, and beams it directly to your iPhone!
    this.startDirectoryWatcher();
  }

  private startDirectoryWatcher(): void {
    try {
      let isProcessing = false;
      let processingTimer: ReturnType<typeof setTimeout> | null = null;
      fs.watch(this.dropZonePath, (eventType, filename) => {
        if (eventType === 'rename' && filename && !isProcessing) {
          isProcessing = true;

          const fullPath = path.join(this.dropZonePath, filename);
          let lastSize = -1;
          let stableChecks = 0;

          const checkStable = () => {
            try {
              if (!fs.existsSync(fullPath)) { isProcessing = false; return; }
              const currentSize = fs.statSync(fullPath).size;
              if (currentSize === lastSize) {
                stableChecks++;
                if (stableChecks >= 3) {
                  processFile();
                  return;
                }
              } else {
                stableChecks = 0;
                lastSize = currentSize;
              }
              processingTimer = setTimeout(checkStable, 500);
            } catch { isProcessing = false; }
          };

          const processFile = () => {
            try {
              if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
                isProcessing = false;
                return;
              }
              const stats = fs.statSync(fullPath);
              if (stats.size > this.maxFileSize) {
                console.log(`[NOTIFY] DropZone file too large: ${filename}`);
                isProcessing = false;
                return;
              }
              const fileId = `file-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`;
              const tempDest = path.join(this.tempDir, `${fileId}_${sanitizeFilename(filename)}`);
              fs.copyFileSync(fullPath, tempDest);
              this.registerLocalFile(fileId, tempDest, filename, stats.size);
              try { fs.unlinkSync(fullPath); } catch { }
              console.log(`[NOTIFY] DropZone shared file: ${filename}`);
            } catch { }
            isProcessing = false;
          };

          processingTimer = setTimeout(checkStable, 400);
        }
      });
    } catch { }
  }

  /** Explicitly accept a file transfer (from Notification Action) */
  public acceptFile(deviceId: string, fileId: string): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.status === 'declined' || (transfer.targetDeviceId && transfer.targetDeviceId !== deviceId)) return;
    transfer.targetDeviceId = deviceId;
    transfer.status = 'receiving';
    const source = this.conn.getClient(transfer.sourceDeviceId);
    if (source) {
      this.conn.send(source, {
        type: 'file_accept',
        payload: { fileId, targetDeviceId: deviceId },
        id: generateId(),
        timestamp: Date.now(),
      });
      if (transfer.receivedChunks >= transfer.chunkCount) this.finalizeTransfer(transfer, source);
    }
  }

  /** Explicitly decline a file transfer (from Notification Action) */
  public declineFile(deviceId: string, fileId: string): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    if (transfer.targetDeviceId && transfer.targetDeviceId !== deviceId) return;
    if (transfer.targetDeviceId === deviceId) transfer.status = 'declined';
    const source = this.conn.getClient(transfer.sourceDeviceId);
    if (source) this.conn.send(source, {
      type: 'file_decline',
      payload: { fileId, deviceId },
      id: generateId(),
      timestamp: Date.now(),
    });
  }

  getConnManager(): ConnectionManager {
    return this.conn;
  }

  /** Register WebSocket message handlers */
  registerHandlers(): void {
    this.conn.on('file_meta', (client, payload: any) => {
      this.handleFileMeta(client, payload);
    });

    this.conn.on('file_chunk', (client, payload: any) => {
      this.handleFileChunk(client, payload);
    });

    this.conn.on('file_cancel', (client, payload: any) => {
      this.handleFileCancel(client, payload);
    });

    this.conn.on('file_accept', (client, payload: any) => {
      this.acceptFile(client.id, payload?.fileId);
    });

    this.conn.on('file_decline', (client, payload: any) => {
      this.declineFile(client.id, payload?.fileId);
    });

    this.conn.on('file_request', (client, payload: any) => {
      this.handleFileRequest(client, payload);
    });
  }

  /** Handle file metadata announcement */
  private handleFileMeta(client: Client, payload: any): void {
    const { fileId, fileName, fileSize, mimeType, chunkCount, targetDeviceId } = payload;

    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(fileId) ||
        typeof fileName !== 'string' || !Number.isSafeInteger(fileSize) || fileSize < 0 ||
        !Number.isSafeInteger(chunkCount) || chunkCount < 1 || fileSize > this.maxFileSize ||
        chunkCount !== Math.max(1, Math.ceil(fileSize / this.chunkSize))) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'INVALID_FILE_METADATA', message: 'File metadata is invalid or exceeds the transfer limit.' },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    if (this.transfers.has(fileId)) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'DUPLICATE_TRANSFER', message: 'A transfer with this ID already exists.' },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    const sanitizedName = sanitizeFilename(fileName);
    const tempPath = path.join(this.tempDir, `${fileId}_${sanitizedName}`);
    
    try {
      // Create/Truncate file to be empty on disk so we can stream chunks directly to it!
      fs.writeFileSync(tempPath, '');
    } catch (err: any) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'FILE_INIT_ERROR', message: `Could not initialize file on disk: ${err.message}` },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    const transfer: FileTransfer = {
      fileId,
      fileName: sanitizedName,
      fileSize,
      mimeType,
      chunkCount: chunkCount || 0,
      receivedChunks: 0,
      receivedChunkIndexes: new Set<number>(),
      sourceDeviceId: client.id,
      targetDeviceId,
      createdAt: Date.now(),
      tempPath: tempPath,
      status: 'pending',
    };

    this.transfers.set(fileId, transfer);

    // If targeted to a specific device, forward metadata
    if (targetDeviceId) {
      this.conn.sendTo(targetDeviceId, {
        type: 'file_meta',
        payload: { fileId, fileName, fileSize, mimeType, chunkCount, sourceDeviceId: client.id, sourceDeviceName: client.name },
        id: generateId(),
        timestamp: Date.now(),
      });
    } else {
      // Broadcast to all other paired devices
      this.conn.broadcastToPaired({
        type: 'file_meta',
        payload: { fileId, fileName, fileSize, mimeType, chunkCount, sourceDeviceId: client.id, sourceDeviceName: client.name },
        id: generateId(),
        timestamp: Date.now(),
      }, client.id);
    }
  }

  /** Handle incoming file chunk */
  private handleFileChunk(client: Client, payload: any): void {
    const { fileId, chunkIndex, data } = payload;
    const transfer = this.transfers.get(fileId);

    if (!transfer) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'TRANSFER_NOT_FOUND', message: 'File transfer not found' },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    if (transfer.sourceDeviceId !== client.id || !Number.isSafeInteger(chunkIndex) ||
        chunkIndex < 0 || chunkIndex >= transfer.chunkCount || typeof data !== 'string' ||
        transfer.receivedChunkIndexes.has(chunkIndex)) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'INVALID_FILE_CHUNK', message: 'File chunk is invalid or has already been received.' },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    try {
      const chunk = Buffer.from(data, 'base64');
      const expectedSize = chunkIndex === transfer.chunkCount - 1
        ? transfer.fileSize - (chunkIndex * this.chunkSize)
        : this.chunkSize;
      if (chunk.length !== expectedSize) {
        throw new Error(`Chunk ${chunkIndex} has ${chunk.length} bytes; expected ${expectedSize}.`);
      }
      // Write at correct position to support out-of-order chunks from parallel upload
      const fd = fs.openSync(transfer.tempPath, 'r+');
      try {
        const position = chunkIndex * this.chunkSize;
        fs.writeSync(fd, chunk, 0, chunk.length, position);
      } finally {
        fs.closeSync(fd);
      }
      transfer.receivedChunkIndexes.add(chunkIndex);
      transfer.receivedChunks = transfer.receivedChunkIndexes.size;

      // Send progress back to the sender for real-time UI feedback. The old
      // broadcast excluded the sender, so the sending device never advanced.
      const progress = Math.round((transfer.receivedChunks / transfer.chunkCount) * 100);
      this.conn.send(client, {
        type: 'file_progress',
        payload: { fileId: transfer.fileId, progress },
        id: generateId(),
        timestamp: Date.now(),
      });
    } catch (err: any) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'FILE_WRITE_ERROR', message: `Could not write chunk to disk: ${err.message}` },
        id: generateId(),
        timestamp: Date.now(),
      });
      return;
    }

    // Send chunk acknowledgment
    this.conn.send(client, {
      type: 'file_chunk_ack',
      payload: { fileId, chunkIndex, received: transfer.receivedChunks },
      id: generateId(),
      timestamp: Date.now(),
    });

    // Check if transfer is complete
    if (transfer.status === 'receiving' && transfer.receivedChunks >= transfer.chunkCount) {
      this.finalizeTransfer(transfer, client);
    }
  }

  /** Finalize a completed file transfer */
  private finalizeTransfer(transfer: FileTransfer, client: Client): void {
    // 🔔 Trigger background push notification for completion
    this.pushManager.broadcastNotification(
      `File Received`, 
      `"${transfer.fileName}" has been received and saved to your PC.`,
      [
        { label: 'Open Folder', value: 'file_open' },
        { label: 'Dismiss', value: 'file_dismiss' }
      ],
      transfer.sourceDeviceId
    );

    // ⚠️ CRITICAL UPGRADE: The file is already 100% assembled on disk! No Buffer.concat or RAM needed!
    // 📂 INTELLIGENT AUTOMATIC FILE SORTING: Sort completed files into clean categories on your laptop's Desktop!
    try {
      const ext = path.extname(transfer.fileName).toLowerCase();
      let category = 'Downloads';

      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
        category = 'Pictures';
      } else if (['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) {
        category = 'Documents';
      } else if (['.mp3', '.wav', '.m4a', '.flac', '.aac'].includes(ext)) {
        category = 'Music';
      } else if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext)) {
        category = 'Videos';
      }

      const destFolder = path.join(os.homedir(), 'Desktop', 'GoonDrop_Received', category);
      ensureDir(destFolder);

      let sortedDest = path.join(destFolder, transfer.fileName);
      
      // Avoid overwriting existing files by appending a counter
      let fileCounter = 1;
      while (fs.existsSync(sortedDest)) {
        const ext = path.extname(transfer.fileName);
        const base = path.basename(transfer.fileName, ext);
        sortedDest = path.join(destFolder, `${base} (${fileCounter})${ext}`);
        fileCounter++;
      }
      
      // Copy from temporary path to the sorted desktop folder!
      fs.copyFileSync(transfer.tempPath, sortedDest);
      console.log(`[NOTIFY] Auto-Sorted ${transfer.fileName} to Desktop/${category}/`);
    } catch { }

    try {
      // Notify recipient that file is ready
      if (transfer.targetDeviceId) {
        this.conn.sendTo(transfer.targetDeviceId, {
          type: 'file_complete',
          payload: {
            fileId: transfer.fileId,
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            mimeType: transfer.mimeType,
            sourceDeviceId: transfer.sourceDeviceId,
            downloadUrl: `/api/files/${transfer.fileId}/${encodeURIComponent(transfer.fileName)}`,
          },
          id: generateId(),
          timestamp: Date.now(),
        });
      } else {
        // Broadcast to all paired devices except sender
        this.conn.broadcastToPaired({
          type: 'file_complete',
          payload: {
            fileId: transfer.fileId,
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            mimeType: transfer.mimeType,
            sourceDeviceId: transfer.sourceDeviceId,
            sourceDeviceName: client.name,
            downloadUrl: `/api/files/${transfer.fileId}/${encodeURIComponent(transfer.fileName)}`,
          },
          id: generateId(),
          timestamp: Date.now(),
        }, client.id);
      }

      // Confirm to sender
      this.conn.send(client, {
        type: 'file_complete',
        payload: { fileId: transfer.fileId, fileName: transfer.fileName, status: 'sent' },
        id: generateId(),
        timestamp: Date.now(),
      });

      console.log(`[NOTIFY] File received from ${client.name}: ${transfer.fileName}`);
    } catch (err: any) {
      this.conn.send(client, {
        type: 'error',
        payload: { code: 'FILE_WRITE_ERROR', message: err.message },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
  }

  /** Handle file transfer cancellation */
  private handleFileCancel(client: Client, payload: any): void {
    const { fileId } = payload;
    const transfer = this.transfers.get(fileId);
    if (transfer && transfer.sourceDeviceId === client.id) {
      if (transfer.tempPath) {
        try { fs.unlinkSync(transfer.tempPath); } catch { /* ignore */ }
      }
      this.transfers.delete(fileId);

      if (transfer.targetDeviceId) {
        this.conn.sendTo(transfer.targetDeviceId, {
          type: 'file_cancel',
          payload: { fileId, reason: 'Cancelled by sender' },
          id: generateId(),
          timestamp: Date.now(),
        });
      } else {
        this.conn.broadcastToPaired({
          type: 'file_cancel',
          payload: { fileId, reason: 'Cancelled by sender' },
          id: generateId(),
          timestamp: Date.now(),
        }, client.id);
      }
    }
  }

  /** Handle file download request via WebSocket trigger */
  private handleFileRequest(client: Client, payload: any): void {
    const { fileId } = payload;
    const transfer = this.transfers.get(fileId);
    if (transfer && transfer.tempPath && fs.existsSync(transfer.tempPath)) {
      this.conn.send(client, {
        type: 'file_meta',
        payload: {
          fileId: transfer.fileId,
          fileName: transfer.fileName,
          fileSize: transfer.fileSize,
          mimeType: transfer.mimeType,
          chunkCount: 0,
          sourceDeviceId: transfer.sourceDeviceId,
          downloadUrl: `/api/files/${transfer.fileId}/${encodeURIComponent(transfer.fileName)}`,
        },
        id: generateId(),
        timestamp: Date.now(),
      });
    }
  }

  /** Get temp file path for a transfer (for HTTP download) */
  getTransferFile(fileId: string): { path: string; name: string } | null {
    for (const [, t] of this.transfers) {
      if (t.fileId === fileId && t.tempPath) {
        return { path: t.tempPath, name: t.fileName };
      }
    }
    return null;
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      '.pdf': 'application/pdf', '.txt': 'text/plain',
      '.html': 'text/html', '.htm': 'text/html',
      '.json': 'application/json', '.xml': 'application/xml',
      '.zip': 'application/zip', '.gz': 'application/gzip',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
      '.flac': 'audio/flac', '.aac': 'audio/aac',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
      '.webm': 'video/webm',
      '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  /** Register a file dynamically from the local Windows machine without chunking! */
  registerLocalFile(fileId: string, sourcePath: string, fileName: string, fileSize: number): void {
    if (fileSize > this.maxFileSize) {
      console.log(`[NOTIFY] File too large, skipping broadcast: ${fileName}`);
      return;
    }
    const mimeType = this.getMimeType(fileName);
    
    this.transfers.set(fileId, {
      fileId,
      fileName: sanitizeFilename(fileName),
      fileSize,
      mimeType,
      chunkCount: 1,
      receivedChunks: 1,
      receivedChunkIndexes: new Set([0]),
      sourceDeviceId: 'local-windows-pc',
      createdAt: Date.now(),
      tempPath: sourcePath
    });

    // Broadcast file_meta
    this.conn.broadcastToPaired({
      type: 'file_meta',
      payload: { fileId, fileName, fileSize, mimeType, chunkCount: 1, sourceDeviceName: 'Windows PC' },
      id: generateId(),
      timestamp: Date.now()
    });

    // Broadcast file_complete immediately
    this.conn.broadcastToPaired({
      type: 'file_complete',
      payload: { 
        fileId, 
        fileName, 
        fileSize, 
        mimeType, 
        sourceDeviceName: 'Windows PC',
        downloadUrl: `/api/files/${fileId}/${encodeURIComponent(fileName)}`
      },
      id: generateId(),
      timestamp: Date.now()
    });
  }

  /** Clean up old transfers */
  cleanup(maxAgeMs = 3600000): void {
    const now = Date.now();
    for (const [id, t] of this.transfers) {
      if (now - t.createdAt > maxAgeMs) {
        if (t.tempPath) {
          try { fs.unlinkSync(t.tempPath); } catch { /* ignore */ }
        }
        this.transfers.delete(id);
      }
    }
  }
}
