import type { LegalOption, TableView } from '@jc/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ActionBar } from '../src/game/ActionBar';
import { captionFace, lineFace, wrapPoints } from '../src/game/amountFit';
import { amounts, type Amounts } from '../src/lib/amount';
import { I18nProvider } from '../src/lib/i18n';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };
// The settings store has no server snapshot: a player with the defaults.
vi.mock('../src/lib/prefs', async (original) => ({ ...(await original<object>()), usePrefs: () => ({ confirmRisky: true, amountUnit: 'chips' }) }));

/** My turn at a deep table: a raise from 12,500 (or `min`) to everything I have. */
function turn(legal: LegalOption[], streetBet = 0): TableView {
  return {
    table: { bigBlind: 2_500 },
    you: { seatIndex: 0, legal },
    seats: [
      { seatIndex: 0, stack: 1_234_567, streetBet },
      { seatIndex: 1, stack: 900_000, streetBet: 5_000 },
    ],
    hand: { seq: 7, potTotal: 7_500 },
  } as unknown as TableView;
}
const raise: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 5_000 }, { type: 'raise', min: 12_500, max: 1_234_567 }];

const markup = (column: boolean, legal = raise, unit?: Amounts, streetBet = 0) =>
  renderToStaticMarkup(h(I18nProvider, null, h(ActionBar, { state: turn(legal, streetBet), onAct: () => true, busy: false, column, amounts: unit })));
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

  it('in big blinds, writes the chips Bet/Raise bets after the rounded blinds, in the column too', () => {
    // 12,501 at a 2,500 blind reads 5 BB rounded: the chips say what is sent.
    const odd: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 5_000 }, { type: 'raise', min: 12_501, max: 1_234_567 }];
    for (const column of [false, true]) expect(textOf(markup(column, odd, amounts('bb', 2_500)), 'action-commit')).toBe('레이즈 5 BB (12,501)');
  });

  it('sizes each line of Bet/Raise’s amount to the button’s width, never under 9px, wrapping only between thousands or at a space; in the column the blinds and the chips take a line each', () => {
    const odd: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 5_000 }, { type: 'raise', min: 12_501, max: 1_234_567 }];
    const lines = (column: boolean) =>
      [...markup(column, odd, amounts('bb', 2_500)).matchAll(/<span class="text-center font-mono[^"]*" style="font-size:([^"]+)">(.*?)<\/span>/g)].map((m) => [m[2], m[1]]);
    expect(lines(true)).toEqual([
      ['5 BB', 'max(9px, min(11px, 40.00cqi))'],
      ['(12,<wbr/>501)', 'max(9px, min(11px, 20.00cqi))'],
    ]);
    expect(lines(false)).toEqual([['5 BB (12,<wbr/>501)', 'max(9px, min(14px, 12.31cqi))']]);
    expect(markup(true)).not.toMatch(/break-all|whitespace-nowrap font-mono/);
  });

  it('a deep stack’s amount keeps the 9px face at least, the button free to grow rather than cut it', () => {
    expect(lineFace('(400,000,000)', 11)).toBe('max(9px, min(11px, 12.31cqi))');
    expect(wrapPoints('(400,000,000)')).toEqual(['(400,', '000,', '000)']);
    expect(captionFace('3,332.33 BB from stack')).toBe('max(9px, min(11px, calc((100cqi - 6px) / 13.20)))');
    const html = markup(false, [{ type: 'fold' }, { type: 'call', amount: 5_000 }, { type: 'raise', min: 400_000_000, max: 400_000_000 }]);
    expect(textOf(html, 'action-commit')).toBe('레이즈 400,000,000');
    const commit = /<button[^>]*data-testid="action-commit"[^>]*>/.exec(html)?.[0] ?? '';
    expect(commit).toContain('min-h-12');
    expect(commit).not.toMatch(/[\s"]h-12[\s"]/);
  });

  it('under Bet/Raise in the bar’s row, writes what comes from the stack on one line sized to the button, not the chips again', () => {
    // A blind of 2,500 in: a raise to 12,500 takes 10,000 from the stack.
    const html = markup(false, raise, amounts('bb', 2_500), 2_500);
    expect(textOf(html, 'action-commit')).toBe('레이즈 5 BB (12,500)');
    expect(textOf(html, 'action-from-stack')).toBe('스택에서 4 BB');
    expect(html).toContain('style="font-size:max(9px, min(11px, calc((100cqi - 6px) / 7.00)))"');
    expect(html).not.toContain('data-testid="action-chips"');
  });

  it('with a big-blind amount the server would refuse, Bet/Raise says one is wanted and the chips of that amount read under it, not what comes from the stack', () => {
    // The amount starts at the least of the window; one the window does not hold stands for a typed one out of range
    // (typing is the E2E's), so Bet/Raise is disabled.
    const legal: LegalOption[] = [{ type: 'fold' }, { type: 'call', amount: 5_000 }, { type: 'raise', min: 12_500, max: 12_499 }];
    const html = markup(false, legal, amounts('bb', 2_500), 2_500);
    expect(textOf(html, 'action-commit')).toBe('레이즈 금액 설정 필요');
    expect(textOf(html, 'action-chips')).toBe('= 12,500');
    expect(html).not.toContain('data-testid="action-from-stack"');
    expect(html).toContain('style="font-size:max(9px, min(11px, calc((100cqi - 6px) / 4.80)))"');
    // In chips the field already reads in chips: nothing under the button.
    expect(markup(false, legal, undefined, 2_500)).not.toMatch(/data-testid="action-(chips|from-stack)"/);
    // In the column, with no line under Bet/Raise, the chips beside the closed sizing's name.
    const col = markup(true, legal, amounts('bb', 2_500), 2_500);
    expect(textOf(col, 'action-dock-amount')).toBe('금액 설정 필요');
    expect(textOf(col, 'action-chips')).toBe('= 12,500');
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
