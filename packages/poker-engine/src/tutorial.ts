/**
 * Helpers for tests and the offline Academy (tutorial / practice).
 * Nothing here is used by the multiplayer server: real tables always shuffle
 * with the CSPRNG (`secureShuffledDeck`).
 */
import { handLabelKey, type Card, type HandLabelKey, type HandRankClass } from '@jc/types';
import { standardDeck } from './deck';
import { HandEngine, type MaxSeats } from './hand';

/**
 * Builds a 52-card deck in the order the adapter consumes it:
 * hole cards (dealing order = clockwise starting left of the button, two each),
 * then burn, flop×3, burn, turn, burn, river, then the rest.
 */
export function stackedDeck(holes: readonly (readonly Card[])[], board: readonly Card[]): Card[] {
  if (board.length !== 5) throw new Error('board must have 5 cards');
  const used = new Set<string>([...holes.flat(), ...board]);
  if (used.size !== holes.flat().length + board.length) throw new Error('duplicate cards');
  const rest = standardDeck().filter((c) => !used.has(c));
  const take = () => rest.shift()!;
  const out: Card[] = [];
  for (const h of holes) out.push(...h);
  out.push(take(), board[0]!, board[1]!, board[2]!, take(), board[3]!, take(), board[4]!);
  out.push(...rest);
  return out;
}

/** Seats 0..n-1 with the button on `button`: the order hole cards are dealt in. */
export function dealOrder(seatCount: number, button: number): number[] {
  return Array.from({ length: seatCount }, (_, k) => (button + 1 + k) % seatCount);
}

export function tableSizeFor(players: number): MaxSeats {
  if (players < 2 || players > 9) throw new Error('2-9 players');
  return players === 2 ? 2 : players <= 6 ? 6 : 9;
}

export interface ShowdownHand {
  seatIndex: number;
  rankClass: HandRankClass;
  label: HandLabelKey;
  bestFive: Card[];
}

export interface ShowdownOutcome {
  /** Seats that won chips; more than one means a split pot. */
  winners: number[];
  hands: ShowdownHand[];
}

/**
 * Judges a spot with the real engine: deals the given hole cards (by seat) and
 * board, checks the hand down and reads the engine's showdown and payouts.
 */
export async function judgeShowdown(holesBySeat: readonly (readonly Card[])[], board: readonly Card[]): Promise<ShowdownOutcome> {
  const n = holesBySeat.length;
  const order = dealOrder(n, 0);
  const engine = HandEngine.start({
    handId: `judge-${Math.random().toString(36).slice(2)}`,
    rules: { maxSeats: tableSizeFor(n), smallBlind: 1, bigBlind: 2, turnMs: 60_000 },
    seats: holesBySeat.map((_, i) => ({ playerId: `s${i}`, seatIndex: i, stack: 100, displayName: `S${i}` })),
    buttonSeat: 0,
    now: 0,
    deck: stackedDeck(order.map((s) => holesBySeat[s]!), board),
  });
  for (let guard = 0; guard < 100 && !engine.isSettled; guard++) {
    if (engine.isStalled()) {
      await engine.resolveStall(guard);
      continue;
    }
    const actor = engine.actorId()!;
    const type = engine.legalOptions(actor).some((o) => o.type === 'check') ? 'check' : 'call';
    const r = await engine.act(actor, { type }, `judge-${guard}`, guard);
    if (!r.ok) throw new Error(`judge: ${r.reason}`);
  }
  const result = engine.handView().result;
  if (!result) throw new Error('judge: hand did not settle');
  return {
    winners: result.winners.map((w) => w.seatIndex).sort((a, b) => a - b),
    hands: result.showdown
      .map((h) => ({ seatIndex: h.seatIndex, rankClass: h.rankClass, label: handLabelKey(h.rankClass, h.bestFive), bestFive: h.bestFive }))
      .sort((a, b) => a.seatIndex - b.seatIndex),
  };
}
