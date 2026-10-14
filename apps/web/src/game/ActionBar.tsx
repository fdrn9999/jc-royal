/**
 * Betting controls (Elite-Poker ActionButtons layout: fold / check-call /
 * raise panel with slider + presets / all-in). Only server-provided legal
 * options are shown; amounts are validated again by the server.
 */
import type { ActionType, LegalOption, TableView } from '@jc/types';
import { cx, formatChips } from '@jc/ui';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';

export function ActionBar({ state, onAct, busy }: { state: TableView; onAct: (type: ActionType, amount?: number) => void; busy: boolean }) {
  const { t } = useI18n();
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

  useEffect(() => {
    setAmount(window_?.min ?? 0);
    setOpen(false);
  }, [state.hand?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (k === 'f' && fold) onAct('fold');
      else if (k === 'c' && (check || call)) onAct(check ? 'check' : 'call');
      else if (k === 'r' && window_) setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, fold, check, call, window_, onAct]);

  if (legal.length === 0) return null;
  const isAllInAmount = allin && amount === allin.amount;
  const btn = 'flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-bold tracking-wide text-white shadow-lg transition active:translate-y-px disabled:opacity-50 sm:h-12 sm:min-w-[7.5rem] sm:flex-none';

  return (
    <div className="pointer-events-auto flex w-full flex-col gap-2 sm:w-auto" data-testid="action-bar">
      {open && window_ && (
        <div className="jc-panel flex flex-col gap-3 p-3 sm:w-[26rem]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-300">{bet ? t('action.betTo') : t('action.raiseTo')}</span>
            <input
              inputMode="numeric"
              className="h-9 w-32 rounded-lg border border-white/10 bg-ink-850 px-2 text-right font-mono text-lg font-semibold text-gold-300"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)}
              onBlur={() => setAmount((v) => Math.min(window_.max, Math.max(window_.min, v)))}
              aria-label={bet ? t('action.betTo') : t('action.raiseTo')}
            />
          </div>
          <input
            type="range"
            min={window_.min}
            max={window_.max}
            step={1}
            value={Math.min(window_.max, Math.max(window_.min, amount))}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label="amount"
          />
          <div className="grid grid-cols-4 gap-1.5">
            {presets.map((p) => (
              <button key={p.label} onClick={() => setAmount(p.value)} className="rounded-lg border border-gold-500/30 bg-gold-500/10 py-1.5 text-xs font-semibold text-gold-300 hover:bg-gold-500/20">
                {p.label}
              </button>
            ))}
          </div>
          <button
            disabled={busy || amount < window_.min || amount > window_.max}
            onClick={() => onAct(isAllInAmount ? 'allin' : bet ? 'bet' : 'raise', amount)}
            className={cx(btn, 'w-full sm:w-full')}
            style={{ background: 'linear-gradient(180deg,#e6c56b,#b48e22)', color: '#0a0b0d' }}
          >
            {t('action.confirm', { type: isAllInAmount ? t('action.allin') : bet ? t('action.bet') : t('action.raise'), amount: formatChips(amount) })}
          </button>
        </div>
      )}
      <div className="flex gap-2 rounded-2xl border border-gold-500/15 bg-ink-950/85 p-2 backdrop-blur-md">
        {fold && (
          <button disabled={busy} onClick={() => onAct('fold')} className={btn} style={{ background: 'linear-gradient(180deg,#c4474a,#962a2d)' }}>
            {t('action.fold')}
          </button>
        )}
        {check && (
          <button disabled={busy} onClick={() => onAct('check')} className={btn} style={{ background: 'linear-gradient(180deg,#3d4452,#2a2f39)' }}>
            {t('action.check')}
          </button>
        )}
        {call && (
          <button disabled={busy} onClick={() => onAct('call')} className={btn} style={{ background: 'linear-gradient(180deg,#2f8f59,#1f6b41)' }}>
            {t('action.call')} <span className="font-mono">{formatChips(call.amount, true)}</span>
          </button>
        )}
        {window_ && (
          <button disabled={busy} onClick={() => setOpen((o) => !o)} className={btn} style={{ background: 'linear-gradient(180deg,#e6c56b,#b48e22)', color: '#0a0b0d' }} aria-expanded={open}>
            {bet ? t('action.bet') : t('action.raise')}
          </button>
        )}
        {allin && !window_ && (
          <button disabled={busy} onClick={() => onAct('allin')} className={btn} style={{ background: 'linear-gradient(180deg,#e08227,#a8570f)' }}>
            {t('action.allin')} <span className="font-mono">{formatChips(allin.amount, true)}</span>
          </button>
        )}
      </div>
    </div>
  );
}
