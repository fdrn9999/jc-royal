/**
 * JC ROYAL sound engine — recorded table effects with Web Audio synthesis as the fallback.
 *
 * Ported from Elite-Poker's `useSound.js` (MIT, © 2026 OpaDips): one shared
 * AudioContext, oscillator/noise voices. Extended with a master/effects gain
 * chain, mute, persisted settings and autoplay-policy compliance (the context
 * is only created/resumed after a user gesture via `unlock()`).
 *
 * Card and chip sounds play short recordings from Pixabay (Pixabay Content License; sources in
 * THIRD_PARTY_NOTICES.md). Until a recording is fetched and decoded — or if that fails — the
 * synthesized voice plays instead, so a sound is never silently lost.
 *
 * What plays is the mixer's call (mixer.ts): a burst plays once, and too much at once drops cards and chips first.
 * A sound only plays at once on a running context in a visible tab: one asked for while the tab is hidden or the
 * context is suspended (iOS, a phone call, the first moments after a tap) is dropped, not saved for later, so a tab
 * coming back or a reconnect never sets off a pile of old sounds.
 */
import { Mixer } from './mixer';

export { AMBIENT, GAP_MS, LENGTH_MS, MAX_VOICES, Mixer } from './mixer';

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
  | 'win'
  // Academy feedback
  | 'select'
  | 'correct'
  | 'wrong'
  | 'complete';

export interface AudioSettings {
  master: number;
  effects: number;
  muted: boolean;
}

const KEY = 'jc.audio';
/**
 * Events that count as a user gesture for audio. iOS Safari only starts audio from the end of a touch (touchend, a
 * tap's click), not from touchstart or a touch's pointerdown.
 */
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
const DEFAULTS: AudioSettings = { master: 0.8, effects: 0.8, muted: false };

/**
 * Recorded voices. The files are peak-normalised; `volume` brings each one to the loudness
 * (RMS of the audible part) of the synthesized voice it replaces, with a -36 dB floor for the
 * very soft card noises. As played (ffmpeg volumedetect over the audible part, times `volume`): cards and the fold
 * -34 dB, chips and actions -27 to -31 dB, and my win -27 dB, so it is not quieter than someone else's chips.
 */
const SAMPLES: Partial<Record<SoundId, { url: string; volume: number }>> = {
  deal: { url: new URL('./sfx/deal.mp3', import.meta.url).href, volume: 0.5 },
  flip: { url: new URL('./sfx/flip.mp3', import.meta.url).href, volume: 0.19 },
  chip: { url: new URL('./sfx/chip.mp3', import.meta.url).href, volume: 0.32 },
  call: { url: new URL('./sfx/call.mp3', import.meta.url).href, volume: 0.31 },
  raise: { url: new URL('./sfx/raise.mp3', import.meta.url).href, volume: 0.56 },
  allin: { url: new URL('./sfx/allin.mp3', import.meta.url).href, volume: 0.33 },
  fold: { url: new URL('./sfx/fold.mp3', import.meta.url).href, volume: 0.09 },
  win: { url: new URL('./sfx/win.mp3', import.meta.url).href, volume: 0.6 },
};

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
  private files = new Map<SoundId, Promise<ArrayBuffer | null>>();
  private buffers = new Map<SoundId, AudioBuffer>();
  private decoding = false;
  private mixer = new Mixer();
  /** While a sound is being started: how to silence each of its parts, should the mixer need its place. */
  private hush: (() => void)[] | null = null;
  private gesture: (() => void) | null = null;
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
        // iOS suspends ("interrupted") the context for a call or the app switcher: the next tap starts it again.
        this.ctx.addEventListener('statechange', () => this.ctx && this.ctx.state !== 'running' && this.listen());
      }
      const ctx = this.ctx;
      if (ctx.state !== 'running') void ctx.resume().then(() => ctx.state === 'running' && this.unlisten(), () => {});
      else this.unlisten();
      // Older iOS only lets a context sound after something played inside the gesture itself.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start();
      this.unlocked = true;
      this.decode(ctx);
    } catch {
      /* audio unsupported */
    }
  }

  /** Starts downloading the recordings (no AudioContext needed, so it can run before the first gesture). */
  preload() {
    if (typeof window === 'undefined' || typeof fetch !== 'function' || this.files.size) return;
    for (const [id, s] of Object.entries(SAMPLES) as [SoundId, { url: string }][]) {
      this.files.set(
        id,
        fetch(s.url)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
      );
    }
  }

  private decode(ctx: AudioContext) {
    if (this.decoding) return;
    this.decoding = true;
    this.preload();
    for (const [id, file] of this.files) {
      void file
        .then((buf) => (buf ? ctx.decodeAudioData(buf) : null))
        .then((b) => b && this.buffers.set(id, b))
        .catch(() => {
          /* keep the synthesized voice */
        });
    }
  }

  /** Unlocks audio on the first interaction; the listeners stay until the context is actually running. */
  installAutoUnlock() {
    if (typeof window === 'undefined') return;
    this.preload();
    if (this.ctx?.state !== 'running') this.listen();
  }

  private listen() {
    if (this.gesture || typeof window === 'undefined') return;
    this.gesture = () => this.unlock();
    for (const ev of GESTURES) window.addEventListener(ev, this.gesture, { passive: true });
  }

  private unlisten() {
    if (!this.gesture) return;
    for (const ev of GESTURES) window.removeEventListener(ev, this.gesture);
    this.gesture = null;
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
    // A suspended context's clock stands still: what is started on it would all sound together once it runs again.
    if (this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => {});
      return null;
    }
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
    this.hush?.push(silence(ctx, gain, osc, t0));
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
    this.hush?.push(silence(ctx, gain, src, t0));
  }

  private sample(buffer: AudioBuffer, volume: number) {
    const ctx = this.ready();
    if (!ctx || !this.fx) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.fx);
    src.start();
    this.hush?.push(silence(ctx, gain, src, ctx.currentTime));
  }

  play(id: SoundId) {
    if (typeof document !== 'undefined' && document.hidden) return;
    const recorded = this.buffers.get(id);
    const parts: (() => void)[] = [];
    if (!this.ready() || !this.mixer.admit(id, performance.now(), recorded && recorded.duration * 1000, () => parts.forEach((f) => f()))) return;
    this.hush = parts;
    try {
      this.voice(id);
    } finally {
      this.hush = null;
    }
  }

  private voice(id: SoundId) {
    const recorded = this.buffers.get(id);
    if (recorded) return this.sample(recorded, SAMPLES[id]!.volume);
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
        this.voice('chip');
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
      case 'select':
        this.tone({ type: 'triangle', freq: 660, endFreq: 880, duration: 0.06, volume: 0.07 });
        return;
      case 'correct':
        this.tone({ type: 'triangle', freq: 659.25, duration: 0.14, volume: 0.11 });
        this.tone({ type: 'triangle', freq: 987.77, duration: 0.22, volume: 0.11, start: 0.09 });
        return;
      case 'wrong':
        this.tone({ type: 'sawtooth', freq: 220, endFreq: 165, duration: 0.22, volume: 0.05 });
        return;
      case 'complete': {
        [523.25, 783.99, 1046.5].forEach((f, i) => this.tone({ type: 'triangle', freq: f, duration: 0.28, volume: 0.12, start: i * 0.1 }));
        return;
      }
    }
  }
}

/** Fades a playing part (started at `t0`) out within a few ms, without a click; one not started yet never starts. */
function silence(ctx: AudioContext, gain: GainNode, src: AudioScheduledSourceNode, t0: number) {
  return () => {
    try {
      const t = ctx.currentTime;
      // Its envelope has not begun (the gain stands at 1 until then): stopped before it starts, it never sounds.
      if (t < t0) return src.stop(t);
      const g = gain.gain;
      // Held where it is, so a fade under way never jumps back up to where its ramp began.
      if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
      else {
        const v = g.value;
        g.cancelScheduledValues(t);
        g.setValueAtTime(v, t);
      }
      g.setTargetAtTime(0, t, 0.006);
      src.stop(t + 0.04);
    } catch {
      /* already over */
    }
  };
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

export const sound = new SoundEngine();
