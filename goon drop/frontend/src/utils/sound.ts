/** Procedural audio chimes using HTML5 Web Audio API - iOS Multi-context unlocked */

export type ChimeType = 'success' | 'notify' | 'chirp';

let globalCtx: AudioContext | null = null;
let _primed = false;

export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!globalCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      globalCtx = new AudioContextClass();
    }
  }
  return globalCtx;
}

export function resumeGlobalAudio(): void {
  try {
    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (!_primed) {
        primeAudioContext(ctx);
        _primed = true;
      }
    }
  } catch {}
}

function primeAudioContext(ctx: AudioContext): void {
  try {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
  } catch {}
}

export function playChime(type: ChimeType): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const needsResume = ctx.state === 'suspended';
    if (needsResume) {
      ctx.resume().catch(() => {});
    }

    // Always prime after first call
    if (!_primed) {
      primeAudioContext(ctx);
      _primed = true;
    }

    // Small offset to give resume time to settle on iOS
    const t = ctx.currentTime + 0.04;

    if (type === 'success') {
      playToneAt(ctx, 523.25, 0.2, 0.25, t);
      playToneAt(ctx, 261.63, 0.2, 0.15, t);
      setTimeout(() => {
        playToneAt(ctx, 659.25, 0.25, 0.3, ctx.currentTime);
        playToneAt(ctx, 329.63, 0.25, 0.2, ctx.currentTime);
      }, 100);
    } else if (type === 'notify') {
      const osc = ctx.createOscillator();
      const oscHarmonic = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      oscHarmonic.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, t);
      osc.frequency.exponentialRampToValueAtTime(1200, t + 0.35);

      oscHarmonic.type = 'sine';
      oscHarmonic.frequency.setValueAtTime(300, t);
      oscHarmonic.frequency.exponentialRampToValueAtTime(600, t + 0.35);

      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

      osc.start(t);
      oscHarmonic.start(t);
      osc.stop(t + 0.35);
      oscHarmonic.stop(t + 0.35);
    } else {
      playToneAt(ctx, 587.33, 0.08, 0.2, t);
      playToneAt(ctx, 293.66, 0.08, 0.1, t);
      setTimeout(() => {
        playToneAt(ctx, 587.33, 0.08, 0.2, ctx.currentTime);
        playToneAt(ctx, 293.66, 0.08, 0.1, ctx.currentTime);
      }, 90);
    }
  } catch {
    // Web audio blocked or unsupported
  }
}

function playToneAt(ctx: AudioContext, freq: number, duration: number, volume: number, startTime: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(volume, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.start(startTime);
  osc.stop(startTime + duration);
}
