/**
 * Shared Academy building blocks: lesson shell with steps, tappable cards,
 * quiz views (pick / choice / sort / compare) and the hand-ranking chart.
 * Cards are the real PlayingCard component; feedback uses @jc/audio, which
 * stays silent when the player muted it.
 */
import { sound } from '@jc/audio';
import type { Card } from '@jc/types';
import { Button, cx, PlayingCard } from '@jc/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { cardName, l, useTr, type L } from './content';
import { completeLesson, recordAnswer, startLesson, updateProgress, type LessonId } from './progress';
import { judgeChoice, judgeCompare, judgePick, judgeSort, type ChoiceQuestion, type CompareQuestion, type CompareResult, type PickQuestion, type Question, type SortQuestion } from './quiz';

export const UI = {
  academy: l('포커 아카데미', 'Poker Academy'),
  back: l('아카데미', 'Academy'),
  prev: l('이전', 'Back'),
  next: l('다음', 'Next'),
  finish: l('레슨 완료', 'Finish lesson'),
  correct: l('정답입니다!', 'Correct!'),
  wrong: l('아쉬워요. 다시 선택해 보세요.', 'Not quite — try again.'),
  retry: l('다시 선택', 'Try again'),
  check: l('확인', 'Check answer'),
  step: l('단계', 'Step'),
  question: l('문제 {i}/{n}', 'Question {i}/{n}'),
  done: l('완료!', 'Done!'),
  nextLesson: l('다음 레슨', 'Next lesson'),
  toAcademy: l('아카데미로', 'Back to Academy'),
  a: l('A', 'A'),
  b: l('B', 'B'),
  split: l('무승부 (스플릿)', 'Tie (split)'),
  board: l('보드', 'Board'),
  sortHint: l('카드를 끌어 옮기거나, 두 장을 차례로 눌러 자리를 바꾸세요.', 'Drag to reorder, or tap two items to swap them.'),
  strongest: l('강함', 'Strongest'),
  weakest: l('약함', 'Weakest'),
};

export function useHaptic() {
  return (ms = 10) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* unsupported */
    }
  };
}

// ------------------------------------------------------------------ lesson shell

export interface LessonStep {
  title: L;
  body: ReactNode;
  /** Step content decides when "Next" unlocks (e.g. after a quiz). Defaults to unlocked. */
  locked?: boolean;
}

export function LessonShell({ id, title, steps, next }: { id: LessonId; title: L; steps: LessonStep[]; next?: { to: string; label: L } }) {
  const tr = useTr();
  const { me } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const step = Math.min(steps.length - 1, Math.max(0, Number(params.get('step') ?? 0) || 0));
  const [finished, setFinished] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => sound.installAutoUnlock(), []);
  useEffect(() => {
    if (me) updateProgress(me.id, (p) => startLesson(p, id, step, Date.now()));
  }, [me, id, step]);

  const go = (s: number) => {
    setParams({ step: String(s) }, { replace: true });
    top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const cur = steps[step]!;
  const last = step === steps.length - 1;
  const finish = () => {
    if (me) updateProgress(me.id, (p) => completeLesson(p, id, Date.now()));
    sound.play('complete');
    setFinished(true);
  };

  return (
    <div ref={top} className="mx-auto flex max-w-3xl scroll-mt-20 flex-col gap-4" data-testid={`lesson-${id}`}>
      <div className="flex items-center gap-2 text-sm">
        <Link to="/academy" className="jc-tap -ml-2 rounded-lg px-2 py-2 text-ink-300 hover:text-ivory">
          ← {tr(UI.back)}
        </Link>
      </div>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-xl font-bold tracking-[0.08em] text-gold-300 sm:text-2xl">{tr(title)}</h1>
        <ol className="flex gap-1.5" aria-label={tr(UI.step)}>
          {steps.map((s, i) => (
            <li key={i} className="min-w-0 flex-1">
              <button
                onClick={() => i <= step && go(i)}
                disabled={i > step}
                className={cx('jc-tap block h-2.5 w-full rounded-full transition', i < step ? 'bg-gold-500' : i === step ? 'bg-gold-300' : 'bg-white/10')}
                aria-label={`${i + 1}. ${tr(s.title)}`}
                aria-current={i === step ? 'step' : undefined}
              />
            </li>
          ))}
        </ol>
        <h2 className="text-base font-bold text-ivory" data-testid="step-title">
          <span className="mr-2 font-mono text-gold-400">{step + 1}/{steps.length}</span>
          {tr(cur.title)}
        </h2>
      </header>

      <section key={step} className="jc-panel animate-rise p-4 sm:p-6">
        {cur.body}
      </section>

      {finished ? (
        <div className="jc-panel jc-pop flex flex-col items-center gap-3 p-6 text-center" data-testid="lesson-done" role="status">
          <div className="text-3xl">🏆</div>
          <div className="text-lg font-bold text-gold-300">{tr(UI.done)}</div>
          <div className="flex flex-wrap justify-center gap-2">
            {next && (
              <Button size="lg" onClick={() => nav(next.to)}>
                {tr(next.label)} →
              </Button>
            )}
            <Button size="lg" variant="outline" onClick={() => nav('/academy')}>
              {tr(UI.toAcademy)}
            </Button>
          </div>
        </div>
      ) : (
        <nav className="flex items-center justify-between gap-3 pb-4">
          <Button variant="ghost" size="lg" disabled={step === 0} onClick={() => go(step - 1)}>
            ← {tr(UI.prev)}
          </Button>
          {last ? (
            <Button size="lg" disabled={cur.locked} onClick={finish} data-testid="lesson-finish">
              {tr(UI.finish)} ✓
            </Button>
          ) : (
            <Button size="lg" disabled={cur.locked} onClick={() => go(step + 1)} data-testid="lesson-next">
              {tr(UI.next)} →
            </Button>
          )}
        </nav>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ cards

type Mark = 'correct' | 'wrong' | 'selected' | null;

export function CardButton({ card, size = 'clamp(3.2rem,15vw,4.6rem)', mark, onClick, disabled, dim }: { card: Card; size?: string; mark?: Mark; onClick?: () => void; disabled?: boolean; dim?: boolean }) {
  const { locale } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={cardName(card, locale)}
      aria-pressed={mark === 'selected' ? true : undefined}
      data-pick={card}
      className={cx(
        'jc-tap select-none rounded-[0.7rem] p-1 transition outline-offset-4',
        mark === 'correct' && 'jc-pop bg-success/25 ring-2 ring-success',
        mark === 'wrong' && 'jc-shake bg-danger/20 ring-2 ring-danger',
        mark === 'selected' && 'bg-gold-500/20 ring-2 ring-gold-400',
        !mark && !disabled && 'hover:-translate-y-1',
      )}
      style={{ WebkitTouchCallout: 'none' }}
    >
      <PlayingCard card={card} size={size} dim={dim} />
    </button>
  );
}

export function CardRow({ cards, size, main = [], second = [], reveal = false }: { cards: Card[]; size?: string; main?: number[]; second?: number[]; reveal?: boolean }) {
  return (
    <div className="flex flex-wrap items-end justify-center gap-1.5 sm:gap-2">
      {cards.map((c, i) => {
        const grp = main.includes(i) ? 'main' : second.includes(i) ? 'second' : main.length ? 'kick' : null;
        return (
          <div key={`${c}-${i}`} className={cx('rounded-[0.7rem] p-0.5 transition', grp === 'main' && 'ring-2 ring-gold-400', grp === 'second' && 'ring-2 ring-info')}>
            <PlayingCard card={c} size={size ?? 'clamp(2.6rem,12vw,3.6rem)'} animate={reveal ? 'flip' : false} dim={grp === 'kick'} style={reveal ? { animationDelay: `${i * 140}ms` } : undefined} />
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ feedback

function Feedback({ state, explain, why, onNext, nextLabel }: { state: 'correct' | 'wrong'; explain: L; why?: L | null; onNext?: () => void; nextLabel?: L }) {
  const tr = useTr();
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={state === 'correct' ? 'feedback-correct' : 'feedback-wrong'}
      className={cx('flex flex-col gap-2 rounded-xl border p-3 text-sm', state === 'correct' ? 'jc-pop border-success/40 bg-success/10 text-[#bfe9d0]' : 'jc-shake border-danger/40 bg-danger/10 text-[#f3c3c4]')}
    >
      <div className="font-bold">{state === 'correct' ? `✓ ${tr(UI.correct)}` : `✗ ${tr(UI.wrong)}`}</div>
      {state === 'wrong' && why && <p>{tr(why)}</p>}
      {state === 'correct' && <p className="text-ink-100">{tr(explain)}</p>}
      {state === 'correct' && onNext && (
        <Button className="self-end" onClick={onNext} data-testid="quiz-next">
          {tr(nextLabel ?? UI.next)} →
        </Button>
      )}
    </div>
  );
}

function useAnswer(onCorrect: () => void) {
  const { me } = useAuth();
  const haptic = useHaptic();
  return (ok: boolean) => {
    if (me) updateProgress(me.id, (p) => recordAnswer(p, ok));
    sound.play(ok ? 'correct' : 'wrong');
    haptic(ok ? 12 : 30);
    if (ok) onCorrect();
  };
}

// ------------------------------------------------------------------ question views

function PickView({ q, onSolved }: { q: PickQuestion; onSolved: () => void }) {
  const tr = useTr();
  const [picked, setPicked] = useState<{ card: Card; ok: boolean } | null>(null);
  const answer = useAnswer(onSolved);
  const solved = picked?.ok === true;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap justify-center gap-2 sm:gap-3" role="group" aria-label={tr(q.prompt)}>
        {q.cards.map((c) => (
          <CardButton
            key={c}
            card={c}
            disabled={solved}
            mark={picked?.card === c ? (picked.ok ? 'correct' : 'wrong') : null}
            onClick={() => {
              const ok = judgePick(q, c);
              setPicked({ card: c, ok });
              answer(ok);
            }}
          />
        ))}
      </div>
      {picked && <Feedback state={picked.ok ? 'correct' : 'wrong'} explain={q.explain} why={picked.ok ? null : q.why(picked.card)} />}
    </div>
  );
}

function ChoiceView({ q, onSolved }: { q: ChoiceQuestion; onSolved: () => void }) {
  const tr = useTr();
  const [picked, setPicked] = useState<{ id: string; ok: boolean } | null>(null);
  const answer = useAnswer(onSolved);
  const solved = picked?.ok === true;
  return (
    <div className="flex flex-col gap-4">
      {q.cards && <CardRow cards={q.cards} />}
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={tr(q.prompt)}>
        {q.options.map((o) => (
          <button
            key={o.id}
            disabled={solved}
            data-choice={o.id}
            onClick={() => {
              const ok = judgeChoice(q, o.id);
              setPicked({ id: o.id, ok });
              answer(ok);
            }}
            className={cx(
              'jc-tap min-h-12 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition',
              picked?.id === o.id ? (picked.ok ? 'jc-pop border-success bg-success/15 text-[#bfe9d0]' : 'jc-shake border-danger bg-danger/10 text-[#f3c3c4]') : 'border-white/10 bg-ink-850 text-ivory hover:border-gold-500/50',
            )}
          >
            {tr(o.label)}
          </button>
        ))}
      </div>
      {picked && <Feedback state={picked.ok ? 'correct' : 'wrong'} explain={q.explain} why={picked.ok ? null : q.why} />}
    </div>
  );
}

/** Reorder by pointer drag (mouse or touch) or by tapping two items to swap. */
function SortView({ q, onSolved }: { q: SortQuestion; onSolved: () => void }) {
  const tr = useTr();
  const { locale } = useI18n();
  const [order, setOrder] = useState(() => q.items.map((_, i) => i));
  const [sel, setSel] = useState<number | null>(null);
  const [result, setResult] = useState<boolean | null>(null);
  const [drag, setDrag] = useState<{ from: number; x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const answer = useAnswer(onSolved);
  const haptic = useHaptic();
  const single = q.items.every((it) => it.length === 1);
  const solved = result === true;

  const move = (from: number, to: number) => {
    if (from === to) return;
    setOrder((o) => {
      const n = [...o];
      const [x] = n.splice(from, 1);
      n.splice(to, 0, x!);
      return n;
    });
  };
  /** Slot under the pointer; the dragged item itself follows the pointer, so it is skipped. */
  const nearest = (x: number, y: number, self: number) => {
    let best = self;
    let dist = Infinity;
    refs.current.forEach((el, i) => {
      if (!el || i === self) return;
      const r = el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };
  const tap = (pos: number) => {
    if (solved) return;
    setResult(null);
    if (sel === null) {
      setSel(pos);
      sound.play('select');
      haptic(6);
    } else {
      setOrder((o) => {
        const n = [...o];
        [n[sel], n[pos]] = [n[pos]!, n[sel]!];
        return n;
      });
      setSel(null);
      sound.play('select');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-300">{tr(UI.sortHint)}</p>
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-ink-400">
        <span>← {tr(UI.strongest)}</span>
        <span>{tr(UI.weakest)} →</span>
      </div>
      <div className={cx('flex gap-2', single ? 'flex-wrap justify-center' : 'flex-col')} data-testid="sort-row">
        {order.map((item, pos) => {
          const cards = q.items[item]!;
          const dragging = drag?.from === pos && drag.moved;
          return (
            <button
              key={item}
              ref={(el) => {
                refs.current[pos] = el;
              }}
              type="button"
              disabled={solved}
              data-sort-item={item}
              aria-label={`${pos + 1}. ${cards.map((c) => cardName(c, locale)).join(', ')}`}
              aria-pressed={sel === pos}
              onPointerDown={(e) => {
                if (solved) return;
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDrag({ from: pos, x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false });
              }}
              onPointerMove={(e) => {
                if (!drag || drag.from !== pos) return;
                const dx = e.clientX - drag.x;
                const dy = e.clientY - drag.y;
                setDrag({ ...drag, dx, dy, moved: drag.moved || Math.hypot(dx, dy) > 8 });
              }}
              onPointerUp={(e) => {
                if (!drag || drag.from !== pos) return;
                const d = drag;
                setDrag(null);
                if (d.moved) {
                  move(pos, nearest(e.clientX, e.clientY, pos));
                  setSel(null);
                  setResult(null);
                  sound.play('select');
                } else tap(pos);
              }}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  tap(pos);
                }
              }}
              onClick={(e) => e.preventDefault()}
              className={cx(
                'relative flex select-none items-center gap-2 rounded-xl border p-1.5 transition-colors',
                single ? '' : 'justify-start',
                sel === pos ? 'border-gold-400 bg-gold-500/15' : 'border-white/10 bg-ink-850/70',
                result === true && 'border-success/60',
                result === false && 'jc-shake border-danger/60',
                dragging && 'z-10 shadow-2xl',
              )}
              style={{ touchAction: 'none', transform: dragging ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined }}
            >
              {!single && <span className="w-5 shrink-0 text-center font-mono text-xs text-gold-400">{pos + 1}</span>}
              <span className="flex gap-1">
                {cards.map((c) => (
                  <PlayingCard key={c} card={c} size={single ? 'clamp(3rem,14vw,4.2rem)' : 'clamp(2rem,9vw,2.8rem)'} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {result !== true && (
        <Button
          className="self-center"
          size="lg"
          onClick={() => {
            const ok = judgeSort(q, order);
            setResult(ok);
            answer(ok);
          }}
          data-testid="sort-check"
        >
          {tr(UI.check)}
        </Button>
      )}
      {result !== null && <Feedback state={result ? 'correct' : 'wrong'} explain={q.explain} why={result ? null : l('아직 순서가 맞지 않아요. 가장 강한 것이 왼쪽(위)에 오도록 바꿔 보세요.', 'Not in order yet. Put the strongest first (left / top).')} />}
    </div>
  );
}

function CompareView({ q, onSolved }: { q: CompareQuestion; onSolved: () => void }) {
  const tr = useTr();
  const { t } = useI18n();
  const [res, setRes] = useState<CompareResult | null>(null);
  const [picked, setPicked] = useState<{ id: string; ok: boolean } | null>(null);
  const answer = useAnswer(onSolved);
  useEffect(() => {
    let live = true;
    void judgeCompare(q).then((r) => live && setRes(r));
    return () => {
      live = false;
    };
  }, [q]);
  const solved = picked?.ok === true;
  const hand = (who: 'a' | 'b') => {
    const cards = who === 'a' ? q.a : q.b;
    const r = res?.[who];
    const wins = solved && (res?.answer === who || res?.answer === 'split');
    return (
      <div className={cx('flex flex-col items-center gap-1.5 rounded-xl border p-2', wins ? 'border-gold-400 bg-gold-500/10' : 'border-white/10 bg-ink-850/60')} data-testid={`hand-${who}`}>
        <div className="text-xs font-bold text-gold-300">{tr(UI[who])}</div>
        <div className="flex gap-1">
          {cards.map((c) => (
            <PlayingCard key={c} card={c} size="clamp(2.4rem,11vw,3.2rem)" highlight={solved && !!r?.bestFive.includes(c)} />
          ))}
        </div>
        {solved && r && <div className="text-xs font-semibold text-ivory">{t(`hand.${r.label}` as MsgKey)}</div>}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{tr(UI.board)}</div>
        <div className="flex gap-1">
          {q.board.map((c) => (
            <PlayingCard key={c} card={c} size="clamp(2.4rem,11vw,3.2rem)" highlight={solved && !!(res?.a.bestFive.includes(c) || res?.b.bestFive.includes(c))} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {hand('a')}
        {hand('b')}
      </div>
      <div className="grid grid-cols-3 gap-2" role="group">
        {(['a', 'b', 'split'] as const).map((id) => (
          <button
            key={id}
            disabled={!res || solved}
            data-choice={id}
            onClick={() => {
              const ok = res!.answer === id;
              setPicked({ id, ok });
              answer(ok);
            }}
            className={cx(
              'jc-tap min-h-12 rounded-xl border px-2 py-2 text-sm font-bold transition disabled:opacity-60',
              picked?.id === id ? (picked.ok ? 'jc-pop border-success bg-success/15' : 'jc-shake border-danger bg-danger/10') : 'border-white/10 bg-ink-850 hover:border-gold-500/50',
            )}
          >
            {id === 'split' ? tr(UI.split) : `${tr(UI[id])} ${tr(l('승리', 'wins'))}`}
          </button>
        ))}
      </div>
      {picked && <Feedback state={picked.ok ? 'correct' : 'wrong'} explain={q.explain} why={picked.ok ? null : l('두 패의 족보를 먼저 확인하고, 같다면 숫자와 킥커를 비교해 보세요.', 'Name both hands first; if they match, compare ranks and kickers.')} />}
    </div>
  );
}

export function QuestionView({ q, onSolved }: { q: Question; onSolved: () => void }) {
  switch (q.kind) {
    case 'pick':
      return <PickView q={q} onSolved={onSolved} />;
    case 'choice':
      return <ChoiceView q={q} onSolved={onSolved} />;
    case 'sort':
      return <SortView q={q} onSolved={onSolved} />;
    case 'compare':
      return <CompareView q={q} onSolved={onSolved} />;
  }
}

/** Runs questions in order; `onDone` fires after the last one is solved. */
export function QuizRunner({ questions, onDone }: { questions: Question[]; onDone: () => void }) {
  const tr = useTr();
  const [i, setI] = useState(0);
  const [solved, setSolved] = useState(false);
  const q = questions[i]!;
  const last = i === questions.length - 1;
  return (
    <div className="flex flex-col gap-4" data-testid="quiz" data-question={q.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-gold-500/15 px-2.5 py-1 font-mono text-xs font-semibold text-gold-300">{tr(UI.question, { i: i + 1, n: questions.length })}</span>
        <div className="flex gap-1" aria-hidden>
          {questions.map((_, k) => (
            <span key={k} className={cx('size-2 rounded-full', k < i || (k === i && solved) ? 'bg-gold-400' : 'bg-white/15')} />
          ))}
        </div>
      </div>
      <h3 className="text-lg font-bold text-ivory" data-testid="quiz-prompt">
        {tr(q.prompt)}
      </h3>
      <QuestionView
        key={q.id}
        q={q}
        onSolved={() => {
          setSolved(true);
          if (last) onDone();
        }}
      />
      {solved && !last && (
        <Button
          size="lg"
          className="self-end"
          data-testid="quiz-next"
          onClick={() => {
            setI(i + 1);
            setSolved(false);
          }}
        >
          {tr(UI.next)} →
        </Button>
      )}
    </div>
  );
}

export { HandRankingChart, HandRankRow } from './HandChart';
