import { handLabelKey, type Card, type HandReviewDto } from '@jc/types';
import { Button, formatChips, formatDate, PlayingCard } from '@jc/ui';
import { useState } from 'react';
import { HandReplay } from '../game/HandReplay';
import { useI18n, type MsgKey } from '../lib/i18n';
import { MemberName } from './MemberName';

const STAGES = ['preflop', 'flop', 'turn', 'river'] as const;
/** Board cards revealed on each street. */
const STREET_CARDS: Record<string, [number, number]> = { preflop: [0, 0], flop: [0, 3], turn: [3, 4], river: [4, 5] };

/** Read-only review card for a finished hand (board, players, actions by street), with a step-by-step replay. */
export function HandReview({ hand }: { hand: HandReviewDto }) {
  const { t, locale } = useI18n();
  const [replaying, setReplaying] = useState(false);
  const name = (seat: number) => hand.players.find((p) => p.seatIndex === seat)?.nickname ?? `#${seat + 1}`;
  const act = (type: string) => (['post-sb', 'post-bb', 'timeout-fold', 'timeout-check'].includes(type) ? t(`replay.${type}` as MsgKey) : t(`action.${type}` as MsgKey));
  return (
    <section className="rounded-xl border border-gold-500/20 bg-black/30 p-4" data-testid="hand-review">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-gold-300">
          {t('board.handReview')} · {hand.tableName} #{hand.handNumber}
        </h3>
        <span className="text-xs text-ink-400">
          {hand.smallBlind !== null && `${formatChips(hand.smallBlind)}/${formatChips(hand.bigBlind ?? 0)} · `}
          {t('table.pot')} {formatChips(hand.potTotal)} · {formatDate(hand.endedAt, locale)}
        </span>
      </header>
      <Button variant={replaying ? 'ghost' : 'outline'} size="sm" className="mb-3" onClick={() => setReplaying(!replaying)} aria-expanded={replaying} data-testid="replay-toggle">
        {replaying ? t('replay.close') : `▶ ${t('replay.open')}`}
      </Button>
      {replaying && (
        <div className="mb-3">
          <HandReplay hand={hand} heroSeat={hand.players.find((p) => p.isAuthor)?.seatIndex ?? null} />
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-1">
        {hand.board.length ? hand.board.map((c) => <PlayingCard key={c} card={c as Card} size="2.2rem" />) : <span className="text-xs text-ink-400">—</span>}
      </div>
      <ul className="mb-3 grid gap-1.5 sm:grid-cols-2">
        {hand.players.map((p) => (
          <li key={p.seatIndex} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${p.isAuthor ? 'bg-gold-500/10' : 'bg-white/[0.03]'}`}>
            <span className="flex gap-0.5">{(p.holeCards ?? [null, null]).map((c, i) => <PlayingCard key={i} card={(c as Card) ?? null} size="1.5rem" />)}</span>
            <span className="flex min-w-0 flex-1">
              <MemberName name={p.nickname} role={p.role} className={p.isAuthor ? 'font-semibold text-gold-300' : undefined} />
            </span>
            {p.rankClass && <span className="text-[11px] text-ink-300">{t(`hand.${handLabelKey(p.rankClass, [])}` as MsgKey)}</span>}
            <span className={`font-mono text-xs tabular-nums ${p.net >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}`}>{p.net > 0 ? '+' : ''}{formatChips(p.net)}</span>
          </li>
        ))}
      </ul>
      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((st) => {
          const rows = hand.actions.filter((a) => a.stage === st);
          if (rows.length === 0) return null;
          return (
            <div key={st} className="rounded-lg bg-white/[0.03] p-2">
              <div className="mb-1 flex items-center justify-between font-semibold text-ink-200">
                {t(`stage.${st}` as MsgKey)}
                <span className="flex gap-0.5">{hand.board.slice(...STREET_CARDS[st]!).map((c) => <span key={c} className="font-mono text-[10px] text-ink-300">{c}</span>)}</span>
              </div>
              <ol className="flex flex-col gap-0.5">
                {rows.map((a, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate text-ink-300">{name(a.seatIndex)}</span>
                    <span className="shrink-0 text-ivory">{act(a.type)}{a.amount > 0 ? ` ${formatChips(a.amount)}` : ''}</span>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </section>
  );
}
