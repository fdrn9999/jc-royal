import { Button, cx, Modal, Stat } from '@jc/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { l, useTr } from '../content';
import { buildScenarios } from '../practice/scenarios';
import { isDone, LESSON_IDS, percent, resetProgress, tutorialComplete, useProgress } from '../progress';
import { UI } from '../ui';
import { LESSONS } from './AcademyPage';

export function ProgressPage() {
  const tr = useTr();
  const { locale } = useI18n();
  const { me } = useAuth();
  const p = useProgress(me?.id);
  const [confirm, setConfirm] = useState(false);
  const date = (ms: number) => (ms ? new Date(ms).toLocaleDateString(locale === 'ko' ? 'ko-KR' : 'en-US') : '—');
  const total = p.quiz.correct + p.quiz.wrong;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4" data-testid="academy-progress">
      <Link to="/academy" className="jc-tap -ml-2 self-start rounded-lg px-2 py-2 text-sm text-ink-300 hover:text-ivory">
        ← {tr(UI.back)}
      </Link>
      <h1 className="font-display text-xl font-bold tracking-[0.08em] text-gold-300">{tr(l('학습 진행 현황', 'Learning progress'))}</h1>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={tr(l('진행률', 'Progress'))} value={`${percent(p)}%`} />
        <Stat label={tr(l('정답', 'Correct'))} value={p.quiz.correct} />
        <Stat label={tr(l('오답', 'Wrong'))} value={p.quiz.wrong} />
        <Stat label={tr(l('정답률', 'Accuracy'))} value={total ? `${Math.round((p.quiz.correct / total) * 100)}%` : '—'} />
      </div>
      {tutorialComplete(p) && <div className="jc-panel border-gold-400/60 p-4 text-center font-bold text-gold-300">🏆 {tr(l('튜토리얼을 모두 완료했습니다!', 'Tutorial complete!'))}</div>}
      <section className="jc-panel divide-y divide-white/5">
        {LESSON_IDS.map((id) => {
          const x = p.lessons[id];
          return (
            <div key={id} className="flex items-center gap-3 p-3 text-sm">
              <span className={cx('grid size-8 shrink-0 place-items-center rounded-lg', isDone(p, id) ? 'bg-gold-500 text-ink-950' : 'bg-ink-700 text-ink-300')}>{isDone(p, id) ? '✓' : LESSONS[id].n}</span>
              <span className="min-w-0 flex-1 font-semibold text-ivory">{tr(LESSONS[id].title)}</span>
              <span className="text-xs text-ink-400">{x ? (isDone(p, id) ? `${tr(l('완료', 'Done'))} ${date(x.completedAt ?? 0)}` : `${tr(l('단계', 'Step'))} ${x.step + 1}`) : tr(l('시작 전', 'Not started'))}</span>
            </div>
          );
        })}
      </section>
      <section className="jc-panel p-3">
        <h2 className="mb-2 text-sm font-bold text-gold-300">{tr(l('연습 시나리오', 'Practice scenarios'))}</h2>
        <div className="flex flex-wrap gap-2">
          {buildScenarios('').map((s) => (
            <Link key={s.id} to={`/academy/practice/${s.id}`} className={cx('jc-tap rounded-full border px-3 py-1.5 text-xs font-semibold', p.practice[s.id] ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300')}>
              {s.id}. {tr(s.title)}
            </Link>
          ))}
        </div>
      </section>
      <Button variant="outline" className="self-start" onClick={() => setConfirm(true)} data-testid="academy-reset">
        {tr(l('처음부터 다시 배우기', 'Start over'))}
      </Button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={tr(l('학습 기록 초기화', 'Reset progress'))}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {tr(l('취소', 'Cancel'))}
            </Button>
            <Button
              variant="danger"
              data-testid="academy-reset-confirm"
              onClick={() => {
                if (me) resetProgress(me.id);
                setConfirm(false);
              }}
            >
              {tr(l('초기화', 'Reset'))}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-200">{tr(l('완료한 레슨, 연습 기록, 퀴즈 점수가 지워집니다. 칩·핸드 기록에는 영향이 없습니다.', 'Completed lessons, practice and quiz scores are cleared. Chips and hand history are not affected.'))}</p>
      </Modal>
    </div>
  );
}
