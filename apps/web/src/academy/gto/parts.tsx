/**
 * Advanced GTO Academy: small building blocks shared by its tools and pages: number fields and sliders, result tiles,
 * the step-by-step formula box, the accuracy note, the 13x13 range grid, a card picker and answer options. Right and
 * wrong, in range and selected are each shown by a shape or text as well as a colour (colour-vision modes).
 */
import type { Card } from '@jc/types';
import { CheckIcon, cx, PlayingCard, XIcon } from '@jc/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';
import { cardName, l, useTr, type L } from '../content';
import { cellClass, comboCount, MATRIX_RANKS, parseClass } from './math';
import type { GtoOption } from './types';

export const G = {
  steps: l('계산 과정', 'How it is worked out'),
  exact: l('정확한 값', 'Exact'),
  exactIn: l('이 모델 안에서 정확한 값', 'Exact within this model'),
  estimate: l('어림값', 'Estimate'),
  example: l('학습용 예시', 'Teaching example'),
  assumptions: l('가정', 'Assumptions'),
  inRange: l('레인지 안', 'in range'),
  outRange: l('레인지 밖', 'not in range'),
  combos: l('{n}콤보', '{n} combos'),
  picked: l('선택한 카드', 'Picked cards'),
  clear: l('비우기', 'Clear'),
  answer: l('정답', 'Answer'),
  yours: l('내 선택', 'Your pick'),
  pair: l('페어', 'pair'),
  suited: l('수딧', 'suited'),
  offsuit: l('오프수딧', 'offsuit'),
};

/** A tick or a cross in a disc, so a right or wrong answer never rests on colour alone. */
export function Mark({ ok, className }: { ok: boolean; className?: string }) {
  return (
    <span aria-hidden className={cx('grid size-6 shrink-0 place-items-center rounded-full text-xs font-black text-ink-950 shadow ring-2 ring-ink-950', ok ? 'bg-success' : 'bg-danger', className)} data-mark={ok ? 'correct' : 'wrong'}>
      {ok ? <CheckIcon className="size-3.5 stroke-[3px]" /> : <XIcon className="size-3.5 stroke-[3px]" />}
    </span>
  );
}

/** A number field that lets the text be cleared or half-typed while editing; only valid values reach `onChange`. */
export function Num({ label, value, onChange, min = 0, max = 100_000, step = 1, testid }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; testid?: string }) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText((t) => (t !== '' && Number(t) === value ? t : String(value))), [value]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold text-ink-300">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
        onBlur={() => setText(String(value))}
        className="h-11 w-full min-w-0 rounded-lg border border-white/10 bg-ink-850 px-3 font-mono text-base text-ivory focus:border-gold-500/60 focus:outline-none"
        data-testid={testid}
      />
    </div>
  );
}

export function Slider({ label, value, onChange, min, max, step = 1, format, testid }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format: (v: number) => string; testid?: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-ink-300">
        <label htmlFor={id}>{label}</label>
        <span className="font-mono text-gold-300">{format(value)}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={format(value)} className="h-8 w-full accent-[var(--color-gold-500)]" data-testid={testid} />
    </div>
  );
}

export function Out({ label, value, sub, strong, testid }: { label: string; value: string; sub?: string; strong?: boolean; testid?: string }) {
  return (
    <div className={cx('flex min-w-0 flex-col rounded-xl border px-3 py-2', strong ? 'border-gold-500/50 bg-gold-500/10' : 'border-white/10 bg-ink-850/70')}>
      <span className="text-[11px] font-semibold text-ink-300">{label}</span>
      <span className={cx('font-mono text-lg font-bold', strong ? 'text-gold-300' : 'text-ivory')} data-testid={testid}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-ink-400">{sub}</span>}
    </div>
  );
}

/** The formula with the numbers put in, one line per step. */
export function Steps({ lines }: { lines: L[] }) {
  const tr = useTr();
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-white/10 bg-ink-900/60 p-3" data-testid="calc-steps">
      <div className="text-[11px] font-bold tracking-wider text-ink-400">{tr(G.steps)}</div>
      <ol className="flex flex-col gap-1 text-xs leading-relaxed text-ink-100">
        {lines.map((x, i) => (
          <li key={i} className="break-words">
            <span className="mr-1 font-mono text-gold-400">{i + 1}.</span>
            {tr(x)}
          </li>
        ))}
      </ol>
    </div>
  );
}

export type Accuracy = 'exact' | 'estimate' | 'example';

/** Says whether a number is exact (within the stated model), an estimate, or an illustrative example, and the model. */
export function Note({ accuracy, children }: { accuracy: Accuracy; children: L }) {
  const tr = useTr();
  const tag = accuracy === 'exact' ? G.exactIn : accuracy === 'estimate' ? G.estimate : G.example;
  return (
    <p className="rounded-lg border border-white/10 bg-ink-850/60 px-3 py-2 text-xs leading-relaxed text-ink-300" data-accuracy={accuracy}>
      <span className="mr-1.5 inline-block rounded border border-gold-500/40 px-1.5 py-px text-[11px] font-bold text-gold-300">{tr(tag)}</span>
      {tr(children)}
    </p>
  );
}

export function ToolBox({ title, children, testid }: { title: L; children: ReactNode; testid?: string }) {
  const tr = useTr();
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-gold-500/25 bg-ink-900/40 p-3 sm:p-4" data-testid={testid}>
      <h3 className="text-sm font-bold text-gold-300">🧮 {tr(title)}</h3>
      {children}
    </section>
  );
}

/** "AKs" → "AKs (수딧, 4콤보)". */
export function classInfo(cls: string, tr: ReturnType<typeof useTr>): string {
  const p = parseClass(cls);
  const kind = p?.kind === 'pair' ? G.pair : p?.kind === 'suited' ? G.suited : G.offsuit;
  return `${cls} (${tr(kind)}, ${tr(G.combos, { n: comboCount(cls) })})`;
}

/**
 * The 13x13 starting-hand grid: pairs on the diagonal, suited above it, offsuit below. Cells in `range` are filled and
 * carry a dot; the `selected` one has a ring and a bold border. Each cell is a button named for screen readers.
 */
export function RangeGrid({ range, selected, onCell, label, testid }: { range: ReadonlySet<string>; selected?: string | null; onCell?: (cls: string) => void; label: string; testid?: string }) {
  const tr = useTr();
  return (
    <div className="w-full max-w-[34rem] self-center" data-testid={testid}>
      <div className="grid grid-cols-13 gap-px rounded-lg border border-white/10 bg-white/10 p-px" role="group" aria-label={label} style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}>
        {MATRIX_RANKS.map((_, r) =>
          MATRIX_RANKS.map((__, c) => {
            const cls = cellClass(r, c);
            const on = range.has(cls);
            const sel = selected === cls;
            return (
              <button
                key={cls}
                type="button"
                disabled={!onCell}
                onClick={() => onCell?.(cls)}
                data-cell={cls}
                data-in={on ? '1' : '0'}
                aria-pressed={onCell ? on : undefined}
                aria-current={sel ? 'true' : undefined}
                aria-label={`${cls}, ${tr(on ? G.inRange : G.outRange)}`}
                className={cx(
                  'relative flex aspect-square min-w-0 items-center justify-center overflow-hidden font-mono text-[8px] leading-none sm:text-[11px]',
                  on ? 'bg-gold-500 font-bold text-ink-950' : r === c ? 'bg-ink-700 text-ink-200' : 'bg-ink-850 text-ink-400',
                  sel && 'z-10 outline outline-2 outline-offset-[-2px] outline-info',
                  onCell ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                {cls}
                {on && <span aria-hidden className="absolute right-px top-0 text-[7px] leading-none sm:text-[9px]">●</span>}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}

const SUIT_ROWS = [
  { s: 's', glyph: '♠', red: false },
  { s: 'h', glyph: '♥', red: true },
  { s: 'd', glyph: '♦', red: true },
  { s: 'c', glyph: '♣', red: false },
] as const;

/** Picks up to `max` cards from the 52 (a suit per row). The picked ones show above as real cards. */
export function CardPicker({ value, onChange, max, label, testid }: { value: Card[]; onChange: (cards: Card[]) => void; max: number; label: string; testid?: string }) {
  const tr = useTr();
  const { locale } = useI18n();
  const toggle = (c: Card) => {
    if (value.includes(c)) onChange(value.filter((x) => x !== c));
    else if (value.length < max) onChange([...value, c]);
    else onChange([...value.slice(1), c]); // full: the oldest pick makes way
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testid}>
      <div className="flex min-h-[3.4rem] flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-ink-300">
          {label} ({value.length}/{max})
        </span>
        {value.map((c) => (
          <PlayingCard key={c} card={c} size="2.3rem" />
        ))}
        {value.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="jc-tap ml-auto rounded-lg px-2 py-1 text-xs text-ink-300 hover:text-ivory">
            {tr(G.clear)}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-px" role="group" aria-label={label}>
        {SUIT_ROWS.map((row) => (
          <div key={row.s} className="grid gap-px" style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}>
            <span aria-hidden className={cx('grid place-items-center text-sm', row.red ? 'text-danger-soft' : 'text-ink-100')}>
              {row.glyph}
            </span>
            {MATRIX_RANKS.map((r) => {
              const c = `${r}${row.s}` as Card;
              const on = value.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(c)}
                  aria-pressed={on}
                  aria-label={cardName(c, locale)}
                  data-card={c}
                  className={cx('h-8 min-w-0 rounded font-mono text-[11px] font-bold transition', on ? 'bg-gold-400 text-ink-950 ring-2 ring-gold-300' : 'bg-ink-850 hover:bg-ink-700', !on && (row.red ? 'text-danger-soft' : 'text-ink-100'))}
                >
                  {r === 'T' ? '10' : r}
                  {on && <CheckIcon className="ml-0.5 inline size-3 align-[-1px] stroke-[3px]" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardsView({ cards, size = 'clamp(2.4rem,11vw,3.2rem)', label }: { cards: readonly Card[]; size?: string; label?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      {label && <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>}
      <div className="flex flex-wrap justify-center gap-1">
        {cards.map((c) => (
          <PlayingCard key={c} card={c} size={size} />
        ))}
      </div>
    </div>
  );
}

/**
 * Answer options. Before an answer they are plain buttons; after one they lock, the pick shows a tick or a cross and the right
 * option is marked "Answer" in words as well, whatever was picked.
 */
export function OptionList({ options, answer, picked, onPick, label }: { options: GtoOption[]; answer: string; picked: string | null; onPick: (id: string) => void; label: string }) {
  const tr = useTr();
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={label}>
      {options.map((o) => {
        const isPick = picked === o.id;
        const isAnswer = picked !== null && o.id === answer;
        return (
          <button
            key={o.id}
            type="button"
            disabled={picked !== null}
            data-choice={o.id}
            onClick={() => onPick(o.id)}
            className={cx(
              'jc-tap flex min-h-12 items-center gap-2 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition',
              picked === null && 'border-white/10 bg-ink-850 text-ivory hover:border-gold-500/50',
              isAnswer && 'border-success bg-success/15 text-success-soft',
              isPick && !isAnswer && 'jc-shake border-danger bg-danger/10 text-danger-soft',
              picked !== null && !isPick && !isAnswer && 'border-white/5 bg-ink-850/50 text-ink-400',
            )}
          >
            {(isPick || isAnswer) && <Mark ok={isAnswer} />}
            <span className="min-w-0 flex-1">{tr(o.label)}</span>
            {isAnswer && <span className="shrink-0 rounded-full bg-success/20 px-2 py-0.5 text-[11px] font-bold">{tr(G.answer)}</span>}
            {isPick && !isAnswer && <span className="shrink-0 rounded-full bg-danger/20 px-2 py-0.5 text-[11px] font-bold">{tr(G.yours)}</span>}
          </button>
        );
      })}
    </div>
  );
}
