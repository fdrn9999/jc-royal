/**
 * Advanced GTO Academy: a numeric answer written out step by step (the formula, the numbers put in, the result), so a
 * quiz or hand analysis shows how its number comes about rather than only the number. The result is formatCalc's, the
 * same string the right option shows.
 */
import type { Card } from '@jc/types';
import { l, rankLabel, SUIT_INFO, suitOf, type L } from '../content';
import { comboCount, formatCalc, num, potOdds, share } from './math';
import type { GtoCalc } from './types';

/** "A♠", "10♥": a card as the lessons write it. */
export const cardText = (c: Card) => `${rankLabel(c)}${SUIT_INFO[suitOf(c)].glyph}`;

export function calcSteps(c: GtoCalc): L[] {
  const v = formatCalc(c);
  switch (c.kind) {
    case 'potOdds': {
      const fin = num(c.pot + 2 * c.bet);
      return [
        l(`콜 뒤 최종 팟 = 팟 ${num(c.pot)} + 베팅 ${num(c.bet)} + 콜 ${num(c.bet)} = ${fin}`, `Final pot after the call = pot ${num(c.pot)} + bet ${num(c.bet)} + call ${num(c.bet)} = ${fin}`),
        l(`필요 에퀴티 = 콜 ÷ 최종 팟 = ${num(c.bet)} ÷ ${fin} = ${v}`, `Required equity = call ÷ final pot = ${num(c.bet)} ÷ ${fin} = ${v}`),
      ];
    }
    case 'mdf':
      return [l(`MDF = P ÷ (P + B) = ${num(c.pot)} ÷ (${num(c.pot)} + ${num(c.bet)}) = ${v}`, `MDF = P ÷ (P + B) = ${num(c.pot)} ÷ (${num(c.pot)} + ${num(c.bet)}) = ${v}`)];
    case 'alpha':
      return [l(`알파(블러프 손익분기 폴드율) = B ÷ (P + B) = ${num(c.bet)} ÷ (${num(c.pot)} + ${num(c.bet)}) = ${v}`, `Alpha (a bluff’s break-even fold rate) = B ÷ (P + B) = ${num(c.bet)} ÷ (${num(c.pot)} + ${num(c.bet)}) = ${v}`)];
    case 'bluffShare':
      return [
        l(`콜하는 쪽의 필요 에퀴티 = B ÷ (P + 2B) = ${num(c.bet)} ÷ (${num(c.pot)} + ${num(2 * c.bet)}) = ${v}`, `The caller’s required equity = B ÷ (P + 2B) = ${num(c.bet)} ÷ (${num(c.pot)} + ${num(2 * c.bet)}) = ${v}`),
        l(`베팅의 ${v}가 블러프면 콜과 폴드의 기대값이 같아집니다.`, `With ${v} of the bets bluffs, calling and folding have the same EV.`),
      ];
    case 'evCall': {
      const fin = num(c.pot + 2 * c.bet);
      return [
        l(`EV(콜) = 에퀴티 × 최종 팟 − 콜 = ${share(c.equity)} × ${fin} − ${num(c.bet)} = ${v}`, `EV(call) = equity × final pot − call = ${share(c.equity)} × ${fin} − ${num(c.bet)} = ${v}`),
        l(`폴드의 EV는 0이므로, 이 값이 0보다 크면 콜이 낫습니다. (본전 에퀴티 ${share(potOdds(c.pot, c.bet))})`, `Folding is worth 0, so calling is better when this is above 0 (break-even equity ${share(potOdds(c.pot, c.bet))}).`),
      ];
    }
    case 'evBluff':
      return [
        l(`EV(블러프) = 폴드율 × P − (1 − 폴드율) × B = ${share(c.fold)} × ${num(c.pot)} − ${share(1 - c.fold)} × ${num(c.bet)} = ${v}`, `EV(bluff) = fold rate × P − (1 − fold rate) × B = ${share(c.fold)} × ${num(c.pot)} − ${share(1 - c.fold)} × ${num(c.bet)} = ${v}`),
        l('블러프는 콜을 받으면 항상 진다고 봅니다.', 'The bluff is assumed to lose whenever it is called.'),
      ];
    case 'combos': {
      const all = comboCount(c.hand);
      const dead = c.dead ?? [];
      if (!dead.length) return [l(`${c.hand} = ${v}콤보 (페어 6 · 수딧 4 · 오프수딧 12 · 둘을 합치면 16)`, `${c.hand} = ${v} combos (a pair 6 · suited 4 · offsuit 12 · both together 16)`)];
      const seen = dead.map(cardText).join(' ');
      return [
        l(`${c.hand}의 전체 콤보 = ${all}`, `All combos of ${c.hand} = ${all}`),
        l(`보이는 카드(${seen})를 쓰는 콤보 ${all - Number(v)}개를 빼면 ${v}콤보`, `Taking out the ${all - Number(v)} that use a visible card (${seen}) leaves ${v}`),
      ];
    }
    case 'outs': {
      const unseen = c.unseen ?? (c.cards === 2 ? 47 : 46);
      if (c.cards === 1) return [l(`맞을 확률 = 아웃 ÷ 보이지 않는 카드 = ${c.outs} ÷ ${unseen} = ${v}`, `Chance to hit = outs ÷ unseen cards = ${c.outs} ÷ ${unseen} = ${v}`)];
      const miss = unseen - c.outs;
      return [
        l(`두 장 모두 빗나갈 확률 = (${miss} ÷ ${unseen}) × (${miss - 1} ÷ ${unseen - 1})`, `Chance both cards miss = (${miss} ÷ ${unseen}) × (${miss - 1} ÷ ${unseen - 1})`),
        l(`한 장이라도 맞을 확률 = 1 − 그 값 = ${v} (2·4의 법칙으로는 ${c.outs * 4}%)`, `Chance at least one hits = 1 − that = ${v} (the rule of 2 and 4 says ${c.outs * 4}%)`),
      ];
    }
    case 'geometric':
      return [
        l(`스트리트마다 팟의 f를 베팅하고 콜받으면 팟이 (1 + 2f)배: (1 + 2f)^${c.streets} = 1 + 2 × ${num(c.stack)} ÷ ${num(c.pot)}`, `Betting f of the pot each street, called, multiplies it by (1 + 2f): (1 + 2f)^${c.streets} = 1 + 2 × ${num(c.stack)} ÷ ${num(c.pot)}`),
        l(`f = ${v} (팟 대비)`, `f = ${v} of the pot`),
      ];
    case 'spr':
      return [l(`SPR = 유효 스택 ÷ 팟 = ${num(c.stack)} ÷ ${num(c.pot)} = ${v}`, `SPR = effective stack ÷ pot = ${num(c.stack)} ÷ ${num(c.pot)} = ${v}`)];
    case 'bluffCombos':
      return [
        l(`밸류 1콤보당 블러프 = B ÷ (P + B) = ${num(c.bet)} ÷ ${num(c.pot + c.bet)}`, `Bluffs per value combo = B ÷ (P + B) = ${num(c.bet)} ÷ ${num(c.pot + c.bet)}`),
        l(`블러프 = 밸류 ${num(c.value)} × ${num(c.bet)} ÷ ${num(c.pot + c.bet)} = ${v}콤보`, `Bluffs = value ${num(c.value)} × ${num(c.bet)} ÷ ${num(c.pot + c.bet)} = ${v} combos`),
      ];
  }
}
