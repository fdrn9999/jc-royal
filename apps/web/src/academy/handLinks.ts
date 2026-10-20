/**
 * Suggests Academy lessons for a finished real hand (My Page → hand detail):
 * a side pot links to the side-pot lesson, a split to tie rules, and so on;
 * a spot the public actions show (a bet faced, a 3-bet, a big blind facing
 * an open) to the advanced course's topic on it. No hidden card is read.
 * Engine-free so it can live in the main bundle.
 */
import { potOddsFor } from '../game/potOdds';
import { l, type L } from './content';

export interface ReviewedHand {
  board: string[];
  actions: { seatIndex: number; stage: string; type: string; amount: number }[];
  players: { seatIndex: number; isYou: boolean; won: number; rankClass: string | null; stackStart: number }[];
  /** The pots as paid (absent for hands recorded before pots were stored). */
  pots?: { uncalled: boolean; winners: { seatIndex: number; amount: number }[] }[] | null;
}

export interface LessonLink {
  id: 'side-pot' | 'split' | 'showdown' | 'fold' | 'no-showdown' | 'all-in' | 'call' | 'pot-odds' | 'three-bet' | 'bb-defense';
  to: string;
  title: L;
  why: L;
}

/** Past this many the panel is a list to scroll by, not a suggestion. */
const MAX_LINKS = 6;

/**
 * The viewer's preflop spots as the action list tells them: a raise raised again while the viewer still had cards
 * (blinds are no raise), and the viewer's first choice from the big blind facing one open raise that nobody called.
 */
function spotsOf(actions: ReviewedHand['actions'], seat: number) {
  const out = { threeBet: false, bbDefense: false };
  const bigBlind = actions.some((a) => a.type === 'post-bb' && a.seatIndex === seat);
  const put = new Map<number, number>();
  let stage = '';
  let bet = 0;
  let raises = 0;
  let calls = 0;
  let folded = false;
  let chose = false;
  for (const a of actions) {
    if (a.stage !== stage) {
      stage = a.stage;
      put.clear();
      bet = 0;
    }
    const before = put.get(a.seatIndex) ?? 0;
    const to = before + a.amount;
    put.set(a.seatIndex, to);
    if (a.type === 'post-sb' || a.type === 'post-bb') {
      bet = Math.max(bet, to);
      continue;
    }
    const mine = a.seatIndex === seat;
    const raise = a.type === 'bet' || a.type === 'raise' || (a.type === 'allin' && to > bet);
    if (stage === 'preflop') {
      if (mine && !chose) {
        chose = true;
        out.bbDefense = bigBlind && raises === 1 && calls === 0 && ['call', 'raise', 'allin', 'fold'].includes(a.type);
      }
      if (raise && ++raises === 2 && !folded) out.threeBet = true;
      if (!raise && (a.type === 'call' || a.type === 'allin')) calls++;
      if (mine && (a.type === 'fold' || a.type === 'timeout-fold')) folded = true;
    }
    if (raise) bet = to;
  }
  return out;
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
  // Study topics of the advanced course, the most particular first: the course's own teaching examples, not a verdict on the hand.
  const spots = me ? spotsOf(h.actions, me.seatIndex) : null;
  if (spots?.bbDefense) out.push({ id: 'bb-defense', to: '/academy/gto/hands?id=bb-86s', title: l('빅 블라인드 방어', 'Defending the big blind'), why: l('빅 블라인드에서 오픈 레이즈 하나를 마주했습니다. 이미 낸 블라인드가 콜 가격을 어떻게 바꾸는지 학습용 예시로 살펴보세요.', 'You faced a single open raise from the big blind; see in a teaching example how the blind already in changes the price of a call.') });
  if (spots?.threeBet) out.push({ id: 'three-bet', to: '/academy/gto/ranges?step=1', title: l('3벳과 레인지', '3-bets and ranges'), why: l('프리플랍에서 레이즈에 다시 레이즈(3벳)가 나왔습니다. 그 액션을 할 만한 핸드 전체(레인지)를 매트릭스로 그려 보세요.', 'Preflop, a raise was raised again (a 3-bet); picture every hand that would take that line, its range, on the matrix.') });
  // The same decisions the hand page shows pot odds for: a call or fold facing a bet.
  if (potOddsFor(h).size) out.push({ id: 'pot-odds', to: '/academy/gto/math?step=0', title: l('팟 오즈 계산', 'Working out pot odds'), why: l('베팅을 마주하고 콜이나 폴드를 정했습니다. 콜에 필요한 승률을 계산 도구로 직접 구해 보세요.', 'You faced a bet and called or folded; work out the equity a call needs with the calculator.') });
  if (me && h.actions.some((a) => a.seatIndex === me.seatIndex && a.type === 'call')) {
    out.push({ id: 'call', to: '/academy/practice/B', title: l('콜 연습', 'Calling practice'), why: l('이 핸드에서 콜했습니다. 콜할 때 얼마를 더 내는지 연습해 보세요.', 'You called here; practise how much a call adds.') });
  }
  if (me && h.actions.some((a) => a.seatIndex === me.seatIndex && (a.type === 'fold' || a.type === 'timeout-fold'))) {
    out.push({ id: 'fold', to: '/academy/practice/D', title: l('폴드 연습', 'Folding practice'), why: l('이 핸드에서 폴드했습니다. 폴드한 칩이 어떻게 되는지 연습해 보세요.', 'You folded here; see what happens to chips already in.') });
  }
  return out.slice(0, MAX_LINKS);
}
