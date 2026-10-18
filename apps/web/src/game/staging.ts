/**
 * How one batch of server cues plays out on the table. A batch arrives with the state it ends in, already final; this
 * plans the few seconds the scene takes to get there: a bet lands in front of its seat before it counts, street bets
 * slide into the pot with their real amounts, board cards turn one after another (an all-in run-out street by street,
 * the hands face up first), the showdown comes before the result, and each winner gets one payout of all they won
 * (their payout cues added up), side pots first. Chips nobody called go straight back from in front of their seat,
 * before a run-out, never through the pot as a win. Pure: no clock, no DOM. The amounts shown are only ever ones the state
 * passed through, no chip is ever shown in two places at once, and a batch whose amounts do not add up to its final
 * state is not staged at all (the scene shows the server state at once).
 */
import type { SoundId } from '@jc/audio';
import type { TableCue, TableView } from '@jc/types';

/** A cue as the scene receives it (useTableSocket's CueEvent, without the state each one carries). */
export interface StageCue {
  id: number;
  cue: TableCue;
}

/**
 * Chips on the move: a bet from the seat to its spot, street bets from their spot to the pot, a payout from the pot to
 * its winner, chips nobody called from their spot back to the seat.
 */
export interface Flight {
  id: number;
  kind: 'bet' | 'sweep' | 'payout' | 'return';
  seat: number;
  amount: number;
  /** Start and duration, in ms from the start of the plan. */
  at: number;
  dur: number;
}

/** A value over time: [from ms, value] steps, in order, the first one at 0. */
type Track = [number, number][];

export interface Plan {
  hand: string;
  /** The state the plan ends in (sig): a state for the same hand that no cue explains ends the plan. */
  final: string;
  /** When everything has landed; the scene shows the server state from then on. */
  end: number;
  flights: Flight[];
  sounds: { at: number; id: SoundId }[];
  /** Per seat index, the bet in front of the seat. */
  bets: Record<number, Track>;
  /** The chips gathered in the middle, when staged. */
  pot: Track | null;
  /** Board cards from index `from` turn at `at[i - from]`. */
  board: { from: number; at: number[] } | null;
  /** Other players' showdown cards stay face down until then; winners, hand names and best fives until `result`. */
  reveal: number;
  result: number;
  /**
   * Per seat paid, the stack before its chips land; `stack` is the final one it must still match. `back`: chips handed
   * back land at `at` (before a payout).
   */
  stacks: Record<number, { before: number; until: number; stack: number; back?: { at: number; amount: number } }>;
  /** Per seat index the plan moves chips at, who sits there (occupant): a seat left or taken since ends the plan. */
  who: Record<number, string>;
}

/** What the scene shows at a moment of a plan (absent fields: the server state's). */
export interface Staged {
  bets: Record<number, number>;
  pot: number | null;
  board: number | null;
  reveal: boolean;
  result: boolean;
  stacks: Record<number, number>;
}

const BET = 260; // a bet from the seat to its spot
const CHECK = 160; // a check or a fold, before what follows
const GAP = 90; // between steps
const SWEEP = 300; // street bets into the pot
const CARD = 100; // between the cards of one street
const STREET = 650; // between the streets of a run-out
const READ = 550; // the hands face up before the result
const HOLD = 250; // the result before the chips move
const PAY = 400; // a payout to its winner
const PAY_GAP = 130; // between payouts
const BACK = 280; // chips nobody called, back to their seat
/** Everything is over well before the next hand, 4 s after the result. */
export const BUDGET = 3300;
/** More cues than that at once (a reconnect, a tab that slept): the scene jumps to the state. */
export const MAX_CUES = 30;

/** The cues that move chips or cards. A seat taken or left is not one of them: it ends a plan only at a seat the plan moves chips at. */
export const STAGED_KINDS: ReadonlySet<TableCue['kind']> = new Set(['handStart', 'deal', 'action', 'returned', 'street', 'showdown', 'payout', 'handEnd']);

export const ACTION_SOUND: Record<string, SoundId> = { fold: 'fold', check: 'check', call: 'call', bet: 'raise', raise: 'raise', allin: 'allin' };

/** Identifies where a state's hand stands: a plan ends when the hand moves on without it. */
export function sig(v: TableView): string {
  const h = v.hand;
  return h ? `${h.id}:${h.seq}:${h.stage}:${h.board.length}` : '-';
}

/** Who sits at a seat: '' when empty, the same key for the same player. */
function occupant(x: TableView['seats'][number] | undefined): string {
  return !x || x.state === 'empty' ? '' : (x.userId ?? x.nickname ?? '*');
}

/** The chips in the middle that are not in front of a seat (none once settled: they have been paid). */
export function collected(v: TableView): number {
  const h = v.hand;
  return h && h.stage !== 'settled' ? h.potTotal - v.seats.reduce((a, x) => a + x.streetBet, 0) : 0;
}

/** Plans `cues`, which took the table from `prev` to `next`; null when they are not to be staged (the state shows at once). */
export function plan(prev: TableView | null, cues: StageCue[], next: TableView, mySeat: number | null): Plan | null {
  const h = next.hand;
  const ph = prev?.hand;
  const staged = cues.filter((c) => STAGED_KINDS.has(c.cue.kind));
  if (!h || !staged.length || staged.length > MAX_CUES) return null;
  if (staged.some((c) => c.cue.kind === 'handStart')) return dealPlan(next, staged);
  if (!ph || ph.id !== h.id || ph.stage === 'settled') return null;

  const settled = h.stage === 'settled';
  const flights: Flight[] = [];
  const sounds: Plan['sounds'] = [];
  const bets: Record<number, Track> = {};
  const running = new Map<number, number>();
  for (const x of prev.seats) if (x.streetBet > 0) running.set(x.seatIndex, x.streetBet);
  const setBet = (seat: number, at: number, v: number) => (bets[seat] ??= [[0, prev.seats.find((x) => x.seatIndex === seat)?.streetBet ?? 0]]).push([at, v]);
  let pot = collected(prev);
  const potT: Track = [[0, pot]];
  const boardAt: number[] = [];
  const runout = staged.some((c) => c.cue.kind === 'showdown') && staged.some((c) => c.cue.kind === 'street');
  const payouts: { seat: number; amount: number }[] = [];
  const back = new Map<number, { at: number; amount: number }>();
  let t = 0;
  let reveal = 0;
  let fid = 0;

  const sweep = () => {
    const moving = [...running].filter(([, v]) => v > 0);
    if (!moving.length) return;
    t += GAP;
    for (const [seat, amount] of moving) {
      flights.push({ id: ++fid, kind: 'sweep', seat, amount, at: t, dur: SWEEP });
      setBet(seat, t, 0);
      pot += amount;
    }
    running.clear();
    t += SWEEP;
    potT.push([t, pot]);
  };
  const showHands = () => {
    if (reveal) return;
    t += GAP;
    reveal = t;
    sounds.push({ at: t, id: 'showdown' });
    t += READ;
  };

  for (const { cue: c } of staged) {
    if (c.kind === 'action') {
      sounds.push({ at: t, id: ACTION_SOUND[c.type] ?? 'chip' });
      if (c.amount > 0) {
        const v = (running.get(c.seatIndex) ?? 0) + c.amount;
        running.set(c.seatIndex, v);
        flights.push({ id: ++fid, kind: 'bet', seat: c.seatIndex, amount: c.amount, at: t, dur: BET });
        t += BET;
        setBet(c.seatIndex, t, v);
      } else t += CHECK;
    } else if (c.kind === 'returned') {
      // Chips nobody called are still in front of the seat that bet them (the hand ended on that street): they go back
      // from there, and only the rest goes to the pot. Anywhere else, the batch does not add up.
      const v = running.get(c.seatIndex) ?? 0;
      if (c.amount <= 0 || v < c.amount || back.has(c.seatIndex)) return null;
      t += GAP;
      flights.push({ id: ++fid, kind: 'return', seat: c.seatIndex, amount: c.amount, at: t, dur: BACK });
      running.set(c.seatIndex, v - c.amount);
      setBet(c.seatIndex, t, v - c.amount);
      t += BACK;
      back.set(c.seatIndex, { at: t, amount: c.amount });
      sounds.push({ at: t, id: 'chip' });
    } else if (c.kind === 'street') {
      sweep();
      if (runout) showHands();
      t += GAP;
      sounds.push({ at: t, id: 'flip' });
      c.cards.forEach((_, i) => boardAt.push(t + i * CARD));
      t += runout ? STREET : (c.cards.length - 1) * CARD;
    } else if (c.kind === 'showdown') {
      sweep();
      showHands();
    } else if (c.kind === 'payout') {
      // One payout per winner: a winner of several pots gets all of it at once, and its stack waits for all of it.
      const same = payouts.find((x) => x.seat === c.seatIndex);
      if (same) same.amount += c.amount;
      else payouts.push({ seat: c.seatIndex, amount: c.amount });
    }
  }

  let result = 0;
  const stacks: Plan['stacks'] = {};
  if (settled) {
    sweep();
    result = t + GAP;
    t = result + HOLD;
    // Side pots first, the main pot last; split pots one winner after another.
    const potsOf = new Map((h.result?.winners ?? []).map((w) => [w.seatIndex, w.potIds]));
    const rank = (seat: number) => Math.max(0, ...(potsOf.get(seat) ?? []).map((id) => (id.startsWith('pot-side-') ? 1 + Number(id.slice(9)) || 1 : 0)));
    payouts.sort((a, b) => rank(b.seat) - rank(a.seat) || a.seat - b.seat);
    payouts.forEach((p, k) => {
      const at = t + k * PAY_GAP;
      flights.push({ id: ++fid, kind: 'payout', seat: p.seat, amount: p.amount, at, dur: PAY });
      pot -= p.amount;
      potT.push([at, pot]);
      const stack = next.seats.find((x) => x.seatIndex === p.seat)?.stack ?? 0;
      stacks[p.seat] = { before: (stacks[p.seat]?.before ?? stack) - p.amount, until: at + PAY, stack };
      sounds.push({ at: at + PAY, id: p.seat === mySeat ? 'win' : 'chip' });
    });
    if (payouts.length) t += (payouts.length - 1) * PAY_GAP + PAY;
  }
  // A seat handed chips back waits for them too: before them it shows what it had left (and before its payout, also
  // what it got back).
  for (const [seat, b] of back) {
    const stack = next.seats.find((x) => x.seatIndex === seat)?.stack ?? 0;
    const s = stacks[seat];
    stacks[seat] = s ? { ...s, before: s.before - b.amount, back: b } : { before: stack - b.amount, until: b.at, stack };
  }

  // Only what adds up is staged: the bets and the pot must end where the state is, the board must grow into its cards.
  // A settled hand always pays someone, and its stacks already hold the pot: without its payouts (the Academy holding
  // the result back for a question) a pot left in the middle would show those chips twice, so the state shows at once.
  if (settled ? !payouts.length || pot !== 0 || Object.values(stacks).some((s) => s.before < 0) : pot !== collected(next)) return null;
  if (!settled && next.seats.some((x) => (running.get(x.seatIndex) ?? 0) !== x.streetBet)) return null;
  const board = boardAt.length && ph.board.length + boardAt.length === h.board.length ? { from: ph.board.length, at: boardAt } : null;
  if (boardAt.length && !board) return null;

  // Chips move only between the same players: a seat its player left, or someone else took, within the batch itself
  // would send them to whoever sits there now, so the state shows at once.
  const who: Plan['who'] = {};
  for (const seat of [...flights.map((f) => f.seat), ...Object.keys(bets).map(Number), ...Object.keys(stacks).map(Number)]) {
    who[seat] = occupant(next.seats.find((x) => x.seatIndex === seat));
    if (who[seat] !== occupant(prev.seats.find((x) => x.seatIndex === seat))) return null;
  }
  const p: Plan = { hand: h.id, final: sig(next), end: t + 60, flights, sounds, bets, pot: potT.length > 1 ? potT : null, board, reveal, result, stacks, who };
  return p.end > BUDGET ? scale(p, BUDGET / p.end) : p;
}

/** A new hand: its cards go round from the seat after the button, one card each and then the second. */
function dealPlan(next: TableView, cues: StageCue[]): Plan {
  const h = next.hand!;
  const order = dealOrder(next);
  const step = dealStep(order.length);
  const sounds: Plan['sounds'] = [];
  if (cues.some((c) => c.cue.kind === 'deal') && order.length) sounds.push({ at: 0, id: 'deal' }, { at: order.length * step, id: 'deal' });
  return { hand: h.id, final: sig(next), end: order.length * 2 * step, flights: [], sounds, bets: {}, pot: null, board: null, reveal: 0, result: 0, stacks: {}, who: {} };
}

function dealOrder(v: TableView): number[] {
  const h = v.hand;
  if (!h) return [];
  const n = v.seats.length;
  const dealt = v.seats.filter((x) => x.hasCards || !!x.holeCards?.length).map((x) => x.seatIndex);
  return dealt.sort((a, b) => ((a - h.buttonSeat - 1 + n) % n) - ((b - h.buttonSeat - 1 + n) % n));
}

/** Between two cards of a deal: a short table deals slower than a full one, the whole deal under a second. */
function dealStep(seats: number) {
  return Math.round(Math.min(90, Math.max(45, 900 / Math.max(1, seats * 2))));
}

/** Per seat index, when each of its two cards arrives (ms from the start of the hand). */
export function dealDelays(v: TableView): Record<number, [number, number]> {
  const order = dealOrder(v);
  const step = dealStep(order.length);
  const out: Record<number, [number, number]> = {};
  order.forEach((seat, k) => (out[seat] = [k * step, (order.length + k) * step]));
  return out;
}

function scale(p: Plan, f: number): Plan {
  const s = (x: number) => Math.round(x * f);
  const track = (tr: Track): Track => tr.map(([at, v]) => [s(at), v]);
  return {
    ...p,
    end: s(p.end),
    // A flight lands exactly when what it carries counts (a bet, the pot, a stack), never a millisecond apart.
    flights: p.flights.map((x) => ({ ...x, at: s(x.at), dur: s(x.at + x.dur) - s(x.at) })),
    sounds: p.sounds.map((x) => ({ ...x, at: s(x.at) })),
    bets: Object.fromEntries(Object.entries(p.bets).map(([k, tr]) => [k, track(tr)])),
    pot: p.pot && track(p.pot),
    board: p.board && { from: p.board.from, at: p.board.at.map(s) },
    reveal: s(p.reveal),
    result: s(p.result),
    stacks: Object.fromEntries(Object.entries(p.stacks).map(([k, x]) => [k, { ...x, until: s(x.until), ...(x.back ? { back: { ...x.back, at: s(x.back.at) } } : {}) }])),
  };
}

function at(tr: Track, t: number): number {
  let v = tr[0]![1];
  for (const [from, x] of tr) if (from <= t) v = x;
  return v;
}

/** The scene at `t` ms into `p`, over the server state `v` (null once the plan is over or no longer applies). */
export function stagedAt(p: Plan | null, t: number, v: TableView): Staged | null {
  if (!p || t >= p.end || v.hand?.id !== p.hand) return null;
  // Chips on their way to a seat its player left, or someone else took: the scene shows the state at once.
  for (const [k, w] of Object.entries(p.who)) if (occupant(v.seats.find((x) => x.seatIndex === +k)) !== w) return null;
  const bets: Record<number, number> = {};
  for (const [k, tr] of Object.entries(p.bets)) bets[+k] = at(tr, t);
  const stacks: Record<number, number> = {};
  // A stack held back only while it is still the one the payout made (a top-up since shows at once).
  for (const [k, x] of Object.entries(p.stacks)) {
    if (t < x.until && v.seats.find((s) => s.seatIndex === +k)?.stack === x.stack) stacks[+k] = x.before + (x.back && t >= x.back.at ? x.back.amount : 0);
  }
  const board = p.board ? p.board.from + p.board.at.filter((a) => a <= t).length : null;
  return { bets, pot: p.pot && at(p.pot, t), board, reveal: t >= p.reveal, result: t >= p.result, stacks };
}

/** The moments a plan's scene changes, after `t` (for the timers that redraw it). */
export function boundaries(p: Plan): number[] {
  const out = new Set<number>([p.end, p.reveal, p.result]);
  for (const tr of Object.values(p.bets)) for (const [a] of tr) out.add(a);
  for (const [a] of p.pot ?? []) out.add(a);
  for (const a of p.board?.at ?? []) out.add(a);
  for (const x of Object.values(p.stacks)) {
    out.add(x.until);
    if (x.back) out.add(x.back.at);
  }
  return [...out].filter((a) => a > 0).sort((a, b) => a - b);
}

/** Sounds for cues that are not staged (reduced motion, a batch that did not add up): the two that matter most, at once. */
const PRIORITY: SoundId[] = ['win', 'showdown', 'allin', 'raise', 'call', 'flip', 'deal', 'check', 'fold', 'chip'];
export function quickSounds(cues: StageCue[], mySeat: number | null): SoundId[] {
  const ids = new Set<SoundId>();
  for (const { cue: c } of cues) {
    if (c.kind === 'deal') ids.add('deal');
    else if (c.kind === 'action') ids.add(ACTION_SOUND[c.type] ?? 'chip');
    else if (c.kind === 'returned') ids.add('chip');
    else if (c.kind === 'street') ids.add('flip');
    else if (c.kind === 'showdown') ids.add('showdown');
    else if (c.kind === 'payout') ids.add(c.seatIndex === mySeat ? 'win' : 'chip');
  }
  return PRIORITY.filter((id) => ids.has(id)).slice(0, 2);
}
