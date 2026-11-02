import { TREND_DAYS, type PositionStatsDto, type StatRatio, type StatsDto, type StatsTrendDto } from '@jc/types';
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

/** A share in percent, or a dash while there is nothing to measure. */
export function pct(n: number, of: number) {
  return of > 0 ? `${Math.round((n / of) * 1000) / 10}%` : '—';
}

/** A card for a ratio: the percentage, and the hands behind it. */
export function RatioStat({ label, ratio, hint, testid }: { label: string; ratio: StatRatio; hint: string; testid: string }) {
  const { t } = useI18n();
  return (
    <div data-testid={testid}>
      <Stat
        label={label}
        value={pct(ratio.n, ratio.of)}
        sub={
          <>
            <span className="block">{t('me.ratioOf', { n: formatChips(ratio.n), of: formatChips(ratio.of) })}</span>
            <span className="block">{hint}</span>
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
                <span className="font-mono font-semibold text-ivory">{p.position}</span>
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
      </ul>
    </details>
  );
}

type Days = (typeof TREND_DAYS)[number];

/** Net chips per day over the chosen period: a bar a day, and the running total as a line. */
export function StatsTrend() {
  const { t } = useI18n();
  const [days, setDays] = useState<Days>(30);
  const [data, setData] = useState<StatsTrendDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  // Minutes east of UTC, the way the server cuts days.
  const tz = -new Date().getTimezoneOffset();

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
  let run = 0;
  const series = Array.from({ length: days }, (_, i) => {
    const day = new Date((today - days + 1 + i) * DAY).toISOString().slice(0, 10);
    const p = byDay.get(day);
    run += p?.net ?? 0;
    return { day, hands: p?.hands ?? 0, net: p?.net ?? 0, total: run };
  });
  const hands = series.reduce((a, s) => a + s.hands, 0);

  return (
    <div className="rounded-xl border border-white/5 bg-ink-850/80 px-4 py-3" data-testid="stats-trend">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold tracking-[0.04em] text-ink-400">{t('me.trend')}</div>
        <Choice label={t('me.trend')} value={days} options={TREND_DAYS} onChange={setDays} render={(d) => t('me.trendDays', { n: d })} testid="stats-days" />
      </div>
      {failed ? (
        <div className="mt-3 text-sm text-ink-400">{t('common.error')}</div>
      ) : !shown ? (
        <div className="mt-3 h-40 animate-pulse rounded-lg bg-white/5" />
      ) : hands === 0 ? (
        <div className="mt-3">
          <Empty>{t('me.trendEmpty')}</Empty>
        </div>
      ) : (
        <>
          <div className="mt-2 text-sm text-ink-300" data-testid="stats-trend-summary">
            {t('me.trendSummary', { hands: formatChips(hands), net: signed(run) })}
          </div>
          <TrendChart series={series} sel={sel} onSelect={setSel} />
          <div className="mt-1 flex justify-between text-[11px] text-ink-400 tabular-nums">
            <span>{series[0]!.day}</span>
            <span>{t('me.trendLegend')}</span>
            <span>{series[series.length - 1]!.day}</span>
          </div>
          <div className="mt-2 min-h-5 text-xs text-ink-300 tabular-nums" aria-live="polite" data-testid="stats-trend-selected">
            {sel !== null &&
              t('me.trendDay', { day: series[sel]!.day, hands: formatChips(series[sel]!.hands), net: signed(series[sel]!.net), total: signed(series[sel]!.total) })}
          </div>
        </>
      )}
    </div>
  );
}

function TrendChart({ series, sel, onSelect }: { series: { day: string; hands: number; net: number; total: number }[]; sel: number | null; onSelect: (i: number) => void }) {
  const { t } = useI18n();
  const W = 600;
  const H = 180;
  const PAD = 8;
  const values = series.flatMap((s) => [s.net, s.total]);
  // All even: zero sits in the middle rather than along the top edge.
  const flat = values.every((v) => v === 0);
  const hi = flat ? 1 : Math.max(0, ...values);
  const lo = flat ? -1 : Math.min(0, ...values);
  const span = hi - lo;
  const y = (v: number) => PAD + ((hi - v) / span) * (H - 2 * PAD);
  const slot = W / series.length;
  const bar = Math.max(1, slot * 0.7);
  const x = (i: number) => i * slot + slot / 2;
  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.total).toFixed(1)}`).join(' ');
  const last = series[series.length - 1]!;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-2 h-44 w-full touch-manipulation"
      preserveAspectRatio="none"
      role="img"
      aria-label={t('me.trendChart', { net: signed(last.total) })}
      data-testid="stats-trend-chart"
    >
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-white/15" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {series.map((s, i) => (
        <g key={s.day} onClick={() => onSelect(i)} className="cursor-pointer">
          <rect x={i * slot} y={0} width={slot} height={H} fill={sel === i ? 'rgba(255,255,255,0.06)' : 'transparent'} />
          {s.net !== 0 ? (
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
          )}
          <title>{`${s.day} · ${signed(s.net)}`}</title>
        </g>
      ))}
      <path d={line} fill="none" stroke="var(--color-gold-300)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" data-testid="stats-trend-line" />
    </svg>
  );
}
