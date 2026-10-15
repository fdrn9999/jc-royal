/**
 * Pre-action toggles while another player is to act: Check/Fold and Check when nothing is to call, Fold against a bet.
 * The room keeps the choice and carries it out on this player's turn only while it still fits (a bet cancels a Check,
 * with a notice); pressing the chosen one again clears it. The pressed state shown is the room's `you.preAction`; a
 * press shows at once until the next state arrives.
 */
import type { PreActionKind, TableView } from '@jc/types';
import { cx } from '@jc/ui';
import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { preActionSpot } from './preAction';

export function PreActions({ s, onPick }: { s: TableView; onPick: (kind: PreActionKind | null) => void }) {
  const { t } = useI18n();
  const [pressed, setPressed] = useState<{ version: number; kind: PreActionKind | null } | null>(null);
  const spot = preActionSpot(s);
  if (!spot) return null;
  const kept = pressed?.version === s.version ? pressed.kind : (s.you.preAction ?? null);
  const pick = (k: PreActionKind) => {
    const next = kept === k ? null : k;
    setPressed({ version: s.version, kind: next });
    onPick(next);
  };
  return (
    <div role="group" aria-label={t('pre.title')} className="pointer-events-auto flex items-center gap-1.5 rounded-2xl border border-white/5 bg-ink-950/80 p-1.5 backdrop-blur sm:self-end" data-testid="pre-actions">
      <span className="px-1.5 text-[11px] font-semibold text-ink-300">{t('pre.title')}</span>
      {spot.choices.map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={kept === k}
          onClick={() => pick(k)}
          className={cx(
            'jc-tap h-10 min-w-[5.5rem] rounded-xl border px-3 text-sm font-semibold transition',
            kept === k ? 'border-gold-400 bg-gold-500/25 text-gold-300' : 'border-white/10 bg-ink-850 text-ivory hover:bg-ink-800',
          )}
          data-testid={`pre-${k}`}
        >
          {kept === k && <span aria-hidden>✓ </span>}
          {t(`pre.${k}`)}
        </button>
      ))}
    </div>
  );
}
