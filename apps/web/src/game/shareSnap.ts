/**
 * What a share image of a replay step shows, taken once when it is asked for and kept as it is while the image is made
 * (the replay moving on meanwhile changes nothing in it). It holds only what that step of the replay shows — its
 * TableView: the viewer's own cards, the cards the record shows face up at the showdown, the board dealt so far, the
 * payout — and what the steps up to it did. It never reads the hand's record past the step (a player's hole cards there
 * included), so an image can show no card the replay does not and nothing of a later step.
 */
import { handLabelKey, type Card, type PublicRole, type VipColor } from '@jc/types';
import { formatChips } from '@jc/ui';
import type { MsgKey } from '../lib/i18n';
import { replayPhase, type ReplayInput, type ReplayLinePart, type ReplayPhase, type ReplayStep } from './replay';

export const SHARE_TEMPLATES = ['classic', 'summary', 'highlight', 'minimal'] as const;
export type ShareTemplate = (typeof SHARE_TEMPLATES)[number];
export const SHARE_RATIOS = ['1:1', '4:5', '9:16', '16:9'] as const;
export type ShareRatio = (typeof SHARE_RATIOS)[number];
/** The image's size at the standard resolution (px); the high one doubles it. */
export const SHARE_SIZES: Record<ShareRatio, { w: number; h: number }> = {
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
};
export const SHARE_FORMATS = ['png', 'webp'] as const;
export type ShareFormat = (typeof SHARE_FORMATS)[number];

export interface ShareOptions {
  template: ShareTemplate;
  ratio: ShareRatio;
  scale: 1 | 2;
  format: ShareFormat;
  /** Nicknames, or "Seat 3" and "You" in their place. */
  names: boolean;
  /** What was done so far: the step's street (classic) or every street (summary). */
  log: boolean;
  winAmount: boolean;
  /** The table theme's felt and colours, or plain dark. */
  background: 'felt' | 'plain';
}

export const SHARE_DEFAULTS: ShareOptions = { template: 'classic', ratio: '1:1', scale: 1, format: 'png', names: true, log: true, winAmount: true, background: 'felt' };

/** An amount in full ("1,234,567") and short ("1.2M") for where the full one cannot fit: never cut off. */
export interface ShareAmount {
  /** In chips (a chip's colour). */
  n: number;
  full: string;
  short: string;
}

export interface ShareSeat {
  seat: number;
  /** Its place clockwise from the bottom seat (the viewer's, or seat 0). */
  place: number;
  nickname: string;
  /** What stands in for the nickname when names are off: "You", "Seat 3". */
  label: string;
  role?: PublicRole;
  vip?: VipColor;
  bot: boolean;
  hero: boolean;
  folded: boolean;
  allIn: boolean;
  stack: ShareAmount;
  /** Chips put in on this street. */
  bet: ShareAmount | null;
  /** Its last action on this street, in words ("Raise"). */
  action: string | null;
  actionType: string | null;
  /** The cards as the step shows them: faces, backs (null: dealt but not shown) or none (folded). */
  cards: (Card | null)[];
  button: boolean;
  /** Won at this step (the payout), main and side pots together. */
  win: ShareAmount | null;
  /** The hand it showed and its best five, where the step shows them. */
  rank: string | null;
  best: Card[];
}

/** A line of what was done, with the players' nicknames and with "You" and "Seat 3" in their place. */
export interface ShareLine {
  named: string;
  anon: string;
}

export interface ShareSnap {
  handNumber: number;
  phase: ReplayPhase;
  /** For the file's name, in English whatever the language: "Preflop" … "Result". */
  phaseFile: string;
  phaseLabel: string;
  /** What this step did. */
  stepLine: ShareLine;
  /** What the steps up to this one did, street by street (actions, shown hands, wins; not the deal or the board). */
  log: { phase: ReplayPhase; label: string; lines: ShareLine[] }[];
  board: Card[];
  /** The first winner's best five, which the board highlights at the payout. */
  best: Card[];
  pot: ShareAmount;
  blinds: string | null;
  maxSeats: number;
  /** Every taken seat, in seat order. */
  seats: ShareSeat[];
  /** The payout's winners, main pot first (none before it, or for a hand recorded without pots and nobody up). */
  winners: number[];
  text: {
    hand: string;
    pot: string;
    board: string;
    myHand: string;
    shown: string;
    winner: string;
    split: string;
    actions: string;
    noShowdown: string;
    folded: string;
    allIn: string;
    /** "+{n} more", the {n} filled in where it is drawn. */
    more: string;
  };
}

const PHASE_FILE: Record<ReplayPhase, string> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown', result: 'Result' };

type Translate = (key: MsgKey, vars?: Record<string, string | number>) => string;

/**
 * The share image's content for `steps[index]`. `say` puts a part of a step's line in the words the replay reads out
 * (HandReplay's), with the player names `name` gives.
 */
export function shareSnap(o: {
  hand: ReplayInput;
  steps: readonly ReplayStep[];
  index: number;
  heroSeat: number | null;
  say: (part: ReplayLinePart, name: (seat: number) => string) => string;
  fmt: (chips: number, compact?: boolean) => string;
  t: Translate;
}): ShareSnap {
  const { hand, steps, heroSeat, fmt, t } = o;
  const index = Math.max(0, Math.min(steps.length - 1, o.index));
  const step = steps[index]!;
  const view = step.view;
  const h = view.hand;
  const phase = replayPhase(step);
  const amount = (n: number): ShareAmount => ({ n, full: fmt(n), short: fmt(n, true) });
  const phaseName = (p: ReplayPhase) => (p === 'result' ? t('replay.result') : t(`stage.${p}` as MsgKey));
  const result = h?.result ?? null;
  const shown = new Map((result?.showdown ?? []).map((x) => [x.seatIndex, x]));
  const winners = step.kind === 'result' ? (result?.winners ?? []) : [];
  const won = new Map<number, number>();
  for (const w of winners) won.set(w.seatIndex, (won.get(w.seatIndex) ?? 0) + w.amount);
  const anchor = heroSeat ?? 0;
  const n = view.table.maxSeats;
  const nick = (seat: number) => hand.players.find((p) => p.seatIndex === seat)?.nickname ?? `#${seat + 1}`;
  const label = (seat: number) => (seat === heroSeat ? t('shareImg.you') : t('shareImg.seat', { n: seat + 1 }));
  const line = (part: ReplayLinePart): ShareLine => ({ named: o.say(part, nick), anon: o.say(part, label) });

  const seats = view.seats
    .filter((s) => s.state !== 'empty')
    .map((s): ShareSeat => {
      const x = shown.get(s.seatIndex);
      const w = won.get(s.seatIndex);
      const hero = s.seatIndex === heroSeat;
      return {
        seat: s.seatIndex,
        place: (s.seatIndex - anchor + n) % n,
        nickname: s.nickname ?? `#${s.seatIndex + 1}`,
        label: label(s.seatIndex),
        ...(s.role ? { role: s.role } : {}),
        ...(s.vip && !s.role ? { vip: s.vip } : {}),
        bot: !!s.bot,
        hero,
        folded: s.state === 'folded',
        allIn: s.state === 'allin',
        stack: amount(s.stack),
        bet: s.streetBet > 0 ? amount(s.streetBet) : null,
        action: s.lastAction ? t(`action.${s.lastAction.type}` as MsgKey) : null,
        actionType: s.lastAction?.type ?? null,
        // Only what the step's view holds: its face-up cards, or backs for a hand still in.
        cards: s.holeCards && s.holeCards.length > 0 ? [...s.holeCards] : s.hasCards ? [null, null] : [],
        button: h?.buttonSeat === s.seatIndex,
        win: w !== undefined && w > 0 ? amount(w) : null,
        rank: x && s.holeCards ? t(`hand.${handLabelKey(x.rankClass, x.bestFive)}` as MsgKey) : null,
        best: x && s.holeCards ? [...x.bestFive] : [],
      };
    });

  // Street by street, up to and with this step: the actions, the hands shown and the wins.
  const log: ShareSnap['log'] = [];
  for (let k = 0; k <= index; k++) {
    const s = steps[k]!;
    const p = replayPhase(s);
    const lines = s.line.filter((part) => part.kind === 'act' || part.kind === 'shows' || part.kind === 'wins').map(line);
    if (lines.length === 0) continue;
    const last = log.at(-1);
    if (last?.phase === p) last.lines.push(...lines);
    else log.push({ phase: p, label: phaseName(p), lines });
  }

  const first = winners[0];
  const firstShown = first ? shown.get(first.seatIndex) : undefined;
  const said = step.line.map(line);
  const join = (k: keyof ShareLine) => (said.length > 0 ? said.map((x) => x[k]).join(' · ') : step.kind === 'result' ? t('replay.step.result') : '');
  return {
    handNumber: hand.handNumber,
    phase,
    phaseFile: PHASE_FILE[phase],
    phaseLabel: phaseName(phase),
    stepLine: { named: join('named'), anon: join('anon') },
    log,
    board: [...(h?.board ?? [])],
    best: firstShown ? [...firstShown.bestFive] : [],
    pot: amount(h?.potTotal ?? 0),
    blinds: hand.smallBlind !== null && hand.bigBlind !== null ? t('replay.blinds', { sb: formatChips(hand.smallBlind), bb: formatChips(hand.bigBlind) }) : null,
    maxSeats: n,
    seats,
    winners: [...new Set(winners.map((w) => w.seatIndex))],
    text: {
      hand: t('replay.hand', { n: hand.handNumber }),
      pot: t('table.pot'),
      board: t('shareImg.board'),
      myHand: t('shareImg.myHand'),
      shown: t('shareImg.shown'),
      winner: t('shareImg.winner'),
      split: t('shareImg.split'),
      actions: t('shareImg.actions'),
      noShowdown: t('shareImg.noShowdown'),
      folded: t('table.folded'),
      allIn: t('action.allin'),
      more: t('shareImg.more', { n: '{n}' }),
    },
  };
}

/** "JC-ROYAL_Hand-12345_Showdown.png": the hand's number and the part of it, nothing about who played. */
export function shareFileName(snap: Pick<ShareSnap, 'handNumber' | 'phaseFile'>, format: ShareFormat): string {
  const n = Number.isSafeInteger(snap.handNumber) && snap.handNumber >= 0 ? snap.handNumber : 0;
  return `JC-ROYAL_Hand-${n}_${snap.phaseFile}.${format}`;
}
