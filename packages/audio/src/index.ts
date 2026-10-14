/**
 * JC ROYAL sound engine — Web Audio synthesis (no audio files).
 *
 * Ported from Elite-Poker's `useSound.js` (MIT, © 2026 OpaDips): one shared
 * AudioContext, oscillator/noise voices. Extended with a master/effects gain
 * chain, mute, persisted settings and autoplay-policy compliance (the context
 * is only created/resumed after a user gesture via `unlock()`).
 */

export type SoundId =
  | 'deal'
  | 'flip'
  | 'chip'
  | 'check'
  | 'call'
  | 'raise'
  | 'allin'
  | 'fold'
  | 'timer'
  | 'showdown'
  | 'win';

export interface AudioSettings {
  master: number;
  effects: number;
  muted: boolean;
}

const KEY = 'jc.audio';
const DEFAULTS: AudioSettings = { master: 0.8, effects: 0.8, muted: false };

function readSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AudioSettings>) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private fx: GainNode | null = null;
  private unlocked = false;
  private listeners = new Set<(s: AudioSettings) => void>();
  settings: AudioSettings = typeof window === 'undefined' ? { ...DEFAULTS } : readSettings();

  /** Must be called from a user gesture (click/keydown/touch). */
  unlock() {
    if (typeof window === 'undefined') return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.fx = this.ctx.createGain();
        this.fx.connect(this.master);
        this.master.connect(this.ctx.destination);
        this.applyGains();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      this.unlocked = true;
    } catch {
      /* audio unsupported */
    }
  }

  /** Installs one-shot listeners that unlock audio on the first interaction. */
  installAutoUnlock() {
    if (typeof window === 'undefined') return;
    const handler = () => {
      this.unlock();
      if (this.unlocked) for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, handler);
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, handler, { passive: true });
  }

  update(patch: Partial<AudioSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.settings.master = clamp01(this.settings.master);
    this.settings.effects = clamp01(this.settings.effects);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    this.applyGains();
    for (const l of this.listeners) l(this.settings);
  }

  subscribe(fn: (s: AudioSettings) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private applyGains() {
    if (!this.master || !this.fx || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.muted ? 0 : this.settings.master, t, 0.01);
    this.fx.gain.setTargetAtTime(this.settings.effects, t, 0.01);
  }

  private ready(): AudioContext | null {
    if (!this.unlocked || !this.ctx || this.settings.muted) return null;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(o: { type?: OscillatorType; freq: number; endFreq?: number; start?: number; duration?: number; volume?: number }) {
    const ctx = this.ready();
    if (!ctx || !this.fx) return;
    const t0 = ctx.currentTime + (o.start ?? 0);
    const dur = o.duration ?? 0.15;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(o.endFreq, 1), t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(o.volume ?? 0.2, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(this.fx);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(o: { duration?: number; volume?: number; filterFreq?: number; start?: number }) {
    const ctx = this.ready();
    if (!ctx || !this.fx) return;
    const dur = o.duration ?? 0.08;
    const t0 = ctx.currentTime + (o.start ?? 0);
    const size = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-4 * (i / size));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = o.filterFreq ?? 2200;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(o.volume ?? 0.15, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.fx);
    src.start(t0);
    src.stop(t0 + dur);
  }

  play(id: SoundId) {
    switch (id) {
      case 'deal':
        this.noise({ duration: 0.09, volume: 0.14, filterFreq: 1800 });
        this.noise({ duration: 0.05, volume: 0.07, filterFreq: 3200, start: 0.03 });
        return;
      case 'flip':
        this.noise({ duration: 0.06, volume: 0.12, filterFreq: 2600 });
        this.tone({ type: 'triangle', freq: 520, endFreq: 760, duration: 0.07, volume: 0.05, start: 0.02 });
        return;
      case 'chip':
        this.tone({ type: 'triangle', freq: 1900, endFreq: 1100, duration: 0.045, volume: 0.14 });
        this.tone({ type: 'sine', freq: 950, endFreq: 620, duration: 0.07, volume: 0.1, start: 0.02 });
        return;
      case 'check':
        this.noise({ duration: 0.04, volume: 0.18, filterFreq: 600 });
        this.noise({ duration: 0.04, volume: 0.14, filterFreq: 600, start: 0.11 });
        return;
      case 'call':
        this.play('chip');
        this.tone({ type: 'sine', freq: 1300, endFreq: 700, duration: 0.055, volume: 0.1, start: 0.08 });
        return;
      case 'raise':
        for (let i = 0; i < 3; i++) this.tone({ type: 'triangle', freq: 1700 + i * 120, endFreq: 1000, duration: 0.05, volume: 0.11, start: i * 0.06 });
        return;
      case 'allin':
        for (let i = 0; i < 10; i++) {
          const f = 900 + Math.random() * 900;
          this.tone({ type: 'triangle', freq: f, endFreq: f * 0.55, duration: 0.16, volume: 0.08, start: i * 0.035 });
        }
        this.noise({ duration: 0.35, volume: 0.06, filterFreq: 5000, start: 0.05 });
        return;
      case 'fold':
        this.noise({ duration: 0.12, volume: 0.1, filterFreq: 900 });
        return;
      case 'timer':
        this.tone({ type: 'sine', freq: 880, duration: 0.09, volume: 0.1 });
        this.tone({ type: 'sine', freq: 880, duration: 0.09, volume: 0.08, start: 0.14 });
        return;
      case 'showdown':
        this.tone({ type: 'triangle', freq: 392, duration: 0.25, volume: 0.09 });
        this.tone({ type: 'triangle', freq: 523.25, duration: 0.3, volume: 0.09, start: 0.12 });
        return;
      case 'win': {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => {
          this.tone({ type: 'triangle', freq: f, duration: 0.32, volume: 0.14, start: i * 0.11 });
          this.tone({ type: 'sine', freq: f * 2, duration: 0.22, volume: 0.05, start: i * 0.11 });
        });
        this.tone({ type: 'sine', freq: 1318.5, duration: 0.5, volume: 0.1, start: notes.length * 0.11 });
        return;
      }
    }
  }
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

export const sound = new SoundEngine();
