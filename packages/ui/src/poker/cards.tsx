/**
 * Playing cards and chips.
 * Layout/tiers adapted from Elite-Poker `Card.jsx` / `ChipStack.jsx` (MIT, © 2026 OpaDips),
 * redrawn for JC ROYAL (logo card back, engine card notation "As").
 */
import type { Card } from '@jc/types';
import type { CSSProperties } from 'react';
import logo128 from '../../assets/logo-128.webp';
import { cx, formatChips } from '../util';

const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' } as const;
const RANK_LABEL: Record<string, string> = { T: '10' };

export function cardLabel(card: Card): string {
  return `${RANK_LABEL[card[0]!] ?? card[0]}${SUIT_GLYPH[card[1] as keyof typeof SUIT_GLYPH]}`;
}

/**
 * A card: both its sides back to back on a turntable (`.jc-card-turn`) inside the box that places it (`.jc-card`, which
 * keeps the fan, the lift and the deal's flight), so a card turned over shows its back until it stands edge on and its
 * face after, with no frame of neither. `animate`: 'flip' turns it face up where it lies; 'deal' flies it in as it is;
 * 'deal-flip' flies it in face down and turns it face up as it lands. `style.animationDelay` delays the whole
 * animation: the flight for the deals, the turn for a flip.
 */
export function PlayingCard({
  card,
  size,
  className,
  highlight,
  dim,
  animate,
  style,
}: {
  card?: Card | null;
  /** CSS length for the card width, e.g. "3rem" or "clamp(2rem,6vw,3.5rem)". */
  size?: string;
  className?: string;
  highlight?: boolean;
  dim?: boolean;
  animate?: 'flip' | 'deal' | 'deal-flip' | false;
  style?: CSSProperties;
}) {
  const { animationDelay, ...rest } = style ?? {};
  const turns = !!card && (animate === 'flip' || animate === 'deal-flip');
  const flies = animate === 'deal' || animate === 'deal-flip';
  const st = { ...(size ? ({ '--card-size': size } as CSSProperties) : {}), ...rest, ...(flies && animationDelay != null ? { animationDelay } : {}) };
  // The turn of a card dealt face down starts as its flight ends (--deal-turn-at, styles.css).
  const turnAt = animate === 'deal-flip' ? `calc(${animationDelay ?? '0ms'} + var(--deal-turn-at))` : animationDelay;
  const anim = cx(flies && 'jc-deal-in', turns && 'jc-flip-in');
  const back = (under: boolean) => (
    <div className={cx('jc-card-back', under && 'jc-card-under')}>
      <img src={logo128} alt="" draggable={false} />
    </div>
  );
  if (!card) {
    return (
      <div className={cx('jc-card', flies && 'jc-deal-in', className)} style={st} aria-label="face-down card">
        <div className="jc-card-turn">{back(false)}</div>
      </div>
    );
  }
  const suit = card[1] as keyof typeof SUIT_GLYPH;
  const red = suit === 'h' || suit === 'd';
  const rank = RANK_LABEL[card[0]!] ?? card[0];
  return (
    <div className={cx('jc-card', anim, highlight && 'highlight', dim && 'dim', className)} style={st} aria-label={cardLabel(card)} data-card={card}>
      <div className="jc-card-turn" style={turns && turnAt != null ? { animationDelay: turnAt } : undefined}>
        <div className={cx('jc-card-face', red ? 'suit-red' : 'suit-black')}>
          <div className="absolute left-[8%] top-[6%] flex flex-col items-center">
            <span className="rank">{rank}</span>
            <span style={{ fontSize: 'calc(var(--card-w) * 0.3)', lineHeight: 1 }}>{SUIT_GLYPH[suit]}</span>
          </div>
          <div className="absolute inset-0 flex items-end justify-end p-[9%]">
            <span style={{ fontSize: 'calc(var(--card-w) * 0.62)', lineHeight: 0.9, opacity: 0.92 }}>{SUIT_GLYPH[suit]}</span>
          </div>
        </div>
        {/* Its back, only while it turns over (hidden facing away once it lies face up). */}
        {turns && back(true)}
      </div>
    </div>
  );
}

/**
 * Casino denomination tiers (Elite-Poker), tuned to the JC ROYAL palette. The colours are the --chip-tN tokens in
 * styles.css, which the colour vision modes swap where neighbouring tiers would read as one.
 */
const TIERS = [100_000, 25_000, 5_000, 1_000, 500, 100, 25, 5, 0].map((min, i, all) => {
  const n = all.length - 1 - i;
  return { min, base: `var(--chip-t${n}-base)`, face: `var(--chip-t${n}-face)` };
});

export function chipTier(amount: number) {
  return TIERS.find((t) => amount >= t.min) ?? TIERS[TIERS.length - 1]!;
}

export function Chip({ amount, size = '1.5rem', style }: { amount: number; size?: string; style?: CSSProperties }) {
  const t = chipTier(amount);
  return <span className="jc-chip" style={{ '--chip-base': t.base, '--chip-face': t.face, '--chip-size': size, ...style } as CSSProperties} />;
}

/** A small pile whose height grows with the amount, plus the amount label (`text` replaces the chip count, e.g. in big blinds). */
export function ChipStack({ amount, size = '1.35rem', label = true, text, className }: { amount: number; size?: string; label?: boolean; text?: string; className?: string }) {
  if (amount <= 0) return null;
  const count = Math.min(5, 1 + Math.floor(Math.log10(Math.max(1, amount))));
  const t = chipTier(amount);
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)}>
      <span className="jc-chip-pile" style={{ '--chip-size': size, height: `calc(${size} + ${count * 3}px)` } as CSSProperties}>
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className="jc-chip" style={{ bottom: i * 3, '--chip-base': t.base, '--chip-face': t.face, '--chip-size': size } as CSSProperties} />
        ))}
      </span>
      {label && <span className="rounded-full bg-black/55 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gold-300 tabular-nums">{text ?? formatChips(amount, true)}</span>}
    </span>
  );
}
