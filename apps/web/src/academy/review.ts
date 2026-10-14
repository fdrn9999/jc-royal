/**
 * Review and random quizzes. Questions are generated from random cards; the
 * answers are never authored: compare questions are judged by a HandEngine
 * showdown when shown (CompareView), the others by the evaluator / card data.
 * The topic mix is weighted towards the player's open mistakes.
 */
import { evaluateBest, rankValue, standardDeck } from '@jc/poker-engine';
import type { Card, HandLabelKey } from '@jc/types';
import { l, type L } from './content';
import { ACTION_QUIZ } from './data/actions';
import { HAND_RANKS } from './data/hands';
import { POSITION_QUIZ } from './data/holdem';
import { TOPICS, type LessonId, type Progress, type Topic } from './progress';
import { handLabelOf, handStrength, suitOf, type ChoiceQuestion, type CompareQuestion, type PickQuestion, type Question, type SortQuestion } from './quiz';

export type Rng = () => number;

/** Small deterministic PRNG (mulberry32) so tests can pin a seed. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pickOne = <T>(xs: readonly T[], r: Rng): T => xs[Math.floor(r() * xs.length)]!;
function shuffled<T>(xs: readonly T[], r: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const TOPIC_INFO: Record<Topic, { name: L; lesson: LessonId; step: number }> = {
  suits: { name: l('카드 문양', 'Suits'), lesson: 'cards', step: 0 },
  ranks: { name: l('카드 순서', 'Card order'), lesson: 'cards', step: 2 },
  'hand-names': { name: l('족보 이름', 'Naming hands'), lesson: 'hands', step: 1 },
  'hand-order': { name: l('족보 순위', 'Hand ranking'), lesson: 'hands', step: 0 },
  kicker: { name: l('같은 족보 비교·킥커', 'Same-rank ties and kickers'), lesson: 'hands', step: 1 },
  split: { name: l('무승부(스플릿)', 'Split pots'), lesson: 'hands', step: 3 },
  positions: { name: l('포지션·행동 순서', 'Positions and order'), lesson: 'holdem', step: 3 },
  actions: { name: l('베팅 액션', 'Betting actions'), lesson: 'actions', step: 0 },
  pots: { name: l('팟과 사이드 팟', 'Pots and side pots'), lesson: 'actions', step: 2 },
};

// ------------------------------------------------------------------ generators

/** Two random hands on a random board whose outcome type matches `want`. */
export function genCompare(want: 'kicker' | 'split' | 'hand-order', r: Rng, n: number): CompareQuestion {
  for (let tries = 0; tries < 20_000; tries++) {
    const d = shuffled(standardDeck(), r);
    const a = d.slice(0, 2);
    const b = d.slice(2, 4);
    const board = d.slice(4, 9);
    const ea = evaluateBest([...a, ...board])!;
    const eb = evaluateBest([...b, ...board])!;
    const same = ea.rankClass === eb.rankClass;
    const tie = same && ea.score.every((v, i) => v === eb.score[i]);
    const kind = tie ? 'split' : same ? 'kicker' : 'hand-order';
    if (kind !== want) continue;
    return {
      kind: 'compare',
      id: `r-${want}-${n}`,
      statId: `review:${want}`,
      topic: want,
      prompt: l('누가 이길까요?', 'Who wins?'),
      board,
      a,
      b,
      explain: l('판정은 실제 게임 엔진이 했습니다.', 'Judged by the real game engine.'),
    };
  }
  throw new Error(`could not generate a ${want} spot`);
}

/** Five random cards of a randomly chosen rank class; the evaluator names it. */
export function genHandName(r: Rng, n: number): ChoiceQuestion {
  const target = pickOne(HAND_RANKS, r).key;
  let cards: Card[] | null = null;
  if (target === 'royal-flush' || target === 'straight-flush') {
    const suit = pickOne(['s', 'h', 'd', 'c'] as const, r);
    const top = target === 'royal-flush' ? 14 : 5 + Math.floor(r() * 9); // 5-high (wheel) … K-high
    const v = (x: number) => (x === 14 || x === 1 ? 'A' : x === 13 ? 'K' : x === 12 ? 'Q' : x === 11 ? 'J' : x === 10 ? 'T' : String(x));
    cards = shuffled([0, 1, 2, 3, 4].map((k) => `${v(top - k)}${suit}` as Card), r);
  } else {
    for (let tries = 0; tries < 200_000 && !cards; tries++) {
      const c = shuffled(standardDeck(), r).slice(0, 5);
      if (handLabelOf(c) === target) cards = c;
    }
  }
  const answer = handLabelOf(cards!);
  const at = HAND_RANKS.findIndex((h) => h.key === answer);
  const ids = new Set<HandLabelKey>([answer]);
  for (const off of shuffled([-2, -1, 1, 2, 3, -3], r)) {
    const h = HAND_RANKS[at + off];
    if (h && ids.size < 4) ids.add(h.key);
  }
  const options = HAND_RANKS.filter((h) => ids.has(h.key)).map((h) => ({ id: h.key, label: l(h.ko, h.en) }));
  return {
    kind: 'choice',
    id: `r-name-${n}`,
    statId: 'review:hand-names',
    topic: 'hand-names',
    prompt: l('이 다섯 장의 족보는?', 'What hand is this?'),
    cards: cards!,
    options,
    answer,
    why: l('같은 숫자가 몇 장인지 → 문양이 모두 같은지 → 숫자가 이어지는지 순서로 확인하세요.', 'Check: matching ranks → one suit → five in a row.'),
    explain: l('족보표에서 위에서부터 차례로 맞는지 확인하면 됩니다.', 'Go down the hand chart and stop at the first match.'),
  };
}

export function genHighest(r: Rng, n: number): PickQuestion {
  const d = shuffled(standardDeck(), r);
  const cards: Card[] = [];
  for (const c of d) if (cards.length < 4 && !cards.some((x) => rankValue(x) === rankValue(c))) cards.push(c);
  const top = Math.max(...cards.map(rankValue));
  return {
    kind: 'pick',
    id: `r-high-${n}`,
    statId: 'review:ranks',
    topic: 'ranks',
    prompt: l('가장 높은 카드를 고르세요.', 'Pick the highest card.'),
    cards,
    isCorrect: (c) => rankValue(c) === top,
    why: () => l('A > K > Q > J > 10 > … > 2 순서입니다.', 'Order: A > K > Q > J > 10 > … > 2.'),
    explain: l('문양과 상관없이 숫자만 비교합니다.', 'Only the rank matters, never the suit.'),
  };
}

export function genSuit(r: Rng, n: number): PickQuestion {
  const rank = pickOne(['2', '5', '7', '9', 'T', 'J', 'Q', 'K', 'A'] as const, r);
  const cards = shuffled((['s', 'h', 'd', 'c'] as const).map((s) => `${rank}${s}` as Card), r);
  const want = pickOne(['s', 'h', 'd', 'c'] as const, r);
  const names = { s: l('스페이드(♠)', 'Spade (♠)'), h: l('하트(♥)', 'Heart (♥)'), d: l('다이아몬드(♦)', 'Diamond (♦)'), c: l('클럽(♣)', 'Club (♣)') };
  return {
    kind: 'pick',
    id: `r-suit-${n}`,
    statId: 'review:suits',
    topic: 'suits',
    prompt: l(`${names[want].ko} 카드를 고르세요.`, `Pick the ${names[want].en} card.`),
    cards,
    isCorrect: (c) => suitOf(c) === want,
    why: () => l('빨간 문양은 ♥·♦, 검은 문양은 ♠·♣ 입니다.', 'Red suits are ♥ ♦, black suits are ♠ ♣.'),
    explain: l('네 가지 문양: ♠ 스페이드, ♥ 하트, ♦ 다이아몬드, ♣ 클럽.', 'Four suits: ♠ ♥ ♦ ♣.'),
  };
}

export function genHandSort(r: Rng, n: number): SortQuestion {
  const classes = shuffled(HAND_RANKS.filter((h) => h.key !== 'royal-flush'), r).slice(0, 4);
  return {
    kind: 'sort',
    id: `r-sort-${n}`,
    statId: 'review:hand-order',
    topic: 'hand-order',
    prompt: l('강한 순서대로 정렬하세요.', 'Sort strongest first.'),
    items: shuffled(classes.map((h) => h.cards), r),
    strength: handStrength,
    explain: l('족보 순위: 로열 플러시 > 스트레이트 플러시 > 포카드 > 풀하우스 > 플러시 > 스트레이트 > 트리플 > 투페어 > 원페어 > 하이카드', 'Royal flush > straight flush > quads > full house > flush > straight > trips > two pair > pair > high card'),
  };
}

const POT_QUIZ: ChoiceQuestion = {
  kind: 'choice',
  id: 'pot-allin',
  topic: 'pots',
  prompt: l('100칩만 가진 플레이어가 올인했고, 두 사람이 콜한 뒤 둘이서 200씩 더 베팅했습니다. 올인한 사람이 이기면 최대 얼마를 가져갈까요?', 'A player all-in for 100 is called by two others, who then bet 200 more each. If the all-in player wins, what is the most they can take?'),
  options: [
    { id: '300', label: l('300 (메인 팟)', '300 (main pot)') },
    { id: '700', label: l('700 (전부)', '700 (everything)') },
    { id: '400', label: l('400 (사이드 팟)', '400 (side pot)') },
  ],
  answer: '300',
  why: l('올인한 사람은 자기가 낸 100만큼씩, 3명 × 100 = 300 까지만 이길 수 있습니다.', 'They can win only 100 from each player: 3 × 100 = 300.'),
  explain: l('나머지 400은 두 사람 사이의 사이드 팟입니다 (사이드 팟 레슨 참고).', 'The other 400 is a side pot between the two callers.'),
};

function fixed(pool: Question[], r: Rng): Question {
  return pickOne(pool, r);
}

export function questionFor(topic: Topic, r: Rng, n: number): Question {
  switch (topic) {
    case 'suits':
      return genSuit(r, n);
    case 'ranks':
      return genHighest(r, n);
    case 'hand-names':
      return genHandName(r, n);
    case 'hand-order':
      return r() < 0.5 ? genHandSort(r, n) : genCompare('hand-order', r, n);
    case 'kicker':
      return genCompare('kicker', r, n);
    case 'split':
      return genCompare('split', r, n);
    case 'positions':
      return { ...fixed(POSITION_QUIZ, r), id: `r-pos-${n}` };
    case 'actions':
      return { ...fixed(ACTION_QUIZ, r), id: `r-act-${n}` };
    case 'pots':
      return { ...POT_QUIZ, id: `r-pots-${n}`, statId: 'review:pots' };
  }
}

/**
 * A review set of `n` questions: topics with open mistakes are weighted up
 * (weight 1 + 3 × mistakes); `random` ignores mistakes for an even mix.
 */
export function buildReview(p: Progress, r: Rng, n = 8, random = false): Question[] {
  const weights = TOPICS.map((t) => (random ? 1 : 1 + 3 * (p.mistakes[t] ?? 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Question[] = [];
  for (let i = 0; i < n; i++) {
    let x = r() * total;
    let k = 0;
    while (x >= weights[k]!) x -= weights[k++]!;
    const topic = TOPICS[k]!;
    out.push(questionFor(topic, r, i));
  }
  return out;
}

