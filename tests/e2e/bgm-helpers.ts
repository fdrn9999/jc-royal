import { expect, type Page } from '@playwright/test';

interface M {
  els: HTMLMediaElement[];
  plays: number;
  pauses: number;
  sfx: number;
}

/**
 * Records the table's background music in the page (an init script; the headless browser plays the mp3 itself, muted
 * by its launch): every element a recording is played on, each play() and pause() of it, and the table's other sounds
 * (every source started but the one-sample buffer that unlocks audio).
 */
export function watchBgm() {
  const m: M = { els: [], plays: 0, pauses: 0, sfx: 0 };
  (window as unknown as { __bgm: M }).__bgm = m;
  const { play, pause } = HTMLMediaElement.prototype;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!m.els.includes(this)) m.els.push(this);
    m.plays += 1;
    return play.call(this);
  };
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    m.pauses += 1;
    return pause.call(this);
  };
  for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype] as { start: (...a: number[]) => void }[]) {
    if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
    const start = proto.start;
    proto.start = function (this: AudioScheduledSourceNode, ...a: number[]) {
      if (!(this instanceof AudioBufferSourceNode && (this.buffer?.length ?? 0) <= 1)) m.sfx += 1;
      return start.apply(this, a);
    };
  }
}

/** What the page's music is doing now: the recording playing (its file's name, '' when none plays) and the counts. */
export function bgm(p: Page) {
  return p.evaluate(() => {
    const m = (window as unknown as { __bgm: M }).__bgm;
    const on = m.els.filter((el) => !el.paused && !el.ended);
    const file = (el: HTMLMediaElement | undefined) => (el ? (/^(tournament|black-table-rhythm)/.exec(el.src.split('/').pop() ?? '')?.[1] ?? el.src) : '');
    return { els: m.els.length, playing: on.length, track: file(on[0]), loaded: file(m.els[0]), loop: m.els[0]?.loop ?? false, t: on[0]?.currentTime ?? 0, plays: m.plays, sfx: m.sfx };
  });
}

/** The page plays `track` (and nothing else), its clock running. */
export async function expectPlaying(p: Page, track: 'tournament' | 'black-table-rhythm') {
  await expect.poll(async () => (await bgm(p)).track, { timeout: 30_000 }).toBe(track);
  const a = await bgm(p);
  expect(a).toMatchObject({ playing: 1, els: 1, loop: true });
  await expect.poll(async () => (await bgm(p)).t, { timeout: 15_000 }).toBeGreaterThan(a.t);
}

/** The page plays no music (after the fade any stop takes). */
export async function expectSilent(p: Page) {
  await expect.poll(async () => (await bgm(p)).playing, { timeout: 15_000 }).toBe(0);
}
