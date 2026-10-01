/**
 * Media state controller.
 *
 * The Goon Drop launcher (Form1.cs) is the only component that can read Windows'
 * real playback / mute state. It exposes it on its loopback control port at
 * GET /control/media-state. This module polls that endpoint, caches the latest
 * snapshot and pushes a `media_state` message to every paired device whenever
 * something actually changed, so the phone can render a truthful play/pause
 * button and a "what's playing" card instead of tracking a blind toggle.
 */
import http from 'http';

export interface MediaState {
  /** False when the launcher is not running, so the UI can grey out controls. */
  available: boolean;
  playing: boolean;
  notificationState: number;
  title: string;
  appName: string;
  volume: number;
  volumeMuted: boolean;
  micMuted: boolean;
  micVolume: number;
  updatedAt: number;
}

const LAUNCHER_HOST = '127.0.0.1';
const LAUNCHER_CONTROL_PORT = 3945;
const POLL_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 900;

function emptyState(): MediaState {
  return {
    available: false,
    playing: false,
    notificationState: 0,
    title: '',
    appName: '',
    volume: -1,
    volumeMuted: false,
    micMuted: false,
    micVolume: -1,
    updatedAt: 0,
  };
}

/** Fields whose change is worth telling a device about. */
function diffKey(state: MediaState): string {
  return [
    state.available ? 1 : 0,
    state.playing ? 1 : 0,
    state.title,
    state.appName,
    state.volumeMuted ? 1 : 0,
    state.micMuted ? 1 : 0,
    // Volume is reported as a 0..1 double; quantise so rounding jitter in the
    // Core Audio scalar does not generate a message on every single poll.
    Math.round(state.volume * 100),
    Math.round(state.micVolume * 100),
  ].join('|');
}

export class MediaController {
  private state: MediaState = emptyState();
  private lastKey: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private onChange: ((state: MediaState) => void) | null = null;
  /** Set while a command is in flight so we can report the settled state. */
  private lastCommandError = '';

  constructor() {
    this.lastKey = diffKey(this.state);
  }

  setOnChange(handler: (state: MediaState) => void): void {
    this.onChange = handler;
  }

  getState(): MediaState {
    return this.state;
  }

  getLastCommandError(): string {
    return this.lastCommandError;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Forward a media command to the launcher.
   *
   * Deliberately returns void: the HTTP request is asynchronous, so any
   * synchronous success/failure value would be a guess. An earlier version
   * returned `false` on every call (the response had not arrived yet) which made
   * callers run a fallback path and fire the command twice — fatal for toggles.
   * Callers should rely on `state.available` to know whether the launcher is up,
   * and on the next poll to observe the settled result.
   */
  sendCommand(command: string): void {
    this.post({ type: 'media', command });
  }

  private poll(): void {
    if (this.polling) return;
    this.polling = true;
    this.get('/control/media-state', (err, body) => {
      this.polling = false;
      if (err || !body) {
        this.apply(emptyState());
        return;
      }
      try {
        const parsed = JSON.parse(body) as Partial<MediaState>;
        this.apply({
          available: true,
          playing: !!parsed.playing,
          notificationState: typeof parsed.notificationState === 'number' ? parsed.notificationState : 0,
          title: typeof parsed.title === 'string' ? parsed.title : '',
          appName: typeof parsed.appName === 'string' ? parsed.appName : '',
          volume: typeof parsed.volume === 'number' ? parsed.volume : -1,
          volumeMuted: !!parsed.volumeMuted,
          micMuted: !!parsed.micMuted,
          micVolume: typeof parsed.micVolume === 'number' ? parsed.micVolume : -1,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
        });
      } catch {
        this.apply(emptyState());
      }
    });
  }

  private apply(next: MediaState): void {
    this.state = next;
    const key = diffKey(next);
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (this.onChange) {
      try {
        this.onChange(next);
      } catch (err: any) {
        console.log(`[MEDIA] change handler failed: ${err?.message}`);
      }
    }
  }

  private request(options: http.RequestOptions, body: string, cb: (err: Error | null, body: string) => void): void {
    const req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) cb(null, data);
        else cb(new Error(`launcher responded ${res.statusCode}`), data);
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('launcher control port timed out'));
    });
    req.on('error', (err) => cb(err, ''));
    if (body) req.write(body);
    req.end();
  }

  private get(route: string, cb: (err: Error | null, body: string) => void): void {
    this.request({ hostname: LAUNCHER_HOST, port: LAUNCHER_CONTROL_PORT, path: route, method: 'GET' }, '', cb);
  }

  private post(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    this.request({
      hostname: LAUNCHER_HOST,
      port: LAUNCHER_CONTROL_PORT,
      path: '/control/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, data, (err) => {
      if (err) {
        this.lastCommandError = err.message;
        console.log(`[MEDIA] launcher command failed: ${err.message} (is the Goon Drop launcher running?)`);
      } else {
        this.lastCommandError = '';
      }
    });
  }
}
