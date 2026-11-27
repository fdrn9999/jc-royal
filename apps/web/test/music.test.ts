import { LEAVE_GRACE_MS, Music, MUSIC_DEFAULT, MUSIC_TRIM, type MusicSettings, type MusicTracks } from '@jc/audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The table's music against stand-ins for the media element, Web Audio, the page and the other tabs: when it plays,
 * that it never starts again for what goes on at the table, how it fades, and what it keeps. Real browsers play it in
 * tests/e2e/music.spec.ts.
 */
class Param {
  calls: [string, ...number[]][] = [];
  value = 1;
  setValueAtTime(v: number, t: number) {
    this.calls.push(['setValueAtTime', v, t]);
  }
  setTargetAtTime(v: number, t: number, c: number) {
    this.calls.push(['setTargetAtTime', v, t, c]);
  }
  cancelScheduledValues(t: number) {
    this.calls.push(['cancelScheduledValues', t]);
  }
  /** The last level it was sent toward. */
  get target() {
    const last = [...this.calls].reverse().find((c) => c[0] === 'setTargetAtTime' || c[0] === 'setValueAtTime');
    return last?.[1];
  }
}

class Gain {
  gain = new Param();
  out: unknown = null;
  constructor(public context: Ctx) {}
  connect(to: unknown) {
    this.out = to;
    return to;
  }
}

class Ctx {
  currentTime = 5;
  state: AudioContextState = 'running';
  gains: Gain[] = [];
  sources = 0;
  createGain() {
    const g = new Gain(this);
    this.gains.push(g);
    return g;
  }
  createMediaElementSource(_el: El) {
    this.sources++;
    return { connect: (to: Gain) => to };
  }
}

/** The media element: play() refused while `refuse` is set (the autoplay policy), as browsers do. */
class El {
  static all: El[] = [];
  static refuse = false;
  paused = true;
  loop = false;
  preload = '';
  src = '';
  plays = 0;
  pauses = 0;
  private handlers = new Map<string, (() => void)[]>();
  constructor() {
    El.all.push(this);
  }
  addEventListener(ev: string, fn: () => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  fire(ev: string) {
    for (const fn of this.handlers.get(ev) ?? []) fn();
  }
  play() {
    this.plays++;
    if (El.refuse) return Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.pauses++;
    this.paused = true;
  }
}

/** The other tabs' channel: what one tab posts, every other tab's channel of the same name receives. */
class Channel {
  static open: Channel[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    Channel.open.push(this);
  }
  postMessage(data: unknown) {
    for (const c of Channel.open) if (c !== this && c.name === this.name) c.onmessage?.({ data });
  }
}

const page = { visibilityState: 'visible' as DocumentVisibilityState, listeners: new Map<string, (() => void)[]>() };
const on = (ev: string, fn: () => void) => page.listeners.set(ev, [...(page.listeners.get(ev) ?? []), fn]);
const fire = (ev: string) => {
  for (const fn of page.listeners.get(ev) ?? []) fn();
};

function setup(o: Partial<MusicSettings> = {}, tracks: string | MusicTracks = '/assets/black-table-rhythm.mp3') {
  const ctx = new Ctx();
  const into = { name: 'master' };
  const settings: MusicSettings = { musicOn: true, music: MUSIC_DEFAULT, muted: false, ...o };
  const host = { unlocked: true, gestures: 0 };
  const music = new Music(
    {
      output: () => (host.unlocked ? { ctx: ctx as unknown as AudioContext, into: into as unknown as AudioNode } : null),
      needGesture: () => host.gestures++,
      settings: () => settings,
    },
    tracks,
  );
  return { ctx, into, settings, host, music };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the table’s background music', () => {
  beforeEach(() => {
    El.all = [];
    El.refuse = false;
    Channel.open = [];
    page.visibilityState = 'visible';
    page.listeners.clear();
    vi.stubGlobal('Audio', El);
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.stubGlobal('window', { addEventListener: on, removeEventListener() {} });
    vi.stubGlobal('document', {
      get visibilityState() {
        return page.visibilityState;
      },
      addEventListener: on,
      removeEventListener() {},
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('plays nothing and loads nothing away from a table, nor before audio is unlocked', () => {
    const { music, host } = setup();
    music.sync();
    expect(El.all).toHaveLength(0);
    host.unlocked = false;
    music.enter();
    expect(El.all).toHaveLength(0);
    expect(music.state().playing).toBe(false);
  });

  it('at a table: one looping element streamed from its file, faded in to 25% of its level through the master fader', () => {
    const { music, ctx, into } = setup();
    music.enter();
    expect(El.all).toHaveLength(1);
    const el = El.all[0]!;
    expect(el.loop).toBe(true);
    expect(el.src).toBe('/assets/black-table-rhythm.mp3');
    expect(el.plays).toBe(1);
    expect(ctx.sources).toBe(1);
    const fader = ctx.gains[0]!;
    expect(fader.out).toBe(into);
    expect(fader.gain.calls).toContainEqual(['setValueAtTime', 0, 5]);
    expect(fader.gain.target).toBeCloseTo(MUSIC_TRIM * 0.25);
    expect(music.state().playing).toBe(true);
  });

  it('never starts again for a new hand, a reconnect or a re-render: the same element plays on', () => {
    const { music, ctx } = setup();
    music.enter();
    for (let i = 0; i < 20; i++) music.sync();
    music.enter();
    expect(El.all).toHaveLength(1);
    expect(El.all[0]!.plays).toBe(1);
    expect(El.all[0]!.pauses).toBe(0);
    expect(ctx.sources).toBe(1);
  });

  it('refused before a tap (autoplay policy): asks for a gesture and plays inside it', async () => {
    const { music, host } = setup();
    El.refuse = true;
    music.enter();
    await flush();
    expect(music.state().blocked).toBe(true);
    expect(host.gestures).toBe(1);
    El.refuse = false;
    music.sync();
    await flush();
    expect(music.state()).toMatchObject({ blocked: false, playing: true });
    expect(El.all).toHaveLength(1);
  });

  it('off in the settings: never plays; turned off while playing, fades out and then stops', () => {
    vi.useFakeTimers();
    const off = setup({ musicOn: false });
    off.music.enter();
    expect(El.all).toHaveLength(0);

    const { music, settings, ctx } = setup();
    music.enter();
    const el = El.all[0]!;
    settings.musicOn = false;
    music.sync();
    expect(ctx.gains[0]!.gain.target).toBe(0);
    expect(el.paused).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(el.paused).toBe(true);
    // On again: fades in from where it is, the same element.
    settings.musicOn = true;
    music.sync();
    expect(el.plays).toBe(2);
    expect(El.all).toHaveLength(1);
  });

  it('a volume moved follows at once without starting it again; muted, it fades out like every sound', () => {
    vi.useFakeTimers();
    const { music, settings, ctx } = setup();
    music.enter();
    const fader = ctx.gains[0]!;
    settings.music = 0.6;
    music.sync();
    expect(fader.gain.target).toBeCloseTo(MUSIC_TRIM * 0.6);
    expect(El.all[0]!.plays).toBe(1);
    settings.muted = true;
    music.sync();
    expect(fader.gain.target).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(El.all[0]!.paused).toBe(true);
  });

  it('back on before the fade ends, it fades in again and is not paused', () => {
    vi.useFakeTimers();
    const { music, settings } = setup();
    music.enter();
    settings.muted = true;
    music.sync();
    vi.advanceTimersByTime(300);
    settings.muted = false;
    music.sync();
    vi.advanceTimersByTime(2_000);
    expect(El.all[0]!.paused).toBe(false);
    expect(El.all[0]!.pauses).toBe(0);
  });

  it('a move to another table plays on; leaving the tables fades it out', () => {
    vi.useFakeTimers();
    const { music, ctx } = setup();
    music.enter();
    music.leave();
    vi.advanceTimersByTime(LEAVE_GRACE_MS - 100);
    music.enter();
    vi.advanceTimersByTime(5_000);
    expect(El.all[0]!.pauses).toBe(0);
    expect(El.all[0]!.plays).toBe(1);
    music.leave();
    vi.advanceTimersByTime(LEAVE_GRACE_MS + 1);
    expect(ctx.gains[0]!.gain.target).toBe(0);
    vi.advanceTimersByTime(1_500);
    expect(El.all[0]!.paused).toBe(true);
    expect(music.state().atTable).toBe(false);
  });

  it('keeps one element and one route for the page’s whole life, however many tables are opened and left', () => {
    vi.useFakeTimers();
    const { music, ctx } = setup();
    for (let i = 0; i < 50; i++) {
      music.enter();
      music.leave();
      vi.advanceTimersByTime(LEAVE_GRACE_MS + 1_500);
    }
    expect(El.all).toHaveLength(1);
    expect(ctx.sources).toBe(1);
    expect(ctx.gains).toHaveLength(1);
    expect(page.listeners.get('visibilitychange')).toHaveLength(1);
    expect(Channel.open).toHaveLength(1);
  });

  it('a file that fails to load leaves the table without music, and is not tried again', () => {
    const { music } = setup();
    music.enter();
    El.all[0]!.fire('error');
    El.all[0]!.paused = true;
    music.sync();
    expect(music.state()).toMatchObject({ failed: true, playing: false });
    expect(El.all[0]!.plays).toBe(1);
  });

  it('a hidden tab fades out; shown again, it plays on', () => {
    vi.useFakeTimers();
    const { music } = setup();
    music.enter();
    page.visibilityState = 'hidden';
    fire('visibilitychange');
    vi.advanceTimersByTime(1_500);
    expect(El.all[0]!.paused).toBe(true);
    page.visibilityState = 'visible';
    fire('visibilitychange');
    expect(El.all[0]!.paused).toBe(false);
  });

  it('in one tab at a time: a tab that starts it later takes it, and the first takes it back when focused', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const a = setup();
    a.music.enter();
    await vi.advanceTimersByTimeAsync(0);
    now.mockReturnValue(2_000);
    const b = setup();
    b.music.enter();
    const [elA, elB] = El.all;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(elA!.paused).toBe(true);
    expect(elB!.paused).toBe(false);
    expect(a.music.state().yielded).toBe(true);
    // Tab A focused again: it claims the music, and B yields.
    now.mockReturnValue(3_000);
    for (const fn of page.listeners.get('focus')?.slice(0, 1) ?? []) fn();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(elA!.paused).toBe(false);
    expect(elB!.paused).toBe(true);
  });

  it('a tab that cannot play takes nothing from the one playing: hidden, music off, audio locked or a play refused', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const a = setup();
    a.music.enter();
    await vi.advanceTimersByTimeAsync(0);
    const elA = El.all[0]!;
    const playsOn = async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(elA.paused).toBe(false);
      expect(a.music.state().yielded).toBe(false);
      expect(a.ctx.gains[0]!.gain.target).toBeCloseTo(MUSIC_TRIM * MUSIC_DEFAULT);
    };

    // A table opened in a background tab (B's page hidden while it opens: A is not told of it).
    now.mockReturnValue(2_000);
    const hidden = setup();
    page.visibilityState = 'hidden';
    hidden.music.enter();
    page.visibilityState = 'visible';
    await playsOn();
    expect(hidden.music.state().playing).toBe(false);

    // Music off, or audio not yet unlocked there.
    now.mockReturnValue(3_000);
    const off = setup({ musicOn: false });
    off.music.enter();
    const locked = setup();
    locked.host.unlocked = false;
    locked.music.enter();
    await playsOn();

    // A play the browser refuses before a tap.
    now.mockReturnValue(4_000);
    El.refuse = true;
    const refused = setup();
    refused.music.enter();
    await playsOn();
    expect(refused.music.state()).toMatchObject({ blocked: true, playing: false });
    El.refuse = false;

    // Once the locked tab is unlocked and plays, it takes the music and A yields.
    now.mockReturnValue(5_000);
    locked.host.unlocked = true;
    locked.music.sync();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(locked.music.state().playing).toBe(true);
    expect(a.music.state().yielded).toBe(true);
    expect(elA.paused).toBe(true);
  });

  describe('a table’s own music (a catalogue of recordings)', () => {
    const A = '/assets/black-table-rhythm.mp3';
    const B = '/assets/tournament.mp3';
    const TRACKS = { a: { url: A, gain: 1 }, b: { url: B, gain: 0.8 }, none: null };
    /** Leaves the table and opens another within the grace: the page of the next table mounts before it knows its music. */
    const move = (music: Music) => {
      music.leave();
      music.enter();
    };

    it('plays nothing until the table says which, then that recording at its own level', () => {
      const { music, ctx } = setup({}, TRACKS);
      music.enter();
      expect(El.all).toHaveLength(0);
      expect(music.state()).toMatchObject({ playing: false, track: null });
      music.enter('b');
      expect(El.all).toHaveLength(1);
      expect(El.all[0]!.src).toBe(B);
      expect(ctx.gains[0]!.gain.target).toBeCloseTo(MUSIC_TRIM * MUSIC_DEFAULT * 0.8);
      expect(music.state()).toMatchObject({ playing: true, track: 'b', loaded: 'b' });
    });

    it('an id the catalogue does not have (a URL, a path, an inherited name) changes nothing', () => {
      const { music } = setup({}, TRACKS);
      for (const bad of ['https://example.com/x.mp3', '/assets/other.mp3', 'constructor', 'toString', '']) music.enter(bad);
      expect(El.all).toHaveLength(0);
      music.enter('a');
      for (const bad of ['https://example.com/x.mp3', 'constructor']) music.enter(bad);
      expect(El.all[0]!.src).toBe(A);
      expect(El.all[0]!.plays).toBe(1);
      expect(music.state().track).toBe('a');
    });

    it('another table with the same music: it plays on from where it was, never loaded or started again', () => {
      vi.useFakeTimers();
      const { music } = setup({}, TRACKS);
      music.enter('a');
      const el = El.all[0]!;
      const srcs: string[] = [];
      Object.defineProperty(el, 'src', { get: () => A, set: (v: string) => srcs.push(v) });
      for (let i = 0; i < 5; i++) {
        move(music);
        music.enter('a');
        // A new hand, a reconnect, a re-render.
        for (let k = 0; k < 10; k++) music.enter('a');
        vi.advanceTimersByTime(5_000);
      }
      expect(El.all).toHaveLength(1);
      expect(srcs).toEqual([]);
      expect(el.plays).toBe(1);
      expect(el.pauses).toBe(0);
      expect(music.state().playing).toBe(true);
    });

    it('another table with other music: the one playing fades out, then the same element takes the new file and fades in', () => {
      vi.useFakeTimers();
      const { music, ctx } = setup({}, TRACKS);
      music.enter('a');
      const el = El.all[0]!;
      const fader = ctx.gains[0]!.gain;
      move(music);
      // Still the first table's music while the next has not said its own.
      expect(music.state()).toMatchObject({ playing: true, track: 'a' });
      music.enter('b');
      // Fading out: the old recording is still the one loaded, and nothing of the new one plays under it.
      expect(el.src).toBe(A);
      expect(fader.target).toBe(0);
      expect(el.pauses).toBe(0);
      music.enter('b');
      music.sync();
      expect(el.src).toBe(A);
      vi.advanceTimersByTime(899);
      expect(el.src).toBe(A);
      vi.advanceTimersByTime(1);
      // Stopped, given the new file, started: one element throughout, so never two recordings at once.
      expect(El.all).toHaveLength(1);
      expect(ctx.sources).toBe(1);
      expect(el.pauses).toBe(1);
      expect(el.src).toBe(B);
      expect(el.plays).toBe(2);
      expect(fader.target).toBeCloseTo(MUSIC_TRIM * MUSIC_DEFAULT * 0.8);
      expect(music.state()).toMatchObject({ playing: true, track: 'b', loaded: 'b' });
      // And it does not start again from there.
      vi.advanceTimersByTime(10_000);
      for (let k = 0; k < 10; k++) music.enter('b');
      expect(el.plays).toBe(2);
      expect(el.pauses).toBe(1);
    });

    it('back to the first table’s music before the switch is over: it plays on, never loaded again', () => {
      vi.useFakeTimers();
      const { music } = setup({}, TRACKS);
      music.enter('a');
      const el = El.all[0]!;
      music.enter('b');
      vi.advanceTimersByTime(300);
      music.enter('a');
      vi.advanceTimersByTime(5_000);
      expect(el.src).toBe(A);
      expect(music.state()).toMatchObject({ playing: true, track: 'a', loaded: 'a' });
    });

    it('a table without music: it fades out and stops, and comes back at a table that has some', () => {
      vi.useFakeTimers();
      const { music, ctx } = setup({}, TRACKS);
      music.enter('a');
      const el = El.all[0]!;
      move(music);
      music.enter('none');
      expect(ctx.gains[0]!.gain.target).toBe(0);
      expect(music.state()).toMatchObject({ track: null, atTable: true });
      vi.advanceTimersByTime(1_500);
      expect(el.paused).toBe(true);
      // Nothing starts it there, whatever goes on at the table.
      for (let k = 0; k < 10; k++) music.enter('none');
      music.sync();
      expect(el.plays).toBe(1);
      // A table opened first with none loads nothing at all.
      const quiet = setup({}, TRACKS);
      const before = El.all.length;
      quiet.music.enter();
      quiet.music.enter('none');
      expect(El.all).toHaveLength(before);
      // On to a table with music again.
      move(music);
      music.enter('b');
      expect(el.src).toBe(B);
      expect(music.state()).toMatchObject({ playing: true, track: 'b' });
    });

    it('a recording that fails to load: that table goes without, the next table’s music still plays, and it is tried again later', () => {
      vi.useFakeTimers();
      const { music } = setup({}, TRACKS);
      music.enter('b');
      const el = El.all[0]!;
      el.fire('error');
      expect(music.state()).toMatchObject({ failed: true, track: 'b' });
      vi.advanceTimersByTime(1_500);
      expect(el.paused).toBe(true);
      // Not tried over and over at the same table.
      for (let k = 0; k < 10; k++) music.enter('b');
      expect(el.plays).toBe(1);
      // Another table, other music: it loads and plays as usual.
      move(music);
      music.enter('a');
      expect(el.src).toBe(A);
      expect(music.state()).toMatchObject({ playing: true, failed: false, track: 'a' });
      // A table opened later (not straight from another) tries the failed one again.
      music.leave();
      vi.advanceTimersByTime(LEAVE_GRACE_MS + 2_000);
      expect(el.paused).toBe(true);
      music.enter();
      music.enter('b');
      expect(el.src).toBe(B);
      expect(music.state()).toMatchObject({ playing: true, failed: false, track: 'b' });
    });

    it('the switch, the volume and mute hold across a change of music', () => {
      vi.useFakeTimers();
      const { music, ctx, settings } = setup({ music: 0.8 }, TRACKS);
      music.enter('a');
      const el = El.all[0]!;
      const fader = ctx.gains[0]!.gain;
      expect(fader.target).toBeCloseTo(MUSIC_TRIM * 0.8);
      music.enter('b');
      vi.advanceTimersByTime(900);
      expect(fader.target).toBeCloseTo(MUSIC_TRIM * 0.8 * 0.8);
      expect(settings).toEqual({ musicOn: true, music: 0.8, muted: false });
      // Muted while a switch is under way: the new recording never starts.
      settings.muted = true;
      music.enter('a');
      music.sync();
      vi.advanceTimersByTime(3_000);
      expect(el.paused).toBe(true);
      const plays = el.plays;
      move(music);
      music.enter('b');
      vi.advanceTimersByTime(3_000);
      expect(el.plays).toBe(plays);
      // Unmuted: the table's music, at the volume kept.
      settings.muted = false;
      music.sync();
      expect(music.state()).toMatchObject({ playing: true, track: 'b' });
      expect(fader.target).toBeCloseTo(MUSIC_TRIM * 0.8 * 0.8);
      // The music turned off: nothing plays at any table.
      settings.musicOn = false;
      music.sync();
      vi.advanceTimersByTime(1_500);
      move(music);
      music.enter('a');
      vi.advanceTimersByTime(3_000);
      expect(el.paused).toBe(true);
    });

    it('a preview away from a table: one recording at a time through the same element, stopped when asked', () => {
      vi.useFakeTimers();
      const { music } = setup({}, TRACKS);
      music.preview('b');
      expect(El.all).toHaveLength(1);
      const el = El.all[0]!;
      expect(el.src).toBe(B);
      expect(music.state()).toMatchObject({ playing: true, atTable: false, track: 'b' });
      // Another choice: the first stops before the second starts.
      music.preview('a');
      expect(el.src).toBe(B);
      vi.advanceTimersByTime(900);
      expect(el.src).toBe(A);
      expect(El.all).toHaveLength(1);
      // The choice that plays nothing, an unknown id, or closing the form: it stops.
      music.preview('none');
      vi.advanceTimersByTime(1_500);
      expect(el.paused).toBe(true);
      music.preview('https://example.com/x.mp3');
      expect(music.state().track).toBeNull();
      music.preview('a');
      expect(music.state().playing).toBe(true);
      music.preview(null);
      vi.advanceTimersByTime(1_500);
      expect(el.paused).toBe(true);
      // A table's own music is not a preview's to change.
      music.enter('a');
      music.preview('b');
      vi.advanceTimersByTime(3_000);
      expect(music.state()).toMatchObject({ playing: true, track: 'a', loaded: 'a' });
    });

    it('a preview asked for in a tab that gave the music to another takes it back', async () => {
      vi.useFakeTimers();
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValue(1_000);
      const a = setup({}, TRACKS);
      a.music.enter('a');
      await vi.advanceTimersByTimeAsync(0);
      a.music.leave();
      await vi.advanceTimersByTimeAsync(10_000);
      now.mockReturnValue(2_000);
      const b = setup({}, TRACKS);
      b.music.enter('a');
      await vi.advanceTimersByTimeAsync(1_500);
      const [elA, elB] = El.all;
      expect(a.music.state()).toMatchObject({ yielded: true, playing: false, atTable: false });
      expect(elB!.paused).toBe(false);
      now.mockReturnValue(3_000);
      a.music.preview('b');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(a.music.state()).toMatchObject({ yielded: false, playing: true, track: 'b' });
      expect(elA!.src).toBe(B);
      expect(elB!.paused).toBe(true);
    });

    it('a preview whose recording failed to load is tried again when asked again', () => {
      vi.useFakeTimers();
      const { music } = setup({}, TRACKS);
      music.preview('b');
      const el = El.all[0]!;
      el.paused = true;
      el.fire('error');
      expect(music.state()).toMatchObject({ failed: true });
      music.preview(null);
      el.src = '';
      music.preview('b');
      expect(music.state()).toMatchObject({ failed: false, playing: true, track: 'b', loaded: 'b' });
      expect(el.src).toBe(B);
    });
  });
});
