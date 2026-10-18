/**
 * Step-by-step replay of a finished hand, built only from its stored record: actions, board, pot payouts and the hole
 * cards the API returned. Every step is a TableView, so the replay renders with the live table's TableScene. The
 * viewer's own cards show from the deal; anyone else's only from the showdown step and only if the API returned them
 * (face up at showdown) — nothing here can reveal a card the record does not already show.
 */
import {
  SUPPORTED_MAX_SEATS,
  type ActionType,
  type Card,
  type HandReplayFields,
  type HandReplayPlayer,
  type HandResultView,
  type HandStage,
  type MaxSeats,
  type PotView,
  type SeatView,
  type TableView,
} from '@jc/types';

export interface ReplayInput extends HandReplayFields {
  id: string;
  tableName: string;
  handNumber: number;
  players: HandReplayPlayer[];
}

export type ReplayAction = HandReplayFields['actions'][number];

/**
 * What a step did, piece by piece, for the line read out under the replay. An action's amount is what a player would
 * say: a bet, raise or all-in to its total on the street, a blind or a call by what it put in.
 */
export type ReplayLinePart =
  | { kind: 'deal' }
  | { kind: 'act'; seat: number; type: string; amount: number }
  | { kind: 'board'; cards: Card[] }
  | { kind: 'shows'; seat: number; rankClass: string; bestFive: Card[] }
  | { kind: 'wins'; seat: number; amount: number };

export interface ReplayStep {
  /** deal: cards dealt and blinds posted · action: one action · street: new board cards · showdown: hands shown · result: pots paid. */
  kind: 'deal' | 'action' | 'street' | 'showdown' | 'result';
  stage: HandStage;
  /** The action of an action step, or the blinds posted on the deal step. */
  actions: ReplayAction[];
  line: ReplayLinePart[];
  view: TableView;
}

/** The parts of a hand on the replay's timeline: the four streets, the showdown and the payout. */
export const REPLAY_PHASES = ['preflop', 'flop', 'turn', 'river', 'showdown', 'result'] as const;
export type ReplayPhase = (typeof REPLAY_PHASES)[number];
export const replayPhase = (s: ReplayStep): ReplayPhase => (s.stage === 'settled' ? 'result' : s.stage);

/** Where each part the hand reached begins and ends (step indexes); a hand over early has no later parts. */
export function replayParts(steps: readonly ReplayStep[]) {
  const parts: { phase: ReplayPhase; first: number; last: number }[] = [];
  steps.forEach((s, k) => {
    const phase = replayPhase(s);
    const prev = parts.at(-1);
    if (prev?.phase === phase) prev.last = k;
    else parts.push({ phase, first: k, last: k });
  });
  return parts;
}

const STREETS: HandStage[] = ['preflop', 'flop', 'turn', 'river'];
const BOARD_AT: Record<HandStage, number> = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, settled: 5 };
const BLINDS = new Set(['post-sb', 'post-bb']);
const FOLDS = new Set(['fold', 'timeout-fold']);
/** Actions read to their street total ("raises to 300"); the rest by what they put in ("calls 200"). */
const TO_TOTAL = new Set(['bet', 'raise', 'allin']);

/** The action shown on a seat plate: posted blinds show none, a time-out shows what it became. */
function plateAction(type: string): ActionType | null {
  if (type === 'timeout-fold') return 'fold';
  if (type === 'timeout-check') return 'check';
  return BLINDS.has(type) ? null : (type as ActionType);
}

/**
 * Pots from what each seat has put in so far, built like the engine's ledger: one pot while nobody is all in,
 * otherwise one per contribution level, with folded chips in and folded seats unable to win. Neighbouring levels with
 * the same contenders show as one pot, and a level nobody left can win joins the pot before it.
 */
export function replayPots(put: ReadonlyMap<number, number>, folded: ReadonlySet<number>, allIn: ReadonlySet<number>): PotView[] {
  const left = new Map([...put].filter(([, v]) => v > 0));
  if (left.size === 0) return [];
  const contenders = (seats: number[]) => seats.filter((s) => !folded.has(s)).sort((a, b) => a - b);
  if (allIn.size === 0) return [{ id: 'pot-0', amount: [...left.values()].reduce((a, b) => a + b, 0), eligibleSeats: contenders([...left.keys()]) }];
  const out: PotView[] = [];
  for (;;) {
    const parts = [...left].filter(([, v]) => v > 0);
    if (parts.length === 0) break;
    const level = Math.min(...parts.map(([, v]) => v));
    for (const [s, v] of parts) left.set(s, v - level);
    const eligibleSeats = contenders(parts.map(([s]) => s));
    const prev = out.at(-1);
    if (prev && (eligibleSeats.length === 0 || prev.eligibleSeats.join() === eligibleSeats.join())) prev.amount += level * parts.length;
    else out.push({ id: `pot-${out.length}`, amount: level * parts.length, eligibleSeats });
  }
  return out;
}

/** What a player won, less the chips nobody called that the server says came back to them (HandReplayFields.returned). */
export const wonLessReturned = (h: ReplayInput, p: { seatIndex: number; won: number }) => p.won - (h.returned?.seatIndex === p.seatIndex ? h.returned.amount : 0);

/**
 * Winners as the table shows them, main pot first: chips won from contested pots (an uncalled bet handed back is not
 * a win). The first one's best five is what the board highlights. The pots and the chips handed back are the server's
 * (HandReplayFields); nothing here works them out.
 */
function resultWinners(h: ReplayInput): HandResultView['winners'] {
  const won = new Map<number, { amount: number; potIds: string[] }>();
  if (h.pots) {
    h.pots.forEach((pot, i) => {
      if (pot.uncalled) return;
      for (const w of pot.winners) {
        const e = won.get(w.seatIndex) ?? { amount: 0, potIds: [] };
        e.amount += w.amount;
        e.potIds.push(`pot-${i}`);
        won.set(w.seatIndex, e);
      }
    });
  } else {
    // Hands recorded before pots were stored: each player's total, less the chips handed back.
    for (const p of h.players) {
      const amount = wonLessReturned(h, p);
      if (amount > 0) won.set(p.seatIndex, { amount, potIds: [] });
    }
  }
  return [...won].map(([seatIndex, e]) => ({ seatIndex, ...e }));
}

/** The seat count of the table layout: the table's own, or the smallest supported one that fits every seat. */
function layoutSeats(h: ReplayInput): MaxSeats {
  const need = Math.max(h.maxSeats, ...h.players.map((p) => p.seatIndex + 1));
  return SUPPORTED_MAX_SEATS.find((n) => n >= need) ?? 9;
}

export function buildReplay(h: ReplayInput, heroSeat: number | null): ReplayStep[] {
  const bySeat = new Map(h.players.map((p) => [p.seatIndex, p]));
  const maxSeats = layoutSeats(h);
  const board = h.board as Card[];
  const sbSeat = h.actions.find((a) => a.type === 'post-sb')?.seatIndex ?? null;
  const bbSeat = h.actions.find((a) => a.type === 'post-bb')?.seatIndex ?? null;
  const put = new Map<number, number>();
  const streetBets = new Map<number, number>();
  const plates = new Map<number, { type: ActionType; amount: number }>();
  const folded = new Set<number>();
  const allIn = new Set<number>();
  let stage: HandStage = 'preflop';
  const steps: ReplayStep[] = [];

  const snap = (kind: ReplayStep['kind'], actions: ReplayAction[], line: ReplayLinePart[], o: { actor?: number; reveal?: boolean; result?: HandResultView } = {}) => {
    const final = kind === 'result';
    const seats: SeatView[] = Array.from({ length: maxSeats }, (_, i): SeatView => {
      const p = bySeat.get(i);
      if (!p) return { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, connected: false, hasCards: false };
      const out = folded.has(i);
      const stack = final ? p.stackStart + p.net : p.stackStart - (put.get(i) ?? 0);
      const shown = i === heroSeat || (!!o.reveal && !out);
      return {
        seatIndex: i,
        state: out ? 'folded' : (final ? stack === 0 : allIn.has(i)) ? 'allin' : 'active',
        nickname: p.nickname,
        ...(p.role ? { role: p.role } : {}),
        ...(p.bot ? { bot: true as const } : {}),
        stack,
        streetBet: final ? 0 : (streetBets.get(i) ?? 0),
        connected: true,
        lastAction: plates.get(i) ?? null,
        hasCards: !out,
        holeCards: shown && p.holeCards ? (p.holeCards as Card[]) : null,
      };
    });
    const potTotal = final ? h.potTotal : [...put.values()].reduce((a, b) => a + b, 0);
    const view: TableView = {
      version: steps.length,
      table: {
        id: h.id,
        name: h.tableName,
        maxSeats,
        smallBlind: h.smallBlind ?? 0,
        bigBlind: h.bigBlind ?? 0,
        minBuyIn: 0,
        maxBuyIn: 0,
        turnSeconds: 30,
        allowSpectators: false,
        isPrivate: false,
        roomType: 'official',
        hostId: null,
      },
      status: final ? 'waiting' : 'playing',
      seats,
      hand: {
        id: h.id,
        number: h.handNumber,
        seq: steps.length,
        stage,
        buttonSeat: h.buttonSeat ?? -1,
        sbSeat,
        bbSeat,
        board: board.slice(0, BOARD_AT[stage]),
        pots: final ? [] : replayPots(put, folded, allIn),
        potTotal,
        actorSeat: o.actor ?? null,
        deadline: null,
        result: o.result ?? null,
      },
      spectatorCount: 0,
      waitlist: [],
      reservation: null,
      nextHandAt: null,
      you: { userId: '', seatIndex: heroSeat, legal: [], sittingOut: false, leaving: false, inWaitlist: false, canSit: false, needsCode: false, topUpQueued: null, autoRebuy: null },
    };
    steps.push({ kind, stage, actions, line, view });
  };

  /** Applies an action and returns how the line reads it. */
  const apply = (a: ReplayAction): ReplayLinePart => {
    const total = (put.get(a.seatIndex) ?? 0) + a.amount;
    put.set(a.seatIndex, total);
    const street = (streetBets.get(a.seatIndex) ?? 0) + a.amount;
    streetBets.set(a.seatIndex, street);
    if (FOLDS.has(a.type)) folded.add(a.seatIndex);
    const start = bySeat.get(a.seatIndex)?.stackStart ?? 0;
    if (start > 0 && total >= start) allIn.add(a.seatIndex);
    const shown = plateAction(a.type);
    if (shown) plates.set(a.seatIndex, { type: shown, amount: a.amount });
    return { kind: 'act', seat: a.seatIndex, type: a.type, amount: TO_TOTAL.has(a.type) ? street : a.amount };
  };

  /** Deals the streets up to `to` (one step each), clearing the street's bets and plate actions. */
  const dealTo = (to: HandStage) => {
    while (STREETS.indexOf(stage) < STREETS.indexOf(to)) {
      const from = BOARD_AT[stage];
      stage = STREETS[STREETS.indexOf(stage) + 1]!;
      streetBets.clear();
      plates.clear();
      const cards = board.slice(from, BOARD_AT[stage]);
      snap('street', [], cards.length > 0 ? [{ kind: 'board', cards }] : []);
    }
  };

  let i = 0;
  const blinds: ReplayAction[] = [];
  const posted: ReplayLinePart[] = [];
  while (i < h.actions.length && BLINDS.has(h.actions[i]!.type)) {
    posted.push(apply(h.actions[i]!));
    blinds.push(h.actions[i]!);
    i += 1;
  }
  snap('deal', blinds, [{ kind: 'deal' }, ...posted]);
  for (; i < h.actions.length; i += 1) {
    const a = h.actions[i]!;
    if (STREETS.includes(a.stage as HandStage)) dealTo(a.stage as HandStage);
    snap('action', [a], [apply(a)], { actor: a.seatIndex });
  }

  // Ranks come only for hands the viewer may see that went to showdown (the API leaves the rest null).
  const contenders = h.players.filter((p) => !folded.has(p.seatIndex));
  const showdown: HandResultView['showdown'] =
    contenders.length >= 2
      ? contenders
          .filter((p) => p.rankClass && p.holeCards)
          .map((p) => ({ seatIndex: p.seatIndex, cards: p.holeCards as Card[], rankClass: p.rankClass as HandResultView['showdown'][number]['rankClass'], bestFive: (p.bestFive ?? []) as Card[] }))
      : [];
  if (contenders.length >= 2) {
    // Streets dealt with nobody left to act (all in): the rest of the board, one street at a time.
    for (const s of STREETS) if (BOARD_AT[s] <= board.length && STREETS.indexOf(s) > STREETS.indexOf(stage)) dealTo(s);
    stage = 'showdown';
    const shows = showdown.map((x): ReplayLinePart => ({ kind: 'shows', seat: x.seatIndex, rankClass: x.rankClass, bestFive: x.bestFive }));
    snap('showdown', [], shows, { reveal: true, result: { winners: [], showdown } });
  }
  stage = 'settled';
  const winners = resultWinners(h);
  const wins = winners.map((w): ReplayLinePart => ({ kind: 'wins', seat: w.seatIndex, amount: w.amount }));
  snap('result', [], wins, { reveal: contenders.length >= 2, result: { winners, showdown } });
  return steps;
}
