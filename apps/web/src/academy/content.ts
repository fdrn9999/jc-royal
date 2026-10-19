/**
 * Academy copy lives next to the lessons as { ko, en } pairs (the app-wide
 * dictionary in lib/i18n.tsx keeps UI chrome). `useTr` picks the active locale.
 */
import { evaluateKnown, rankValue, type Evaluation } from '@jc/poker-engine/evaluate';
import { handLabelKey, type Card } from '@jc/types';
import { useCallback } from 'react';
import { useI18n, type MsgKey } from '../lib/i18n';

export interface L {
  ko: string;
  en: string;
}

export const l = (ko: string, en: string): L => ({ ko, en });

export function useTr() {
  const { locale } = useI18n();
  return useCallback((x: L, vars?: Record<string, string | number>) => {
    let s = x[locale];
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  }, [locale]);
}

export const SUIT_INFO = {
  s: { glyph: '♠', name: l('스페이드', 'Spades'), red: false },
  h: { glyph: '♥', name: l('하트', 'Hearts'), red: true },
  d: { glyph: '♦', name: l('다이아몬드', 'Diamonds'), red: true },
  c: { glyph: '♣', name: l('클럽(클로버)', 'Clubs'), red: false },
} as const;
export type SuitCode = keyof typeof SUIT_INFO;

export const suitOf = (c: Card) => c[1] as SuitCode;
export const rankLabel = (c: Card | string) => (c[0] === 'T' ? '10' : c[0]!);

/** "A", "K" … "2" for a numeric rank value. */
export function valueLabel(v: number): string {
  return v === 14 || v === 1 ? 'A' : v === 13 ? 'K' : v === 12 ? 'Q' : v === 11 ? 'J' : String(v);
}

const SPOKEN: Record<string, L> = { A: l('에이스', 'Ace'), K: l('킹', 'King'), Q: l('퀸', 'Queen'), J: l('잭', 'Jack') };

/** Card name for screen readers and hints, e.g. "스페이드 에이스" / "Ace of Spades". */
export function cardName(c: Card, locale: 'ko' | 'en'): string {
  const suit = SUIT_INFO[suitOf(c)].name[locale].replace('(클로버)', '');
  const rank = SPOKEN[c[0]!]?.[locale] ?? rankLabel(c);
  return locale === 'ko' ? `${suit} ${rank}` : `${rank} of ${suit}`;
}

/** Short description of a made hand: "A 원페어", "K·7 투페어", "Flush, A high". */
export function describeHand(ev: Evaluation, locale: 'ko' | 'en', t: (k: MsgKey) => string): string {
  const [, a = 0, b = 0] = ev.score;
  const A = valueLabel(a);
  const B = valueLabel(b);
  const label = handLabelKey(ev.rankClass, ev.bestFive);
  const name = t(`hand.${label}` as MsgKey);
  if (locale === 'ko') {
    switch (label) {
      case 'royal-flush':
        return name;
      case 'straight-flush':
      case 'straight':
      case 'flush':
        return `${A} 하이 ${name}`;
      case 'full-house':
        return `${A} ${name} (${B} 페어)`;
      case 'two-pair':
        return `${A}·${B} ${name}`;
      case 'high-card':
        return `${A} ${name}`;
      default:
        return `${A} ${name}`;
    }
  }
  switch (label) {
    case 'royal-flush':
      return name;
    case 'straight-flush':
    case 'straight':
      return `${name} to ${A}`;
    case 'flush':
      return `${name}, ${A} high`;
    case 'full-house':
      return `${name}, ${A}s over ${B}s`;
    case 'two-pair':
      return `${name}, ${A}s and ${B}s`;
    case 'pair':
      return `Pair of ${A}s`;
    case 'three-of-a-kind':
      return `Three ${A}s`;
    case 'four-of-a-kind':
      return `Four ${A}s`;
    default:
      return `${A} high`;
  }
}

/** Current made hand from own hole cards and the revealed board only. */
export function currentHand(hole: readonly Card[] | null | undefined, board: readonly Card[]): Evaluation | null {
  if (!hole || hole.length !== 2) return null;
  return evaluateKnown([...hole, ...board]);
}

const POCKET_EN: Record<string, string> = { A: 'Aces', K: 'Kings', Q: 'Queens', J: 'Jacks', T: 'Tens', '9': 'Nines', '8': 'Eights', '7': 'Sevens', '6': 'Sixes', '5': 'Fives', '4': 'Fours', '3': 'Threes', '2': 'Twos' };

/**
 * A starting hand by its usual name, before the flop: "포켓 에이스" / "Pocket Aces", "A-K 수딧" / "A-K suited",
 * "A-K 오프수딧" / "A-K offsuit" (the higher card first). Null without two cards.
 */
export function startingHandName(hole: readonly Card[] | null | undefined, locale: 'ko' | 'en'): string | null {
  if (!hole || hole.length !== 2) return null;
  const [x, y] = [...hole].sort((a, b) => rankValue(b) - rankValue(a)) as [Card, Card];
  if (x[0] === y[0]) return locale === 'ko' ? `포켓 ${SPOKEN[x[0]!]?.ko ?? rankLabel(x)}` : `Pocket ${POCKET_EN[x[0]!]}`;
  const pair = `${rankLabel(x)}-${rankLabel(y)}`;
  const suited = x[1] === y[1];
  return locale === 'ko' ? `${pair} ${suited ? '수딧' : '오프수딧'}` : `${pair} ${suited ? 'suited' : 'offsuit'}`;
}

/** What the hand HUD says: the starting hand's name before the flop, the made hand after (describeHand). */
export function describeCurrent(hole: readonly Card[] | null | undefined, board: readonly Card[], locale: 'ko' | 'en', t: (k: MsgKey) => string): string | null {
  if (board.length === 0) return startingHandName(hole, locale);
  const ev = currentHand(hole, board);
  return ev ? describeHand(ev, locale, t) : null;
}

export { rankValue };
