import { sound } from '@jc/audio';
import { Button, cx, RotateCcwIcon } from '@jc/ui';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { l, useTr } from '../content';
import { COMPARE_QUESTIONS, HAND_SORT, NAME_QUESTIONS } from '../data/handQuiz';
import { HAND_RANKS } from '../data/hands';
import { CardRow, HandRankRow, LessonShell, QuizRunner, type LessonStep } from '../ui';

function OverviewStep() {
  const tr = useTr();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-100">{tr(l('포커 패는 언제나 5장으로 비교합니다. 아래로 갈수록 약한 족보이며, 밝게 표시된 카드가 족보를 만드는 카드입니다.', 'Hands are always compared as five cards. Lower rows are weaker; bright cards are the ones that make the hand.'))}</p>
      <div className="flex flex-col gap-1.5">
        {HAND_RANKS.map((h, i) => (
          <HandRankRow key={h.key} h={h} index={i} reveal />
        ))}
      </div>
    </div>
  );
}

function DetailStep() {
  const tr = useTr();
  const { locale } = useI18n();
  const [i, setI] = useState(0);
  const [play, setPlay] = useState(0);
  const h = HAND_RANKS[i]!;
  const choose = (k: number) => {
    setI(k);
    setPlay((p) => p + 1);
    sound.play('flip');
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label={tr(l('족보 선택', 'Choose a hand'))}>
        {HAND_RANKS.map((x, k) => (
          <button key={x.key} role="tab" aria-selected={k === i} onClick={() => choose(k)} className={cx('jc-tap shrink-0 snap-start rounded-full border px-3 py-2 text-xs font-semibold', k === i ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-200')}>
            {k + 1}. {locale === 'ko' ? x.ko : x.en}
          </button>
        ))}
      </div>
      <div className="flex flex-col items-center gap-2 rounded-2xl p-4" style={{ background: 'var(--t-felt)' }} data-testid="rank-detail">
        <CardRow key={`${h.key}-${play}`} cards={h.cards} main={h.main} second={h.second} reveal size="clamp(3rem,14vw,4.4rem)" />
        <div className="text-center">
          <div className="text-lg font-bold text-ivory">{locale === 'ko' ? h.ko : h.en}</div>
          {locale === 'ko' && <div className="text-xs text-ink-300">{h.en}</div>}
        </div>
        {h.second && (
          <div className="flex gap-3 text-[11px] text-ink-200">
            <span>
              <span className="mr-1 inline-block size-2.5 rounded-sm ring-2 ring-gold-400" /> {tr(l(h.key === 'full-house' ? '트리플' : '높은 페어', h.key === 'full-house' ? 'Three of a kind' : 'Top pair'))}
            </span>
            <span>
              <span className="mr-1 inline-block size-2.5 rounded-sm ring-2 ring-info" /> {tr(l(h.key === 'full-house' ? '페어' : '낮은 페어', h.key === 'full-house' ? 'Pair' : 'Second pair'))}
            </span>
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={() => choose(i)}>
          <RotateCcwIcon />
          {tr(l('다시 보기', 'Replay'))}
        </Button>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {[
          [l('성립 조건', 'What makes it'), h.rule],
          [l('주의할 점', 'Watch out'), h.caveat],
          [l('예시', 'Example'), h.example],
          [l('다른 족보와 비교', 'Compared with others'), h.beats],
        ].map(([k, v], n) => (
          <div key={n} className="rounded-xl border border-white/10 bg-ink-850 p-3">
            <dt className="text-[11px] font-bold uppercase tracking-wider text-gold-400">{tr(k!)}</dt>
            <dd className="mt-1 text-ink-100">{tr(v!)}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-between">
        <Button variant="ghost" disabled={i === 0} onClick={() => choose(i - 1)}>
          ↑ {tr(l('더 강한 족보', 'Stronger'))}
        </Button>
        <Button variant="ghost" disabled={i === HAND_RANKS.length - 1} onClick={() => choose(i + 1)}>
          {tr(l('더 약한 족보', 'Weaker'))} ↓
        </Button>
      </div>
    </div>
  );
}

export function HandsLesson() {
  const tr = useTr();
  const [done, setDone] = useState({ name: false, compare: false, sort: false });
  const steps: LessonStep[] = [
    { title: l('족보 순위 한눈에 보기', 'The ranking at a glance'), body: <OverviewStep /> },
    { title: l('족보 하나씩 자세히', 'Each hand in detail'), body: <DetailStep /> },
    { title: l('퀴즈: 이 패의 족보는?', 'Quiz: name the hand'), body: <QuizRunner questions={NAME_QUESTIONS} onDone={() => setDone((d) => ({ ...d, name: true }))} />, locked: !done.name },
    {
      title: l('퀴즈: 누가 이길까?', 'Quiz: who wins?'),
      body: (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-300">{tr(l('두 사람이 같은 보드를 함께 씁니다. 판정은 실제 게임 엔진이 합니다.', 'Both players share the board. The real game engine decides.'))}</p>
          <QuizRunner questions={COMPARE_QUESTIONS} onDone={() => setDone((d) => ({ ...d, compare: true }))} />
        </div>
      ),
      locked: !done.compare,
    },
    { title: l('퀴즈: 강한 순서로 정렬', 'Quiz: sort by strength'), body: <QuizRunner questions={[HAND_SORT]} onDone={() => setDone((d) => ({ ...d, sort: true }))} />, locked: !done.sort },
  ];
  return <LessonShell id="hands" title={l('Lesson 2 · 포커 족보', 'Lesson 2 · Hand rankings')} steps={steps} next={{ to: '/academy/holdem', label: l('Lesson 3 · 홀덤 규칙', "Lesson 3 · Hold'em rules") }} />;
}
