/**
 * Practice scenarios A–H. Each is a fixed deck + scripted opponents played on
 * the real HandEngine (see runner.ts). Unit tests play every scenario through
 * its script and assert the outcome the copy describes.
 */
import type { ActionType, Card } from '@jc/types';
import { l, type L } from '../content';
import type { ScenarioId } from '../progress';

const c = (s: string) => s.split(' ') as Card[];

export interface HeroStep {
  expect: ActionType | ActionType[];
  /** bet/raise: smallest acceptable "to" amount. */
  minTo?: number;
  coach: L;
}

export type PracticeQuestion =
  | { kind: 'handName'; at: 'flop' | 'turn' | 'river' | 'settled'; prompt: L }
  | { kind: 'winner'; at: 'settled'; prompt: L }
  | { kind: 'mainPot'; at: 'turn'; prompt: L };

export interface Scenario {
  id: ScenarioId;
  title: L;
  goal: L;
  intro: L;
  outro: L;
  size: 2 | 6 | 9;
  seats: { index: number; name: string; stack: number }[];
  hero: number;
  button: number;
  blinds: [number, number];
  holes: Record<number, Card[]>;
  board: Card[];
  /** Opponent decisions in order, per seat; when empty they check or call. */
  bots: Record<number, { type: ActionType; amount?: number }[]>;
  steps: HeroStep[];
  questions: PracticeQuestion[];
  /** What the scripted hand must end with (tested). */
  expectWinners: number[];
}

const HU = (heroName: string, villain: string, button: 0 | 1) => ({
  size: 2 as const,
  seats: [
    { index: 0, name: heroName, stack: 1000 },
    { index: 1, name: villain, stack: 1000 },
  ],
  hero: 0,
  button,
  blinds: [5, 10] as [number, number],
});

export function buildScenarios(heroName: string): Scenario[] {
  return [
    {
      id: 'A',
      ...HU(heroName, 'Mia', 1),
      title: l('체크하기', 'Checking'),
      goal: l('맞출 베팅이 없을 때 체크로 차례를 넘깁니다.', 'Pass the turn with a check when there is nothing to match.'),
      intro: l('당신은 빅 블라인드(BB)입니다. 상대(버튼/SB)가 먼저 행동합니다.', 'You are the big blind. Your opponent (button/SB) acts first.'),
      outro: l('체크는 무료로 다음 카드를 보는 방법입니다. 단, 누군가 베팅하면 체크할 수 없습니다.', 'A check sees the next card for free — but only while nobody has bet.'),
      holes: { 0: c('8d 8c'), 1: c('Kh 4s') },
      board: c('Qs 7h 2c 5d 3s'),
      bots: { 1: [{ type: 'call' }] },
      steps: [
        { expect: 'check', coach: l('상대가 10을 맞춰 콜했습니다. 내가 더 낼 칩이 없으니 [체크]를 누르세요.', 'Your opponent called to 10. You owe nothing more — tap [Check].') },
        { expect: 'check', coach: l('플랍 이후에는 버튼 왼쪽인 내가(BB) 먼저 행동합니다. 다시 [체크]!', 'After the flop the big blind acts first. [Check] again!') },
      ],
      questions: [],
      expectWinners: [0],
    },
    {
      id: 'B',
      ...HU(heroName, 'Mia', 1),
      title: l('콜하기', 'Calling'),
      goal: l('상대의 베팅에 같은 금액을 맞춥니다.', 'Match an opponent’s bet.'),
      intro: l('당신은 빅 블라인드(10)를 냈습니다. 상대가 레이즈합니다.', 'You posted the 10 big blind. Your opponent raises.'),
      outro: l('콜은 상대의 베팅까지 금액을 맞추는 것입니다. 이미 낸 10을 빼고 20만 더 냈습니다.', 'A call matches the bet: you had 10 in, so you added 20.'),
      holes: { 0: c('Ah Jd'), 1: c('Kc Qc') },
      board: c('Ad 9s 6h 3c 2d'),
      bots: { 1: [{ type: 'raise', amount: 30 }] },
      steps: [{ expect: 'call', coach: l('상대가 30으로 레이즈했습니다. [콜]을 눌러 20을 더 넣어 맞추세요.', 'Your opponent raised to 30. Tap [Call] to add 20 and match.') }],
      questions: [],
      expectWinners: [0],
    },
    {
      id: 'C',
      ...HU(heroName, 'Mia', 1),
      title: l('레이즈하기', 'Raising'),
      goal: l('슬라이더와 프리셋으로 금액을 정해 레이즈합니다.', 'Choose an amount with the slider or presets and raise.'),
      intro: l('좋은 패(K 페어)를 받았습니다. 상대는 콜만 했습니다.', 'You hold a pair of Kings. Your opponent just called.'),
      outro: l('레이즈 금액은 최소 금액 이상, 내 스택 이하에서 고를 수 있습니다. 프리셋(최소·1/2 팟·팟·최대)이 빠릅니다.', 'Any amount from the minimum up to your stack is allowed; presets (Min, ½ Pot, Pot, Max) are the quick way.'),
      holes: { 0: c('Kh Kd'), 1: c('9c 8c') },
      board: c('Ks 7d 2h 4c Jc'),
      bots: { 1: [{ type: 'call' }, { type: 'call' }] },
      steps: [
        {
          expect: 'raise',
          minTo: 20,
          coach: l('오른쪽 위의 화살표 버튼으로 금액 설정을 펼치고 슬라이더·[−][+]·프리셋으로 금액을 정한 뒤 [레이즈]를 누르세요.', 'Open the bet sizing with the arrow button at the top right, set the amount with the slider, [−][+] or a preset, then press [Raise].'),
        },
      ],
      questions: [],
      expectWinners: [0],
    },
    {
      id: 'D',
      ...HU(heroName, 'Mia', 1),
      title: l('폴드하기', 'Folding'),
      goal: l('약한 패로 큰 베팅을 만나면 핸드를 포기합니다.', 'Give up a weak hand facing a big bet.'),
      intro: l('7-2는 가장 약한 시작 패로 알려져 있습니다. 상대가 크게 레이즈합니다.', '7-2 offsuit is known as the weakest starting hand. Your opponent raises big.'),
      outro: l('폴드하면 핸드가 끝납니다. 이미 낸 빅 블라인드 10은 돌려받지 못하고 상대가 팟을 가져갑니다.', 'Folding ends your hand. The 10 you posted stays in the pot and your opponent takes it.'),
      holes: { 0: c('7c 2d'), 1: c('Ah Ad') },
      board: c('Ks 9d 4h 3c Jc'),
      bots: { 1: [{ type: 'raise', amount: 100 }] },
      steps: [{ expect: 'fold', coach: l('상대가 100으로 레이즈했습니다. 7-2로는 따라가기 어렵습니다. [폴드]하세요.', 'Raised to 100. 7-2 is not worth it — tap [Fold].') }],
      questions: [],
      expectWinners: [1],
    },
    {
      id: 'E',
      ...HU(heroName, 'Mia', 1),
      title: l('족보 완성하기', 'Making a hand'),
      goal: l('보드가 열릴 때마다 지금 내 족보를 맞혀 봅니다.', 'Name your hand as each street is dealt.'),
      intro: l('♥A ♥K 를 받았습니다. 체크하며 카드가 열리는 것을 지켜보세요.', 'You hold ♥A ♥K. Check along and watch the board.'),
      outro: l('플랍의 K 원페어가 턴의 ♥Q 로 하트 플러시가 되었습니다. 족보는 보드가 열릴 때마다 달라질 수 있습니다.', 'Your pair of Kings became a heart flush on the turn. Your hand can change on every street.'),
      holes: { 0: c('Ah Kh'), 1: c('Qd Jc') },
      board: c('Kd 7h 2h Qh 9c'),
      bots: { 1: [{ type: 'call' }] },
      steps: [
        { expect: 'check', coach: l('[체크]하고 플랍을 보세요.', '[Check] and see the flop.') },
        { expect: 'check', coach: l('[체크]', '[Check]') },
        { expect: 'check', coach: l('[체크]', '[Check]') },
        { expect: 'check', coach: l('[체크]', '[Check]') },
      ],
      questions: [
        { kind: 'handName', at: 'flop', prompt: l('플랍이 열렸습니다. 지금 내 족보는?', 'Flop is out. What do you have now?') },
        { kind: 'handName', at: 'turn', prompt: l('턴 카드 ♥Q. 지금 내 족보는?', 'Turn: the ♥Q. What do you have now?') },
        { kind: 'handName', at: 'river', prompt: l('리버까지 열렸습니다. 최종 족보는?', 'River is out. Your final hand?') },
      ],
      expectWinners: [0],
    },
    {
      id: 'F',
      ...HU(heroName, 'Mia', 1),
      title: l('쇼다운', 'Showdown'),
      goal: l('두 사람의 패를 비교해 승자를 예측합니다.', 'Compare both hands and predict the winner.'),
      intro: l('Q 페어로 끝까지 갑니다. 이번에는 자동으로 진행됩니다.', 'You take pocket Queens to the end; this one plays itself.'),
      outro: l('상대는 보드의 K와 짝을 이뤄 K 원페어. 내 Q 페어보다 높습니다. 높은 페어가 이깁니다.', 'Your opponent paired the King on board. A pair of Kings beats your Queens.'),
      holes: { 0: c('Qs Qd'), 1: c('Kh 9c') },
      board: c('Kc 8h 4d 2s 7s'),
      bots: { 1: [{ type: 'call' }] },
      steps: [],
      questions: [{ kind: 'winner', at: 'settled', prompt: l('패가 공개되었습니다. 누가 이겼을까요?', 'Cards are face up. Who won?') }],
      expectWinners: [1],
    },
    {
      id: 'G',
      size: 6,
      seats: [
        { index: 0, name: heroName, stack: 1000 },
        { index: 2, name: 'Leo', stack: 100 },
        { index: 4, name: 'Mia', stack: 1000 },
      ],
      hero: 0,
      button: 0,
      blinds: [5, 10],
      title: l('사이드 팟', 'Side pots'),
      goal: l('스택이 다른 플레이어가 올인하면 팟이 나뉘는 방식을 봅니다.', 'See how pots split when a short stack is all-in.'),
      intro: l('3명 테이블. 당신이 버튼이고, 레오는 칩이 100뿐입니다.', 'Three players. You are on the button; Leo has only 100 chips.'),
      outro: l('레오는 메인 팟(300)만 이길 수 있고, 그 뒤 베팅은 당신과 미아의 사이드 팟(400)이 됩니다. 레오가 메인 팟, 당신이 사이드 팟을 가져갔습니다.', 'Leo could only win the main pot (300); later bets formed a side pot (400) between you and Mia. Leo took the main pot and you took the side pot.'),
      holes: { 0: c('Kc Kd'), 2: c('Ac Ad'), 4: c('Qc Js') },
      board: c('2h 7s 9d 3c 4h'),
      bots: { 2: [{ type: 'allin' }], 4: [{ type: 'call' }, { type: 'bet', amount: 200 }] },
      steps: [
        { expect: 'call', coach: l('3인 테이블에서는 버튼이 프리플랍에 먼저 행동합니다. [콜]로 10을 맞추세요.', 'Three-handed, the button acts first preflop. [Call] the 10.') },
        { expect: 'call', coach: l('레오가 100으로 올인, 미아가 콜했습니다. [콜]로 90을 더 내세요.', 'Leo is all-in for 100 and Mia called. [Call] 90 more.') },
        { expect: 'call', coach: l('미아가 200을 벳했습니다. 레오는 이미 올인이라 이 칩은 사이드 팟으로 갑니다. [콜]하세요.', 'Mia bets 200. Leo is all-in, so this goes to a side pot. [Call].') },
      ],
      questions: [{ kind: 'mainPot', at: 'turn', prompt: l('레오(올인)가 이긴다면 최대 얼마를 가져갈 수 있을까요?', 'If Leo (all-in) wins, how much can he take at most?') }],
      expectWinners: [0, 2],
    },
    {
      id: 'H',
      ...HU(heroName, 'Mia', 0),
      title: l('전체 핸드 체험', 'A full hand'),
      goal: l('프리플랍부터 쇼다운까지 한 핸드를 끝까지 플레이합니다.', 'Play one hand from preflop to showdown.'),
      intro: l('헤즈업에서 당신은 버튼이자 스몰 블라인드입니다. 프리플랍에서 먼저, 플랍 이후에는 나중에 행동합니다.', 'Heads-up you are the button and small blind: first to act preflop, last after the flop.'),
      outro: l('Q 원페어(A 킥커)로 K 하이를 이겼습니다. 이제 실제 테이블에서도 한 판을 플레이할 수 있습니다!', 'A pair of Queens beat King high. You are ready for a real table!'),
      holes: { 0: c('Ah Qd'), 1: c('Kc Jc') },
      board: c('Qs 8c 3h 5d 2s'),
      bots: { 1: [{ type: 'call' }, { type: 'check' }, { type: 'call' }, { type: 'check' }, { type: 'bet', amount: 40 }] },
      steps: [
        { expect: 'raise', minTo: 20, coach: l('프리플랍: 좋은 패입니다. [레이즈]로 30 정도 올려 보세요.', 'Preflop with a good hand: [Raise] to about 30.') },
        { expect: 'bet', minTo: 10, coach: l('플랍에서 Q 페어를 맞췄습니다. 상대가 체크했으니 [벳]하세요.', 'You paired your Queen and your opponent checked: [Bet].') },
        { expect: 'check', coach: l('턴: 상대가 체크했습니다. 이번엔 [체크]로 넘겨 보세요.', 'Turn: your opponent checks. [Check] behind this time.') },
        { expect: 'call', coach: l('리버: 상대가 40을 벳했습니다. Q 페어면 충분해 보입니다. [콜]!', 'River: your opponent bets 40. Your pair looks good — [Call]!') },
      ],
      questions: [{ kind: 'handName', at: 'settled', prompt: l('쇼다운! 내 최종 족보는?', 'Showdown! What is your final hand?') }],
      expectWinners: [0],
    },
  ];
}
