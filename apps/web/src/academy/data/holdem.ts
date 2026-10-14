import type { Card } from '@jc/types';
import { l, type L } from '../content';

const c = (s: string) => s.split(' ') as Card[];

export const STAGES: { id: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'; name: L; board: number; points: L[] }[] = [
  {
    id: 'preflop',
    name: l('프리플랍 Preflop', 'Preflop'),
    board: 0,
    points: [
      l('모든 플레이어가 자기만 보는 카드(홀카드) 2장을 받습니다.', 'Everyone gets two private cards (hole cards).'),
      l('버튼 왼쪽의 두 사람이 스몰 블라인드·빅 블라인드를 강제로 냅니다. 팟을 만들기 위한 의무 베팅입니다.', 'The two players left of the button post the small and big blinds — forced bets that seed the pot.'),
      l('첫 번째 베팅 라운드: 빅 블라인드 왼쪽(UTG)부터 시작해 빅 블라인드에서 끝납니다.', 'First betting round: starts left of the big blind (UTG) and ends with the big blind.'),
    ],
  },
  {
    id: 'flop',
    name: l('플랍 Flop', 'Flop'),
    board: 3,
    points: [
      l('가운데에 모두가 함께 쓰는 커뮤니티 카드 3장이 공개됩니다.', 'Three shared community cards are dealt face up.'),
      l('두 번째 베팅 라운드: 버튼 왼쪽에 남은 첫 플레이어부터 행동합니다.', 'Second betting round: the first remaining player left of the button acts first.'),
    ],
  },
  {
    id: 'turn',
    name: l('턴 Turn', 'Turn'),
    board: 4,
    points: [l('커뮤니티 카드 1장이 추가됩니다(총 4장).', 'A fourth community card is added.'), l('세 번째 베팅 라운드.', 'Third betting round.')],
  },
  {
    id: 'river',
    name: l('리버 River', 'River'),
    board: 5,
    points: [l('마지막 커뮤니티 카드가 공개됩니다(총 5장).', 'The fifth and final community card.'), l('네 번째(마지막) 베팅 라운드.', 'Fourth and last betting round.')],
  },
  {
    id: 'showdown',
    name: l('쇼다운 Showdown', 'Showdown'),
    board: 5,
    points: [
      l('끝까지 남은 플레이어들이 패를 공개해 비교합니다.', 'Remaining players reveal and compare their hands.'),
      l('각자 7장(홀카드 2 + 보드 5) 중 가장 강한 5장으로 승부합니다.', 'Each plays the best five of seven cards (2 hole + 5 board).'),
      l('가장 강한 패가 팟을 가져가고, 같으면 나눕니다.', 'The best hand takes the pot; equal hands split it.'),
    ],
  },
];

/** Stage walkthrough hand (checked with the engine in the unit tests: hero wins with a pair of Kings). */
export const WALKTHROUGH = { hero: c('Ah Kd'), villain: c('Qh Qc'), board: c('Ks 9h 4c 7d 2s') };

/** Goal section: the best five can come entirely from the board. */
export const BOARD_PLAYS = { hole: c('2c 3d'), board: c('As Ks Qs Js Ts') };
export const BEST_FIVE_DEMO = { hole: c('Ah Jh'), board: c('Kh 9h 4c 2h 7s') };

/**
 * Position names in seat order starting at the button and going clockwise.
 * Middle seats are named from the button backwards: CO, HJ, LJ, MP, UTG+1, and
 * the first seat after the big blind is UTG.
 */
export function positionNames(players: number): string[] {
  if (players < 2 || players > 9) throw new Error('2-9 players');
  if (players === 2) return ['BTN/SB', 'BB'];
  const middle = players - 3;
  const tail = ['CO', 'HJ', 'LJ', 'MP', 'UTG+1'];
  const names: string[] = [];
  for (let k = 0; k < middle; k++) names.push(k === 0 ? 'UTG' : tail[middle - 1 - k]!);
  return ['BTN', 'SB', 'BB', ...names];
}

/** Indexes into positionNames() in acting order. */
export function actingOrder(players: number, street: 'preflop' | 'postflop'): number[] {
  const all = Array.from({ length: players }, (_, i) => i);
  if (players === 2) return street === 'preflop' ? [0, 1] : [1, 0];
  // Preflop: UTG (index 3, or BTN when 3-handed) … BTN, SB, BB. Postflop: SB, BB, … BTN.
  return street === 'preflop' ? [...all.slice(3), 0, 1, 2] : [...all.slice(1), 0];
}

export const POSITION_INFO: Record<string, L> = {
  BTN: l('딜러 버튼. 포스트플랍에서 가장 마지막에 행동해 가장 유리한 자리입니다.', 'Dealer button. Acts last after the flop — the best seat.'),
  'BTN/SB': l('헤즈업(2인)에서는 버튼이 스몰 블라인드를 내고, 프리플랍에는 먼저, 플랍 이후에는 나중에 행동합니다.', 'Heads-up the button posts the small blind, acts first preflop and last after the flop.'),
  SB: l('스몰 블라인드. 버튼 바로 왼쪽, 빅 블라인드의 절반을 강제로 냅니다.', 'Small blind: left of the button, posts half the big blind.'),
  BB: l('빅 블라인드. 프리플랍에서 가장 마지막에 행동합니다.', 'Big blind: posts the full blind and acts last preflop.'),
  UTG: l('Under the Gun. 프리플랍에서 가장 먼저 행동하는 자리입니다.', 'Under the Gun: first to act preflop.'),
  'UTG+1': l('UTG 다음 자리.', 'The seat after UTG.'),
  MP: l('미들 포지션.', 'Middle position.'),
  LJ: l('로잭(Lojack). 하이잭 오른쪽.', 'Lojack: right of the hijack.'),
  HJ: l('하이잭(Hijack). 컷오프 오른쪽.', 'Hijack: right of the cutoff.'),
  CO: l('컷오프(Cutoff). 버튼 바로 오른쪽, 버튼 다음으로 유리한 자리입니다.', 'Cutoff: right of the button, the second-best seat.'),
};

export const TOUR: { target: string; name: L; body: L }[] = [
  { target: '[data-testid=seat-0]', name: l('내 좌석', 'Your seat'), body: l('항상 화면 아래쪽에 표시됩니다. 닉네임과 칩 스택(남은 칩)이 보입니다.', 'Always shown at the bottom, with your name and chip stack.') },
  { target: '[data-testid=seat-0] [data-card]', name: l('내 홀카드', 'Your hole cards'), body: l('나만 볼 수 있는 2장입니다. 상대의 홀카드는 뒷면으로 보입니다.', 'Two cards only you can see. Opponents’ cards show their backs.') },
  { target: '[data-testid=board]', name: l('커뮤니티 카드', 'Community cards'), body: l('모두가 함께 쓰는 최대 5장의 카드입니다.', 'Up to five shared cards everyone can use.') },
  { target: '[data-testid=pot]', name: l('팟 (Pot)', 'Pot'), body: l('이번 핸드에 걸린 칩의 합계. 이긴 사람이 가져갑니다.', 'All chips bet this hand; the winner takes them.') },
  { target: '[data-testid=stack-0]', name: l('칩 스택', 'Chip stack'), body: l('지금 테이블에서 쓸 수 있는 내 칩입니다.', 'The chips you have in front of you.') },
  { target: '[data-testid=dealer-button]', name: l('딜러 버튼 (D)', 'Dealer button (D)'), body: l('매 핸드 시계 방향으로 한 칸씩 이동합니다. 블라인드와 행동 순서의 기준입니다.', 'Moves one seat clockwise each hand and sets the blinds and acting order.') },
  { target: '[data-tour=blind-SB]', name: l('스몰 블라인드 (SB)', 'Small blind (SB)'), body: l('버튼 왼쪽 사람이 내는 작은 의무 베팅.', 'The small forced bet, left of the button.') },
  { target: '[data-tour=blind-BB]', name: l('빅 블라인드 (BB)', 'Big blind (BB)'), body: l('SB 왼쪽 사람이 내는 큰 의무 베팅. 최소 베팅 단위가 됩니다.', 'The larger forced bet; it sets the minimum bet size.') },
  { target: '[data-tour=timer]', name: l('턴 타이머', 'Turn timer'), body: l('차례인 사람의 아바타 주위 링이 줄어듭니다. 시간이 다 되면 체크 가능할 때 체크, 아니면 자동 폴드됩니다.', 'The ring around the acting player shrinks; at zero you check if free, otherwise fold.') },
  { target: '[data-testid=action-bar]', name: l('액션 버튼', 'Action buttons'), body: l('내 차례에만 나타납니다. 폴드·체크·콜·벳·레이즈·올인 중 가능한 것만 보입니다.', 'Appear only on your turn, showing just the legal choices.') },
];
