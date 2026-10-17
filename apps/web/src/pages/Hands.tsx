/**
 * All of the member's hands (My Page → all hands), newest first, narrowed by period, position, result, pot size, tag
 * or bookmark. The server filters (GET /api/me/hands) and pages; the filters live in the address so back and reload
 * keep them.
 */
import { HAND_MIN_POTS, HAND_RESULTS, HAND_TAGS, POSITIONS, type HandSummaryDto } from '@jc/types';
import { Button, cx, Empty, Field, Input, Panel } from '@jc/ui';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { HandRow } from '../components/HandNotes';
import { api, ApiError } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';

const PAGE = 20;
const PERIODS = ['all', 'today', '7', '30', 'custom'] as const;
/** Address keys, in the order they read. */
const KEYS = ['period', 'from', 'to', 'position', 'result', 'pot', 'tag', 'bookmarked'] as const;

/** The start of the day `back` days before today, on this device's clock. */
const dayStart = (back: number) => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - back).getTime();
};
/** 'YYYY-MM-DD' → the start of that day (or of the day after), on this device's clock. */
const parseDay = (s: string | null, after = 0) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + after).getTime() : undefined;
};

/** The API query for the filters in the address (paging left out). */
function apiQuery(p: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams();
  const period = p.get('period');
  const from = period === 'today' ? dayStart(0) : period === '7' ? dayStart(6) : period === '30' ? dayStart(29) : period === 'custom' ? parseDay(p.get('from')) : undefined;
  const to = period === 'custom' ? parseDay(p.get('to'), 1) : undefined;
  if (from !== undefined) q.set('from', String(from));
  if (to !== undefined) q.set('to', String(to));
  const pos = p.get('position');
  if (pos && (POSITIONS as readonly string[]).includes(pos)) q.set('position', pos);
  const result = p.get('result');
  if (result && (HAND_RESULTS as readonly string[]).includes(result)) q.set('result', result);
  const pot = p.get('pot');
  if (pot && (HAND_MIN_POTS as readonly number[]).includes(Number(pot))) q.set('minPot', pot);
  const tag = p.get('tag');
  if (tag && (HAND_TAGS as readonly string[]).includes(tag)) q.set('tag', tag);
  if (p.get('bookmarked') === '1') q.set('bookmarked', '1');
  q.set('limit', String(PAGE));
  return q;
}

const selectCls = 'h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-2 text-base text-ivory focus:border-gold-500/70 focus:outline-none sm:text-sm';

export function HandsPage() {
  const { t, err } = useI18n();
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => apiQuery(params).toString(), [params]);
  const [hands, setHands] = useState<HandSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState(false);
  const filtered = query !== `limit=${PAGE}`;
  const active = KEYS.filter((k) => k !== 'from' && k !== 'to' && params.get(k) && params.get(k) !== 'all').length;

  const load = useCallback(
    async (after?: HandSummaryDto, signal?: AbortSignal) => {
      const q = new URLSearchParams(query);
      if (after) {
        q.set('before', String(after.endedAt));
        q.set('beforeId', after.id);
      }
      const page = await api<HandSummaryDto[]>(`/api/me/hands?${q}`, { signal });
      setMore(page.length === PAGE);
      return page;
    },
    [query],
  );
  const fail = (x: unknown) => setError(x instanceof ApiError && x.code === 'rate_limited' ? err(x.code) : t('hands.loadFailed'));
  const first = useCallback(
    (signal?: AbortSignal) => {
      setHands(null);
      setError(null);
      load(undefined, signal).then(setHands, (x: unknown) => {
        if (!signal?.aborted) fail(x);
      });
    },
    [load], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const ac = new AbortController();
    first(ac.signal);
    return () => ac.abort();
  }, [first]);

  async function loadMore() {
    if (!hands?.length) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await load(hands[hands.length - 1]);
      setHands((h) => [...(h ?? []), ...page.filter((x) => !h?.some((y) => y.id === x.id))]);
    } catch (x) {
      fail(x);
    } finally {
      setLoadingMore(false);
    }
  }

  const set = (k: (typeof KEYS)[number], v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v === null || v === '' || v === 'all') n.delete(k);
        else n.set(k, v);
        if (k === 'period' && v !== 'custom') {
          n.delete('from');
          n.delete('to');
        }
        return n;
      },
      // Not in a transition: the controls show the new value at once instead of the old one for a moment.
      { replace: true, flushSync: true },
    );
  const replace = (h: HandSummaryDto) => setHands((list) => list?.map((x) => (x.id === h.id ? h : x)) ?? null);
  const period = params.get('period') ?? 'all';

  const select = (k: (typeof KEYS)[number], label: string, any: string, options: { value: string; label: string }[], hint?: ReactNode) => (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} value={params.get(k) ?? ''} onChange={(e) => set(k, e.target.value)} className={selectCls} data-testid={`hands-${k}`}>
          <option value="">{any}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold tracking-[0.04em] jc-gold-text">{t('hands.title')}</h1>
        <Link to="/me" className="text-sm text-gold-300 hover:underline">
          ← {t('nav.me')}
        </Link>
      </div>
      <Panel
        title={t('hands.filters')}
        actions={
          <div className="flex items-center gap-3">
            {active > 0 && (
              <button type="button" className="jc-tap py-2 text-xs text-gold-300 hover:underline" onClick={() => setParams(new URLSearchParams(), { replace: true, flushSync: true })} data-testid="hands-reset">
                {t('hands.reset')}
              </button>
            )}
            <button type="button" className="jc-tap rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-ink-200 sm:hidden" aria-expanded={open} aria-controls="hands-filters" onClick={() => setOpen(!open)} data-testid="hands-filters-toggle">
              {t('hands.filters')}
              {active > 0 && ` (${active})`} {open ? '▲' : '▼'}
            </button>
          </div>
        }
      >
        <div id="hands-filters" className={cx(open ? 'grid' : 'hidden', 'grid-cols-2 gap-3 sm:grid sm:grid-cols-3 lg:grid-cols-6')}>
          <Field label={t('hands.period')}>
            {(id) => (
              <select id={id} value={period} onChange={(e) => set('period', e.target.value)} className={selectCls} data-testid="hands-period">
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {t(`hands.period.${p}` as MsgKey)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {select('position', t('me.position'), t('hands.anyPosition'), POSITIONS.map((p) => ({ value: p, label: t(`me.pos.${p}` as MsgKey) })))}
          {select('result', t('hands.result'), t('hands.result.any'), HAND_RESULTS.map((r) => ({ value: r, label: t(`hands.result.${r}` as MsgKey) })))}
          {select(
            'pot',
            t('hands.pot'),
            t('hands.pot.any'),
            HAND_MIN_POTS.map((n) => ({ value: String(n), label: t('hands.pot.min', { n }) })),
            params.get('pot') ? t('hands.potNote') : undefined,
          )}
          {select('tag', t('hands.tag'), t('hands.tag.any'), HAND_TAGS.map((tg) => ({ value: tg, label: t(`hands.tags.${tg}` as MsgKey) })))}
          <label className="jc-tap flex min-h-11 cursor-pointer items-center gap-2 self-end rounded-lg border border-white/10 px-3 text-sm text-ink-100">
            <input type="checkbox" className="size-4" checked={params.get('bookmarked') === '1'} onChange={(e) => set('bookmarked', e.target.checked ? '1' : null)} data-testid="hands-bookmarked" />
            {t('hands.bookmarkedOnly')}
          </label>
          {period === 'custom' && (
            <>
              <Field label={t('hands.from')}>{(id) => <Input id={id} type="date" value={params.get('from') ?? ''} max={params.get('to') ?? undefined} onChange={(e) => set('from', e.target.value)} data-testid="hands-from" />}</Field>
              <Field label={t('hands.to')}>{(id) => <Input id={id} type="date" value={params.get('to') ?? ''} min={params.get('from') ?? undefined} onChange={(e) => set('to', e.target.value)} data-testid="hands-to" />}</Field>
            </>
          )}
        </div>
      </Panel>
      <Panel title={t('me.allHands')}>
        {error && !hands ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center" role="alert" data-testid="hands-error">
            <p className="text-sm text-ink-200">{error}</p>
            <Button size="sm" variant="outline" onClick={() => first()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : !hands ? (
          <Empty>{t('common.loading')}</Empty>
        ) : hands.length === 0 ? (
          <div data-testid="hands-empty">
            <Empty>{filtered ? t('hands.noMatch') : t('me.none')}</Empty>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-white/5" data-testid="hands-list">
              {hands.map((h) => (
                <HandRow key={h.id} hand={h} onChange={replace} />
              ))}
            </ul>
            {error && (
              <p className="mt-3 text-center text-sm text-danger" role="alert">
                {error}
              </p>
            )}
            {more && (
              <div className="mt-3 flex justify-center">
                <Button size="sm" variant="outline" loading={loadingMore} onClick={() => void loadMore()} data-testid="hands-more">
                  {error ? t('common.retry') : t('hands.more')}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
