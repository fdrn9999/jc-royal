import type { Card } from '@jc/types';
import { l, rankLabel, SUIT_INFO } from '../content';
import { handStrength, rankOf, suitOf, type Question } from '../quiz';

const c = (s: string) => s.split(' ') as Card[];
const suitName = (card: Card) => SUIT_INFO[suitOf(card)].name;

export const FACE_NAMES = [
  { rank: 'A', ko: '에이스 (Ace)', en: 'Ace', note: l('가장 높은 카드. A-2-3-4-5 스트레이트에서만 가장 낮은 카드(1)로도 쓰입니다.', 'Highest card. Only in the A-2-3-4-5 straight does it also play low, as a 1.') },
  { rank: 'K', ko: '킹 (King)', en: 'King', note: l('A 다음으로 높은 카드.', 'Second highest.') },
  { rank: 'Q', ko: '퀸 (Queen)', en: 'Queen', note: l('K 다음.', 'Below the King.') },
  { rank: 'J', ko: '잭 (Jack)', en: 'Jack', note: l('Q 다음, 10보다 높습니다.', 'Below the Queen, above the 10.') },
];

export const RANK_ORDER = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

export const CARD_QUESTIONS: Question[] = [
  {
    kind: 'pick',
    id: 'c-heart',
    prompt: l('하트(♥) 카드를 선택하세요.', 'Pick the Heart (♥) card.'),
    cards: c('As 7h Kc 9d'),
    isCorrect: (x) => suitOf(x) === 'h',
    why: (x) => l(`그 카드는 ${suitName(x).ko}입니다. 하트는 빨간 ♥ 모양이에요.`, `That card is a ${suitName(x).en.replace(/s$/, '')}. Hearts are the red ♥ shape.`),
    explain: l('빨간 문양은 ♥ 하트와 ♦ 다이아몬드, 검은 문양은 ♠ 스페이드와 ♣ 클럽입니다.', 'Red suits: ♥ Hearts and ♦ Diamonds. Black suits: ♠ Spades and ♣ Clubs.'),
  },
  {
    kind: 'pick',
    id: 'c-ace-spades',
    prompt: l('스페이드 A(♠A)를 선택하세요.', 'Pick the Ace of Spades (♠A).'),
    cards: c('Ah As Ac Ks'),
    isCorrect: (x) => x === 'As',
    why: (x) =>
      x[0] !== 'A'
        ? l(`그 카드는 ${rankLabel(x)}입니다. 숫자 자리에 A가 있는 카드를 찾으세요.`, `That is a ${rankLabel(x)}. Look for an A in the corner.`)
        : l(`A는 맞지만 문양이 ${suitName(x).ko}입니다. 스페이드는 검은 ♠ 모양이에요.`, `Right rank, but that suit is ${suitName(x).en}. Spades are the black ♠.`),
    explain: l('카드 왼쪽 위에 숫자와 문양이 함께 적혀 있습니다.', 'The rank and the suit are printed together in the top-left corner.'),
  },
  {
    kind: 'pick',
    id: 'c-k-vs-q',
    prompt: l('K와 Q 중 더 높은 카드를 선택하세요.', 'Pick the higher card: K or Q?'),
    cards: c('Qd Kc'),
    isCorrect: (x) => rankOf(x) === 13,
    why: () => l('Q(퀸)는 K(킹)보다 한 단계 낮습니다. 순서: A > K > Q > J > 10 …', 'The Queen is one step below the King. Order: A > K > Q > J > 10 …'),
    explain: l('K는 A 다음으로 높은 카드입니다.', 'The King is second only to the Ace.'),
  },
  {
    kind: 'pick',
    id: 'c-diamond',
    prompt: l('네 장 중 다이아몬드(♦)를 선택하세요.', 'Of these four, pick the Diamond (♦).'),
    cards: c('5h 5d 5c 5s'),
    isCorrect: (x) => suitOf(x) === 'd',
    why: (x) => l(`그 카드는 ${suitName(x).ko}입니다. 다이아몬드는 빨간 마름모 ♦ 모양이에요.`, `That one is ${suitName(x).en}. Diamonds are the red rhombus ♦.`),
    explain: l('숫자가 같아도 문양은 네 가지로 다릅니다.', 'The same rank comes in four different suits.'),
  },
  {
    kind: 'pick',
    id: 'c-highest',
    prompt: l('가장 높은 카드를 선택하세요.', 'Pick the highest card.'),
    cards: c('Jh Ts Ac 2d'),
    isCorrect: (x) => rankOf(x) === 14,
    why: (x) => l(`${rankLabel(x)}보다 A가 더 높습니다. 홀덤에서 A는 가장 높은 카드예요.`, `The Ace beats the ${rankLabel(x)}. In hold'em the Ace is the highest card.`),
    explain: l('A > K > Q > J > 10 > 9 > … > 2', 'A > K > Q > J > 10 > 9 > … > 2'),
  },
  {
    kind: 'choice',
    id: 'c-suits-equal',
    prompt: l('♠9와 ♥9 중 어느 카드가 더 높을까요?', 'Which is higher: ♠9 or ♥9?'),
    cards: c('9s 9h'),
    options: [
      { id: 's', label: l('♠9 (스페이드)', '♠9 (Spades)') },
      { id: 'h', label: l('♥9 (하트)', '♥9 (Hearts)') },
      { id: 'eq', label: l('둘은 같다', 'They are equal') },
    ],
    answer: 'eq',
    why: l('텍사스 홀덤 족보에서는 문양 사이에 높고 낮음이 없습니다. 숫자가 같으면 같은 카드로 취급해요.', "Texas hold'em has no suit ranking: cards of the same rank are equal."),
    explain: l('문양은 플러시(같은 문양 5장)를 만들 때만 의미가 있습니다.', 'Suits only matter for making a flush (five of one suit).'),
  },
  {
    kind: 'sort',
    id: 'c-sort-faces',
    prompt: l('A, K, Q, J를 높은 순서대로 정렬하세요.', 'Sort A, K, Q, J from highest to lowest.'),
    items: [c('Jd'), c('As'), c('Qc'), c('Kh')],
    strength: handStrength,
    explain: l('A > K > Q > J. 그림 카드 다음은 10입니다.', 'A > K > Q > J, and the 10 comes next.'),
  },
  {
    kind: 'sort',
    id: 'c-sort-mixed',
    prompt: l('다섯 장을 높은 순서대로 정렬하세요.', 'Sort these five cards from highest to lowest.'),
    items: [c('9c'), c('2h'), c('Td'), c('Ks'), c('5s')],
    strength: handStrength,
    explain: l('K > 10 > 9 > 5 > 2. 문양은 순서에 영향을 주지 않습니다.', 'K > 10 > 9 > 5 > 2. Suits do not affect the order.'),
  },
];
