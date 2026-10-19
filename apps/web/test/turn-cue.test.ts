import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cueTurn, holdTurnTitle, resetTurnCue, takeTurnCue, TURN_BUZZ, TURN_LOW_MS, TurnBanner } from '../src/game/TurnCue';
import { I18nProvider } from '../src/lib/i18n';

// The provider reads ?lang= from the address on its first render.
(globalThis as { window?: unknown }).window ??= { location: { search: '' } };

/** A tab's sessionStorage (or one the browser blocks). */
function fakeSession(blocked = false) {
  const m = new Map<string, string>();
  const no = () => {
    throw new Error('blocked');
  };
  return {
    getItem: blocked ? no : (k: string) => m.get(k) ?? null,
    setItem: blocked ? no : (k: string, v: string) => void m.set(k, v),
    removeItem: blocked ? no : (k: string) => void m.delete(k),
  };
}

describe('the turn cue', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', fakeSession());
    resetTurnCue();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('plays once per decision: a re-render or the time bank (same hand and version) plays nothing more', () => {
    const play = vi.fn();
    expect(cueTurn('h1:4', false, { hidden: false, play })).toBe(true);
    expect(cueTurn('h1:4', false, { hidden: false, play })).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
    // The next decision (another street, or the next hand) plays again.
    expect(cueTurn('h1:9', false, { hidden: false, play })).toBe(true);
    expect(cueTurn('h2:3', false, { hidden: false, play })).toBe(true);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it('remembers the decision across a reload of the tab (the page starts afresh, the tab keeps it)', () => {
    expect(takeTurnCue('h1:4')).toBe(true);
    // A reload: this module starts with nothing, the tab's storage still has it.
    resetTurnCueMemoryOnly();
    expect(takeTurnCue('h1:4')).toBe(false);
    expect(takeTurnCue('h1:5')).toBe(true);
  });

  it('still cues once with the storage blocked', () => {
    vi.stubGlobal('sessionStorage', fakeSession(true));
    resetTurnCue();
    const play = vi.fn();
    expect(cueTurn('h1:4', false, { hidden: false, play })).toBe(true);
    expect(cueTurn('h1:4', false, { hidden: false, play })).toBe(false);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('plays nothing while the page is hidden, and not later either for that decision', () => {
    const play = vi.fn();
    const buzz = vi.fn();
    expect(cueTurn('h1:4', true, { hidden: true, play, buzz })).toBe(false);
    expect(cueTurn('h1:4', true, { hidden: false, play, buzz })).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(buzz).not.toHaveBeenCalled();
  });

  it('buzzes only when the setting asks for it, and a refused buzz breaks nothing', () => {
    const play = vi.fn();
    const buzz = vi.fn();
    cueTurn('h1:1', false, { hidden: false, play, buzz });
    expect(buzz).not.toHaveBeenCalled();
    cueTurn('h1:2', true, { hidden: false, play, buzz });
    expect(buzz).toHaveBeenCalledWith(TURN_BUZZ);
    const refuse = () => {
      throw new Error('not allowed');
    };
    expect(cueTurn('h1:3', true, { hidden: false, play, buzz: refuse })).toBe(true);
    // A device without vibration.
    expect(cueTurn('h1:4', true, { hidden: false, play })).toBe(true);
    expect(play).toHaveBeenCalledTimes(4);
  });
});

/** A reload: the module's memory goes, the tab's storage stays. */
function resetTurnCueMemoryOnly() {
  const keep = sessionStorage.getItem('jc.turn');
  resetTurnCue();
  if (keep !== null) sessionStorage.setItem('jc.turn', keep);
}

describe('the tab title on my turn', () => {
  function fakeDoc(hidden: boolean) {
    const ls = new Set<() => void>();
    return {
      title: 'JC ROYAL',
      hidden,
      addEventListener: (_: string, l: () => void) => void ls.add(l),
      removeEventListener: (_: string, l: () => void) => void ls.delete(l),
      flip(next: boolean) {
        this.hidden = next;
        for (const l of ls) l();
      },
      listeners: ls,
    };
  }

  it('marks the title only while the page is hidden, and puts it back when the turn ends', () => {
    const d = fakeDoc(false);
    const stop = holdTurnTitle(d as never, '내 차례');
    expect(d.title).toBe('JC ROYAL');
    d.flip(true);
    expect(d.title).toBe('내 차례 · JC ROYAL');
    d.flip(false);
    expect(d.title).toBe('JC ROYAL');
    d.flip(true);
    stop();
    expect(d.title).toBe('JC ROYAL');
    expect(d.listeners.size).toBe(0);
  });

  it('marks a page already hidden when the turn comes', () => {
    const d = fakeDoc(true);
    const stop = holdTurnTitle(d as never, 'Your turn');
    expect(d.title).toBe('Your turn · JC ROYAL');
    stop();
    expect(d.title).toBe('JC ROYAL');
  });

  it('leaves a title the page changed meanwhile', () => {
    const d = fakeDoc(true);
    const stop = holdTurnTitle(d as never, '내 차례');
    d.title = 'Something else';
    stop();
    expect(d.title).toBe('Something else');
  });
});

describe('TurnBanner', () => {
  const html = (deadline: number | null) => renderToStaticMarkup(h(I18nProvider, null, h(TurnBanner, { deadline })));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('says whose turn it is and the whole seconds left, a part second rounded up', () => {
    const out = html(1_000_000 + 12_300);
    expect(out).toContain('data-testid="turn-banner"');
    expect(out).toContain('role="status"');
    expect(out).toContain('내 차례입니다');
    expect(out).toMatch(/data-testid="turn-left">13초</);
    expect(out).not.toContain('data-low');
    expect(out).toContain('jc-pulse-gold');
    // It takes no taps, so it never stands in front of a control.
    expect(out).toContain('pointer-events-none');
  });

  it('reads low from the same point the timer beeps, with a mark and a word as well as the colour', () => {
    expect(TURN_LOW_MS).toBe(5_000);
    const at = html(1_000_000 + TURN_LOW_MS);
    expect(at).toContain('data-low=""');
    expect(at).toMatch(/data-testid="turn-left">⚠ 5초</);
    expect(at).toContain('시간이 얼마 남지 않았습니다');
    expect(at).toContain('text-danger-soft');
    expect(at).not.toContain('jc-pulse-gold');
    const above = html(1_000_000 + TURN_LOW_MS + 1_000);
    expect(above).not.toContain('data-low');
  });

  it('compact (in a short screen’s time bank pill): one short line, no box of its own, low on time all the same', () => {
    const html2 = (deadline: number) => renderToStaticMarkup(h(I18nProvider, null, h(TurnBanner, { deadline, compact: true })));
    const out = html2(1_000_000 + 30_000);
    expect(out).toContain('data-testid="turn-banner"');
    expect(out).toMatch(/>내 차례<\/span>/);
    expect(out).toMatch(/data-testid="turn-left">30초</);
    expect(out).not.toContain('rounded-full');
    expect(out).not.toContain('border');
    const low = html2(1_000_000 + 2_000);
    expect(low).toContain('data-low=""');
    expect(low).toMatch(/data-testid="turn-left">⚠ 2초</);
    expect(low).toContain('시간이 얼마 남지 않았습니다');
  });

  it('inSeat (in my seat’s status line on a phone upright): the short label at the line’s own size, low on time all the same', () => {
    const seat = (deadline: number) => renderToStaticMarkup(h(I18nProvider, null, h(TurnBanner, { deadline, inSeat: true })));
    const out = seat(1_000_000 + 24_000);
    expect(out).toContain('data-testid="turn-banner"');
    expect(out).toContain('role="status"');
    expect(out).toMatch(/>내 차례<\/span>/);
    expect(out).toMatch(/data-testid="turn-left">24초</);
    expect(out).toContain('pointer-events-none');
    // No box, ring or size of its own: the seat's plate already wears the gold ring, and the line sets the size.
    expect(out).not.toContain('rounded-full');
    expect(out).not.toContain('border');
    expect(out).not.toContain('jc-pulse-gold');
    expect(out).not.toContain('text-xs');
    const low = seat(1_000_000 + 4_000);
    expect(low).toContain('data-low=""');
    expect(low).toMatch(/data-testid="turn-left">⚠ 4초</);
    expect(low).toContain('시간이 얼마 남지 않았습니다');
    expect(low).toContain('text-danger-soft');
  });

  it('never counts below zero, and shows no clock without a deadline', () => {
    expect(html(1_000_000 - 3_000)).toMatch(/data-testid="turn-left">⚠ 0초</);
    const none = html(null);
    expect(none).toContain('내 차례입니다');
    expect(none).not.toContain('turn-left');
    expect(none).not.toContain('data-low');
  });
});
