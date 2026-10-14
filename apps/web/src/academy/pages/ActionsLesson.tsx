import type { ActionType, LegalOption, PotView, TableView } from '@jc/types';
import { cx, formatChips } from '@jc/ui';
import { useEffect, useState } from 'react';
import { ActionBar } from '../../game/ActionBar';
import { useI18n } from '../../lib/i18n';
import { l, useTr, type L } from '../content';
import { ACTION_QUIZ, ACTIONS } from '../data/actions';
import { PracticeSession } from '../practice/runner';
import { buildScenarios, type Scenario } from '../practice/scenarios';
import { LessonShell, QuizRunner, type LessonStep } from '../ui';

function ActionCards() {
  const tr = useTr();
  const { locale } = useI18n();
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="action-cards">
      {ACTIONS.map((a) => (
        <article key={a.type} className="rounded-xl border border-white/10 bg-ink-850 p-3" data-action={a.type}>
          <h3 className="font-bold text-gold-300">
            {locale === 'ko' ? a.ko : a.en}
            {locale === 'ko' && <span className="ml-1.5 text-xs font-normal text-ink-400">{a.en}</span>}
          </h3>
          <p className="mt-1 text-sm text-ivory">{tr(a.what)}</p>
          <p className="mt-1 text-xs text-ink-300">
            <b className="text-ink-200">{tr(l('언제?', 'When?'))}</b> {tr(a.when)}
          </p>
          {a.note && <p className="mt-1.5 rounded-lg bg-gold-500/5 p-2 text-xs text-gold-300/90">{tr(a.note)}</p>}
        </article>
      ))}
    </div>
  );
}

/** Plays a scenario's script up to the hero's `heroTurn`-th decision and returns that table view. */
async function situation(sc: Scenario, heroTurn: number): Promise<TableView> {
  const s = new PracticeSession(sc);
  let turns = 0;
  for (let g = 0; g < 50; g++) {
    if (await s.step()) continue;
    if (!s.isHeroTurn()) break;
    if (turns === heroTurn) break;
    const step = s.currentStep();
    await s.heroAct(Array.isArray(step?.expect) ? step.expect[0]! : (step?.expect ?? s.autoHeroAction().type));
    turns++;
  }
  return s.view();
}

const SITUATIONS: { id: string; label: L; scenario: Scenario['id']; heroTurn: number; desc: L }[] = [
  { id: 'free', label: l('아무도 베팅하지 않음', 'Nobody has bet'), scenario: 'A', heroTurn: 1, desc: l('플랍. 내가 먼저 행동하고, 아직 베팅이 없습니다.', 'On the flop you act first and nobody has bet.') },
  { id: 'limp', label: l('상대가 콜만 함 (BB)', 'Opponent just called (BB)'), scenario: 'A', heroTurn: 0, desc: l('프리플랍. 나는 빅 블라인드이고 상대가 10을 맞췄습니다.', 'Preflop: you are the big blind and your opponent called 10.') },
  { id: 'facing', label: l('상대가 레이즈함', 'Facing a raise'), scenario: 'B', heroTurn: 0, desc: l('프리플랍. 상대가 30으로 레이즈했습니다.', 'Preflop: your opponent raised to 30.') },
];

function explainAct(type: ActionType, amount: number | undefined, legal: LegalOption[], myBet: number, tr: (x: L, v?: Record<string, string | number>) => string): string {
  const call = legal.find((o) => o.type === 'call');
  switch (type) {
    case 'fold':
      return tr(l('폴드: 이번 핸드를 포기합니다. 이미 넣은 {b}칩은 팟에 남습니다.', 'Fold: you give up; the {b} chips you put in stay in the pot.'), { b: myBet });
    case 'check':
      return tr(l('체크: 칩을 넣지 않고 차례를 넘깁니다.', 'Check: pass without putting in chips.'));
    case 'call':
      return tr(l('콜: {a}칩을 더 넣어 베팅을 맞춥니다.', 'Call: add {a} chips to match the bet.'), { a: call && 'amount' in call ? call.amount : 0 });
    case 'bet':
      return tr(l('벳: 이번 라운드 첫 베팅으로 {a}칩을 겁니다.', 'Bet: open this round for {a} chips.'), { a: amount ?? 0 });
    case 'raise':
      return tr(l('레이즈: 이번 라운드 총 {a}칩이 되도록 올립니다.', 'Raise: make it {a} in total this round.'), { a: amount ?? 0 });
    case 'allin':
      return tr(l('올인: 남은 칩을 전부 겁니다.', 'All-in: every chip you have left.'));
  }
}

function LiveDemo() {
  const tr = useTr();
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<TableView | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const s = SITUATIONS[sel]!;
    setView(null);
    setSaid(null);
    void situation(buildScenarios('You').find((x) => x.id === s.scenario)!, s.heroTurn).then((v) => live && setView(v));
    return () => {
      live = false;
    };
  }, [sel]);
  const legal = view?.you.legal ?? [];
  const me = view?.seats.find((x) => x.seatIndex === view.you.seatIndex);
  const win = legal.find((o): o is Extract<LegalOption, { min: number }> => o.type === 'bet' || o.type === 'raise');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-100">{tr(l('실제 게임 엔진이 상황마다 허용하는 액션만 버튼으로 보여 줍니다. 버튼을 눌러 보세요 (연습이라 실제로 실행되지는 않습니다).', 'The real engine decides which buttons appear in each spot. Try them — nothing is actually played here.'))}</p>
      <div className="flex flex-wrap gap-2" role="tablist">
        {SITUATIONS.map((s, i) => (
          <button key={s.id} role="tab" aria-selected={i === sel} onClick={() => setSel(i)} data-situation={s.id} className={cx('jc-tap min-h-11 rounded-full border px-3 text-xs font-semibold', i === sel ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-200')}>
            {tr(s.label)}
          </button>
        ))}
      </div>
      <div className="rounded-xl border border-white/10 bg-ink-850 p-3 text-sm">
        <p className="text-ink-100">{tr(SITUATIONS[sel]!.desc)}</p>
        {view && (
          <p className="mt-1 font-mono text-xs text-ink-300" data-testid="legal-list">
            {tr(l('가능한 액션', 'Legal'))}: {legal.map((o) => o.type + ('amount' in o ? ` ${o.amount}` : 'min' in o ? ` ${o.min}~${formatChips(o.max)}` : '')).join(' · ')}
          </p>
        )}
        {win && <p className="mt-1 text-xs text-gold-300">{tr(l('최소 {t} {min} — 최대 {max} (내 스택 전부)', 'Minimum {t} to {min}, maximum {max} (your stack)'), { t: win.type, min: win.min, max: formatChips(win.max) })}</p>}
      </div>
      {view && <ActionBar state={view} busy={false} onAct={(type, amount) => setSaid(explainAct(type, amount, legal, me?.streetBet ?? 0, tr))} />}
      {said && (
        <div className="jc-pop rounded-xl border border-gold-500/40 bg-gold-500/10 p-3 text-sm text-gold-300" role="status" data-testid="demo-said">
          {said}
        </div>
      )}
    </div>
  );
}

function SidePotStep() {
  const tr = useTr();
  const [pots, setPots] = useState<PotView[] | null>(null);
  useEffect(() => {
    const sc = buildScenarios('You').find((x) => x.id === 'G')!;
    void (async () => {
      const s = new PracticeSession(sc);
      for (let g = 0; g < 50 && s.stage !== 'turn'; g++) {
        if (await s.step()) continue;
        await s.heroAct(s.currentStep()?.expect as ActionType);
      }
      setPots(s.view().hand!.pots);
    })();
  }, []);
  const name = (seat: number) => (seat === 0 ? tr(l('나', 'You')) : seat === 2 ? 'Leo' : 'Mia');
  return (
    <div className="flex flex-col gap-4 text-sm text-ink-100">
      <section className="rounded-xl border border-white/10 bg-ink-850 p-3">
        <h3 className="font-bold text-gold-300">{tr(l('최소 레이즈', 'Minimum raise'))}</h3>
        <p className="mt-1">{tr(ACTIONS.find((a) => a.type === 'raise')!.note!)}</p>
      </section>
      <section className="rounded-xl border border-white/10 bg-ink-850 p-3">
        <h3 className="font-bold text-gold-300">{tr(l('올인과 사이드 팟', 'All-in and side pots'))}</h3>
        <p className="mt-1">{tr(l('예: 레오(100칩)가 올인하고 나와 미아가 따라간 뒤, 플랍에서 미아가 200을 벳하고 내가 콜했습니다. 엔진이 계산한 팟은 다음과 같습니다.', 'Example: Leo (100 chips) is all-in, you and Mia call, then Mia bets 200 on the flop and you call. The engine splits the pots like this:'))}</p>
        <div className="mt-3 flex flex-col gap-2" data-testid="sidepot-demo">
          {pots?.map((p, i) => (
            <div key={p.id} className={cx('flex items-center justify-between gap-2 rounded-lg border p-2', i === 0 ? 'border-gold-400/50 bg-gold-500/10' : 'border-info/50 bg-info/10')}>
              <span className="font-bold">{i === 0 ? tr(l('메인 팟', 'Main pot')) : tr(l('사이드 팟 {n}', 'Side pot {n}'), { n: i })}</span>
              <span className="font-mono text-gold-300">{formatChips(p.amount)}</span>
              <span className="text-xs text-ink-200">{p.eligibleSeats.map(name).join(' · ')}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-300">{tr(l('레오는 자기가 낸 100만큼씩, 즉 메인 팟만 이길 수 있습니다. 사이드 팟은 나와 미아 중 더 강한 패가 가져갑니다.', 'Leo can win only up to what he put in from each player — the main pot. The side pot goes to the better hand between you and Mia.'))}</p>
      </section>
    </div>
  );
}

export function ActionsLesson() {
  const [quiz, setQuiz] = useState(false);
  const steps: LessonStep[] = [
    { title: l('여섯 가지 액션', 'The six actions'), body: <ActionCards /> },
    { title: l('실제 버튼으로 확인하기', 'Try the real buttons'), body: <LiveDemo /> },
    { title: l('레이즈 규칙과 사이드 팟', 'Raise rules and side pots'), body: <SidePotStep /> },
    { title: l('퀴즈: 어떤 액션일까?', 'Quiz: which action?'), body: <QuizRunner questions={ACTION_QUIZ} onDone={() => setQuiz(true)} />, locked: !quiz },
  ];
  return <LessonShell id="actions" title={l('Lesson 4 · 베팅 액션 배우기', 'Lesson 4 · Betting actions')} steps={steps} next={{ to: '/academy/practice', label: l('Lesson 5 · 연습 게임', 'Lesson 5 · Practice') }} />;
}
