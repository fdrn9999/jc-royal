import type { Card, HandReplayPlayer } from '@jc/types';
import { formatBB, formatChips } from '@jc/ui';
import { describe, expect, it } from 'vitest';
import { buildReplay, type ReplayInput, type ReplayLinePart } from '../src/game/replay';
import { DEFAULT_PALETTE, drawShare, type ShareBox } from '../src/game/shareDraw';
import { SHARE_DEFAULTS, SHARE_RATIOS, SHARE_SIZES, SHARE_TEMPLATES, shareFileName, shareSnap, type ShareOptions, type ShareSnap } from '../src/game/shareSnap';
import type { MsgKey } from '../src/lib/i18n';
import { en } from '../src/lib/i18n-en';

const t = (k: MsgKey, vars?: Record<string, string | number>) => en[k].replace(/\{(\w+)\}/g, (_, v: string) => String(vars?.[v] ?? `{${v}}`));
const say = (x: ReplayLinePart, name: (seat: number) => string) => {
  if (x.kind === 'deal') return 'Cards dealt';
  if (x.kind === 'board') return `Board ${x.cards.join(' ')}`;
  if (x.kind === 'shows') return `${name(x.seat)} shows ${x.rankClass}`;
  if (x.kind === 'wins') return `${name(x.seat)} wins ${formatChips(x.amount)}`;
  return `${name(x.seat)} ${x.type} ${formatChips(x.amount)}`;
};
const snapOf = (hand: ReplayInput, hero: number | null, index: number) => shareSnap({ hand, steps: buildReplay(hand, hero), index, heroSeat: hero, say, fmt: formatChips, t });

const a = (seatIndex: number, stage: string, type: string, amount = 0) => ({ seatIndex, stage, type, amount });
const DECK = ['As', 'Ad', 'Kh', 'Kc', 'Qs', 'Qd', 'Jh', 'Jc', 'Ts', 'Td', '9h', '9c', '8s', '8d', '7h', '7c', '6s', '6d'] as const;
const BOARD = ['2h', '5c', '3d', '4s', 'Ah'];
const LONG = ['포커왕김철수포커왕김철수', 'MaximilianLongnameTheThird', '아주아주긴닉네임플레이어', 'W'.repeat(24), '가나다라마바사아자차카타', 'NobodyFoldsHereEverEver', '한글English섞인긴이름123', 'ZZZZZZZZZZZZZZZZZZZZ', '마지막으로긴닉네임입니다'];

/**
 * `n` players, button 0, everyone calls the big blind and checks it down; at the showdown every hand but the mucked
 * ones is face up. `split` splits the pot between seats 0 and 1 (or the first `split` seats), otherwise seat 0 wins it;
 * with `ownBest` each hand's best five holds its own two cards.
 */
function table(n: number, o: { bb?: number; split?: boolean | number; mucked?: number[]; long?: boolean; role?: boolean; ownBest?: boolean } = {}): ReplayInput {
  const bb = o.bb ?? 10;
  const sb = bb / 2;
  const sbSeat = n === 2 ? 0 : 1;
  const bbSeat = n === 2 ? 1 : 2;
  const pre = [a(sbSeat, 'preflop', 'post-sb', sb), a(bbSeat, 'preflop', 'post-bb', bb)];
  const order = Array.from({ length: n }, (_, k) => (bbSeat + 1 + k) % n);
  for (const s of order) if (s !== bbSeat) pre.push(a(s, 'preflop', 'call', s === sbSeat ? bb - sb : bb));
  pre.push(a(bbSeat, 'preflop', 'check'));
  const post = (['flop', 'turn', 'river'] as const).flatMap((st) => Array.from({ length: n }, (_, k) => a((sbSeat + k) % n, st, 'check')));
  const pot = n * bb;
  const ways = o.split === true ? 2 : o.split || 1;
  const winners = Array.from({ length: ways }, (_, s) => ({ seatIndex: s, amount: pot / ways }));
  const players: HandReplayPlayer[] = Array.from({ length: n }, (_, s) => {
    const shown = !o.mucked?.includes(s);
    const hole = [DECK[2 * s]!, DECK[2 * s + 1]!];
    const won = winners.find((w) => w.seatIndex === s)?.amount ?? 0;
    return {
      seatIndex: s,
      nickname: o.long ? LONG[s]! : `p${s}`,
      ...(o.role && s === 1 ? { role: 'admin' as const } : {}),
      ...(s === n - 1 && n > 2 ? { bot: true as const } : {}),
      holeCards: shown ? hole : null,
      stackStart: bb * 1000,
      net: won - bb,
      won,
      rankClass: shown ? 'straight' : null,
      bestFive: shown ? (o.ownBest ? [...hole, 'Ah', '2h', '3d'] : ['Ah', '2h', '3d', '4s', '5c']) : null,
    };
  });
  return { id: `t${n}`, tableName: 'T', handNumber: 12345, board: BOARD, potTotal: pot, smallBlind: sb, bigBlind: bb, maxSeats: n, buttonSeat: 0, pots: [{ amount: pot, eligibleSeats: players.map((p) => p.seatIndex), winners, uncalled: false }], returned: null, actions: [...pre, ...post], players };
}

/** Raise, and everyone folds to it: no showdown, nobody's cards but the viewer's. */
function foldOut(): ReplayInput {
  return {
    id: 'f',
    tableName: 'T',
    handNumber: 99,
    board: [],
    potTotal: 450,
    smallBlind: 50,
    bigBlind: 100,
    maxSeats: 6,
    buttonSeat: 0,
    pots: [
      { amount: 250, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 250 }], uncalled: false },
      { amount: 200, eligibleSeats: [0], winners: [{ seatIndex: 0, amount: 200 }], uncalled: true },
    ],
    returned: { seatIndex: 0, amount: 200 },
    actions: [a(1, 'preflop', 'post-sb', 50), a(2, 'preflop', 'post-bb', 100), a(0, 'preflop', 'raise', 300), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold')],
    // The record holds every player's cards; the replay shows only the viewer's (seat 1) and none of the folded others'.
    players: [0, 1, 2].map((s) => ({ seatIndex: s, nickname: `p${s}`, holeCards: [DECK[2 * s]!, DECK[2 * s + 1]!], stackStart: 10_000, net: s === 0 ? 150 : -50 * s, won: s === 0 ? 450 : 0, rankClass: null, bestFive: null })),
  };
}

/**
 * The line the brief draws: 6 seats, blinds 50/100, the viewer (seat 0) on the button. UTG and HJ fold, CO raises to
 * 250, the viewer 3-bets to 800, the blinds fold, CO 4-bets to 2,000 (putting in 1,750) and the viewer calls 1,200; on
 * the flop CO checks, the viewer bets 2,000 and CO calls; on the turn CO checks and the viewer is all in for 6,000,
 * called; the river is dealt to the showdown, where the viewer's kings beat CO's queens.
 */
function brief(): ReplayInput {
  const hole = [['As', 'Ks'], ['4h', '4c'], ['5h', '5d'], ['6s', '6d'], ['8s', '8d'], ['Qh', 'Qd']];
  const net = [10_150, -50, -100, 0, 0, -10_000];
  return {
    id: 'brief',
    tableName: 'T',
    handNumber: 777,
    board: ['Kh', '7s', '2d', 'Jc', '3s'],
    potTotal: 20_150,
    smallBlind: 50,
    bigBlind: 100,
    maxSeats: 6,
    buttonSeat: 0,
    pots: [{ amount: 20_150, eligibleSeats: [0, 5], winners: [{ seatIndex: 0, amount: 20_150 }], uncalled: false }],
    returned: null,
    actions: [
      ...[a(1, 'preflop', 'post-sb', 50), a(2, 'preflop', 'post-bb', 100), a(3, 'preflop', 'fold'), a(4, 'preflop', 'fold'), a(5, 'preflop', 'raise', 250)],
      ...[a(0, 'preflop', 'raise', 800), a(1, 'preflop', 'fold'), a(2, 'preflop', 'fold'), a(5, 'preflop', 'raise', 1750), a(0, 'preflop', 'call', 1200)],
      ...[a(5, 'flop', 'check'), a(0, 'flop', 'bet', 2000), a(5, 'flop', 'call', 2000)],
      ...[a(5, 'turn', 'check'), a(0, 'turn', 'allin', 6000), a(5, 'turn', 'call', 6000)],
    ],
    players: hole.map((h, s) => ({
      seatIndex: s,
      nickname: `p${s}`,
      holeCards: h,
      stackStart: 10_000,
      net: net[s]!,
      won: s === 0 ? 20_150 : 0,
      rankClass: s === 0 || s === 5 ? 'pair' : null,
      bestFive: s === 0 ? ['Ks', 'Kh', 'As', 'Jc', '7s'] : s === 5 ? ['Qh', 'Qd', 'Kh', 'Jc', '7s'] : null,
    })),
  };
}

/**
 * A short stack all in preflop: seat 2 (500 behind) 3-bets all in over seat 0's raise to 300, both others call; seat 0
 * bets 1,000 on the flop into seat 1, who calls; it is checked down. Seat 2's queens take the main pot (1,500), seat 0's
 * aces the side pot (2,000); seat 1 mucks its kings.
 */
function sidePot(): ReplayInput {
  const hole = [['As', 'Ad'], ['Kh', 'Kc'], ['Qs', 'Qd']];
  return {
    id: 'side',
    tableName: 'T',
    handNumber: 778,
    board: ['Qh', '7c', '2d', '9s', '3c'],
    potTotal: 3500,
    smallBlind: 50,
    bigBlind: 100,
    maxSeats: 6,
    buttonSeat: 0,
    pots: [
      { amount: 1500, eligibleSeats: [0, 1, 2], winners: [{ seatIndex: 2, amount: 1500 }], uncalled: false },
      { amount: 2000, eligibleSeats: [0, 1], winners: [{ seatIndex: 0, amount: 2000 }], uncalled: false },
    ],
    returned: null,
    actions: [
      ...[a(1, 'preflop', 'post-sb', 50), a(2, 'preflop', 'post-bb', 100), a(0, 'preflop', 'raise', 300), a(1, 'preflop', 'call', 250), a(2, 'preflop', 'allin', 400), a(0, 'preflop', 'call', 200), a(1, 'preflop', 'call', 200)],
      ...[a(1, 'flop', 'check'), a(0, 'flop', 'bet', 1000), a(1, 'flop', 'call', 1000)],
      ...[a(1, 'turn', 'check'), a(0, 'turn', 'check'), a(1, 'river', 'check'), a(0, 'river', 'check')],
    ],
    players: hole.map((h, s) => ({
      seatIndex: s,
      nickname: `p${s}`,
      holeCards: h,
      stackStart: s === 2 ? 500 : 10_000,
      net: [500, -1500, 1000][s]!,
      won: [2000, 0, 1500][s]!,
      rankClass: s === 2 ? 'three-of-a-kind' : 'pair',
      bestFive: s === 2 ? ['Qs', 'Qd', 'Qh', '9s', '7c'] : s === 0 ? ['As', 'Ad', 'Qh', '9s', '7c'] : ['Kh', 'Kc', 'Qh', '9s', '7c'],
      ...(s === 1 ? { mucked: true } : {}),
    })),
  };
}

/**
 * A 2D context that draws nothing and measures text by its length: wide letters (Hangul) as an em, capitals as `upper`,
 * the rest as `latin` (0.55 em by default; the bold faces the image uses run wider, `WIDE`).
 */
function fakeCtx(m: { latin: number; upper: number } = { latin: 0.55, upper: 0.55 }) {
  const state: Record<string, unknown> = { font: '600 20px sans-serif', globalAlpha: 1 };
  const gradient = { addColorStop() {} };
  const em = (ch: string) => (ch.codePointAt(0)! >= 0x1100 && ch !== '·' && ch !== '…' ? 1 : /[A-Z]/.test(ch) ? m.upper : m.latin);
  const methods: Record<string, unknown> = {
    measureText(s: string) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 20);
      const w = Array.from(s).reduce((x, ch) => x + em(ch), 0) * size;
      return { width: w, actualBoundingBoxAscent: 0.7 * size, actualBoundingBoxDescent: 0.2 * size };
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  return new Proxy(state, {
    get: (s, k: string) => (k in methods ? methods[k] : k in s ? s[k] : () => {}),
    set: (s, k: string, v) => {
      s[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const WIDE = { latin: 0.64, upper: 0.82 };

function draw(snap: ShareSnap, opt: Partial<ShareOptions> = {}, ctx = fakeCtx()) {
  const o = { ...SHARE_DEFAULTS, ...opt };
  const boxes: ShareBox[] = [];
  drawShare(ctx, snap, o, { pal: DEFAULT_PALETTE, logo: null }, boxes);
  return { boxes, ...SHARE_SIZES[o.ratio] };
}

const EPS = 0.5;
const overlap = (p: ShareBox, q: ShareBox) => p.x + EPS < q.x + q.w && q.x + EPS < p.x + p.w && p.y + EPS < q.y + q.h && q.y + EPS < p.y + p.h;
/** What is wrong with a drawing: pieces past the image's edge, pieces of different groups over one another. */
function faults({ boxes, w, h }: ReturnType<typeof draw>) {
  const out: string[] = [];
  for (const b of boxes) {
    if (b.x < -EPS || b.y < -EPS || b.x + b.w > w + EPS || b.y + b.h > h + EPS) out.push(`${b.id} leaves the image (${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)})`);
    if (!(b.w > 0 && b.h > 0)) out.push(`${b.id} has no size`);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i]!;
      const q = boxes[j]!;
      if (p.group !== q.group && overlap(p, q)) out.push(`${p.id} (${p.group}) over ${q.id} (${q.group})`);
    }
  return out;
}
const faces = (boxes: ShareBox[]) => boxes.filter((b) => b.kind === 'card' && b.card).map((b) => b.card as Card);

describe('the share image shows only what the replay step shows', () => {
  it("shows nobody's cards but the viewer's before the showdown, whatever the record holds", () => {
    const hand = table(6);
    const steps = buildReplay(hand, 2);
    const showdown = steps.findIndex((s) => s.kind === 'showdown');
    for (let k = 0; k < showdown; k++) {
      const snap = snapOf(hand, 2, k);
      for (const s of snap.seats) expect(s.cards.filter(Boolean)).toEqual(s.hero ? [DECK[4], DECK[5]] : []);
      for (const tpl of SHARE_TEMPLATES) {
        const shown = faces(draw(snap, { template: tpl }).boxes);
        expect(shown.every((c) => c === DECK[4] || c === DECK[5] || snap.board.includes(c))).toBe(true);
      }
    }
  });

  it('keeps a mucked hand face down at the showdown, and a fold-ended hand shows only the viewer\'s cards', () => {
    const hand = table(6, { mucked: [3, 4] });
    const steps = buildReplay(hand, 0);
    const sd = snapOf(hand, 0, steps.findIndex((s) => s.kind === 'showdown'));
    for (const s of sd.seats.filter((x) => x.seat === 3 || x.seat === 4)) expect(s.cards).toEqual([null, null]);
    const mucked = new Set<string>([DECK[6], DECK[7], DECK[8], DECK[9]]);
    for (const tpl of SHARE_TEMPLATES) for (const r of SHARE_RATIOS) expect(faces(draw(sd, { template: tpl, ratio: r }).boxes).filter((c) => mucked.has(c))).toEqual([]);

    const f = foldOut();
    const end = snapOf(f, 1, buildReplay(f, 1).length - 1);
    expect(end.seats.find((s) => s.seat === 0)!.cards).toEqual([null, null]);
    expect(end.winners).toEqual([0]);
    for (const tpl of SHARE_TEMPLATES) {
      const shown = faces(draw(end, { template: tpl }).boxes);
      expect(shown.every((c) => c === DECK[2] || c === DECK[3])).toBe(true);
      expect(shown).not.toContain(DECK[0]);
      expect(shown).not.toContain(DECK[4]);
    }
  });

  it('takes nothing from a later step: the board, the hands, the wins and the actions are those up to it', () => {
    const hand = table(3);
    const steps = buildReplay(hand, 0);
    const flop = steps.findIndex((s) => s.kind === 'street');
    const snap = snapOf(hand, 0, flop);
    expect(snap.phase).toBe('flop');
    expect(snap.board).toEqual(BOARD.slice(0, 3));
    expect(snap.winners).toEqual([]);
    expect(snap.seats.every((s) => s.rank === null && s.win === null)).toBe(true);
    expect(snap.log.map((e) => e.phase)).toEqual(['preflop']);
    for (const tpl of SHARE_TEMPLATES) {
      const shown = faces(draw(snap, { template: tpl }).boxes);
      expect(shown).not.toContain('4s');
      expect(shown).not.toContain('Ah');
      const words = draw(snap, { template: tpl }).boxes.map((b) => b.text ?? '').join(' ');
      expect(words).not.toMatch(/wins|shows|straight/i);
    }
  });

  it('keeps the step it was taken at: a snapshot is plain data the replay moving on does not touch', () => {
    const hand = table(2);
    const steps = buildReplay(hand, 0);
    const snap = shareSnap({ hand, steps, index: steps.findIndex((s) => s.kind === 'street') - 1, heroSeat: 0, say, fmt: formatChips, t });
    const before = JSON.stringify(snap);
    shareSnap({ hand, steps, index: steps.length - 1, heroSeat: 0, say, fmt: formatChips, t });
    expect(JSON.stringify(snap)).toBe(before);
    expect(snap.phaseFile).toBe('Preflop');
  });

  it('names the file by the hand and the part of it, nothing about who played', () => {
    const hand = table(6, { long: true });
    const steps = buildReplay(hand, 0);
    expect(shareFileName(snapOf(hand, 0, steps.length - 1), 'png')).toBe('JC-ROYAL_Hand-12345_Result.png');
    expect(shareFileName(snapOf(hand, 0, steps.findIndex((s) => s.kind === 'showdown')), 'webp')).toBe('JC-ROYAL_Hand-12345_Showdown.webp');
    expect(shareFileName({ handNumber: Number.NaN, phaseFile: 'Flop' }, 'png')).toBe('JC-ROYAL_Hand-0_Flop.png');
  });

  it("carries a VIP member's color from the record to the replay's seats and the image, with the name only", () => {
    const hand = table(3);
    hand.players[0] = { ...hand.players[0]!, vip: 'rose' };
    // The server never sends both; were it to, the staff mark wins (as at the table).
    hand.players[1] = { ...hand.players[1]!, role: 'admin', vip: 'gold' };
    const steps = buildReplay(hand, 1);
    expect(steps.every((s) => s.view.seats[0]!.vip === 'rose')).toBe(true);
    expect('vip' in steps[0]!.view.seats[2]!).toBe(false);
    const snap = snapOf(hand, 1, steps.length - 1);
    expect(snap.seats.map((s) => [s.seat, s.vip ?? null, s.role ?? null])).toEqual([
      [0, 'rose', null],
      [1, null, 'admin'],
      [2, null, null],
    ]);
    for (const tpl of SHARE_TEMPLATES) {
      const marks = (names: boolean) => draw(snap, { template: tpl, names }).boxes.filter((b) => b.id.endsWith('-mark')).length;
      // With the names off, no mark is left to tell who a seat was.
      expect(marks(false)).toBe(0);
      if (tpl === 'classic') expect(marks(true)).toBeGreaterThanOrEqual(2);
    }
  });

  it("marks a table bot with the robot in front of its name, square on the name's line, and nobody else; no BOT text", () => {
    const hand = table(6, { long: true });
    const none = table(6, { long: true });
    for (const p of none.players) delete p.bot;
    const snap = snapOf(hand, 0, buildReplay(hand, 0).length - 1);
    const plain = snapOf(none, 0, buildReplay(none, 0).length - 1);
    expect(snap.seats.filter((s) => s.bot).map((s) => s.seat)).toEqual([5]);
    // A bot is no one's identity: its mark stays with the names off, as the seat's label does.
    for (const tpl of SHARE_TEMPLATES)
      for (const names of [true, false]) {
        const { boxes } = draw(snap, { template: tpl, names });
        expect(boxes.some((b) => /\bBOT\b/.test(b.text ?? ''))).toBe(false);
        const bots = boxes.filter((b) => b.id.endsWith('-bot'));
        if (tpl === 'classic') expect(bots.map((b) => b.id)).toContain('name-5-bot');
        for (const m of bots) {
          const name = boxes.find((b) => b.id === m.id.slice(0, -'-bot'.length))!;
          expect(m.w).toBeCloseTo(m.h);
          expect(m.x + m.w).toBeLessThanOrEqual(name.x + EPS);
          expect(Math.abs(m.y + m.h / 2 - (name.y + name.h / 2))).toBeLessThan(1.5);
        }
        expect(draw(plain, { template: tpl, names }).boxes.filter((b) => b.id.endsWith('-bot'))).toEqual([]);
      }
  });

  it('says "You" and "Seat 3" with the names off, in the lines too', () => {
    const hand = table(3, { long: true });
    const steps = buildReplay(hand, 1);
    const snap = snapOf(hand, 1, steps.length - 1);
    expect(snap.seats.map((s) => s.label)).toEqual(['Seat 1', 'You', 'Seat 3']);
    const anon = snap.log.flatMap((e) => e.lines.map((l) => l.anon)).join(' ');
    for (const n of LONG.slice(0, 3)) expect(anon).not.toContain(n);
    for (const tpl of SHARE_TEMPLATES) {
      const words = draw(snap, { template: tpl, names: false }).boxes.map((b) => b.text ?? '').join(' ');
      for (const n of LONG.slice(0, 3)) expect(words).not.toContain(n.slice(0, 6));
    }
  });
});

describe('every template at every ratio lays out without cutting or covering', () => {
  const cases: [string, ReplayInput, number | null][] = [
    ['2 seats', table(2), 0],
    ['6 seats', table(6), 3],
    ['9 seats', table(9), 4],
    ['9 seats, long names, big pot', table(9, { long: true, bb: 2_000_000, role: true }), 0],
    ['6 seats, split pot', table(6, { split: true, long: true }), 1],
    ['fold-ended', foldOut(), 1],
    ['spectator', table(6), null],
    ['3-bet, 4-bet and all in', brief(), 0],
    ['side pot, a muck', sidePot(), 0],
  ];
  /** The faults of every template at every ratio, with the options on and off, at the start, flop, showdown and end. */
  const layoutFaults = (hand: ReplayInput, hero: number | null, measure?: typeof WIDE) => {
    const steps = buildReplay(hand, hero);
    const at = [0, steps.findIndex((s) => s.kind === 'street'), steps.findIndex((s) => s.kind === 'showdown'), steps.length - 1].filter((k) => k >= 0);
    const out: string[] = [];
    for (const k of at) {
      const snap = snapOf(hand, hero, k);
      for (const tpl of SHARE_TEMPLATES)
        for (const r of SHARE_RATIOS)
          for (const o of [{}, { names: false, log: false, winAmount: false, background: 'plain' as const }]) {
            const d = draw(snap, { template: tpl, ratio: r, ...o }, fakeCtx(measure));
            expect(d.boxes.length).toBeGreaterThan(3);
            out.push(...faults(d).map((f) => `${snap.phase} ${tpl} ${r}${Object.keys(o).length ? ' (off)' : ''}: ${f}`));
          }
    }
    return out.slice(0, 20);
  };
  for (const [name, hand, hero] of cases) it(name, () => expect(layoutFaults(hand, hero)).toEqual([]));

  // Letters as wide as the bold faces' make the long lines take their fallbacks: a line cut to fit, a winner a line.
  const four = table(9, { long: true, bb: 2_000_000, role: true, split: 4, ownBest: true });
  it('in wider letters: 9 seats, four winners, long names, big pot', () => expect(layoutFaults(four, 0, WIDE)).toEqual([]));
  it('in wider letters: 6 seats, split pot, long names', () => expect(layoutFaults(table(6, { split: true, long: true }), 1, WIDE)).toEqual([]));

  it("lights each winner's own best five, no loser's, and shows every winner's win, with four winners", () => {
    const steps = buildReplay(four, 0);
    const snap = snapOf(four, 0, steps.length - 1);
    expect(snap.winners).toEqual([0, 1, 2, 3]);
    const hole = (s: number) => [DECK[2 * s]!, DECK[2 * s + 1]!] as Card[];
    const won = new Set([0, 1, 2, 3].flatMap(hole));
    const lost = new Set([4, 5, 6, 7, 8].flatMap(hole));
    const each = four.pots[0]!.winners[0]!.amount;
    const out: string[] = [];
    for (const tpl of SHARE_TEMPLATES)
      for (const r of SHARE_RATIOS) {
        const { boxes } = draw(snap, { template: tpl, ratio: r }, fakeCtx(WIDE));
        const cs = boxes.filter((b) => b.kind === 'card' && b.card);
        for (const b of cs) {
          if (won.has(b.card!) && !b.lit) out.push(`${tpl} ${r}: ${b.id} (${b.card}) of a winner is not lit`);
          if (lost.has(b.card!) && b.lit) out.push(`${tpl} ${r}: ${b.id} (${b.card}) of a loser is lit`);
        }
        // Every winner's amount, in full or short; the four are the same here, so each must show four times at least.
        const amounts = boxes.filter((b) => b.text === formatChips(each) || b.text === formatChips(each, true));
        if (amounts.length < 4) out.push(`${tpl} ${r}: ${amounts.length} of the 4 wins shown`);
      }
    expect(out.slice(0, 20)).toEqual([]);
  });

  it('the check itself finds a piece past the edge and pieces of two groups over one another', () => {
    const box = (id: string, group: string, x: number, y: number): ShareBox => ({ id, group, kind: 'text', x, y, w: 100, h: 40 });
    expect(faults({ boxes: [box('a', 'g1', 0, 0), box('b', 'g1', 50, 10)], w: 1080, h: 1080 })).toEqual([]);
    expect(faults({ boxes: [box('a', 'g1', 0, 0), box('b', 'g2', 50, 10)], w: 1080, h: 1080 })).toEqual(['a (g1) over b (g2)']);
    expect(faults({ boxes: [box('a', 'g1', 1000, 0)], w: 1080, h: 1080 })).toHaveLength(1);
    // A real drawing has several groups to keep apart.
    const groups = new Set(draw(snapOf(table(9), 0, buildReplay(table(9), 0).length - 1)).boxes.map((b) => b.group));
    expect(groups.size).toBeGreaterThan(4);
  });

  it('shows the win and the amount at the payout, the split as such, and no amount with it off', () => {
    const hand = table(6, { split: true });
    const steps = buildReplay(hand, 0);
    const snap = snapOf(hand, 0, steps.length - 1);
    expect(snap.winners).toEqual([0, 1]);
    for (const tpl of ['summary', 'highlight'] as const) {
      const on = draw(snap, { template: tpl }).boxes.map((b) => b.text ?? '').join(' ');
      expect(on).toContain('30');
      const off = draw(snap, { template: tpl, winAmount: false }).boxes.map((b) => b.text ?? '');
      expect(off.some((x) => x.includes('+30'))).toBe(false);
    }
  });
});

describe('the betting line image', () => {
  const texts = (boxes: ShareBox[]) => new Map(boxes.flatMap((b) => (b.text === undefined ? [] : [[b.id, b.text] as const])));
  const all = (boxes: ShareBox[]) => boxes.map((b) => b.text ?? '').join(' ');
  /** The rows drawn, as "street:index" ("sd:index" at the showdown). */
  const drawn = (boxes: ShareBox[]) =>
    new Set(
      boxes.flatMap((b) => {
        const m = /^line-(\d+|sd)-(\d+)-name$/.exec(b.id);
        return m ? [`${m[1] === 'sd' ? -1 : m[1]}:${m[2]}`] : [];
      }),
    );
  /** How many rows the image says it left out. */
  const left = (boxes: ShareBox[]) => sumOf(boxes.filter((b) => b.id.startsWith('line-omit-')).map((b) => Number(/\d+/.exec(b.text ?? '')?.[0] ?? NaN)));
  const sumOf = (xs: number[]) => xs.reduce((p, q) => p + q, 0);
  const rowsOf = (snap: ShareSnap) => sumOf(snap.streets.map((st) => st.acts.length)) + (snap.showdown?.length ?? 0);

  it('reads the hand street by street: what each action was, at what amount, each street’s cards and the pot it began with', () => {
    const hand = brief();
    const steps = buildReplay(hand, 0);
    const snap = snapOf(hand, 0, steps.length - 1);
    const { boxes } = draw(snap, { template: 'betline' });
    const tx = texts(boxes);
    const row = (id: string) => ['pos', 'word-0', 'amt'].map((k) => tx.get(`${id}-${k}`) ?? null);
    // A raise reads as what it raised to: CO's 4-bet to 2,000, not the 1,750 it put in; a call as what it put in.
    expect(row('line-0-2')).toEqual(['UTG', 'Fold', null]);
    expect(row('line-0-4')).toEqual(['CO', 'Raise', '250']);
    expect(row('line-0-5')).toEqual(['BTN', '3-Bet', '800']);
    expect(row('line-0-8')).toEqual(['CO', '4-Bet', '2,000']);
    expect(row('line-0-9')).toEqual(['BTN', 'Call', '1,200']);
    expect(row('line-1-0')).toEqual(['CO', 'Check', null]);
    expect(row('line-1-1')).toEqual(['BTN', 'Bet', '2,000']);
    expect(row('line-2-1')).toEqual(['BTN', 'All-in', '6,000']);
    // A call of a player's last chips is an all-in too.
    expect(row('line-2-2')).toEqual(['CO', 'All-in', '6,000']);
    const dealt = (at: number) => boxes.filter((b) => new RegExp(`^line-head-${at}-\\d+-card-`).test(b.id)).map((b) => b.card);
    expect([0, 1, 2, 3].map(dealt)).toEqual([[], ['Kh', '7s', '2d'], ['Jc'], ['3s']]);
    const pot = (at: number) => boxes.find((b) => new RegExp(`^line-head-${at}-\\d+-pot-1$`).test(b.id))?.text;
    expect([1, 2, 3].map(pot)).toEqual(['4,150', '8,150', '20,150']);
    // The showdown's hands, then the payout: the pot and, smaller than the win, the viewer's own result.
    expect(boxes.filter((b) => b.id.startsWith('line-sd-') && b.card).map((b) => b.card)).toEqual(['As', 'Ks', 'Qh', 'Qd']);
    const net = boxes.find((b) => b.text === '+10,150');
    const win = boxes.find((b) => b.id.startsWith('result-win') && b.text === '20,150');
    expect(net && win && net.h < win.h).toBe(true);
    expect(faults({ boxes, ...SHARE_SIZES['1:1'] })).toEqual([]);
  });

  it('reads amounts in big blinds by the hand’s own blinds', () => {
    const hand = brief();
    const steps = buildReplay(hand, 0);
    const snap = shareSnap({ hand, steps, index: steps.length - 1, heroSeat: 0, say, fmt: (n, c) => formatBB(n, 100, c), t });
    const tx = texts(draw(snap, { template: 'betline' }).boxes);
    expect(['line-0-4-amt', 'line-0-5-amt', 'line-0-8-amt', 'line-0-9-amt'].map((id) => tx.get(id))).toEqual(['2.5 BB', '8 BB', '20 BB', '12 BB']);
  });

  it('says nothing of what came after its step: no later street, action, hand or result', () => {
    const hand = brief();
    const steps = buildReplay(hand, 0);
    const flop = steps.findIndex((s) => s.kind === 'street' && s.stage === 'flop');
    const showdown = steps.findIndex((s) => s.kind === 'showdown');
    for (const r of SHARE_RATIOS) {
      const { boxes } = draw(snapOf(hand, 0, flop), { template: 'betline', ratio: r });
      const words = all(boxes);
      for (const later of ['Turn', 'River', 'All-in', '6,000', 'Showdown', 'My net', '20,150']) expect(words, `${r}: ${later}`).not.toContain(later);
      expect(faces(boxes).filter((c) => ['Jc', '3s', 'Qh', 'Qd'].includes(c))).toEqual([]);
      // Before the showdown nobody's cards but the viewer's, at any step.
      for (let k = 0; k < showdown; k++) expect(faces(draw(snapOf(hand, 0, k), { template: 'betline', ratio: r }).boxes).filter((c) => c === 'Qh' || c === 'Qd')).toEqual([]);
    }
  });

  it('shows the side pots and who took each, the short stack’s all-in raise, and a muck as a muck', () => {
    const hand = sidePot();
    const steps = buildReplay(hand, 0);
    const snap = snapOf(hand, 0, steps.length - 1);
    for (const r of SHARE_RATIOS) {
      const { boxes } = draw(snap, { template: 'betline', ratio: r }, fakeCtx(WIDE));
      const tx = texts(boxes);
      const words = all(boxes);
      expect(words).toContain('Main pot');
      expect(words).toContain('Side pot 1');
      expect([tx.get('line-0-4-word-0'), tx.get('line-0-4-amt')]).toEqual(['All-in', '500']);
      expect([...tx].some(([id, x]) => id.startsWith('line-sd-') && x === 'Muck')).toBe(true);
      expect(faces(boxes).filter((c) => c === 'Kh' || c === 'Kc')).toEqual([]);
    }
  });

  it('ends a hand nobody called with the raise, the folds and the bet handed back, and no showdown', () => {
    const hand = foldOut();
    const steps = buildReplay(hand, 1);
    const { boxes } = draw(snapOf(hand, 1, steps.length - 1), { template: 'betline' });
    const tx = texts(boxes);
    expect([tx.get('line-0-2-word-0'), tx.get('line-0-2-amt')]).toEqual(['Raise', '300']);
    expect([tx.get('line-0-3-word-0'), tx.get('line-0-4-word-0')]).toEqual(['Fold', 'Fold']);
    expect(boxes.some((b) => b.id.startsWith('line-sd') || b.id.startsWith('line-head--1'))).toBe(false);
    expect(all(boxes)).toContain('Uncalled bet returned');
    expect(all(boxes)).toContain('No showdown');
  });

  it('leaves out the least telling actions where the line does not fit, says how many, and keeps every one of the viewer’s', () => {
    const hand = table(9, { long: true });
    const steps = buildReplay(hand, 4);
    const snap = snapOf(hand, 4, steps.length - 1);
    const mine = [...snap.streets.flatMap((st, at) => st.acts.flatMap((x, j) => (x.hero ? [`${at}:${j}`] : []))), ...(snap.showdown ?? []).flatMap((x, j) => (x.seat === 4 ? [`-1:${j}`] : []))];
    expect(mine.length).toBe(5);
    for (const r of SHARE_RATIOS) {
      const { boxes } = draw(snap, { template: 'betline', ratio: r }, fakeCtx(WIDE));
      const rows = drawn(boxes);
      expect(rows.size + left(boxes), r).toBe(rowsOf(snap));
      for (const k of mine) expect(rows.has(k), `${r}: ${k}`).toBe(true);
      if (r === '1:1') expect(left(boxes)).toBeGreaterThan(0);
    }
  });

  it('splits a line too long for one column between whole streets, the two columns as near the same height as they go', () => {
    const out: string[] = [];
    let two = 0;
    const cases: [string, ReplayInput, number][] = [
      ['9 seats, long names', table(9, { long: true }), 4],
      ['6 seats, a muck', table(6, { mucked: [5] }), 3],
      ['3-bet, 4-bet and all in', brief(), 0],
      ['side pots', sidePot(), 0],
    ];
    for (const [name, hand, hero] of cases)
      for (const r of SHARE_RATIOS)
        for (const m of [undefined, WIDE]) {
          const steps = buildReplay(hand, hero);
          const { boxes } = draw(snapOf(hand, hero, steps.length - 1), { template: 'betline', ratio: r }, fakeCtx(m));
          // Each street's column (by its heading) and the height its rows take.
          const heads = boxes.flatMap((b) => {
            const x = /^line-head-(-?\d+)-(\d+)$/.exec(b.id);
            return x ? [{ group: x[1] === '-1' ? 'line-sd' : `line-${x[1]}`, col: Number(x[2]) }] : [];
          });
          if (!heads.some((h) => h.col === 1)) continue;
          two++;
          const at = `${name} ${r}${m ? ' wide' : ''}`;
          if (new Set(heads.map((h) => h.group)).size < heads.length) continue; // a street too long for a column runs on
          const span = (bs: ShareBox[]) => [Math.min(...bs.map((b) => b.y)), Math.max(...bs.map((b) => b.y + b.h))] as const;
          const secs = heads.map((h) => ({ ...h, y: span(boxes.filter((b) => b.group === h.group)) }));
          const tall = Math.max(...secs.map((x) => x.y[1] - x.y[0]));
          const [l, rt] = [0, 1].map((c) => span(boxes.filter((b) => secs.some((x) => x.col === c && x.group === b.group))))
            .map(([top, bottom]) => bottom - top) as [number, number];
          // Moving the street at the split to the shorter column would make that one the taller: no split is more even.
          if (Math.abs(l - rt) > tall + 48) out.push(`${at}: columns ${Math.round(l)} and ${Math.round(rt)} tall, the tallest street ${Math.round(tall)}`);
        }
    expect(two).toBeGreaterThan(0);
    expect(out).toEqual([]);
  });

  it('with the actions off draws the key line: no other player’s blinds, checks, folds or mucks, and says how many it left out', () => {
    const hand = table(6, { mucked: [5] });
    const steps = buildReplay(hand, 3);
    const snap = snapOf(hand, 3, steps.length - 1);
    const { boxes } = draw(snap, { template: 'betline', log: false });
    const rows = [...drawn(boxes)].map((k) => k.split(':').map(Number) as [number, number]);
    const quiet = new Set(['sb', 'bb', 'check', 'fold']);
    for (const [at, j] of rows) {
      if (at === -1) expect(snap.showdown![j]!.muck && snap.showdown![j]!.seat !== 3).toBe(false);
      else {
        const x = snap.streets[at]!.acts[j]!;
        expect(x.hero || !quiet.has(x.kind), `${at}:${j} ${x.kind}`).toBe(true);
      }
    }
    expect(rows.length + left(boxes)).toBe(rowsOf(snap));
    expect(left(boxes)).toBeGreaterThan(0);
  });
});

describe('the full hand history image', () => {
  /** The actions its log draws, and how many it says it left out. */
  const logOf = (boxes: ShareBox[]) => ({
    items: boxes.filter((b) => /^log-\d+-\d+$/.test(b.id)).flatMap((b) => (b.text ?? '').replace(/^… /, '').split(' · ')),
    left: Number(/\d+/.exec(boxes.find((b) => b.id === 'log-omit')?.text ?? '0')?.[0]),
  });

  it('keeps its log at every ratio with the hands shown, and says how many actions it left out', () => {
    const cases: [string, ReplayInput, number][] = [
      ['4 seats, three hands shown', table(4), 0],
      ['9 seats, long names', table(9, { long: true }), 4],
      ['3-bet, 4-bet and all in', brief(), 0],
    ];
    const out: string[] = [];
    for (const [name, hand, hero] of cases) {
      const steps = buildReplay(hand, hero);
      const snap = snapOf(hand, hero, steps.length - 1);
      const total = snap.log.filter((e) => e.phase !== 'result').reduce((n, e) => n + e.lines.length, 0);
      for (const r of SHARE_RATIOS)
        for (const m of [undefined, WIDE]) {
          const d = draw(snap, { template: 'summary', ratio: r }, fakeCtx(m));
          const { items, left } = logOf(d.boxes);
          const at = `${name} ${r}${m ? ' wide' : ''}`;
          if (items.length === 0) out.push(`${at}: no action drawn`);
          if (items.length + left !== total) out.push(`${at}: ${items.length} drawn + ${left} left out of ${total}`);
          out.push(...faults(d).map((f) => `${at}: ${f}`));
        }
    }
    expect(out.slice(0, 20)).toEqual([]);
  });

  it('says nothing is left out when every action fits, and nothing of a log turned off', () => {
    const hand = table(2);
    const steps = buildReplay(hand, 0);
    const snap = snapOf(hand, 0, steps.length - 1);
    const total = snap.log.filter((e) => e.phase !== 'result').reduce((n, e) => n + e.lines.length, 0);
    const on = logOf(draw(snap, { template: 'summary', ratio: '9:16' }).boxes);
    expect([on.items.length, on.left]).toEqual([total, 0]);
    const off = draw(snap, { template: 'summary', ratio: '1:1', log: false }).boxes;
    expect(off.some((b) => b.id.startsWith('log'))).toBe(false);
  });
});
