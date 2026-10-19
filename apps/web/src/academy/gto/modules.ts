/**
 * Advanced GTO Academy: the ten modules. Written for this academy from standard poker theory; the numbers in the
 * examples are worked out with the formulas in ./math (the tests recompute the ones that the quizzes use).
 */
import { l } from '../content';
import type { GtoModule, GtoModuleId } from './types';

export const MODULES: GtoModule[] = [
  {
    id: 'foundations',
    title: l('GTO 기초', 'GTO foundations'),
    summary: l('균형 잡힌 전략이 무엇이고, 왜 상대가 이용할 수 없는지', 'What a balanced strategy is and why it cannot be exploited'),
    goals: [
      l('GTO와 내시 균형이 무엇을 보장하고 무엇을 보장하지 않는지 말할 수 있다.', 'Say what GTO and a Nash equilibrium guarantee, and what they do not.'),
      l('“상대의 선택을 무차별하게 만든다”는 말의 뜻을 숫자로 설명할 수 있다.', 'Explain with numbers what “making the opponent indifferent” means.'),
      l('GTO를 기준선으로, 익스플로잇을 조정으로 구분할 수 있다.', 'Tell a GTO baseline apart from an exploitative adjustment.'),
    ],
    steps: [
      {
        id: 'what',
        title: l('GTO란 무엇인가', 'What GTO means'),
        sections: [
          {
            paras: [
              l(
                'GTO(Game Theory Optimal)는 게임 이론의 “균형”에 가까운 전략을 말합니다. 두 사람이 겨루는 게임에서 균형 전략을 쓰면, 상대가 어떤 전략으로 바꾸더라도 나에게서 평균적으로 더 빼앗아 갈 수 없습니다. 이것을 “이용(익스플로잇)당하지 않는다”고 합니다.',
                'GTO (game theory optimal) means a strategy close to a game-theory equilibrium. In a two-player game, if you play the equilibrium, no change in your opponent’s strategy can take more from you on average. That is what “unexploitable” means.',
              ),
              l(
                '중요한 것은 GTO가 “상대를 가장 많이 이기는” 전략이 아니라는 점입니다. 실수가 많은 상대를 만나면 그 실수를 노리는 전략이 더 많이 법니다. GTO는 상대가 누구든 크게 지지 않는 출발점입니다.',
                'GTO is not the strategy that beats each opponent by the most. Against a player who makes mistakes, a strategy that targets those mistakes earns more. GTO is the starting point that does not lose much to anyone.',
              ),
            ],
            bullets: [
              l('여러 명이 함께하는 팟에서는 두 사람 게임처럼 깔끔한 보장이 없습니다.', 'In multi-way pots there is no clean two-player guarantee.'),
              l('실제 포커는 너무 커서 완전한 GTO를 아는 사람은 없습니다. 계산 프로그램(솔버)도 정해 둔 가정 아래에서 근사값을 냅니다.', 'Real poker is too big for anyone to know full GTO. Solver programs also give approximations under assumptions they are given.'),
              l('이 아카데미는 솔버를 쓰지 않습니다. 모든 숫자는 단순한 모델과 공식으로 계산하며, 그 모델을 함께 적습니다.', 'This academy uses no solver. Every number comes from a simple model and formula, and the model is stated with it.'),
            ],
          },
        ],
      },
      {
        id: 'indifference',
        title: l('무차별: 상대의 선택을 같게 만들기', 'Indifference: making the choices equal'),
        sections: [
          {
            paras: [
              l(
                '가위바위보를 생각해 보세요. 세 가지를 1/3씩 섞어 내면 상대가 무엇을 내든 기대값이 0으로 같습니다. 상대가 어떤 선택을 해도 차이가 없게 만드는 것, 이것이 “무차별”입니다.',
                'Think of rock-paper-scissors. If you mix all three a third of the time each, your opponent’s expected value is 0 whatever they throw. Leaving them no better choice is called “indifference”.',
              ),
              l(
                '포커에서도 같습니다. 리버에서 베팅하는 쪽은 블러프 비율로 콜하는 쪽을 무차별하게 만들고, 콜하는 쪽은 방어 빈도로 블러프를 무차별하게 만듭니다. 아래 도구에서 블러프 비율과 콜 빈도를 바꿔 보세요.',
                'Poker works the same way. On the river the bettor’s bluff share leaves the caller indifferent, and the caller’s defence frequency leaves the bluffs indifferent. Move the bluff share and the call frequency in the tool below.',
              ),
            ],
            example: {
              title: l('예시: 팟 크기 베팅', 'Example: a pot-size bet'),
              lines: [
                l('팟 100, 베팅 100. 콜하는 쪽은 100을 내고 300짜리 팟을 노립니다. → 필요 에퀴티 100 ÷ 300 = 33.3%', 'Pot 100, bet 100. The caller puts in 100 to win a pot of 300. → needs 100 ÷ 300 = 33.3%'),
                l('베팅 레인지의 1/3이 블러프면 콜의 기대값은 0: 콜하든 폴드하든 같습니다.', 'If a third of the betting range is bluffs, calling has EV 0: calling and folding are equal.'),
                l('콜하는 쪽이 절반(100 ÷ 200)을 지키면 블러프의 기대값도 0입니다.', 'If the caller defends half the time (100 ÷ 200), the bluffs have EV 0 too.'),
              ],
            },
          },
        ],
        tool: 'indifference',
      },
      {
        id: 'baseline',
        title: l('기준선과 조정', 'Baseline and adjustments'),
        sections: [
          {
            paras: [
              l(
                '균형 전략은 수비에 강합니다. 상대가 강하거나 처음 만난 상대라면 균형에 가깝게 두는 것이 안전합니다. 반대로 상대가 한쪽으로 크게 치우친 것이 분명하면 그 방향으로 조정해 더 벌 수 있습니다(모듈 10).',
                'A balanced strategy is a strong defence. Against a strong or unknown opponent, staying close to balance is the safe choice. When an opponent clearly leans one way, adjusting toward it earns more (module 10).',
              ),
              l('조정은 공짜가 아닙니다. 상대를 노리는 만큼 나도 균형에서 벗어나고, 상대가 눈치채면 그 틈을 역으로 이용당할 수 있습니다.', 'Adjustments are not free. Leaning toward an opponent moves you away from balance, and an opponent who notices can turn that against you.'),
            ],
            bullets: [
              l('혼합 전략: 같은 상황에서 여러 선택을 정해 둔 비율로 섞는 것(예: 블러프 캐처로 절반은 콜, 절반은 폴드).', 'Mixed strategy: playing several choices in one spot at set rates (say, calling half the time with a bluff-catcher and folding the rest).'),
              l('최적 대응: 상대 전략을 알 때 그에 맞춰 가장 많이 버는 전략. 대개 한쪽 선택만 고르는 “순수” 전략이 됩니다.', 'Best response: the strategy that earns most against a known opponent strategy. It is usually “pure”, taking one choice only.'),
              l('균형 전략과 최적 대응의 차이: 균형은 누구에게나 버티고, 최적 대응은 그 한 상대에게만 최대이며 다른 상대에게는 약할 수 있습니다.', 'Equilibrium versus best response: the equilibrium holds up against anyone; a best response is the most against that one opponent and can be weak against others.'),
            ],
          },
        ],
      },
    ],
    review: [
      l('GTO는 이용당하지 않는 기준선이지, 모든 상대를 가장 많이 이기는 전략이 아니다.', 'GTO is an unexploitable baseline, not the strategy that beats everyone by the most.'),
      l('균형은 상대의 선택을 무차별하게(기대값이 같게) 만드는 데서 나온다.', 'Balance comes from leaving the opponent indifferent (equal EV between choices).'),
      l('완전한 GTO는 누구도 모른다. 이 아카데미의 숫자는 명시한 단순 모델의 값이다.', 'Nobody knows full GTO. The numbers here belong to the simple models they state.'),
    ],
  },
  {
    id: 'ranges',
    title: l('핸드 레인지', 'Hand ranges'),
    summary: l('한 장면에서 가질 수 있는 핸드 전체로 생각하기', 'Thinking in every hand a player can hold'),
    goals: [
      l('페어 6, 수딧 4, 오프수딧 12 콤보를 바로 셀 수 있다.', 'Count 6 pair, 4 suited and 12 offsuit combos at a glance.'),
      l('13×13 매트릭스를 읽고 레인지의 크기를 퍼센트로 말할 수 있다.', 'Read the 13×13 matrix and give a range’s size as a percentage.'),
      l('내 카드와 보드가 상대 콤보를 얼마나 지우는지(카드 제거) 계산할 수 있다.', 'Work out how many of the opponent’s combos your cards and the board remove (card removal).'),
    ],
    steps: [
      {
        id: 'think',
        title: l('한 핸드가 아니라 레인지로', 'Ranges, not single hands'),
        sections: [
          {
            paras: [
              l(
                '상대의 카드를 정확히 맞히는 것은 불가능합니다. 대신 “이 액션을 이 자리에서 할 만한 핸드 전체”를 떠올립니다. 이것이 레인지입니다. 레인지는 핸드마다 얼마나 자주 그 액션을 하는지(빈도)까지 포함합니다.',
                'You cannot name an opponent’s exact cards. Instead, picture every hand that would take this action from this seat: that is a range. A range also says how often each hand takes the action (its frequency).',
              ),
              l('두 장의 시작 핸드는 모두 1326가지(콤보)이고, 무늬를 묶으면 169종류입니다.', 'There are 1326 two-card starting hands (combos), which group into 169 kinds once suits are set aside.'),
            ],
            bullets: [
              l('포켓 페어(예: 77): 같은 숫자 4장 중 2장 → 6콤보', 'Pocket pair (e.g. 77): 2 of 4 cards of one rank → 6 combos'),
              l('수딧(예: AKs): 무늬가 같은 경우 → 4콤보', 'Suited (e.g. AKs): same suit → 4 combos'),
              l('오프수딧(예: AKo): 4 × 4 − 4 → 12콤보', 'Offsuit (e.g. AKo): 4 × 4 − 4 → 12 combos'),
            ],
          },
        ],
      },
      {
        id: 'matrix',
        title: l('13×13 레인지 매트릭스', 'The 13×13 range matrix'),
        sections: [
          {
            paras: [
              l(
                '대각선은 페어, 대각선 오른쪽 위는 수딧, 왼쪽 아래는 오프수딧입니다. 칸을 눌러 레인지를 만들고, 콤보 수와 전체 대비 비율을 확인하세요. 프리셋은 포지션별 예시 오픈 레인지입니다(솔버 결과가 아닌 학습용 단순화).',
                'The diagonal holds pairs, above it to the right are suited hands, below it to the left offsuit. Tap cells to build a range and read its combos and share of all hands. The presets are example opening ranges by seat (a teaching simplification, not solver output).',
              ),
            ],
          },
        ],
        tool: 'matrix',
      },
      {
        id: 'removal',
        title: l('카드 제거와 블로커', 'Card removal and blockers'),
        sections: [
          {
            paras: [
              l(
                '내가 가진 카드와 보드에 보이는 카드는 상대가 가질 수 없습니다. 내가 A 한 장을 들고 있으면 상대의 AA는 6콤보에서 3콤보로 줄고, AK는 16콤보에서 12콤보로 줄어듭니다. 상대의 강한 핸드를 줄여 주는 카드를 “블로커”라고 합니다.',
                'Cards in your hand and on the board cannot be in the opponent’s. Holding one ace cuts their AA from 6 combos to 3 and their AK from 16 to 12. A card that removes the opponent’s strong hands is called a “blocker”.',
              ),
            ],
            example: {
              title: l('예시: A♥ 한 장과 보드 A♣ 7♦ 2♠', 'Example: you hold A♥, the board is A♣ 7♦ 2♠'),
              lines: [
                l('남은 A는 A♠, A♦ 두 장 → 상대 AA는 1콤보', 'Two aces are left, A♠ and A♦ → the opponent has 1 combo of AA'),
                l('AK(수딧·오프 모두): 2 × 4 = 8콤보 (원래 16)', 'AK (suited or not): 2 × 4 = 8 combos (16 before)'),
              ],
            },
          },
        ],
        tool: 'combos',
      },
    ],
    review: [
      l('페어 6 · 수딧 4 · 오프수딧 12 · 전체 1326.', 'Pair 6 · suited 4 · offsuit 12 · all 1326.'),
      l('레인지는 핸드의 목록과 각각의 빈도다.', 'A range is a list of hands and how often each one plays.'),
      l('내 카드와 보드는 상대 콤보를 지운다: 블로커는 판단을 바꿀 수 있다.', 'Your cards and the board remove combos: blockers can change a decision.'),
    ],
  },
  {
    id: 'math',
    title: l('포커 수학', 'Poker math'),
    summary: l('팟 오즈, 아웃츠, 기대값(EV)', 'Pot odds, outs and expected value (EV)'),
    goals: [
      l('콜에 필요한 에퀴티를 베팅 ÷ (팟 + 베팅 × 2)로 구할 수 있다.', 'Get the equity a call needs as bet ÷ (pot + 2 × bet).'),
      l('아웃츠로 정확한 확률과 2·4 규칙의 근사값을 비교할 수 있다.', 'Compare the exact odds from outs with the 2-and-4 shortcut.'),
      l('콜과 블러프의 기대값을 계산할 수 있다.', 'Work out the EV of a call and of a bluff.'),
    ],
    steps: [
      {
        id: 'odds',
        title: l('팟 오즈와 필요 에퀴티', 'Pot odds and required equity'),
        sections: [
          {
            paras: [
              l(
                '상대가 베팅하면, 콜하는 금액과 이길 때 받는 팟을 비교합니다. 콜 뒤의 최종 팟에서 내가 낸 몫이 곧 필요 에퀴티입니다. 이 계산은 “이 콜로 액션이 끝나고 더 이상 돈이 들어가지 않는다”는 가정에서 정확합니다.',
                'When someone bets, compare what you call with the pot you would win. Your share of the final pot after the call is the equity you need. This is exact when the call ends the betting and no more money goes in.',
              ),
            ],
            example: {
              title: l('예시: 팟 100, 상대 베팅 50', 'Example: pot 100, opponent bets 50'),
              lines: [
                l('콜 50 → 최종 팟 100 + 50 + 50 = 200', 'Call 50 → final pot 100 + 50 + 50 = 200'),
                l('필요 에퀴티 50 ÷ 200 = 25%', 'Required equity 50 ÷ 200 = 25%'),
                l('비율로 말하면 150 : 50 = 3 : 1', 'As a ratio: 150 to 50, or 3 to 1'),
              ],
            },
          },
        ],
        tool: 'potOdds',
      },
      {
        id: 'outs',
        title: l('아웃츠와 2·4 규칙', 'Outs and the rule of 2 and 4'),
        sections: [
          {
            paras: [
              l(
                '아웃츠는 나를 이기게 만드는 남은 카드입니다. 플랍에서 플러시 드로우는 같은 무늬 13장 중 4장이 보이므로 9아웃츠입니다. 남은 카드가 47장일 때, 두 장(턴과 리버) 안에 한 번이라도 나올 확률은 1 − (38/47 × 37/46) ≈ 35.0%입니다.',
                'Outs are the unseen cards that would make you the winner. A flop flush draw sees 4 of 13 cards of its suit, so it has 9 outs. With 47 cards unseen, the chance one comes on the turn or the river is 1 − (38/47 × 37/46) ≈ 35.0%.',
              ),
              l(
                '테이블에서는 빠르게 “카드 두 장이 남으면 아웃츠 × 4, 한 장이면 × 2”로 어림합니다. 아웃츠가 많을수록 × 4는 실제보다 크게 나옵니다.',
                'At the table, a quick estimate is outs × 4 with two cards to come and × 2 with one. With many outs, × 4 runs higher than the truth.',
              ),
            ],
            bullets: [
              l('가정: 아웃 카드가 나오면 반드시 이기고, 아닌 카드로는 이기지 못한다.', 'Assumption: every out wins and no other card does.'),
              l('“두 장을 다 본다”는 것은 턴에서 더 베팅이 없을 때(예: 올인)만 맞습니다.', '“Seeing both cards” only holds when no more betting happens on the turn (an all-in, for example).'),
            ],
          },
        ],
        tool: 'outs',
      },
      {
        id: 'ev',
        title: l('기대값(EV)', 'Expected value (EV)'),
        sections: [
          {
            paras: [
              l(
                '기대값은 같은 결정을 아주 많이 반복했을 때 한 번에 평균적으로 얻거나 잃는 양입니다. 폴드의 기대값을 0으로 두면, 콜의 기대값은 에퀴티 × (팟 + 베팅 × 2) − 베팅입니다.',
                'Expected value is what a decision wins or loses on average if it is repeated many times. Counting a fold as 0, a call’s EV is equity × (pot + 2 × bet) − bet.',
              ),
              l('블러프(콜당하면 지는 베팅)의 기대값은 폴드 확률 × 팟 − (1 − 폴드 확률) × 베팅입니다.', 'A bluff (a bet that loses when called) has EV = fold rate × pot − (1 − fold rate) × bet.'),
            ],
            example: {
              title: l('예시: 팟 80, 베팅 40, 내 에퀴티 30%', 'Example: pot 80, bet 40, your equity 30%'),
              lines: [
                l('0.30 × (80 + 80) − 40 = 48 − 40 = +8', '0.30 × (80 + 80) − 40 = 48 − 40 = +8'),
                l('필요 에퀴티는 40 ÷ 160 = 25%. 30%가 그보다 높으니 콜이 이득입니다.', 'Required equity is 40 ÷ 160 = 25%. 30% is more, so the call gains.'),
              ],
            },
          },
          {
            title: l('본전 콜과 임플라이드 오즈', 'Break-even calls and implied odds'),
            paras: [
              l(
                '에퀴티가 필요 에퀴티와 정확히 같으면 콜의 기대값은 0, 즉 본전 콜입니다. 위 공식은 지금 팟만 셉니다. 실제로는 이후 스트리트의 베팅이 결과를 바꿉니다.',
                'When your equity equals the required equity, the call has EV 0: a break-even call. The formula above counts only today’s pot; later betting changes the result.',
              ),
            ],
            bullets: [
              l('임플라이드 오즈: 드로우가 맞았을 때 더 받을 칩까지 생각하면, 지금 에퀴티가 조금 모자라도 콜할 수 있습니다.', 'Implied odds: counting the chips you win later when the draw hits, a call can be right with a little less equity today.'),
              l('리버스 임플라이드 오즈: 맞아도 더 강한 핸드에 지는 경우(낮은 플러시 등)에는 이후에 더 잃으므로, 필요 에퀴티보다 더 있어야 합니다.', 'Reverse implied odds: when hitting can still lose to a stronger hand (a low flush, say), you lose more later, so you need more than the required equity.'),
              l('둘 다 상대가 얼마나 더 내고 받을지에 대한 추정이라, 정확한 숫자가 아니라 방향으로 씁니다.', 'Both rest on a guess about how much more goes in, so use them as a direction, not an exact number.'),
            ],
          },
        ],
        tool: 'ev',
      },
    ],
    review: [
      l('필요 에퀴티 = 베팅 ÷ (팟 + 베팅 × 2). 팟은 베팅 전 크기.', 'Required equity = bet ÷ (pot + 2 × bet), with the pot before the bet.'),
      l('플랍 9아웃츠는 리버까지 약 35%, 턴 한 장이면 9/46 ≈ 19.6%.', '9 outs on the flop is about 35% by the river; with one card it is 9/46 ≈ 19.6%.'),
      l('EV(콜) = 에퀴티 × (팟 + 베팅 × 2) − 베팅.', 'EV(call) = equity × (pot + 2 × bet) − bet.'),
    ],
  },
  {
    id: 'position',
    title: l('포지션', 'Position'),
    summary: l('나중에 행동하는 쪽이 왜 유리한가', 'Why acting later is an advantage'),
    goals: [
      l('6인 테이블의 자리 이름과 행동 순서를 말할 수 있다.', 'Name the seats of a 6-max table and their order of play.'),
      l('뒤에 남은 사람이 적을수록 오픈 레인지가 넓어지는 이유를 설명할 수 있다.', 'Explain why opening ranges widen as fewer players are left behind.'),
      l('포지션 밖(OOP)에서 무엇을 조정하는지 안다.', 'Know what to adjust when out of position (OOP).'),
    ],
    steps: [
      {
        id: 'why',
        title: l('정보와 주도권', 'Information and control'),
        sections: [
          {
            paras: [
              l(
                '플랍부터는 버튼에 가까운 사람이 나중에 행동합니다. 나중에 행동하면 상대의 선택을 보고 결정할 수 있어, 팟 크기를 조절하고 내 핸드의 에퀴티를 실제로 살려 내기(에퀴티 실현) 쉽습니다.',
                'From the flop on, the player nearer the button acts later. Acting later lets you see the other choice first, so you can control the pot size and realise more of your hand’s equity.',
              ),
            ],
            bullets: [
              l('6인 순서(프리플랍): UTG → HJ → CO → BTN → SB → BB', '6-max order (preflop): UTG → HJ → CO → BTN → SB → BB'),
              l('플랍 이후: SB → BB → UTG → … → BTN(버튼이 마지막)', 'After the flop: SB → BB → UTG → … → BTN (the button acts last)'),
              l('IP(인 포지션): 상대보다 나중에 행동 / OOP: 먼저 행동', 'IP (in position): acting after the opponent / OOP: acting first'),
              l('주도권(이니셔티브): 마지막으로 공격한 쪽(대개 프리플랍 레이저)이 다음 스트리트에서 베팅을 이어 갈 수 있는 위치. 포지션과는 별개입니다.', 'Initiative: the last aggressor (usually the preflop raiser) is placed to keep betting on the next street. It is separate from position.'),
            ],
          },
        ],
      },
      {
        id: 'open',
        title: l('자리마다 다른 오픈 레인지', 'Opening ranges by seat'),
        sections: [
          {
            paras: [
              l(
                '앞자리(UTG)에서 레이즈하면 뒤에 다섯 명이 남아 누군가 강한 핸드를 들었을 가능성이 큽니다. 버튼에서는 두 명(블라인드)만 남고 플랍 이후 포지션도 가집니다. 그래서 같은 핸드라도 자리에 따라 오픈 여부가 달라집니다.',
                'Raising first from UTG leaves five players behind, so someone is more likely to hold a strong hand. From the button only the two blinds are left, and you have position after the flop. So one hand can be an open in one seat and a fold in another.',
              ),
              l('아래 도구의 레인지는 100bb 6인 캐시 게임을 가정한 학습용 예시입니다. 솔버 결과가 아니며 그대로 외울 표도 아닙니다.', 'The ranges in the tool below are teaching examples for a 100-big-blind 6-max cash game. They are not solver output and not a chart to memorise.'),
              l('도구에서 핸드 하나를 골라, 같은 핸드가 자리마다 오픈인지 폴드인지 비교해 보세요.', 'Pick one hand in the tool and compare whether the same hand opens or folds from each seat.'),
            ],
          },
        ],
        tool: 'position',
      },
      {
        id: 'oop',
        title: l('포지션 밖에서', 'Out of position'),
        sections: [
          {
            paras: [
              l(
                '먼저 행동하는 쪽은 정보가 적고 상대에게 마지막 결정권을 넘깁니다. 그래서 보통 더 좁은 레인지로 들어가고, 콜보다 레이즈(3벳)나 폴드를 고르는 경우가 늘며, 플랍 이후에는 체크를 더 자주 섞습니다.',
                'Acting first means less information and handing the last word to the opponent. So players usually enter with tighter ranges, choose a raise (3-bet) or a fold over a call more often, and check more after the flop.',
              ),
              l('빅 블라인드는 예외적으로 이미 1bb를 냈기 때문에 싸게 콜할 수 있어 넓게 방어합니다(손 분석 참고).', 'The big blind is the exception: it already has 1 bb in, so calling is cheap and it defends wide (see the hand analyses).'),
            ],
          },
        ],
      },
    ],
    review: [
      l('나중에 행동할수록 정보가 많고 팟을 조절하기 쉽다.', 'Acting later gives more information and more control of the pot.'),
      l('뒤에 남은 사람이 적을수록 오픈 레인지가 넓어진다.', 'The fewer players behind, the wider the opening range.'),
      l('포지션 밖에서는 더 좁게 들어가고 체크를 더 섞는다.', 'Out of position, enter tighter and check more often.'),
    ],
  },
  {
    id: 'texture',
    title: l('보드 텍스처', 'Board texture'),
    summary: l('보드가 어느 레인지를 돕는가', 'Which range a board helps'),
    goals: [
      l('드라이·웻, 페어·모노톤·연결된 보드를 구분할 수 있다.', 'Tell dry from wet, and spot paired, monotone and connected boards.'),
      l('레인지 우위와 너트 우위를 설명할 수 있다.', 'Explain range advantage and nut advantage.'),
      l('텍스처에 따라 베팅 빈도와 크기가 어떻게 달라지는지 안다.', 'Know how texture changes how often and how big people bet.'),
    ],
    steps: [
      {
        id: 'read',
        title: l('드라이 보드와 웻 보드', 'Dry and wet boards'),
        sections: [
          {
            paras: [
              l(
                'K♠ 7♦ 2♣처럼 무늬가 다르고 숫자가 떨어진 보드는 “드라이”합니다. 드로우가 적어 턴·리버에 순위가 잘 바뀌지 않습니다. 9♥ 8♥ 7♣처럼 이어지고 같은 무늬가 둘 이상인 보드는 “웻”합니다. 스트레이트·플러시 드로우가 많아 순위가 자주 바뀝니다.',
                'A board like K♠ 7♦ 2♣, with mixed suits and spread ranks, is “dry”: few draws, so the order of hands rarely changes on the turn and river. A board like 9♥ 8♥ 7♣, connected and two-suited, is “wet”: many straight and flush draws, so the order changes often.',
              ),
              l('도구에서 플랍을 골라 분류를 확인해 보세요. 분류 기준은 아래에 함께 적었습니다.', 'Pick a flop in the tool and read how it is classified; the rules are listed with it.'),
            ],
            bullets: [
              l('연결된 보드(9 8 7): 스트레이트와 그 드로우가 많습니다.', 'Connected (9 8 7): many straights and straight draws.'),
              l('페어 보드(Q Q 4): 트립스·풀하우스를 가진 콤보가 적어 상대적으로 드라이합니다.', 'Paired (Q Q 4): few combos make trips or a full house, so it plays drier.'),
              l('모노톤 보드(세 장이 같은 무늬): 이미 플러시가 가능하고, 그 무늬의 높은 카드가 큰 블로커가 됩니다.', 'Monotone (three of one suit): flushes are already possible, and a high card of that suit is a big blocker.'),
              l('드로우 밀도: 플러시·스트레이트 드로우가 될 수 있는 조합이 얼마나 많은가. 많을수록 턴·리버에 순위가 자주 바뀝니다.', 'Draw density: how many combos can be flush or straight draws. The more there are, the more often the order changes later.'),
            ],
          },
        ],
        tool: 'texture',
      },
      {
        id: 'advantage',
        title: l('레인지 우위와 너트 우위', 'Range advantage and nut advantage'),
        sections: [
          {
            paras: [
              l(
                '“레인지 우위”는 한쪽 레인지 전체가 이 보드에서 평균적으로 더 강한 것, “너트 우위”는 가장 강한 핸드(셋, 스트레이트 등)를 더 많이 가진 것을 말합니다.',
                '“Range advantage” means one side’s whole range is stronger on average on this board; “nut advantage” means one side holds more of the strongest hands (sets, straights and so on).',
              ),
              l(
                '프리플랍 레이저는 AA·KK·AK 같은 높은 카드를 더 많이 가지므로 A·K가 보이는 드라이 보드에서 보통 유리합니다. 빅 블라인드처럼 넓게 콜한 쪽은 작은 연결 카드와 작은 페어가 많아 7♥ 6♥ 5♣ 같은 낮고 이어진 보드에서 너트를 더 자주 가집니다.',
                'The preflop raiser holds more high cards such as AA, KK and AK, so ace- or king-high dry boards usually favour them. A side that called wide, like the big blind, has more small connected cards and small pairs, so on low connected boards like 7♥ 6♥ 5♣ it holds the nuts more often.',
              ),
            ],
          },
        ],
      },
      {
        id: 'betting',
        title: l('텍스처와 베팅', 'Texture and betting'),
        sections: [
          {
            paras: [
              l(
                '일반적인 경향으로, 레인지 우위가 크고 드라이한 보드에서는 작은 베팅을 자주 쓰고, 웻하거나 상대가 너트를 더 가진 보드에서는 베팅 빈도를 줄이거나 더 크게 베팅합니다. 이것은 규칙이 아니라 경향이며, 상대와 스택에 따라 달라집니다.',
                'As a general tendency, players bet small and often on dry boards where they have a big range advantage, and bet less often or bigger on wet boards or where the opponent has more nuts. These are tendencies, not rules: they move with opponents and stacks.',
              ),
            ],
          },
        ],
      },
    ],
    review: [
      l('드라이: 순위가 잘 안 바뀜 / 웻: 드로우가 많아 자주 바뀜.', 'Dry: the order rarely changes / wet: many draws, it changes often.'),
      l('높은 드라이 보드는 대개 프리플랍 레이저, 낮고 이어진 보드는 넓게 콜한 쪽을 돕는다.', 'High dry boards usually help the preflop raiser; low connected ones help the wide caller.'),
      l('레인지 우위가 클수록 작은 베팅을 자주 쓰는 경향이 있다.', 'A big range advantage tends to mean small, frequent bets.'),
    ],
  },
  {
    id: 'sizing',
    title: l('베팅 사이즈', 'Bet sizing'),
    summary: l('베팅 크기가 상대에게 요구하는 것', 'What a bet size asks of the opponent'),
    goals: [
      l('베팅 크기마다 상대의 필요 에퀴티와 MDF를 말할 수 있다.', 'Give the caller’s required equity and the MDF for each bet size.'),
      l('폴라라이즈드 레인지와 리니어 레인지의 사이즈 차이를 설명할 수 있다.', 'Explain how polarised and linear ranges choose sizes.'),
      l('기하(지오메트릭) 사이즈의 뜻을 안다.', 'Know what geometric sizing means.'),
    ],
    steps: [
      {
        id: 'price',
        title: l('크기가 정하는 가격', 'The price a size sets'),
        sections: [
          {
            paras: [
              l('베팅이 클수록 콜하는 쪽이 내야 할 가격이 비싸집니다. 슬라이더로 크기를 바꾸며 숫자를 비교해 보세요.', 'The bigger the bet, the higher the price for the caller. Move the slider and compare the numbers.'),
            ],
            bullets: [
              l('팟의 1/3 → 필요 에퀴티 20%', '1/3 pot → required equity 20%'),
              l('팟의 1/2 → 25%', '1/2 pot → 25%'),
              l('팟의 2/3 → 약 28.6%', '2/3 pot → about 28.6%'),
              l('팟 크기 → 33.3%', 'Pot → 33.3%'),
              l('팟의 2배(오버벳) → 40%', '2× pot (overbet) → 40%'),
            ],
          },
        ],
        tool: 'sizing',
      },
      {
        id: 'shape',
        title: l('폴라라이즈드와 리니어', 'Polarised and linear'),
        sections: [
          {
            paras: [
              l(
                '“폴라라이즈드” 레인지는 아주 강한 핸드와 블러프로 이루어지고 중간 핸드는 체크합니다. 중간이 없으니 크게 베팅해 강한 핸드의 값을 키우고, 블러프도 더 큰 폴드를 얻습니다.',
                'A “polarised” range is made of very strong hands and bluffs, with the medium hands checked. With nothing in the middle, it bets big to get more from the strong hands, and its bluffs get more folds.',
              ),
              l(
                '“리니어(머지드)” 레인지는 강한 것부터 중간까지 넓게 베팅합니다. 더 약한 핸드에게서도 콜을 받아야 하므로 작게 베팅하는 경우가 많습니다.',
                'A “linear” (merged) range bets from the strongest down into the medium hands. It needs calls from weaker hands, so it usually bets small.',
              ),
            ],
          },
        ],
      },
      {
        id: 'geometric',
        title: l('기하 사이즈', 'Geometric sizing'),
        sections: [
          {
            paras: [
              l(
                '남은 스트리트마다 팟 대비 같은 비율로 베팅해 리버에서 정확히 올인이 되게 하는 크기를 기하 사이즈라고 합니다. 양쪽이 매번 콜한다고 가정하면, 비율 f는 (1 + 2f)^스트리트 수 = 1 + 2 × 스택 ÷ 팟에서 나옵니다.',
                'Betting the same fraction of the pot on each street left, so that the river bet is exactly all-in, is called geometric sizing. If both sides call each time, the fraction f solves (1 + 2f)^streets = 1 + 2 × stack ÷ pot.',
              ),
            ],
            example: {
              title: l('예시: 팟 10, 남은 스택 45, 세 스트리트', 'Example: pot 10, stacks 45, three streets'),
              lines: [
                l('1 + 2 × 45 ÷ 10 = 10 → 1 + 2f = 10^(1/3) ≈ 2.154 → f ≈ 0.58', '1 + 2 × 45 ÷ 10 = 10 → 1 + 2f = 10^(1/3) ≈ 2.154 → f ≈ 0.58'),
                l('플랍 5.8 → 턴 12.4 → 리버 26.8: 합계 45로 올인', 'Flop 5.8 → turn 12.4 → river 26.8: 45 in total, all-in'),
              ],
            },
          },
        ],
      },
      {
        id: 'spr',
        title: l('SPR과 프로텍션', 'SPR and protection'),
        sections: [
          {
            paras: [
              l(
                'SPR(스택 대 팟 비율)은 플랍에서 남은 유효 스택 ÷ 팟입니다. SPR이 낮으면 몇 번의 베팅으로 올인이 되므로 탑 페어 같은 핸드도 끝까지 가기 쉽고, SPR이 높으면 한 페어로 스택 전체를 걸기에는 위험이 커집니다.',
                'SPR (stack-to-pot ratio) is the effective stack left on the flop divided by the pot. With a low SPR a few bets put everyone all-in, so a hand like top pair often goes the distance; with a high SPR, risking the whole stack with one pair gets dangerous.',
              ),
              l(
                '프로텍션은 지금 앞서 있지만 다음 카드에 쉽게 역전당하는 핸드로 베팅해, 상대 드로우에게 공짜 카드를 주지 않는 것입니다. 웻 보드일수록, SPR이 낮을수록 의미가 커집니다.',
                'Protection is betting a hand that is ahead now but easily outdrawn, so the opponent’s draws do not see a free card. It matters more on wet boards and at low SPR.',
              ),
            ],
            bullets: [
              l('예시: 팟 20, 유효 스택 60 → SPR 3. 팟 크기 베팅 한 번과 콜(20)이면 남은 스택 40, 팟 60으로 다음 베팅에서 올인이 됩니다.', 'Example: pot 20, effective stack 60 → SPR 3. One pot-size bet and call (20) leaves 40 behind into a pot of 60, so the next bet is all-in.'),
              l('구간은 경향일 뿐입니다: 대략 3 이하 “낮음”, 3–8 “중간”, 8 이상 “높음”으로 나눠 설명하지만 정해진 기준은 아닙니다.', 'The bands are only tendencies: roughly 3 or less is “low”, 3–8 “medium” and above 8 “high”, but there is no fixed line.'),
            ],
          },
        ],
        tool: 'spr',
      },
    ],
    review: [
      l('사이즈가 커지면 상대의 필요 에퀴티가 오르고 MDF가 내려간다.', 'Bigger sizes raise the caller’s required equity and lower the MDF.'),
      l('폴라라이즈드 레인지는 크게, 리니어 레인지는 작게 베팅하는 경향이 있다.', 'Polarised ranges tend to bet big, linear ranges small.'),
      l('기하 사이즈: 스트리트마다 같은 비율로 리버 올인을 맞춘다.', 'Geometric sizing: the same fraction each street, ending all-in on the river.'),
    ],
  },
  {
    id: 'bluffing',
    title: l('블러프 이론', 'Bluffing theory'),
    summary: l('왜, 얼마나, 어떤 핸드로 블러프하는가', 'Why, how often and with which hands to bluff'),
    goals: [
      l('균형 잡힌 리버 블러프 비율을 베팅 크기로 구할 수 있다.', 'Get a balanced river bluff share from the bet size.'),
      l('순수 블러프의 손익분기 폴드 확률(알파)을 계산할 수 있다.', 'Work out a pure bluff’s break-even fold rate (alpha).'),
      l('블로커와 쇼다운 가치로 블러프 후보를 고를 수 있다.', 'Pick bluff candidates by blockers and showdown value.'),
    ],
    steps: [
      {
        id: 'why',
        title: l('블러프가 필요한 이유', 'Why bluffs are needed'),
        sections: [
          {
            paras: [
              l(
                '강한 핸드로만 베팅하면 상대는 베팅을 보면 폴드하면 됩니다. 블러프가 섞여 있어야 상대가 콜해야 하고, 그래야 강한 핸드가 값을 받습니다.',
                'If you only bet strong hands, the opponent can simply fold to every bet. Bluffs in the mix force calls, and the calls are what pay your strong hands.',
              ),
              l(
                '리버에서 상대를 무차별하게 만드는 블러프 비율은 베팅 ÷ (팟 + 베팅 × 2)로, 상대의 필요 에퀴티와 같습니다. 팟 크기 베팅이면 베팅 레인지의 1/3, 팟의 절반이면 1/4이 블러프입니다.',
                'On the river, the bluff share that leaves the caller indifferent is bet ÷ (pot + 2 × bet), the same as the caller’s required equity. For a pot-size bet a third of the betting range is bluffs; for half pot, a quarter.',
              ),
            ],
            bullets: [
              l('가정: 마지막 스트리트, 한 번의 베팅, 콜하는 쪽은 블러프만 이기는 핸드(블러프 캐처)를 가진다.', 'Assumption: the last street, one bet, and the caller holds hands that beat only bluffs (bluff-catchers).'),
              l('밸류 : 블러프 비율로 말하면 (팟 + 베팅) : 베팅입니다. 팟 크기면 2 : 1, 팟의 절반이면 3 : 1.', 'As a value-to-bluff ratio it is (pot + bet) : bet: 2 : 1 for a pot-size bet, 3 : 1 for half pot.'),
            ],
          },
        ],
        tool: 'bluffRatio',
      },
      {
        id: 'alpha',
        title: l('손익분기 폴드 확률(알파)', 'Break-even fold rate (alpha)'),
        sections: [
          {
            paras: [
              l(
                '콜당하면 반드시 지는 순수 블러프는 상대가 베팅 ÷ (팟 + 베팅) 이상 폴드해야 이득입니다. 팟의 절반이면 33%, 팟 크기면 50%입니다. 이 값을 알파라고 하며, 1 − MDF와 같습니다.',
                'A pure bluff, which always loses when called, gains only if the opponent folds at least bet ÷ (pot + bet) of the time. That is 33% for half pot and 50% for a pot-size bet. The number is called alpha, and it equals 1 − MDF.',
              ),
            ],
          },
        ],
        tool: 'ev',
      },
      {
        id: 'choose',
        title: l('어떤 핸드로 블러프할까', 'Which hands to bluff with'),
        sections: [
          {
            paras: [
              l('좋은 블러프 후보에는 공통점이 있습니다.', 'Good bluff candidates share a few traits.'),
            ],
            bullets: [
              l('쇼다운 가치가 없다: 체크하면 거의 이기지 못하는 핸드.', 'No showdown value: a hand that rarely wins if checked down.'),
              l('블로커: 상대가 콜할 강한 핸드를 줄이는 카드(예: 플러시가 가능한 보드에서 그 무늬의 A).', 'Blockers: cards that remove the opponent’s strong calls (e.g. the ace of the suit on a board where a flush is possible).'),
              l('언블로커: 상대가 폴드할 핸드는 막지 않는 카드. 상대의 놓친 드로우를 내가 들고 있지 않아야 그 핸드들이 폴드해 줍니다.', 'Unblockers: cards that leave the opponent’s folding hands alone. If you do not hold their missed draws, those hands are still there to fold.'),
              l('세미 블러프: 플랍·턴에서는 지금은 지고 있어도 좋아질 수 있는 드로우로 베팅해, 폴드와 드로우 두 길로 이깁니다.', 'Semi-bluff: on the flop or turn, betting a draw that is behind now but can improve wins two ways, by folds and by hitting.'),
            ],
          },
        ],
      },
    ],
    review: [
      l('균형 리버 블러프 비율 = 베팅 ÷ (팟 + 베팅 × 2).', 'Balanced river bluff share = bet ÷ (pot + 2 × bet).'),
      l('순수 블러프의 손익분기 폴드 확률 = 베팅 ÷ (팟 + 베팅).', 'A pure bluff breaks even at a fold rate of bet ÷ (pot + bet).'),
      l('쇼다운 가치가 없고 블로커가 있는 핸드가 좋은 블러프 후보다.', 'Hands with no showdown value and good blockers make the best bluffs.'),
    ],
  },
  {
    id: 'mdf',
    title: l('최소 방어 빈도(MDF)', 'Minimum defence frequency (MDF)'),
    summary: l('MDF = P ÷ (P + B), 그리고 그 한계', 'MDF = P ÷ (P + B), and its limits'),
    goals: [
      l('MDF를 계산하고 베팅 크기에 따라 어떻게 변하는지 말할 수 있다.', 'Compute the MDF and say how it moves with the bet size.'),
      l('MDF가 맞지 않는 상황을 설명할 수 있다.', 'Explain the spots where MDF does not apply.'),
    ],
    steps: [
      {
        id: 'formula',
        title: l('공식', 'The formula'),
        sections: [
          {
            paras: [
              l(
                'MDF = P ÷ (P + B). P는 베팅 전 팟, B는 상대의 베팅입니다. 이보다 덜 방어하면(콜·레이즈를 덜 하면) 상대는 어떤 두 장으로든 블러프해서 이득을 봅니다.',
                'MDF = P ÷ (P + B), where P is the pot before the bet and B the bet. Defend (call or raise) less than this and the opponent profits by bluffing with any two cards.',
              ),
            ],
            bullets: [
              l('팟 100, 베팅 50 → 100 ÷ 150 ≈ 66.7%', 'Pot 100, bet 50 → 100 ÷ 150 ≈ 66.7%'),
              l('팟 크기 베팅 → 50%', 'Pot-size bet → 50%'),
              l('팟의 2배 → 33.3%', '2× pot → 33.3%'),
            ],
          },
        ],
        tool: 'mdf',
      },
      {
        id: 'limits',
        title: l('MDF의 한계', 'Where MDF stops'),
        sections: [
          {
            paras: [
              l(
                'MDF는 “상대가 아무 카드로나 블러프할 수 있다”는 최악의 경우를 막는 기준입니다. 실제 판단에서는 다음을 함께 봐야 합니다.',
                'MDF guards against the worst case, a bettor who could bluff with any cards. Real decisions also weigh the following.',
              ),
            ],
            bullets: [
              l('상대의 실제 블러프 빈도: 거의 블러프하지 않는 상대에게는 MDF보다 더 폴드하는 것이 맞습니다.', 'The opponent’s real bluffing: against someone who almost never bluffs, folding more than MDF is right.'),
              l('남은 스트리트: 플랍·턴의 콜은 드로우의 에퀴티도 함께 가집니다.', 'Streets to come: flop and turn calls also carry drawing equity.'),
              l('카드 제거, 레이크, 스택 깊이.', 'Card removal, rake and stack depth.'),
              l('MDF는 레인지 전체의 방어 비율이지 한 핸드의 콜 기준이 아닙니다.', 'MDF is a share of the whole range, not a call rule for one hand.'),
            ],
          },
        ],
      },
      {
        id: 'pair',
        title: l('MDF와 알파', 'MDF and alpha'),
        sections: [
          {
            paras: [
              l(
                'MDF + 알파 = 1입니다. 베팅하는 쪽이 블러프로 이득을 보려면 상대가 알파보다 많이 폴드해야 하고, 방어하는 쪽은 MDF만큼 버텨 그 이득을 0으로 만듭니다. 모듈 1의 무차별 도구에서 두 숫자가 만나는 지점을 다시 확인해 보세요.',
                'MDF + alpha = 1. A bluff gains only if the opponent folds more than alpha; the defender holds on MDF of the time to bring that gain to 0. Revisit the indifference tool in module 1 to see the two numbers meet.',
              ),
            ],
          },
        ],
      },
    ],
    review: [
      l('MDF = P ÷ (P + B), 알파 = B ÷ (P + B), 합은 1.', 'MDF = P ÷ (P + B), alpha = B ÷ (P + B), and they add up to 1.'),
      l('MDF는 최악의 상대를 막는 기준이다: 실제 상대의 블러프 빈도를 함께 본다.', 'MDF guards against the worst case; weigh the real opponent’s bluffing too.'),
      l('MDF는 레인지 단위의 숫자다.', 'MDF is a number for the whole range.'),
    ],
  },
  {
    id: 'streets',
    title: l('턴과 리버', 'Turn and river'),
    summary: l('배럴, 얇은 밸류, 블러프 캐치', 'Barrels, thin value and bluff-catching'),
    goals: [
      l('턴 카드가 어느 레인지를 돕는지 판단할 수 있다.', 'Judge which range a turn card helps.'),
      l('얇은 밸류 베팅의 기준을 말할 수 있다.', 'State the test for a thin value bet.'),
      l('리버 블러프 캐치를 필요 에퀴티와 블러프 비율로 판단할 수 있다.', 'Decide a river bluff-catch with the required equity and the bluff share.'),
    ],
    steps: [
      {
        id: 'turn',
        title: l('턴: 계속 베팅할까', 'Turn: keep betting?'),
        sections: [
          {
            paras: [
              l(
                '턴 카드는 레인지의 힘을 다시 나눕니다. 8♣ 6♦ 2♥ 플랍 뒤의 A♠처럼 높은 카드는 보통 프리플랍 레이저의 레인지를 더 돕고, 5♥처럼 이어지는 낮은 카드는 넓게 콜한 쪽을 더 돕습니다.',
                'The turn card reshuffles the ranges’ strength. A high card like the A♠ after an 8♣ 6♦ 2♥ flop usually helps the preflop raiser’s range more; a low connecting card like the 5♥ helps the wide caller more.',
              ),
              l('턴에서 계속 베팅(배럴)할 핸드는 밸류 핸드와, 리버에서 좋아질 수 있는 드로우가 중심입니다.', 'The hands that keep betting (barrel) on the turn are mostly value hands and draws that can improve on the river.'),
              l('아래 도구에서 한 핸드를 플랍부터 리버까지 따라가며, 스트리트마다 팟·필요 에퀴티·판단 근거가 어떻게 바뀌는지 확인하세요.', 'In the tool below, follow one hand from the flop to the river and watch the pot, the required equity and the reasoning change street by street.'),
            ],
          },
        ],
        tool: 'streetWalk',
      },
      {
        id: 'value',
        title: l('리버: 얇은 밸류', 'River: thin value'),
        sections: [
          {
            paras: [
              l(
                '리버에는 더 나올 카드가 없습니다. 밸류 베팅의 기준은 “콜을 받았을 때 절반 넘게 이기는가”입니다. 상대가 콜할 핸드 중 나보다 약한 것이 더 많다면, 강하지 않은 핸드로도 작게 베팅해 값을 받을 수 있습니다(얇은 밸류).',
                'On the river no cards are left. The test for a value bet is: when called, do you win more than half the time? If more of the opponent’s calling hands are worse than yours, even a medium hand can bet small for value (thin value).',
              ),
            ],
          },
        ],
      },
      {
        id: 'catch',
        title: l('리버: 블러프 캐치', 'River: bluff-catching'),
        sections: [
          {
            paras: [
              l(
                '블러프만 이기는 핸드로 리버 베팅을 마주하면, 상대의 베팅 중 블러프의 비율과 필요 에퀴티를 비교합니다. 블러프 비율이 필요 에퀴티보다 높다고 판단되면 콜, 낮으면 폴드입니다.',
                'Facing a river bet with a hand that beats only bluffs, compare the share of bluffs in the bet with the required equity. If you judge the bluffs to be more than the required equity, call; if fewer, fold.',
              ),
            ],
            bullets: [
              l('블로커 효과: 내 카드가 상대의 밸류 핸드를 지우면 상대 베팅 속 블러프 비율이 올라가 콜이 나아지고, 상대의 블러프(놓친 드로우)를 지우면 반대가 됩니다.', 'Blocker effects: if your cards remove the opponent’s value hands, the bluff share in their bet rises and calling improves; if they remove the bluffs (missed draws), the opposite.'),
              l('레인지 폴라라이즈: 리버의 큰 베팅은 대개 아주 강한 핸드와 블러프로 나뉩니다. 중간 핸드가 적으니 블러프 캐처는 그 블러프 비율로 판단합니다.', 'Range polarisation: a big river bet usually splits into very strong hands and bluffs. With few medium hands in it, a bluff-catcher decides by that bluff share.'),
            ],
          },
        ],
        tool: 'potOdds',
      },
    ],
    review: [
      l('높은 턴 카드는 대개 레이저를, 낮고 이어진 카드는 콜러를 돕는다.', 'High turn cards usually help the raiser, low connecting ones the caller.'),
      l('얇은 밸류: 콜받았을 때 절반 넘게 이기면 베팅한다.', 'Thin value: bet when you win more than half the time you are called.'),
      l('블러프 캐치: 블러프 비율 > 필요 에퀴티면 콜.', 'Bluff-catch: call when the bluff share beats the required equity.'),
    ],
  },
  {
    id: 'exploit',
    title: l('익스플로잇 조정', 'Exploitative adjustments'),
    summary: l('상대의 치우침을 이용하되, 위험을 알고', 'Using an opponent’s leaks, knowing the risks'),
    goals: [
      l('흔한 치우침(폴드 과다·콜 과다·블러프 과다·블러프 부족)에 맞는 조정을 고를 수 있다.', 'Pick the adjustment for common leaks (over-folding, over-calling, over-bluffing, under-bluffing).'),
      l('조정의 위험과 표본 크기의 문제를 설명할 수 있다.', 'Explain the risks of adjusting and the sample-size problem.'),
    ],
    steps: [
      {
        id: 'leaks',
        title: l('흔한 치우침과 조정', 'Common leaks and adjustments'),
        sections: [
          {
            paras: [l('실제 상대는 균형에서 벗어나 있습니다. 대표적인 경우와 단순한 대응입니다.', 'Real opponents are off balance. The typical cases and simple responses:')],
            bullets: [
              l('폴드가 너무 많은 상대 → 블러프를 늘린다(폴드율이 알파보다 높으면 블러프가 이득).', 'Folds too much → bluff more (a bluff gains when the fold rate beats alpha).'),
              l('콜이 너무 많은 상대 → 블러프를 줄이고, 더 얇고 크게 밸류 베팅한다.', 'Calls too much → bluff less, value bet thinner and bigger.'),
              l('블러프가 너무 많은 상대 → 블러프 캐처로 더 콜하고, 내 블러프는 줄인다.', 'Bluffs too much → call more with bluff-catchers, bluff less yourself.'),
              l('블러프가 너무 적은 상대 → 큰 베팅에는 더 폴드한다(MDF보다 적게 방어해도 된다).', 'Bluffs too little → fold more to big bets (defending below MDF is fine).'),
              l('수동적인 상대(체크·콜 위주) → 그 상대의 베팅·레이즈는 강하다고 보고, 나는 밸류 베팅을 늘린다.', 'Passive (mostly checks and calls) → read their bets and raises as strong, and value bet more yourself.'),
              l('공격적인 상대(베팅·레이즈 과다) → 강한 핸드로는 체크해 상대가 베팅하게 두고, 블러프 캐처로 더 버틴다.', 'Over-aggressive (bets and raises too much) → check strong hands to let them bet, and hold on with bluff-catchers more.'),
            ],
          },
          {
            title: l('GTO를 기준선으로', 'GTO as the baseline'),
            paras: [
              l(
                '조정은 균형에서 출발해 “얼마나, 어느 쪽으로” 벗어날지를 정하는 일입니다. 기준선을 알면 상대의 빈도가 어느 쪽으로 치우쳤는지 잴 수 있고, 근거가 약해지면 돌아갈 곳도 생깁니다.',
                'Adjusting means starting from balance and deciding how far, and which way, to move off it. Knowing the baseline lets you measure which way an opponent leans, and gives you a place to return to when the evidence weakens.',
              ),
            ],
          },
        ],
        tool: 'exploit',
      },
      {
        id: 'risk',
        title: l('조정의 위험', 'The risks'),
        sections: [
          {
            paras: [
              l(
                '수십 핸드로 본 빈도는 우연일 수 있습니다. 표본이 작을수록 조정은 작게 하고, 상대가 바뀌는 신호가 보이면 균형 쪽으로 돌아옵니다. 크게 치우친 조정은 그만큼 나를 이용당하기 쉽게 만듭니다.',
                'A frequency seen over a few dozen hands may be luck. The smaller the sample, the smaller the adjustment; at signs that the opponent is changing, drift back toward balance. A large lean makes you that much easier to exploit.',
              ),
            ],
          },
        ],
      },
    ],
    review: [
      l('폴드 과다 → 블러프↑ / 콜 과다 → 블러프↓·밸류↑.', 'Over-folder → bluff more / over-caller → bluff less, value more.'),
      l('블러프 과다 → 더 콜 / 블러프 부족 → 큰 베팅에 더 폴드.', 'Over-bluffer → call more / under-bluffer → fold more to big bets.'),
      l('표본이 작으면 작게 조정하고, 언제든 균형으로 돌아올 준비를 한다.', 'Small sample, small adjustment; be ready to return to balance.'),
    ],
  },
];

export const MODULE_BY_ID = Object.fromEntries(MODULES.map((m) => [m.id, m])) as Record<GtoModuleId, GtoModule>;
