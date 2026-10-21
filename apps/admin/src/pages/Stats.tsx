/**
 * Operations trends by day, week and month (GET /api/admin/stats): members, first games, play, concurrency, reports
 * and the Academy, from numbers the server rolls up once a day. Aggregates only: no member is named here. The charts
 * are plain bars (no chart library), each with a text summary for screen readers and the table below as the source.
 */
import { Badge, Button, Empty, Panel, Stat } from '@jc/ui';
import { Link, useSearchParams } from 'react-router';
import { useT, type Key } from '../i18n';
import { useData } from '../lib';
import { LoadError } from '../ui';
import { Table } from './Console';
import { dur } from './Reports';

type Unit = 'day' | 'week' | 'month';
type RoomPlay = { hands: number; tablesAvg: number | null; seats: number; seatMs: number };
type AcademyKey = 'ac_lesson_start' | 'ac_lesson_done' | 'ac_scenario_start' | 'ac_scenario_done' | 'ac_answer' | 'ac_correct';
type HandNoteKey = 'hn_bookmark' | 'hn_tag' | 'hn_memo' | 'hn_fail_conflict' | 'hn_fail_invalid' | 'hn_fail_notfound' | 'hn_fail_limit' | 'hn_fail_error';
type TimeBankKey = 'tb_use' | 'tb_sec' | 'tb_empty' | 'tb_expired' | 'tb_late' | 'tb_recover';
/** `tb_timeout` is absent from an API older than it. */
type TimeBankTotals = Record<TimeBankKey, number> & { tb_timeout?: number };
type SettingsKey = 'ss_save' | 'ss_legacy' | 'ss_conflict' | 'ss_stale' | 'ss_epoch' | 'ss_fail_invalid' | 'ss_fail_limit' | 'ss_fail_busy' | 'ss_fail_error' | 'ss_load_fail' | 'ss_client_fail' | 'ss_reset' | 'ss_restore';
interface Period {
  from: string;
  to: string;
  days: number;
  complete: boolean;
  members: { signups: number; dauAvg: number | null; returningAvg: number | null; wau: number | null; mau: number | null; partial: { dau: boolean; wau: boolean; mau: boolean }; activityDays: number };
  activation: { cohort: number; play1d: number; play7d: number; cohortDays: number };
  play: { hands: number; handsPerDay: number | null; tablesAvg: number | null; seats: number; avgSeatMs: number | null; peak: number | null; official: RoomPlay; member: RoomPlay; bots?: { hands: number; tablesAvg: number | null } };
  reports: { created: number; handled: number; avgHandleMs: number | null };
  academy: Record<AcademyKey, number>;
  handNotes: Record<HandNoteKey, number>;
  /** Account settings sync (absent from an older API). */
  settings?: Record<SettingsKey, number>;
  /** Time bank use and timer problems (absent from an older API). */
  timeBank?: TimeBankTotals;
}
interface OpsStats {
  unit: Unit;
  n: number;
  from: string;
  to: string;
  rolledFrom: string | null;
  rolledThrough: string | null;
  activitySince: string | null;
  retentionDays: number;
  periods: Period[];
  total: Period;
  hourly: { avg: number | null; max: number | null }[];
  rolled: { days: number; behind: number } | { failed: true } | null;
  /** Hand notes kept now, counted when the page loads (never whose or what). */
  handNotesNow: { members: number; bookmarked: number; tagged: number; memos: number };
}

const UNITS: [Unit, Key][] = [
  ['day', 'osDay'],
  ['week', 'osWeek'],
  ['month', 'osMonth'],
];
const td = 'px-2 py-1.5';
const COLUMNS: Key[] = ['osColPeriod', 'osColDays', 'osColSignups', 'osColDau', 'osColWau', 'osColMau', 'osColPlay', 'osColHands', 'osColTables', 'osColSeat', 'osColPeak', 'osColReports', 'osColHandle'];

export function StatsPage() {
  const { t, locale } = useT();
  const [params, setParams] = useSearchParams();
  const unit: Unit = UNITS.some(([u]) => u === params.get('unit')) ? (params.get('unit') as Unit) : 'day';
  const setUnit = (u: Unit) => setParams(u === 'day' ? {} : { unit: u });
  const { data, error, loading, reload } = useData<OpsStats>(`/api/admin/stats?unit=${unit}`);
  const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 1 }));
  const pct = (a: number, b: number) => (b ? `${num(Math.round((a / b) * 1000) / 10)}%` : '—');
  const len = (ms: number | null) => (ms == null ? '—' : dur(t, ms));
  // A month is named by its month; a day or week by its dates (a week by its Monday, cut at the last day shown).
  const label = (p: Period) => (unit === 'month' ? p.from.slice(0, 7) : unit === 'day' ? p.from : `${p.from.slice(5)} – ${p.to.slice(5)}`);

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('opsStats')}</h1>
      <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label={t('osUnit')}>
        {UNITS.map(([u, k]) => (
          <Button key={u} size="sm" variant={unit === u ? 'gold' : 'outline'} aria-pressed={unit === u} onClick={() => setUnit(u)} data-testid={`stats-${u}`}>
            {t(k)}
          </Button>
        ))}
        <Button size="sm" variant="subtle" onClick={() => void reload()} loading={loading} data-testid="stats-reload">{t('refresh')}</Button>
      </div>
    </div>
  );
  if (error) return <div className="flex flex-col gap-4">{header}<LoadError error={error} onRetry={reload} /></div>;
  if (!data || data.unit !== unit) return <div className="flex flex-col gap-4">{header}<Empty>{t('loading')}</Empty></div>;
  const d = data;
  const tot = d.total;
  const rolled = d.rolled;
  const notice = rolled && 'failed' in rolled ? (
    <p className="text-sm text-danger" role="alert" data-testid="stats-roll-failed">{t('osRollFailed')}</p>
  ) : rolled ? (
    <p className="text-xs text-ink-300" role="status" data-testid="stats-rolled">
      {t('osRolledNow', { n: rolled.days })} {rolled.behind > 0 && t('osBehind', { n: rolled.behind })}
    </p>
  ) : null;
  if (d.rolledThrough === null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {notice}
        <Empty><span data-testid="stats-empty">{t('osEmpty')}</span></Empty>
      </div>
    );
  }
  const star = (on: boolean) => (on ? <span className="text-gold-400" title={t('osPartialTip')}>*</span> : null);
  const m = tot.members;
  const share = (k: 'hands' | 'seats' | 'seatMs') => {
    const a = tot.play.official[k];
    const b = tot.play.member[k];
    return { a, b, p: a + b ? Math.round((a / (a + b)) * 100) : null };
  };
  const labels = d.periods.map(label);
  const faded = d.periods.map((p) => !p.complete);
  const ac = tot.academy;
  const hn = tot.handNotes;
  const hnFailed = hn.hn_fail_conflict + hn.hn_fail_invalid + hn.hn_fail_notfound + hn.hn_fail_limit + hn.hn_fail_error;
  const now = d.handNotesNow;
  const ss = tot.settings;
  const tb = tot.timeBank;
  return (
    <div className={`flex flex-col gap-6 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="stats-page">
      {header}
      <p className="text-xs text-ink-400" data-testid="stats-range">{t('osRange', { from: d.from, to: d.to })}</p>
      {notice}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="stats-totals">
        <Stat label={t('osActive')} value={<>{num(m.dauAvg)}{star(m.partial.dau)}</>} sub={<>{t('osActiveSub', { wau: num(m.wau), mau: num(m.mau) })}{star(m.partial.wau || m.partial.mau)}</>} />
        <Stat label={t('osNew')} value={num(m.signups)} sub={t('osNewSub', { n: num(m.returningAvg) })} />
        <Stat
          label={t('osActivation')}
          value={<span data-testid="stats-activation">{pct(tot.activation.play7d, tot.activation.cohort)}</span>}
          sub={t('osActivationSub', { d1: pct(tot.activation.play1d, tot.activation.cohort), n: num(tot.activation.cohort) })}
        />
        <Stat label={t('osHandsDay')} value={<span data-testid="stats-hands-day">{num(tot.play.handsPerDay)}</span>} sub={t('osHandsDaySub', { n: num(tot.play.hands) })} />
        <Stat label={t('osSeatLen')} value={len(tot.play.avgSeatMs)} sub={t('osSeatLenSub', { n: num(tot.play.seats) })} />
        <Stat label={t('osTables')} value={num(tot.play.tablesAvg)} sub={t('osTablesSub')} />
        <Stat label={t('osBotHands')} value={<span data-testid="stats-bot-hands">{num(tot.play.bots?.hands ?? 0)}</span>} sub={t('osBotHandsSub', { n: num(tot.play.bots?.tablesAvg ?? null) })} />
        <Stat label={t('osPeak')} value={<span data-testid="stats-peak">{num(tot.play.peak)}</span>} sub={t('osPeakSub')} />
        <Stat
          label={t('osReports')}
          value={<span data-testid="stats-reports">{num(tot.reports.created)}</span>}
          sub={t('osReportsSub', { n: num(tot.reports.handled), d: len(tot.reports.avgHandleMs) })}
        />
      </div>

      <Panel title={t('osTrend')}>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2" data-testid="stats-charts">
          <Bars title={t('osActive')} values={d.periods.map((p) => p.members.dauAvg)} labels={labels} faded={faded} fmt={num} testid="chart-active" />
          <Bars title={t('osNew')} values={d.periods.map((p) => p.members.signups)} labels={labels} faded={faded} fmt={num} testid="chart-signups" />
          <Bars title={t('osHandsDay')} values={d.periods.map((p) => p.play.handsPerDay)} labels={labels} faded={faded} fmt={num} testid="chart-hands" />
          <Bars title={t('osPeak')} values={d.periods.map((p) => p.play.peak)} labels={labels} faded={faded} fmt={num} testid="chart-peak" />
        </div>
        <p className="mt-3 text-xs text-ink-400">{t('osFadedHint')}</p>
      </Panel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('osShare')}>
          <div className="flex flex-col gap-3" data-testid="stats-share">
            {(
              [
                ['hands', 'osShareHands'],
                ['seats', 'osShareSeats'],
                ['seatMs', 'osShareTime'],
              ] as const
            ).map(([k, key]) => {
              const s = share(k);
              const fmt = k === 'seatMs' ? len : num;
              return (
                <div key={k} data-share={k}>
                  <div className="mb-1 flex flex-wrap justify-between gap-2 text-xs">
                    <span className="font-semibold text-ink-200">{t(key)}</span>
                    <span className="text-ink-400">{t('osShareRow', { a: fmt(s.a), b: fmt(s.b) })}</span>
                  </div>
                  <div
                    role="img"
                    aria-label={s.p === null ? `${t(key)}: —` : `${t(key)}: ${t('osOfficial')} ${s.p}%, ${t('osMember')} ${100 - s.p}%`}
                    className="flex h-3 overflow-hidden rounded-full bg-white/5"
                  >
                    {s.p !== null && (
                      <>
                        <span className="bg-gold-500/70" style={{ width: `${s.p}%` }} />
                        <span className="bg-info/70" style={{ width: `${100 - s.p}%` }} />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-4 text-xs text-ink-300">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-gold-500/70" />{t('osOfficial')}</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-info/70" />{t('osMember')}</span>
            </div>
          </div>
        </Panel>
        <Panel title={t('osAcademy')}>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3" data-testid="stats-academy">
            <div>
              <dt className="text-xs text-ink-400">{t('osAcLessons')}</dt>
              <dd className="font-mono text-lg">{pct(ac.ac_lesson_done, ac.ac_lesson_start)}</dd>
              <dd className="text-xs text-ink-400">{t('osAcStartDone', { s: num(ac.ac_lesson_start), d: num(ac.ac_lesson_done) })}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-400">{t('osAcScenarios')}</dt>
              <dd className="font-mono text-lg">{pct(ac.ac_scenario_done, ac.ac_scenario_start)}</dd>
              <dd className="text-xs text-ink-400">{t('osAcStartDone', { s: num(ac.ac_scenario_start), d: num(ac.ac_scenario_done) })}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-400">{t('osAcAnswers')}</dt>
              <dd className="font-mono text-lg">{pct(ac.ac_correct, ac.ac_answer)}</dd>
              <dd className="text-xs text-ink-400">{t('osAcAnswered', { n: num(ac.ac_answer) })}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ink-400">{t('osAcademyHint')}</p>
        </Panel>
      </div>

      <Panel title={t('osHandNotes')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="stats-hand-notes">
          <Stat
            label={t('osHnSaved')}
            value={<span data-testid="stats-hn-saved">{num(hn.hn_bookmark + hn.hn_tag + hn.hn_memo)}</span>}
            sub={t('osHnSavedSub', { b: num(hn.hn_bookmark), t: num(hn.hn_tag), m: num(hn.hn_memo) })}
          />
          <Stat
            label={t('osHnFailed')}
            value={<span data-testid="stats-hn-failed">{num(hnFailed)}</span>}
            sub={t('osHnFailedSub', { c: num(hn.hn_fail_conflict), i: num(hn.hn_fail_invalid), n: num(hn.hn_fail_notfound), l: num(hn.hn_fail_limit), e: num(hn.hn_fail_error) })}
          />
          <Stat
            label={t('osHnNow')}
            value={<span data-testid="stats-hn-now">{num(now.members)}</span>}
            sub={t('osHnNowSub', { b: num(now.bookmarked), t: num(now.tagged), m: num(now.memos) })}
          />
        </div>
        <p className="mt-3 text-xs text-ink-400">{t('osHnHint')}</p>
      </Panel>
      {ss && (
        <Panel title={t('osSettings')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="stats-settings">
            <Stat label={t('osSsSaved')} value={<span data-testid="stats-ss-saved">{num(ss.ss_save)}</span>} sub={t('osSsSavedSub', { l: num(ss.ss_legacy) })} />
            <Stat
              label={t('osSsConflict')}
              value={<span data-testid="stats-ss-conflict">{num(ss.ss_conflict)}</span>}
              sub={t('osSsConflictSub', { s: num(ss.ss_stale), e: num(ss.ss_epoch) })}
            />
            <Stat
              label={t('osSsFailed')}
              value={<span data-testid="stats-ss-failed">{num(ss.ss_fail_invalid + ss.ss_fail_limit + ss.ss_fail_busy + ss.ss_fail_error + ss.ss_load_fail + ss.ss_client_fail)}</span>}
              sub={t('osSsFailedSub', { i: num(ss.ss_fail_invalid), l: num(ss.ss_fail_limit), b: num(ss.ss_fail_busy), e: num(ss.ss_fail_error), r: num(ss.ss_load_fail), c: num(ss.ss_client_fail) })}
            />
            <Stat label={t('osSsReset')} value={<span data-testid="stats-ss-reset">{num(ss.ss_reset)}</span>} sub={t('osSsResetSub', { r: num(ss.ss_restore) })} />
          </div>
          <p className="mt-3 text-xs text-ink-400">{t('osSsHint')}</p>
        </Panel>
      )}
      {tb && (
        <Panel title={t('tbTitle')} actions={<Link to="/tables/time-bank" className="text-sm text-gold-300 hover:underline">{t('tbManage')} →</Link>}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="stats-time-bank">
            <Stat label={t('tbUses')} value={<span data-testid="stats-tb-use">{num(tb.tb_use)}</span>} sub={t('osTbUseSub', { s: num(tb.tb_sec), e: num(tb.tb_empty) })} />
            <Stat label={t('tbTimeout')} value={<span data-testid="stats-tb-timeout">{num(tb.tb_timeout)}</span>} sub={t('osTbTimeoutSub', { e: num(tb.tb_expired) })} />
            <Stat label={t('tbLate')} value={<span data-testid="stats-tb-late">{num(tb.tb_late)}</span>} sub={t('osTbLateSub', { r: num(tb.tb_recover) })} />
          </div>
        </Panel>
      )}
      <Panel title={t('osHourly')}>
        <figure data-testid="stats-hourly">
          <div
            role="img"
            aria-label={t('osHourlyAria', { h: hourOfMax(d.hourly), n: num(Math.max(0, ...d.hourly.map((h) => h.max ?? 0))) })}
            className="flex h-28 items-end gap-px border-b border-white/10"
          >
            {d.hourly.map((h, i) => {
              const top = Math.max(1, ...d.hourly.map((x) => x.avg ?? 0));
              return (
                <span
                  key={i}
                  title={t('osHourTip', { h: i, avg: num(h.avg), max: num(h.max) })}
                  className={`min-w-0 flex-1 rounded-t-sm ${h.avg ? 'bg-gold-500/70' : 'bg-white/5'}`}
                  style={{ height: h.avg ? `${Math.max(4, (h.avg / top) * 100)}%` : '2px' }}
                />
              );
            })}
          </div>
          <figcaption className="mt-1.5 flex justify-between text-[11px] text-ink-400">
            {[0, 6, 12, 18, 23].map((h) => <span key={h}>{t('osHour', { h })}</span>)}
          </figcaption>
        </figure>
        <p className="mt-2 text-xs text-ink-400">{t('osHourlyHint')}</p>
      </Panel>

      <Panel title={t('osTable')}>
        <div data-testid="stats-table">
          <Table
            head={COLUMNS.map((k) => <span key={k} className="whitespace-nowrap">{t(k)}</span>)}
          >
            {[...d.periods].reverse().map((p) => (
              <tr key={p.from} className={p.complete ? undefined : 'text-ink-300'} data-period={p.from}>
                <td className={`${td} whitespace-nowrap font-mono text-xs`}>
                  {label(p)} {!p.complete && <Badge className="font-sans">{p.days ? t('osPartial') : t('osNotRolled')}</Badge>}
                </td>
                <td className={`${td} font-mono`}>{p.days}</td>
                <td className={`${td} font-mono`}>{num(p.members.signups)}</td>
                <td className={`${td} font-mono`}>{num(p.members.dauAvg)}{star(p.members.partial.dau)}</td>
                <td className={`${td} font-mono`}>{num(p.members.wau)}{star(p.members.partial.wau)}</td>
                <td className={`${td} font-mono`}>{num(p.members.mau)}{star(p.members.partial.mau)}</td>
                <td className={`${td} whitespace-nowrap font-mono`}>{p.activation.cohort ? `${pct(p.activation.play1d, p.activation.cohort)} / ${pct(p.activation.play7d, p.activation.cohort)}` : '—'}</td>
                <td className={`${td} font-mono`}>{num(p.play.handsPerDay)}</td>
                <td className={`${td} font-mono`}>{num(p.play.tablesAvg)}</td>
                <td className={`${td} whitespace-nowrap`}>{len(p.play.avgSeatMs)}</td>
                <td className={`${td} font-mono`}>{num(p.play.peak)}</td>
                <td className={`${td} whitespace-nowrap font-mono`}>{`${num(p.reports.created)} / ${num(p.reports.handled)}`}</td>
                <td className={`${td} whitespace-nowrap`}>{len(p.reports.avgHandleMs)}</td>
              </tr>
            ))}
          </Table>
        </div>
      </Panel>

      <Panel title={t('osNotes')}>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-xs text-ink-300" data-testid="stats-notes">
          <li>{t('osNoteDay')}</li>
          <li>{t('osNoteRolled', { from: d.rolledFrom ?? '—', to: d.rolledThrough })}</li>
          <li>{d.activitySince ? t('osNoteActive', { since: d.activitySince, days: d.retentionDays }) : t('osNoteActiveNone')}</li>
          <li>{t('osNotePartial')}</li>
          <li>{t('osNoteCohort')}</li>
          <li>{t('osNoteSeats')}</li>
          <li>{t('osNoteReports')}</li>
        </ul>
      </Panel>
    </div>
  );
}

function hourOfMax(hourly: { max: number | null }[]) {
  let best = 0;
  hourly.forEach((h, i) => {
    if ((h.max ?? 0) > (hourly[best]!.max ?? 0)) best = i;
  });
  return best;
}

/** One bar per period; a period not over yet, or only partly rolled up, is drawn lighter. */
function Bars({ title, values, labels, faded, fmt, testid }: { title: string; values: (number | null)[]; labels: string[]; faded: boolean[]; fmt: (n: number | null) => string; testid: string }) {
  const { t } = useT();
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const shown = values.filter((v): v is number => v !== null);
  return (
    <figure className="min-w-0" data-testid={testid}>
      <figcaption className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-ink-200">{title}</span>
        <span className="text-ink-400">{t('osChartMax', { n: fmt(shown.length ? Math.max(...shown) : null) })}</span>
      </figcaption>
      <div
        role="img"
        aria-label={`${title}: ${labels[0]} – ${labels[labels.length - 1]}, ${t('osChartMax', { n: fmt(shown.length ? Math.max(...shown) : null) })}, ${t('osChartLast', { n: fmt(values[values.length - 1] ?? null) })}`}
        className="flex h-24 items-end gap-px border-b border-white/10"
      >
        {values.map((v, i) => (
          <span
            key={labels[i]}
            title={`${labels[i]}: ${fmt(v)}`}
            className={`min-w-0 flex-1 rounded-t-sm ${!v ? 'bg-white/5' : faded[i] ? 'bg-gold-500/35' : 'bg-gold-500/70'}`}
            style={{ height: v ? `${Math.max(4, (v / max) * 100)}%` : '2px' }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[10px] text-ink-400">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </figure>
  );
}
