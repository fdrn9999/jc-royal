import type { Card, HandRankClass } from './cards';

/** Seat counts poker-engine-ts supports (SessionConfig.maxSeats). */
export const SUPPORTED_MAX_SEATS = [2, 6, 9] as const;
export type MaxSeats = (typeof SUPPORTED_MAX_SEATS)[number];

export type HandStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'settled';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

/**
 * What a player chose to do on their next turn of the current street while waiting for others. The room carries it
 * out only while it still fits: `check` only as a check (a bet in the meantime cancels it), `checkFold` checks or else
 * folds, `fold` folds a bet but never a free check. Calls, raises and all-ins are never chosen in advance.
 */
export type PreActionKind = 'check' | 'checkFold' | 'fold';

/** Legal option for the viewer, already normalised for the UI. */
export type LegalOption =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call'; amount: number }
  /** bet/raise amounts are "to" totals for the current street. */
  | { type: 'bet'; min: number; max: number }
  | { type: 'raise'; min: number; max: number }
  | { type: 'allin'; amount: number };

export type SeatState = 'empty' | 'waiting' | 'active' | 'folded' | 'allin' | 'sittingOut';

export interface SeatView {
  seatIndex: number;
  state: SeatState;
  userId?: string;
  nickname?: string;
  avatarUrl?: string | null;
  stack: number;
  /** Chips committed on the current street. */
  streetBet: number;
  connected: boolean;
  lastAction?: { type: ActionType; amount: number } | null;
  /** True when this seat holds cards in the current hand. */
  hasCards: boolean;
  /** Only present for the viewer's own seat or cards revealed at showdown. */
  holeCards?: Card[] | null;
}

export interface PotView {
  id: string;
  amount: number;
  eligibleSeats: number[];
}

export interface HandResultView {
  winners: { seatIndex: number; amount: number; potIds: string[] }[];
  showdown: { seatIndex: number; cards: Card[]; rankClass: HandRankClass; bestFive: Card[] }[];
}

export interface HandView {
  id: string;
  number: number;
  /** Engine event sequence; action messages must echo it (stale views are rejected). */
  seq: number;
  stage: HandStage;
  buttonSeat: number;
  sbSeat: number | null;
  bbSeat: number | null;
  board: Card[];
  pots: PotView[];
  potTotal: number;
  actorSeat: number | null;
  /** Epoch ms when the current actor times out. */
  deadline: number | null;
  result: HandResultView | null;
}

export interface TableConfigView {
  id: string;
  name: string;
  maxSeats: MaxSeats;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  turnSeconds: number;
  allowSpectators: boolean;
  isPrivate: boolean;
  roomType: 'official' | 'member';
  /** The member who opened a member room; null for official tables. */
  hostId: string | null;
}

export interface TableView {
  version: number;
  table: TableConfigView;
  status: 'waiting' | 'playing' | 'closing' | 'closed';
  seats: SeatView[];
  hand: HandView | null;
  spectatorCount: number;
  /** Nicknames in waitlist order. */
  waitlist: string[];
  /** A freed seat held for the head of the waitlist. */
  reservation: { nickname: string; until: number } | null;
  /** Epoch ms when the next hand is scheduled, if any. */
  nextHandAt: number | null;
  you: {
    userId: string;
    seatIndex: number | null;
    legal: LegalOption[];
    sittingOut: boolean;
    /** Leaving after the current hand. */
    leaving: boolean;
    inWaitlist: boolean;
    canSit: boolean;
    /** A private table this connection has no valid join code for: sitting and the waitlist need one first. */
    needsCode: boolean;
    /** A top-up waiting for the current hand to end; nothing is taken from the wallet until then. */
    topUpQueued: number | null;
    /** Automatic rebuy for this seat (off unless the player turned it on): chips per rebuy, total limit, used so far. */
    autoRebuy: { amount: number; cap: number; spent: number } | null;
    /** The viewer's own pre-action for this street (nobody else is ever shown it). Absent from older rooms. */
    preAction?: PreActionKind | null;
    /** The seated viewer's auto-muck setting as the room holds it; null when not seated. Absent from older rooms. */
    autoMuck?: boolean | null;
  };
}

/** Animation / sound cues derived from server state changes. Never authoritative. */
export type TableCue =
  | { kind: 'handStart'; handNumber: number }
  | { kind: 'deal' }
  | { kind: 'action'; seatIndex: number; type: ActionType; amount: number }
  | { kind: 'street'; stage: 'flop' | 'turn' | 'river'; cards: Card[] }
  | { kind: 'showdown' }
  | { kind: 'payout'; seatIndex: number; amount: number }
  | { kind: 'handEnd' }
  | { kind: 'seat'; seatIndex: number; nickname: string }
  | { kind: 'leave'; seatIndex: number };
