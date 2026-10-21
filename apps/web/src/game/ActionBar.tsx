/**
 * Betting controls (Elite-Poker ActionButtons layout: fold / check-call /
 * raise panel with slider + presets / all-in). Only server-provided legal
 * options are shown; amounts are validated again by the server.
 *
 * Mis-tap protection, the same for mouse, touch and the F/C/R keys: presses in
 * the first moment after the bar appears are ignored, and risky actions (fold
 * while check is free, putting half the stack or more in, all-in) need a second
 * press of the same action at the same amount unless disabled in settings.
 * Held-down keys, modified keys, and keys typed into fields, the chat or a
 * modal are not shortcuts.
 *
 * Amounts may read in big blinds (settings). The amount held and sent is always whole chips: a typed big-blind amount
 * is rounded to the nearest chip at once, shown in chips beside the field, and checked by commitAction like any other.
 *
 * Sent, the pressed button keeps its colour with a spinner (and says so to a screen reader) until the server answers;
 * the bar then goes (the seat shows the action taken) or, refused, stays with the reason in the table's toast. A press
 * that could not be sent (no connection) says so over the bar. Neither changes the bar's height.
 *
 * `column`: a short screen's column at the table's side (short.ts), narrower than the bar's own row. The buttons share
 * one row of its width with their amounts under their names (pressed once, a risky one says to press again instead),
 * and the raise panel above them is sized to it, so opening it moves neither the buttons nor the table.
 */
import type { ActionType, LegalOption, TableView } from '@jc/types';
import { cx, formatChips, Spinner } from '@jc/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { amounts as chipAmounts, type Amounts } from '../lib/amount';
import { useI18n } from '../lib/i18n';
import { usePrefs } from '../lib/prefs';
import { armSig, commitAction, decideTap, isRisky, shortcutFor, type ArmKey, type Armed } from './actionSafety';

/** Ignore taps this long after the bar (re)appears: a finger may already be on the screen. */
const APPEAR_GUARD_MS = 350;
/** A first tap on a risky action stays armed this long. */
const ARM_MS = 2_500;

function haptic(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

const CHIPS = chipAmounts('chips', 0);

export function ActionBar({
  state,
  onAct,
  busy,
  amounts: a = CHIPS,
  column = false,
}: {
  state: TableView;
  /** Returns false when it could not be sent (no connection). */
  onAct: (type: ActionType, amount?: number) => unknown;
  busy: boolean;
  /** How amounts read (the player's unit at a real table; the Academy keeps chips). */
  amounts?: Amounts;
  /** Laid out for a short screen's column (see above). */
  column?: boolean;
}) {
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
  // What is being typed, kept as typed ("2." on the way to "2.5") while `amount` already holds its chips.
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState<Armed | null>(null);
  /** The press in flight: its button and what it says. */
  const [sent, setSent] = useState<{ key: ArmKey | 'check' | 'open'; text: string } | null>(null);
  const [unsent, setUnsent] = useState(false);
  const readyAt = useRef(Date.now() + APPEAR_GUARD_MS);
  const toggle = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const bb = Math.max(1, state.table.bigBlind);
  const mine = state.seats.find((x) => x.seatIndex === state.you.seatIndex);
  const myStack = mine?.stack ?? 0;
  const streetBet = mine?.streetBet ?? 0;
  const seq = state.hand?.seq;

  useEffect(() => {
    setAmount(window_?.min ?? 0);
    setDraft(null);
    setOpen(false);
    setArmed(null);
    setSent(null);
    setUnsent(false);
    readyAt.current = Date.now() + APPEAR_GUARD_MS;
  }, [state.hand?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Answered (a refusal keeps the turn): the buttons are back to normal.
  useEffect(() => {
    if (!busy) setSent(null);
  }, [busy]);
  useEffect(() => {
    if (!unsent) return;
    const h = setTimeout(() => setUnsent(false), 4_000);
    return () => clearTimeout(h);
  }, [unsent]);

  // The column scrolls when what it holds is taller than the screen (the raise panel under a side-pot line, a phone on its
  // side): the buttons acted on are kept whole at its end, what is above them scrolled up, instead of cut at the bottom.
  // Only then: a column that just fits (its padding aside) keeps its top line in view.
  useLayoutEffect(() => {
    const el = root.current;
    const box = el?.parentElement;
    if (column && el && box && el.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom + 0.5) el.scrollIntoView({ block: 'nearest' });
  }, [column, open]);

  // A changed amount cancels an armed commit, even if it is moved back to the armed amount.
  useEffect(() => setArmed((a) => (a?.key === 'commit' ? null : a)), [amount]);

  useEffect(() => {
    if (!armed) return;
    const h = setTimeout(() => setArmed(null), Math.max(0, armed.until - Date.now()));
    return () => clearTimeout(h);
  }, [armed]);

  /** Runs `run` unless the press came too early or while an action is in flight, or is risky and not yet armed for `sig`. */
  const tap = (key: ArmKey, risky: boolean, sig: string, run: () => void) => {
    const now = Date.now();
    const decision = decideTap({ key, sig, risky, confirmRisky: prefs.confirmRisky, armed, busy, now, readyAt: readyAt.current });
    if (decision === 'ignore') return;
    if (decision === 'arm') {
      setArmed({ key, sig, until: now + ARM_MS });
      haptic(8);
      return;
    }
    setArmed(null);
    haptic(15);
    run();
  };
  /** An amount from the slider, steps or presets replaces whatever was being typed. */
  const pick = (v: number) => {
    setDraft(null);
    setAmount(v);
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

  const send = (key: ArmKey | 'check' | 'open', text: string, type: ActionType, amount?: number) => {
    const ok = onAct(type, amount) !== false;
    setUnsent(!ok);
    setSent(ok ? { key, text } : null);
  };
  const bigCall = isRisky('call', legal, myStack);
  const commit = commitAction(legal, amount);
  const foldSig = armSig(seq, undefined);
  const callSig = armSig(seq, call?.amount);
  const allinSig = armSig(seq, allin?.amount);
  const commitSig = armSig(seq, amount);
  const commitText = (c: NonNullable<typeof commit>) => `${c.type === 'allin' ? t('action.allin') : bet ? t('action.bet') : t('action.raise')} ${a.fmt(c.amount, true)}`;
  const doFold = () => tap('fold', !!check, foldSig, () => send('fold', t('action.fold'), 'fold'));
  const doCheck = () => tap('call', false, callSig, () => send('check', t('action.check'), 'check'));
  const doCall = () => tap('call', bigCall, callSig, () => send('call', `${t('action.call')} ${a.fmt(call?.amount ?? 0, true)}`, 'call'));
  const doCommit = () => commit && tap('commit', isRisky('commit', legal, myStack, streetBet, commit.amount), commitSig, () => send('commit', commitText(commit), commit.type, commit.amount));
  const doAllin = () => tap('allin', true, allinSig, () => send('allin', `${t('action.allin')} ${a.fmt(allin?.amount ?? 0, true)}`, 'allin'));

  // Keyboard: F fold, C check/call, R raise panel, Escape closes it (back to its button). Same confirmation as a tap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = shortcutFor(e, !!document.querySelector('[aria-modal="true"]'));
      if (s === 'fold' && fold) doFold();
      else if (s === 'checkCall' && check) doCheck();
      else if (s === 'checkCall' && call) doCall();
      else if (s === 'raisePanel' && window_) setOpen((o) => !o);
      else if (s === 'closePanel' && open) {
        setOpen(false);
        toggle.current?.focus();
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (legal.length === 0) return null;
  const isAllInAmount = commit?.type === 'allin';
  const btn = column
    ? 'jc-tap jc-act flex h-12 min-w-0 flex-1 flex-col items-center justify-center rounded-xl px-1 text-center text-xs font-bold leading-tight tracking-wide text-white shadow-lg transition active:translate-y-px disabled:opacity-50'
    : 'jc-tap jc-act flex h-12 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-bold tracking-wide text-white shadow-lg transition active:translate-y-px disabled:opacity-50 sm:h-12 sm:min-w-[7.5rem] sm:flex-none';
  const commitBtn = column
    ? 'jc-tap jc-act flex h-10 w-full items-center justify-center gap-1.5 rounded-xl px-2 text-center text-sm font-bold leading-tight tracking-wide shadow-lg transition active:translate-y-px disabled:opacity-50'
    : 'jc-tap jc-act flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-center text-sm font-bold leading-tight tracking-wide shadow-lg transition active:translate-y-px disabled:opacity-50 sm:h-12';
  /** A button's amount, under its name in the column; there, pressed once, the press-again line stands alone. */
  const amountOf = (key: ArmKey, sig: string, v: number) => !(column && isArmed(key, sig)) && <span className={cx('font-mono', column && 'text-[11px] font-semibold')}>{a.fmt(v, true)}</span>;
  const armedCls = 'ring-2 ring-ivory ring-offset-2 ring-offset-ink-950 animate-pulse';
  // The pressed button stays lit while the others dim.
  const sentCls = (key: ArmKey | 'check' | 'open') => (busy && sent?.key === key ? 'disabled:opacity-100 ring-2 ring-ivory/70' : '');
  const pending = (key: ArmKey | 'check' | 'open') => busy && sent?.key === key && <Spinner className="size-4" />;
  const isArmed = (key: ArmKey, sig: string) => armed?.key === key && armed.sig === sig;
  const label = (key: ArmKey, sig: string, text: string) => (isArmed(key, sig) ? t('action.tapAgain', { type: text }) : text);
  const commitType = isAllInAmount ? t('action.allin') : bet ? t('action.bet') : t('action.raise');
  const stepBtn = cx(
    'jc-tap grid shrink-0 place-items-center rounded-lg border border-white/10 bg-ink-850 text-lg font-bold text-ivory active:bg-ink-700 disabled:opacity-40',
    column ? 'size-10' : 'size-11',
  );
  const amountLabel = bet ? t('action.betTo') : t('action.raiseTo');
  // A raise is to a total: what already sits in front of me is part of it.
  const fromStack = streetBet > 0 && (
    <span className={cx('font-mono tabular-nums', column && 'text-ink-400')} data-testid="action-from-stack">
      {t('action.fromStack', { amount: a.fmt(Math.max(0, amount - streetBet), true) })}
    </span>
  );
  const inChips = a.unit === 'bb' && (
    <span className={cx('font-mono tabular-nums', column && 'text-ink-400')} data-testid="action-chips">
      = {formatChips(amount)}
    </span>
  );
  const amountInput = (
    <input
      inputMode={a.unit === 'bb' ? 'decimal' : 'numeric'}
      className={cx('rounded-lg border border-white/10 bg-ink-850 px-2 text-right font-mono font-semibold text-gold-300', column ? 'h-10 w-24 min-w-0 shrink text-base' : 'h-11 w-full pt-3.5 text-lg sm:h-12')}
      value={draft ?? a.toInput(amount)}
      onChange={(e) => {
        const typed = a.clean(e.target.value);
        setDraft(typed);
        setAmount(a.fromInput(typed));
      }}
      onBlur={() => pick(clampAmt(amount))}
      aria-label={amountLabel}
      data-testid="action-amount"
    />
  );
  // In the bar's own row, what comes from the stack and the chips read on the confirm button's lower edge, as the
  // panel's text rather than the button's name (which stays the action and its amount). Pressed once, the press-again
  // line stands alone.
  const caption = !column && !isArmed('commit', commitSig) && (fromStack || inChips) && (
    <span className={cx('pointer-events-none absolute inset-x-1 bottom-1 flex justify-center gap-x-1.5 overflow-hidden whitespace-nowrap text-[11px] font-semibold leading-3.5 text-ink-950/75', (!commit || (busy && sent?.key !== 'commit')) && 'opacity-50')}>
      {fromStack}
      {inChips}
    </span>
  );
  const commitButton = (
    <button
      disabled={busy || !commit}
      onClick={doCommit}
      className={cx(commitBtn, caption && 'pb-3.5', isArmed('commit', commitSig) && armedCls, sentCls('commit'))}
      style={{ background: 'linear-gradient(180deg,var(--act-raise-from),var(--act-raise-to))', color: 'var(--act-raise-fg)' }}
      aria-busy={busy && sent?.key === 'commit'}
      data-testid="action-commit"
    >
      {pending('commit')}
      {label('commit', commitSig, t('action.confirm', { type: commitType, amount: a.exact(amount) }))}
    </button>
  );

  return (
    <div ref={root} className={cx('pointer-events-auto flex w-full flex-col', column ? 'gap-1' : 'gap-2 sm:w-auto')} data-testid="action-bar" data-raise-open={open ? '' : undefined}>
      {open && window_ && (
        // Open for a moment: the table makes way for it while it is open, then takes the room back (useStackRoom).
        // In the bar's own row three lines (steps and slider, presets, the amount beside the confirm button), so a phone
        // held upright keeps as much of its table as it can while the panel is open. In the column four, each 40px (what
        // a finger needs, no more) and close together: a phone on its side 360px high holds them, the turn line and the
        // bar without scrolling.
        <div className={cx('jc-panel flex flex-col', column ? 'gap-1 p-1.5' : 'gap-2 p-2 sm:w-[26rem] sm:gap-3 sm:p-3')} data-momentary data-raise-panel>
          {column && (
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 flex-col text-[10px] leading-tight">
                <span className="font-semibold uppercase tracking-wider text-ink-300">{amountLabel}</span>
                {fromStack}
                {inChips}
              </span>
              {amountInput}
            </div>
          )}
          <div className={cx('flex items-center', column ? 'gap-1.5' : 'gap-2')}>
            <button type="button" className={stepBtn} disabled={amount <= window_.min} onClick={() => pick(clampAmt(amount - bb))} aria-label={`- ${a.fmt(bb)}`}>
              −
            </button>
            <input
              type="range"
              className="jc-range min-w-0 flex-1"
              min={window_.min}
              max={window_.max}
              step={1}
              value={clampAmt(amount)}
              onChange={(e) => pick(snap(Number(e.target.value)))}
              aria-label={amountLabel}
              aria-valuetext={a.fmt(clampAmt(amount))}
            />
            <button type="button" className={stepBtn} disabled={amount >= window_.max} onClick={() => pick(clampAmt(amount + bb))} aria-label={`+ ${a.fmt(bb)}`}>
              +
            </button>
          </div>
          <div className={cx('grid grid-cols-4', column ? 'gap-1' : 'gap-1.5')}>
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => pick(p.value)}
                className={cx(
                  'jc-tap rounded-lg border font-semibold text-gold-300 hover:bg-gold-500/20',
                  column ? 'h-10 px-0.5 text-[11px] leading-tight' : 'h-10 text-xs',
                  amount === p.value ? 'border-gold-400 bg-gold-500/25' : 'border-gold-500/30 bg-gold-500/10',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {column ? (
            commitButton
          ) : (
            <div className="flex gap-2">
              <label className="relative w-32 shrink-0">
                <span className="pointer-events-none absolute left-2 top-1 text-[10px] font-semibold uppercase leading-3 tracking-wider text-ink-300">{amountLabel}</span>
                {amountInput}
              </label>
              <div className="relative flex min-w-0 flex-1">
                {commitButton}
                {caption}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Shown only on my turn: a gold edge says the buttons are live. */}
      <div className={cx('relative flex rounded-2xl border border-gold-400/60 bg-ink-950/85 shadow-[0_0_14px_rgba(230,197,107,0.22)] backdrop-blur-md', column ? 'gap-1.5 p-1.5' : 'gap-2 p-2')}>
        {/* Over the bar, so the bar (and the table above it) does not move. */}
        <p role="status" aria-live="polite" className="sr-only" data-testid="action-sending">
          {busy && sent ? t('action.sending', { action: sent.text }) : ''}
        </p>
        {unsent && (
          <p role="alert" className="pointer-events-none absolute inset-x-2 bottom-full mb-2 rounded-lg border border-danger/40 bg-ink-950/95 px-3 py-2 text-center text-xs text-[#f3b0b2]" data-testid="action-unsent">
            {t('action.notSent')}
          </p>
        )}
        {fold && (
          <button disabled={busy} onClick={doFold} className={cx(btn, isArmed('fold', foldSig) && armedCls, sentCls('fold'))} style={{ background: 'linear-gradient(180deg,var(--act-fold-from),var(--act-fold-to))', color: 'var(--act-fold-fg)' }} aria-keyshortcuts="F" aria-busy={busy && sent?.key === 'fold'}>
            {pending('fold')}
            {label('fold', foldSig, t('action.fold'))}
          </button>
        )}
        {check && (
          <button disabled={busy} onClick={doCheck} className={cx(btn, sentCls('check'))} style={{ background: 'linear-gradient(180deg,var(--act-check-from),var(--act-check-to))', color: 'var(--act-check-fg)' }} aria-keyshortcuts="C" aria-busy={busy && sent?.key === 'check'}>
            {pending('check')}
            {t('action.check')}
          </button>
        )}
        {call && (
          <button disabled={busy} onClick={doCall} className={cx(btn, isArmed('call', callSig) && armedCls, sentCls('call'))} style={{ background: 'linear-gradient(180deg,var(--act-call-from),var(--act-call-to))', color: 'var(--act-call-fg)' }} aria-keyshortcuts="C" aria-busy={busy && sent?.key === 'call'}>
            {pending('call')}
            {label('call', callSig, t('action.call'))} {amountOf('call', callSig, call.amount)}
          </button>
        )}
        {window_ && (
          <button ref={toggle} disabled={busy} onClick={() => setOpen((o) => !o)} className={btn} style={{ background: 'linear-gradient(180deg,var(--act-raise-from),var(--act-raise-to))', color: 'var(--act-raise-fg)' }} aria-expanded={open} aria-keyshortcuts="R">
            {bet ? t('action.bet') : t('action.raise')}
          </button>
        )}
        {allin && !window_ && (
          <button disabled={busy} onClick={doAllin} className={cx(btn, isArmed('allin', allinSig) && armedCls, sentCls('allin'))} style={{ background: 'linear-gradient(180deg,var(--act-allin-from),var(--act-allin-to))', color: 'var(--act-allin-fg)' }} aria-busy={busy && sent?.key === 'allin'}>
            {pending('allin')}
            {label('allin', allinSig, t('action.allin'))} {amountOf('allin', allinSig, allin.amount)}
          </button>
        )}
      </div>
    </div>
  );
}
