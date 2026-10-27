// A table bot's manners after the hand (bot-manners.ts): it shows only a pot it took uncontested, as often as its
// style says (less as its level rises), and reacts rarely — never while reactions are off, one bot per hand, spaced out, never the same twice.
import { BOT_LEVELS, BOT_STYLES, type BotLevel, type BotStyle, type Card } from '@jc/types';
import { describe, expect, it } from 'vitest';
import { BIG_POT_BB, BOT_REACT_GAP_MS, BOT_REACT_HANDS, botManners, emptyManners, MANNERS, MANNERS_LEVEL, showKind, type MannersHand } from './bot-manners';

const c = (s: string) => s.split(' ') as Card[];
const BB = 10;
/** A seeded generator (mulberry32), so a run is the same every time. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Took the pot on the turn with nothing (a bluff that worked), 12 big blinds in.
const bluffWin: MannersHand = { hole: c('7s 4d'), board: c('Kh 9d 2c Qs'), bigBlind: BB, potTotal: 120, net: 60, wentToShowdown: false, shown: false };
const on = { reactionsOn: true, reactedThisHand: false };
const casual = { level: 'normal', style: 'casual' } as const;

/** How often `style` (at `level`) shows and reacts over `n` hands like `h`, each with a fresh memory (no gaps in the way). */
function rates(style: BotStyle, h: MannersHand, n = 4000, level: BotLevel = 'normal') {
  const rand = seeded(7);
  let show = 0;
  let react = 0;
  for (let i = 0; i < n; i++) {
    const m = botManners('b1', { level, style }, h, i, 0, emptyManners(), on, rand);
    if (m.show) show++;
    if (m.reaction) react++;
  }
  return { show: show / n, react: react / n };
}

describe('bot manners after the hand', () => {
  it('tells a bluff and a strong hand from the rest, before and after the flop', () => {
    expect(showKind(c('7s 4d'), c('Kh 9d 2c'))).toBe('bluff');
    expect(showKind(c('Kd Jc'), c('Kh 9d 2c'))).toBe('strong');
    expect(showKind(c('9s 8s'), c('Kh 9d 2c'))).toBeNull();
    expect(showKind(c('7d 2c'), [])).toBe('bluff');
    expect(showKind(c('Ah Ad'), [])).toBe('strong');
    expect(showKind(c('Th 9h'), [])).toBeNull();
  });

  it('never shows a hand the showdown decided, a loss, a walk or a hand in between', () => {
    const never: MannersHand[] = [
      { ...bluffWin, wentToShowdown: true },
      { ...bluffWin, net: -60 },
      { ...bluffWin, shown: true },
      { ...bluffWin, hole: c('7d 2c'), board: [], potTotal: 15, net: 5 },
      { ...bluffWin, hole: c('9s 8s'), board: c('Kh 9d 2c Qs') },
    ];
    for (const style of BOT_STYLES) for (const h of never) expect(rates(style, h, 500).show, `${style} ${JSON.stringify(h)}`).toBe(0);
  });

  it('shows as often as its style says: casual most, tight-passive least', () => {
    const r = Object.fromEntries(BOT_STYLES.map((s) => [s, rates(s, bluffWin)])) as Record<BotStyle, { show: number; react: number }>;
    console.log(`bluff shown: ${BOT_STYLES.map((s) => `${s} ${(r[s].show * 100).toFixed(1)}%`).join(' | ')}`);
    for (const s of BOT_STYLES) expect(r[s].show, s).toBeCloseTo(MANNERS[s].show, 1);
    expect(r.casual.show).toBeGreaterThan(r.lag.show);
    expect(r.lag.show).toBeGreaterThan(r.balanced.show);
    expect(r['tight-passive'].show).toBeLessThan(r.balanced.show);
    // A strong hand is shown less often than a bluff.
    expect(rates('casual', { ...bluffWin, hole: c('Kd Kc') }).show).toBeLessThan(r.casual.show);
  });

  it('holds back as the level rises: an expert shows and reacts least, each style keeping its order', () => {
    const bigWin = { ...bluffWin, hole: c('9s 8s'), potTotal: 600, net: BIG_POT_BB * BB };
    for (const style of ['casual', 'balanced'] as const) {
      const by = Object.fromEntries(BOT_LEVELS.map((l) => [l, { show: rates(style, bluffWin, 6000, l).show, react: rates(style, bigWin, 6000, l).react }]));
      console.log(`${style}: ${BOT_LEVELS.map((l) => `${l} show ${(by[l]!.show * 100).toFixed(1)}% react ${(by[l]!.react * 100).toFixed(1)}%`).join(' | ')}`);
      for (const l of BOT_LEVELS) expect(by[l]!.show, `${style} ${l}`).toBeCloseTo(MANNERS[style].show * MANNERS_LEVEL[l], 1);
      expect(by.easy!.show).toBeGreaterThan(by.expert!.show);
      expect(by.easy!.react).toBeGreaterThan(by.expert!.react);
    }
    // An expert casual still shows more than an easy tight-passive: the style leads.
    expect(rates('casual', bluffWin, 6000, 'expert').show).toBeGreaterThan(rates('tight-passive', bluffWin, 6000, 'easy').show);
  });

  it('reacts only after a big pot or a bluff shown, and never while reactions are off', () => {
    const small = { ...bluffWin, hole: c('9s 8s') };
    expect(rates('casual', small).react).toBe(0);
    const bigWin = { ...bluffWin, hole: c('9s 8s'), potTotal: 600, net: BIG_POT_BB * BB };
    const bigLoss = { ...bluffWin, hole: c('9s 8s'), potTotal: 600, net: -BIG_POT_BB * BB, wentToShowdown: true };
    expect(rates('casual', bigWin).react).toBeGreaterThan(0.1);
    expect(rates('casual', bigLoss).react).toBeGreaterThan(0.1);
    // A big loss it folded out of is not reacted to.
    expect(rates('casual', { ...bigLoss, wentToShowdown: false }).react).toBe(0);
    const rand = seeded(1);
    for (let i = 0; i < 500; i++) {
      const off = botManners('b1', casual, bigWin, i, 0, emptyManners(), { reactionsOn: false, reactedThisHand: false }, rand);
      const second = botManners('b1', casual, bigWin, i, 0, emptyManners(), { reactionsOn: true, reactedThisHand: true }, rand);
      expect(off.reaction).toBeNull();
      expect(second.reaction).toBeNull();
    }
    // The cards are still shown with reactions off: showing is not a reaction.
    expect(Array.from({ length: 500 }, () => botManners('b1', casual, bluffWin, 0, 0, emptyManners(), { reactionsOn: false, reactedThisHand: false }, rand).show).filter(Boolean).length).toBeGreaterThan(0);
  });

  it('keeps reactions apart at the table and for each bot, and never repeats one', () => {
    const bigWin = { ...bluffWin, hole: c('9s 8s'), potTotal: 600, net: 40 * BB };
    const memory = emptyManners();
    const rand = seeded(3);
    const sent: { bot: string; hand: number; at: number; reaction: string }[] = [];
    for (let hand = 0; hand < 3000; hand++) {
      const at = hand * 15_000;
      const bot = `b${hand % 3}`;
      const m = botManners(bot, casual, bigWin, hand, at, memory, on, rand);
      if (m.reaction) sent.push({ bot, hand, at, reaction: m.reaction });
    }
    expect(sent.length).toBeGreaterThan(50);
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(BOT_REACT_GAP_MS);
    for (const bot of ['b0', 'b1', 'b2']) {
      const own = sent.filter((x) => x.bot === bot);
      for (let i = 1; i < own.length; i++) {
        expect(own[i]!.hand - own[i - 1]!.hand).toBeGreaterThanOrEqual(BOT_REACT_HANDS);
        expect(own[i]!.reaction).not.toBe(own[i - 1]!.reaction);
      }
    }
    // Only light ones after a win.
    expect(new Set(sent.map((x) => x.reaction))).toEqual(new Set(['cool', 'fire']));
  });
});
