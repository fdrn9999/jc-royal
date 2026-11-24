import type { HudStatsDto, StatRatio } from '@jc/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { barFill, HudFigures, type HudKind } from '../src/game/SeatHud';
import { I18nProvider } from '../src/lib/i18n';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };

const r = (n: number, of: number): StatRatio => ({ n, of });
const none = r(0, 0);
const stats = (over: Partial<HudStatsDto> = {}): HudStatsDto => ({
  hands: 40,
  counted: 40,
  vpip: r(10, 40),
  pfr: r(0, 40),
  threeBet: none,
  foldTo3Bet: none,
  cbet: none,
  foldToCbet: none,
  wtsd: none,
  wsd: none,
  aggression: { bets: 0, calls: 0 },
  ...over,
});
const draw = (s: HudStatsDto, kind: HudKind = 'cash', bot = false) => renderToStaticMarkup(h(I18nProvider, null, h(HudFigures, { stats: s, kind, bot })));
/** The element with this test id, as it was written: its opening tag and what is inside it. */
function part(html: string, id: string) {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf('<', at);
  const tag = html.slice(open, html.indexOf('>', at) + 1);
  const rest = html.slice(html.indexOf('>', at) + 1);
  return { tag, inside: rest.slice(0, rest.indexOf('</dd>')) };
}

describe('how much of a share’s bar is filled', () => {
  it('is the share of the hands behind it, and nothing at all while there was no chance', () => {
    expect(barFill(r(10, 40))).toBe(0.25);
    expect(barFill(r(0, 40))).toBe(0);
    expect(barFill(r(40, 40))).toBe(1);
    expect(barFill(none)).toBeNull();
  });

  it('holds counts that cannot be inside the bar', () => {
    expect(barFill(r(50, 40))).toBe(1);
    expect(barFill(r(-3, 40))).toBe(0);
    expect(barFill(r(Number.NaN, 40))).toBe(0);
    expect(barFill(r(Number.POSITIVE_INFINITY, 40))).toBe(0);
    expect(barFill(r(3, -1))).toBeNull();
    expect(barFill(r(3, Number.NaN))).toBeNull();
    expect(barFill(r(3, Number.POSITIVE_INFINITY))).toBeNull();
  });
});

describe('the HUD figures as drawn', () => {
  it('a share has its number and a bar of that width; 0% is an empty bar, no chance is a dash and an idle track', () => {
    const html = draw(stats());
    const vpip = part(html, 'seat-hud-vpip-bar')!;
    expect(vpip.tag).toContain('data-fill="25"');
    expect(vpip.inside).toContain('width:25%');
    expect(part(html, 'seat-hud-vpip')!.inside).toContain('25%');
    // Really never raised in 40 hands: 0%, the track with nothing in it.
    const pfr = part(html, 'seat-hud-pfr-bar')!;
    expect(pfr.tag).toContain('data-fill="0"');
    expect(pfr.inside).toBe('');
    expect(html).toMatch(/data-testid="seat-hud-pfr".*?>0%</s);
    // No chance to 3-bet yet: a dash, and a track that is not the same as the empty one.
    const three = part(html, 'seat-hud-3bet-bar')!;
    expect(three.tag).toContain('data-fill="none"');
    expect(three.inside).toBe('');
    expect(three.tag).not.toBe(pfr.tag.replace('seat-hud-pfr-bar', 'seat-hud-3bet-bar').replace('data-fill="0"', 'data-fill="none"'));
    expect(html).toMatch(/data-testid="seat-hud-3bet".*?>—</s);
  });

  it('100% fills the bar, and more than there were does not go past it', () => {
    expect(part(draw(stats({ vpip: r(40, 40) })), 'seat-hud-vpip-bar')!.inside).toContain('width:100%');
    const over = part(draw(stats({ vpip: r(90, 40) })), 'seat-hud-vpip-bar')!;
    expect(over.tag).toContain('data-fill="100"');
    expect(over.inside).toContain('width:100%');
  });

  it('under 30 hands behind it: gold, with the note; 30 and more: neither', () => {
    const few = draw(stats({ hands: 12, vpip: r(3, 12), pfr: r(1, 12) }));
    expect(part(few, 'seat-hud-vpip')!.tag).toContain('data-small="true"');
    expect(part(few, 'seat-hud-vpip-bar')!.inside).toContain('bg-gold-400');
    expect(few).toContain('data-testid="seat-hud-small"');
    const many = draw(stats());
    expect(part(many, 'seat-hud-vpip')!.tag).toContain('data-small="false"');
    expect(part(many, 'seat-hud-vpip-bar')!.inside).not.toContain('gold');
    expect(many).not.toContain('data-testid="seat-hud-small"');
  });

  it('the sample is a count with no bar, and no colour says a figure is bad', () => {
    const html = draw(stats({ vpip: r(39, 40), pfr: r(38, 40) }));
    expect(html).toContain('data-testid="seat-hud-hands"');
    expect(html).not.toContain('seat-hud-hands-bar');
    expect(html.match(/data-testid="seat-hud-[a-z0-9-]+-bar"/g)).toEqual(['data-testid="seat-hud-vpip-bar"', 'data-testid="seat-hud-pfr-bar"', 'data-testid="seat-hud-3bet-bar"']);
    expect(html).not.toMatch(/(?:bg|text|border)-(?:red|rose|danger)|#f3b0b2/);
  });

  it('nothing but what is shown is written: no tooltip, no number beyond the share and its hands', () => {
    const html = draw(stats(), 'cash', true);
    expect(html).not.toMatch(/\stitle=/);
    expect([...html.matchAll(/\sdata-([a-z-]+)=/g)].map((x) => x[1]).filter((k, i, all) => all.indexOf(k) === i).sort()).toEqual(['bot', 'fill', 'kind', 'small', 'testid']);
  });

  it('no hands at all: the empty state, with no figure and no bar', () => {
    const html = draw(stats({ hands: 0, counted: 0, vpip: none, pfr: none }), 'practice');
    expect(html).toContain('data-testid="seat-hud-none"');
    expect(html).not.toContain('-bar"');
    expect(html).toContain('data-kind="practice"');
  });
});
