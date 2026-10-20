/**
 * Advanced GTO Academy pages (/academy/gto/*), one lazy chunk apart from the beginner course: the course home, a
 * module's lesson steps with their tools and its review, the quiz bank, hand analyses, the glossary and a review of
 * what went wrong. Progress is recorded for signed-in members only, in the course's own store (./progress). The
 * current step lives in the URL and the rest in component state, so switching the language keeps the learner's place.
 */
import { sound } from '@jc/audio';
import { Button, cx } from '@jc/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../lib/auth';
import { HAND_PAGE, useBack } from '../../lib/back';
import { useI18n } from '../../lib/i18n';
import { l, useTr, type L } from '../content';
import { isDone, useProgress, type LessonId } from '../progress';
import { track } from '../sync';
import { calcSteps } from './explain';
import { GLOSSARY } from './glossary';
import { HANDS } from './hands';
import { num } from './math';
import { MODULE_BY_ID, MODULES } from './modules';
import { CardsView, Mark, Note, OptionList, Out, Steps } from './parts';
import { answerHand, answerQuiz, completeModule, gtoPercent, gtoSummary, moduleDone, nextModule, resetGto, updateGto, useGtoProgress, visitStep, weakModules, type GtoAnswer, type GtoCatalog } from './progress';
import { QUIZZES } from './quizzes';
import { useGtoSync } from './sync';
import { GtoTool } from './tools';
import { GTO_MODULES, type GtoHandAnalysis, type GtoModuleId, type GtoQuiz, type GtoSection } from './types';

const CATALOG: GtoCatalog = { quizzes: QUIZZES, hands: HANDS };

const T = {
  brand: l('고급 GTO 아카데미', 'Advanced GTO Academy'),
  hero: l('레인지·확률·베팅 크기·균형과 그 활용까지, 숫자로 이해하는 포커 이론.', 'Ranges, odds, bet sizes, balance and when to leave it: poker theory you can check with numbers.'),
  original: l(
    '모든 설명·예시·문제는 이 아카데미가 직접 만든 학습용 자료입니다. 숫자는 각 화면이 밝힌 단순 모델로 계산한 값이며, 솔버 결과가 아닙니다.',
    'Every explanation, example and question here was written for this academy. The numbers come from the simple model each screen states; none of them is solver output.',
  ),
  home: l('코스 홈', 'Course'),
  quiz: l('퀴즈', 'Quizzes'),
  hands: l('핸드 분석', 'Hands'),
  glossary: l('용어', 'Glossary'),
  review: l('복습', 'Review'),
  toBeginner: l('← 아카데미', '← Academy'),
  toHand: l('← 핸드로 돌아가기', '← Back to the hand'),
  progress: l('고급 과정 진행률', 'Advanced course progress'),
  parts: l('모듈 {m}/{M} · 맞힌 퀴즈 {q}/{Q} · 핸드 분석 {h}/{H}', 'Modules {m}/{M} · quizzes right {q}/{Q} · hands {h}/{H}'),
  start: l('첫 모듈 시작하기', 'Start the first module'),
  cont: l('이어서 학습하기', 'Continue'),
  allDone: l('모든 모듈 완료! 복습하기', 'All modules done! Review'),
  guest: l('로그인하면 진행 상황이 계정에 저장됩니다. 지금은 풀어 보기만 할 수 있습니다.', 'Sign in to save your progress to your account. For now you can try everything, but nothing is recorded.'),
  prereq: l('먼저 알면 좋은 것', 'Good to know first'),
  prereqSub: l('초보 과정을 끝내지 않아도 바로 시작할 수 있습니다. 아래 내용이 낯설다면 먼저 보고 오세요.', 'You can start right away without finishing the beginner course. If these are new to you, look at them first.'),
  modules: l('모듈', 'Modules'),
  weak: l('다시 볼 개념', 'Concepts to revisit'),
  weakSub: l('최근 답이 틀린 문제가 있는 모듈입니다.', 'Modules with a question whose latest answer was wrong.'),
  done: l('완료', 'Done'),
  inProgress: l('{s}/{n}단계', 'Step {s}/{n}'),
  quizCount: l('퀴즈 {n}', '{n} quizzes'),
  reset: l('고급 과정 진행 기록 지우기', 'Clear advanced course progress'),
  resetAsk: l('고급 과정의 진행 기록만 지웁니다(초보 과정 기록은 그대로). 계속할까요?', 'This clears the advanced course progress only (the beginner course is kept). Go ahead?'),
  resetYes: l('네, 지웁니다', 'Yes, clear it'),
  cancel: l('취소', 'Cancel'),
  resetDone: l('고급 과정 기록을 지웠습니다.', 'The advanced course progress was cleared.'),
  goals: l('이 모듈을 마치면', 'After this module you can'),
  step: l('단계', 'Step'),
  prev: l('이전', 'Back'),
  next: l('다음', 'Next'),
  reviewStep: l('정리', 'Review'),
  reviewTitle: l('이 모듈 정리', 'This module in brief'),
  moduleQuiz: l('이 모듈의 퀴즈 풀기 ({n})', 'Take this module’s quizzes ({n})'),
  moduleHands: l('이 모듈의 핸드 분석 ({n})', 'This module’s hand analyses ({n})'),
  finish: l('모듈 완료', 'Finish module'),
  finished: l('모듈 완료!', 'Module complete!'),
  nextModule: l('다음 모듈: {t}', 'Next module: {t}'),
  toHome: l('코스 홈으로', 'Back to the course'),
  freePractice: l('자유 연습에서 직접 해 보기', 'Try it in free practice'),
  example: l('예시', 'Example'),
  all: l('전체', 'All'),
  onlyWrong: l('틀린 문제만', 'Wrong ones only'),
  question: l('문제 {i}/{n}', 'Question {i}/{n}'),
  correct: l('정답입니다!', 'Correct!'),
  wrong: l('오답입니다. 정답과 풀이를 확인하세요.', 'Not this one. See the answer and the working.'),
  retry: l('다시 풀기', 'Try again'),
  record: l('이 문제 기록: 정답 {c} · 오답 {w}', 'Your record here: {c} right · {w} wrong'),
  noneLeft: l('여기에 해당하는 문제가 없습니다.', 'No questions here.'),
  finishedSet: l('이 묶음을 다 풀었습니다.', 'You reached the end of this set.'),
  again: l('처음부터 다시', 'From the start'),
  handList: l('핸드 분석', 'Hand analyses'),
  handListSub: l('실제 같은 상황에서 결정을 내리고, 단계별 근거와 가정을 확인하세요.', 'Make the decision in a realistic spot, then check the reasoning step by step and the assumptions.'),
  heroHand: l('내 핸드', 'Your hand'),
  board: l('보드', 'Board'),
  noBoard: l('프리플랍 (보드 없음)', 'Preflop (no board)'),
  pot: l('지금 팟', 'Pot now'),
  potWithBet: l('지금 팟 (상대 베팅 포함)', 'Pot now (with the bet)'),
  toCall: l('콜에 드는 칩', 'To call'),
  firstToAct: l('먼저 행동', 'You act first'),
  reasoning: l('근거', 'Reasoning'),
  takeaway: l('핵심', 'Takeaway'),
  listBack: l('← 핸드 목록', '← All hands'),
  prevHand: l('이전 핸드', 'Previous hand'),
  nextHand: l('다음 핸드', 'Next hand'),
  new: l('새 문제', 'New'),
  searchLabel: l('용어 찾기', 'Find a term'),
  searchPh: l('예: 에퀴티, MDF', 'e.g. equity, MDF'),
  openModule: l('{t} 모듈로', 'Open {t}'),
  reviewHead: l('복습', 'Review'),
  answered: l('푼 횟수 {n} · 정답률 {p}', '{n} answers · {p} right'),
  noWeak: l('최근에 틀린 문제가 없습니다. 잘하고 있어요!', 'No recent wrong answers. Nice work!'),
  wrongQuizzes: l('최근에 틀린 퀴즈', 'Quizzes you last got wrong'),
  wrongHands: l('최근에 틀린 핸드 분석', 'Hand analyses you last got wrong'),
  retryWrong: l('틀린 퀴즈 다시 풀기', 'Retry the wrong quizzes'),
  practiseModule: l('이 모듈 퀴즈 풀기', 'Practise this module'),
  allReviews: l('모듈별 정리', 'Every module in brief'),
};

const STREET: Record<GtoHandAnalysis['street'], L> = { preflop: l('프리플랍', 'Preflop'), flop: l('플랍', 'Flop'), turn: l('턴', 'Turn'), river: l('리버', 'River') };

/** Beginner lessons that make the advanced course easier; shown as a suggestion, never a lock. */
const PREREQS: { id: LessonId; title: L; to: string }[] = [
  { id: 'hands', title: l('포커 족보', 'Hand rankings'), to: '/academy/hands' },
  { id: 'holdem', title: l('텍사스 홀덤 규칙', "Texas hold'em rules"), to: '/academy/holdem' },
  { id: 'actions', title: l('베팅 액션', 'Betting actions'), to: '/academy/actions' },
];

const moduleNo = (id: GtoModuleId) => GTO_MODULES.indexOf(id) + 1;
const quizzesOf = (id: GtoModuleId) => QUIZZES.filter((q) => q.module === id);
const handsOf = (id: GtoModuleId) => HANDS.filter((h) => h.module === id);

function useMe() {
  return useAuth().me;
}

// ------------------------------------------------------------------ layout

const TABS: { to: string; label: L; end?: boolean; testid: string }[] = [
  { to: '/academy/gto', label: T.home, end: true, testid: 'gto-tab-home' },
  { to: '/academy/gto/quiz', label: T.quiz, testid: 'gto-tab-quiz' },
  { to: '/academy/gto/hands', label: T.hands, testid: 'gto-tab-hands' },
  { to: '/academy/gto/glossary', label: T.glossary, testid: 'gto-tab-glossary' },
  { to: '/academy/gto/review', label: T.review, testid: 'gto-tab-review' },
];

export function GtoLayout() {
  const tr = useTr();
  const me = useMe();
  // Opened from a hand's review, back goes to that hand.
  const back = useBack(HAND_PAGE, '/academy');
  useGtoSync(me?.id);
  useEffect(() => sound.installAutoUnlock(), []);
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4" data-testid="gto">
      <div className="flex items-center justify-between gap-2 text-sm">
        <Link to={back.to} onClick={back.onClick} className="jc-tap -ml-2 rounded-lg px-2 py-2 text-ink-300 hover:text-ivory" data-testid="gto-back">
          {tr(back.from ? T.toHand : T.toBeginner)}
        </Link>
        <span className="truncate font-display text-xs font-bold tracking-[0.2em] text-gold-400">GTO</span>
      </div>
      <nav aria-label={tr(T.brand)} className="grid grid-cols-5 gap-1 rounded-xl border border-white/10 bg-ink-900/60 p-1">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            data-testid={t.testid}
            className={({ isActive }) => cx('jc-tap flex min-h-10 items-center justify-center rounded-lg px-1 text-center text-xs font-semibold leading-tight sm:text-sm', isActive ? 'bg-gold-500 text-ink-950' : 'text-ink-300 hover:text-ivory')}
          >
            {tr(t.label)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

// ------------------------------------------------------------------ home

export function GtoHome() {
  const tr = useTr();
  const me = useMe();
  const nav = useNavigate();
  const p = useGtoProgress(me?.id);
  const basics = useProgress(me?.id);
  const pct = gtoPercent(p, CATALOG);
  const s = gtoSummary(p, CATALOG);
  const next = nextModule(p);
  const weak = weakModules(p, CATALOG);
  const started = Object.keys(p.modules).length > 0;
  const [asking, setAsking] = useState(false);
  const [cleared, setCleared] = useState(false);

  return (
    <div className="flex flex-col gap-5" data-testid="gto-home">
      <section className="jc-panel relative overflow-hidden p-5 sm:p-7">
        <div className="relative flex flex-col gap-4">
          <div>
            <div className="font-display text-xs font-bold tracking-[0.3em] text-gold-400">JC ROYAL ACADEMY</div>
            <h1 className="mt-1 text-2xl font-bold text-ivory sm:text-3xl">{tr(T.brand)}</h1>
            <p className="mt-1 text-sm text-ink-300">{tr(T.hero)}</p>
          </div>
          <p className="rounded-lg border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-xs leading-relaxed text-ink-200" data-testid="gto-original">
            ⓘ {tr(T.original)}
          </p>
          <div>
            <div className="mb-1.5 flex justify-between text-xs font-semibold text-ink-300">
              <span>{tr(T.progress)}</span>
              <span className="font-mono text-gold-300" data-testid="gto-percent">
                {pct}%
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={tr(T.progress)} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-gradient-to-r from-gold-600 to-gold-300 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 text-xs text-ink-400" data-testid="gto-parts">
              {tr(T.parts, { m: s.modules, M: GTO_MODULES.length, q: s.quizzes, Q: QUIZZES.length, h: s.hands, H: HANDS.length })}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => nav(next ? `/academy/gto/${next.module}?step=${next.step}` : '/academy/gto/review')} data-testid="gto-continue">
              {next ? (started ? tr(T.cont) : tr(T.start)) : tr(T.allDone)} →
            </Button>
            <Button size="lg" variant="outline" onClick={() => nav('/academy/gto/quiz')}>
              {tr(T.quiz)}
            </Button>
            <Button size="lg" variant="outline" onClick={() => nav('/academy/gto/hands')}>
              {tr(T.hands)}
            </Button>
          </div>
          {!me && <p className="text-xs text-ink-400" data-testid="gto-guest">{tr(T.guest)}</p>}
        </div>
      </section>

      <section className="jc-panel flex flex-col gap-2 p-4" data-testid="gto-prereq">
        <h2 className="text-sm font-bold text-gold-300">{tr(T.prereq)}</h2>
        <p className="text-xs text-ink-300">{tr(T.prereqSub)}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {PREREQS.map((x) => {
            const done = isDone(basics, x.id);
            return (
              <Link key={x.id} to={x.to} className="jc-tap flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-ink-850 px-3 py-2 text-sm text-ivory hover:border-gold-500/50" data-prereq={x.id} data-done={done ? '1' : '0'}>
                <span aria-hidden className={cx('grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold', done ? 'bg-gold-500 text-ink-950' : 'bg-ink-700 text-ink-300')}>
                  {done ? '✓' : '·'}
                </span>
                <span className="min-w-0 flex-1">{tr(x.title)}</span>
                {done && <span className="text-xs text-gold-300">{tr(T.done)}</span>}
              </Link>
            );
          })}
        </div>
      </section>

      {weak.length > 0 && (
        <section className="jc-panel flex flex-col gap-2 border-danger/30 p-4" data-testid="gto-weak">
          <h2 className="text-sm font-bold text-gold-300">{tr(T.weak)}</h2>
          <p className="text-xs text-ink-300">{tr(T.weakSub)}</p>
          <div className="flex flex-wrap gap-2">
            {weak.map((w) => (
              <Link key={w.module} to={`/academy/gto/quiz?module=${w.module}`} className="jc-tap rounded-full border border-white/10 bg-ink-850 px-3 py-1.5 text-xs font-semibold text-ivory hover:border-gold-500/50">
                {tr(MODULE_BY_ID[w.module].title)} <span className="ml-1 rounded-full bg-danger-strong px-1.5 text-[11px] text-white">{w.count}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold tracking-[0.06em] text-gold-300">{tr(T.modules)}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODULES.map((m) => {
            const done = moduleDone(p, m.id);
            const mp = p.modules[m.id];
            return (
              <Link key={m.id} to={`/academy/gto/${m.id}${mp && !done ? `?step=${mp.step}` : ''}`} className="jc-tap jc-panel flex items-center gap-3 p-4 transition hover:border-gold-500/40" data-testid={`gto-module-${m.id}`}>
                <span className={cx('grid size-11 shrink-0 place-items-center rounded-xl font-mono text-lg font-bold', done ? 'bg-gold-500 text-ink-950' : 'bg-ink-700 text-gold-300')}>{done ? '✓' : moduleNo(m.id)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    Module {moduleNo(m.id)} · {tr(T.quizCount, { n: quizzesOf(m.id).length })}
                  </span>
                  <span className="block font-bold text-ivory">{tr(m.title)}</span>
                  <span className="block text-xs text-ink-300">{tr(m.summary)}</span>
                </span>
                <span className={cx('shrink-0 text-xs font-semibold', done ? 'text-gold-300' : 'text-ink-400')}>{done ? tr(T.done) : mp ? tr(T.inProgress, { s: Math.min(mp.step + 1, m.steps.length + 1), n: m.steps.length + 1 }) : null}</span>
              </Link>
            );
          })}
        </div>
      </section>

      {me && (started || Object.keys(p.quiz).length + Object.keys(p.hands).length > 0) && (
        <section className="flex flex-col items-start gap-2 pb-4">
          {asking ? (
            <div className="jc-panel flex w-full flex-col gap-3 border-danger/40 p-4" role="group" data-testid="gto-reset-confirm">
              <p className="text-sm text-ivory">{tr(T.resetAsk)}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  onClick={() => {
                    resetGto(me.id);
                    setAsking(false);
                    setCleared(true);
                  }}
                  data-testid="gto-reset-yes"
                >
                  {tr(T.resetYes)}
                </Button>
                <Button variant="ghost" onClick={() => setAsking(false)}>
                  {tr(T.cancel)}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setAsking(true)} data-testid="gto-reset">
              {tr(T.reset)}
            </Button>
          )}
        </section>
      )}
      {cleared && (
        <p role="status" className="pb-4 text-xs text-ink-300">
          {tr(T.resetDone)}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ module (lesson)

function Section({ s }: { s: GtoSection }) {
  const tr = useTr();
  return (
    <div className="flex flex-col gap-2">
      {s.title && <h3 className="text-sm font-bold text-gold-300">{tr(s.title)}</h3>}
      {s.paras.map((x, i) => (
        <p key={i} className="text-sm leading-relaxed text-ink-100">
          {tr(x)}
        </p>
      ))}
      {s.bullets && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-ink-100">
          {s.bullets.map((x, i) => (
            <li key={i}>{tr(x)}</li>
          ))}
        </ul>
      )}
      {s.example && (
        <div className="rounded-xl border border-info/30 bg-ink-900/60 p-3">
          <div className="mb-1 text-xs font-bold text-info">
            {tr(T.example)} · {tr(s.example.title)}
          </div>
          <ol className="flex flex-col gap-0.5 text-xs leading-relaxed text-ink-100">
            {s.example.lines.map((x, i) => (
              <li key={i}>{tr(x)}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function GtoModulePage() {
  const { module } = useParams();
  if (!module || !(GTO_MODULES as readonly string[]).includes(module)) return <Navigate to="/academy/gto" replace />;
  return <ModuleView id={module as GtoModuleId} key={module} />;
}

function ModuleView({ id }: { id: GtoModuleId }) {
  const tr = useTr();
  const me = useMe();
  const nav = useNavigate();
  const m = MODULE_BY_ID[id];
  const p = useGtoProgress(me?.id);
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const total = m.steps.length + 1; // the lesson steps, then the review
  const step = Math.min(total - 1, Math.max(0, Number(params.get('step') ?? 0) || 0));
  const isReview = step === m.steps.length;
  const cur = isReview ? null : m.steps[step]!;
  const [finished, setFinished] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const after = GTO_MODULES[GTO_MODULES.indexOf(id) + 1];

  useEffect(() => track({ kind: 'lesson', id: `gto:${id}`, phase: 'start' }), [id]);
  useEffect(() => {
    if (me) updateGto(me.id, (x) => visitStep(x, id, step, Date.now()));
  }, [me, id, step]);

  const go = (s: number) => {
    // The state keeps where the module was opened from (the way back to a hand).
    setParams({ step: String(s) }, { replace: true, state: loc.state });
    setFinished(false);
    top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const finish = () => {
    if (me) updateGto(me.id, (x) => completeModule(x, id, Date.now()));
    track({ kind: 'lesson', id: `gto:${id}`, phase: 'complete' });
    sound.play('complete');
    setFinished(true);
  };
  const qs = quizzesOf(id).length;
  const hs = handsOf(id).length;

  return (
    <div ref={top} className="flex scroll-mt-20 flex-col gap-4" data-testid={`gto-lesson-${id}`}>
      <header className="flex flex-col gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Module {moduleNo(id)} / {GTO_MODULES.length}
          {moduleDone(p, id) && <span className="ml-2 rounded-full bg-gold-500/20 px-2 py-0.5 text-gold-300">✓ {tr(T.done)}</span>}
        </div>
        <h1 className="font-display text-xl font-bold tracking-[0.04em] text-gold-300 sm:text-2xl">{tr(m.title)}</h1>
        <ol className="flex gap-1.5" aria-label={tr(T.step)}>
          {Array.from({ length: total }, (_, i) => (
            <li key={i} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => go(i)}
                className={cx('jc-tap block h-2.5 w-full rounded-full transition', i < step ? 'bg-gold-500' : i === step ? 'bg-gold-300' : 'bg-white/10')}
                aria-label={`${i + 1}. ${tr(i === m.steps.length ? T.reviewStep : m.steps[i]!.title)}`}
                aria-current={i === step ? 'step' : undefined}
              />
            </li>
          ))}
        </ol>
        <h2 className="text-base font-bold text-ivory" data-testid="gto-step-title">
          <span className="mr-2 font-mono text-gold-400">
            {step + 1}/{total}
          </span>
          {tr(cur ? cur.title : T.reviewStep)}
        </h2>
      </header>

      {step === 0 && (
        <section className="rounded-xl border border-white/10 bg-ink-900/50 p-3">
          <div className="mb-1 text-xs font-bold text-gold-300">{tr(T.goals)}</div>
          <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-ink-100">
            {m.goals.map((g, i) => (
              <li key={i}>{tr(g)}</li>
            ))}
          </ul>
        </section>
      )}

      <section key={step} className="jc-panel animate-rise flex flex-col gap-4 p-4 sm:p-6" data-testid="gto-step-body">
        {cur ? (
          <>
            {cur.sections.map((s, i) => (
              <Section key={i} s={s} />
            ))}
            {cur.tool && <GtoTool kind={cur.tool} />}
          </>
        ) : (
          <div className="flex flex-col gap-3" data-testid="gto-module-review">
            <h3 className="text-sm font-bold text-gold-300">{tr(T.reviewTitle)}</h3>
            <ul className="flex flex-col gap-2 text-sm text-ink-100">
              {m.review.map((x, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className="text-gold-400">
                    ✓
                  </span>
                  <span>{tr(x)}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              {qs > 0 && (
                <Button variant="outline" onClick={() => nav(`/academy/gto/quiz?module=${id}`)} data-testid="gto-module-quiz">
                  {tr(T.moduleQuiz, { n: qs })}
                </Button>
              )}
              {hs > 0 && (
                <Button variant="outline" onClick={() => nav(`/academy/gto/hands?module=${id}`)}>
                  {tr(T.moduleHands, { n: hs })}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      {finished ? (
        <div className="jc-panel jc-pop flex flex-col items-center gap-3 p-6 text-center" data-testid="gto-done" role="status">
          <div className="text-3xl">🏆</div>
          <div className="text-lg font-bold text-gold-300">{tr(T.finished)}</div>
          <div className="flex flex-wrap justify-center gap-2">
            {after && (
              <Button size="lg" onClick={() => nav(`/academy/gto/${after}`)}>
                {tr(T.nextModule, { t: tr(MODULE_BY_ID[after].title) })} →
              </Button>
            )}
            <Button size="lg" variant="outline" onClick={() => nav('/academy/practice/free', { state: { from: loc.pathname + loc.search } })} data-testid="gto-free-practice">
              {tr(T.freePractice)}
            </Button>
            <Button size="lg" variant="outline" onClick={() => nav('/academy/gto')}>
              {tr(T.toHome)}
            </Button>
          </div>
        </div>
      ) : (
        <nav className="flex items-center justify-between gap-3 pb-4">
          <Button variant="ghost" size="lg" disabled={step === 0} onClick={() => go(step - 1)}>
            ← {tr(T.prev)}
          </Button>
          {isReview ? (
            <Button size="lg" onClick={finish} data-testid="gto-finish">
              {tr(T.finish)} ✓
            </Button>
          ) : (
            <Button size="lg" onClick={() => go(step + 1)} data-testid="gto-next">
              {tr(T.next)} →
            </Button>
          )}
        </nav>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ quizzes

function Verdict({ ok }: { ok: boolean }) {
  const tr = useTr();
  return (
    <div role="status" aria-live="polite" className={cx('flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold', ok ? 'jc-pop border-success/40 bg-success/10 text-success-soft' : 'border-danger/40 bg-danger/10 text-danger-soft')} data-testid={ok ? 'gto-correct' : 'gto-wrong'}>
      <Mark ok={ok} />
      {tr(ok ? T.correct : T.wrong)}
    </div>
  );
}

function RecordLine({ a }: { a: GtoAnswer | undefined }) {
  const tr = useTr();
  if (!a) return null;
  return <p className="text-xs text-ink-400">{tr(T.record, { c: a.correct, w: a.wrong })}</p>;
}

export function GtoQuizPage() {
  const tr = useTr();
  const me = useMe();
  const p = useGtoProgress(me?.id);
  const [params, setParams] = useSearchParams();
  const raw = params.get('module');
  const filter = raw && (GTO_MODULES as readonly string[]).includes(raw) ? (raw as GtoModuleId) : null;
  const onlyWrong = params.get('only') === 'wrong';
  const key = `${filter ?? 'all'}:${onlyWrong ? 'wrong' : 'any'}`;
  const set = (next: { module?: GtoModuleId | null; wrong?: boolean }) => {
    const q = new URLSearchParams();
    const mod = next.module === undefined ? filter : next.module;
    const w = next.wrong === undefined ? onlyWrong : next.wrong;
    if (mod) q.set('module', mod);
    if (w) q.set('only', 'wrong');
    setParams(q, { replace: true });
  };
  const wrongCount = QUIZZES.filter((q) => p.quiz[q.id] && !p.quiz[q.id]!.last).length;

  return (
    <div className="flex flex-col gap-4" data-testid="gto-quiz">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr(T.modules)}>
        <Button size="sm" variant={!filter ? 'gold' : 'subtle'} aria-pressed={!filter} onClick={() => set({ module: null })}>
          {tr(T.all)} ({QUIZZES.length})
        </Button>
        {MODULES.map((m) => (
          <Button key={m.id} size="sm" variant={filter === m.id ? 'gold' : 'subtle'} aria-pressed={filter === m.id} onClick={() => set({ module: m.id })} data-filter={m.id}>
            {moduleNo(m.id)}. {tr(m.title)}
          </Button>
        ))}
      </div>
      {me && wrongCount > 0 && (
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input type="checkbox" checked={onlyWrong} onChange={(e) => set({ wrong: e.target.checked })} className="size-5 accent-[var(--color-gold-500)]" data-testid="gto-only-wrong" />
          {tr(T.onlyWrong)} ({wrongCount})
        </label>
      )}
      <QuizRun key={key} filter={filter} onlyWrong={onlyWrong} />
    </div>
  );
}

function QuizRun({ filter, onlyWrong }: { filter: GtoModuleId | null; onlyWrong: boolean }) {
  const tr = useTr();
  const me = useMe();
  const p = useGtoProgress(me?.id);
  // The set is fixed when it opens: answering a "wrong only" question right must not shift the ones after it.
  const [list] = useState<GtoQuiz[]>(() => QUIZZES.filter((q) => (!filter || q.module === filter) && (!onlyWrong || (p.quiz[q.id] && !p.quiz[q.id]!.last))));
  const [i, setI] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const top = useRef<HTMLDivElement>(null);
  if (!list.length) return <p className="jc-panel p-4 text-sm text-ink-300">{tr(T.noneLeft)}</p>;
  const end = i >= list.length;
  const q = list[Math.min(i, list.length - 1)]!;
  const picked = picks[q.id] ?? null;
  const pick = (id: string) => {
    const ok = id === q.answer;
    setPicks((x) => ({ ...x, [q.id]: id }));
    if (me) updateGto(me.id, (x) => answerQuiz(x, q.id, ok, Date.now()));
    track({ kind: 'question', id: `gto:${q.id}`, correct: ok });
    sound.play(ok ? 'correct' : 'wrong');
  };
  const go = (n: number) => {
    setI(n);
    top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  if (end)
    return (
      <div className="jc-panel flex flex-col items-center gap-3 p-6 text-center" role="status" data-testid="gto-quiz-end">
        <div className="text-3xl">🎯</div>
        <p className="font-bold text-gold-300">{tr(T.finishedSet)}</p>
        <Button
          onClick={() => {
            setPicks({});
            go(0);
          }}
        >
          {tr(T.again)}
        </Button>
      </div>
    );
  return (
    <div ref={top} className="jc-panel flex scroll-mt-20 flex-col gap-3 p-4 sm:p-6" data-quiz={q.id}>
      <div className="flex items-center justify-between gap-2 text-xs text-ink-400">
        <span className="font-mono text-gold-400">{tr(T.question, { i: i + 1, n: list.length })}</span>
        <span className="truncate">
          {moduleNo(q.module)}. {tr(MODULE_BY_ID[q.module].title)}
        </span>
      </div>
      <p className="whitespace-pre-line text-base font-semibold leading-relaxed text-ivory" data-testid="gto-quiz-prompt">
        {tr(q.prompt)}
      </p>
      <OptionList options={q.options} answer={q.answer} picked={picked} onPick={pick} label={tr(q.prompt)} />
      {picked !== null && (
        <div className="flex flex-col gap-2" data-testid="gto-quiz-feedback">
          <Verdict ok={picked === q.answer} />
          <p className="text-sm leading-relaxed text-ink-100">{tr(q.explain)}</p>
          {q.calc && <Steps lines={calcSteps(q.calc)} />}
          {q.assumptions && <Note accuracy={q.calc ? 'exact' : 'example'}>{q.assumptions}</Note>}
          <RecordLine a={p.quiz[q.id]} />
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() =>
              setPicks((x) => {
                const n = { ...x };
                delete n[q.id];
                return n;
              })
            }
          >
            ↺ {tr(T.retry)}
          </Button>
        </div>
      )}
      <nav className="flex items-center justify-between gap-3 pt-1">
        <Button variant="ghost" disabled={i === 0} onClick={() => go(i - 1)}>
          ← {tr(T.prev)}
        </Button>
        <Button disabled={picked === null} onClick={() => go(i + 1)} data-testid="gto-quiz-next">
          {tr(T.next)} →
        </Button>
      </nav>
    </div>
  );
}

// ------------------------------------------------------------------ hand analyses

export function GtoHandsPage() {
  const [params] = useSearchParams();
  const id = params.get('id');
  const hand = id ? HANDS.find((h) => h.id === id) : undefined;
  return hand ? <HandView key={hand.id} h={hand} /> : <HandList />;
}

function status(a: GtoAnswer | undefined): 'new' | 'right' | 'wrong' {
  return !a ? 'new' : a.last ? 'right' : 'wrong';
}

function HandList() {
  const tr = useTr();
  const me = useMe();
  const p = useGtoProgress(me?.id);
  const [params, setParams] = useSearchParams();
  const raw = params.get('module');
  const filter = raw && (GTO_MODULES as readonly string[]).includes(raw) ? (raw as GtoModuleId) : null;
  const list = HANDS.filter((h) => !filter || h.module === filter);
  return (
    <div className="flex flex-col gap-3" data-testid="gto-hands">
      <div>
        <h1 className="text-lg font-bold text-gold-300">{tr(T.handList)}</h1>
        <p className="text-xs text-ink-300">{tr(T.handListSub)}</p>
      </div>
      {filter && (
        <Button size="sm" variant="subtle" className="self-start" onClick={() => setParams({}, { replace: true })}>
          {tr(T.all)} ({HANDS.length})
        </Button>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {list.map((h) => {
          const st = status(p.hands[h.id]);
          return (
            <Link key={h.id} to={`/academy/gto/hands?id=${h.id}`} className="jc-tap jc-panel flex items-center gap-3 p-3 transition hover:border-gold-500/40" data-testid={`gto-hand-${h.id}`} data-status={st}>
              <CardsView cards={h.hero} size="1.9rem" />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                  {tr(STREET[h.street])} · {tr(MODULE_BY_ID[h.module].title)}
                </span>
                <span className="block text-sm font-bold text-ivory">{tr(h.title)}</span>
              </span>
              {st === 'new' ? <span className="shrink-0 text-[11px] font-semibold text-ink-400">{tr(T.new)}</span> : <Mark ok={st === 'right'} />}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function HandView({ h }: { h: GtoHandAnalysis }) {
  const tr = useTr();
  const me = useMe();
  const p = useGtoProgress(me?.id);
  const [picked, setPicked] = useState<string | null>(null);
  const back = useBack(HAND_PAGE, '/academy/gto/hands');
  const idx = HANDS.indexOf(h);
  const prev = HANDS[idx - 1];
  const after = HANDS[idx + 1];
  const pick = (id: string) => {
    const ok = id === h.answer;
    setPicked(id);
    if (me) updateGto(me.id, (x) => answerHand(x, h.id, ok, Date.now()));
    track({ kind: 'question', id: `gto:hand:${h.id}`, correct: ok });
    sound.play(ok ? 'correct' : 'wrong');
  };
  return (
    <div className="flex flex-col gap-4" data-testid={`gto-hand-view-${h.id}`}>
      <Link to={back.to} onClick={back.onClick} className="jc-tap -ml-2 self-start rounded-lg px-2 py-1 text-sm text-ink-300 hover:text-ivory" data-testid="gto-hand-back">
        {tr(back.from ? T.toHand : T.listBack)}
      </Link>
      <section className="jc-panel flex flex-col gap-3 p-4 sm:p-6">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          {tr(STREET[h.street])} · {tr(MODULE_BY_ID[h.module].title)}
        </div>
        <h1 className="text-lg font-bold text-gold-300">{tr(h.title)}</h1>
        <p className="text-sm leading-relaxed text-ink-100">{tr(h.spot)}</p>
        <div className="grid grid-cols-[auto_1fr] items-end gap-3">
          <CardsView cards={h.hero} label={tr(T.heroHand)} />
          {h.board.length ? <CardsView cards={h.board} label={tr(T.board)} /> : <div className="pb-3 text-center text-xs text-ink-400">{tr(T.noBoard)}</div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Out label={tr(h.facing > 0 ? T.potWithBet : T.pot)} value={`${num(h.pot + h.facing)} bb`} testid="gto-hand-pot" />
          <Out label={tr(T.toCall)} value={h.facing > 0 ? `${num(h.facing)} bb` : tr(T.firstToAct)} />
        </div>
        <p className="text-base font-semibold text-ivory">{tr(h.question)}</p>
        <OptionList options={h.options} answer={h.answer} picked={picked} onPick={pick} label={tr(h.question)} />
        {picked !== null && (
          <div className="flex flex-col gap-3" data-testid="gto-hand-feedback">
            <Verdict ok={picked === h.answer} />
            <div>
              <div className="mb-1 text-xs font-bold text-gold-300">{tr(T.reasoning)}</div>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed text-ink-100">
                {h.reasoning.map((x, i) => (
                  <li key={i}>{tr(x)}</li>
                ))}
              </ol>
            </div>
            {h.calc && <Steps lines={calcSteps(h.calc)} />}
            <Note accuracy="example">{h.assumptions}</Note>
            <p className="rounded-xl border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-sm font-semibold text-gold-300">
              💡 {tr(T.takeaway)}: {tr(h.takeaway)}
            </p>
            <RecordLine a={p.hands[h.id]} />
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setPicked(null)}>
              ↺ {tr(T.retry)}
            </Button>
          </div>
        )}
      </section>
      <nav className="flex items-center justify-between gap-3 pb-4">
        {prev ? (
          <Link to={`/academy/gto/hands?id=${prev.id}`} className="jc-tap rounded-lg px-3 py-2 text-sm text-ink-300 hover:text-ivory">
            ← {tr(T.prevHand)}
          </Link>
        ) : (
          <span />
        )}
        {after && (
          <Link to={`/academy/gto/hands?id=${after.id}`} className="jc-tap rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950" data-testid="gto-hand-next">
            {tr(T.nextHand)} →
          </Link>
        )}
      </nav>
    </div>
  );
}

// ------------------------------------------------------------------ glossary

export function GtoGlossaryPage() {
  const tr = useTr();
  const { locale } = useI18n();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => GLOSSARY.filter((g) => !needle || [g.term.ko, g.term.en, g.def.ko, g.def.en].some((s) => s.toLowerCase().includes(needle))), [needle]);
  return (
    <div className="flex flex-col gap-4" data-testid="gto-glossary">
      <h1 className="text-lg font-bold text-gold-300">{tr(T.glossary)}</h1>
      <div className="flex flex-col gap-1">
        <label htmlFor="gto-glossary-search" className="text-xs font-semibold text-ink-300">
          {tr(T.searchLabel)}
        </label>
        <input
          id="gto-glossary-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tr(T.searchPh)}
          className="h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-3 text-base text-ivory focus:border-gold-500/60 focus:outline-none"
          data-testid="gto-glossary-search"
        />
      </div>
      {GTO_MODULES.map((mid) => {
        const terms = hits.filter((g) => g.module === mid);
        if (!terms.length) return null;
        return (
          <section key={mid} className="flex flex-col gap-2">
            <h2 className="text-xs font-bold tracking-[0.06em] text-ink-400">
              {moduleNo(mid)}. {tr(MODULE_BY_ID[mid].title)}
            </h2>
            <dl className="grid gap-2 sm:grid-cols-2">
              {terms.map((g) => (
                <div key={g.id} className="jc-panel flex flex-col gap-1 p-3" data-term={g.id}>
                  <dt className="font-bold text-ivory">
                    {tr(g.term)}
                    <span className="ml-1.5 text-xs font-normal text-ink-400">{locale === 'ko' ? g.term.en : g.term.ko}</span>
                  </dt>
                  <dd className="text-sm leading-relaxed text-ink-200">{tr(g.def)}</dd>
                  <dd>
                    <Link to={`/academy/gto/${g.module}`} className="text-xs text-gold-300 underline-offset-2 hover:underline">
                      {tr(T.openModule, { t: tr(MODULE_BY_ID[g.module].title) })} →
                    </Link>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
      {!hits.length && <p className="text-sm text-ink-300">{tr(T.noneLeft)}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ review

export function GtoReviewPage() {
  const tr = useTr();
  const me = useMe();
  const nav = useNavigate();
  const p = useGtoProgress(me?.id);
  const s = gtoSummary(p, CATALOG);
  const weak = weakModules(p, CATALOG);
  const wrongQ = QUIZZES.filter((q) => p.quiz[q.id] && !p.quiz[q.id]!.last);
  const wrongH = HANDS.filter((h) => p.hands[h.id] && !p.hands[h.id]!.last);
  return (
    <div className="flex flex-col gap-4" data-testid="gto-review">
      <section className="jc-panel flex flex-col gap-2 p-4">
        <h1 className="text-lg font-bold text-gold-300">{tr(T.reviewHead)}</h1>
        <p className="text-sm text-ink-200" data-testid="gto-review-summary">
          {tr(T.answered, { n: s.answered, p: s.answered ? `${Math.round((100 * s.correct) / s.answered)}%` : '—' })}
        </p>
        {!me && <p className="text-xs text-ink-400">{tr(T.guest)}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold text-gold-300">{tr(T.weak)}</h2>
        {weak.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {weak.map((w) => (
              <div key={w.module} className="jc-panel flex items-center gap-3 p-3" data-weak={w.module}>
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger-strong font-mono text-xs font-bold text-white">{w.count}</span>
                <span className="min-w-0 flex-1 text-sm font-bold text-ivory">{tr(MODULE_BY_ID[w.module].title)}</span>
                <Button size="sm" variant="outline" onClick={() => nav(`/academy/gto/quiz?module=${w.module}`)}>
                  {tr(T.practiseModule)}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-300">{tr(T.noWeak)}</p>
        )}
      </section>

      {wrongQ.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-bold text-gold-300">
            {tr(T.wrongQuizzes)} ({wrongQ.length})
          </h2>
          <ul className="flex flex-col gap-1 text-sm text-ink-100">
            {wrongQ.map((q) => (
              <li key={q.id} className="flex gap-2">
                <Mark ok={false} className="size-5" />
                <span className="min-w-0 flex-1 truncate">{tr(q.prompt)}</span>
              </li>
            ))}
          </ul>
          <Button className="self-start" onClick={() => nav('/academy/gto/quiz?only=wrong')} data-testid="gto-retry-wrong">
            {tr(T.retryWrong)} →
          </Button>
        </section>
      )}

      {wrongH.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-bold text-gold-300">
            {tr(T.wrongHands)} ({wrongH.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {wrongH.map((h) => (
              <Link key={h.id} to={`/academy/gto/hands?id=${h.id}`} className="jc-tap rounded-full border border-white/10 bg-ink-850 px-3 py-1.5 text-xs font-semibold text-ivory hover:border-gold-500/50">
                {tr(h.title)}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2 pb-4">
        <h2 className="text-sm font-bold text-gold-300">{tr(T.allReviews)}</h2>
        {MODULES.map((m) => (
          <details key={m.id} className="jc-panel p-3" data-review={m.id}>
            <summary className="jc-tap flex cursor-pointer items-center gap-2 text-sm font-bold text-ivory">
              <span className="font-mono text-gold-400">{moduleNo(m.id)}.</span>
              <span className="min-w-0 flex-1">{tr(m.title)}</span>
              {moduleDone(p, m.id) && <span className="text-xs text-gold-300">✓ {tr(T.done)}</span>}
            </summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink-100">
              {m.review.map((x, i) => (
                <li key={i}>{tr(x)}</li>
              ))}
            </ul>
            <Link to={`/academy/gto/${m.id}?step=${m.steps.length}`} className="mt-2 inline-block text-xs text-gold-300 underline-offset-2 hover:underline">
              {tr(T.openModule, { t: tr(m.title) })} →
            </Link>
          </details>
        ))}
      </section>
    </div>
  );
}
