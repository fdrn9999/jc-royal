/**
 * A table bot's manners once a hand ends (room.ts settle). Now and then it turns over the cards of a pot it took with
 * no showdown — a bluff that worked, or a big hand nobody paid — and, rarely, sends a quick reaction after a big pot:
 * a light taunt after a bluff shown or a big win, a sigh or a 'gg' after a big loss. How often comes from its style,
 * held back as its level rises (an expert mostly keeps quiet).
 *
 * Decided by the room from the bot's own cards, the board and the result the table saw, after the hand is settled: it
 * changes nothing about the result, the stacks, the record or the ledger, and takes no time (no wait is added between
 * hands). A hand that went to showdown is left as the rules turned it over: a losing hand the rules let it muck stays
 * mucked. What it shows goes the way a member's shown cards go (muck.ts): to the table until the next deal, not into the
 * hand history or the replay.
 *
 * Reactions follow the table's social policy (none while quick reactions are off) and the members' own setting (a page
 * with quick reactions off shows none). At most one bot reacts per hand, BOT_REACT_GAP_MS apart at a table and
 * BOT_REACT_HANDS hands apart for one bot, and a bot never sends the same one twice running.
 */
import { readHand, startingScore } from '@jc/poker-engine';
import type { BotLevel, BotStyle, Card, ReactionId } from '@jc/types';
import type { ShowChoice } from './muck';

/** How often a style shows a pot it took uncontested (of the hands worth showing), and reacts to a big pot. */
export const MANNERS: Record<BotStyle, { show: number; react: number }> = {
  balanced: { show: 0.05, react: 0.06 },
  tag: { show: 0.04, react: 0.05 },
  lag: { show: 0.12, react: 0.1 },
  'tight-passive': { show: 0.02, react: 0.03 },
  'loose-passive': { show: 0.05, react: 0.06 },
  casual: { show: 0.2, react: 0.15 },
};

/** The level scales both: an easy bot is a little more showy, an expert holds back. */
export const MANNERS_LEVEL: Record<BotLevel, number> = { easy: 1.2, normal: 1, hard: 0.8, expert: 0.6 };

/** At least this long between two bot reactions at one table. */
export const BOT_REACT_GAP_MS = 45_000;
/** At least this many hands between two reactions from one bot. */
export const BOT_REACT_HANDS = 5;
/** A pot is big from this many big blinds won or lost. */
export const BIG_POT_BB = 25;
/** Nothing is shown from a pot smaller than this (a walk, a steal of the blinds). */
const SHOW_POT_BB = 4;

/** What the table saw of one bot's hand, with its own cards. */
export interface MannersHand {
  hole: readonly Card[];
  board: readonly Card[];
  bigBlind: number;
  potTotal: number;
  /** Its chips won (net) this hand: below 0 for a loss. */
  net: number;
  wentToShowdown: boolean;
  /** Its cards were face up at showdown. */
  shown: boolean;
}

/** The room's memory of bot reactions (in memory only: a restart starts it again). */
export interface MannersMemory {
  /** Each bot's last reaction and the hand it came after. */
  last: Map<string, { hand: number; reaction: ReactionId }>;
  /** When a bot at the table last reacted. */
  tableAt: number;
}

export const emptyManners = (): MannersMemory => ({ last: new Map(), tableAt: Number.NEGATIVE_INFINITY });

export interface Manners {
  show: ShowChoice | null;
  reaction: ReactionId | null;
}

/**
 * Worth showing a pot taken uncontested: a bluff (nothing made, or a weak start before the flop) or a strong hand (top
 * pair or better, or a strong start).
 */
export function showKind(hole: readonly Card[], board: readonly Card[]): 'bluff' | 'strong' | null {
  if (board.length >= 3) {
    const r = readHand(hole, board);
    return r.made === 0 ? 'bluff' : r.made >= 2 ? 'strong' : null;
  }
  const s = startingScore(hole);
  return s <= 5 ? 'bluff' : s >= 12 ? 'strong' : null;
}

/**
 * What one bot (playing at `play`'s level and style) does after hand number `hand`. `reactionsOn`: the table takes quick
 * reactions; `reactedThisHand`: a bot at the table has already reacted after this hand. Records the reaction it sends
 * in `memory`.
 */
export function botManners(
  botId: string,
  play: { level: BotLevel; style: BotStyle },
  h: MannersHand,
  hand: number,
  now: number,
  memory: MannersMemory,
  opts: { reactionsOn: boolean; reactedThisHand: boolean },
  rand: () => number,
): Manners {
  const k = MANNERS_LEVEL[play.level];
  const m = { show: MANNERS[play.style].show * k, react: MANNERS[play.style].react * k };
  const bb = Math.max(1, h.bigBlind);
  let show: ShowChoice | null = null;
  let bluffShown = false;
  // Only a pot it took with nobody left to show it to: never a hand the showdown decided.
  if (h.net > 0 && !h.wentToShowdown && !h.shown && h.potTotal >= SHOW_POT_BB * bb) {
    const kind = showKind(h.hole, h.board);
    if (kind && rand() < (kind === 'bluff' ? m.show : m.show * 0.6)) {
      show = 'both';
      bluffShown = kind === 'bluff';
    }
  }
  let pool: readonly ReactionId[] = [];
  if (bluffShown) pool = ['laugh', 'cool'];
  else if (h.net >= BIG_POT_BB * bb) pool = ['cool', 'fire'];
  else if (h.net <= -BIG_POT_BB * bb && h.wentToShowdown) pool = ['cry', 'gg'];
  const last = memory.last.get(botId);
  const ready = opts.reactionsOn && !opts.reactedThisHand && now - memory.tableAt >= BOT_REACT_GAP_MS && (!last || hand - last.hand >= BOT_REACT_HANDS);
  let reaction: ReactionId | null = null;
  if (ready && pool.length && rand() < (bluffShown ? m.react * 1.5 : m.react)) {
    const fresh = pool.filter((r) => r !== last?.reaction);
    reaction = fresh[Math.floor(rand() * fresh.length)] ?? null;
    if (reaction) {
      memory.last.set(botId, { hand, reaction });
      memory.tableAt = now;
    }
  }
  return { show, reaction };
}
