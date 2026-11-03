import { TREND_DAYS, type PositionStatsDto, type StatRatio, type StatsDto, type StatsTrendDto, type TrendDays } from '@jc/types';
import { ChevronDownIcon, createTranslator, cx, Empty, Figure, formatChips, Stat } from '@jc/ui';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { Choice } from './Rooms';

const DAY = 86_400_000;
const POS = 'text-[#9fd8b6]';
const NEG = 'text-[#f0a0a2]';

function signed(n: number) {
  return `${n > 0 ? '+' : ''}${formatChips(n)}`;
}

/**
 * Below these samples a figure carries a warning: a share over fewer than 30 hands, BB/100 over fewer than 1,000. A
 * guide for reading the figure, not a confidence interval.
 */
export const SMALL_RATIO = 30;
export const SMALL_BB100 = 1000;

/** The position's code as shown: the early seats are named after their first, UTG. */
export const posCode = (p: string) => (p === 'EP' ? 'UTG' : p);

function signedBb(n: number) {
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** A share in percent, or a dash while there is nothing to measure. */
export function pct(n: number, of: number) {
  return of > 0 ? `${Math.round((n / of) * 1000) / 10}%` : '—';
}

/** A card for a ratio: the percentage, and the hands behind it. */
export function RatioStat({ label, ratio, hint, testid }: { label: string; ratio: StatRatio; hint: string; testid: string }) {
  const { t, locale } = useI18n();
  return (
    <div data-testid={testid}>
      <Stat
        label={label}
        value={pct(ratio.n, ratio.of)}
        sub={
          <>
            <span className="block">{t('me.ratioOf', { n: formatChips(ratio.n), of: formatChips(ratio.of) })}</span>
            {/* On a phone the card keeps the figure, its hands and the warning; the definitions below say what it counts. */}
            <span className="hidden sm:block">{hint}</span>
            {ratio.of > 0 && ratio.of < SMALL_RATIO && (
              <span className="block text-gold-300" data-testid={`${testid}-small`}>
                {more(locale)('small', { n: formatChips(SMALL_RATIO) })}
              </span>
            )}
          </>
        }
      />
    </div>
  );
}

export function PositionTable({ positions }: { positions: PositionStatsDto[] }) {
  const { t } = useI18n();
  return (
    <div className="overflow-hidden rounded-xl border border-white/5 bg-ink-850/80" data-testid="stats-positions">
      <div className="px-3 pt-3 text-[11px] font-semibold tracking-[0.04em] text-ink-400 sm:px-4">{t('me.positions')}</div>
      {/* On a phone the columns stand 12px apart, as far as from the box's edges: with digits 0.6em wide (a phone's own
          monospace font) and "Position" over the first column, the English table had 0.2px to spare at 360px. */}
      <table className="mt-1 w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-[11px] text-ink-400">
            <th className="py-1.5 pl-3 pr-1.5 font-medium sm:px-4">{t('me.position')}</th>
            <th className="px-1.5 py-1.5 text-right font-medium sm:px-2">{t('me.posHands')}</th>
            <th className="px-1.5 py-1.5 text-right font-medium sm:px-2">VPIP</th>
            <th className="px-1.5 py-1.5 text-right font-medium sm:px-2">PFR</th>
            <th className="py-1.5 pl-1.5 pr-3 text-right font-medium sm:px-4">{t('me.posNet')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {positions.map((p) => (
            <tr key={p.position} data-testid={`stats-pos-${p.position}`}>
              <td className="py-2 pl-3 pr-1.5 sm:px-4">
                <span className="font-mono font-semibold text-ivory">{posCode(p.position)}</span>
                <span className="ml-2 text-xs text-ink-400 max-sm:hidden">{t(`me.pos.${p.position}` as MsgKey)}</span>
              </td>
              {/* Both counts may wrap between digit groups, and the cells sit closer on a phone: a nine-digit result keeps its column. */}
              <td className="px-1.5 py-2 text-right font-mono sm:px-2">
                <Figure>{formatChips(p.hands)}</Figure>
              </td>
              <td className="px-1.5 py-2 text-right font-mono sm:px-2">{pct(p.vpip, p.hands)}</td>
              <td className="px-1.5 py-2 text-right font-mono sm:px-2">{pct(p.pfr, p.hands)}</td>
              <td className={cx('py-2 pl-1.5 pr-3 text-right font-mono sm:px-4', p.hands > 0 && (p.net >= 0 ? POS : NEG))}>{p.hands > 0 ? <Figure>{signed(p.net)}</Figure> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The page's later figures keep their words here, in the page's own chunk, rather than in the dictionaries every page
// loads first.
const ko = {
  threeBet: '3-Bet',
  threeBetHint: '오픈 레이즈를 받고 다시 레이즈한 핸드',
  foldTo3Bet: '3-Bet에 폴드',
  foldTo3BetHint: '내 오픈이 3-Bet을 받고 폴드한 핸드',
  cbet: 'C-Bet',
  cbetHint: '프리플롭 레이저로 플롭에서 먼저 베팅한 핸드',
  foldToCbet: 'C-Bet에 폴드',
  foldToCbetHint: '상대의 C-Bet을 받고 폴드한 핸드',
  af: 'AF',
  afSub: '플롭 이후 베팅·레이즈 {bets} / 콜 {calls}',
  bb100: 'BB/100',
  bb100Sub: '100핸드당 딴 빅블라인드 · {n}핸드',
  counted: '아래 수치는 이 통계가 생긴 뒤 기록된 {n}핸드에서 셉니다.',
  'defs.detail':
    '3-Bet·C-Bet·AF·BB/100: 봇이 상대를 읽을 때 쓰는 엔진의 셈을 그대로 씁니다. 각 비율의 분모는 그럴 기회가 있었던 핸드입니다(레이즈할 칩이 있었을 때만 3-Bet 기회). 이 통계가 생기기 전에 기록된 핸드는 들어가지 않으며, 기회가 없었으면 0%가 아니라 —로 보입니다.',
  'defs.af': 'AF: 플롭 이후 베팅과 레이즈 수를 콜 수로 나눈 값입니다. 콜이 없으면 —입니다. BB/100: 순손익을 그 핸드의 빅블라인드로 나눠 더하고 100핸드당으로 바꾼 값입니다.',
  'defs.period':
    '기간: 최근 7·30·90일은 오늘을 포함해 이 기기의 시간대로 자른 날짜로 셉니다. 전체는 기록된 모든 핸드입니다. 맨 위 요약(플레이한 핸드·승률·BB/100)은 늘 전체 기간이고, 기간을 바꾸면 이 기록 탭의 통계·포지션·추이가 함께 바뀝니다.',
  'defs.sample':
    '표본: 비율은 분모가 30핸드 미만일 때, BB/100은 1,000핸드 미만일 때 경고를 붙입니다. 그보다 적은 표본에서는 몇 핸드로도 값이 크게 바뀌기 때문입니다. 이 기준은 읽기 위한 안내이며 신뢰구간이 아닙니다.',
  small: '표본 {n}핸드 미만 · 아직 참고용',
  smallBb100: '표본 {n}핸드 미만 · BB/100은 아직 크게 흔들립니다',
  period: '기간',
  periodAll: '전체',
  posBb100: '포지션별 BB/100',
  posBb100Note: '막대는 100핸드당 딴 빅블라인드, 옆 숫자는 그 표본입니다. {n}핸드 미만은 흐리게 보입니다.',
  handsN: '{n}핸드',
  metric: '추이 항목',
  'metric.net': '순손익',
  'metric.hands': '핸드 수',
  'metric.bb100': 'BB/100',
  'metric.vpip': 'VPIP·PFR',
  'metric.showdown': '쇼다운',
  'legend.hands': '막대 일별 핸드 수',
  'legend.bb100': '선 기간 첫날부터 누적',
  trendAll: '전체 기간에서도 추이는 최근 90일까지 보입니다.',
  'sel.hands': '{day} · {hands}핸드',
  'sel.bb100': '{day} · 누적 BB/100 {v} · {n}핸드',
  'sel.vpip': '{day} · 누적 VPIP {a} · PFR {b} · {n}핸드',
  'sel.showdown': '{day} · 누적 쇼다운 진입률 {a} · 쇼다운 승률 {b} · 플롭 {n}핸드',
  'chart.hands': '일별 핸드 수 막대, 기간 합계 {n}핸드',
  'chart.bb100': '기간 첫날부터 누적한 BB/100 선, 마지막 날 {v}',
  'chart.vpip': '기간 첫날부터 누적한 VPIP와 PFR 선, 마지막 날 VPIP {a} · PFR {b}',
  'chart.showdown': '기간 첫날부터 누적한 쇼다운 진입률과 쇼다운 승률 선, 마지막 날 {a} · {b}',
};
const en: Record<keyof typeof ko, string> = {
  threeBet: '3-Bet',
  threeBetHint: 'Re-raised an open raise',
  foldTo3Bet: 'Fold to 3-Bet',
  foldTo3BetHint: 'Folded your open to a 3-bet',
  cbet: 'C-Bet',
  cbetHint: 'Bet the flop first as the preflop raiser',
  foldToCbet: 'Fold to C-Bet',
  foldToCbetHint: 'Folded to a c-bet',
  af: 'AF',
  afSub: 'After the flop: bets and raises {bets} / calls {calls}',
  bb100: 'BB/100',
  bb100Sub: 'Big blinds won per 100 hands · {n} hands',
  counted: 'These count the {n} hands recorded since they were added.',
  'defs.detail':
    'The 3-bet, c-bet, AF and BB/100 figures use the engine’s own counting, the one the bots read opponents with. Each ratio is over the hands where you had the chance (a 3-bet chance only with chips to raise). Hands recorded before these figures existed are not in them, and no chance shows as —, not 0%.',
  'defs.af': 'AF: bets and raises after the flop divided by calls; — without a call. BB/100: net chips over each hand’s big blind, summed and scaled to 100 hands.',
  'defs.period':
    'Period: the last 7, 30 or 90 days count today, cut at this device’s time zone; All is every hand recorded. The summary at the top (hands, win rate, BB/100) is always all of it; changing the period changes this tab’s figures, positions and trend together.',
  'defs.sample':
    'Sample: a ratio over fewer than 30 hands and BB/100 over fewer than 1,000 carry a warning, since a few hands still move them a lot. The thresholds are a reading guide, not a confidence interval.',
  small: 'Under {n} hands · indicative only',
  smallBb100: 'Under {n} hands · BB/100 still swings widely',
  period: 'Period',
  periodAll: 'All',
  posBb100: 'BB/100 by position',
  posBb100Note: 'Bars are big blinds won per 100 hands, the number beside them the sample. Under {n} hands they are faint.',
  handsN: '{n} hands',
  metric: 'Trend figure',
  'metric.net': 'Net',
  'metric.hands': 'Hands',
  'metric.bb100': 'BB/100',
  'metric.vpip': 'VPIP·PFR',
  'metric.showdown': 'Showdown',
  'legend.hands': 'Bars hands per day',
  'legend.bb100': 'Line running from the first day',
  trendAll: 'With All chosen the trend still shows the last 90 days.',
  'sel.hands': '{day} · hands {hands}',
  'sel.bb100': '{day} · running BB/100 {v} · {n} hands',
  'sel.vpip': '{day} · running VPIP {a} · PFR {b} · {n} hands',
  'sel.showdown': '{day} · running went to showdown {a} · won at showdown {b} · {n} flops',
  'chart.hands': 'Hands per day as bars, {n} over the period',
  'chart.bb100': 'BB/100 running from the period’s first day as a line, {v} on the last day',
  'chart.vpip': 'VPIP and PFR running from the period’s first day as lines, VPIP {a} · PFR {b} on the last day',
  'chart.showdown': 'Went to showdown and won at showdown running from the period’s first day as lines, {a} · {b} on the last day',
};
const more = createTranslator({ ko, en });

/** Aggression factor to one decimal, or a dash without a call to divide by. */
export function aggressionFactor(a: StatsDto['aggression']) {
  return a.calls > 0 ? (Math.round((a.bets / a.calls) * 10) / 10).toFixed(1) : '—';
}

/** The figures counted with the engine's opponent counters: 3-bet, c-bet and their folds, AF and BB/100. */
export function MoreStats({ st }: { st: StatsDto }) {
  const { locale } = useI18n();
  const m = more(locale);
  return (
    <>
      <div className="col-span-2 text-xs text-ink-400 md:col-span-3" data-testid="stats-counted">
        {m('counted', { n: formatChips(st.counted) })}
      </div>
      <RatioStat label={m('threeBet')} ratio={st.threeBet} hint={m('threeBetHint')} testid="stats-3bet" />
      <RatioStat label={m('foldTo3Bet')} ratio={st.foldTo3Bet} hint={m('foldTo3BetHint')} testid="stats-fold-3bet" />
      <RatioStat label={m('cbet')} ratio={st.cbet} hint={m('cbetHint')} testid="stats-cbet" />
      <RatioStat label={m('foldToCbet')} ratio={st.foldToCbet} hint={m('foldToCbetHint')} testid="stats-fold-cbet" />
      <div data-testid="stats-af">
        <Stat label={m('af')} value={aggressionFactor(st.aggression)} sub={m('afSub', { bets: formatChips(st.aggression.bets), calls: formatChips(st.aggression.calls) })} />
      </div>
      <div data-testid="stats-bb100">
        <Stat
          label={m('bb100')}
          value={st.bb100 === null ? '—' : <span className={st.bb100 >= 0 ? POS : NEG}>{`${st.bb100 > 0 ? '+' : ''}${st.bb100.toFixed(2)}`}</span>}
          sub={m('bb100Sub', { n: formatChips(st.counted) })}
        />
      </div>
    </>
  );
}

const DEFINITIONS = ['scope', 'won', 'vpip', 'pfr', 'showdown', 'position', 'pot', 'missing', 'trend'] as const;

/** How every figure is counted, folded away by default. */
export function StatDefinitions() {
  const { t, locale } = useI18n();
  return (
    <details className="group rounded-xl border border-white/5 bg-ink-850/80 px-4 py-3" data-testid="stats-definitions">
      <summary className="jc-tap flex min-h-8 cursor-pointer list-none items-center justify-between text-sm font-semibold text-ink-300 hover:text-ivory">
        {t('me.defs')}
        <ChevronDownIcon className="size-4 text-ink-400 transition group-open:rotate-180" />
      </summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-ink-300">
        {DEFINITIONS.map((k) => (
          <li key={k}>{t(`me.defs.${k}`)}</li>
        ))}
        <li>{more(locale)('defs.detail')}</li>
        <li>{more(locale)('defs.af')}</li>
        <li>{more(locale)('defs.period')}</li>
        <li>{more(locale)('defs.sample')}</li>
      </ul>
    </details>
  );
}

export type StatsPeriod = TrendDays | 'all';
export const STATS_PERIODS: readonly StatsPeriod[] = [...TREND_DAYS, 'all'];

/** Minutes east of UTC, the way the server cuts days. */
const zone = () => -new Date().getTimezoneOffset();

/**
 * The figures of a period, from the one statistics route: all of them are the ones the page already read; a shorter
 * period is read again with its days (`?days=&tz=`), by the same counting.
 */
export function usePeriodStats(all: StatsDto | null, period: StatsPeriod): { data: StatsDto | null; failed: boolean } {
  const [data, setData] = useState<StatsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const tz = zone();
  useEffect(() => {
    if (period === 'all') return;
    let live = true;
    setFailed(false);
    api<StatsDto>(`/api/me/stats?days=${period}&tz=${tz}`)
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [period, tz]);
  if (period === 'all') return { data: all, failed: false };
  return { data: data && data.days === period ? data : null, failed };
}

/** The period every figure of the statistics panel is counted over. */
export function StatsPeriodChoice({ value, onChange }: { value: StatsPeriod; onChange: (p: StatsPeriod) => void }) {
  const { t, locale } = useI18n();
  const m = more(locale);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="stats-period">
      <span className="text-[11px] font-semibold tracking-[0.04em] text-ink-400">{m('period')}</span>
      <Choice label={m('period')} value={value} options={STATS_PERIODS} onChange={onChange} render={(d) => (d === 'all' ? m('periodAll') : t('me.trendDays', { n: d }))} testid="stats-days" />
    </div>
  );
}

/**
 * BB/100 by position, each with the hands it is counted over: a bar either side of zero. Below SMALL_BB100 hands a
 * position's bar is faint and its figure grey, and a position with none shows a dash.
 */
export function PositionBb100({ positions }: { positions: PositionStatsDto[] }) {
  const { locale } = useI18n();
  const m = more(locale);
  const top = Math.max(0, ...positions.map((p) => Math.abs(p.bb100 ?? 0)));
  return (
    <div className="rounded-xl border border-white/5 bg-ink-850/80 px-3 py-3 sm:px-4" data-testid="stats-pos-bb100">
      <div className="text-[11px] font-semibold tracking-[0.04em] text-ink-400">{m('posBb100')}</div>
      {/* One set of columns for every row (a subgrid), so the zero lines stand one above another. */}
      <ul className="mt-2 grid grid-cols-[2.75rem_minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 text-sm tabular-nums sm:gap-x-3">
        {positions.map((p) => {
          const small = p.counted < SMALL_BB100;
          const w = p.bb100 === null || top === 0 ? 0 : (Math.abs(p.bb100) / top) * 50;
          return (
            <li key={p.position} className="col-span-3 grid grid-cols-subgrid items-center" data-testid={`stats-pos-bb100-${p.position}`} data-small={small}>
              <span className="font-mono font-semibold text-ivory">{posCode(p.position)}</span>
              <span className="relative h-3" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px bg-white/15" />
                {w > 0 && (
                  <span
                    className="absolute inset-y-0 rounded-sm"
                    style={{ [p.bb100! >= 0 ? 'left' : 'right']: '50%', width: `${w}%`, background: p.bb100! >= 0 ? '#9fd8b6' : '#f0a0a2', opacity: small ? 0.35 : 0.8 }}
                  />
                )}
              </span>
              <span className="flex items-baseline justify-end gap-1.5 text-right">
                <span className={cx('font-mono', p.bb100 === null || small ? 'text-ink-300' : 'text-ivory')}>{p.bb100 === null ? '—' : signedBb(p.bb100)}</span>
                <span className="text-[11px] text-ink-400">{m('handsN', { n: formatChips(p.counted) })}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">{m('posBb100Note', { n: formatChips(SMALL_BB100) })}</p>
    </div>
  );
}

type Metric = 'net' | 'hands' | 'bb100' | 'vpip' | 'showdown';
const METRICS: readonly Metric[] = ['net', 'hands', 'bb100', 'vpip', 'showdown'];
/** The two lines of a ratio chart (validated together on the dark surface): the second also dashed. */
const LINE_A = '#b48e22';
const LINE_B = '#6f8fe8';

interface Day {
  day: string;
  hands: number;
  net: number;
  total: number;
  /** Running from the period's first day: BB/100, and the ratios in percent; null before anything to measure. */
  bb100: number | null;
  counted: number;
  vpip: number | null;
  pfr: number | null;
  vpipOf: number;
  wtsd: number | null;
  wsd: number | null;
  wtsdOf: number;
}

const share = (n: number, of: number) => (of > 0 ? (n / of) * 100 : null);
const pctText = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10) / 10}%`);

/**
 * The period's days: net chips per day (a bar a day, the running total as a line), hands per day, or the running BB/100,
 * VPIP and PFR, or showdown shares from the period's first day. All of the period reads its last 90 days.
 */
export function StatsTrend({ period }: { period: StatsPeriod }) {
  const { t, locale } = useI18n();
  const m = more(locale);
  const days: TrendDays = period === 'all' ? 90 : period;
  const [metric, setMetric] = useState<Metric>('net');
  const [data, setData] = useState<StatsTrendDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const tz = zone();

  useEffect(() => {
    let live = true;
    setFailed(false);
    setSel(null);
    api<StatsTrendDto>(`/api/me/stats/trend?days=${days}&tz=${tz}`)
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [days, tz]);

  const shown = data && data.days === days ? data : null;
  // Every day of the period, oldest first, the days without hands at zero.
  const today = Math.floor((Date.now() + tz * 60_000) / DAY);
  const byDay = new Map(shown?.points.map((p) => [p.day, p]));
  const run = { net: 0, counted: 0, bb: 0, vn: 0, vof: 0, pn: 0, pof: 0, wn: 0, wof: 0, sn: 0, sof: 0 };
  const series: Day[] = Array.from({ length: days }, (_, i) => {
    const day = new Date((today - days + 1 + i) * DAY).toISOString().slice(0, 10);
    const p = byDay.get(day);
    if (p) {
      run.net += p.net;
      run.counted += p.counted;
      run.bb += p.bbWon;
      run.vn += p.vpip.n;
      run.vof += p.vpip.of;
      run.pn += p.pfr.n;
      run.pof += p.pfr.of;
      run.wn += p.wtsd.n;
      run.wof += p.wtsd.of;
      run.sn += p.wsd.n;
      run.sof += p.wsd.of;
    }
    return {
      day,
      hands: p?.hands ?? 0,
      net: p?.net ?? 0,
      total: run.net,
      bb100: run.counted > 0 ? (run.bb / run.counted) * 100 : null,
      counted: run.counted,
      vpip: share(run.vn, run.vof),
      pfr: share(run.pn, run.pof),
      vpipOf: run.vof,
      wtsd: share(run.wn, run.wof),
      wsd: share(run.sn, run.sof),
      wtsdOf: run.wof,
    };
  });
  const hands = series.reduce((a, s) => a + s.hands, 0);
  const last = series[series.length - 1]!;
  const s = sel === null ? null : series[sel]!;
  const selected =
    s &&
    (metric === 'net'
      ? t('me.trendDay', { day: s.day, hands: formatChips(s.hands), net: signed(s.net), total: signed(s.total) })
      : metric === 'hands'
        ? m('sel.hands', { day: s.day, hands: formatChips(s.hands) })
        : metric === 'bb100'
          ? m('sel.bb100', { day: s.day, v: s.bb100 === null ? '—' : signedBb(s.bb100), n: formatChips(s.counted) })
          : metric === 'vpip'
            ? m('sel.vpip', { day: s.day, a: pctText(s.vpip), b: pctText(s.pfr), n: formatChips(s.vpipOf) })
            : m('sel.showdown', { day: s.day, a: pctText(s.wtsd), b: pctText(s.wsd), n: formatChips(s.wtsdOf) }));
  // The sample behind the running figure at the period's end.
  const smallNote =
    metric === 'bb100' && last.counted > 0 && last.counted < SMALL_BB100
      ? m('smallBb100', { n: formatChips(SMALL_BB100) })
      : (metric === 'vpip' && last.vpipOf > 0 && last.vpipOf < SMALL_RATIO) || (metric === 'showdown' && last.wtsdOf > 0 && last.wtsdOf < SMALL_RATIO)
        ? m('small', { n: formatChips(SMALL_RATIO) })
        : null;

  return (
    <div className="rounded-xl border border-white/5 bg-ink-850/80 px-4 py-3" data-testid="stats-trend" data-metric={metric}>
      <div className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold tracking-[0.04em] text-ink-400">{t('me.trend')}</div>
        <Choice label={m('metric')} value={metric} options={METRICS} onChange={(v) => setMetric(v)} render={(v) => m(`metric.${v}`)} testid="stats-trend-metric" />
      </div>
      {period === 'all' && (
        <div className="mt-2 text-xs text-ink-400" data-testid="stats-trend-all">
          {m('trendAll')}
        </div>
      )}
      {failed ? (
        <div className="mt-3 text-sm text-ink-400">{t('common.error')}</div>
      ) : !shown ? (
        <div className="mt-3 h-36 animate-pulse rounded-lg bg-white/5 sm:h-40" />
      ) : hands === 0 ? (
        <div className="mt-3">
          <Empty>{t('me.trendEmpty')}</Empty>
        </div>
      ) : (
        <>
          <div className="mt-2 text-sm text-ink-300" data-testid="stats-trend-summary">
            {t('me.trendSummary', { hands: formatChips(hands), net: signed(last.total) })}
          </div>
          <TrendChart series={series} metric={metric} sel={sel} onSelect={setSel} />
          <div className="mt-1 flex justify-between gap-2 text-[11px] text-ink-400 tabular-nums">
            <span className="shrink-0 whitespace-nowrap" data-testid="stats-trend-first">{series[0]!.day}</span>
            <TrendLegend metric={metric} />
            <span className="shrink-0 whitespace-nowrap" data-testid="stats-trend-last">{last.day}</span>
          </div>
          {smallNote && (
            <div className="mt-1 text-xs text-gold-300" data-testid="stats-trend-small">
              {smallNote}
            </div>
          )}
          <div className="mt-2 min-h-5 text-xs text-ink-300 tabular-nums" aria-live="polite" data-testid="stats-trend-selected">
            {selected}
          </div>
        </>
      )}
    </div>
  );
}

function TrendLegend({ metric }: { metric: Metric }) {
  const { t, locale } = useI18n();
  const m = more(locale);
  if (metric === 'net') return <span className="text-center">{t('me.trendLegend')}</span>;
  if (metric === 'hands' || metric === 'bb100') return <span className="text-center">{m(`legend.${metric}`)}</span>;
  const [a, b] = metric === 'vpip' ? ['VPIP', 'PFR'] : [t('me.wtsd'), t('me.wsd')];
  return (
    <span className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5" data-testid="stats-trend-legend">
      <span className="flex items-center gap-1">
        <svg width="14" height="4" aria-hidden>
          <line x1="0" x2="14" y1="2" y2="2" stroke={LINE_A} strokeWidth="2" />
        </svg>
        {a}
      </span>
      <span className="flex items-center gap-1">
        <svg width="14" height="4" aria-hidden>
          <line x1="0" x2="14" y1="2" y2="2" stroke={LINE_B} strokeWidth="2" strokeDasharray="4 2" />
        </svg>
        {b}
      </span>
    </span>
  );
}

/** A line through the days that have a value, broken over the days before the first. */
function pathOf(values: (number | null)[], x: (i: number) => number, y: (v: number) => number) {
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    open = true;
  });
  return d.trim();
}

function TrendChart({ series, metric, sel, onSelect }: { series: Day[]; metric: Metric; sel: number | null; onSelect: (i: number) => void }) {
  const { t, locale } = useI18n();
  const m = more(locale);
  const W = 600;
  const H = 180;
  const PAD = 8;
  const ratio = metric === 'vpip' || metric === 'showdown';
  const lines: (number | null)[][] =
    metric === 'net' ? [series.map((s) => s.total)] : metric === 'bb100' ? [series.map((s) => s.bb100)] : metric === 'vpip' ? [series.map((s) => s.vpip), series.map((s) => s.pfr)] : metric === 'showdown' ? [series.map((s) => s.wtsd), series.map((s) => s.wsd)] : [];
  const bars = metric === 'net' ? series.map((s) => s.net) : metric === 'hands' ? series.map((s) => s.hands) : [];
  const values = [...bars, ...lines.flat().filter((v): v is number => v !== null)];
  // Shares run 0 to 100; otherwise zero is always in view, and all even puts it in the middle rather than along an edge.
  const flat = values.every((v) => v === 0);
  const hi = ratio ? 100 : flat ? 1 : Math.max(0, ...values);
  const lo = ratio ? 0 : flat ? -1 : Math.min(0, ...values);
  const span = hi - lo;
  const y = (v: number) => PAD + ((hi - v) / span) * (H - 2 * PAD);
  const slot = W / series.length;
  const bar = Math.max(1, slot * 0.7);
  const x = (i: number) => i * slot + slot / 2;
  const last = series[series.length - 1]!;
  const label =
    metric === 'net'
      ? t('me.trendChart', { net: signed(last.total) })
      : metric === 'hands'
        ? m('chart.hands', { n: formatChips(series.reduce((a, s) => a + s.hands, 0)) })
        : metric === 'bb100'
          ? m('chart.bb100', { v: last.bb100 === null ? '—' : signedBb(last.bb100) })
          : metric === 'vpip'
            ? m('chart.vpip', { a: pctText(last.vpip), b: pctText(last.pfr) })
            : m('chart.showdown', { a: pctText(last.wtsd), b: pctText(last.wsd) });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-36 w-full touch-manipulation sm:h-44" preserveAspectRatio="none" role="img" aria-label={label} data-testid="stats-trend-chart">
      {ratio ? (
        [0, 50, 100].map((g) => <line key={g} x1={0} x2={W} y1={y(g)} y2={y(g)} stroke="currentColor" className="text-white/10" strokeWidth={1} vectorEffect="non-scaling-stroke" />)
      ) : (
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-white/15" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )}
      {series.map((s, i) => (
        <g key={s.day} onClick={() => onSelect(i)} className="cursor-pointer">
          <rect x={i * slot} y={0} width={slot} height={H} fill={sel === i ? 'rgba(255,255,255,0.06)' : 'transparent'} />
          {metric === 'net' &&
            (s.net !== 0 ? (
              <rect
                x={x(i) - bar / 2}
                y={Math.min(y(s.net), y(0))}
                width={bar}
                height={Math.max(1, Math.abs(y(s.net) - y(0)))}
                fill={s.net > 0 ? '#9fd8b6' : '#f0a0a2'}
                opacity={0.75}
                data-testid="stats-trend-bar"
              />
            ) : (
              // Played but broke even: a grey mark on the zero line, so the day still shows.
              s.hands > 0 && <rect x={x(i) - bar / 2} y={y(0) - 3} width={bar} height={6} fill="currentColor" className="text-ink-300" opacity={0.6} data-testid="stats-trend-even" />
            ))}
          {metric === 'hands' && s.hands > 0 && <rect x={x(i) - bar / 2} y={y(s.hands)} width={bar} height={Math.max(1, y(0) - y(s.hands))} fill={LINE_A} opacity={0.85} data-testid="stats-trend-bar" />}
          <title>{s.day}</title>
        </g>
      ))}
      {lines.map((v, k) => {
        const d = pathOf(v, x, y);
        // A single day with a value is a dot rather than a line of no length (a round cap, so the stretched chart keeps it round).
        const only = v.filter((n) => n !== null).length === 1 ? v.findIndex((n) => n !== null) : -1;
        const color = metric === 'net' ? 'var(--color-gold-300)' : k === 0 ? LINE_A : LINE_B;
        // The lines let a tap through to the day beneath (on a phone a 90-day slot is narrower than the stroke is near).
        return (
          <g key={k} data-testid="stats-trend-line" pointerEvents="none">
            {d && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray={k === 1 ? '6 3' : undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
            {only >= 0 && metric !== 'net' && <path d={`M${x(only).toFixed(1)},${y(v[only]!).toFixed(1)} h0`} stroke={color} strokeWidth={8} strokeLinecap="round" vectorEffect="non-scaling-stroke" data-testid="stats-trend-dot" />}
          </g>
        );
      })}
    </svg>
  );
}