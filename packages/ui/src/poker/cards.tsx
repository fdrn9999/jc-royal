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
  animate?: 'flip' | 'deal' | false;
  style?: CSSProperties;
}) {
  const st = { ...(size ? ({ '--card-size': size } as CSSProperties) : {}), ...style };
  const anim = animate === 'flip' ? 'jc-flip-in' : animate === 'deal' ? 'jc-deal-in' : '';
  if (!card) {
    return (
      <div className={cx('jc-card', anim, className)} style={st} aria-label="face-down card">
        <div className="jc-card-back">
          <img src={logo128} alt="" draggable={false} />
        </div>
      </div>
    );
  }
  const suit = card[1] as keyof typeof SUIT_GLYPH;
  const red = suit === 'h' || suit === 'd';
  const rank = RANK_LABEL[card[0]!] ?? card[0];
  return (
    <div className={cx('jc-card', anim, highlight && 'highlight', dim && 'dim', className)} style={st} aria-label={cardLabel(card)} data-card={card}>
      <div className={cx('jc-card-face', red ? 'suit-red' : 'suit-black')}>
        <div className="absolute left-[8%] top-[6%] flex flex-col items-center">
          <span className="rank">{rank}</span>
          <span style={{ fontSize: 'calc(var(--card-w) * 0.3)', lineHeight: 1 }}>{SUIT_GLYPH[suit]}</span>
        </div>
        <div className="absolute inset-0 flex items-end justify-end p-[9%]">
          <span style={{ fontSize: 'calc(var(--card-w) * 0.62)', lineHeight: 0.9, opacity: 0.92 }}>{SUIT_GLYPH[suit]}</span>
        </div>
      </div>
    </div>
  );
}

/** Casino denomination tiers (Elite-Poker), tuned to the JC ROYAL palette. */
const TIERS = [
  { min: 100_000, base: '#1d1d22', face: '#3a3a44' },
  { min: 25_000, base: '#1f4f6b', face: '#2c6f93' },
  { min: 5_000, base: '#5b2f78', face: '#7b45a0' },
  { min: 1_000, base: '#9c7414', face: '#c9a227' },
  { min: 500, base: '#6e2050', face: '#8d2f69' },
  { min: 100, base: '#202026', face: '#383842' },
  { min: 25, base: '#155a37', face: '#1f7a4b' },
  { min: 5, base: '#8f2622', face: '#b23a35' },
  { min: 0, base: '#2f5c8f', face: '#4176b0' },
];

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
