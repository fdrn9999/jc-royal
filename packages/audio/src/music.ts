/**
 * The table's background music: one recording at a time, looped by the media element itself. Which one is the table's
 * choice (`enter(track)`, from the catalogue in bgm.ts): the first, "검은 테이블의 리듬" (music/black-table-rhythm.mp3,
 * 2:28), starts at the full beat 0.12 s in and ends on a 2 s fade to -38 dB, so the loop is the end fading away and
 * the beat coming back, with no click and no gap worth a crossfade.
 *
 * It plays at a table (`enter`, `leave`), apart from the table's sounds: its own on/off and volume (AudioSettings
 * `musicOn`, `music`), under the master volume and mute every sound shares. Through the sound engine's AudioContext
 * (a MediaElementAudioSourceNode into the master fader), so iOS, which ignores a media element's own volume, plays it
 * at the volume set, and starting and stopping fade instead of cutting. One element for the page's whole life, so a
 * new hand, a reconnect, a re-render or a move to another table with the same music never starts it again; it streams,
 * nothing of it is decoded or kept. A table with other music: the one playing fades out, the same element takes the
 * new file and fades in (never two at once). A table with none: it fades out and stops, the table's sounds play on.
 *
 * It sounds only:
 * - at a table: leaving fades it out, unless another table opens within LEAVE_GRACE_MS (a move between tables);
 * - with audio unlocked (the context running): a browser that refuses to play before a tap gets it on the next tap;
 * - in a visible tab, and in one tab at a time: a tab that starts it tells the others (BroadcastChannel), which fade
 *   out until they are shown or focused again;
 * - while it is on and not muted; turned off, it fades out and the element stops (nothing plays at volume 0).
 * A file that fails to load leaves the table as it is, without music: only that recording, until a table is opened
 * again (another table's music loads and plays as usual).
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
/** A table with other music: the one playing fades this long, then the element takes the new file. */
const SWITCH_AFTER_MS = 900;
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

/** A recording: its file and the level it plays at next to the others (1: as mastered). */
export interface MusicTrack {
  url: string;
  gain?: number;
}
/** The recordings by id; null for an id that plays nothing (a table without music). */
export type MusicTracks = Readonly<Record<string, MusicTrack | null>>;
/** The id of the one recording when Music is given a single file. */
const ONLY = 'default';

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
  /** The recording that failed to load (the element holds one at a time). */
  private failedTrack: string | null = null;
  private readonly tracks: MusicTracks;
  /** With a single file, every table plays it; with a catalogue, a table plays nothing until it says which. */
  private readonly sole: boolean;
  /** The recording the table asked for; null while no table said which. */
  private track: string | null;
  /** The recording the element holds. */
  private loaded: string | null = null;
  private switching: ReturnType<typeof setTimeout> | null = null;
  /** A recording played outside a table (the room form's preview); null otherwise. */
  private previewing: string | null = null;
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
    tracks: string | MusicTracks,
  ) {
    this.sole = typeof tracks === 'string';
    this.tracks = typeof tracks === 'string' ? { [ONLY]: { url: tracks } } : tracks;
    this.track = this.sole ? ONLY : null;
  }

  /**
   * A table opened: plays (or plays on, if it was being left for this one). `track`: the table's music, once it is
   * known (the room's state said so); an id the catalogue does not have changes nothing. Called without one, the
   * table is open and the music of the table before plays on until this one says its own. It takes the music from
   * another tab only once it plays itself: a hidden tab, one with the music off or audio still locked, opens its
   * table in silence.
   */
  enter(track?: string) {
    if (this.leaving) clearTimeout(this.leaving);
    this.leaving = null;
    this.listen();
    if (!this.atTable) {
      this.atTable = true;
      this.yielded = false;
      // A recording that failed is tried again at the next table.
      if (this.failedTrack) this.loaded = this.failedTrack = null;
    }
    if (track !== undefined && Object.hasOwn(this.tracks, track)) this.track = track;
    this.sync();
  }

  /** The table closed: fades out, unless another opens within LEAVE_GRACE_MS. */
  leave() {
    if (this.leaving) clearTimeout(this.leaving);
    this.leaving = setTimeout(() => {
      this.leaving = null;
      this.atTable = false;
      if (!this.sole) this.track = null;
      this.sync();
    }, LEAVE_GRACE_MS);
  }

  /**
   * Plays a recording away from a table (choosing a room's music), or with null stops it. Through the same element
   * and fader as the table's, so it follows the music's switch, volume and mute, and never plays next to the table's.
   */
  preview(track: string | null) {
    this.previewing = track !== null && this.tracks[track] ? track : null;
    if (this.previewing) {
      this.listen();
      if (!this.atTable) {
        // Asked for by hand: it takes the music back from another tab (once it plays), and a recording that failed
        // is tried again.
        this.yielded = false;
        if (this.failedTrack === this.previewing) this.loaded = this.failedTrack = null;
      }
    }
    this.sync();
  }

  /** The recording to play now, if any: the table's, or away from a table the one previewed. */
  private current(): string | null {
    const id = this.atTable ? this.track : this.previewing;
    return id !== null && this.tracks[id] ? id : null;
  }

  /** Whether it should be sounding now. */
  wanted(): boolean {
    const s = this.host.settings();
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const id = this.current();
    return id !== null && s.musicOn && !s.muted && s.music > 0 && visible && !this.yielded && this.failedTrack !== id;
  }

  /** Brings the element and its fader to what is wanted now. Called on every change (settings, tab, context, gesture). */
  sync() {
    const out = this.wanted() ? this.host.output() : null;
    if (!out) return this.fadeOut();
    const id = this.current()!;
    const el = this.element(out, id);
    if (!el || !this.gain) return;
    // The table's music is another recording: the one playing fades out first (the timer comes back here).
    if (this.switching) return;
    if (this.loaded !== id) {
      if (!el.paused) return this.switchAfterFade(el);
      this.load(el, id);
    }
    if (this.pausing) clearTimeout(this.pausing);
    this.pausing = null;
    const back = this.fading;
    this.fading = false;
    const s = this.host.settings();
    const target = MUSIC_TRIM * s.music * (this.tracks[id]?.gain ?? 1);
    const t = out.ctx.currentTime;
    if (el.paused) {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(0, t);
      this.gain.gain.setTargetAtTime(target, t, FADE_IN);
      const played = el.play();
      this.blocked = false;
      // The other tabs are told once it plays, so a play refused takes nothing from them.
      if (!played) this.claim();
      void played?.then(
        () => {
          if (this.wanted()) this.claim();
        },
        (e: unknown) => {
          // Refused before a gesture: the next one plays it. Any other failure: no music, the table as it is.
          if (e instanceof Error && e.name === 'NotAllowedError') {
            this.blocked = true;
            this.host.needGesture();
          }
        },
      );
    } else {
      if (back) this.claim();
      this.gain.gain.setTargetAtTime(target, t, back ? FADE_IN : SLIDE);
    }
  }

  /** Fades the recording playing out, then stops it and comes back to `sync` for what is wanted by then. */
  private switchAfterFade(el: HTMLAudioElement) {
    if (this.pausing) clearTimeout(this.pausing);
    this.pausing = null;
    this.fading = true;
    this.gain!.gain.setTargetAtTime(0, this.gain!.context.currentTime, FADE_OUT);
    this.switching = setTimeout(() => {
      this.switching = null;
      this.fading = false;
      el.pause();
      this.sync();
    }, SWITCH_AFTER_MS);
  }

  /** Gives the (stopped) element a recording: it starts from its beginning. */
  private load(el: HTMLAudioElement, id: string) {
    this.loaded = id;
    if (this.failedTrack === id) this.failedTrack = null;
    el.src = this.tracks[id]!.url;
  }

  private fadeOut() {
    const el = this.el;
    if (!el || el.paused || !this.gain) return;
    // (A switch under way is a fade out already: its timer stops the element, and nothing is wanted after it.)
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
  private element(out: { ctx: AudioContext; into: AudioNode }, id: string): HTMLAudioElement | null {
    if (this.el) return this.el;
    if (typeof Audio === 'undefined') return null;
    try {
      const el = new Audio();
      el.loop = true;
      el.preload = 'auto';
      el.addEventListener('error', () => {
        // Only the recording it holds: the table goes on without it, and another table's music still loads.
        this.failedTrack = this.loaded;
        this.sync();
      });
      this.load(el, id);
      const gain = out.ctx.createGain();
      gain.gain.value = 0;
      out.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(out.into);
      this.el = el;
      this.gain = gain;
      return el;
    } catch {
      this.failedTrack = id;
      return null;
    }
  }

  /** Tells the other tabs this one plays now; the latest to say so plays. */
  private claim() {
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
    // Shown or focused again, at a table: this tab takes the music back, once it plays (sync).
    const back = () => {
      if ((this.atTable || this.previewing) && !(typeof document !== 'undefined' && document.visibilityState === 'hidden')) this.yielded = false;
      this.sync();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
  }

  /** For tests and diagnosis: the element's state. */
  state() {
    return {
      playing: !!this.el && !this.el.paused,
      atTable: this.atTable,
      yielded: this.yielded,
      blocked: this.blocked,
      failed: this.failedTrack !== null && this.failedTrack === this.current(),
      /** The recording asked for now (null: none), and the one the element holds. */
      track: this.current(),
      loaded: this.loaded,
    };
  }
}
