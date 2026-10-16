/**
 * Step-by-step replay of a finished hand on the live table's TableScene: previous/next action, play/pause and speed,
 * the pot growing street by street, then the winners and every pot's payout. Only the stored record is shown (see
 * replay.ts); nothing is fetched or derived from hidden cards. Amounts read in the player's unit, in big blinds of this
 * hand's table when chosen (hands recorded without blinds stay in chips).
 */
import { Button } from '@jc/ui';
import { useEffect, useMemo, useState } from 'react';
import { MemberName } from '../components/MemberName';
import { useAmounts, type Amounts } from '../lib/amount';
import { useI18n, type MsgKey } from '../lib/i18n';
import { buildReplay, type ReplayInput, type ReplayStep } from './replay';
import { TableScene, useBoxSize, useTableLayout } from './TableScene';

const STEP_MS = 1400;
const SPEEDS = [0.5, 1, 2] as const;

export function HandReplay({ hand, heroSeat }: { hand: ReplayInput; heroSeat: number | null }) {
  const { t } = useI18n();
  const a = useAmounts(hand.bigBlind ?? 0);
  const steps = useMemo(() => buildReplay(hand, heroSeat), [hand, heroSeat]);
  const last = steps.length - 1;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  const step = steps[Math.min(i, last)]!;
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const layout = useTableLayout(area, step.view.table.maxSeats, heroSeat ?? 0);

  useEffect(() => {
    if (!playing) return;
    if (i >= last) return setPlaying(false);
    const id = setTimeout(() => setI((x) => Math.min(x + 1, last)), STEP_MS / speed);
    return () => clearTimeout(id);
  }, [playing, i, last, speed]);

  const go = (to: number) => {
    setPlaying(false);
    setI(Math.max(0, Math.min(last, to)));
  };
  const toggle = () => {
    if (playing) return setPlaying(false);
    if (i >= last) setI(0);
    setPlaying(true);
  };
  const name = (seat: number) => hand.players.find((p) => p.seatIndex === seat)?.nickname ?? `#${seat + 1}`;
  const actionText = (type: string) => (['post-sb', 'post-bb', 'timeout-fold', 'timeout-check'].includes(type) ? t(`replay.${type}` as MsgKey) : t(`action.${type}` as MsgKey));
  const describe = (s: ReplayStep) => {
    const acts = s.actions.map((x) => `${name(x.seatIndex)} ${actionText(x.type)}${x.amount > 0 ? ` ${a.fmt(x.amount)}` : ''}`).join(' · ');
    if (s.kind === 'deal') return acts ? `${t('replay.step.deal')} · ${acts}` : t('replay.step.deal');
    if (s.kind === 'street') return t('replay.step.street', { street: t(`stage.${s.stage}` as MsgKey) });
    if (s.kind === 'showdown') return t('replay.step.showdown');
    if (s.kind === 'result') return t('replay.step.result');
    return acts;
  };

  return (
    <div className="flex flex-col gap-3" data-testid="hand-replay">
      <div className="jc-game-surface relative overflow-hidden rounded-2xl" style={{ background: 'var(--t-bg)' }}>
        {/* Room above and below the felt for the top and bottom seats' plates and cards. */}
        <div ref={areaRef} className="flex h-[min(60vh,32rem)] items-center justify-center px-2 pb-8 pt-10">
          <TableScene s={step.view} layout={layout} mySeat={heroSeat} canSit={false} onSit={() => {}} nextIn={null} cues={[]} consumeCues={() => {}} reducedMotion={reducedMotion} amounts={a} />
        </div>
      </div>
      {/* On phones the controls stay in reach just above the bottom navigation while the replay is on screen. */}
      <div
        className="sticky bottom-[calc(3rem+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 rounded-xl border border-gold-500/30 bg-ink-850 p-3 shadow-[0_-8px_24px_rgba(0,0,0,0.5)] sm:static sm:shadow-none"
        data-testid="replay-controls"
      >
        <div className="flex items-baseline justify-between gap-2 text-xs text-ink-300">
          <span>
            <span className="font-mono tabular-nums" data-testid="replay-index">{i + 1}/{steps.length}</span> · {t(`stage.${step.stage}` as MsgKey)}
          </span>
          <span className="font-mono text-gold-300 tabular-nums" data-testid="replay-pot">
            {t('table.pot')} {a.fmt(step.view.hand!.potTotal)}
          </span>
        </div>
        <p className="min-h-5 text-sm font-semibold text-ivory" aria-live="polite" data-testid="replay-step">
          {describe(step)}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1" role="group" aria-label={t('replay.player')}>
            <Button variant="ghost" size="md" onClick={() => go(0)} disabled={i === 0} aria-label={t('replay.first')} title={t('replay.first')} data-testid="replay-first">⏮</Button>
            <Button variant="outline" size="md" onClick={() => go(i - 1)} disabled={i === 0} aria-label={t('replay.prev')} title={t('replay.prev')} data-testid="replay-prev">◀</Button>
            <Button
              variant="gold"
              size="md"
              className="min-w-24"
              onClick={toggle}
              aria-pressed={playing}
              data-testid="replay-play"
            >
              {playing ? `❚❚ ${t('replay.pause')}` : `▶ ${t('replay.play')}`}
            </Button>
            <Button variant="outline" size="md" onClick={() => go(i + 1)} disabled={i >= last} aria-label={t('replay.next')} title={t('replay.next')} data-testid="replay-next">▶</Button>
            <Button variant="ghost" size="md" onClick={() => go(last)} disabled={i >= last} aria-label={t('replay.last')} title={t('replay.last')} data-testid="replay-last">⏭</Button>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label={t('replay.speed')}>
            <span className="mr-1 text-xs text-ink-400">{t('replay.speed')}</span>
            {SPEEDS.map((x) => (
              <Button key={x} variant={speed === x ? 'subtle' : 'ghost'} size="sm" onClick={() => setSpeed(x)} aria-pressed={speed === x} data-testid={`replay-speed-${x}`}>
                {x}×
              </Button>
            ))}
          </div>
        </div>
      </div>
      {step.kind === 'result' && <Settlement hand={hand} name={name} amounts={a} />}
    </div>
  );
}

/** Each pot of the hand and who won it, or each player's total for hands recorded before pots were stored. */
function Settlement({ hand, name, amounts: a }: { hand: ReplayInput; name: (seat: number) => string; amounts: Amounts }) {
  const { t } = useI18n();
  let side = 0;
  return (
    <section className="rounded-xl border border-white/10 bg-black/25 p-3" data-testid="replay-pots">
      <h4 className="mb-2 text-sm font-bold text-gold-300">{t('replay.settlement')}</h4>
      {hand.pots ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {hand.pots.map((pot, k) => {
            const label = pot.uncalled ? t('replay.returned') : k === 0 ? t('replay.mainPot') : t('table.sidePot', { n: (side += 1) });
            return (
              <li key={k} className="rounded-lg bg-white/[0.03] px-2.5 py-1.5" data-testid="replay-pot-row">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-ink-100">{label}</span>
                  <span className="font-mono text-gold-300 tabular-nums">{a.fmt(pot.amount)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  {!pot.uncalled && <span className="text-ink-400">{t('replay.contenders', { names: pot.eligibleSeats.map(name).join(', ') })}</span>}
                  <span className="text-[#9fd8b6]">
                    {pot.winners.map((w) => `${name(w.seatIndex)} ${pot.uncalled ? '' : '+'}${a.fmt(w.amount)}`).join(' · ')}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <>
          <ul className="flex flex-col gap-1 text-sm">
            {hand.players
              .filter((p) => p.won > 0)
              .map((p) => (
                <li key={p.seatIndex} className="flex justify-between gap-2">
                  <MemberName name={p.nickname} role={p.role} />
                  <span className="font-mono text-[#9fd8b6] tabular-nums">+{a.fmt(p.won)}</span>
                </li>
              ))}
          </ul>
          <p className="mt-2 text-xs text-ink-400">{t('replay.legacy')}</p>
        </>
      )}
    </section>
  );
}
