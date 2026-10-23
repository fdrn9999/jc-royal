/**
 * Quick play: the server picks a public table where the room confirms a free seat (beginner tables first for
 * newcomers), then the table page opens the usual buy-in dialog; nothing is paid until the player confirms there.
 * Its size and blind filters are the lobby list's filters too. The `quick` query parameter carries the filters and
 * the tables already tried, so "find another table" on the table page skips them.
 */
import type { LobbyTableDto, QuickPlayDto } from '@jc/types';
import { Button, formatChips, PlusIcon, ZapIcon } from '@jc/ui';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { RefillHintLazy } from './RefillHintLazy';
import { Choice } from './Rooms';

/** 0 means any. */
export interface QuickFilters {
  maxSeats: 0 | 2 | 6 | 9;
  bigBlind: number;
}
export const ANY: QuickFilters = { maxSeats: 0, bigBlind: 0 };
const SEATS = [0, 2, 6, 9] as const;
/** The server accepts at most this many tables to skip. */
const MAX_TRIED = 20;

export interface QuickMiss {
  code: string;
  minBuyIn?: number;
  balance?: number;
}

/** Reads `quick=<seats>,<bigBlind>,<tried ids…>` back from the table page's URL. */
export function parseQuick(v: string | null): { filters: QuickFilters; tried: string[] } | null {
  if (!v) return null;
  const [seats, bb, ...tried] = v.split(',');
  const maxSeats = Number(seats);
  return {
    filters: { maxSeats: (SEATS as readonly number[]).includes(maxSeats) ? (maxSeats as QuickFilters['maxSeats']) : 0, bigBlind: Math.max(0, Math.floor(Number(bb) || 0)) },
    tried: tried.filter(Boolean).slice(-MAX_TRIED),
  };
}

export function useQuickPlay() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [miss, setMiss] = useState<QuickMiss | null>(null);
  const run = useCallback(
    async (f: QuickFilters, tried: string[] = []) => {
      setBusy(true);
      setMiss(null);
      try {
        const r = await api<QuickPlayDto>('/api/tables/quick', {
          body: { ...(f.maxSeats ? { maxSeats: f.maxSeats } : {}), ...(f.bigBlind ? { bigBlind: f.bigBlind } : {}), exclude: tried.slice(-MAX_TRIED) },
        });
        const quick = [f.maxSeats, f.bigBlind, ...[...tried, r.table.id].slice(-MAX_TRIED)].join(',');
        nav(`/table/${encodeURIComponent(r.table.id)}?${new URLSearchParams({ sit: '1', quick })}`);
      } catch (e) {
        const d = e instanceof ApiError ? (e.details as { minBuyIn?: number; balance?: number } | undefined) : undefined;
        setMiss({ code: e instanceof ApiError ? e.code : 'internal', minBuyIn: d?.minBuyIn, balance: d?.balance });
      } finally {
        setBusy(false);
      }
    },
    [nav],
  );
  return { run, busy, miss, clear: useCallback(() => setMiss(null), []) };
}

/** What went wrong and what the player can do instead. */
export function QuickMissNote({ miss, filtered, onReset, onRetry, onCreateRoom }: { miss: QuickMiss; filtered: boolean; onReset?: () => void; onRetry?: () => void; onCreateRoom?: () => void }) {
  const { t, err } = useI18n();
  const text =
    miss.code === 'no_table'
      ? t('quick.noTable')
      : miss.code === 'tables_full'
        ? t('quick.full')
        : miss.code === 'insufficient_balance' && miss.minBuyIn !== undefined
          ? t('quick.poor', { min: formatChips(miss.minBuyIn), balance: formatChips(miss.balance ?? 0) })
          : err(miss.code);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gold-500/25 bg-gold-500/10 px-3 py-2.5 text-sm text-ivory" role="status" data-testid="quick-miss" data-code={miss.code}>
      <p>{text}</p>
      {miss.code === 'insufficient_balance' && <RefillHintLazy />}
      <div className="flex flex-wrap gap-2">
        {filtered && onReset && (
          <Button size="sm" variant="outline" onClick={onReset} data-testid="quick-reset">
            {t('quick.reset')}
          </Button>
        )}
        {miss.code === 'tables_full' && onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('quick.retry')}
          </Button>
        )}
        {miss.code !== 'insufficient_balance' && onCreateRoom && (
          <Button size="sm" variant="outline" onClick={onCreateRoom}>
            <PlusIcon />
            {t('room.create')}
          </Button>
        )}
        {miss.code === 'insufficient_balance' && (
          <Link to="/me" className="jc-tap inline-flex min-h-9 items-center rounded-lg border border-white/10 px-3 text-xs font-semibold text-ink-200 hover:text-ivory">
            {t('quick.wallet')}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Blind levels (big blind → small blind) played at the open tables of a size, lowest first. */
export function blindLevels(tables: LobbyTableDto[] | null, maxSeats: QuickFilters['maxSeats']): [number, number][] {
  const seen = new Map<number, number>();
  for (const tb of tables ?? []) {
    if (tb.status !== 'open' || (maxSeats && tb.maxSeats !== maxSeats)) continue;
    if (!seen.has(tb.bigBlind)) seen.set(tb.bigBlind, tb.smallBlind);
  }
  return [...seen].sort((a, b) => a[0] - b[0]);
}

/** The size and blind filters a lobby address (`seats`, `bb`) asks for. */
export function filtersOf(params: URLSearchParams): QuickFilters {
  const seats = Number(params.get('seats'));
  return { maxSeats: (SEATS as readonly number[]).includes(seats) ? (seats as QuickFilters['maxSeats']) : 0, bigBlind: Math.max(0, Math.floor(Number(params.get('bb')) || 0)) };
}

/** The lobby's size and blind filters drive quick play too; a blind level the chosen size doesn't play reads as any. */
export function useLobbyFilters(tables: LobbyTableDto[] | null, f: QuickFilters) {
  const blinds = useMemo(() => blindLevels(tables, f.maxSeats), [tables, f.maxSeats]);
  const filters: QuickFilters = { ...f, bigBlind: blinds.some(([bb]) => bb === f.bigBlind) ? f.bigBlind : 0 };
  return { filters, blinds, any: !filters.maxSeats && !filters.bigBlind };
}

export function QuickPlayPanel({
  filters,
  blinds,
  onFilters,
  onCreateRoom,
  paused = false,
}: {
  filters: QuickFilters;
  blinds: [number, number][];
  onFilters: (f: QuickFilters) => void;
  onCreateRoom: () => void;
  /** Maintenance under way: quick play and new rooms wait (the server refuses both). */
  paused?: boolean;
}) {
  const { t } = useI18n();
  const { run, busy, miss, clear } = useQuickPlay();
  const f = filters;
  const set = (next: Partial<QuickFilters>) => {
    clear();
    onFilters({ ...f, ...next });
  };
  const bigBlind = f.bigBlind;

  return (
    <section className="jc-panel flex flex-col gap-3 border-gold-500/30 p-4 sm:p-5" data-testid="quick-play" aria-labelledby="quick-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="min-w-0 lg:w-80 lg:shrink-0">
          <h2 id="quick-title" className="font-bold text-ivory">
            <ZapIcon className="mr-1 inline size-4 align-[-2px] text-gold-300" />
            {t('quick.title')}
          </h2>
          <p className="mt-1 text-xs text-ink-300">{t('quick.desc')}</p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-300">{t('quick.seats')}</span>
            <Choice label={t('quick.seats')} value={f.maxSeats} options={SEATS} onChange={(maxSeats) => set({ maxSeats })} render={(n) => (n ? t('room.seatsN', { n }) : t('quick.any'))} testid="quick-seats" />
          </div>
          <label className="flex min-w-0 flex-col gap-1.5 sm:w-40">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-300">{t('lobby.blinds')}</span>
            <select
              value={bigBlind}
              onChange={(e) => set({ bigBlind: Number(e.target.value) })}
              className="h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-2 text-base text-ivory focus:border-gold-500/70 focus:outline-none sm:text-sm"
              data-testid="quick-blind"
            >
              <option value={0}>{t('quick.any')}</option>
              {blinds.map(([bb, sb]) => (
                <option key={bb} value={bb}>
                  {formatChips(sb)}/{formatChips(bb)}
                </option>
              ))}
            </select>
          </label>
          <Button className="h-11 sm:ml-auto sm:min-w-36" loading={busy} disabled={paused} onClick={() => run(filters)} data-testid="quick-go">
            {t('quick.go')}
          </Button>
        </div>
      </div>
      {miss && !paused && (
        <QuickMissNote
          miss={miss}
          filtered={!!(filters.maxSeats || filters.bigBlind)}
          onReset={() => set(ANY)}
          onRetry={() => run(filters)}
          onCreateRoom={onCreateRoom}
        />
      )}
    </section>
  );
}
