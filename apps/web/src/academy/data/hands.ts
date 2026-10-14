/**
 * The ten hand rankings, strongest first. Kept free of engine imports: the
 * in-game hand chart uses it too. Each example is checked against the
 * evaluator in the unit tests (label and highlight groups).
 */
import type { Card, HandLabelKey } from '@jc/types';
import { l, type L } from '../content';

const c = (s: string) => s.split(' ') as Card[];

export interface HandRankInfo {
  key: HandLabelKey;
  ko: string;
  en: string;
  cards: Card[];
  /** Card indexes of the main group (gold) and, if any, the second group (blue). The rest are kickers. */
  main: number[];
  second?: number[];
  rule: L;
  caveat: L;
  example: L;
  beats: L;
}

export const HAND_RANKS: HandRankInfo[] = [
  {
    key: 'royal-flush',
    ko: '로열 플러시',
    en: 'Royal Flush',
    cards: c('As Ks Qs Js Ts'),
    main: [0, 1, 2, 3, 4],
    rule: l('같은 문양의 A-K-Q-J-10.', 'A-K-Q-J-10, all of one suit.'),
    caveat: l('가장 높은 스트레이트 플러시의 특별한 이름입니다. 문양 사이에 우열이 없어 두 로열 플러시는 무승부입니다.', 'It is simply the highest straight flush. Suits have no rank, so two royal flushes tie.'),
    example: l('♥A ♥K 를 들고 보드가 ♥Q ♥J ♥10 이면 로열 플러시.', 'Holding ♥A ♥K with ♥Q ♥J ♥10 on board.'),
    beats: l('모든 족보 중 가장 강합니다.', 'Beats every other hand.'),
  },
  {
    key: 'straight-flush',
    ko: '스트레이트 플러시',
    en: 'Straight Flush',
    cards: c('9h 8h 7h 6h 5h'),
    main: [0, 1, 2, 3, 4],
    rule: l('같은 문양으로 숫자 5장이 연속.', 'Five cards in a row, all of one suit.'),
    caveat: l('가장 높은 카드로 비교합니다. ♣5-4-3-2-A 는 5 하이로 가장 낮은 스트레이트 플러시입니다. Q-K-A-2-3 처럼 A를 넘어 이어지지는 않습니다.', 'Compared by the top card. 5-4-3-2-A is the lowest (5 high). Runs do not wrap around the Ace (Q-K-A-2-3 is not a straight).'),
    example: l('9 하이 스트레이트 플러시는 8 하이 스트레이트 플러시를 이깁니다.', 'A 9-high straight flush beats an 8-high one.'),
    beats: l('포카드보다 강하고 로열 플러시보다 약합니다.', 'Beats four of a kind; loses only to a higher straight flush.'),
  },
  {
    key: 'four-of-a-kind',
    ko: '포카드',
    en: 'Four of a Kind',
    cards: c('Qc Qd Qh Qs 7c'),
    main: [0, 1, 2, 3],
    rule: l('같은 숫자 4장.', 'Four cards of the same rank.'),
    caveat: l('포카드 숫자가 같으면(보드에 4장) 남은 1장, 킥커가 높은 쪽이 이깁니다.', 'If both share the same four (all on the board), the higher fifth card — the kicker — wins.'),
    example: l('Q 포카드 + 7 킥커.', 'Four Queens with a 7 kicker.'),
    beats: l('풀하우스보다 강합니다.', 'Beats a full house.'),
  },
  {
    key: 'full-house',
    ko: '풀하우스',
    en: 'Full House',
    cards: c('Kc Kd Kh 7s 7c'),
    main: [0, 1, 2],
    second: [3, 4],
    rule: l('같은 숫자 3장(트리플) + 같은 숫자 2장(페어).', 'Three of one rank plus a pair of another.'),
    caveat: l('트리플의 숫자를 먼저 비교하고, 같으면 페어를 비교합니다. Q-Q-Q-2-2 는 J-J-J-A-A 를 이깁니다.', 'Compare the three-of-a-kind first, then the pair: Q-Q-Q-2-2 beats J-J-J-A-A.'),
    example: l('K 풀하우스(7 페어): K-K-K-7-7.', 'Kings full of sevens: K-K-K-7-7.'),
    beats: l('플러시보다 강합니다.', 'Beats a flush.'),
  },
  {
    key: 'flush',
    ko: '플러시',
    en: 'Flush',
    cards: c('Ac Jc 8c 5c 2c'),
    main: [0, 1, 2, 3, 4],
    rule: l('같은 문양 5장 (숫자는 연속이 아니어도 됨).', 'Any five cards of one suit.'),
    caveat: l('플러시끼리는 가장 높은 카드부터 차례로 비교합니다. 문양 자체는 우열이 없습니다.', 'Flushes are compared card by card from the top. The suit itself never matters.'),
    example: l('A-J-8-5-2 플러시는 K-Q-J-9-7 플러시를 이깁니다.', 'A-J-8-5-2 beats K-Q-J-9-7.'),
    beats: l('스트레이트보다 강합니다.', 'Beats a straight.'),
  },
  {
    key: 'straight',
    ko: '스트레이트',
    en: 'Straight',
    cards: c('Ts 9h 8d 7c 6s'),
    main: [0, 1, 2, 3, 4],
    rule: l('숫자 5장이 연속 (문양은 상관없음).', 'Five ranks in a row, any suits.'),
    caveat: l('가장 높은 카드로 비교합니다. A-K-Q-J-10 이 가장 높고, 5-4-3-2-A 는 5 하이로 가장 낮습니다.', 'Compared by the top card. A-K-Q-J-10 is the best; 5-4-3-2-A is the lowest (5 high).'),
    example: l('10 하이 스트레이트: 10-9-8-7-6.', 'Ten-high straight: 10-9-8-7-6.'),
    beats: l('트리플보다 강합니다.', 'Beats three of a kind.'),
  },
  {
    key: 'three-of-a-kind',
    ko: '트리플',
    en: 'Three of a Kind',
    cards: c('7d 7s 7h Kc 2d'),
    main: [0, 1, 2],
    rule: l('같은 숫자 3장.', 'Three cards of the same rank.'),
    caveat: l('숫자가 같은 트리플끼리는 남은 2장(킥커)을 높은 것부터 비교합니다.', 'Equal trips are decided by the two kickers, highest first.'),
    example: l('7 트리플 + K, 2 킥커.', 'Three sevens with K and 2 kickers.'),
    beats: l('투페어보다 강합니다.', 'Beats two pair.'),
  },
  {
    key: 'two-pair',
    ko: '투페어',
    en: 'Two Pair',
    cards: c('Kh Kd 9c 9s 4h'),
    main: [0, 1],
    second: [2, 3],
    rule: l('서로 다른 페어 2개.', 'Two different pairs.'),
    caveat: l('높은 페어 → 낮은 페어 → 킥커 순서로 비교합니다. 7장 중 페어가 3개면 높은 2개만 씁니다.', 'Compare the top pair, then the second pair, then the kicker. With three pairs available, only the top two count.'),
    example: l('K·9 투페어 + 4 킥커.', 'Kings and nines with a 4 kicker.'),
    beats: l('원페어보다 강합니다.', 'Beats one pair.'),
  },
  {
    key: 'pair',
    ko: '원페어',
    en: 'One Pair',
    cards: c('Ah Ad Kc 8s 3d'),
    main: [0, 1],
    rule: l('같은 숫자 2장.', 'Two cards of the same rank.'),
    caveat: l('같은 페어끼리는 남은 3장(킥커)을 높은 것부터 비교합니다.', 'Equal pairs are decided by the three kickers, highest first.'),
    example: l('A 원페어 + K-8-3 킥커.', 'A pair of Aces with K-8-3 kickers.'),
    beats: l('하이카드보다 강합니다.', 'Beats high card.'),
  },
  {
    key: 'high-card',
    ko: '하이카드',
    en: 'High Card',
    cards: c('Ac Qd 9h 6s 3c'),
    main: [0],
    rule: l('위의 어느 족보도 아닐 때. 가장 높은 카드로 부릅니다.', 'None of the above; named after the highest card.'),
    caveat: l('가장 높은 카드부터 다섯 장까지 차례로 비교합니다.', 'Compared card by card, highest first, through all five.'),
    example: l('A 하이: A-Q-9-6-3.', 'Ace high: A-Q-9-6-3.'),
    beats: l('가장 약한 족보입니다.', 'The weakest hand.'),
  },
];
