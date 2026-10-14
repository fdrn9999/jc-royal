/**
 * Betting controls (Elite-Poker ActionButtons layout: fold / check-call /
 * raise panel with slider + presets / all-in). Only server-provided legal
 * options are shown; amounts are validated again by the server.
 *
 * Mobile mis-tap protection: taps in the first moment after the bar appears
 * are ignored, and risky actions (fold while check is free, calls of half the
 * stack or more, all-in) need a second tap unless disabled in settings.
 */
import type { ActionType, LegalOption, TableView } from '@jc/types';
import { cx, formatChips } from '@jc/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { usePrefs } from '../lib/prefs';

/** Ignore taps this long after the bar (re)appears: a finger may already be on the screen. */
const APPEAR_GUARD_MS = 350;
/** A first tap on a risky action stays armed this long. */
const ARM_MS = 2_500;

type ArmKey = 'fold' | 'call' | 'allin' | 'commit';

function haptic(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

export function ActionBar({ state, onAct, busy }: { state: TableView; onAct: (type: ActionType, amount?: number) => void; busy: boolean }) {
  const { t } = useI18n();
  const prefs = usePrefs();
  const legal = state.you.legal;
  const find = <K extends LegalOption['type']>(k: K) => legal.find((o) => o.type === k) as Extract<LegalOption, { type: K }> | undefined;
  const fold = find('fold');
  const check = find('check');
  const call = find('call');
  const bet = find('bet');
  const raise = find('raise');
  const allin = find('allin');
  const window_ = bet ?? raise;
  const [amount, setAmount] = useState(window_?.min ?? 0);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<ArmKey | null>(null);
  const readyAt = useRef(Date.now() + APPEAR_GUARD_MS);
  const bb = Math.max(1, state.table.bigBlind);
  const myStack = state.seats.find((x) => x.seatIndex === state.you.seatIndex)?.stack ?? 0;

  useEffect(() => {
    setAmount(window_?.min ?? 0);
    setOpen(false);
    setArmed(null);
    readyAt.current = Date.now() + APPEAR_GUARD_MS;
  }, [state.hand?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!armed) return;
    const h = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(h);
  }, [armed]);

  /** Runs `run` unless the tap came too early, or the action is risky and not yet armed. */
  const tap = (key: ArmKey, risky: boolean, run: () => void) => {
    if (busy || Date.now() < readyAt.current) return;
    if (risky && prefs.confirmRisky && armed !== key) {
      setArmed(key);
      haptic(8);
      return;
    }
    setArmed(null);
    haptic(15);
    run();
  };
  const clampAmt = (v: number) => (window_ ? Math.min(window_.max, Math.max(window_.min, v)) : v);
  /** Slider values snap to big-blind steps; min and max stay reachable. */
  const snap = (v: number) => (!window_ || v >= window_.max ? (window_?.max ?? v) : clampAmt(window_.min + Math.round((v - window_.min) / bb) * bb));

  const presets = useMemo(() => {
    if (!window_ || !state.hand) return [];
    const highest = Math.max(0, ...state.seats.map((s) => s.streetBet));
    const potAfterCall = state.hand.potTotal + (call?.amount ?? 0);
    const clamp = (v: number) => Math.min(window_.max, Math.max(window_.min, Math.round(v)));
    return [
      { label: t('action.min'), value: window_.min },
      { label: t('action.half'), value: clamp(highest + potAfterCall * 0.5) },
      { label: t('action.pot'), value: clamp(highest + potAfterCall) },
      { label: t('action.max'), value: window_.max },
    ];
  }, [window_, state.hand, state.seats, call, t]);

  // Keyboard: F fold, C check/call, R raise panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'f' && fold) tap('fold', !!check, () => onAct('fold'));
      else if (k === 'c' && (check || call)) onAct(check ? 'check' : 'call');
      else if (k === 'r' && window_) setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (legal.length === 0) return null;
  const isAllInAmount = !!allin && amount === allin.amount;
  const bigCall = !!call && call.amount * 2 >= myStack;
  const btn =
    'jc-tap flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-bold tracking-wide text-white shadow-lg transition active:translate-y-px disabled:opacity-50 sm:h-12 sm:min-w-[7.5rem] sm:flex-none';
  const armedCls = 'ring-2 ring-ivory ring-offset-2 ring-offset-ink-950 animate-pulse';
  const label = (key: ArmKey, text: string) => (armed === key ? t('action.tapAgain', { type: text }) : text);
  const commitType = isAllInAmount ? t('action.allin') : bet ? t('action.bet') : t('action.raise');
  const stepBtn = 'jc-tap grid size-11 shrink-0 place-items-center rounded-lg border border-white/10 bg-ink-850 text-lg font-bold text-ivory active:bg-ink-700 disabled:opacity-40';

  return (
    <div className="pointer-events-auto flex w-full flex-col gap-2 sm:w-auto" data-testid="action-bar">
      {open && window_ && (
        <div className="jc-panel flex flex-col gap-3 p-3 sm:w-[26rem]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-300">{bet ? t('action.betTo') : t('action.raiseTo')}</span>
            <input
              inputMode="numeric"
              className="h-10 w-32 rounded-lg border border-white/10 bg-ink-850 px-2 text-right font-mono text-lg font-semibold text-gold-300"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)}
              onBlur={() => setAmount((v) => clampAmt(v))}
              aria-label={bet ? t('action.betTo') : t('action.raiseTo')}
            />
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={stepBtn} disabled={amount <= window_.min} onClick={() => setAmount((v) => clampAmt(v - bb))} aria-label={`- ${formatChips(bb)}`}>
              −
            </button>
            <input
              type="range"
              className="jc-range min-w-0 flex-1"
              min={window_.min}
              max={window_.max}
              step={1}
              value={clampAmt(amount)}
              onChange={(e) => setAmount(snap(Number(e.target.value)))}
              aria-label="amount"
            />
            <button type="button" className={stepBtn} disabled={amount >= window_.max} onClick={() => setAmount((v) => clampAmt(v + bb))} aria-label={`+ ${formatChips(bb)}`}>
              +
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => setAmount(p.value)}
                className={cx('jc-tap h-10 rounded-lg border text-xs font-semibold text-gold-300 hover:bg-gold-500/20', amount === p.value ? 'border-gold-400 bg-gold-500/25' : 'border-gold-500/30 bg-gold-500/10')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            disabled={busy || amount < window_.min || amount > window_.max}
            onClick={() => tap('commit', isAllInAmount, () => onAct(isAllInAmount ? 'allin' : bet ? 'bet' : 'raise', amount))}
            className={cx(btn, 'w-full flex-none! sm:w-full', armed === 'commit' && armedCls)}
            style={{ background: 'linear-gradient(180deg,#e6c56b,#b48e22)', color: '#0a0b0d' }}
          >
            {label('commit', t('action.confirm', { type: commitType, amount: formatChips(amount) }))}
          </button>
        </div>
      )}
      <div className="flex gap-2 rounded-2xl border border-gold-500/15 bg-ink-950/85 p-2 backdrop-blur-md">
        {fold && (
          <button disabled={busy} onClick={() => tap('fold', !!check, () => onAct('fold'))} className={cx(btn, armed === 'fold' && armedCls)} style={{ background: 'linear-gradient(180deg,#c4474a,#962a2d)' }}>
            {label('fold', t('action.fold'))}
          </button>
        )}
        {check && (
          <button disabled={busy} onClick={() => tap('call', false, () => onAct('check'))} className={btn} style={{ background: 'linear-gradient(180deg,#3d4452,#2a2f39)' }}>
            {t('action.check')}
          </button>
        )}
        {call && (
          <button disabled={busy} onClick={() => tap('call', bigCall, () => onAct('call'))} className={cx(btn, armed === 'call' && armedCls)} style={{ background: 'linear-gradient(180deg,#2f8f59,#1f6b41)' }}>
            {label('call', t('action.call'))} <span className="font-mono">{formatChips(call.amount, true)}</span>
          </button>
        )}
        {window_ && (
          <button disabled={busy} onClick={() => setOpen((o) => !o)} className={btn} style={{ background: 'linear-gradient(180deg,#e6c56b,#b48e22)', color: '#0a0b0d' }} aria-expanded={open}>
            {bet ? t('action.bet') : t('action.raise')}
          </button>
        )}
        {allin && !window_ && (
          <button disabled={busy} onClick={() => tap('allin', true, () => onAct('allin'))} className={cx(btn, armed === 'allin' && armedCls)} style={{ background: 'linear-gradient(180deg,#e08227,#a8570f)' }}>
            {label('allin', t('action.allin'))} <span className="font-mono">{formatChips(allin.amount, true)}</span>
          </button>
        )}
      </div>
    </div>
  );
}
