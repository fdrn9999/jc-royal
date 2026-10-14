/** Hand-ranking chart. Engine-free: also used at the multiplayer table. */
import { PlayingCard } from '@jc/ui';
import { useI18n } from '../lib/i18n';
import { l, useTr } from './content';
import { HAND_RANKS, type HandRankInfo } from './data/hands';

export function HandRankRow({ h, index, reveal, compact }: { h: HandRankInfo; index: number; reveal?: boolean; compact?: boolean }) {
  const { locale } = useI18n();
  const tr = useTr();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-ink-850/60 p-2" data-testid={`rank-${h.key}`}>
      <span className="w-6 shrink-0 text-center font-mono text-sm font-bold text-gold-400">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-ivory">
          {locale === 'ko' ? h.ko : h.en}
          {locale === 'ko' && <span className="ml-1.5 text-[11px] font-normal text-ink-400">{h.en}</span>}
        </div>
        {!compact && <div className="text-xs text-ink-300">{tr(h.rule)}</div>}
      </div>
      <div className="flex shrink-0 gap-0.5">
        {h.cards.map((c, i) => (
          <PlayingCard key={c} card={c} size={compact ? '1.55rem' : 'clamp(1.6rem,6vw,2.1rem)'} dim={!h.main.includes(i) && !(h.second ?? []).includes(i)} animate={reveal ? 'flip' : false} style={reveal ? { animationDelay: `${index * 60 + i * 40}ms` } : undefined} />
        ))}
      </div>
    </div>
  );
}

export function HandRankingChart({ compact }: { compact?: boolean }) {
  const tr = useTr();
  return (
    <div className="flex flex-col gap-1.5" data-testid="hand-chart">
      {HAND_RANKS.map((h, i) => (
        <HandRankRow key={h.key} h={h} index={i} compact={compact} />
      ))}
      <p className="mt-1 text-[11px] text-ink-400">{tr(l('위가 더 강합니다. 7장(홀카드 2 + 보드 5) 중 가장 좋은 5장으로 비교하며, 문양에는 우열이 없습니다.', 'Higher rows win. Each player uses the best five of seven cards; suits never break ties.'))}</p>
    </div>
  );
}
