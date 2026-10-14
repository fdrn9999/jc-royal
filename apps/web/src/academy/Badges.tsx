/** Cosmetic Academy badges (from the server; awarded from progress, never chips). */
import { BADGES, type BadgeId } from '@jc/types';
import { cx } from '@jc/ui';
import { l, useTr, type L } from './content';
import { useBadges } from './sync';

export const BADGE_INFO: Record<BadgeId, { icon: string; name: L; how: L }> = {
  'first-step': { icon: '♠', name: l('첫걸음', 'First step'), how: l('레슨 하나 완료', 'Finish any lesson') },
  'card-reader': { icon: 'A', name: l('카드 읽기', 'Card reader'), how: l('레슨 1 완료', 'Finish lesson 1') },
  'hand-expert': { icon: '♥', name: l('족보 박사', 'Hand expert'), how: l('레슨 2 완료', 'Finish lesson 2') },
  'rule-keeper': { icon: '♦', name: l('규칙 수호자', 'Rule keeper'), how: l('레슨 3·4 완료', 'Finish lessons 3 and 4') },
  'practice-graduate': { icon: '♣', name: l('연습 수료', 'Practice graduate'), how: l('연습 시나리오 8개 완료', 'Finish all 8 scenarios') },
  'academy-graduate': { icon: '🏆', name: l('아카데미 수료', 'Academy graduate'), how: l('모든 레슨 완료', 'Finish every lesson') },
  'sharp-eye': { icon: '◎', name: l('예리한 눈', 'Sharp eye'), how: l('복습·랜덤 퀴즈 3회 완료', 'Finish 3 review quizzes') },
};

export function BadgeShelf({ showLocked = true }: { showLocked?: boolean }) {
  const tr = useTr();
  const earned = new Map(useBadges().map((b) => [b.badge, b.awardedAt]));
  const list = showLocked ? BADGES : BADGES.filter((b) => earned.has(b));
  if (list.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="badges">
      {list.map((b) => {
        const on = earned.has(b);
        const info = BADGE_INFO[b];
        return (
          <li key={b} className={cx('flex items-center gap-2 rounded-xl border p-2', on ? 'border-gold-400/60 bg-gold-500/10' : 'border-white/5 bg-ink-850/50 opacity-55')} data-badge={b} data-earned={on ? '1' : '0'}>
            <span className={cx('grid size-9 shrink-0 place-items-center rounded-full text-lg', on ? 'bg-gold-500 text-ink-950' : 'bg-ink-700 text-ink-400')} aria-hidden>
              {info.icon}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-bold text-ivory">{tr(info.name)}</span>
              <span className="block truncate text-[10px] text-ink-400">{tr(info.how)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
