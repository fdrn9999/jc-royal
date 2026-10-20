/**
 * A tournament table's own pieces (docs/TOURNAMENT.md): the level bar under the header, and the result card in the
 * bottom stack (a card, not a dialog, so it never covers the game). Everything shown comes from the room's
 * TournamentTableView; the countdown runs on the server's clock (serverNow) and is only a display: the room raises
 * the blinds, from the next hand, whatever this screen shows.
 */
import type { TournamentTableView } from '@jc/types';
import { cx, formatChips } from '@jc/ui';
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

export function TournamentBar({ tn }: { tn: TournamentTableView }) {
  const { t } = useI18n();
  const tr = useTn();
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
  return (
    <div className="jc-game-surface z-40 flex items-center gap-x-3 gap-y-0.5 overflow-x-auto whitespace-nowrap border-b border-gold-500/10 bg-ink-950/60 px-3 py-1 text-[11px] text-ink-200" data-testid="tn-bar" data-level={tn.level}>
      <span className="font-bold text-gold-300">🏆 {tr('level', { n: tn.level + 1, total: tn.levelCount })}</span>
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
      <span className="ml-auto font-mono tabular-nums text-ink-300">{tr('left', { n: tn.playersLeft, total: tn.entrants })}</span>
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
        <span aria-hidden className="text-xl leading-none">
          {tn.you.status === 'won' ? '🏆' : tn.status === 'aborted' ? '⏹' : '🎖'}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cx('font-bold', tn.you.status === 'won' ? 'text-gold-300' : 'text-ivory')}>{head}</p>
          <p className="text-xs text-ink-300">{ended ? (tn.status === 'aborted' ? tr('abortedNote') : tr('result.closing')) : tr('result.watching')}</p>
        </div>
        {!ended && (
          <button type="button" className="jc-tap -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-full text-ink-300 hover:text-ivory" onClick={() => setClosed(key)} aria-label={tr('result.dismiss')} data-testid="tn-result-close">
            ✕
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
