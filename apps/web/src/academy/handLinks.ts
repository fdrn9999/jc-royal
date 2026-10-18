/**
 * Suggests Academy lessons for a finished real hand (My Page → hand detail):
 * a side pot links to the side-pot lesson, a split to tie rules, and so on.
 * Engine-free so it can live in the main bundle.
 */
import { l, type L } from './content';

export interface ReviewedHand {
  board: string[];
  actions: { seatIndex: number; stage: string; type: string; amount: number }[];
  players: { seatIndex: number; isYou: boolean; won: number; rankClass: string | null; stackStart: number }[];
  /** The pots as paid (absent for hands recorded before pots were stored). */
  pots?: { uncalled: boolean; winners: { seatIndex: number; amount: number }[] }[] | null;
}

export interface LessonLink {
  id: 'side-pot' | 'split' | 'showdown' | 'fold' | 'no-showdown' | 'all-in' | 'call';
  to: string;
  title: L;
  why: L;
}

export function lessonLinksFor(h: ReviewedHand): LessonLink[] {
  const out: LessonLink[] = [];
  const me = h.players.find((p) => p.isYou);
  const allIns = h.actions.filter((a) => a.type === 'allin');
  // Chips nobody called, handed back, are no win: a covering all-in that lost the showdown is no split.
  const back = new Map<number, number>();
  for (const pot of h.pots ?? []) if (pot.uncalled) for (const w of pot.winners) back.set(w.seatIndex, (back.get(w.seatIndex) ?? 0) + w.amount);
  const winners = h.players.filter((p) => p.won - (back.get(p.seatIndex) ?? 0) > 0);
  const showdown = h.players.filter((p) => p.rankClass);
  // A side pot needs an all-in for less than what at least two others kept betting.
  const shortAllIn = allIns.some((a) => {
    const stack = h.players.find((p) => p.seatIndex === a.seatIndex)?.stackStart ?? 0;
    return h.players.filter((p) => p.seatIndex !== a.seatIndex && p.stackStart > stack).length >= 2;
  });
  if (shortAllIn) out.push({ id: 'side-pot', to: '/academy/actions?step=2', title: l('사이드 팟', 'Side pots'), why: l('스택이 적은 플레이어가 올인해 팟이 나뉘었습니다.', 'A short stack went all-in, so the pot was split into main and side pots.') });
  else if (allIns.length) out.push({ id: 'all-in', to: '/academy/actions?step=0', title: l('올인', 'All-in'), why: l('이 핸드에서 올인이 나왔습니다.', 'Someone went all-in in this hand.') });
  if (winners.length >= 2 && showdown.length >= 2) out.push({ id: 'split', to: '/academy/hands?step=3', title: l('무승부(스플릿)', 'Split pots'), why: l('여러 명이 팟을 나눠 가졌습니다.', 'The pot was shared between players.') });
  if (showdown.length >= 2) out.push({ id: 'showdown', to: '/academy/hands?step=1', title: l('족보 비교', 'Comparing hands'), why: l('쇼다운에서 패를 비교했습니다.', 'Hands were compared at showdown.') });
  else if (winners.length === 1) out.push({ id: 'no-showdown', to: '/academy/holdem?step=0', title: l('쇼다운 없는 승리', 'Winning without a showdown'), why: l('나머지가 모두 폴드해 쇼다운 없이 끝났습니다.', 'Everyone else folded, so there was no showdown.') });
  if (me && h.actions.some((a) => a.seatIndex === me.seatIndex && a.type === 'call')) {
    out.push({ id: 'call', to: '/academy/practice/B', title: l('콜 연습', 'Calling practice'), why: l('이 핸드에서 콜했습니다. 콜할 때 얼마를 더 내는지 연습해 보세요.', 'You called here; practise how much a call adds.') });
  }
  if (me && h.actions.some((a) => a.seatIndex === me.seatIndex && (a.type === 'fold' || a.type === 'timeout-fold'))) {
    out.push({ id: 'fold', to: '/academy/practice/D', title: l('폴드 연습', 'Folding practice'), why: l('이 핸드에서 폴드했습니다. 폴드한 칩이 어떻게 되는지 연습해 보세요.', 'You folded here; see what happens to chips already in.') });
  }
  return out;
}
