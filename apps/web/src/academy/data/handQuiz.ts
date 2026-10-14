/**
 * Lesson 2 quizzes. Compare questions are judged by a real HandEngine showdown
 * (see quiz.judgeCompare); the `explain` text is checked against the engine's
 * verdict in the unit tests so the copy can never contradict the rules.
 */
import type { Card, HandLabelKey } from '@jc/types';
import { l } from '../content';
import { HAND_RANKS } from './hands';
import { handLabelOf, handStrength, type ChoiceQuestion, type CompareQuestion, type SortQuestion } from '../quiz';

const c = (s: string) => s.split(' ') as Card[];

export const COMPARE_QUESTIONS: (CompareQuestion & { expect: 'a' | 'b' | 'split' })[] = [
  {
    kind: 'compare', id: 'h-pair-vs-2pair', expect: 'b',
    prompt: l('원페어 vs 투페어', 'One pair vs two pair'),
    board: c('Kd 9c 6h 3s 2d'), a: c('Ks Qh'), b: c('9s 6c'),
    explain: l('B는 보드의 9·6과 짝을 이뤄 투페어, A는 K 원페어입니다. 투페어가 원페어보다 강합니다.', 'B pairs both the 9 and the 6 for two pair; A has one pair of Kings. Two pair wins.'),
  },
  {
    kind: 'compare', id: 'h-flush-vs-straight', expect: 'b',
    prompt: l('스트레이트 vs 플러시', 'Straight vs flush'),
    board: c('Th 9h 8c 2h 4s'), a: c('Jd 7s'), b: c('Ah 5h'),
    explain: l('A는 7-8-9-10-J 스트레이트, B는 하트 5장으로 플러시입니다. 플러시가 스트레이트보다 강합니다.', 'A has a 7-to-J straight; B has five hearts, a flush. A flush beats a straight.'),
  },
  {
    kind: 'compare', id: 'h-boat-vs-quads', expect: 'b',
    prompt: l('풀하우스 vs 포카드', 'Full house vs four of a kind'),
    board: c('Qs Qd 7c 7h 2s'), a: c('Qc 3d'), b: c('7s 7d'),
    explain: l('A는 Q 풀하우스, B는 7 포카드입니다. 숫자는 낮아도 포카드가 풀하우스를 이깁니다.', 'A has Queens full of sevens; B has four sevens. Four of a kind beats a full house, whatever the ranks.'),
  },
  {
    kind: 'compare', id: 'h-higher-pair', expect: 'a',
    prompt: l('같은 족보: 원페어끼리', 'Same rank class: pair vs pair'),
    board: c('Ad 9s 6c 4h 2d'), a: c('Ks Kh'), b: c('Qs Qc'),
    explain: l('둘 다 원페어지만 K 페어가 Q 페어보다 높습니다.', 'Both have one pair; Kings beat Queens.'),
  },
  {
    kind: 'compare', id: 'h-kicker', expect: 'a',
    prompt: l('킥커 비교', 'Kicker battle'),
    board: c('Ah 9c 7d 4s 2c'), a: c('As Kd'), b: c('Ac Qh'),
    explain: l('둘 다 A 원페어입니다. 다음으로 높은 카드(킥커)가 K인 A가 Q인 B를 이깁니다.', 'Both have a pair of Aces. The next card decides: A’s King kicker beats B’s Queen.'),
  },
  {
    kind: 'compare', id: 'h-flush-high', expect: 'a',
    prompt: l('플러시끼리: 높은 카드', 'Flush vs flush'),
    board: c('Kh 9h 5h 2c 3d'), a: c('Ah 4h'), b: c('Qh Jh'),
    explain: l('둘 다 하트 플러시입니다. 가장 높은 카드부터 비교하면 A(A-K-9-5-4)가 B(K-Q-J-9-5)보다 높습니다.', 'Both have heart flushes. Compared from the top, A-K-9-5-4 beats K-Q-J-9-5.'),
  },
  {
    kind: 'compare', id: 'h-straight-top', expect: 'b',
    prompt: l('스트레이트끼리: 최고 카드', 'Straight vs straight'),
    board: c('9d 8s 7c 2h Kd'), a: c('6h 5s'), b: c('Th Jc'),
    explain: l('A는 5-9 스트레이트(9 하이), B는 7-J 스트레이트(J 하이)입니다. 최고 카드가 높은 B가 이깁니다.', 'A has 5-to-9 (nine high); B has 7-to-J (jack high). The higher top card wins.'),
  },
  {
    kind: 'compare', id: 'h-boat-trips-first', expect: 'a',
    prompt: l('풀하우스끼리: 트리플 먼저', 'Full house vs full house'),
    board: c('Kc Kd 5s 5h 9c'), a: c('Kh 2s'), b: c('5c 9d'),
    explain: l('A는 K-K-K-5-5, B는 5-5-5-K-K 입니다. 풀하우스는 트리플 숫자를 먼저 비교하므로 A가 이깁니다.', 'A has K-K-K-5-5, B has 5-5-5-K-K. Full houses compare the three of a kind first, so A wins.'),
  },
  {
    kind: 'compare', id: 'h-board-plays', expect: 'split',
    prompt: l('정확히 무승부가 되는 상황', 'An exact tie'),
    board: c('8c 8d 4s 4h Ac'), a: c('Kd 2s'), b: c('Qd Jh'),
    explain: l('둘 다 보드의 8·4 투페어 + A 킥커를 씁니다. 홀카드가 쓰이지 않아 팟을 나눕니다(스플릿).', 'Both play the board: eights and fours with an Ace kicker. Neither hole card plays, so the pot is split.'),
  },
  {
    kind: 'compare', id: 'h-royal-board', expect: 'split',
    prompt: l('보드에 로열 플러시', 'Royal flush on the board'),
    board: c('As Ks Qs Js Ts'), a: c('2c 3d'), b: c('9h 8h'),
    explain: l('보드 5장이 로열 플러시라 두 사람 모두 같은 패입니다. 무승부입니다.', 'The board itself is a royal flush, so both players have it. Split pot.'),
  },
  {
    kind: 'compare', id: 'h-high-card', expect: 'a',
    prompt: l('하이카드끼리', 'High card vs high card'),
    board: c('Kc 9d 6s 3h 2c'), a: c('Ah 5d'), b: c('Qd Jh'),
    explain: l('아무도 페어가 없습니다. 가장 높은 카드가 A인 A가 이깁니다.', 'Nobody pairs. A has the highest card, an Ace.'),
  },
];

function nameQuestion(id: string, cards: Card[], options: HandLabelKey[]): ChoiceQuestion {
  return {
    kind: 'choice',
    id,
    prompt: l('이 다섯 장의 족보는 무엇일까요?', 'What hand do these five cards make?'),
    cards,
    options: options.map((k) => {
      const info = HAND_RANKS.find((h) => h.key === k)!;
      return { id: k, label: l(info.ko, info.en) };
    }),
    answer: handLabelOf(cards),
    why: l('카드의 숫자가 몇 장씩 같은지, 문양이 모두 같은지, 숫자가 이어지는지 차례로 확인해 보세요.', 'Check in turn: how many cards share a rank, whether all suits match, and whether the ranks run in order.'),
    explain: l('위에서부터 차례로 확인하면 빠르게 찾을 수 있습니다.', 'Work down the ranking list and stop at the first that fits.'),
  };
}

export const NAME_QUESTIONS: ChoiceQuestion[] = [
  nameQuestion('h-name-boat', c('Jc Jd Jh 4s 4c'), ['three-of-a-kind', 'full-house', 'two-pair', 'four-of-a-kind']),
  nameQuestion('h-name-wheel', c('5d 4c 3h 2s Ad'), ['high-card', 'straight', 'flush', 'pair']),
  nameQuestion('h-name-flush', c('Kd 9d 7d 4d 2d'), ['straight', 'flush', 'straight-flush', 'high-card']),
];

export const HAND_SORT: SortQuestion = {
  kind: 'sort',
  id: 'h-sort',
  prompt: l('네 개의 패를 강한 순서대로 정렬하세요.', 'Sort the four hands from strongest to weakest.'),
  items: [c('Ts 9h 8d 7c 6s'), c('Kc Kd Kh 7s 7c'), c('Kh Kd 9c 9s 4h'), c('Ac Jc 8c 5c 2c')],
  strength: handStrength,
  explain: l('풀하우스 > 플러시 > 스트레이트 > 투페어.', 'Full house > flush > straight > two pair.'),
};
