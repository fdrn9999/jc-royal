/**
 * Names of the Academy items that the anonymous statistics count (`academy_stats`), in both languages, for the admin
 * console. Keys are `${kind}:${itemId}` exactly as the web app tracks them (apps/web/src/academy); a web unit test
 * checks that every tracked id has a name here, so a new lesson, scenario or question cannot show up unnamed.
 */
export type AcademyItemKind = 'lesson' | 'question' | 'scenario';
interface Name {
  ko: string;
  en: string;
}
const n = (ko: string, en: string): Name => ({ ko, en });

export const ACADEMY_ITEM_NAMES: Readonly<Record<string, Name>> = {
  'lesson:cards': n('레슨 1 · 플레잉카드의 기초', 'Lesson 1 · Playing card basics'),
  'lesson:hands': n('레슨 2 · 포커 족보', 'Lesson 2 · Hand rankings'),
  'lesson:holdem': n('레슨 3 · 텍사스 홀덤 규칙', "Lesson 3 · Texas hold'em rules"),
  'lesson:actions': n('레슨 4 · 베팅 액션', 'Lesson 4 · Betting actions'),
  'lesson:practice': n('레슨 5 · 연습 게임', 'Lesson 5 · Practice table'),

  'scenario:A': n('연습 A · 체크하기', 'Practice A · Checking'),
  'scenario:B': n('연습 B · 콜하기', 'Practice B · Calling'),
  'scenario:C': n('연습 C · 레이즈하기', 'Practice C · Raising'),
  'scenario:D': n('연습 D · 폴드하기', 'Practice D · Folding'),
  'scenario:E': n('연습 E · 족보 완성하기', 'Practice E · Making a hand'),
  'scenario:F': n('연습 F · 쇼다운', 'Practice F · Showdown'),
  'scenario:G': n('연습 G · 사이드 팟', 'Practice G · Side pots'),
  'scenario:H': n('연습 H · 전체 핸드 체험', 'Practice H · A full hand'),
  'scenario:free': n('자유 연습', 'Free practice'),

  // Lesson 1 quiz
  'question:c-heart': n('카드 퀴즈 · 하트 카드 고르기', 'Card quiz · Pick the Heart'),
  'question:c-ace-spades': n('카드 퀴즈 · 스페이드 A 고르기', 'Card quiz · Pick the Ace of Spades'),
  'question:c-k-vs-q': n('카드 퀴즈 · K와 Q 중 높은 카드', 'Card quiz · Higher card, K or Q'),
  'question:c-diamond': n('카드 퀴즈 · 다이아몬드 고르기', 'Card quiz · Pick the Diamond'),
  'question:c-highest': n('카드 퀴즈 · 가장 높은 카드', 'Card quiz · Highest card'),
  'question:c-suits-equal': n('카드 퀴즈 · ♠9와 ♥9 비교', 'Card quiz · ♠9 vs ♥9'),
  'question:c-sort-faces': n('카드 퀴즈 · A·K·Q·J 정렬', 'Card quiz · Sort A, K, Q, J'),
  'question:c-sort-mixed': n('카드 퀴즈 · 다섯 장 정렬', 'Card quiz · Sort five cards'),

  // Lesson 2 quizzes
  'question:h-name-boat': n('족보 이름 · 풀하우스', 'Name the hand · Full house'),
  'question:h-name-wheel': n('족보 이름 · A부터 5까지 스트레이트', 'Name the hand · Ace-to-five straight'),
  'question:h-name-flush': n('족보 이름 · 플러시', 'Name the hand · Flush'),
  'question:h-pair-vs-2pair': n('승자 맞히기 · 원페어 vs 투페어', 'Who wins · One pair vs two pair'),
  'question:h-flush-vs-straight': n('승자 맞히기 · 스트레이트 vs 플러시', 'Who wins · Straight vs flush'),
  'question:h-boat-vs-quads': n('승자 맞히기 · 풀하우스 vs 포카드', 'Who wins · Full house vs four of a kind'),
  'question:h-higher-pair': n('승자 맞히기 · 원페어끼리', 'Who wins · Pair vs pair'),
  'question:h-kicker': n('승자 맞히기 · 킥커 비교', 'Who wins · Kicker battle'),
  'question:h-flush-high': n('승자 맞히기 · 플러시끼리', 'Who wins · Flush vs flush'),
  'question:h-straight-top': n('승자 맞히기 · 스트레이트끼리', 'Who wins · Straight vs straight'),
  'question:h-boat-trips-first': n('승자 맞히기 · 풀하우스끼리', 'Who wins · Full house vs full house'),
  'question:h-board-plays': n('승자 맞히기 · 보드로 무승부', 'Who wins · The board plays (tie)'),
  'question:h-royal-board': n('승자 맞히기 · 보드에 로열 플러시', 'Who wins · Royal flush on the board'),
  'question:h-high-card': n('승자 맞히기 · 하이카드끼리', 'Who wins · High card vs high card'),
  'question:h-sort': n('족보 퀴즈 · 강한 순서로 정렬', 'Hand quiz · Sort by strength'),

  // Lesson 3 quiz
  'question:p-6-pre': n('포지션 퀴즈 · 6인 프리플랍 첫 행동', 'Position quiz · 6 players preflop, first to act'),
  'question:p-6-post': n('포지션 퀴즈 · 6인 플랍 이후 첫 행동', 'Position quiz · 6 players after the flop, first to act'),
  'question:p-hu-pre': n('포지션 퀴즈 · 헤즈업 프리플랍 첫 행동', 'Position quiz · Heads-up preflop, first to act'),

  // Lesson 4 quiz
  'question:a-free': n('액션 퀴즈 · 칩 없이 차례 넘기기', 'Action quiz · Pass without chips'),
  'question:a-match': n('액션 퀴즈 · 같은 금액으로 따라가기', 'Action quiz · Match a bet'),
  'question:a-fold-chips': n('액션 퀴즈 · 폴드 후 낸 블라인드', 'Action quiz · A folded blind'),

  // Questions asked during the practice scenarios (`practice:<scenario>:<index>`)
  'question:practice:E:0': n('연습 E · 플랍에서 내 족보', 'Practice E · My hand on the flop'),
  'question:practice:E:1': n('연습 E · 턴에서 내 족보', 'Practice E · My hand on the turn'),
  'question:practice:E:2': n('연습 E · 리버 최종 족보', 'Practice E · Final hand on the river'),
  'question:practice:F:0': n('연습 F · 쇼다운 승자', 'Practice F · Who won the showdown'),
  'question:practice:G:0': n('연습 G · 올인한 사람이 이길 수 있는 금액', 'Practice G · What the all-in player can win'),
  'question:practice:H:0': n('연습 H · 쇼다운 최종 족보', 'Practice H · Final hand at showdown'),

  // Review questions, generated or drawn per topic (`review:<topic>`)
  'question:review:suits': n('복습 · 카드 문양', 'Review · Suits'),
  'question:review:ranks': n('복습 · 카드 순서', 'Review · Card order'),
  'question:review:hand-names': n('복습 · 족보 이름', 'Review · Naming hands'),
  'question:review:hand-order': n('복습 · 족보 순위', 'Review · Hand ranking'),
  'question:review:kicker': n('복습 · 같은 족보 비교·킥커', 'Review · Same-rank ties and kickers'),
  'question:review:split': n('복습 · 무승부(스플릿)', 'Review · Split pots'),
  'question:review:positions': n('복습 · 포지션·행동 순서', 'Review · Positions and order'),
  'question:review:actions': n('복습 · 베팅 액션', 'Review · Betting actions'),
  'question:review:pots': n('복습 · 팟과 사이드 팟', 'Review · Pots and side pots'),
};

/**
 * The name of an Academy item, or null when it has none. Review position and action questions are counted as
 * `r-pos-<n>` / `r-act-<n>` (n = place in the review set, not the question), so those rows get the topic's name.
 */
export function academyItemName(kind: AcademyItemKind, id: string, locale: 'ko' | 'en'): string | null {
  const key = kind === 'question' ? id.replace(/^r-pos-\d+$/, 'review:positions').replace(/^r-act-\d+$/, 'review:actions') : id;
  return ACADEMY_ITEM_NAMES[`${kind}:${key}`]?.[locale] ?? null;
}
