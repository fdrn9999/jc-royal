/**
 * Lesson 5: practice table. The real TableScene + ActionBar render a
 * PracticeSession (local HandEngine, scripted opponents). No socket is opened
 * and nothing is sent to the server: wallet, history and statistics are untouched.
 */
import { sound } from '@jc/audio';
import { handLabelKey, type ActionType, type TableView } from '@jc/types';
import { Button, cx, Modal } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ActionBar } from '../../game/ActionBar';
import { TableScene, useBoxSize, useTableLayout } from '../../game/TableScene';
import { useAuth } from '../../lib/auth';
import { useI18n, type MsgKey } from '../../lib/i18n';
import { currentHand, l, useTr, type L } from '../content';
import { HAND_RANKS } from '../data/hands';
import { PracticeSession } from '../practice/runner';
import { buildScenarios, type PracticeQuestion, type Scenario } from '../practice/scenarios';
import { completeScenario, missScenario, recordAnswer, SCENARIO_IDS, startScenario, updateProgress, useProgress, type ScenarioId, type Topic } from '../progress';
import { track } from '../sync';
import { HandRankingChart, UI } from '../ui';

const T = {
  title: l('Lesson 5 · 연습 게임', 'Lesson 5 · Practice'),
  sub: l('실제 테이블 화면에서 시나리오를 따라 플레이합니다. 연습 칩만 쓰며 지갑·핸드 기록·통계에는 아무 영향이 없습니다.', 'Play guided scenarios on the real table screen. Practice chips only: your wallet, hand history and stats are never touched.'),
  play: l('시작', 'Play'),
  again: l('다시 하기', 'Play again'),
  next: l('다음 시나리오', 'Next scenario'),
  list: l('시나리오 목록', 'All scenarios'),
  done: l('완료', 'Done'),
  auto: l('남은 진행은 자동으로 플레이합니다…', 'Playing the rest automatically…'),
  offScript: l('이번 연습에서는 다른 액션을 눌러 보세요: ', 'For this exercise, try this instead: '),
  thinking: l('{name} 생각 중…', '{name} is thinking…'),
  practice: l('연습 모드', 'Practice mode'),
  chart: l('족보표', 'Hand chart'),
  allDone: l('모든 연습을 마쳤습니다! 이제 실제 테이블에서 플레이해 보세요.', 'All practice done! Time for a real table.'),
  toLobby: l('로비로 가기', 'Go to the lobby'),
  me: l('내가 승리', 'I win'),
  opp: l('상대 승리', 'Opponent wins'),
  split: l('무승부', 'Split'),
  fault: l('연습 진행 중 문제가 생겼습니다. 시나리오를 처음부터 다시 시작해 주세요.', 'Something went wrong in this practice. Please restart the scenario.'),
  stats: l('시도 {tries}회 · 실수 {misses}회', 'Attempts {tries} · mistakes {misses}'),
  free: l('자유 연습', 'Free practice'),
  freeDesc: l('정답 안내 없이 규칙 기반 봇과 직접 판단하며 플레이', 'No coaching: decide for yourself against rule-based bots'),
  guided: l('가이드 연습', 'Guided practice'),
};

export function PracticeListPage() {
  const tr = useTr();
  const { me } = useAuth();
  const p = useProgress(me?.id);
  const scenarios = useMemo(() => buildScenarios(me?.nickname ?? 'You'), [me?.nickname]);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4" data-testid="practice-list">
      <Link to="/academy" className="jc-tap -ml-2 self-start rounded-lg px-2 py-2 text-sm text-ink-300 hover:text-ivory">
        ← {tr(UI.back)}
      </Link>
      <h1 className="font-display text-xl font-bold tracking-[0.08em] text-gold-300 sm:text-2xl">{tr(T.title)}</h1>
      <p className="text-sm text-ink-300">{tr(T.sub)}</p>
      <Link to="/academy/practice/free" className="jc-tap jc-panel flex items-center gap-3 border-gold-500/40 p-4 transition hover:border-gold-400/70" data-testid="scenario-free">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-500/15 text-xl text-gold-300">♣</span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-ivory">{tr(T.free)}</span>
          <span className="block text-xs text-ink-300">{tr(T.freeDesc)}</span>
        </span>
        <span className="text-xs font-semibold text-gold-300">{tr(T.play)} →</span>
      </Link>
      <h2 className="mt-2 text-sm font-bold tracking-[0.06em] text-gold-300">{tr(T.guided)}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {scenarios.map((s) => {
          const done = !!p.practice[s.id];
          const st = p.scenarioStats[s.id];
          return (
            <Link key={s.id} to={`/academy/practice/${s.id}`} className="jc-tap jc-panel flex items-center gap-3 p-4 transition hover:border-gold-500/40" data-testid={`scenario-${s.id}`}>
              <span className={cx('grid size-11 shrink-0 place-items-center rounded-xl font-display text-lg font-bold', done ? 'bg-gold-500 text-ink-950' : 'bg-ink-700 text-gold-300')}>{done ? '✓' : s.id}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-ivory">{tr(s.title)}</span>
                <span className="block text-xs text-ink-300">{tr(s.goal)}</span>
                {st && <span className="block text-[11px] text-ink-400">{tr(T.stats, { tries: st.tries, misses: st.misses })}</span>}
              </span>
              <span className="text-xs font-semibold text-gold-300">{done ? tr(T.done) : tr(T.play)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

interface Asked {
  q: PracticeQuestion;
  index: number;
  options: { id: string; label: string }[];
  answer: string;
  picked: string | null;
}

function buildQuestion(q: PracticeQuestion, index: number, v: TableView, sc: Scenario, tr: (x: L) => string, t: (k: MsgKey) => string): Asked {
  if (q.kind === 'handName') {
    const me = v.seats.find((s) => s.seatIndex === sc.hero)!;
    const ev = currentHand(me.holeCards ?? sc.holes[sc.hero]!, v.hand!.board)!;
    const key = handLabelKey(ev.rankClass, ev.bestFive);
    const at = HAND_RANKS.findIndex((h) => h.key === key);
    // Correct answer plus its neighbours in the ranking, in ranking order.
    const pick = [at - 2, at - 1, at, at + 1, at + 2].filter((i) => i >= 0 && i < HAND_RANKS.length);
    const ids = (pick.length > 4 ? (at < 2 ? pick.slice(0, 4) : pick.slice(-4)) : pick).map((i) => HAND_RANKS[i]!.key);
    return { q, index, options: ids.map((id) => ({ id, label: t(`hand.${id}` as MsgKey) })), answer: key, picked: null };
  }
  if (q.kind === 'winner') {
    const winners = v.hand!.result!.winners.map((w) => w.seatIndex);
    const answer = winners.length > 1 ? 'split' : winners[0] === sc.hero ? 'me' : 'opp';
    return { q, index, options: (['me', 'opp', 'split'] as const).map((id) => ({ id, label: tr(T[id]) })), answer, picked: null };
  }
  const pots = v.hand!.pots;
  const total = pots.reduce((a, p) => a + p.amount, 0);
  const amounts = [...new Set([pots[0]!.amount, total, pots[1]?.amount ?? total / 2])].sort((a, b) => a - b);
  return { q, index, options: amounts.map((a) => ({ id: String(a), label: a.toLocaleString() })), answer: String(pots[0]!.amount), picked: null };
}

function questionDue(q: PracticeQuestion, s: PracticeSession): boolean {
  if (q.at === 'settled') return s.settled;
  return !s.settled && s.stage === q.at;
}

export function PracticeTablePage() {
  const { id = 'A' } = useParams();
  const sid = ((SCENARIO_IDS as readonly string[]).includes(id) ? id : 'A') as ScenarioId;
  // Remount on scenario change or "play again".
  const [round, setRound] = useState(0);
  return <PracticeTable key={`${sid}-${round}`} id={sid} onAgain={() => setRound((r) => r + 1)} />;
}

function PracticeTable({ id, onAgain }: { id: ScenarioId; onAgain: () => void }) {
  const tr = useTr();
  const { t } = useI18n();
  const { me } = useAuth();
  const nav = useNavigate();
  const sc = useMemo(() => buildScenarios(me?.nickname ?? 'You').find((s) => s.id === id)!, [id, me?.nickname]);
  const session = useRef<PracticeSession | null>(null);
  if (!session.current) session.current = new PracticeSession(sc);
  const s = session.current;
  const [view, setView] = useState<TableView>(() => s.view());
  const [cues, setCues] = useState(s.cues);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [answered, setAnswered] = useState<Set<number>>(() => new Set());
  const [finished, setFinished] = useState(false);
  const [chart, setChart] = useState(false);
  const [fault, setFault] = useState(false);
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const layout = useTableLayout(area, view.table.maxSeats, sc.hero);
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const delay = reducedMotion ? 350 : 800;

  useEffect(() => sound.installAutoUnlock(), []);
  useEffect(() => {
    if (me) updateProgress(me.id, (p) => startScenario(p, sc.id));
    track({ kind: 'scenario', id: sc.id, phase: 'start' });
  }, [sc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => {
    setView(s.view());
    setCues([...s.cues]);
  }, [s]);
  /** Runs one engine step; an unexpected error stops the loop and offers a restart instead of freezing. */
  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        console.error(`[practice] scenario ${sc.id} stopped`, e);
        setFault(true);
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh, sc.id],
  );

  // Drive the hand: questions first, then opponents / auto-play, waiting for the hero when it is their turn.
  useEffect(() => {
    if (asked || finished || busy || fault) return;
    const due = sc.questions.findIndex((q, i) => !answered.has(i) && questionDue(q, s));
    if (due >= 0) {
      setAsked(buildQuestion(sc.questions[due]!, due, s.view(), sc, tr, t));
      return;
    }
    if (s.settled) {
      if (me) updateProgress(me.id, (p) => completeScenario(p, sc.id, Date.now()));
      track({ kind: 'scenario', id: sc.id, phase: 'complete' });
      sound.play('complete');
      setFinished(true);
      return;
    }
    const heroTurn = s.isHeroTurn();
    if (heroTurn && s.currentStep()) return; // waiting for the player
    const h = setTimeout(() => void guard(() => (heroTurn ? s.heroAct(s.autoHeroAction().type) : s.step())), delay);
    return () => clearTimeout(h);
  }, [view, asked, finished, busy, fault, answered, s, sc, me, delay, guard, tr, t]);

  const onAct = useCallback(
    async (type: ActionType, amount?: number) => {
      const chk = s.checkHero(type, amount);
      if (!chk.ok) {
        const step = s.currentStep();
        const want = step ? (Array.isArray(step.expect) ? step.expect : [step.expect]).map((x) => t(`action.${x}` as MsgKey)).join(' / ') : '';
        setWarn(`${tr(T.offScript)}${want}${step?.minTo ? ` (≥ ${step.minTo})` : ''}`);
        if (me) updateProgress(me.id, (p) => missScenario(p, sc.id, 'actions'));
        sound.play('wrong');
        return;
      }
      setWarn(null);
      await guard(() => s.heroAct(type, amount));
    },
    [s, guard, t, tr, me, sc.id],
  );

  const answer = (opt: string) => {
    if (!asked || asked.picked === asked.answer) return;
    const ok = opt === asked.answer;
    const topic: Topic = asked.q.kind === 'handName' ? 'hand-names' : asked.q.kind === 'mainPot' ? 'pots' : 'hand-order';
    if (me) updateProgress(me.id, (p) => (ok ? recordAnswer(p, true, topic) : missScenario(p, sc.id, topic)));
    track({ kind: 'question', id: `practice:${sc.id}:${asked.index}`, correct: ok });
    sound.play(ok ? 'correct' : 'wrong');
    setAsked({ ...asked, picked: opt });
  };
  const closeQuestion = () => {
    if (!asked) return;
    setAnswered((a) => new Set(a).add(asked.index));
    setAsked(null);
  };

  // A pending "who won?" question hides the result and the payout chips until answered.
  const winnerPending = s.settled && sc.questions.some((q, i) => q.kind === 'winner' && !answered.has(i)) && !(asked?.q.kind === 'winner' && asked.picked === asked.answer);
  const hideResult = winnerPending;
  const shown: TableView = hideResult && view.hand ? { ...view, hand: { ...view.hand, result: view.hand.result && { ...view.hand.result, winners: [], showdown: [] } } } : view;
  const heroTurn = s.isHeroTurn() && !asked && !finished && !!s.currentStep();
  const step = s.currentStep();
  const actor = view.hand?.actorSeat;
  const thinking = !heroTurn && !asked && !finished && actor !== null && actor !== undefined && actor !== sc.hero ? sc.seats.find((x) => x.index === actor)?.name : null;
  const idx = SCENARIO_IDS.indexOf(sc.id);
  const stats = useProgress(me?.id).scenarioStats[sc.id];
  const nextId = SCENARIO_IDS[idx + 1];

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: 'var(--t-bg)' }} data-testid="practice-table" data-scenario={sc.id}>
      <header className="jc-game-surface z-40 flex h-14 shrink-0 items-center gap-2 border-b border-gold-500/10 bg-ink-950/70 px-3 backdrop-blur-md">
        <Link to="/academy/practice" className="jc-tap grid size-10 place-items-center rounded-lg text-ink-200" aria-label={tr(T.list)}>
          ←
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-ivory">
            {sc.id}. {tr(sc.title)}
          </div>
          <div className="truncate text-[11px] text-gold-300">
            {tr(T.practice)} · {t(`stage.${view.hand?.stage ?? 'preflop'}` as MsgKey)}
          </div>
        </div>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setChart(true)} data-testid="practice-chart">
          {tr(T.chart)}
        </Button>
      </header>

      {/* coach */}
      <div className="z-30 px-3 pt-2">
        <div className={cx('mx-auto max-w-2xl rounded-xl border px-3 py-2 text-sm', warn ? 'jc-shake border-danger/50 bg-danger/10 text-[#f3c3c4]' : 'border-gold-500/30 bg-ink-900/90 text-ivory')} role="status" aria-live="polite" data-testid="coach">
          {warn ?? (finished ? tr(sc.outro) : heroTurn && step ? tr(step.coach) : thinking ? tr(T.thinking).replace('{name}', thinking) : !s.currentStep() && !s.settled ? tr(T.auto) : tr(sc.intro))}
        </div>
      </div>

      <div className="jc-game-surface relative flex min-h-0 flex-1 flex-col">
        <div ref={areaRef} className="relative mx-2 mb-[6.75rem] mt-1 flex min-h-0 flex-1 items-center justify-center sm:mx-6 sm:mb-24">
          <TableScene
            s={shown}
            layout={layout}
            mySeat={sc.hero}
            canSit={false}
            onSit={() => {}}
            nextIn={null}
            cues={winnerPending ? cues.filter((c) => c.cue.kind !== 'payout') : cues}
            consumeCues={(up) => {
              s.consumeCues(up);
              setCues([...s.cues]);
            }}
            reducedMotion={reducedMotion}
          />
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-6">
          {asked && (
            <div className="jc-panel pointer-events-auto flex w-full max-w-md flex-col gap-2 p-3" data-testid="practice-question">
              <div className="font-bold text-gold-300">{tr(asked.q.prompt)}</div>
              <div className="grid grid-cols-2 gap-2">
                {asked.options.map((o) => (
                  <button
                    key={o.id}
                    data-choice={o.id}
                    onClick={() => answer(o.id)}
                    className={cx(
                      'jc-tap min-h-12 rounded-xl border px-2 text-sm font-semibold',
                      asked.picked === o.id ? (o.id === asked.answer ? 'jc-pop border-success bg-success/15' : 'jc-shake border-danger bg-danger/10') : 'border-white/10 bg-ink-850 text-ivory',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {asked.picked && asked.picked !== asked.answer && <p className="text-xs text-[#f3c3c4]">{tr(UI.wrong)}</p>}
              {asked.picked === asked.answer && (
                <Button onClick={closeQuestion} data-testid="practice-continue">
                  {tr(UI.correct)} {tr(UI.next)} →
                </Button>
              )}
            </div>
          )}
          {fault && (
            <div className="jc-panel pointer-events-auto flex w-full max-w-md flex-col gap-2 border-danger/50 p-4" role="alert" data-testid="practice-fault">
              <p className="text-sm text-[#f3c3c4]">{tr(T.fault)}</p>
              <Button onClick={onAgain}>{tr(T.again)}</Button>
            </div>
          )}
          {finished && (
            <div className="jc-panel jc-pop pointer-events-auto flex w-full max-w-md flex-col gap-2 p-4" data-testid="practice-done">
              <div className="text-lg font-bold text-gold-300">✓ {tr(sc.title)}</div>
              {stats && (
                <p className="text-xs text-ink-300" data-testid="practice-stats">
                  {tr(T.stats, { tries: stats.tries, misses: stats.misses })}
                </p>
              )}
              {!nextId && <p className="text-sm text-ivory">{tr(T.allDone)}</p>}
              <div className="flex flex-wrap gap-2">
                {nextId ? (
                  <Button onClick={() => nav(`/academy/practice/${nextId}`)} data-testid="practice-next">
                    {tr(T.next)} →
                  </Button>
                ) : (
                  <Button onClick={() => nav('/')}>{tr(T.toLobby)} →</Button>
                )}
                <Button variant="outline" onClick={onAgain}>
                  {tr(T.again)}
                </Button>
                <Button variant="ghost" onClick={() => nav('/academy/practice')}>
                  {tr(T.list)}
                </Button>
              </div>
            </div>
          )}
          {heroTurn && <ActionBar state={view} onAct={onAct} busy={busy} />}
        </div>
      </div>

      <Modal open={chart} onClose={() => setChart(false)} title={tr(T.chart)}>
        <HandRankingChart compact />
      </Modal>
    </div>
  );
}
