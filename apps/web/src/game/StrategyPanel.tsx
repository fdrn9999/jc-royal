/**
 * The replay's decision review: the viewer's own decisions in the hand (strategy.ts), each one's situation as it came
 * to them, the choices they had and the one they made, then what can honestly be put beside it. Solver frequencies
 * only from real solver data, with its source; otherwise it says the spot is not supported, and never guesses a
 * frequency. The plain arithmetic of the moment and the academy's example range are marked as for study, not a solver's.
 * Loaded only when opened (HandReplay), under the replay's controls: it lays nothing over the table or the controls.
 */
import { Badge, cardLabel, cx, inHoleOrder } from '@jc/ui';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { oddsRatio } from './potOdds';
import type { ReplayInput, ReplayStep } from './replay';
import { decisionsOf, educationalFor, handClass, OPEN_SPOT, SOLVER_PROVIDERS, solverFor, type Choice, type Decision, type EducationalNote, type SolverAnswer } from './strategy';

interface Props {
  hand: ReplayInput;
  steps: readonly ReplayStep[];
  heroSeat: number;
  /** The step on screen, and a way to go to another. */
  index: number;
  onGo: (step: number) => void;
  amounts: Amounts;
  /** Called once it has drawn, to bring it on screen. */
  onShown?: () => void;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function StrategyPanel({ hand, steps, heroSeat, index, onGo, amounts: a, onShown }: Props) {
  const { t, locale } = useI18n();
  const tr = (ko: string, en: string) => (locale === 'en' ? en : ko);
  const decisions = useMemo(() => decisionsOf(hand, steps, heroSeat), [hand, steps, heroSeat]);
  const current = decisions.find((d) => d.step === index) ?? null;
  const choice = (c: Choice) => t(`action.${c}` as MsgKey);
  const stage = (d: Decision) => t(`stage.${d.stage}` as MsgKey);

  // The room it took stays while it is open, so stepping from a decision to a step with less to say never shortens the
  // page and pulls what lies under a finger (the slider) down the screen.
  // Kept for each width it has been drawn at, where it may take fewer lines (a phone turned): back at a width, even for a
  // moment elsewhere (a window resized, a full-page capture), it has the room it took there again. What it keeps is its
  // own height, its padding and border included: the content's and what lies around it, read as it first shows (nothing
  // kept yet).
  const boxRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [keep, setKeep] = useState(0);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el || !boxRef.current) return;
    const around = boxRef.current.offsetHeight - el.offsetHeight;
    const kept = new Map<number, number>();
    const ro = new ResizeObserver(() => {
      const h = Math.max(kept.get(el.offsetWidth) ?? 0, el.offsetHeight + around);
      kept.set(el.offsetWidth, h);
      setKeep(h);
    });
    ro.observe(el);
    onShown?.();
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section ref={boxRef} id="replay-strategy" aria-labelledby="replay-strategy-title" className="rounded-xl border border-white/10 bg-black/25 p-3" style={keep > 0 ? { minHeight: keep } : undefined} data-testid="replay-strategy">
      <div ref={innerRef} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="replay-strategy-title" className="text-sm font-bold text-gold-300">
            {tr('결정 복기', 'Decision review')}
          </h4>
          <span data-testid="replay-strategy-kind">
            <Badge>{SOLVER_PROVIDERS.length === 0 ? tr('학습용 · 솔버 결과 아님', 'For study · not solver output') : tr('솔버 데이터가 있는 상황만 솔버 표시', 'Solver data only where it exists')}</Badge>
          </span>
        </div>
        {decisions.length === 0 ? (
          <p className="text-sm text-ink-200" data-testid="replay-strategy-none">
            {tr('이 핸드에는 블라인드 말고 내가 정한 액션이 없습니다.', 'You made no decision in this hand beyond the blinds.')}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1" role="group" aria-label={tr('내 결정', 'My decisions')} data-testid="replay-strategy-decisions">
              {decisions.map((d, k) => {
                const now = d === current;
                return (
                  <button
                    key={d.action}
                    type="button"
                    className={cx(
                      'h-9 rounded-md px-2 text-[11px] font-semibold whitespace-nowrap transition-colors',
                      now ? 'bg-gold-500/25 text-gold-300 ring-1 ring-gold-400/60' : 'bg-white/[0.05] text-ink-200 hover:bg-white/10',
                    )}
                    onClick={() => onGo(d.step)}
                    aria-current={now ? 'step' : undefined}
                    data-testid={`replay-strategy-decision-${k}`}
                  >
                    {stage(d)} · {choice(d.did)}
                  </button>
                );
              })}
            </div>
            {current ? (
              <Spot d={current} hand={hand} a={a} tr={tr} choice={choice} stage={stage(current)} />
            ) : (
              <p className="text-sm text-ink-200" data-testid="replay-strategy-pick">
                {tr('위에서 내 결정을 고르거나 리플레이를 내 차례로 옮기면, 그 순간의 상황과 전략 정보가 나옵니다.', 'Pick one of your decisions above, or step the replay to your turn, to see that moment and what can be said about it.')}
              </p>
            )}
          </>
        )}
        <p className="text-[11px] leading-4 text-ink-400">
          {SOLVER_PROVIDERS.length === 0
            ? tr(
                '솔버 빈도와 EV는 실제 솔버 데이터가 있는 상황에서만 출처와 함께 보여 줍니다. 지금은 솔버 데이터가 없어 모든 상황이 지원하지 않음으로 나옵니다. 학습용 계산은 단순한 모델이며 정답이 아닙니다.',
                'Solver frequencies and EV show only where real solver data exists, with its source. There is none yet, so every spot reads as not supported. The study figures are simple models, not the right answer.',
              )
            : tr('솔버 빈도와 EV는 실제 솔버 데이터가 있는 상황에서만 출처와 함께 보여 줍니다. 학습용 계산은 단순한 모델이며 정답이 아닙니다.', 'Solver frequencies and EV show only where real solver data exists, with its source. The study figures are simple models, not the right answer.')}
        </p>
      </div>
    </section>
  );
}

type Tr = (ko: string, en: string) => string;

/** One decision: the situation, the choices and the one made, the solver's answer or why there is none, the study figures. */
function Spot({ d, hand, a, tr, choice, stage }: { d: Decision; hand: ReplayInput; a: Amounts; tr: Tr; choice: (c: Choice) => string; stage: string }) {
  const { t } = useI18n();
  const bb = hand.bigBlind ?? 0;
  // Stacks read in big blinds too where the player reads chips, as a strategy is usually put.
  const deep = (chips: number) => (a.unit !== 'bb' && bb > 0 ? `${a.fmt(chips)} (${Math.round((chips / bb) * 10) / 10} BB)` : a.fmt(chips));
  const solver = solverFor(d, hand);
  const notes = educationalFor(d, hand.bigBlind);
  const cls = handClass(d.cards);
  const facing = (() => {
    const f = d.facing;
    if (!f) return d.toCall > 0 ? tr(`블라인드 · 콜 ${a.fmt(d.toCall)}`, `The blind · call ${a.fmt(d.toCall)}`) : tr('베팅 없음', 'No bet');
    const call = tr(` · 콜 ${a.fmt(d.toCall)}`, ` · call ${a.fmt(d.toCall)}`);
    if (f.kind === 'bet') return `${tr(`베팅 ${a.fmt(f.to)} (팟의 ${pct(f.to / f.potBefore)})`, `Bet ${a.fmt(f.to)} (${pct(f.to / f.potBefore)} of the pot)`)}${call}`;
    const name = d.stage === 'preflop' ? (f.raises === 1 ? tr('오픈 레이즈', 'Open raise') : `${f.raises + 1}${tr('벳', '-bet')}`) : tr('레이즈', 'Raise');
    return `${name} ${a.fmt(f.to)}${call}`;
  })();
  const did = [choice(d.did), d.amount > 0 && a.fmt(d.amount), d.allIn && t('action.allin'), d.timedOut && tr('(시간 초과)', '(timed out)')].filter(Boolean).join(' ');
  const row = 'contents [&>dt]:text-ink-400 [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:text-ink-100';
  return (
    <div className="flex flex-col gap-3" data-testid="replay-strategy-spot">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <div className={row}>
          <dt>{tr('스트리트', 'Street')}</dt>
          <dd>
            {stage}
            {d.board.length > 0 && ` · ${d.board.map(cardLabel).join(' ')}`}
          </dd>
        </div>
        <div className={row}>
          <dt>{tr('포지션', 'Position')}</dt>
          <dd data-testid="replay-strategy-position">
            {d.position ?? tr('기록으로 알 수 없음', 'Not clear from the record')} · {tr(`${d.dealt}인`, `${d.dealt}-handed`)}
          </dd>
        </div>
        {d.cards && (
          <div className={row}>
            <dt>{tr('내 패', 'My hand')}</dt>
            <dd>
              {inHoleOrder(d.cards).map(cardLabel).join(' ')}
              {cls && ` (${cls})`}
            </dd>
          </div>
        )}
        <div className={row}>
          <dt>{tr('유효 스택', 'Effective stack')}</dt>
          <dd>{deep(d.effective)}</dd>
        </div>
        <div className={row}>
          <dt>{t('table.pot')}</dt>
          <dd>{a.fmt(d.pot)}</dd>
        </div>
        <div className={row}>
          <dt>{tr('상대 베팅', 'Facing')}</dt>
          <dd>{facing}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-ink-400">{tr('선택지', 'Options')}</p>
        <ul className="flex flex-wrap gap-1" data-testid="replay-strategy-options">
          {d.options.map((c) => {
            const freq = solver.kind === 'solver' ? solver.freqs.find((f) => f.choice === c) : undefined;
            return (
              <li key={c} className={cx('rounded-md px-2 py-1 text-xs font-semibold', c === d.did ? 'bg-gold-500/20 text-gold-200 ring-1 ring-gold-400/60' : 'bg-white/[0.05] text-ink-200')} data-played={c === d.did || undefined}>
                {choice(c)}
                {freq && <span className="ml-1 font-mono tabular-nums">{pct(freq.share)}</span>}
              </li>
            );
          })}
        </ul>
        <p className="text-sm font-semibold text-ivory" data-testid="replay-strategy-played">
          {tr('실제 선택', 'Played')}: {did}
        </p>
      </div>

      <SolverBlock answer={solver} played={d.did} tr={tr} choice={choice} />
      <StudyBlock notes={notes} d={d} a={a} tr={tr} choice={choice} deep={deep} />
    </div>
  );
}

function SolverBlock({ answer, played, tr, choice }: { answer: SolverAnswer; played: Choice; tr: Tr; choice: (c: Choice) => string }) {
  if (answer.kind === 'unsupported') {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2" data-testid="replay-strategy-solver" data-kind="unsupported">
        <p className="text-xs font-semibold text-ink-100">{tr('솔버 전략 · 지원하지 않는 상황', 'Solver strategy · spot not supported')}</p>
        <p className="mt-0.5 text-xs text-ink-300">
          {answer.reason === 'noPosition'
            ? tr('기록만으로 포지션을 확정할 수 없어(놓친 블라인드 등) 솔버 상황을 찾지 않습니다.', 'The record does not settle the position (a missed blind, say), so no solver spot is looked up.')
            : tr('이 상황에 맞는 솔버 데이터가 없습니다. 빈도나 EV를 짐작해 보여 주지 않습니다.', 'There is no solver data for this spot. No frequency or EV is guessed in its place.')}
        </p>
      </div>
    );
  }
  const mine = answer.freqs.find((f) => f.choice === played);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-info/40 bg-info/10 px-2.5 py-2" data-testid="replay-strategy-solver" data-kind="solver">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink-100">{tr('솔버 전략', 'Solver strategy')}</p>
        <Badge tone="blue">{answer.source}</Badge>
      </div>
      <ul className="flex flex-col gap-1">
        {answer.freqs.map((f) => {
          const ev = answer.ev?.find((e) => e.choice === f.choice);
          return (
            <li key={f.choice} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
              <span className="text-ink-200">{choice(f.choice)}</span>
              <span className="h-2 overflow-hidden rounded-full bg-white/10" aria-hidden>
                <span className="block h-full rounded-full bg-info/70" style={{ width: pct(f.share) }} />
              </span>
              <span className="font-mono text-ink-100 tabular-nums">
                {pct(f.share)}
                {ev && ` · EV ${ev.bb >= 0 ? '+' : ''}${Math.round(ev.bb * 100) / 100} BB`}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-ink-300">
        {tr(`실제 선택(${choice(played)})의 솔버 빈도: ${mine ? pct(mine.share) : '0%'}`, `How often the solver plays your choice (${choice(played)}): ${mine ? pct(mine.share) : '0%'}`)}
      </p>
    </div>
  );
}

function StudyBlock({ notes, d, a, tr, choice, deep }: { notes: EducationalNote[]; d: Decision; a: Amounts; tr: Tr; choice: (c: Choice) => string; deep: (chips: number) => string }) {
  const { t } = useI18n();
  const link = 'font-semibold text-gold-300 underline decoration-dotted underline-offset-2 hover:text-gold-200';
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2" data-testid="replay-strategy-study">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink-100">{tr('학습용 계산', 'Figures for study')}</p>
        <Badge>{tr('솔버 결과 아님', 'Not solver output')}</Badge>
      </div>
      {notes.length === 0 ? (
        <p className="text-xs text-ink-300">{tr('이 결정에는 붙일 단순 계산이 없습니다.', 'No simple figure applies to this decision.')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-xs text-ink-200">
          {notes.map((n) => (
            <li key={n.kind} data-testid={`replay-strategy-note-${n.kind}`}>
              {n.kind === 'potOdds' && (
                <>
                  <p>{t('odds.line', { pot: a.fmt(n.odds.pot), call: a.fmt(n.odds.toCall), ratio: oddsRatio(n.odds), need: n.odds.need })}</p>
                  <p className="text-[11px] text-ink-400">
                    {t('odds.note')}{' '}
                    <Link className={link} to="/academy/gto/math?step=0">
                      {tr('계산 도구', 'Calculator')}
                    </Link>
                  </p>
                </>
              )}
              {n.kind === 'betSize' && <p>{tr(`상대 베팅 ${a.fmt(n.to)}은 베팅 전 팟 ${a.fmt(n.potBefore)}의 ${pct(n.share)}입니다.`, `The bet of ${a.fmt(n.to)} was ${pct(n.share)} of the ${a.fmt(n.potBefore)} pot before it.`)}</p>}
              {n.kind === 'spr' && (
                <p>
                  {tr(
                    `이 스트리트 시작 SPR ${n.ratio.toFixed(1)}: 유효 스택 ${deep(n.effective)} ÷ 팟 ${a.fmt(n.pot)}. 낮을수록 올인까지 남은 베팅이 적습니다.`,
                    `SPR as the street began ${n.ratio.toFixed(1)}: effective stack ${deep(n.effective)} ÷ pot ${a.fmt(n.pot)}. The lower it is, the fewer bets are left before all in.`,
                  )}
                </p>
              )}
              {n.kind === 'openRange' && (
                <>
                  <p>
                    {tr(
                      `아카데미의 예시 오픈 범위(${OPEN_SPOT.players}인 · 100BB · 앞에서 모두 폴드)에서 ${n.seat}의 ${n.hand}는 범위 ${n.inRange ? '안' : '밖'}입니다. 실제 선택: ${choice(d.did)}.`,
                      `In the academy's example opening range (${OPEN_SPOT.players}-handed, 100 BB, folded to you), ${n.hand} from ${n.seat} is ${n.inRange ? 'in' : 'out of'} the range. You chose: ${choice(d.did)}.`,
                    )}{' '}
                    <span className={n.inRange === n.opened ? 'text-[#9fd8b6]' : 'text-gold-300'} data-testid="replay-strategy-range-match">
                      {n.inRange === n.opened ? tr('예시와 같음', 'Same as the example') : tr('예시와 다름', 'Unlike the example')}
                    </span>
                  </p>
                  <p className="text-[11px] text-ink-400">
                    {tr('아카데미가 가르치려고 만든 단순한 예시이며 솔버 결과가 아닙니다. 실제 범위는 스택, 레이크, 뒤의 플레이어에 따라 달라집니다.', 'A simple teaching picture made for the academy, not solver output. Real ranges move with stacks, rake and the players behind.')}{' '}
                    <Link className={link} to="/academy/gto/position">
                      {tr('포지션 학습', 'Position module')}
                    </Link>
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
