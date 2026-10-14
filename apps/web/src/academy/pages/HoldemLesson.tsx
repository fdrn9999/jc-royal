import { evaluateBest, evaluateKnown } from '@jc/poker-engine/evaluate';
import { judgeShowdown } from '@jc/poker-engine';
import type { TableView } from '@jc/types';
import { Button, cx, PlayingCard } from '@jc/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionBar } from '../../game/ActionBar';
import { seatLayout } from '../../game/layout';
import { TableScene, useBoxSize, useTableLayout } from '../../game/TableScene';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { describeHand, l, useTr } from '../content';
import { actingOrder, BEST_FIVE_DEMO, BOARD_PLAYS, POSITION_INFO, positionNames, STAGES, TOUR, WALKTHROUGH } from '../data/holdem';
import { PracticeSession } from '../practice/runner';
import { buildScenarios } from '../practice/scenarios';
import type { ChoiceQuestion } from '../quiz';
import { CardRow, LessonShell, QuizRunner, type LessonStep } from '../ui';

function GoalStep() {
  const tr = useTr();
  const { locale, t } = useI18n();
  const [show, setShow] = useState(false);
  const all = [...BEST_FIVE_DEMO.hole, ...BEST_FIVE_DEMO.board];
  const best = evaluateBest(all)!;
  const boardPlays = evaluateBest([...BOARD_PLAYS.hole, ...BOARD_PLAYS.board])!;
  return (
    <div className="flex flex-col gap-4 text-sm text-ink-100">
      <p>{tr(l('목표는 내 홀카드 2장과 모두가 쓰는 커뮤니티 카드 5장, 총 7장 중에서 가장 강한 5장짜리 패를 만드는 것입니다.', 'The goal: make the best five-card hand from seven — your two hole cards plus five shared community cards.'))}</p>
      <div className="flex flex-col items-center gap-3 rounded-2xl p-3" style={{ background: 'var(--t-felt)' }}>
        <div className="flex flex-wrap items-end justify-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[11px] font-bold text-gold-300">{tr(l('내 홀카드', 'Hole cards'))}</span>
            <div className="flex gap-1">
              {BEST_FIVE_DEMO.hole.map((c) => (
                <PlayingCard key={c} card={c} size="clamp(2.6rem,11vw,3.4rem)" highlight={show && best.bestFive.includes(c)} dim={show && !best.bestFive.includes(c)} />
              ))}
            </div>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[11px] font-bold text-gold-300">{tr(l('커뮤니티 카드', 'Community cards'))}</span>
            <div className="flex gap-1">
              {BEST_FIVE_DEMO.board.map((c) => (
                <PlayingCard key={c} card={c} size="clamp(2.6rem,11vw,3.4rem)" highlight={show && best.bestFive.includes(c)} dim={show && !best.bestFive.includes(c)} />
              ))}
            </div>
          </div>
        </div>
        {show ? (
          <div className="jc-pop font-bold text-gold-300" data-testid="best-five">
            {describeHand(best, locale, t)}
          </div>
        ) : (
          <Button onClick={() => setShow(true)} data-testid="find-best">
            {tr(l('가장 강한 5장 찾기', 'Find the best five'))}
          </Button>
        )}
      </div>
      <div className="rounded-xl border border-white/10 bg-ink-850 p-3">
        <p className="mb-2">{tr(l('홀카드를 꼭 쓸 필요는 없습니다. 보드 5장이 가장 강하면 보드만으로 승부합니다.', 'You do not have to use your hole cards: if the board itself is best, you play the board.'))}</p>
        <div className="flex flex-wrap items-center gap-2">
          <CardRow cards={BOARD_PLAYS.hole} size="2.2rem" />
          <span className="text-ink-400">+</span>
          <CardRow cards={BOARD_PLAYS.board} size="2.2rem" />
          <span className="text-xs font-semibold text-gold-300">= {describeHand(boardPlays, locale, t)}</span>
        </div>
      </div>
      <p className="rounded-xl border border-gold-500/25 bg-gold-500/5 p-3">{tr(l('패를 비교하기 전에 다른 모든 사람이 폴드하면, 쇼다운 없이 남은 한 사람이 팟을 가져갑니다.', 'If everyone else folds, the last player wins the pot without a showdown.'))}</p>
    </div>
  );
}

/** A real practice engine state (scenario H, preflop) used as a tour backdrop. */
function useTourView(): TableView | null {
  const { me } = useAuth();
  return useMemo(() => {
    const sc = buildScenarios(me?.nickname ?? 'You').find((s) => s.id === 'H')!;
    const v = new PracticeSession(sc).view();
    return { ...v, hand: v.hand && { ...v.hand, deadline: Date.now() + 25_000 } };
  }, [me?.nickname]);
}

function TourStep() {
  const tr = useTr();
  const view = useTourView();
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const layout = useTableLayout(area, view?.table.maxSeats, view?.you.seatIndex ?? 0);
  const wrap = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const item = TOUR[i]!;
  useLayoutEffect(() => {
    const measure = () => {
      const root = wrap.current;
      const els = root ? [...root.querySelectorAll<HTMLElement>(item.target)] : [];
      if (!root || els.length === 0) return setRect(null);
      const base = root.getBoundingClientRect();
      const rs = els.map((e) => e.getBoundingClientRect());
      const x = Math.min(...rs.map((r) => r.left));
      const y = Math.min(...rs.map((r) => r.top));
      const w = Math.max(...rs.map((r) => r.right)) - x;
      const h = Math.max(...rs.map((r) => r.bottom)) - y;
      setRect({ x: x - base.left - 6, y: y - base.top - 6, w: w + 12, h: h + 12 });
    };
    measure();
    const t = setTimeout(measure, 450); // after deal/flip animations settle
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [item.target, area.w, area.h]);
  if (!view) return null;
  return (
    <div className="flex flex-col gap-3">
      <div ref={wrap} className="jc-game-surface relative overflow-hidden rounded-2xl" style={{ background: 'var(--t-bg)' }} data-testid="tour">
        <div ref={areaRef} className="flex h-[min(62vh,32rem)] items-center justify-center px-2 pb-14 pt-6">
          <TableScene s={view} layout={layout} mySeat={view.you.seatIndex} canSit={false} onSit={() => {}} nextIn={null} cues={[]} consumeCues={() => {}} reducedMotion />
        </div>
        <div className="px-2 pb-2">
          <ActionBar state={view} onAct={() => setI(TOUR.length - 1)} busy={false} />
        </div>
        {rect && <div className="jc-spot" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} aria-hidden data-testid="tour-spot" />}
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-gold-500/30 bg-ink-850 p-3" aria-live="polite">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-gold-300" data-testid="tour-name">
            {i + 1}/{TOUR.length} · {tr(item.name)}
          </span>
        </div>
        <p className="text-sm text-ink-100">{tr(item.body)}</p>
        <div className="flex justify-between">
          <Button variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)}>
            ←
          </Button>
          <Button variant="outline" disabled={i === TOUR.length - 1} onClick={() => setI(i + 1)} data-testid="tour-next">
            →
          </Button>
        </div>
      </div>
    </div>
  );
}

function StagesStep() {
  const tr = useTr();
  const { locale, t } = useI18n();
  const [k, setK] = useState(0);
  const [winner, setWinner] = useState<number[] | null>(null);
  useEffect(() => {
    void judgeShowdown([WALKTHROUGH.hero, WALKTHROUGH.villain], WALKTHROUGH.board).then((o) => setWinner(o.winners));
  }, []);
  const st = STAGES[k]!;
  const board = WALKTHROUGH.board.slice(0, st.board);
  const showdown = st.id === 'showdown';
  const mine = evaluateKnown([...WALKTHROUGH.hero, ...board])!;
  const theirs = evaluateKnown([...WALKTHROUGH.villain, ...board])!;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-5 gap-1" role="tablist">
        {STAGES.map((s, n) => (
          <button key={s.id} role="tab" aria-selected={n === k} onClick={() => setK(n)} data-stage={s.id} className={cx('jc-tap min-h-11 rounded-lg border px-1 text-[11px] font-bold sm:text-xs', n === k ? 'border-gold-400 bg-gold-500/15 text-gold-300' : n < k ? 'border-gold-500/30 text-ink-200' : 'border-white/10 text-ink-400')}>
            {tr(s.name).split(' ')[0]}
          </button>
        ))}
      </div>
      <div className="flex flex-col items-center gap-3 rounded-2xl p-3" style={{ background: 'var(--t-felt)' }}>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] font-semibold text-ink-200">{tr(l('상대', 'Opponent'))}</span>
          <div className="flex gap-1">
            {WALKTHROUGH.villain.map((c) => (
              <PlayingCard key={`${c}-${showdown}`} card={showdown ? c : null} size="2.4rem" animate={showdown ? 'flip' : false} />
            ))}
          </div>
          {showdown && <span className="text-xs text-ink-100">{describeHand(theirs, locale, t)}</span>}
        </div>
        <div className="flex min-h-[3.6rem] gap-1 rounded-xl bg-black/30 p-1.5" data-testid="stage-board">
          {Array.from({ length: 5 }, (_, n) =>
            board[n] ? <PlayingCard key={board[n]} card={board[n]!} size="2.4rem" animate="flip" style={{ animationDelay: `${(n % 3) * 110}ms` }} /> : <div key={n} className="jc-card border border-dashed border-white/15" style={{ ['--card-size' as string]: '2.4rem', boxShadow: 'none' }} />,
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="flex gap-1">
            {WALKTHROUGH.hero.map((c) => (
              <PlayingCard key={c} card={c} size="2.8rem" animate="deal" />
            ))}
          </div>
          <span className="text-xs font-semibold text-gold-300">
            {tr(l('내 패', 'You'))}: {describeHand(mine, locale, t)}
          </span>
        </div>
        {showdown && winner && <div className="jc-pop rounded-full bg-gold-500/20 px-3 py-1 text-sm font-bold text-gold-300">{winner.includes(0) ? tr(l('승리! K 원페어가 Q 원페어를 이깁니다.', 'You win: a pair of Kings beats a pair of Queens.')) : tr(l('상대 승리', 'Opponent wins'))}</div>}
      </div>
      <div>
        <h3 className="mb-2 font-bold text-ivory">{tr(st.name)}</h3>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-100">
          {st.points.map((p, n) => (
            <li key={n}>{tr(p)}</li>
          ))}
        </ul>
      </div>
      <div className="flex justify-between">
        <Button variant="ghost" disabled={k === 0} onClick={() => setK(k - 1)}>
          ← {tr(l('이전 단계', 'Previous street'))}
        </Button>
        <Button variant="outline" disabled={k === STAGES.length - 1} onClick={() => setK(k + 1)} data-testid="stage-next">
          {tr(l('다음 단계', 'Next street'))} →
        </Button>
      </div>
    </div>
  );
}

function PositionsStep() {
  const tr = useTr();
  const [n, setN] = useState(6);
  const [street, setStreet] = useState<'preflop' | 'postflop'>('preflop');
  const names = positionNames(n);
  const order = actingOrder(n, street);
  const geo = seatLayout(n, 0, false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {[2, 3, 6, 9].map((x) => (
          <button key={x} onClick={() => setN(x)} aria-pressed={n === x} className={cx('jc-tap min-h-11 rounded-full border px-4 text-sm font-semibold', n === x ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-200')}>
            {x}
            {tr(l('인', ' players'))}
          </button>
        ))}
        <span className="mx-1 w-px bg-white/10" />
        {(['preflop', 'postflop'] as const).map((s) => (
          <button key={s} onClick={() => setStreet(s)} aria-pressed={street === s} className={cx('jc-tap min-h-11 rounded-full border px-4 text-sm font-semibold', street === s ? 'border-info bg-info/15 text-[#a9c8ee]' : 'border-white/10 text-ink-200')}>
            {s === 'preflop' ? tr(l('프리플랍', 'Preflop')) : tr(l('플랍 이후', 'After the flop'))}
          </button>
        ))}
      </div>
      <div className="relative mx-auto aspect-[1.75] w-full max-w-lg" data-testid="positions">
        <div className="absolute inset-[14%_10%] rounded-[50%] border-4 border-[#6f5615]" style={{ background: 'var(--t-felt)' }} />
        {names.map((name, i) => {
          const g = geo[i]!.seat;
          const turn = order.indexOf(i) + 1;
          return (
            <div key={i} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: `${g.x}%`, top: `${g.y}%` }} data-position={name}>
              <span className={cx('grid min-w-11 place-items-center rounded-full border px-1.5 py-1 text-[10px] font-bold sm:text-xs', name.startsWith('BTN') ? 'border-ivory bg-ivory text-ink-950' : name === 'SB' || name === 'BB' ? 'border-gold-400 bg-ink-900 text-gold-300' : 'border-white/20 bg-ink-900 text-ivory')}>{name}</span>
              <span className="mt-0.5 grid size-5 place-items-center rounded-full bg-info/80 font-mono text-[10px] font-bold text-white" aria-label={`${turn}`}>
                {turn}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-center text-xs text-ink-300">{tr(l('파란 숫자는 행동 순서입니다. 딜러 버튼은 매 핸드 시계 방향으로 한 칸 이동합니다.', 'Blue numbers show the acting order. The button moves one seat clockwise every hand.'))}</p>
      <ul className="flex flex-col gap-1.5 text-sm text-ink-100">
        {(street === 'preflop'
          ? [l('프리플랍: 빅 블라인드 다음 자리(UTG)부터 시작해 빅 블라인드가 마지막입니다.', 'Preflop: starts after the big blind (UTG) and ends with the big blind.')]
          : [l('플랍 이후: 버튼 왼쪽에 남은 첫 사람(보통 SB)부터 시작해 버튼이 마지막입니다.', 'After the flop: the first remaining player left of the button (usually SB) starts; the button acts last.')]
        ).map((x, k) => (
          <li key={k} className="rounded-xl border border-info/30 bg-info/5 p-3">
            {tr(x)}
          </li>
        ))}
        {n === 2 && <li className="rounded-xl border border-gold-500/30 bg-gold-500/5 p-3">{tr(POSITION_INFO['BTN/SB']!)}</li>}
        {n === 3 && <li className="rounded-xl border border-white/10 bg-ink-850 p-3">{tr(l('3인에서는 UTG가 없으므로 버튼이 프리플랍에 가장 먼저 행동합니다.', 'Three-handed there is no UTG: the button acts first preflop.'))}</li>}
      </ul>
      <dl className="grid gap-1.5 sm:grid-cols-2">
        {[...new Set(names)].map((name) => (
          <div key={name} className="rounded-lg border border-white/5 bg-ink-850/70 p-2 text-xs">
            <dt className="font-bold text-gold-300">{name}</dt>
            <dd className="text-ink-200">{tr(POSITION_INFO[name]!)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const pos = (n: number, street: 'preflop' | 'postflop') => positionNames(n)[actingOrder(n, street)[0]!]!;
const POSITION_QUIZ: ChoiceQuestion[] = [
  {
    kind: 'choice',
    id: 'p-6-pre',
    prompt: l('6인 테이블, 프리플랍에서 가장 먼저 행동하는 자리는?', '6 players, preflop: who acts first?'),
    options: ['BTN', 'SB', 'BB', 'UTG'].map((x) => ({ id: x, label: l(x, x) })),
    answer: pos(6, 'preflop'),
    why: l('프리플랍은 빅 블라인드 다음 자리부터 시작합니다.', 'Preflop action starts after the big blind.'),
    explain: l('UTG(Under the Gun)가 가장 먼저, 빅 블라인드가 가장 나중입니다.', 'UTG acts first and the big blind last.'),
  },
  {
    kind: 'choice',
    id: 'p-6-post',
    prompt: l('6인 테이블, 플랍 이후 가장 먼저 행동하는 자리는? (모두 남아 있음)', '6 players, after the flop (nobody folded): who acts first?'),
    options: ['BTN', 'SB', 'UTG', 'CO'].map((x) => ({ id: x, label: l(x, x) })),
    answer: pos(6, 'postflop'),
    why: l('플랍 이후에는 버튼 바로 왼쪽부터 행동합니다.', 'After the flop, action starts just left of the button.'),
    explain: l('SB가 먼저, 버튼이 가장 나중입니다. 그래서 버튼이 가장 유리합니다.', 'SB first and the button last — that is why the button is the best seat.'),
  },
  {
    kind: 'choice',
    id: 'p-hu-pre',
    prompt: l('헤즈업(2인), 프리플랍에서 먼저 행동하는 사람은?', 'Heads-up preflop: who acts first?'),
    options: ['BTN/SB', 'BB'].map((x) => ({ id: x, label: l(x, x) })),
    answer: pos(2, 'preflop'),
    why: l('헤즈업은 예외입니다. 버튼이 스몰 블라인드를 내고 프리플랍에 먼저 행동합니다.', 'Heads-up is the exception: the button posts the small blind and acts first preflop.'),
    explain: l('플랍 이후에는 반대로 BB가 먼저 행동합니다.', 'After the flop it flips: the big blind acts first.'),
  },
];

export function HoldemLesson() {
  const [quiz, setQuiz] = useState(false);
  const steps: LessonStep[] = [
    { title: l('홀덤의 목적', 'The goal'), body: <GoalStep /> },
    { title: l('테이블 둘러보기', 'Tour of the table'), body: <TourStep /> },
    { title: l('게임 진행: 프리플랍 → 쇼다운', 'Streets: preflop to showdown'), body: <StagesStep /> },
    { title: l('포지션과 블라인드', 'Positions and blinds'), body: <PositionsStep /> },
    { title: l('퀴즈: 누가 먼저 행동할까?', 'Quiz: who acts first?'), body: <QuizRunner questions={POSITION_QUIZ} onDone={() => setQuiz(true)} />, locked: !quiz },
  ];
  return <LessonShell id="holdem" title={l("Lesson 3 · 텍사스 홀덤의 기본 규칙", "Lesson 3 · Texas hold'em basics")} steps={steps} next={{ to: '/academy/actions', label: l('Lesson 4 · 베팅 액션', 'Lesson 4 · Betting actions') }} />;
}
