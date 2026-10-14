import type { ActionType } from '@jc/types';
import { l, type L } from '../content';
import type { ChoiceQuestion } from '../quiz';

export const ACTIONS: { type: ActionType; ko: string; en: string; what: L; when: L; note?: L }[] = [
  {
    type: 'fold',
    ko: '폴드',
    en: 'Fold',
    what: l('이번 핸드를 포기합니다. 카드를 내려놓고 더 이상 참여하지 않습니다.', 'Give up the hand: your cards go away and you are out until the next hand.'),
    when: l('상대의 베팅을 따라가기에 패가 약할 때.', 'When your hand is not worth matching a bet.'),
    note: l('이미 팟에 넣은 칩(블라인드 포함)은 돌려받지 못합니다.', 'Chips you already put in (including blinds) stay in the pot.'),
  },
  {
    type: 'check',
    ko: '체크',
    en: 'Check',
    what: l('칩을 더 넣지 않고 차례를 넘깁니다.', 'Pass the turn without putting in chips.'),
    when: l('이번 라운드에 내가 맞춰야 할 베팅이 없을 때만 가능합니다.', 'Only when there is no bet for you to match.'),
  },
  {
    type: 'call',
    ko: '콜',
    en: 'Call',
    what: l('상대의 베팅과 같아지도록 필요한 만큼 칩을 넣습니다.', 'Put in just enough chips to match the current bet.'),
    when: l('누군가 베팅했고, 그 금액만큼 따라가고 싶을 때.', 'Someone bet and you want to continue for that price.'),
  },
  {
    type: 'bet',
    ko: '벳',
    en: 'Bet',
    what: l('이번 라운드에서 처음으로 칩을 겁니다.', 'Put chips in first on this betting round.'),
    when: l('아직 아무도 베팅하지 않았을 때. 최소 금액은 빅 블라인드입니다.', 'When nobody has bet yet. The minimum is one big blind.'),
  },
  {
    type: 'raise',
    ko: '레이즈',
    en: 'Raise',
    what: l('이미 있는 베팅보다 금액을 높입니다.', 'Increase an existing bet.'),
    when: l('베팅이 있고 더 크게 걸고 싶을 때.', 'There is a bet and you want to make it bigger.'),
    note: l('직전 베팅(또는 레이즈)이 올린 만큼 이상 더 올려야 합니다. 예) 10 → 30 으로 올렸다면 다음 레이즈는 최소 50. 최대는 남은 스택 전부입니다.', 'You must raise by at least as much as the last bet or raise added. E.g. after 10 → 30 the next raise is to at least 50. The maximum is your whole stack.'),
  },
  {
    type: 'allin',
    ko: '올인',
    en: 'All-in',
    what: l('남은 칩 전부를 겁니다.', 'Bet every chip you have left.'),
    when: l('강한 패이거나, 남은 칩이 적어 다른 선택이 의미 없을 때.', 'With a strong hand, or when your stack is too short for anything else.'),
    note: l('스택보다 큰 금액은 낼 수 없으므로, 올인한 사람은 자기가 넣은 만큼만 각 상대에게서 이길 수 있습니다. 넘는 칩은 다른 사람들끼리의 사이드 팟이 됩니다.', 'You can never be forced to bet more than you have, so an all-in player can only win as much from each opponent as they put in. The rest forms a side pot among the others.'),
  },
];

export const ACTION_QUIZ: ChoiceQuestion[] = [
  {
    kind: 'choice',
    topic: 'actions',
    id: 'a-free',
    prompt: l('아무도 베팅하지 않았습니다. 칩을 넣지 않고 차례를 넘기려면?', 'Nobody has bet. How do you pass without putting in chips?'),
    options: [
      { id: 'fold', label: l('폴드', 'Fold') },
      { id: 'check', label: l('체크', 'Check') },
      { id: 'call', label: l('콜', 'Call') },
    ],
    answer: 'check',
    why: l('폴드는 핸드를 포기하는 것이고, 콜은 맞출 베팅이 있을 때 씁니다.', 'Fold gives up the hand; call is for matching an existing bet.'),
    explain: l('맞출 베팅이 없을 때는 체크로 무료로 넘길 수 있습니다.', 'With nothing to match, checking is free.'),
  },
  {
    kind: 'choice',
    topic: 'actions',
    id: 'a-match',
    prompt: l('상대가 50을 베팅했습니다. 같은 금액만 넣고 계속하려면?', 'An opponent bets 50. How do you continue for exactly that?'),
    options: [
      { id: 'raise', label: l('레이즈', 'Raise') },
      { id: 'call', label: l('콜', 'Call') },
      { id: 'check', label: l('체크', 'Check') },
    ],
    answer: 'call',
    why: l('베팅이 있으면 체크할 수 없고, 레이즈는 금액을 더 높이는 것입니다.', 'You cannot check facing a bet, and a raise puts in more.'),
    explain: l('콜은 상대의 베팅에 맞춰 같은 금액을 넣습니다.', 'A call matches the bet.'),
  },
  {
    kind: 'choice',
    topic: 'actions',
    id: 'a-fold-chips',
    prompt: l('빅 블라인드 10을 낸 뒤 폴드했습니다. 그 10은?', 'You posted a 10 big blind and then folded. What happens to the 10?'),
    options: [
      { id: 'back', label: l('돌려받는다', 'It comes back to you') },
      { id: 'pot', label: l('팟에 남아 이긴 사람이 가져간다', 'It stays in the pot for the winner') },
    ],
    answer: 'pot',
    why: l('한 번 팟에 들어간 칩은 폴드해도 돌아오지 않습니다.', 'Chips in the pot never come back when you fold.'),
    explain: l('그래서 블라인드 위치에서는 조금 더 넓게 플레이하기도 합니다.', 'That is part of why players defend their blinds more often.'),
  },
];
