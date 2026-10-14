/**
 * Visual + audio effects driven by server cues. Effects are purely cosmetic:
 * the table already renders the authoritative state; this layer only adds
 * flying chips (Elite-Poker AnimatedChip idea: arc + ease-out, capped
 * concurrency) and sounds. Fast bursts and reconnect snapshots are trimmed so
 * the queue can never lag behind the game.
 */
import { sound, type SoundId } from '@jc/audio';
import { Chip } from '@jc/ui';
import { useEffect, useRef, useState } from 'react';
import { POT_POINT, type SeatGeometry, type Point } from './layout';
import type { CueEvent } from './useTableSocket';

interface Flight {
  id: number;
  from: Point;
  to: Point;
  amount: number;
  delay: number;
}

const MAX_FLIGHTS = 10;
const STALE_MS = 3_000;

export function CueLayer({
  cues,
  consume,
  geometry,
  mySeat,
  reducedMotion,
}: {
  cues: CueEvent[];
  consume: (upTo: number) => void;
  geometry: SeatGeometry[];
  mySeat: number | null;
  reducedMotion: boolean;
}) {
  const [flights, setFlights] = useState<Flight[]>([]);
  const seq = useRef(0);
  const firstSeen = useRef(new Map<number, number>());

  useEffect(() => {
    if (cues.length === 0) return;
    const now = Date.now();
    const add: Flight[] = [];
    const sounds = new Set<SoundId>();
    for (const ev of cues) {
      if (!firstSeen.current.has(ev.id)) firstSeen.current.set(ev.id, now);
      // Cues that arrived while the tab was hidden are dropped, not replayed.
      if (now - firstSeen.current.get(ev.id)! > STALE_MS || document.hidden) continue;
      const c = ev.cue;
      switch (c.kind) {
        case 'deal':
          sounds.add('deal');
          break;
        case 'action': {
          const map: Record<string, SoundId> = { fold: 'fold', check: 'check', call: 'call', bet: 'raise', raise: 'raise', allin: 'allin' };
          sounds.add(map[c.type] ?? 'chip');
          const g = geometry[c.seatIndex];
          if (g && c.amount > 0) add.push({ id: ++seq.current, from: g.seat, to: g.bet, amount: c.amount, delay: 0 });
          break;
        }
        case 'street': {
          sounds.add('flip');
          // Street bets are swept into the pot.
          geometry.forEach((g, i) => {
            const bet = ev.state.seats[i];
            if (bet && i < geometry.length && add.length < MAX_FLIGHTS && bet.state !== 'empty') add.push({ id: ++seq.current, from: g.bet, to: POT_POINT, amount: 25, delay: 40 * i });
          });
          break;
        }
        case 'showdown':
          sounds.add('showdown');
          break;
        case 'payout': {
          const g = geometry[c.seatIndex];
          if (g) for (let k = 0; k < 4; k++) add.push({ id: ++seq.current, from: POT_POINT, to: g.seat, amount: c.amount, delay: 350 + k * 90 });
          if (c.seatIndex === mySeat) sounds.add('win');
          else sounds.add('chip');
          break;
        }
        default:
          break;
      }
    }
    for (const s of sounds) sound.play(s);
    if (!reducedMotion && add.length) setFlights((f) => [...f, ...add].slice(-MAX_FLIGHTS * 2));
    consume(cues[cues.length - 1]!.id);
  }, [cues, consume, geometry, mySeat, reducedMotion]);

  return (
    <div className="pointer-events-none absolute inset-0 z-30" aria-hidden>
      {flights.map((f) => (
        <FlyingChip key={f.id} flight={f} onDone={() => setFlights((all) => all.filter((x) => x.id !== f.id))} />
      ))}
    </div>
  );
}

function FlyingChip({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dx = flight.to.x - flight.from.x;
    const dy = flight.to.y - flight.from.y;
    const anim = el.animate(
      [
        { left: `${flight.from.x}%`, top: `${flight.from.y}%`, opacity: 0, transform: 'translate(-50%,-50%) scale(0.7)' },
        { left: `${flight.from.x + dx * 0.5}%`, top: `${flight.from.y + dy * 0.5 - 6}%`, opacity: 1, transform: 'translate(-50%,-50%) scale(1.05)', offset: 0.5 },
        { left: `${flight.to.x}%`, top: `${flight.to.y}%`, opacity: 0.2, transform: 'translate(-50%,-50%) scale(0.9)' },
      ],
      { duration: 520, delay: flight.delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
    anim.onfinish = () => {
      if (flight.delay === 0) sound.play('chip');
      done.current();
    };
    return () => anim.cancel();
  }, [flight]);
  return (
    <div ref={ref} className="absolute" style={{ left: `${flight.from.x}%`, top: `${flight.from.y}%` }}>
      <Chip amount={flight.amount} size="1.15rem" />
    </div>
  );
}
