/**
 * Plays the server's cues on the table: staging.ts plans each batch, this runs the plan (its sounds and redraws) and
 * draws its flying chips. Purely presentational: the table already holds the server state, and what the plan shows
 * instead lasts a few seconds at most, never reaches the action bar or a dialog, and gives way at once to anything new
 * (a new batch starts from where the last one ends, a new hand or a state no cue explains ends it, a hidden tab drops
 * it with its sounds). Cues delivered again with a state of the same version never get here (useTableSocket).
 */
import { sound } from '@jc/audio';
import { RESULT_HOLD_MS, SCENE_MS, type ShowdownMode, type TableView } from '@jc/types';
import { ChipStack } from '@jc/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { Amounts } from '../lib/amount';
import type { Point, SeatGeometry } from './layout';
import { boundaries, dealDelays, holdSeats, plan, quickSounds, sig, STAGED_KINDS, stagedAt, type Flight, type Plan, type Staged } from './staging';
import type { CueEvent } from './useTableSocket';

/** How the current hand's cards came in: dealt in front of us (when each card lands), or already there when we arrived. */
export interface HandArrival {
  id: string;
  deal: Record<number, [number, number]> | null;
  /** The cards seen on arrival: they stay put; only cards turned since then animate. */
  still: ReadonlySet<string> | null;
}

export interface Staging {
  /** What the scene shows instead of the server state right now (null: the server state). */
  staged: Staged | null;
  flights: Flight[];
  /** When the running plan started (performance.now()): its flights are timed from it. */
  start: number;
  arrival: HandArrival | null;
  /** How long the showdown's title shows, in ms (0: no showdown is staged). */
  titleMs: number;
  /**
   * The seats to draw: the state's, with a seat left after its hand's result (out of chips, or leaving) kept as the
   * result found it until the next hand, so the hand's end reads with everyone who was in it.
   */
  seats: TableView['seats'];
  /** My seat among those kept, once the room stood me up after the result (null: I sit where the state says, or nowhere). */
  mine: number | null;
  /** Ends the running scene on this screen only: the state shows at once (nothing is sent, nothing else changes). */
  skip: () => void;
}

/** The longest a seat left after the result stays in the picture: the longest the room leaves before a deal (pace.ts). */
export const SEAT_HOLD_MS = SCENE_MS.runout + RESULT_HOLD_MS.bust;

interface Run {
  plan: Plan;
  start: number;
  /** The state the plan was made for. */
  view: TableView;
}

function cardsOf(v: TableView): Set<string> {
  const out = new Set<string>(v.hand?.board ?? []);
  for (const x of v.seats) for (const c of [...(x.holeCards ?? []), ...(x.shown ?? [])]) if (c) out.add(c);
  return out;
}

export function useCueStaging(s: TableView, cues: CueEvent[], consume: (upToId: number) => void, mySeat: number | null, reducedMotion: boolean, mode: ShowdownMode = 'cinematic'): Staging {
  const last = useRef(0);
  const prev = useRef<TableView | null>(null);
  const run = useRef<Run | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The Academy pages pass a new function every render.
  const consumeRef = useRef(consume);
  consumeRef.current = consume;
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  const fresh = cues.filter((e) => e.id > last.current);
  const staging = fresh.some((e) => STAGED_KINDS.has(e.cue.kind));
  // Planned while rendering (it is pure), so the batch's first frame already shows where it starts, not where it ends.
  const next = useMemo<Run | null>(() => {
    if (!staging || reducedMotion || document.hidden) return null;
    // (The fast setting stages nothing of a hand's end: its result shows at once.)
    if (mode === 'fast' && s.hand?.stage === 'settled') return null;
    const p = plan(prev.current, fresh, s, mySeat, mode);
    return p && { plan: p, start: performance.now(), view: s };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cues, s]);

  // Each hand as first seen: dealt now (its handStart came with it) or under way (its cards are just there).
  const arrival = useRef<HandArrival | null>(null);
  const hand = s.hand;
  if (hand && arrival.current?.id !== hand.id) {
    const dealt = !reducedMotion && fresh.some((e) => e.cue.kind === 'handStart');
    arrival.current = { id: hand.id, deal: dealt ? dealDelays(s) : null, still: dealt ? null : cardsOf(s) };
  }

  // The hand's end as the result found it: the state the room sent everybody with the result (nothing a client could
  // not already see), kept for that hand only. A seat its player left since stays in the picture until the next deal.
  // Never longer than the longest time the room leaves before a deal (a table left with nobody to deal to keeps its
  // last hand's result: the seat is free there, and shows as free).
  const settledAs = useRef<{ view: TableView; at: number } | null>(null);
  if (!hand || hand.stage !== 'settled') settledAs.current = null;
  else if (settledAs.current?.view.hand?.id !== hand.id) settledAs.current = { view: s, at: performance.now() };
  const heldId = settledAs.current ? hand!.id : null;
  useEffect(() => {
    if (!heldId) return;
    const h = setTimeout(redraw, SEAT_HOLD_MS + 50);
    return () => clearTimeout(h);
  }, [heldId]);
  const kept = settledAs.current && performance.now() - settledAs.current.at < SEAT_HOLD_MS ? settledAs.current.view : null;

  const clear = () => {
    for (const h of timers.current) clearTimeout(h);
    timers.current = [];
    run.current = null;
  };
  const stop = useCallback(() => {
    const was = run.current;
    clear();
    if (was) redraw();
  }, []);

  useLayoutEffect(() => {
    prev.current = s;
    const batch = cues.filter((e) => e.id > last.current);
    if (batch.length) {
      last.current = batch[batch.length - 1]!.id;
      consumeRef.current(last.current);
    }
    if (!batch.some((e) => STAGED_KINDS.has(e.cue.kind))) {
      // A seat taken or left, a reconnect: the plan goes on unless the hand moved on without it, or the plan no longer
      // applies (chips on their way to a seat left or taken), so its timers and sounds end with it.
      const r = run.current;
      if (r && (sig(s) !== r.plan.final || !stagedAt(r.plan, performance.now() - r.start, holdSeats(r.view, s)))) stop();
      return;
    }
    // Anything new catches up: the old plan gives way, the new one starts from the state it left.
    stop();
    if (document.hidden) return;
    if (!next) {
      for (const id of quickSounds(batch, mySeat)) sound.play(id);
      return;
    }
    run.current = next;
    const late = performance.now() - next.start;
    for (const x of next.plan.sounds) {
      if (x.at <= late) sound.play(x.id);
      else timers.current.push(setTimeout(() => sound.play(x.id), x.at - late));
    }
    for (const b of boundaries(next.plan)) timers.current.push(setTimeout(b >= next.plan.end ? stop : redraw, Math.max(0, b - late)));
  }, [cues, s]); // eslint-disable-line react-hooks/exhaustive-deps

  // A hidden tab keeps nothing for later: it shows the state when it comes back, without the sounds it missed.
  useEffect(() => {
    const hide = () => document.hidden && stop();
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      clear();
    };
  }, [stop]);

  const active = staging ? next : run.current && sig(s) === run.current.plan.final ? run.current : null;
  // (A player the room stood up after the result, out of chips, stays in the scene until it is over.)
  const shown = kept ? holdSeats(kept, s, true) : active ? holdSeats(active.view, s) : s;
  const staged = active ? stagedAt(active.plan, performance.now() - active.start, shown) : null;
  const cine = staged?.cine ? active!.plan.cine : null;
  return {
    staged,
    flights: staged ? active!.plan.flights : [],
    start: active?.start ?? 0,
    arrival: hand && arrival.current?.id === hand.id ? arrival.current : null,
    titleMs: cine ? active!.plan.reveal - cine.title : 0,
    seats: shown.seats,
    mine: heldMine(kept, s, shown),
    skip: stop,
  };
}

/** My seat while the picture keeps it after the room stood me up: the one I had at the result, still empty since. */
function heldMine(was: TableView | null, now: TableView, shown: TableView): number | null {
  const i = was?.you.seatIndex;
  if (i == null || now.you.seatIndex !== null || shown === now) return null;
  const kept = shown.seats.find((x) => x.seatIndex === i);
  return kept && kept.state !== 'empty' && now.seats.find((x) => x.seatIndex === i)?.state === 'empty' ? i : null;
}

/** The running plan's chips, each flying at its time in the plan. `box`: the table's size in px, which the flights move by. */
export function Flights({ flights, start, geometry, pot, box, amounts }: { flights: Flight[]; start: number; geometry: SeatGeometry[]; pot: Point; box: { w: number; h: number }; amounts: Amounts }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-hidden data-testid="flights">
      {flights.map((f) => {
        const g = geometry[f.seat];
        if (!g) return null;
        const [from, to] = f.kind === 'bet' ? [g.seat, g.bet] : f.kind === 'sweep' ? [g.bet, pot] : f.kind === 'return' ? [g.bet, g.seat] : [pot, g.seat];
        return <FlyingChips key={`${start}-${f.id}`} flight={f} from={from} to={to} box={box} start={start} text={f.kind === 'payout' ? amounts.fmt(f.amount, true) : null} />;
      })}
    </div>
  );
}

function FlyingChips({ flight, from, to, box, start, text }: { flight: Flight; from: Point; to: Point; box: { w: number; h: number }; start: number; text: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') return;
    // Drawn after its plan started (a resize, a redraw): the flight keeps its place in the plan.
    const late = performance.now() - start;
    // Placed where it starts and moved from there by a transform only (with its opacity), which the compositor runs:
    // moving left and top would lay the page out again every frame of the flight.
    const dx = ((to.x - from.x) * box.w) / 100;
    const dy = ((to.y - from.y) * box.h) / 100;
    const lift = (4 * box.h) / 100;
    const anim = el.animate(
      [
        { opacity: 0, transform: 'translate(0px,0px) scale(0.8)' },
        { opacity: 1, offset: 0.15 },
        { transform: `translate(${dx / 2}px,${dy / 2 - lift}px) scale(1.04)`, offset: 0.5 },
        { opacity: 1, offset: 0.85 },
        { opacity: 0, transform: `translate(${dx}px,${dy}px) scale(0.92)` },
      ],
      { duration: flight.dur, delay: flight.at - late, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
    return () => anim.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight, from.x, from.y, to.x, to.y, box.w, box.h]);
  return (
    // Centred by `translate` (Tailwind's), which applies before the animated transform.
    <div ref={ref} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${from.x}%`, top: `${from.y}%`, opacity: 0 }} data-flight={flight.kind} data-seat={flight.seat} data-amount={flight.amount}>
      <ChipStack amount={flight.amount} size={text ? '1.1rem' : '0.95rem'} label={!!text} text={text ?? undefined} />
    </div>
  );
}
