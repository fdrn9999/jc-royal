/**
 * The table's background music: one recording ("검은 테이블의 리듬", music/black-table-rhythm.mp3, 2:28), looped by the
 * media element itself. It starts at the full beat 0.12 s in and ends on a 2 s fade to -38 dB, so the loop is the end
 * fading away and the beat coming back, with no click and no gap worth a crossfade.
 *
 * It plays at a table (`enter`, `leave`), apart from the table's sounds: its own on/off and volume (AudioSettings
 * `musicOn`, `music`), under the master volume and mute every sound shares. Through the sound engine's AudioContext
 * (a MediaElementAudioSourceNode into the master fader), so iOS, which ignores a media element's own volume, plays it
 * at the volume set, and starting and stopping fade instead of cutting. One element for the page's whole life, so a
 * new hand, a reconnect, a re-render or a move to another table never starts it again; it streams, nothing of it is
 * decoded or kept.
 *
 * It sounds only:
 * - at a table: leaving fades it out, unless another table opens within LEAVE_GRACE_MS (a move between tables);
 * - with audio unlocked (the context running): a browser that refuses to play before a tap gets it on the next tap;
 * - in a visible tab, and in one tab at a time: a tab that starts it tells the others (BroadcastChannel), which fade
 *   out until they are shown or focused again;
 * - while it is on and not muted; turned off, it fades out and the element stops (nothing plays at volume 0).
 * A file that fails to load leaves the table as it is, without music.
 */

/** Its level at 100%: the recording is mastered loud (-17 dB mean); at the 25% it starts at, it sits about 5 dB under the table's actions. */
export const MUSIC_TRIM = 0.5;
export const MUSIC_DEFAULT = 0.25;
/** A table closed and another opened within this is a move between tables: the music plays on. */
export const LEAVE_GRACE_MS = 600;
const FADE_IN = 0.35;
const FADE_OUT = 0.25;
/** After a fade out, the element is paused (FADE_OUT time constants: inaudible by then). */
const PAUSE_AFTER_MS = 1_400;
/** A volume moved on the slider follows at once. */
const SLIDE = 0.04;
const CHANNEL = 'jc.music';

export interface MusicSettings {
  musicOn: boolean;
  music: number;
  muted: boolean;
}

/** What the music needs of the sound engine. */
export interface MusicHost {
  /**
   * The context and the node music plays into (the master fader), once audio is unlocked; null before. The context
   * may still be starting (a tap's resume): the element starts inside the tap, which a browser allows, and sounds once it runs.
   */
  output(): { ctx: AudioContext; into: AudioNode } | null;
  /** A play was refused: the next user gesture is to try again (it calls `sync`, inside the gesture). */
  needGesture(): void;
  settings(): MusicSettings;
}

interface Claim {
  type: 'claim';
  tab: string;
  at: number;
}

export class Music {
  private el: HTMLAudioElement | null = null;
  private gain: GainNode | null = null;
  private atTable = false;
  private leaving: ReturnType<typeof setTimeout> | null = null;
  private pausing: ReturnType<typeof setTimeout> | null = null;
  /** Another tab started it after this one did. */
  private yielded = false;
  private failed = false;
  /** play() was refused (autoplay policy) and waits for a gesture. */
  blocked = false;
  /** Fading out (to be paused): coming back fades in again rather than jumping up. */
  private fading = false;
  private channel: BroadcastChannel | null = null;
  private readonly tab = Math.random().toString(36).slice(2);
  private claimedAt = 0;
  private listening = false;

  constructor(
    private host: MusicHost,
    private url: string,
  ) {}

  /** A table opened: plays (or plays on, if it was being left for this one). */
  enter() {
    if (this.leaving) clearTimeout(this.leaving);
    this.leaving = null;
    this.listen();
    if (!this.atTable) {
      this.atTable = true;
      this.claim();
    }
    this.sync();
  }

  /** The table closed: fades out, unless another opens within LEAVE_GRACE_MS. */
  leave() {
    if (this.leaving) clearTimeout(this.leaving);
    this.leaving = setTimeout(() => {
      this.leaving = null;
      this.atTable = false;
      this.sync();
    }, LEAVE_GRACE_MS);
  }

  /** Whether it should be sounding now. */
  wanted(): boolean {
    const s = this.host.settings();
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    return this.atTable && s.musicOn && !s.muted && s.music > 0 && visible && !this.yielded && !this.failed;
  }

  /** Brings the element and its fader to what is wanted now. Called on every change (settings, tab, context, gesture). */
  sync() {
    const out = this.wanted() ? this.host.output() : null;
    if (!out) return this.fadeOut();
    const el = this.element(out);
    if (!el || !this.gain) return;
    if (this.pausing) clearTimeout(this.pausing);
    this.pausing = null;
    const back = this.fading;
    this.fading = false;
    const s = this.host.settings();
    const target = MUSIC_TRIM * s.music;
    const t = out.ctx.currentTime;
    if (el.paused) {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(0, t);
      this.gain.gain.setTargetAtTime(target, t, FADE_IN);
      const played = el.play();
      this.blocked = false;
      void played?.catch((e: unknown) => {
        // Refused before a gesture: the next one plays it. Any other failure: no music, the table as it is.
        if (e instanceof Error && e.name === 'NotAllowedError') {
          this.blocked = true;
          this.host.needGesture();
        }
      });
    } else this.gain.gain.setTargetAtTime(target, t, back ? FADE_IN : SLIDE);
  }

  private fadeOut() {
    const el = this.el;
    if (!el || el.paused || !this.gain) return;
    if (this.fading) return;
    this.fading = true;
    this.gain.gain.setTargetAtTime(0, this.gain.context.currentTime, FADE_OUT);
    this.pausing = setTimeout(() => {
      this.pausing = null;
      if (!this.fading) return;
      this.fading = false;
      el.pause();
    }, PAUSE_AFTER_MS);
  }

  /** The one element, routed into the context the first time it is needed. */
  private element(out: { ctx: AudioContext; into: AudioNode }): HTMLAudioElement | null {
    if (this.el) return this.el;
    if (typeof Audio === 'undefined') return null;
    try {
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      el.addEventListener('error', () => {
        this.failed = true;
      });
      el.src = this.url;
      const gain = out.ctx.createGain();
      gain.gain.value = 0;
      out.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(out.into);
      this.el = el;
      this.gain = gain;
      return el;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /** Tells the other tabs this one plays now; the latest to say so plays. */
  private claim() {
    this.yielded = false;
    this.claimedAt = Date.now();
    try {
      this.channel?.postMessage({ type: 'claim', tab: this.tab, at: this.claimedAt } satisfies Claim);
    } catch {
      /* closed */
    }
  }

  private listen() {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL);
        this.channel.onmessage = (e: MessageEvent<Claim>) => {
          const m = e.data;
          if (m?.type !== 'claim' || m.tab === this.tab) return;
          if (m.at > this.claimedAt || (m.at === this.claimedAt && m.tab > this.tab)) {
            this.yielded = true;
            this.sync();
          }
        };
      } catch {
        this.channel = null;
      }
    }
    // Shown or focused again, at a table: this tab takes the music back.
    const back = () => {
      if (!this.atTable || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return this.sync();
      this.claim();
      this.sync();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
  }

  /** For tests and diagnosis: the element's state. */
  state() {
    return { playing: !!this.el && !this.el.paused, atTable: this.atTable, yielded: this.yielded, blocked: this.blocked, failed: this.failed };
  }
}
