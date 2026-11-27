import { expect, type Page } from '@playwright/test';
import { setRange } from './helpers';

/** One phase of a showdown's scene as the page drew it: who was lit, who was marked a winner, which cards showed. */
export interface Snap {
  phase: string;
  seats: Record<string, { sd: string | null; winner: boolean; cards: string[]; lit: string[] }>;
  board: string[];
  boardLit: string[];
  title: boolean;
}
/** The filters the page had settled on a moment into a phase (`now`: the phase it was in when they were read). */
export interface Styles {
  phase: string;
  now: string | null;
  felt: string;
  board: string;
  pot: string;
  header: string;
  seats: Record<string, { sd: string | null; cards: string | null; plate: string; winner: boolean }>;
  title: { pointer: string; font: string; inside: boolean } | null;
}
interface Watched {
  phases: (string | null)[];
  snaps: Snap[];
  styles: Styles[];
  titles: number;
}

/**
 * Records the showdown's scene in the page (an init script): every change of the table's data-showdown, what the table
 * showed at that change, the title each time it is drawn, and the filters once their transition is over.
 */
export function watchShowdown() {
  const w: Watched = { phases: [], snaps: [], styles: [], titles: 0 };
  (window as unknown as { __sd: Watched }).__sd = w;
  const seats = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid=table] [data-testid^="seat-"][data-state]')).filter((el) => /^seat-\d+$/.test(el.dataset.testid!));
  const cards = (root: Element, sel = '.jc-card[data-card]') => Array.from(root.querySelectorAll(sel)).map((c) => c.getAttribute('data-card')!);
  const snap = (phase: string) => {
    const board = document.querySelector('[data-testid=board]')!;
    const s: Snap = { phase, seats: {}, board: cards(board), boardLit: cards(board, '.jc-card.highlight[data-card]'), title: !!document.querySelector('[data-testid=showdown-title]') };
    for (const el of seats()) {
      s.seats[el.dataset.testid!.slice(5)] = { sd: el.getAttribute('data-sd'), winner: !!el.querySelector('.jc-sd-plate.jc-winner'), cards: cards(el), lit: cards(el, '.jc-card.highlight[data-card]') };
    }
    w.snaps.push(s);
  };
  const styles = (phase: string) => {
    const table = document.querySelector<HTMLElement>('[data-testid=table]');
    if (!table) return;
    const f = (el: Element | null) => (el ? getComputedStyle(el).filter : 'missing');
    const title = document.querySelector<HTMLElement>('[data-testid=showdown-title]');
    const box = title?.getBoundingClientRect();
    const out: Styles = {
      phase,
      now: table.getAttribute('data-showdown'),
      felt: f(table.querySelector('.jc-sd-dim')),
      board: f(table.querySelector('[data-testid=board]')),
      pot: f(table.querySelector('[data-testid=pot]')),
      header: f(document.querySelector('.jc-sd-ui')),
      seats: {},
      title: title && box ? { pointer: getComputedStyle(title).pointerEvents, font: getComputedStyle(title).fontFamily, inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight } : null,
    };
    for (const el of seats()) {
      const held = el.querySelector('.jc-sd-cards');
      out.seats[el.dataset.testid!.slice(5)] = { sd: el.getAttribute('data-sd'), cards: held ? f(held) : null, plate: f(el.querySelector('.jc-sd-plate')), winner: !!el.querySelector('.jc-sd-plate.jc-winner') };
    }
    w.styles.push(out);
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of Array.from(m.addedNodes)) if (n instanceof Element && (n.matches('[data-testid=showdown-title]') || n.querySelector('[data-testid=showdown-title]'))) w.titles += 1;
        continue;
      }
      const p = (m.target as Element).getAttribute('data-showdown');
      if (w.phases[w.phases.length - 1] === p && w.phases.length) continue;
      w.phases.push(p);
      if (p) snap(p);
      if (p === 'title') setTimeout(() => styles('title'), 300);
      if (p === 'reveal') setTimeout(() => styles('reveal'), 700);
      if (p === 'highlight') setTimeout(() => styles('highlight'), 450);
      if (!p) setTimeout(() => styles('after'), 600);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-showdown'] });
}

export const scene = (p: Page) => p.evaluate(() => (window as unknown as { __sd: Watched }).__sd);

/** The scenes the page has finished (each ends with the attribute gone). */
export const scenesDone = async (p: Page) => (await scene(p)).phases.filter((x) => x === null).length;

/** What the server said of each hand that ended: the page's truth to hold the scene against. */
export interface Truth {
  mySeat: number | null;
  /** The hand being played: its id and how many seats were dealt into it. */
  current: { id: string; dealt: number } | null;
  settled: {
    id: string;
    /** The server sent its showdown cue for this hand. */
    showdown: boolean;
    winners: number[];
    pots: number;
    shown: { seatIndex: number; cards: string[]; bestFive: string[] }[];
    board: string[];
  }[];
}
export function truth(page: Page): Truth {
  const w: Truth = { mySeat: null, current: null, settled: [] };
  const cued = new Set<string>();
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      let m: {
        t: string;
        cues?: { kind: string }[];
        state?: {
          seats: { hasCards: boolean }[];
          hand: { id: string; stage: string; board: string[]; result: { winners: { seatIndex: number; amount: number; potIds: string[] }[]; returned?: { seatIndex: number; amount: number }; showdown: { seatIndex: number; cards: string[]; bestFive: string[] }[] } | null } | null;
          you: { seatIndex: number | null };
        };
      };
      try {
        m = JSON.parse(payload);
      } catch {
        return;
      }
      if (m.t !== 'state' || !m.state) return;
      w.mySeat = m.state.you.seatIndex;
      const h = m.state.hand;
      if (!h) return;
      if (m.cues?.some((c) => c.kind === 'showdown')) cued.add(h.id);
      if (h.stage !== 'settled') {
        if (w.current?.id !== h.id) w.current = { id: h.id, dealt: m.state.seats.filter((s) => s.hasCards).length };
        return;
      }
      if (h.result && !w.settled.some((x) => x.id === h.id)) {
        // Chips nobody called, handed back, are no win: a winner is whoever won more than that.
        const r = h.result;
        const won = new Map<number, number>();
        for (const x of r.winners) won.set(x.seatIndex, (won.get(x.seatIndex) ?? 0) + x.amount);
        if (r.returned) won.set(r.returned.seatIndex, (won.get(r.returned.seatIndex) ?? 0) - r.returned.amount);
        const winners = [...won].filter(([, v]) => v > 0).map(([k]) => k);
        w.settled.push({
          id: h.id,
          showdown: cued.has(h.id),
          winners,
          pots: new Set(r.winners.flatMap((x) => x.potIds)).size - (r.returned ? 1 : 0),
          shown: h.result.showdown.map((x) => ({ seatIndex: x.seatIndex, cards: x.cards, bestFive: x.bestFive })),
          board: h.board,
        });
      }
    });
  });
  return w;
}

/** Opens a members' room as this page's account and returns its id. */
export async function openRoom(page: Page, over: Record<string, unknown> = {}): Promise<string> {
  const r = await page.evaluate(async (body) => {
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { id?: string } };
  }, { name: `E2E ${Date.now().toString(36)}`, maxSeats: 2, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000, ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id!;
}

const ORDER = ['dimming', 'title', 'reveal', 'highlight', 'settlement', 'restore'];

/** The phases of the page's `n`th scene (from 0), in the order it went through them. */
export function phasesOf(w: Watched, n: number): string[] {
  const out: string[][] = [[]];
  for (const p of w.phases) {
    if (p === null) out.push([]);
    else out[out.length - 1]!.push(p);
  }
  return out[n] ?? [];
}

/**
 * The page's `n`th scene against what the server said of its hand: its phases in order and once each; in colour exactly
 * the hands the showdown turned over; the winner's mark on every pot's winner and nobody else; the board's gold on the
 * winners' five; and no card of a hand kept face down (other than this page's own).
 */
export function expectScene(w: Watched, n: number, t: Truth['settled'][number], mySeat: number | null) {
  const ph = phasesOf(w, n);
  expect(ph.length, `phases of scene ${n}: ${JSON.stringify(w.phases)}`).toBeGreaterThanOrEqual(4);
  expect(new Set(ph).size, `no phase twice: ${ph}`).toBe(ph.length);
  expect([...ph].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), 'in order').toEqual(ph);
  // (The colour coming back lasts a third of a second: a page too busy to draw it in time goes from the result
  // straight to the scene's end, like a next hand that cuts it short. What is left then is checked by expectRestored.)
  for (const must of ['title', 'reveal']) expect(ph, `phases: ${ph}`).toContain(must);
  const snaps = w.snaps.filter((_, i) => {
    // The snaps of this scene: as many as its phases, after those of the scenes before it.
    let from = 0;
    for (let k = 0; k < n; k++) from += phasesOf(w, k).length;
    return i >= from && i < from + ph.length;
  });
  const at = (phase: string) => snaps.find((s) => s.phase === phase);
  const shown = new Set(t.shown.map((x) => x.seatIndex));
  // Until the hands turn, every seat is grey and the title is the only thing added.
  const title = at('title')!;
  expect(title.title).toBe(true);
  for (const s of Object.values(title.seats)) expect(s.sd).toBe('out');
  // From then on: the showdown's hands in colour, every other seat grey.
  const lit = at('highlight') ?? at('settlement')!;
  expect(lit, `a snap with the result: ${ph}`).toBeTruthy();
  expect(lit.title).toBe(false);
  for (const [k, s] of Object.entries(lit.seats)) {
    const seat = Number(k);
    expect(s.sd, `seat ${seat}`).toBe(shown.has(seat) ? 'in' : 'out');
    expect(s.winner, `winner mark on seat ${seat}`).toBe(t.winners.includes(seat));
    if (shown.has(seat)) expect([...s.cards].sort(), `seat ${seat}'s hand`).toEqual([...t.shown.find((x) => x.seatIndex === seat)!.cards].sort());
    else if (seat !== mySeat) expect(s.cards, `seat ${seat} kept its hand face down`).toEqual([]);
    // The gold on a hand: a winner's own cards of its best five; a hand shown and beaten has none.
    const own = t.shown.find((x) => x.seatIndex === seat);
    expect([...s.lit].sort(), `gold on seat ${seat}'s cards`).toEqual(own && t.winners.includes(seat) ? own.cards.filter((c) => own.bestFive.includes(c)).sort() : []);
  }
  for (const seat of shown) expect(lit.seats[seat], `seat ${seat} is at the table`).toBeTruthy();
  // The board's gold: the five of every pot's winner, and nothing else.
  const five = new Set(t.shown.filter((x) => t.winners.includes(x.seatIndex)).flatMap((x) => x.bestFive));
  expect([...lit.board].sort()).toEqual([...t.board].sort());
  expect([...lit.boardLit].sort()).toEqual(t.board.filter((c) => five.has(c)).sort());
  // The colour is back at the end: no seat is marked any more.
  for (const s of Object.values(at('restore')?.seats ?? {})) expect(s.sd).toBeNull();
}

const GREY = /grayscale\(1\)/;
/** In its own colour: no filter, or the last few hundredths of the transition back to none. */
const clear = (f: string | null) => f === 'none' || Number(/grayscale\(([\d.e-]+)\)/.exec(f ?? '')?.[1] ?? 1) < 0.05;
/** The filters a moment after the hands turned: the table grey, the board, the pot and the showdown's hands not. */
export function expectLit(w: Watched, n: number, t: Truth['settled'][number]) {
  const st = w.styles.filter((s) => s.phase === 'reveal')[n]!;
  expect(st, `styles read in scene ${n}`).toBeTruthy();
  if (!st.now || st.now === 'restore') return false;
  const shown = new Set(t.shown.map((x) => x.seatIndex));
  expect(st.felt).toMatch(GREY);
  expect(st.header).toMatch(GREY);
  expect(clear(st.board), st.board).toBe(true);
  expect(clear(st.pot), st.pot).toBe(true);
  for (const [k, s] of Object.entries(st.seats)) {
    if (shown.has(Number(k))) expect(clear(s.cards), `seat ${k}'s cards in colour: ${s.cards}`).toBe(true);
    else {
      if (s.cards !== null) expect(s.cards, `seat ${k}'s cards grey`).toMatch(GREY);
      expect(s.plate, `seat ${k}'s plate grey`).toMatch(GREY);
    }
  }
  // A winner's plate, once the result has been up for the transition's length: in colour, the others' still grey.
  const won = w.styles.filter((s) => s.phase === 'highlight')[n];
  if (won?.now && won.now !== 'restore') {
    for (const [k, s] of Object.entries(won.seats)) {
      expect(s.winner, `winner mark on seat ${k}`).toBe(t.winners.includes(Number(k)));
      if (s.winner) expect(clear(s.plate), `the winner's plate in colour: ${s.plate}`).toBe(true);
      else expect(s.plate, `seat ${k}'s plate grey`).toMatch(GREY);
    }
  }
  return true;
}

/** Everything in its own colour again once the scene is over. */
export function expectRestored(w: Watched, n: number) {
  const st = w.styles.filter((s) => s.phase === 'after')[n]!;
  expect(st, `styles read after scene ${n}`).toBeTruthy();
  if (st.now) return false; // (the next scene already: nothing to read)
  for (const v of [st.felt, st.board, st.pot, st.header]) expect(clear(v), v).toBe(true);
  for (const s of Object.values(st.seats)) {
    expect(clear(s.plate), s.plate).toBe(true);
    if (s.cards !== null) expect(clear(s.cards), s.cards).toBe(true);
  }
  expect(st.title).toBeNull();
  return true;
}

/** Folds when it is this page's turn. Returns true if it did. */
export async function fold(page: Page): Promise<boolean> {
  const b = page.getByTestId('action-bar').getByRole('button', { name: /^(폴드|Fold)$/ });
  if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) return false;
  await b.click().catch(() => {});
  await page.waitForTimeout(250);
  return true;
}

/** Puts everything in when it is this page's turn: all in if it may bet or raise, a call otherwise. */
export async function shove(page: Page): Promise<boolean> {
  const bar = page.getByTestId('action-bar');
  if (!(await bar.isVisible().catch(() => false))) return false;
  const again = /^(한 번 더|Press again)/;
  const press = async (name: RegExp) => {
    const b = bar.getByRole('button', { name });
    if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) return false;
    await b.click({ timeout: 2_000 }).catch(() => {});
    return true;
  };
  const toggle = bar.getByTestId('action-dock-toggle');
  if ((await toggle.isVisible().catch(() => false)) && (await toggle.isEnabled().catch(() => false))) {
    await page.waitForTimeout(400); // past the appear guard
    await toggle.click({ timeout: 2_000 }).catch(() => {});
    if (await press(/^(최대|Max)$/)) {
      const commit = bar.getByTestId('action-commit');
      await commit.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(200);
      if (again.test((await commit.textContent().catch(() => '')) ?? '')) await commit.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
  }
  if (await press(/^(콜|Call)/)) {
    await page.waitForTimeout(200);
    await press(again);
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

/** Takes a picture of the page at each phase of its next scene (each as soon as the page has entered it). */
export async function shootPhases(page: Page, prefix: string, from: number) {
  const seen: string[] = [];
  for (const ph of ['dimming', 'title', 'reveal', 'highlight', 'settlement', 'restore']) {
    const ok = await page
      .waitForFunction(([n, p]) => (window as unknown as { __sd: { phases: (string | null)[] } }).__sd.phases.slice(n as number).includes(p as string), [from, ph] as const, { timeout: 150_000, polling: 'raf' })
      .then(() => true, () => false);
    if (!ok) break;
    const now = await page.getByTestId('table').getAttribute('data-showdown').catch(() => null);
    await page.screenshot({ path: `test-results/${prefix}-${ph}.png` }).catch(() => {});
    seen.push(`${ph}:${now ?? 'over'}`);
  }
  return seen;
}

/**
 * Sits with `buyIn` and a standing order to buy in again for the same after losing everything, so a hand that takes a
 * whole stack leaves its player in the seat (a seat left while a hand's result is staged ends the staging).
 */
export async function sitRebuy(page: Page, tableId: string, buyIn: number) {
  await page.goto(`/table/${tableId}?sit=1`);
  const dialog = page.getByRole('dialog');
  const confirm = page.getByTestId('buyin-confirm');
  await expect(confirm).toBeVisible();
  await setRange(dialog.locator('input[type="range"]').first(), buyIn);
  await expect(confirm).toContainText(buyIn.toLocaleString('en-US'));
  const auto = dialog.getByTestId('buyin-autobuy');
  await auto.getByTestId('autobuy-mode-rebuy').click();
  await setRange(auto.getByTestId('rebuy-range'), buyIn);
  await auto.getByTestId('rebuy-consent').check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('rebuy-badge')).toBeVisible();
}
