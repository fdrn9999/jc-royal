/**
 * The tag that says which kind of analysis a figure is (game/strategy.ts AnalysisKind), shared by the replay's review
 * and the practice results so each says it the same way.
 */
import { cx } from '@jc/ui';
import type { AnalysisKind } from './strategy';

const KINDS: Record<AnalysisKind, { ko: string; en: string; tone: string }> = {
  math: { ko: '수학 계산', en: 'Math', tone: 'border-white/25 text-ink-100' },
  heuristic: { ko: '휴리스틱', en: 'Heuristic', tone: 'border-gold-400/50 text-gold-300' },
  solver: { ko: '솔버 분석', en: 'Solver', tone: 'border-info/60 text-info' },
  unavailable: { ko: '분석 불가', en: 'Unavailable', tone: 'border-white/15 text-ink-400' },
};

/** Which kind of analysis a part is, said in words beside it (never by colour alone). */
export function KindTag({ kind, tr }: { kind: AnalysisKind; tr: (ko: string, en: string) => string }) {
  const k = KINDS[kind];
  return (
    <span className={cx('inline-block rounded-full border px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap', k.tone)} data-analysis={kind}>
      {tr(k.ko, k.en)}
    </span>
  );
}
