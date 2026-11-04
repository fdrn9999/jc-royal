/**
 * A tournament table's own pieces (docs/TOURNAMENT.md): the level bar under the header, and the result card in the
 * bottom stack (a card, not a dialog, so it never covers the game). Everything shown comes from the room's
 * TournamentTableView; the countdown runs on the server's clock (serverNow) and is only a display: the room raises
 * the blinds, from the next hand, whatever this screen shows. A multi-table tournament's final table says so; the
 * standings are the seats' stacks as everyone at the table sees them (no card, nothing a watcher may not see).
 */
import type { TournamentTableView, VipColor } from '@jc/types';
import { cx, formatChips, MedalIcon, SquareIcon, TrophyIcon, XIcon } from '@jc/ui';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { MemberName } from '../components/MemberName';
import { useI18n } from '../lib/i18n';
import { serverNow } from '../lib/service';
import { useTn } from './tournament-text';

/** m:ss (or h:mm:ss) for a time left. */
function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function useNow(on: boolean) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!on) return;
    setNow(serverNow());
    const h = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(h);
  }, [on]);
  return now;
}

/** A seated player as the standings show them: the stack every seat shows. */
export interface StandingSeat {
  seatIndex: number;
  nickname: string;
  stack: number;
  vip?: VipColor;
}

export function TournamentBar({ tn, seats = [] }: { tn: TournamentTableView; seats?: StandingSeat[] }) {
  const tr = useTn();
  const [open, setOpen] = useState(false);
  const now = useNow(tn.status === 'running' && tn.levelEndsAt !== null);
  const next = tn.next;
  const clock =
    tn.status !== 'running'
      ? null
      : !next
        ? tr('lastLevel')
        : tn.levelEndsAt !== null
          ? tr('nextIn', { sb: formatChips(next.sb), bb: formatChips(next.bb), time: clockText(tn.levelEndsAt - now) })
          : tn.levelLeftMs !== null
            ? tr('stoppedLeft', { time: clockText(tn.levelLeftMs) })
            : null;
  const standings = [...seats].sort((a, b) => b.stack - a.stack || a.seatIndex - b.seatIndex);
  return (
    <div className="relative z-40">
      <div className="jc-game-surface flex flex-wrap items-center gap-x-2 gap-y-0.5 whitespace-nowrap border-b border-gold-500/10 bg-ink-950/60 px-2 py-1 sm:gap-x-3 sm:px-3 text-[11px] text-ink-200" data-testid="tn-bar" data-level={tn.level}>
        {tn.mtt?.finalTable && (
          <span className="rounded-full bg-gold-500 px-2 font-extrabold tracking-[0.08em] text-ink-950" data-testid="tn-final">
            {tr('finalTable')}
          </span>
        )}
        <span className="inline-flex items-center gap-1 font-bold text-gold-300"><TrophyIcon className="size-3" />{tr('level', { n: tn.level + 1, total: tn.levelCount })}</span>
        <span className="font-mono tabular-nums">
          {formatChips(tn.smallBlind)}/{formatChips(tn.bigBlind)}
        </span>
        {tn.paused && tn.status === 'running' ? (
          <span className="rounded-full bg-gold-500/20 px-2 font-semibold text-gold-300" data-testid="tn-bar-paused">
            {tr('pausedShort')}
          </span>
        ) : (
          clock && (
            <span className="font-mono tabular-nums text-ink-300" data-testid="tn-bar-clock">
              {clock}
            </span>
          )
        )}
        {tn.mtt && !tn.mtt.finalTable && <span className="text-ink-300" data-testid="tn-bar-tables">{tr('mttTables', { n: tn.mtt.tables })}</span>}
        {tn.mtt?.movedTo && (
          <span className="text-gold-300" role="status" data-testid="tn-bar-moving">
            {tr('moving')}
          </span>
        )}
        {tn.mtt?.hold && tn.status === 'running' && (
          <span className="text-gold-300" data-testid="tn-bar-hold">
            {tr('hold')}
          </span>
        )}
        {/* The players left open the standings (one control, so the bar's essentials fit a 320px phone). */}
        {standings.length > 0 ? (
          <button
            type="button"
            className="jc-tap -my-1 ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-gold-500/30 px-1.5 py-0.5 font-mono tabular-nums text-ink-200 hover:bg-gold-500/10"
            aria-expanded={open}
            aria-controls="tn-standings"
            title={tr('standings')}
            onClick={() => setOpen((o) => !o)}
            data-testid="tn-standings-toggle"
          >
            <span className="sr-only">{tr('standings')} · </span>
            {tr('left', { n: tn.playersLeft, total: tn.entrants })}
            <span aria-hidden className={cx('text-[9px] text-gold-300 transition-transform', open && 'rotate-180')}>
              ▾
            </span>
          </button>
        ) : (
          <span className="ml-auto font-mono tabular-nums text-ink-300">{tr('left', { n: tn.playersLeft, total: tn.entrants })}</span>
        )}
      </div>
      {open && standings.length > 0 && (
        <div id="tn-standings" className="absolute right-2 top-full mt-1 flex max-h-[min(60dvh,24rem)] w-[min(18rem,calc(100vw-1rem))] flex-col gap-2 overflow-y-auto rounded-xl border border-gold-500/25 bg-ink-950/95 p-3 text-xs shadow-xl backdrop-blur" data-testid="tn-standings">
          <div className="flex items-center justify-between gap-2">
            <p className="font-bold text-gold-300">{tr('standings.title')}</p>
            <button type="button" className="jc-tap -mr-1 grid size-7 place-items-center rounded-full text-ink-300 hover:text-ivory" onClick={() => setOpen(false)} aria-label={tr('result.dismiss')}>
              <XIcon className="size-3.5" />
            </button>
          </div>
          <ol className="flex flex-col divide-y divide-white/5">
            {standings.map((p, i) => (
              <li key={p.seatIndex} className="flex items-center gap-2 py-1" data-testid="tn-standing">
                <span className="w-5 shrink-0 font-mono tabular-nums text-ink-400">{i + 1}</span>
                <span className="flex min-w-0 flex-1">
                  <MemberName name={p.nickname} vip={p.vip} />
                </span>
                <span className="shrink-0 font-mono tabular-nums text-ink-100">{formatChips(p.stack)}</span>
              </li>
            ))}
          </ol>
          <p className="text-[10px] text-ink-400">{tr('standings.note')}</p>
          {tn.places.length > 0 && (
            <>
              <p className="font-bold text-ink-200">{tr('standings.out')}</p>
              <ol className="flex flex-col gap-0.5 text-ink-300">
                {tn.places.map((p) => (
                  <li key={`${p.place}-${p.nickname}`} className="flex min-w-0 items-center gap-2">
                    <span className="w-8 shrink-0 font-mono tabular-nums">{tr('place', { n: p.place })}</span>
                    <MemberName name={p.nickname} vip={p.vip} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The viewer's result once it is decided: out (at their place; they may close it and keep watching), the winner, a
 * finished or stopped tournament. Places decided so far are listed best first.
 */
export function TournamentResult({ tn }: { tn: TournamentTableView }) {
  const { t } = useI18n();
  const tr = useTn();
  const key = `${tn.id}:${tn.status}:${tn.you.status}:${tn.you.place ?? ''}`;
  const [closed, setClosed] = useState<string | null>(null);
  const ended = tn.status !== 'running';
  const mine = tn.you.status === 'eliminated' || tn.you.status === 'won' || tn.you.status === 'stopped';
  if (!ended && !mine) return null;
  // Out while the others play on: the card can be closed; at the end it stays (the table closes shortly anyway).
  if (closed === key && !ended) return null;
  const head =
    tn.you.status === 'won'
      ? tr('result.won')
      : tn.you.status === 'eliminated' && tn.you.place !== null
        ? tr('result.out', { n: tn.you.place })
        : tn.status === 'aborted' || tn.you.status === 'stopped'
          ? tr('result.stopped')
          : tr('result.finished');
  const places = tn.places.slice(0, 6);
  const champion = tn.status === 'finished' && tn.you.status !== 'won' ? tn.places.find((p) => p.place === 1) : undefined;
  return (
    <div
      className={cx(
        'pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-2xl border bg-ink-950/95 p-3 text-sm backdrop-blur sm:w-[26rem]',
        tn.you.status === 'won' ? 'border-gold-400/70' : 'border-white/10',
      )}
      role="status"
      data-testid="tn-result"
      data-status={tn.you.status}
    >
      <div className="flex items-start gap-2">
        {tn.you.status === 'won' ? <TrophyIcon className="size-5 text-gold-300" /> : tn.status === 'aborted' ? <SquareIcon className="size-5 text-ink-300" /> : <MedalIcon className="size-5 text-gold-300" />}
        <div className="min-w-0 flex-1">
          <p className={cx('font-bold', tn.you.status === 'won' ? 'text-gold-300' : 'text-ivory')}>{head}</p>
          {champion && (
            <p className="flex min-w-0 items-center gap-1 font-bold text-gold-300" data-testid="tn-champion">
              <TrophyIcon className="size-4 shrink-0" />
              <MemberName name={champion.nickname} vip={champion.vip} />
            </p>
          )}
          <p className="text-xs text-ink-300">{ended ? (tn.status === 'aborted' ? tr('abortedNote') : tr('result.closing')) : tr('result.watching')}</p>
        </div>
        {!ended && (
          <button type="button" className="jc-tap -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-ink-300 hover:text-ivory" onClick={() => setClosed(key)} aria-label={tr('result.dismiss')} data-testid="tn-result-close">
            <XIcon className="size-4" />
          </button>
        )}
      </div>
      {places.length > 0 && (
        <ol className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-200" aria-label={tr('result.places')}>
          {places.map((p) => (
            <li key={`${p.place}-${p.nickname}`} className={cx('inline-flex min-w-0 max-w-full items-center gap-1', p.place === 1 && 'font-semibold text-gold-300')}>
              <span className="shrink-0">{tr('place', { n: p.place })}</span>
              <MemberName name={p.nickname} vip={p.vip} />
            </li>
          ))}
        </ol>
      )}
      <Link to={`/tournaments/${tn.id}`} className="self-start text-xs font-semibold text-gold-300 underline underline-offset-2" data-testid="tn-result-link">
        {tr('result.view')} →
      </Link>
    </div>
  );
}
