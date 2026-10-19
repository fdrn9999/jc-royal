import type { Card, TableView } from '@jc/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describeCurrent, startingHandName } from '../src/academy/content';
import { CurrentHandPill } from '../src/game/BeginnerAids';
import { I18nProvider, useI18n, type MsgKey } from '../src/lib/i18n';
import { en } from '../src/lib/i18n-en';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };

const cards = (s: string) => (s ? s.split(' ') : []) as Card[];
function Say({ hole, board }: { hole: Card[]; board: Card[] }) {
  const { t, locale } = useI18n();
  return h('i', null, describeCurrent(hole, board, locale, t));
}
/** In Korean, through the app's own dictionary. */
const ko = (hole: string, board = '') => renderToStaticMarkup(h(I18nProvider, null, h(Say, { hole: cards(hole), board: cards(board) }))).replace(/^<i>|<\/i>$/g, '');
const english = (hole: string, board = '') => describeCurrent(cards(hole), cards(board), 'en', (k: MsgKey) => en[k]);

describe('the hand HUD before the flop: the starting hand by its usual name', () => {
  it('names pocket pairs, suited and offsuit hands, the higher card first', () => {
    expect(ko('As Ah')).toBe('포켓 에이스');
    expect(english('As Ah')).toBe('Pocket Aces');
    expect(ko('Ks As')).toBe('A-K 수딧');
    expect(english('Ks As')).toBe('A-K suited');
    expect(ko('Kd As')).toBe('A-K 오프수딧');
    expect(english('Kd As')).toBe('A-K offsuit');
    expect(ko('Tc Th')).toBe('포켓 10');
    expect(english('Tc Th')).toBe('Pocket Tens');
    expect(ko('9s Ts')).toBe('10-9 수딧');
    expect(english('2c 2d')).toBe('Pocket Twos');
    expect(ko('Qh Qd')).toBe('포켓 퀸');
  });

  it('has a name for every pocket pair in both languages', () => {
    for (const r of 'AKQJT98765432') {
      expect(startingHandName([`${r}s`, `${r}h`] as Card[], 'en')).toMatch(/^Pocket [A-Z][a-z]+s$/);
      expect(startingHandName([`${r}s`, `${r}h`] as Card[], 'ko')).toMatch(/^포켓 \S+$/);
    }
  });

  it('says nothing without two cards of my own', () => {
    expect(startingHandName(null, 'ko')).toBeNull();
    expect(startingHandName(['As'] as Card[], 'en')).toBeNull();
    expect(describeCurrent(null, cards('Ah 7c 2d'), 'en', (k: MsgKey) => en[k])).toBeNull();
  });
});

describe('the hand HUD after the flop: the made hand, all ten categories', () => {
  const CASES: [hole: string, board: string, ko: string, en: string][] = [
    ['As Ks', 'Qs Js Ts 2d 3c', '로열 플러시', 'Royal flush'],
    ['9h 8h', '7h 6h 5h Kd 2c', '9 하이 스트레이트 플러시', 'Straight flush to 9'],
    ['7c 7d', '7h 7s Kd 2c 3h', '7 포카드', 'Four 7s'],
    ['Kc Kd', 'Kh 4s 4d 2c 9h', 'K 풀하우스 (4 페어)', 'Full house, Ks over 4s'],
    ['Ad 9d', '2d 5d Jd Kc 3h', 'A 하이 플러시', 'Flush, A high'],
    ['9c Td', 'Jh Qs Kd 2c 3h', 'K 하이 스트레이트', 'Straight to K'],
    ['8c 8d', '8h 2s Kd 4c Jh', '8 트리플', 'Three 8s'],
    ['Ac Kd', 'Ah Ks 4d 7c 2h', 'A·K 투페어', 'Two pair, As and Ks'],
    ['Qc 3d', 'Qh 8s 5d 2c Jh', 'Q 원페어', 'Pair of Qs'],
    ['Ac 3d', 'Kh 8s 5d 2c Jh', 'A 하이카드', 'A high'],
  ];
  it.each(CASES)('%s on %s', (hole, board, k, e) => {
    expect(ko(hole, board)).toBe(k);
    expect(english(hole, board)).toBe(e);
  });

  it('reads the flop and the turn as they are, and the wheel as five high', () => {
    expect(ko('As Ad', 'Ah 7c 2d')).toBe('A 트리플');
    expect(english('As Ad', 'Ah 7c 2d 9h')).toBe('Three As');
    expect(english('Ac 2d', '3h 4s 5d Kc 9h')).toBe('Straight to 5');
  });
});

describe('the hand HUD under the board (inline, a phone upright)', () => {
  /** Only what the pill reads: my seat, my own cards and the board shown. */
  const view = (state = 'active') =>
    ({ you: { seatIndex: 0 }, seats: [{ seatIndex: 0, holeCards: ['Kc', 'Ah'], state }], hand: { board: ['Kd', '7c', '2h'] } }) as unknown as TableView;
  const pill = (s: TableView) => renderToStaticMarkup(h(I18nProvider, null, h(CurrentHandPill, { s, inline: true })));

  it('is one line at the status line’s size, saying it is read from the cards shown', () => {
    const out = pill(view());
    expect(out).toContain('data-testid="current-hand"');
    expect(out).toContain('K 원페어');
    expect(out).toContain('공개 카드 기준');
    expect(out).toContain('truncate');
    expect(out).toContain('leading-3');
    // Not a control: nothing in it takes a tap.
    expect(out).not.toContain('pointer-events-auto');
  });

  it('says nothing once I have folded', () => {
    expect(pill(view('folded'))).toBe('');
  });
});
