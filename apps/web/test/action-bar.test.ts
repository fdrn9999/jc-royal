import type { LegalOption, TableView } from '@jc/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ActionBar } from '../src/game/ActionBar';
import { I18nProvider } from '../src/lib/i18n';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };
// The settings store has no server snapshot: a player with the defaults.
vi.mock('../src/lib/prefs', async (original) => ({ ...(await original<object>()), usePrefs: () => ({ confirmRisky: true, amountUnit: 'chips' }) }));

/** My turn at a deep table: a raise from 12,500 to everything I have. */
function turn(legal: LegalOption[]): TableView {
  return {
    table: { bigBlind: 2_500 },
    you: { seatIndex: 0, legal },
    seats: [
      { seatIndex: 0, stack: 1_234_567, streetBet: 0 },
      { seatIndex: 1, stack: 900_000, streetBet: 5_000 },
    ],
    hand: { seq: 7, potTotal: 7_500 },
  } as unknown as TableView;
}
const raise: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 5_000 }, { type: 'raise', min: 12_500, max: 1_234_567 }];

const markup = (column: boolean) => renderToStaticMarkup(h(I18nProvider, null, h(ActionBar, { state: turn(raise), onAct: () => true, busy: false, column })));
/** The text of the element with this test id (its tags dropped). */
const textOf = (html: string, id: string) => {
  const m = new RegExp(`<(\\w+)[^>]*data-testid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m?.[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
};

describe('the action bar', () => {
  it('writes the amount Bet/Raise bets on it in full, in the bar’s own row and in a short screen’s column', () => {
    for (const column of [false, true]) {
      const html = markup(column);
      expect(textOf(html, 'action-commit')).toBe('레이즈 12,500');
      expect(textOf(html, 'action-dock-amount')).toBe('12,500');
      expect(html).not.toMatch(/12\.5K/);
    }
  });

  it('gives the sizing toggle a tip saying it sets the amount, and its key, in place of a bare title', () => {
    const html = markup(false);
    const toggle = /<button[^>]*data-testid="action-dock-toggle"[^>]*>/.exec(html)?.[0] ?? '';
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('aria-label="베팅 금액 설정 펼치기"');
    expect(toggle).not.toContain('title=');
    const tipId = /aria-describedby="([^"]+)"/.exec(toggle)?.[1];
    expect(tipId).toBeTruthy();
    const tip = new RegExp(`<span[^>]*id="${tipId}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(tip).toContain('role="tooltip"');
    expect(textOf(html, 'action-dock-tip')).toBe('베팅 금액 조절R');
  });
});
