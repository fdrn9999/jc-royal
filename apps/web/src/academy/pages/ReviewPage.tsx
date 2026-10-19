import { sound } from '@jc/audio';
import { ACADEMY_REVIEW_SIZE } from '@jc/types';
import { Button, cx } from '@jc/ui';
import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../../lib/auth';
import { l, useTr } from '../content';
import { finishReview, updateProgress, useProgress, weakTopics } from '../progress';
import type { Question } from '../quiz';
import { buildReview, seeded, TOPIC_INFO } from '../review';
import { AnswerContext, QuizRunner, UI } from '../ui';
import { LESSONS } from './AcademyPage';

const T = {
  title: l('복습 · 랜덤 퀴즈', 'Review · Random quiz'),
  sub: l('문제는 매번 무작위 카드로 새로 만들어지고, 정답은 실제 게임 엔진과 평가기가 판정합니다.', 'Questions are dealt fresh from random cards each time; the real engine and evaluator decide the answers.'),
  weak: l('보완이 필요한 개념', 'Concepts to work on'),
  none: l('아직 틀린 개념이 없습니다. 랜덤 퀴즈로 실력을 확인해 보세요.', 'No weak spots yet. Try a random quiz.'),
  review: l('약점 위주로 복습', 'Review my weak spots'),
  random: l('랜덤 퀴즈', 'Random quiz'),
  goLesson: l('레슨 다시 보기', 'Revisit lesson'),
  score: l('첫 시도 정답 {s}/{n}', 'First-try correct: {s}/{n}'),
  again: l('새 문제로 다시', 'New set'),
};

export function ReviewPage() {
  const tr = useTr();
  const { me } = useAuth();
  const p = useProgress(me?.id);
  const [params, setParams] = useSearchParams();
  const mode = params.get('mode');
  const [seed, setSeed] = useState(() => Date.now() % 1_000_000);
  const [done, setDone] = useState<number | null>(null);
  const firstTry = useRef(new Map<string, boolean>());
  // Built once per set: the mix is decided by the mistakes at the start of the set.
  const questions = useMemo<Question[] | null>(() => (mode ? buildReview(p, seeded(seed), ACADEMY_REVIEW_SIZE, mode === 'random') : null), [mode, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const weak = weakTopics(p);

  const start = (m: 'review' | 'random') => {
    firstTry.current = new Map();
    setDone(null);
    setSeed(Date.now() % 1_000_000);
    setParams({ mode: m });
  };
  const onAnswer = (q: Question, ok: boolean) => {
    if (!firstTry.current.has(q.id)) firstTry.current.set(q.id, ok);
  };
  const finish = () => {
    const score = [...firstTry.current.values()].filter(Boolean).length;
    if (me) updateProgress(me.id, (x) => finishReview(x, score));
    sound.play('complete');
    setDone(score);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4" data-testid="review">
      <Link to="/academy" className="jc-tap -ml-2 self-start rounded-lg px-2 py-2 text-sm text-ink-300 hover:text-ivory">
        ← {tr(UI.back)}
      </Link>
      <h1 className="font-display text-xl font-bold tracking-[0.08em] text-gold-300 sm:text-2xl">{tr(T.title)}</h1>
      <p className="text-sm text-ink-300">{tr(T.sub)}</p>

      {!questions && (
        <>
          <section className="jc-panel p-4" data-testid="weak-topics">
            <h2 className="mb-2 text-sm font-bold text-gold-300">{tr(T.weak)}</h2>
            {weak.length === 0 ? (
              <p className="text-sm text-ink-300">{tr(T.none)}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {weak.map(({ topic, count }) => {
                  const info = TOPIC_INFO[topic];
                  return (
                    <li key={topic} className="flex items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm" data-topic={topic}>
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger/20 font-mono text-xs font-bold text-danger-soft">{count}</span>
                      <span className="min-w-0 flex-1 font-semibold text-ivory">{tr(info.name)}</span>
                      <Link to={`${LESSONS[info.lesson].to}?step=${info.step}`} className="jc-tap shrink-0 rounded-lg px-2 py-2 text-xs font-semibold text-gold-300 hover:underline">
                        {tr(T.goLesson)} →
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => start('review')} disabled={weak.length === 0} data-testid="start-review">
              {tr(T.review)}
            </Button>
            <Button size="lg" variant="outline" onClick={() => start('random')} data-testid="start-random">
              {tr(T.random)}
            </Button>
          </div>
        </>
      )}

      {questions && done === null && (
        <section className="jc-panel p-4 sm:p-6" key={seed}>
          <AnswerContext.Provider value={onAnswer}>
            <QuizRunner questions={questions} onDone={finish} />
          </AnswerContext.Provider>
        </section>
      )}

      {questions && done !== null && (
        <section className={cx('jc-panel jc-pop flex flex-col items-center gap-3 p-6 text-center')} data-testid="review-done" role="status">
          <div className="text-3xl">{done >= questions.length - 1 ? '🏆' : '📘'}</div>
          <div className="text-lg font-bold text-gold-300">{tr(T.score, { s: done, n: questions.length })}</div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => start(mode === 'random' ? 'random' : 'review')}>{tr(T.again)}</Button>
            <Button variant="outline" onClick={() => setParams({})}>
              {tr(T.weak)}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
