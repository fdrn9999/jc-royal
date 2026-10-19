/**
 * Advanced GTO Academy: the street walk (module "streets"). One example hand followed from the flop to the river, with
 * the pot, the price and the reasoning on each street. Written for this academy; the numbers in the text are the ones
 * ./math gives, and the content test recomputes them.
 */
import type { Card } from '@jc/types';
import { l, type L } from '../content';

export interface WalkStreet {
  street: 'flop' | 'turn' | 'river';
  /** The whole board so far. */
  board: Card[];
  /** Pot before the bet on this street, and the bet. */
  pot: number;
  bet: number;
  /** Who bets: the opponent (hero decides a call) or hero (the opponent decides). */
  bettor: 'villain' | 'hero';
  /** Hero's outs with the cards to come and the unseen cards, when hero is drawing. */
  outs?: { outs: number; cards: 1 | 2; unseen: number };
  action: L;
  decision: L;
  reasoning: L[];
}

export interface StreetWalk {
  title: L;
  spot: L;
  hero: [Card, Card];
  streets: WalkStreet[];
  assumptions: L;
  takeaway: L;
}

export const STREET_WALK: StreetWalk = {
  title: l('빅 블라인드의 J♥ 10♥, 플랍부터 리버까지', 'J♥ 10♥ in the big blind, flop to river'),
  spot: l(
    '6인 캐시, 모두 100bb. 버튼이 2.5bb로 오픈하고 SB는 폴드, 빅 블라인드인 내가 콜했습니다. 플랍 팟은 0.5 + 2.5 + 2.5 = 5.5bb이고, 플랍 이후 나는 먼저 행동합니다.',
    '6-max cash, everyone 100 bb. The button opens to 2.5 bb, the SB folds and you call from the big blind. The flop pot is 0.5 + 2.5 + 2.5 = 5.5 bb, and you act first after the flop.',
  ),
  hero: ['Jh', 'Th'],
  streets: [
    {
      street: 'flop',
      board: ['Qh', '8c', '4h'],
      pot: 5.5,
      bet: 2,
      bettor: 'villain',
      outs: { outs: 12, cards: 2, unseen: 47 },
      action: l('내가 체크하고, 버튼이 2bb를 베팅합니다.', 'You check and the button bets 2 bb.'),
      decision: l('콜 (체크 레이즈를 섞어도 되는 자리)', 'Call (a spot where a check-raise can be mixed in)'),
      reasoning: [
        l('콜 뒤 팟은 5.5 + 2 + 2 = 9.5bb, 필요 에퀴티는 2 ÷ 9.5 ≈ 21.1%입니다.', 'After the call the pot is 5.5 + 2 + 2 = 9.5 bb, so you need 2 ÷ 9.5 ≈ 21.1%.'),
        l('아웃: 남은 하트 9장(플러시)과 하트가 아닌 9 세 장(스트레이트)으로 12장. 두 장이 남아 정확히 세면 약 45%이고, 4의 법칙으로는 48%입니다.', 'Outs: the 9 hearts left (flush) and the three non-heart nines (straight), 12 in all. With two cards to come that is about 45% exactly, 48% by the rule of 4.'),
        l('필요한 21.1%보다 훨씬 높아 폴드는 실수입니다. 드로우가 둘 겹친 핸드라 체크 레이즈(세미 블러프)도 좋은 선택이고, 균형 잡힌 전략은 둘을 섞습니다.', 'That is far above the 21.1% needed, so folding is a mistake. With two draws at once a check-raise (semi-bluff) is also good, and a balanced strategy mixes both.'),
        l('단, 45%는 두 장을 끝까지 공짜로 본다는 가정의 값입니다. 턴에 또 베팅이 오므로 실제로는 에퀴티를 다 실현하지 못합니다.', 'But 45% assumes seeing both cards for free. Another bet comes on the turn, so in play you realise less of it.'),
      ],
    },
    {
      street: 'turn',
      board: ['Qh', '8c', '4h', '2s'],
      pot: 9.5,
      bet: 6.5,
      bettor: 'villain',
      outs: { outs: 12, cards: 1, unseen: 46 },
      action: l('턴은 2♠. 내가 체크하고, 버튼이 6.5bb(팟의 약 68%)를 베팅합니다.', 'The turn is the 2♠. You check and the button bets 6.5 bb (about 68% of the pot).'),
      decision: l('콜 (임플라이드 오즈를 보고)', 'Call (on implied odds)'),
      reasoning: [
        l('콜 뒤 팟은 9.5 + 6.5 + 6.5 = 22.5bb, 필요 에퀴티는 6.5 ÷ 22.5 ≈ 28.9%입니다.', 'After the call the pot is 9.5 + 6.5 + 6.5 = 22.5 bb, so you need 6.5 ÷ 22.5 ≈ 28.9%.'),
        l('보이지 않는 46장 중 아웃 12장: 리버에 맞을 확률은 12 ÷ 46 ≈ 26.1%로, 지금 가격만으로는 조금 모자랍니다.', 'Twelve outs among 46 unseen cards: the river hits 12 ÷ 46 ≈ 26.1% of the time, a little short at today’s price alone.'),
        l('맞았을 때 리버에서 평균 약 2.4bb만 더 받으면 본전입니다(6.5 ÷ 26.1% − 22.5). 남은 스택이 89bb라 기대할 만한 크기입니다.', 'You break even if a hit wins about 2.4 bb more on the river on average (6.5 ÷ 26.1% − 22.5). With 89 bb behind, that is a fair hope.'),
        l('주의: 하트가 나와 플러시가 돼도 상대가 A♥·K♥가 든 더 높은 플러시 드로우였다면 집니다. 이런 역 임플라이드 오즈만큼 아웃의 값은 줄어듭니다.', 'Careful: a heart makes your flush, but loses to a higher flush draw with the A♥ or K♥. Such reverse implied odds take some value off the outs.'),
      ],
    },
    {
      street: 'river',
      board: ['Qh', '8c', '4h', '2s', '9d'],
      pot: 22.5,
      bet: 15,
      bettor: 'hero',
      action: l('리버 9♦로 8-9-10-J-Q 스트레이트가 완성됐습니다. 내가 먼저 행동합니다.', 'The 9♦ river completes your 8-9-10-J-Q straight. You act first.'),
      decision: l('15bb(팟의 2/3)로 밸류 베팅', 'Bet 15 bb (two-thirds of the pot) for value'),
      reasoning: [
        l('보드에 페어도, 같은 문양 세 장도 없어 풀하우스와 플러시가 불가능합니다. 내 스트레이트를 이기는 핸드는 없고, 같은 J-10만 비깁니다.', 'The board has no pair and no three of a suit, so no full house or flush is possible. Nothing beats your straight; only another J-10 ties.'),
        l('밸류 베팅의 기준(콜을 받으면 절반 넘게 이긴다)을 넉넉히 넘습니다.', 'It clears the value-bet test (win more than half the time when called) with room to spare.'),
        l('버튼이 15bb를 콜하려면 15 ÷ (22.5 + 30) ≈ 28.6%를 이겨야 합니다. 퀸 페어 같은 핸드는 내 블러프도 있다고 보고 콜할 수 있고, 그 콜이 값을 내 줍니다.', 'To call 15 bb the button needs 15 ÷ (22.5 + 30) ≈ 28.6%. Hands like a pair of queens may call, counting on some bluffs from you, and those calls pay you.'),
        l('9는 넓게 콜한 BB 쪽의 J-10 같은 연결 핸드를 완성시키는 카드라, 먼저 베팅해도 자연스럽습니다. 체크 레이즈를 노릴 수도 있지만 버튼이 체크로 넘기면 받을 값을 놓칩니다.', 'The 9 completes connected hands like J-10 that the wide-calling BB holds, so leading is natural. You could try for a check-raise, but if the button checks behind you miss the value.'),
      ],
    },
  ],
  assumptions: l(
    '학습용 예시입니다. 에퀴티는 아웃 모델(아웃이 나오면 이기고 아니면 진다)로 세었고, 상대의 카드는 보이지 않는 카드로 세었습니다. 솔버 결과가 아닙니다.',
    'A teaching example. Equity uses the outs model (an out wins, anything else loses), counting the opponent’s cards as unseen. Not solver output.',
  ),
  takeaway: l(
    '스트리트마다 팟과 가격이 바뀌어, 같은 드로우라도 콜의 근거가 직접 가격(플랍)에서 임플라이드 오즈(턴)로 옮겨 갑니다.',
    'The pot and the price change every street: the same draw calls on the direct price on the flop and on implied odds on the turn.',
  ),
};
