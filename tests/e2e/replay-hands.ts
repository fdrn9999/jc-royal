import type { HandDetailDto, PublicRole } from '@jc/types';

/**
 * Finished hands for checking the replay's layout at 2, 6 and 9 seats: the longest nicknames the signup allows (16
 * letters, wide Latin and Hangul), staff and bot names, all-ins with side pots, a split pot and a showdown. They are
 * served in place of GET /api/me/hands/:id, so every seat count is checked without playing a nine-handed hand; the
 * replay itself (replay-mobile.spec.ts) is still checked on a hand played on the server.
 */
interface SeatSpec {
  seat: number;
  name: string;
  stack: number;
  cards?: [string, string];
  rank?: string;
  best?: string[];
  role?: PublicRole;
  bot?: true;
}
type Act = [seat: number, stage: 'preflop' | 'flop' | 'turn' | 'river', type: string, amount: number];
interface PotSpec {
  amount: number;
  eligible: number[];
  winners: [seat: number, amount: number][];
}

export function build(id: string, maxSeats: number, button: number, board: string[], seats: SeatSpec[], acts: Act[], pots: PotSpec[]): HandDetailDto {
  const put = new Map<number, number>();
  for (const [s, , , amount] of acts) put.set(s, (put.get(s) ?? 0) + amount);
  const won = new Map<number, number>();
  for (const p of pots) for (const [s, amount] of p.winners) won.set(s, (won.get(s) ?? 0) + amount);
  const potTotal = [...put.values()].reduce((a, b) => a + b, 0);
  const paid = pots.reduce((a, p) => a + p.amount, 0);
  if (paid !== potTotal) throw new Error(`${id}: pots ${paid} != chips put in ${potTotal}`);
  return {
    id,
    tableId: 'e2e-replay',
    tableName: 'E2E Replay Layout',
    handNumber: 42,
    endedAt: Date.UTC(2026, 9, 16, 12),
    board,
    potTotal,
    smallBlind: 50,
    bigBlind: 100,
    maxSeats,
    buttonSeat: button,
    pots: pots.map((p) => ({ amount: p.amount, eligibleSeats: p.eligible, winners: p.winners.map(([seatIndex, amount]) => ({ seatIndex, amount })), uncalled: false })),
    returned: null,
    actions: acts.map(([seatIndex, stage, type, amount]) => ({ seatIndex, stage, type, amount })),
    players: seats.map((s) => ({
      seatIndex: s.seat,
      userId: `u-${id}-${s.seat}`,
      isYou: s.seat === 0,
      nickname: s.name,
      ...(s.role ? { role: s.role } : {}),
      ...(s.bot ? { bot: true as const } : {}),
      holeCards: s.cards ?? null,
      stackStart: s.stack,
      net: (won.get(s.seat) ?? 0) - (put.get(s.seat) ?? 0),
      won: won.get(s.seat) ?? 0,
      rankClass: s.rank ?? null,
      bestFive: s.best ?? null,
    })),
    note: { bookmarked: false, tags: [], memo: null, rev: 0, updatedAt: null },
  };
}

const W16 = 'WWWWWWWWWWWWWWWW';
const M16 = 'MMMMMMMMMMMMMMMM';
const HANGUL16 = '가나다라마바사아자차카타파하거너';

/** Heads-up, checked and bet to a showdown: one pot. */
export const HAND_2 = build(
  'e2e-layout-2',
  2,
  0,
  ['Js', 'Td', '4c', '8h', '2s'],
  [
    { seat: 0, name: W16, stack: 100_000, cards: ['Jh', '9h'], rank: 'pair', best: ['Jh', 'Js', 'Td', '9h', '8h'] },
    { seat: 1, name: M16, role: 'super_admin', stack: 1_234_567, cards: ['Qc', '9c'], rank: 'straight', best: ['Qc', 'Js', 'Td', '9c', '8h'] },
  ],
  [
    [0, 'preflop', 'post-sb', 50],
    [1, 'preflop', 'post-bb', 100],
    [0, 'preflop', 'call', 50],
    [1, 'preflop', 'check', 0],
    [1, 'flop', 'bet', 200],
    [0, 'flop', 'raise', 600],
    [1, 'flop', 'call', 400],
    [1, 'turn', 'check', 0],
    [0, 'turn', 'bet', 1500],
    [1, 'turn', 'call', 1500],
    [1, 'river', 'check', 0],
    [0, 'river', 'check', 0],
  ],
  [{ amount: 4400, eligible: [0, 1], winners: [[1, 4400]] }],
);

/** Six seats: a short all-in wins the main pot, the viewer the side pot. */
export const HAND_6 = build(
  'e2e-layout-6',
  6,
  3,
  ['Qc', '9s', '5d', '3h', '2c'],
  [
    { seat: 0, name: W16, stack: 100_000, cards: ['Qh', 'Qd'], rank: 'three-of-a-kind', best: ['Qh', 'Qd', 'Qc', '9s', '5d'] },
    { seat: 1, name: HANGUL16, stack: 800, cards: ['4s', '6h'], rank: 'straight', best: ['6h', '5d', '4s', '3h', '2c'] },
    { seat: 2, name: M16, role: 'super_admin', stack: 1_234_567 },
    { seat: 3, name: 'JC봇_Hard_00003', bot: true, stack: 50_000, cards: ['Ac', 'Kc'], rank: 'high-card', best: ['Ac', 'Kc', 'Qc', '9s', '5d'] },
    { seat: 4, name: 'abcdefghijklmnop', role: 'admin', stack: 7_777 },
    { seat: 5, name: 'ZZZZZZZZZZZZZZZZ', stack: 99_999 },
  ],
  [
    [4, 'preflop', 'post-sb', 50],
    [5, 'preflop', 'post-bb', 100],
    [0, 'preflop', 'raise', 300],
    [1, 'preflop', 'allin', 800],
    [2, 'preflop', 'fold', 0],
    [3, 'preflop', 'call', 800],
    [4, 'preflop', 'fold', 0],
    [5, 'preflop', 'call', 700],
    [0, 'preflop', 'call', 500],
    [5, 'flop', 'bet', 2000],
    [0, 'flop', 'call', 2000],
    [3, 'flop', 'call', 2000],
    [5, 'turn', 'check', 0],
    [0, 'turn', 'bet', 6000],
    [3, 'turn', 'call', 6000],
    [5, 'turn', 'fold', 0],
    [0, 'river', 'check', 0],
    [3, 'river', 'check', 0],
  ],
  [
    { amount: 3250, eligible: [0, 1, 3], winners: [[1, 3250]] },
    { amount: 18_000, eligible: [0, 3], winners: [[0, 18_000]] },
  ],
);

/** Nine seats: two all-ins, three pots, the last one split between the viewer and the admin. */
export const HAND_9 = build(
  'e2e-layout-9',
  9,
  6,
  ['Ah', 'Kd', '7c', '7s', '2h'],
  [
    { seat: 0, name: W16, stack: 100_000, cards: ['As', 'Qs'], rank: 'two-pair', best: ['As', 'Ah', '7c', '7s', 'Kd'] },
    { seat: 1, name: HANGUL16, stack: 25_000 },
    { seat: 2, name: M16, role: 'super_admin', stack: 1_234_567 },
    { seat: 3, name: 'short_stack_0003', stack: 500, cards: ['Kh', 'Kc'], rank: 'full-house', best: ['Kh', 'Kc', 'Kd', '7c', '7s'] },
    { seat: 4, name: '관리자닉네임열여섯글자다', role: 'admin', stack: 1_234_567, cards: ['Ac', 'Js'], rank: 'two-pair', best: ['Ac', 'Ah', '7c', '7s', 'Kd'] },
    { seat: 5, name: 'JC봇_Normal_005', bot: true, stack: 2000, cards: ['7d', '2c'], rank: 'full-house', best: ['7d', '7c', '7s', '2c', '2h'] },
    { seat: 6, name: 'W_W_W_W_W_W_W_W_', stack: 88_888 },
    { seat: 7, name: 'abcdefghijklmnop', stack: 50_000 },
    { seat: 8, name: 'ZZZZZZZZZZZZZZZZ', stack: 99_999 },
  ],
  [
    [7, 'preflop', 'post-sb', 50],
    [8, 'preflop', 'post-bb', 100],
    [0, 'preflop', 'call', 100],
    [1, 'preflop', 'call', 100],
    [2, 'preflop', 'fold', 0],
    [3, 'preflop', 'allin', 500],
    [4, 'preflop', 'call', 500],
    [5, 'preflop', 'allin', 2000],
    [6, 'preflop', 'call', 2000],
    [7, 'preflop', 'fold', 0],
    [8, 'preflop', 'call', 1900],
    [0, 'preflop', 'call', 1900],
    [1, 'preflop', 'fold', 0],
    [4, 'preflop', 'call', 1500],
    [8, 'flop', 'check', 0],
    [0, 'flop', 'bet', 5000],
    [4, 'flop', 'call', 5000],
    [6, 'flop', 'fold', 0],
    [8, 'flop', 'call', 5000],
    [8, 'turn', 'check', 0],
    [0, 'turn', 'check', 0],
    [4, 'turn', 'bet', 12_345],
    [8, 'turn', 'fold', 0],
    [0, 'turn', 'call', 12_345],
    [0, 'river', 'check', 0],
    [4, 'river', 'check', 0],
  ],
  [
    { amount: 3150, eligible: [0, 3, 4, 5], winners: [[3, 3150]] },
    { amount: 7500, eligible: [0, 4, 5], winners: [[5, 7500]] },
    {
      amount: 39_690,
      eligible: [0, 4],
      winners: [
        [0, 19_845],
        [4, 19_845],
      ],
    },
  ],
);
