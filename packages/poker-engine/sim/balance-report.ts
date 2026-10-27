/**
 * The report for sim/balance-sim.ts: reads every shard in a folder and writes markdown.
 *
 *   pnpm exec tsx sim/balance-report.ts --dir <folder> [--out report.md]
 *
 * Rates are totals over sessions (Σ count / Σ chances), each with a 95% interval clustered by session: hands in one
 * session share players and a record, so they are not counted as independent. Differences between levels (or between
 * a style and the balanced one) are paired: both played the same decks, seats and opponents' random numbers, and the
 * interval of the difference is clustered by that shared session.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_LEVELS, BOT_STYLES, STAT_KEYS, type BotLevel, type BotStyle } from '../src';
import { BB, BIN, FIELDS, PAIRS, type BalanceOutput, type Field, type Grade, type Rec, type Timing } from './balance-sim';
import { OPPONENT_LABELS } from './opponents';

const LEVEL_KO: Record<BotLevel, string> = { easy: '쉬움', normal: '보통', hard: '어려움', expert: '전문가' };
const STYLE_KO: Record<BotStyle, string> = { balanced: '균형형', tag: '타이트 어그레시브', lag: '루즈 어그레시브', 'tight-passive': '타이트 패시브', 'loose-passive': '루즈 패시브', casual: '캐주얼' };
const ci = (k: string) => STAT_KEYS.indexOf(k as (typeof STAT_KEYS)[number]);

/** A metric: a count over its chances for one session record. */
interface Metric {
  label: string;
  num: (r: Rec) => number;
  den: (r: Rec) => number;
  /** Shown as a percentage (×100), as big blinds or times per 100 hands, or as a plain ratio. */
  fmt: 'pct' | 'bb100' | 'per100' | 'ratio';
}
const c = (k: string) => (r: Rec) => r.c[ci(k)]!;
const g = (k: keyof Grade) => (r: Rec) => r.g[k];
const M = {
  bb100: { label: 'BB/100', num: (r) => r.net / BB, den: (r) => r.hands / 100, fmt: 'bb100' },
  won: { label: '핸드 승률', num: (r) => r.won, den: (r) => r.hands, fmt: 'pct' },
  vpip: { label: 'VPIP', num: c('vpip'), den: c('vpipOpp'), fmt: 'pct' },
  pfr: { label: 'PFR', num: c('pfr'), den: c('vpipOpp'), fmt: 'pct' },
  threeBet: { label: '3-Bet', num: c('threeBet'), den: c('threeBetOpp'), fmt: 'pct' },
  af: { label: 'AF', num: c('postBets'), den: c('postCalls'), fmt: 'ratio' },
  cbet: { label: 'C-Bet', num: c('cbet'), den: c('cbetOpp'), fmt: 'pct' },
  foldCbet: { label: 'Fold to C-Bet', num: c('foldToCbet'), den: c('foldToCbetOpp'), fmt: 'pct' },
  wtsd: { label: 'WTSD', num: c('showdowns'), den: c('sawFlop'), fmt: 'pct' },
  wsd: { label: 'W$SD', num: (r) => r.sdWon, den: c('showdowns'), fmt: 'pct' },
  earlyBluff: { label: '플롭·턴 순수 블러프 비율', num: g('earlyBluffs'), den: g('earlyBets'), fmt: 'pct' },
  semiBluff: { label: '플롭·턴 세미 블러프 비율', num: g('semiBluffs'), den: g('earlyBets'), fmt: 'pct' },
  riverBluff: { label: '리버 블러프 비율', num: g('riverBluffs'), den: g('riverBets'), fmt: 'pct' },
  badCall: { label: '리버 나쁜 콜 비율', num: g('badRiverCalls'), den: g('riverCalls'), fmt: 'pct' },
  weakBig: { label: '20BB+ 약한 콜 비율', num: g('weakBigCalls'), den: g('bigCalls'), fmt: 'pct' },
  size: { label: '평균 베팅 크기(팟 대비)', num: g('sizeSum'), den: (r) => r.g.earlyBets + r.g.riverBets, fmt: 'ratio' },
  overbet: { label: '오버벳 비율', num: g('overbets'), den: (r) => r.g.earlyBets + r.g.riverBets, fmt: 'pct' },
  jam: { label: '올인 벳·레이즈/100핸드', num: g('jams'), den: (r) => r.hands / 100, fmt: 'per100' },
  wildJam: { label: '비정상 올인/100핸드', num: g('wildJams'), den: (r) => r.hands / 100, fmt: 'per100' },
} satisfies Record<string, Metric>;
type MetricKey = keyof typeof M;

interface Est {
  r: number;
  se: number;
  den: number;
  n: number;
}

/** Σnum/Σden with its standard error clustered by `cluster` (records of one cluster are summed first). */
function ratio(recs: Rec[], m: Metric, cluster: (r: Rec) => string): Est {
  const by = new Map<string, [number, number]>();
  for (const r of recs) {
    const k = cluster(r);
    const x = by.get(k) ?? [0, 0];
    x[0] += m.num(r);
    x[1] += m.den(r);
    by.set(k, x);
  }
  let N = 0;
  let D = 0;
  for (const [n, d] of by.values()) {
    N += n;
    D += d;
  }
  const R = D > 0 ? N / D : NaN;
  const n = by.size;
  let ss = 0;
  for (const [x, d] of by.values()) ss += (x - R * d) ** 2;
  return { r: R, se: n > 1 && D > 0 ? Math.sqrt((n / (n - 1)) * ss) / D : NaN, den: D, n };
}

/** R(a) − R(b), paired by cluster (both sides' records of a cluster share its decks and players). */
function diff(a: Rec[], b: Rec[], m: Metric, cluster: (r: Rec) => string): Est {
  const ea = ratio(a, m, cluster);
  const eb = ratio(b, m, cluster);
  const infl = new Map<string, number>();
  const add = (recs: Rec[], e: Est, sign: number) => {
    for (const r of recs) {
      const k = cluster(r);
      infl.set(k, (infl.get(k) ?? 0) + (sign * (m.num(r) - e.r * m.den(r))) / e.den);
    }
  };
  add(a, ea, 1);
  add(b, eb, -1);
  const n = infl.size;
  let ss = 0;
  for (const x of infl.values()) ss += x * x;
  return { r: ea.r - eb.r, se: n > 1 ? Math.sqrt((n / (n - 1)) * ss) : NaN, den: Math.min(ea.den, eb.den), n };
}

const scale = (m: Metric) => (m.fmt === 'pct' ? 100 : 1);
function show(e: Est, m: Metric, withCi = true): string {
  if (!Number.isFinite(e.r)) return '—';
  const s = scale(m);
  const d = m.fmt === 'ratio' ? 2 : 1;
  const v = (e.r * s).toFixed(d) + (m.fmt === 'pct' ? '%' : '');
  return withCi && Number.isFinite(e.se) ? `${v} ±${(1.96 * e.se * s).toFixed(d)}` : v;
}
function showDiff(e: Est, m: Metric): string {
  if (!Number.isFinite(e.r)) return '—';
  const s = scale(m);
  const d = m.fmt === 'ratio' ? 2 : 1;
  const lo = (e.r - 1.96 * e.se) * s;
  const hi = (e.r + 1.96 * e.se) * s;
  const mark = lo > 0 ? ' ▲' : hi < 0 ? ' ▼' : '';
  return `${e.r * s >= 0 ? '+' : ''}${(e.r * s).toFixed(d)} [${lo.toFixed(d)}, ${hi.toFixed(d)}]${mark}`;
}
/** Whether the difference is beyond its 95% interval, in the given direction. */
const sig = (e: Est, dir: 1 | -1) => (dir > 0 ? e.r - 1.96 * e.se > 0 : e.r + 1.96 * e.se < 0);

/** A percentile from the histogram. The last bin holds everything slower, so a percentile there is only a lower bound. */
function quantile(t: Timing, q: number, digits: number): string {
  const target = q * t.n;
  let acc = 0;
  for (let i = 0; i < t.bins.length; i++) {
    acc += t.bins[i]!;
    if (acc >= target) return i === t.bins.length - 1 ? `≥${(i * BIN).toFixed(digits)}` : ((i + 1) * BIN).toFixed(digits);
  }
  return t.max.toFixed(digits);
}
function mergeTiming(into: Record<string, Timing>, from: Record<string, Timing>) {
  for (const [k, t] of Object.entries(from)) {
    const x = into[k];
    if (!x) into[k] = { ...t, bins: [...t.bins] };
    else {
      x.n += t.n;
      x.sum += t.sum;
      x.max = Math.max(x.max, t.max);
      t.bins.forEach((b, i) => (x.bins[i]! += b));
    }
  }
}

function args() {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 && a[i + 1] ? a[i + 1]! : d;
  };
  return { dir: get('dir', '.'), out: get('out', '') };
}

const parse = (key: string) => {
  const [exp, rest] = key.split(':') as [string, string];
  const [group, level, style] = rest.split('|') as [string, BotLevel, BotStyle | undefined];
  return { exp, group, level, style };
};

export function report(outs: BalanceOutput[]): string {
  const field = outs.filter((o) => o.exp === 'field').flatMap((o) => o.recs);
  const duel = outs.filter((o) => o.exp === 'duel').flatMap((o) => o.recs);
  const timing: Record<string, Timing> = {};
  const tables: Record<string, Timing> = {};
  const perfTiming: Record<string, Timing> = {};
  for (const o of outs) {
    if (o.exp === 'field') mergeTiming(timing, o.timing);
    if (o.exp === 'perf') {
      mergeTiming(perfTiming, o.timing);
      mergeTiming(tables, o.tables);
    }
  }
  const errors = outs.flatMap((o) => o.errors);
  const hands = (exp: string) => outs.filter((o) => o.exp === exp).reduce((a, o) => a + o.hands, 0);

  const sel = (f: (p: ReturnType<typeof parse>) => boolean) => field.filter((r) => f(parse(r.key)));
  const byFieldSession = (r: Rec) => `${parse(r.key).group}#${r.si}`;
  const sessions = new Set(field.map((r) => r.si)).size;
  const L: string[] = [];
  const p = (s = '') => L.push(s);

  p('# 봇 난이도·스타일 밸런싱 시뮬레이션');
  p();
  p(`- field: ${hands('field').toLocaleString()} 핸드 (상대 유형 ${FIELDS.length}종 × 난이도 4 × 스타일 ${BOT_STYLES.length} × 세션 ${sessions}, 6인 100BB, 세션마다 ${Math.round(field[0] ? field[0].hands : 0)}핸드)`);
  p(`- duel: ${hands('duel').toLocaleString()} 핸드 (난이도 쌍 ${PAIRS.length}개, 헤즈업 100BB, 같은 덱을 자리 바꿔 두 번)`);
  p(`- perf: ${hands('perf').toLocaleString()} 핸드 (한 난이도의 봇만 6석·9석)`);
  p(`- 오류(거부된 액션·핸드 미종료·칩 불일치): ${errors.length}건${errors.length ? ` — ${errors.slice(0, 5).join(' / ')}` : ''}`);
  p('- 구간은 95% (세션 단위 군집 표준오차 × 1.96). 차이는 같은 덱·자리·상대 난수로 짝지은 값이며 ▲/▼는 구간이 0을 넘지 않는 경우.');
  p();

  // Levels: overall and per opponent type.
  const levelKeys: MetricKey[] = ['bb100', 'won', 'vpip', 'pfr', 'threeBet', 'af', 'cbet', 'foldCbet', 'wtsd', 'wsd', 'earlyBluff', 'semiBluff', 'riverBluff', 'badCall', 'weakBig'];
  p('## 1. 난이도별 (모든 상대 유형·스타일 합계)');
  p();
  p(`| 난이도 | 핸드 | ${levelKeys.map((k) => M[k].label).join(' | ')} |`);
  p(`|---|---:|${levelKeys.map(() => '---:').join('|')}|`);
  for (const level of BOT_LEVELS) {
    const recs = sel((x) => x.level === level);
    p(`| ${LEVEL_KO[level]} | ${recs.reduce((a, r) => a + r.hands, 0).toLocaleString()} | ${levelKeys.map((k) => show(ratio(recs, M[k], byFieldSession), M[k])).join(' | ')} |`);
  }
  p();
  p('### 1-1. 난이도 차이 (짝지은 차이, BB/100과 판단 지표)');
  p();
  const diffKeys: MetricKey[] = ['bb100', 'badCall', 'weakBig', 'riverBluff', 'earlyBluff', 'wsd'];
  p(`| 비교 | ${diffKeys.map((k) => M[k].label).join(' | ')} |`);
  p(`|---|${diffKeys.map(() => '---').join('|')}|`);
  const cmp: [BotLevel, BotLevel][] = [
    ['expert', 'hard'],
    ['expert', 'normal'],
    ['expert', 'easy'],
    ['hard', 'normal'],
    ['hard', 'easy'],
    ['normal', 'easy'],
  ];
  for (const [a, b] of cmp) {
    const ra = sel((x) => x.level === a);
    const rb = sel((x) => x.level === b);
    p(`| ${LEVEL_KO[a]} − ${LEVEL_KO[b]} | ${diffKeys.map((k) => showDiff(diff(ra, rb, M[k], byFieldSession), M[k])).join(' | ')} |`);
  }
  p();
  p(`## 2. 상대 유형 × 난이도: BB/100 (스타일 ${BOT_STYLES.length}종 합계)`);
  p();
  p(`| 상대 유형 | ${BOT_LEVELS.map((l) => LEVEL_KO[l]).join(' | ')} | 전문가 − 어려움 | 전문가 − 쉬움 |`);
  p(`|---|${BOT_LEVELS.map(() => '---:').join('|')}|---|---|`);
  for (const f of FIELDS) {
    const at = (l: BotLevel) => sel((x) => x.group === f && x.level === l);
    p(`| ${OPPONENT_LABELS[f as Field]} | ${BOT_LEVELS.map((l) => show(ratio(at(l), M.bb100, byFieldSession), M.bb100)).join(' | ')} | ${showDiff(diff(at('expert'), at('hard'), M.bb100, byFieldSession), M.bb100)} | ${showDiff(diff(at('expert'), at('easy'), M.bb100, byFieldSession), M.bb100)} |`);
  }
  p();
  p(`## 3. 상대 유형 × 난이도: 플레이 지표 (스타일 ${BOT_STYLES.length}종 합계)`);
  p();
  const fk: MetricKey[] = ['vpip', 'pfr', 'threeBet', 'af', 'cbet', 'foldCbet', 'wtsd', 'wsd', 'riverBluff', 'badCall'];
  p(`| 상대 유형 | 난이도 | ${fk.map((k) => M[k].label).join(' | ')} |`);
  p(`|---|---|${fk.map(() => '---:').join('|')}|`);
  for (const f of FIELDS)
    for (const level of BOT_LEVELS) {
      const recs = sel((x) => x.group === f && x.level === level);
      p(`| ${OPPONENT_LABELS[f as Field]} | ${LEVEL_KO[level]} | ${fk.map((k) => show(ratio(recs, M[k], byFieldSession), M[k], false)).join(' | ')} |`);
    }
  p();

  // Duels.
  p('## 4. 헤즈업 대결 (균형형끼리, 같은 덱을 자리 바꿔 두 번)');
  p();
  p('| 대결 | 핸드 | 앞쪽 난이도의 BB/100 | 앞쪽 리버 나쁜 콜 | 뒤쪽 리버 나쁜 콜 |');
  p('|---|---:|---|---:|---:|');
  for (const [a, b] of PAIRS) {
    const ra = duel.filter((r) => r.key === `duel:${a}-${b}|${a}`);
    const rb = duel.filter((r) => r.key === `duel:${a}-${b}|${b}`);
    const bySession = (r: Rec) => String(r.si);
    const e = ratio(ra, M.bb100, bySession);
    p(`| ${LEVEL_KO[a]} vs ${LEVEL_KO[b]} | ${ra.reduce((x, r) => x + r.hands, 0).toLocaleString()} | ${showDiff(e, M.bb100)} | ${show(ratio(ra, M.badCall, bySession), M.badCall, false)} | ${show(ratio(rb, M.badCall, bySession), M.badCall, false)} |`);
  }
  p();

  // Styles.
  const sk: MetricKey[] = ['vpip', 'pfr', 'threeBet', 'af', 'cbet', 'wtsd', 'earlyBluff', 'riverBluff', 'size', 'overbet', 'jam', 'wildJam', 'bb100'];
  p('## 5. 스타일별 (모든 상대 유형·난이도 합계)');
  p();
  p(`| 스타일 | ${sk.map((k) => M[k].label).join(' | ')} |`);
  p(`|---|${sk.map(() => '---:').join('|')}|`);
  for (const style of BOT_STYLES) {
    const recs = sel((x) => x.style === style);
    p(`| ${STYLE_KO[style]} | ${sk.map((k) => show(ratio(recs, M[k], byFieldSession), M[k])).join(' | ')} |`);
  }
  p();
  p('### 5-1. 균형형 대비 차이 (같은 난이도·덱·상대로 짝지음)');
  p();
  const dk: MetricKey[] = ['vpip', 'pfr', 'threeBet', 'af', 'cbet', 'size', 'overbet', 'wildJam'];
  p(`| 스타일 | ${dk.map((k) => M[k].label).join(' | ')} |`);
  p(`|---|${dk.map(() => '---').join('|')}|`);
  const bal = sel((x) => x.style === 'balanced');
  for (const style of BOT_STYLES.filter((s) => s !== 'balanced')) {
    const recs = sel((x) => x.style === style);
    p(`| ${STYLE_KO[style]} | ${dk.map((k) => showDiff(diff(recs, bal, M[k], byFieldSession), M[k])).join(' | ')} |`);
  }
  p();
  p('## 6. 난이도 × 스타일 (VPIP / PFR / AF / BB/100, 모든 상대 유형 합계)');
  p();
  p(`| 난이도 | ${BOT_STYLES.map((s) => STYLE_KO[s]).join(' | ')} |`);
  p(`|---|${BOT_STYLES.map(() => '---').join('|')}|`);
  for (const level of BOT_LEVELS) {
    const cells = BOT_STYLES.map((style) => {
      const recs = sel((x) => x.level === level && x.style === style);
      return `${show(ratio(recs, M.vpip, byFieldSession), M.vpip, false)} / ${show(ratio(recs, M.pfr, byFieldSession), M.pfr, false)} / ${show(ratio(recs, M.af, byFieldSession), M.af, false)} / ${show(ratio(recs, M.bb100, byFieldSession), M.bb100, false)}`;
    });
    p(`| ${LEVEL_KO[level]} | ${cells.join(' | ')} |`);
  }
  p();

  // Style checks, overall and within each level.
  p('## 7. 스타일 검증 (차이의 95% 구간이 0을 넘지 않아야 통과)');
  p();
  const scopes: [string, (x: ReturnType<typeof parse>) => boolean][] = [['전체', () => true], ...BOT_LEVELS.map((l) => [LEVEL_KO[l], (x: ReturnType<typeof parse>) => x.level === l] as [string, (x: ReturnType<typeof parse>) => boolean])];
  const checks: { label: string; test: (at: (s: BotStyle) => Rec[]) => boolean }[] = [
    { label: 'TAG: VPIP < 균형형', test: (at) => sig(diff(at('tag'), at('balanced'), M.vpip, byFieldSession), -1) },
    { label: 'TAG: AF > 균형형', test: (at) => sig(diff(at('tag'), at('balanced'), M.af, byFieldSession), 1) },
    { label: 'LAG: VPIP > TAG', test: (at) => sig(diff(at('lag'), at('tag'), M.vpip, byFieldSession), 1) },
    { label: 'LAG: PFR > TAG', test: (at) => sig(diff(at('lag'), at('tag'), M.pfr, byFieldSession), 1) },
    { label: 'LAG: AF > TAG', test: (at) => sig(diff(at('lag'), at('tag'), M.af, byFieldSession), 1) },
    { label: 'LP: VPIP > 균형형', test: (at) => sig(diff(at('loose-passive'), at('balanced'), M.vpip, byFieldSession), 1) },
    { label: 'LP: PFR < 균형형', test: (at) => sig(diff(at('loose-passive'), at('balanced'), M.pfr, byFieldSession), -1) },
    { label: 'LP: AF < 균형형', test: (at) => sig(diff(at('loose-passive'), at('balanced'), M.af, byFieldSession), -1) },
    { label: 'TP: VPIP < 균형형', test: (at) => sig(diff(at('tight-passive'), at('balanced'), M.vpip, byFieldSession), -1) },
    { label: 'TP: AF < 균형형', test: (at) => sig(diff(at('tight-passive'), at('balanced'), M.af, byFieldSession), -1) },
    { label: '캐주얼: VPIP > 균형형', test: (at) => sig(diff(at('casual'), at('balanced'), M.vpip, byFieldSession), 1) },
    { label: '캐주얼: PFR > 균형형', test: (at) => sig(diff(at('casual'), at('balanced'), M.pfr, byFieldSession), 1) },
    { label: '캐주얼: AF > 균형형', test: (at) => sig(diff(at('casual'), at('balanced'), M.af, byFieldSession), 1) },
    { label: '캐주얼: 평균 베팅 크기 > 균형형', test: (at) => sig(diff(at('casual'), at('balanced'), M.size, byFieldSession), 1) },
    { label: '캐주얼: 오버벳 비율 > 균형형', test: (at) => sig(diff(at('casual'), at('balanced'), M.overbet, byFieldSession), 1) },
    { label: '캐주얼: VPIP > LAG', test: (at) => sig(diff(at('casual'), at('lag'), M.vpip, byFieldSession), 1) },
    { label: '캐주얼: 평균 베팅 크기 > LAG', test: (at) => sig(diff(at('casual'), at('lag'), M.size, byFieldSession), 1) },
    { label: '캐주얼: 비정상 올인이 균형형보다 많지 않음', test: (at) => !sig(diff(at('casual'), at('balanced'), M.wildJam, byFieldSession), 1) },
    {
      label: `균형형: VPIP·AF가 극단이 아님 (${BOT_STYLES.length}개 스타일 중 최소·최대가 아님)`,
      test: (at) =>
        (['vpip', 'af'] as const).every((k) => {
          const v = BOT_STYLES.map((s) => ratio(at(s), M[k], byFieldSession).r);
          const b = v[BOT_STYLES.indexOf('balanced')]!;
          return b > Math.min(...v) && b < Math.max(...v);
        }),
    },
  ];
  p(`| 검증 | ${scopes.map(([l]) => l).join(' | ')} |`);
  p(`|---|${scopes.map(() => ':---:').join('|')}|`);
  for (const chk of checks) p(`| ${chk.label} | ${scopes.map(([, f]) => (chk.test((s) => sel((x) => f(x) && x.style === s)) ? '통과' : '**실패**')).join(' | ')} |`);
  p();
  p('### 7-1. 같은 스타일 안의 난이도 차이 vs 같은 난이도 안의 스타일 차이');
  p();
  p('스타일이 경향(VPIP·PFR·AF·C-Bet)을, 난이도가 정확도(BB/100·나쁜 콜·큰 베팅에 약한 콜)를 움직이는지 본다.');
  p();
  p('| 차이 | VPIP | PFR | AF | C-Bet | BB/100 | 리버 나쁜 콜 | 20BB+ 약한 콜 |');
  p('|---|---|---|---|---|---|---|---|');
  const row = (label: string, a: Rec[], b: Rec[]) => p(`| ${label} | ${(['vpip', 'pfr', 'af', 'cbet', 'bb100', 'badCall', 'weakBig'] as const).map((k) => showDiff(diff(a, b, M[k], byFieldSession), M[k])).join(' | ')} |`);
  row('전문가 − 쉬움 (스타일 합계)', sel((x) => x.level === 'expert'), sel((x) => x.level === 'easy'));
  row('루즈 어그레시브 − 타이트 패시브 (난이도 합계)', sel((x) => x.style === 'lag'), sel((x) => x.style === 'tight-passive'));
  row('캐주얼 − 균형형 (난이도 합계)', sel((x) => x.style === 'casual'), sel((x) => x.style === 'balanced'));
  row('쉬움·캐주얼 − 전문가·캐주얼', sel((x) => x.level === 'easy' && x.style === 'casual'), sel((x) => x.level === 'expert' && x.style === 'casual'));
  row('전문가·타이트 패시브 − 쉬움·루즈 어그레시브', sel((x) => x.level === 'expert' && x.style === 'tight-passive'), sel((x) => x.level === 'easy' && x.style === 'lag'));
  p();

  // Timing.
  p('## 8. 판단 시간 (ms, 한 번의 결정)');
  p();
  p('| 난이도 | 결정 | 평균 | p50 | p95 | p99 | 최대 |');
  p('|---|---:|---:|---:|---:|---:|---:|');
  for (const level of BOT_LEVELS) {
    const t = timing[level];
    if (t) p(`| ${LEVEL_KO[level]} (field) | ${t.n.toLocaleString()} | ${(t.sum / t.n).toFixed(2)} | ${quantile(t, 0.5, 2)} | ${quantile(t, 0.95, 2)} | ${quantile(t, 0.99, 2)} | ${t.max.toFixed(1)} |`);
  }
  for (const level of BOT_LEVELS) {
    const t = perfTiming[level];
    if (t) p(`| ${LEVEL_KO[level]} (perf) | ${t.n.toLocaleString()} | ${(t.sum / t.n).toFixed(2)} | ${quantile(t, 0.5, 2)} | ${quantile(t, 0.95, 2)} | ${quantile(t, 0.99, 2)} | ${t.max.toFixed(1)} |`);
  }
  p();
  p('### 8-1. 한 테이블의 봇 전부가 한 핸드에 쓰는 계산 시간 (ms)');
  p();
  p('| 난이도 | 좌석 | 핸드 | 평균 | p95 | 최대 |');
  p('|---|---:|---:|---:|---:|---:|');
  for (const level of BOT_LEVELS)
    for (const size of [6, 9]) {
      const t = tables[`${level}|${size}`];
      if (t) p(`| ${LEVEL_KO[level]} | ${size} | ${t.n.toLocaleString()} | ${(t.sum / t.n).toFixed(1)} | ${quantile(t, 0.95, 1)} | ${t.max.toFixed(1)} |`);
    }
  p();
  return L.join('\n');
}

if (process.argv[1]?.endsWith('balance-report.ts')) {
  const a = args();
  const outs = readdirSync(a.dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(a.dir, f), 'utf8')) as BalanceOutput);
  const md = report(outs);
  if (a.out) writeFileSync(a.out, md);
  else console.log(md);
}
