import { Button, cx, PlayingCard } from '@jc/ui';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../../lib/auth';
import { setPrefs, usePrefs } from '../../lib/prefs';
import { l, useTr, type L } from '../content';
import { isDone, LESSON_IDS, nextLesson, percent, SCENARIO_IDS, updateProgress, useProgress, weakTopics, type LessonId } from '../progress';
import { BadgeShelf } from '../Badges';
import { UI } from '../ui';

export const LESSONS: Record<LessonId, { n: number; title: L; desc: L; to: string; icon: string }> = {
  cards: { n: 1, title: l('플레잉카드의 기초', 'Playing card basics'), desc: l('52장의 구성, 네 가지 문양, 카드의 높고 낮음', '52 cards, four suits, which card is higher'), to: '/academy/cards', icon: '♠' },
  hands: { n: 2, title: l('포커 족보', 'Hand rankings'), desc: l('로열 플러시부터 하이카드까지, 비교와 킥커', 'Royal flush to high card, ties and kickers'), to: '/academy/hands', icon: '♥' },
  holdem: { n: 3, title: l('텍사스 홀덤 규칙', "Texas hold'em rules"), desc: l('테이블 구성, 진행 단계, 포지션과 블라인드', 'The table, the streets, positions and blinds'), to: '/academy/holdem', icon: '♦' },
  actions: { n: 4, title: l('베팅 액션', 'Betting actions'), desc: l('폴드·체크·콜·벳·레이즈·올인과 사이드 팟', 'Fold, check, call, bet, raise, all-in and side pots'), to: '/academy/actions', icon: '♣' },
  practice: { n: 5, title: l('연습 게임', 'Practice table'), desc: l('실제 테이블에서 시나리오 8개를 플레이 (칩 차감 없음)', 'Play eight scenarios on a real table (no chips used)'), to: '/academy/practice', icon: '▶' },
};

const T = {
  hero: l('처음 카드를 배우는 순간부터 실제 홀덤 한 판까지.', 'From your first card to your first real hand of hold’em.'),
  progress: l('학습 진행률', 'Progress'),
  cont: l('이어서 학습하기', 'Continue'),
  start: l('학습 시작하기', 'Start learning'),
  restart: l('처음부터 다시 배우기', 'Start over'),
  free: l('자유 연습', 'Free practice'),
  quiz: l('족보 퀴즈', 'Hand quiz'),
  toc: l('전체 학습 목차', 'All lessons'),
  done: l('완료', 'Done'),
  inProgress: l('진행 중', 'In progress'),
  newQ: l('텍사스 홀덤이 처음인가요?', "New to Texas hold'em?"),
  newSub: l('원하는 곳부터 시작하세요. 언제든 다시 돌아올 수 있습니다.', 'Start wherever you like — you can come back any time.'),
  beginner: l('초보자 모드', 'Beginner mode'),
  beginnerDesc: l('게임 중 현재 내 패, 액션 도움말, 진행 단계 설명을 보여줍니다.', 'Shows your current hand, action help and street explanations at the table.'),
  details: l('상세 진행 현황', 'Detailed progress'),
  review: l('복습·랜덤 퀴즈', 'Review & random quiz'),
  badges: l('배지', 'Badges'),
  scenarios: l('연습 시나리오', 'Practice scenarios'),
};

const CHOICES: { label: L; to: string; testid: string }[] = [
  { label: l('카드부터 처음 배우기', 'Learn the cards first'), to: '/academy/cards', testid: 'choose-cards' },
  { label: l('홀덤 규칙부터 배우기', "Learn hold'em rules"), to: '/academy/holdem', testid: 'choose-holdem' },
  { label: l('족보만 빠르게 익히기', 'Just the hand rankings'), to: '/academy/hands', testid: 'choose-hands' },
  { label: l('연습 게임 시작하기', 'Start a practice game'), to: '/academy/practice', testid: 'choose-practice' },
  { label: l('건너뛰고 실제 게임 시작하기', 'Skip and play for real'), to: '/', testid: 'choose-skip' },
];

export function AcademyPage() {
  const tr = useTr();
  const { me } = useAuth();
  const nav = useNavigate();
  const p = useProgress(me?.id);
  const prefs = usePrefs();
  const pct = percent(p);
  const next = nextLesson(p);
  const started = Object.keys(p.lessons).length > 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5" data-testid="academy">
      <section className="jc-panel relative overflow-hidden p-5 sm:p-7">
        <div className="pointer-events-none absolute -right-6 -top-4 flex rotate-12 gap-1 opacity-25 sm:opacity-40" aria-hidden>
          <PlayingCard card="As" size="4.5rem" />
          <PlayingCard card="Kh" size="4.5rem" />
        </div>
        <div className="relative flex flex-col gap-4">
          <div>
            <div className="font-display text-xs font-bold tracking-[0.3em] text-gold-400">JC ROYAL ACADEMY</div>
            <h1 className="mt-1 text-2xl font-bold text-ivory sm:text-3xl">{tr(UI.academy)}</h1>
            <p className="mt-1 text-sm text-ink-300">{tr(T.hero)}</p>
          </div>
          <div>
            <div className="mb-1.5 flex justify-between text-xs font-semibold text-ink-300">
              <span>{tr(T.progress)}</span>
              <span className="font-mono text-gold-300" data-testid="academy-percent">
                {pct}%
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-gradient-to-r from-gold-600 to-gold-300 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {next && (
              <Button size="lg" onClick={() => nav(`${LESSONS[next].to}${p.last?.lesson === next ? `?step=${p.last.step}` : ''}`)} data-testid="academy-continue">
                {started ? tr(T.cont) : tr(T.start)} →
              </Button>
            )}
            <Button size="lg" variant="outline" onClick={() => nav('/academy/practice')}>
              {tr(T.free)}
            </Button>
            <Button size="lg" variant="outline" onClick={() => nav('/academy/hands?step=3')}>
              {tr(T.quiz)}
            </Button>
            <Button size="lg" variant="outline" onClick={() => nav('/academy/review')} data-testid="academy-review">
              {tr(T.review)}
              {weakTopics(p).length > 0 && <span className="ml-1 rounded-full bg-danger-strong px-1.5 text-[11px] text-white">{weakTopics(p).length}</span>}
            </Button>
          </div>
        </div>
      </section>

      {!p.onboarded && (
        <section className="jc-panel border-gold-500/40 p-5" data-testid="academy-onboarding">
          <h2 className="text-lg font-bold text-gold-300">{tr(T.newQ)}</h2>
          <p className="mb-3 text-sm text-ink-300">{tr(T.newSub)}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHOICES.map((c, i) => (
              <button
                key={c.to}
                data-testid={c.testid}
                onClick={() => {
                  if (me) updateProgress(me.id, (x) => ({ ...x, onboarded: true }));
                  nav(c.to);
                }}
                className="jc-tap flex min-h-12 items-center gap-3 rounded-xl border border-white/10 bg-ink-850 px-4 py-3 text-left text-sm font-semibold text-ivory transition hover:border-gold-500/50"
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-gold-500/15 font-mono text-xs text-gold-300">{i + 1}</span>
                {tr(c.label)}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold tracking-[0.06em] text-gold-300">{tr(T.toc)}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {LESSON_IDS.map((id) => {
            const L = LESSONS[id];
            const done = isDone(p, id);
            const going = !done && !!p.lessons[id];
            const sub = id === 'practice' ? `${SCENARIO_IDS.filter((s) => p.practice[s]).length}/${SCENARIO_IDS.length}` : null;
            return (
              <Link key={id} to={L.to} className="jc-tap jc-panel flex items-center gap-3 p-4 transition hover:border-gold-500/40" data-testid={`toc-${id}`}>
                <span className={cx('grid size-11 shrink-0 place-items-center rounded-xl text-xl', done ? 'bg-gold-500 text-ink-950' : 'bg-ink-700 text-gold-300')}>{done ? '✓' : L.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400">Lesson {L.n}</span>
                  <span className="block font-bold text-ivory">{tr(L.title)}</span>
                  <span className="block text-xs text-ink-300">{tr(L.desc)}</span>
                </span>
                <span className={cx('shrink-0 text-xs font-semibold', done ? 'text-gold-300' : 'text-ink-400')}>{done ? tr(T.done) : going ? tr(T.inProgress) : sub}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold tracking-[0.06em] text-gold-300">{tr(T.badges)}</h2>
        <BadgeShelf />
      </section>

      <section className="jc-panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex flex-1 items-start gap-3">
          <input type="checkbox" checked={prefs.beginner} onChange={(e) => setPrefs({ beginner: e.target.checked })} className="mt-1 size-5 shrink-0 accent-[var(--color-gold-500)]" data-testid="beginner-toggle" />
          <span>
            <span className="block font-bold text-ivory">{tr(T.beginner)}</span>
            <span className="block text-xs text-ink-300">{tr(T.beginnerDesc)}</span>
          </span>
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/academy/progress')}>
            {tr(T.details)}
          </Button>
        </div>
      </section>
    </div>
  );
}
