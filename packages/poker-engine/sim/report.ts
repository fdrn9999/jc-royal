/**
 * Merges table-sim shards (`legacy-*.json` and `new-*.json` in one folder) and prints the before/after tables as
 * Markdown. Every rate shows its denominator; a cell with no opportunities reads "–".
 *
 *   pnpm exec tsx sim/report.ts --dir <folder> [--out report.md]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addCounters, BOT_LEVELS, BOT_STYLES, emptyCounters } from '../src';
import { emptyExtra, type Extra, type Group, type SimOutput, type TableAgg } from './table-sim';
import { USER_KINDS, USER_LABELS } from './users';

const BB = 10;

interface Merged {
  hands: number;
  shards: number;
  wallMs: number;
  errors: string[];
  groups: Map<string, Group>;
  tables: Map<string, TableAgg>;
}

function merge(files: string[]): Merged {
  const m: Merged = { hands: 0, shards: 0, wallMs: 0, errors: [], groups: new Map(), tables: new Map() };
  for (const f of files) {
    const o = JSON.parse(readFileSync(f, 'utf8')) as SimOutput;
    m.hands += o.hands;
    m.shards++;
    m.wallMs = Math.max(m.wallMs, o.wallMs);
    m.errors.push(...o.errors);
    for (const [k, g] of Object.entries(o.groups)) {
      const into = m.groups.get(k) ?? { c: emptyCounters(), x: emptyExtra() };
      addCounters(into.c, g.c);
      for (const key of Object.keys(into.x) as (keyof Extra)[]) into.x[key] = key === 'msMax' ? Math.max(into.x[key], g.x[key]) : into.x[key] + g.x[key];
      m.groups.set(k, into);
    }
    for (const [k, t] of Object.entries(o.tables)) {
      const into = m.tables.get(k);
      if (!into) m.tables.set(k, { ...t });
      else for (const key of Object.keys(t) as (keyof TableAgg)[]) into[key] += t[key];
    }
  }
  return m;
}

const pct = (x: number, n: number) => (n > 0 ? `${((100 * x) / n).toFixed(1)}%` : '–');
const pctN = (x: number, n: number) => (n > 0 ? `${((100 * x) / n).toFixed(1)}% (${n.toLocaleString('en-US')})` : '–');
const num = (x: number, n: number, d = 2) => (n > 0 ? (x / n).toFixed(d) : '–');

type Metric = [label: string, f: (g: Group) => string];

const M: Record<string, Metric> = {
  vpip: ['VPIP', (g) => pct(g.c.vpip, g.c.vpipOpp)],
  pfr: ['PFR', (g) => pct(g.c.pfr, g.c.vpipOpp)],
  threeBet: ['3Bet%', (g) => pct(g.c.threeBet, g.c.threeBetOpp)],
  fourBet: ['4Bet%', (g) => pct(g.c.fourBet, g.c.fourBetOpp)],
  bbDef: ['BB Defense%', (g) => pct(g.x.bbDef, g.x.bbDefOpp)],
  foldBbSteal: ['Fold BB to Steal%', (g) => pct(g.c.bbFoldToSteal, g.c.bbStealOpp)],
  fold3: ['Fold to 3Bet%', (g) => pct(g.c.foldTo3Bet, g.c.foldTo3BetOpp)],
  steal: ['Steal%', (g) => pct(g.c.steal, g.c.stealOpp)],
  cbet: ['C-bet%', (g) => pct(g.c.cbet, g.c.cbetOpp)],
  foldCbet: ['Fold to C-bet%', (g) => pct(g.c.foldToCbet, g.c.foldToCbetOpp)],
  overbet: ['Overbet Freq (베팅 기회당)', (g) => pct(g.c.overbets, g.c.postBetOpp)],
  foldOb: ['Fold to Overbet%', (g) => pct(g.c.foldToOverbet, g.c.foldToOverbetOpp)],
  allinCall: ['All-in Call Freq', (g) => pct(g.c.allinCall, g.c.allinCallOpp)],
  bigOpenFold: ['Fold to 5BB+ open', (g) => pct(g.x.bigOpenFold, g.x.bigOpenOpp)],
  wtsd: ['WTSD (쇼다운/플랍)', (g) => pct(g.c.showdowns, g.c.sawFlop)],
  af: ['AF', (g) => num(g.c.postBets, g.c.postCalls)],
  jam: ['프리플랍 올인/핸드', (g) => pct(g.c.jams, g.c.hands)],
  bb100: ['BB/100', (g) => num((100 * g.x.net) / BB, g.c.hands, 1)],
  hands: ['핸드', (g) => g.c.hands.toLocaleString('en-US')],
};

const DENOM: Record<string, (g: Group) => number> = {
  vpip: (g) => g.c.vpipOpp,
  pfr: (g) => g.c.vpipOpp,
  threeBet: (g) => g.c.threeBetOpp,
  fourBet: (g) => g.c.fourBetOpp,
  bbDef: (g) => g.x.bbDefOpp,
  foldBbSteal: (g) => g.c.bbStealOpp,
  fold3: (g) => g.c.foldTo3BetOpp,
  steal: (g) => g.c.stealOpp,
  cbet: (g) => g.c.cbetOpp,
  foldCbet: (g) => g.c.foldToCbetOpp,
  overbet: (g) => g.c.postBetOpp,
  foldOb: (g) => g.c.foldToOverbetOpp,
  allinCall: (g) => g.c.allinCallOpp,
  bigOpenFold: (g) => g.x.bigOpenOpp,
  wtsd: (g) => g.c.sawFlop,
  af: (g) => g.c.postCalls,
  jam: (g) => g.c.hands,
  bb100: (g) => g.c.hands,
};

function row(cells: string[]) {
  return `| ${cells.join(' | ')} |`;
}
function head(cells: string[]) {
  return [row(cells), row(cells.map(() => '---'))].join('\n');
}

function compare(L: Merged, N: Merged, key: string, metrics: string[]): string {
  const lines = [head(['지표', '기존(legacy)', '신규(2.0)', '표본(기존 / 신규)'])];
  const l = L.groups.get(key);
  const n = N.groups.get(key);
  for (const m of metrics) {
    const [label, f] = M[m]!;
    const d = DENOM[m];
    lines.push(row([label, l ? f(l) : '–', n ? f(n) : '–', d ? `${l ? d(l).toLocaleString('en-US') : 0} / ${n ? d(n).toLocaleString('en-US') : 0}` : '']));
  }
  return lines.join('\n');
}

function split(L: Merged, N: Merged, keys: { label: string; key: string }[], metrics: string[]): string {
  const cols = ['구분', ...metrics.flatMap((m) => [`${M[m]![0]} 기존`, `${M[m]![0]} 신규`])];
  const lines = [head(cols)];
  for (const { label, key } of keys) {
    const l = L.groups.get(key);
    const n = N.groups.get(key);
    if (!l && !n) continue;
    lines.push(row([label, ...metrics.flatMap((m) => [l ? M[m]![1](l) : '–', n ? M[m]![1](n) : '–'])]));
  }
  return lines.join('\n');
}

function tableRow(label: string, t: TableAgg | undefined): string[] {
  if (!t) return [label, '–', '–', '–', '–', '–', '–'];
  return [label, t.hands.toLocaleString('en-US'), num(t.pot, t.hands, 1), num(t.actions, t.hands, 1), pct(t.flops, t.hands), pct(t.showdowns, t.hands), pct(t.threeBetPots, t.hands)];
}

export function report(L: Merged, N: Merged): string {
  const out: string[] = [];
  const levels = BOT_LEVELS.map((lv) => ({ label: lv, key: `bot:${lv}` }));
  out.push('## 실행');
  out.push(head(['모드', '핸드', '샤드', '가장 긴 샤드(초)', '오류(거부·칩 불일치·미종료)']));
  out.push(row(['기존(legacy)', L.hands.toLocaleString('en-US'), String(L.shards), (L.wallMs / 1000).toFixed(0), String(L.errors.length)]));
  out.push(row(['신규(2.0)', N.hands.toLocaleString('en-US'), String(N.shards), (N.wallMs / 1000).toFixed(0), String(N.errors.length)]));
  for (const e of [...L.errors.slice(0, 5).map((x) => `legacy ${x}`), ...N.errors.slice(0, 5).map((x) => `new ${x}`)]) out.push(`- ${e}`);
  out.push('');
  out.push('## 전체 봇 (모든 테이블·스택·시나리오)');
  out.push(compare(L, N, 'bot:all', ['vpip', 'pfr', 'threeBet', 'fourBet', 'bbDef', 'foldBbSteal', 'fold3', 'steal', 'cbet', 'foldCbet', 'overbet', 'foldOb', 'allinCall', 'bigOpenFold', 'wtsd', 'af', 'jam']));
  out.push('');
  out.push('## 테이블 전체');
  out.push(head(['구분', '핸드', '평균 팟(BB)', '평균 액션 수', '플랍까지 간 비율', '쇼다운 비율', '3벳 팟 비율']));
  for (const [label, key] of [
    ['기존 전체', 'all'],
    ['신규 전체', 'all'],
  ] as const)
    out.push(row(tableRow(label, (label.startsWith('기존') ? L : N).tables.get(key))));
  for (const sc of ['bots', ...USER_KINDS]) {
    out.push(row(tableRow(`기존 vs ${sc}`, L.tables.get(`vs:${sc}`))));
    out.push(row(tableRow(`신규 vs ${sc}`, N.tables.get(`vs:${sc}`))));
  }
  out.push('');
  out.push('## 난이도별');
  out.push(split(L, N, levels, ['vpip', 'pfr', 'threeBet', 'bbDef', 'foldBbSteal', 'fold3', 'foldOb', 'allinCall', 'bb100']));
  out.push('');
  out.push('## 포지션별 (전체 봇)');
  out.push(
    split(
      L,
      N,
      ['UTG', 'EP', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((p) => ({ label: p, key: `bot:all|pos:${p}` })),
      ['vpip', 'pfr', 'threeBet', 'steal'],
    ),
  );
  out.push('');
  out.push('## 스택 깊이별 (전체 봇)');
  out.push(
    split(
      L,
      N,
      [20, 50, 100, 200].map((d) => ({ label: `${d}BB`, key: `bot:all|depth:${d}` })),
      ['vpip', 'pfr', 'threeBet', 'allinCall', 'jam'],
    ),
  );
  out.push('');
  out.push('## 테이블 크기별 (전체 봇)');
  out.push(
    split(
      L,
      N,
      [2, 6, 9].map((n) => ({ label: `${n}인`, key: `bot:all|size:${n}` })),
      ['vpip', 'pfr', 'threeBet', 'bbDef', 'wtsd'],
    ),
  );
  out.push('');
  out.push('## 난이도 × 포지션 (신규)');
  out.push(head(['난이도', ...['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((p) => `${p} VPIP/PFR`)]));
  for (const lv of BOT_LEVELS) {
    out.push(
      row([
        lv,
        ...['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((p) => {
          const g = N.groups.get(`bot:${lv}|pos:${p}`);
          return g ? `${M.vpip![1](g)} / ${M.pfr![1](g)}` : '–';
        }),
      ]),
    );
  }
  out.push('');
  out.push('## 가상 사용자 상대');
  out.push(head(['사용자', '사용자 BB/100 기존', '사용자 BB/100 신규', '사용자 레이즈에 전원 폴드 기존', '신규', '5BB+ 오픈에 전원 폴드 기존', '신규', '오버벳에 전원 폴드 기존', '신규', '올인에 전원 폴드 기존', '신규']));
  for (const u of USER_KINDS) {
    const lu = L.groups.get(`user:${u}`);
    const nu = N.groups.get(`user:${u}`);
    const lt = L.tables.get(`vs:${u}`);
    const nt = N.tables.get(`vs:${u}`);
    out.push(
      row([
        `${u} ${USER_LABELS[u]}`,
        lu ? M.bb100![1](lu) : '–',
        nu ? M.bb100![1](nu) : '–',
        lt ? pctN(lt.userRaisesAllFold, lt.userRaises) : '–',
        nt ? pctN(nt.userRaisesAllFold, nt.userRaises) : '–',
        lt ? pctN(lt.userBigOpensAllFold, lt.userBigOpens) : '–',
        nt ? pctN(nt.userBigOpensAllFold, nt.userBigOpens) : '–',
        lt ? pctN(lt.userOverbetsAllFold, lt.userOverbets) : '–',
        nt ? pctN(nt.userOverbetsAllFold, nt.userOverbets) : '–',
        lt ? pctN(lt.userJamsAllFold, lt.userJams) : '–',
        nt ? pctN(nt.userJamsAllFold, nt.userJams) : '–',
      ]),
    );
  }
  out.push('');
  out.push('### 사용자별 봇의 대응');
  out.push(
    split(
      L,
      N,
      USER_KINDS.map((u) => ({ label: `vs ${u} ${USER_LABELS[u]}`, key: `bot:all|vs:${u}` })),
      ['bbDef', 'foldBbSteal', 'threeBet', 'bigOpenFold', 'foldOb', 'allinCall', 'bb100'],
    ),
  );
  out.push('');
  out.push('### 적응: 세션(250핸드) 전반 125핸드 대 후반 125핸드');
  out.push('봇은 같은 세션에서 본 사용자의 공개 통계만 씁니다(기존 봇은 통계를 쓰지 않음). 같은 덱 시드라 전반·후반 차이는 카드 운도 포함합니다.');
  out.push(
    head([
      '사용자',
      '모드',
      '봇 Fold to Overbet 전반',
      '후반',
      '봇 All-in Call 전반',
      '후반',
      '봇 Fold to 5BB+ open 전반',
      '후반',
      '오버벳 전원 폴드 전반',
      '후반',
      '사용자 BB/100 전반',
      '후반',
    ]),
  );
  for (const u of USER_KINDS) {
    for (const [mode, R] of [
      ['기존', L],
      ['신규', N],
    ] as const) {
      const b1 = R.groups.get(`bot:all|vs:${u}|half:1`);
      const b2 = R.groups.get(`bot:all|vs:${u}|half:2`);
      const u1 = R.groups.get(`user:${u}|half:1`);
      const u2 = R.groups.get(`user:${u}|half:2`);
      const t1 = R.tables.get(`vs:${u}|half:1`);
      const t2 = R.tables.get(`vs:${u}|half:2`);
      const f = (g: Group | undefined, m: string) => (g ? M[m]![1](g) : '–');
      out.push(
        row([
          `${u} ${USER_LABELS[u]}`,
          mode,
          f(b1, 'foldOb'),
          f(b2, 'foldOb'),
          f(b1, 'allinCall'),
          f(b2, 'allinCall'),
          f(b1, 'bigOpenFold'),
          f(b2, 'bigOpenFold'),
          t1 ? pct(t1.userOverbetsAllFold, t1.userOverbets) : '–',
          t2 ? pct(t2.userOverbetsAllFold, t2.userOverbets) : '–',
          f(u1, 'bb100'),
          f(u2, 'bb100'),
        ]),
      );
    }
  }
  out.push('');
  out.push('### 사용자 상대 난이도별 봇 BB/100');
  out.push(head(['사용자', ...BOT_LEVELS.flatMap((lv) => [`${lv} 기존`, `${lv} 신규`])]));
  for (const u of ['bots', ...USER_KINDS]) {
    out.push(
      row([
        u,
        ...BOT_LEVELS.flatMap((lv) => {
          const l = L.groups.get(`bot:${lv}|vs:${u}`);
          const n = N.groups.get(`bot:${lv}|vs:${u}`);
          return [l ? M.bb100![1](l) : '–', n ? M.bb100![1](n) : '–'];
        }),
      ]),
    );
  }
  out.push('');
  out.push('## 스타일 다양성 (신규)');
  out.push(head(['스타일', 'VPIP', 'PFR', '3Bet%', 'C-bet%', 'AF', 'WTSD', 'BB/100', '핸드']));
  for (const st of BOT_STYLES) {
    const g = N.groups.get(`style:${st}`);
    if (!g) continue;
    out.push(row([st, M.vpip![1](g), M.pfr![1](g), M.threeBet![1](g), M.cbet![1](g), M.af![1](g), M.wtsd![1](g), M.bb100![1](g), M.hands![1](g)]));
  }
  out.push('');
  out.push('## 무리한 판단 (분석용으로만 카드를 보고 채점)');
  out.push('- 무리한 콜: 20BB 이상이 드는 올인 콜 가운데 프리플랍 상위 45% 밖 패, 또는 플랍 이후 핸드 강도 0.4 미만으로 콜한 비율');
  out.push('- 비정상 올인: 프리플랍 30BB 이상 올인을 상위 25% 밖 패로 한 경우, 플랍 이후 팟의 3배가 넘는 올인을 강도 0.3 미만으로 한 경우');
  out.push(head(['난이도', '무리한 콜 기존', '신규', '비정상 올인 기존', '신규']));
  for (const lv of ['all', ...BOT_LEVELS]) {
    const l = L.groups.get(`bot:${lv}`);
    const n = N.groups.get(`bot:${lv}`);
    out.push(row([lv, l ? pctN(l.x.recklessCall, l.x.allinCallsMade) : '–', n ? pctN(n.x.recklessCall, n.x.allinCallsMade) : '–', l ? pctN(l.x.abnormalJam, l.x.jamsMade) : '–', n ? pctN(n.x.abnormalJam, n.x.jamsMade) : '–']));
  }
  out.push('');
  out.push('## 결정 시간 (이 PC, 단일 스레드)');
  out.push(head(['난이도', '평균 ms 기존', '신규', '최대 ms 기존', '신규', '50ms 초과 기존', '신규']));
  for (const lv of BOT_LEVELS) {
    const l = L.groups.get(`bot:${lv}`);
    const n = N.groups.get(`bot:${lv}`);
    out.push(row([lv, l ? num(l.x.ms, l.x.decisions, 2) : '–', n ? num(n.x.ms, n.x.decisions, 2) : '–', l ? l.x.msMax.toFixed(1) : '–', n ? n.x.msMax.toFixed(1) : '–', l ? pctN(l.x.slow, l.x.decisions) : '–', n ? pctN(n.x.slow, n.x.decisions) : '–']));
  }
  return out.join('\n');
}

if (process.argv[1]?.endsWith('report.ts')) {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const dir = get('dir') ?? '.';
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const L = merge(files.filter((f) => f.startsWith('legacy-')).map((f) => join(dir, f)));
  const N = merge(files.filter((f) => f.startsWith('new-')).map((f) => join(dir, f)));
  const md = report(L, N);
  const out = get('out');
  if (out) writeFileSync(out, md);
  else console.log(md);
}
