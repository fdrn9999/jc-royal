import { LENGTH_MS, MAX_VOICES, sound } from '@jc/audio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The sound engine against a recording stand-in for Web Audio: what it schedules, on which node, and whether it ever
 * reads a gain back. Real browsers play it in `docs/TEST_REPORT.md` (후속 개선 7).
 */
class Param {
  calls: [string, ...number[]][] = [];
  reads = 0;
  private v = 1;
  get value() {
    this.reads++;
    return this.v;
  }
  set value(v: number) {
    this.calls.push(['value', v]);
    this.v = v;
  }
  setValueAtTime(v: number, t: number) {
    this.calls.push(['setValueAtTime', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(['linearRampToValueAtTime', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(['exponentialRampToValueAtTime', v, t]);
  }
  setTargetAtTime(v: number, t: number, c: number) {
    this.calls.push(['setTargetAtTime', v, t, c]);
  }
  cancelScheduledValues(t: number) {
    this.calls.push(['cancelScheduledValues', t]);
  }
  cancelAndHoldAtTime(t: number) {
    this.calls.push(['cancelAndHoldAtTime', t]);
  }
}

class Node {
  out: Node | null = null;
  connect(to: Node) {
    this.out = to;
    return to;
  }
}

class Gain extends Node {
  gain = new Param();
}

class Source extends Node {
  starts: number[] = [];
  stops: number[] = [];
  frequency = new Param();
  type = '';
  buffer: unknown = null;
  start(t = 0) {
    this.starts.push(t);
  }
  stop(t = 0) {
    this.stops.push(t);
  }
}

class Ctx {
  static last: Ctx;
  currentTime = 10;
  state = 'running';
  sampleRate = 48000;
  destination = new Node();
  gains: Gain[] = [];
  sources: Source[] = [];
  constructor() {
    Ctx.last = this;
  }
  createGain() {
    const g = new Gain();
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    const s = new Source();
    this.sources.push(s);
    return s;
  }
  createBufferSource() {
    const s = new Source();
    this.sources.push(s);
    return s;
  }
  createBuffer(_ch: number, size: number) {
    const data = new Float32Array(size);
    return { getChannelData: () => data };
  }
  createBiquadFilter() {
    return Object.assign(new Node(), { type: '', frequency: { value: 0 }, Q: { value: 0 } });
  }
  resume() {
    return Promise.resolve();
  }
  addEventListener() {}
  decodeAudioData() {
    return Promise.reject(new Error('no recordings here'));
  }
}

/** The nodes one call to `play` made. */
function played(ctx: Ctx, id: Parameters<typeof sound.play>[0]) {
  const [g, s] = [ctx.gains.length, ctx.sources.length];
  sound.play(id);
  return { gains: ctx.gains.slice(g), sources: ctx.sources.slice(s) };
}

describe('stopping a sound for one that tells the hand', () => {
  let now = 0;
  beforeAll(() => {
    vi.stubGlobal('window', { AudioContext: Ctx, addEventListener() {}, removeEventListener() {} });
    // No recordings: every sound is the synthesized one, whose parts have envelopes.
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false }));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    sound.unlock();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fades the sound’s own fader, reads and cancels no envelope, and keeps a part not started yet from starting', () => {
    const ctx = Ctx.last;
    expect(ctx).toBeTruthy();
    // Six at once: 'flip' (100ms) is the background sound nearest its end, so the win takes its place.
    const flip = played(ctx, 'flip');
    for (const id of ['deal', 'chip', 'check', 'call', 'fold'] as const) played(ctx, id);
    const [bus, ...parts] = flip.gains;
    expect(parts).toHaveLength(2);
    // Every part plays through the sound's fader, and the fader into the effects gain every sound shares.
    const [master, fx] = ctx.gains;
    for (const p of parts) expect(p.out).toBe(bus);
    expect(bus!.out).toBe(fx);
    expect(master!.out).toBe(ctx.destination);
    // Each envelope starts from its first value, not the default 1: the noise at its volume, the tone at 0.
    expect(parts.map((p) => p.gain.calls[0])).toEqual([['value', 0.12], ['value', 0]]);

    // 10ms in: the noise is playing, the tone (20ms in) has not started.
    ctx.currentTime += 0.01;
    now += 1;
    const before = parts.map((p) => p.gain.calls.length);
    const win = played(ctx, 'win');
    expect(win.sources.length).toBeGreaterThan(0);
    const t = ctx.currentTime;
    expect(bus!.gain.calls).toEqual([['setTargetAtTime', 0, t, 0.006]]);
    parts.forEach((p, i) => {
      expect(p.gain.calls.length).toBe(before[i]);
      expect(p.gain.reads).toBe(0);
    });
    const [noise, tone] = flip.sources;
    expect(noise!.stops.at(-1)).toBeCloseTo(t + 0.04, 9);
    expect(tone!.starts[0]).toBeGreaterThan(t);
    expect(tone!.stops.at(-1)).toBe(t);
  });

  it('only the sound whose place is taken is faded; the others play on untouched', () => {
    const ctx = Ctx.last;
    now += Math.max(...Object.values(LENGTH_MS)) + 10;
    ctx.currentTime += 2;
    const ids = ['timer', 'showdown', 'correct', 'wrong', 'complete', 'raise'] as const;
    expect(ids).toHaveLength(MAX_VOICES);
    const sounds = ids.map((id) => played(ctx, id));
    // A seventh that tells the hand: 'raise' (220ms) is the one nearest its end, none being background.
    now += 1;
    ctx.currentTime += 0.001;
    played(ctx, 'call');
    sounds.forEach((s, i) => {
      expect(s.gains[0]!.gain.calls).toEqual(ids[i] === 'raise' ? [['setTargetAtTime', 0, ctx.currentTime, 0.006]] : []);
      for (const g of s.gains) expect(g.gain.reads).toBe(0);
    });
  });
});
