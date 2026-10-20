import type { Card, HandReplayPlayer } from '@jc/types';
import { formatChips } from '@jc/ui';
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
