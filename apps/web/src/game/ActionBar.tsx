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
 * Sizing a bet and making it are two buttons. The card's top line says the amount set, with a button of its own at its
 * right (`action-dock-toggle`, R, its tip saying it sets the amount) that opens and closes the sizing (slider, steps,
 * presets, the amount field) and does nothing else: it sends nothing, arms nothing and keeps the amount, even one the
 * server would refuse. Bet/Raise in the buttons' row always bets the amount set, written on it in full, open or closed,
 * with the same confirmation as any other press; an amount the server would refuse leaves it disabled, saying an amount
 * is wanted. The row is the same open or closed (fold, check or call, bet or raise, all-in when it is the only raise),
 * so its buttons neither move nor change meaning: the dock's own control at its top right, the game's actions below.
 *
 * The bar sits in the table's dock, a band of fixed height under the table (Table.tsx): opening the sizing grows the
 * card inside that band and moves nothing else. Open, the slider (the amount at its end) takes the top line, beside the
 * same toggle, and the presets the next.
 *
 * `column`: a short screen's column at the table's side (short.ts), narrower than the bar's own row. The buttons share
 * one row of its width with their amounts under their names (pressed once, a risky one says to press again instead,
 * Bet/Raise still with its amount under it), and
 * the sizing above them is sized to it: the amount field beside the toggle, then the slider, then the presets.
 */
import type { ActionType, LegalOption, TableView } from '@jc/types';
import { ChevronDownIcon, ChevronUpIcon, cx, formatChips, MinusIcon, PlusIcon, Spinner } from '@jc/ui';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { amounts as chipAmounts, type Amounts } from '../lib/amount';
import { useI18n } from '../lib/i18n';
import { usePrefs } from '../lib/prefs';
import { armSig, commitAction, decideTap, isRisky, shortcutFor, type ArmKey, type Armed } from './actionSafety';
import { captionFace, lineFace, wrapPoints } from './amountFit';

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

/** Narrower than Tailwind's `sm`: a phone held upright, where the bar's own row stacks the time bank over the bar. */
const PHONE_QUERY = 'not all and (min-width: 40rem)';
function subscribePhone(onChange: () => void) {
  const m = window.matchMedia?.(PHONE_QUERY);
  m?.addEventListener?.('change', onChange);
  return () => m?.removeEventListener?.('change', onChange);
}
const readPhone = () => window.matchMedia?.(PHONE_QUERY).matches === true;

export function ActionBar({
  state,
  onAct,
  busy,
  amounts: a = CHIPS,
  column = false,
  bank,
}: {
  state: TableView;
  /** Returns false when it could not be sent (no connection). */
  onAct: (type: ActionType, amount?: number) => unknown;
  busy: boolean;
  /** How amounts read (the player's unit at a real table; the Academy keeps chips). */
  amounts?: Amounts;
  /** Laid out for a short screen's column (see above). */
  column?: boolean;
  /**
   * The bar's own row's time bank (TimeBank.tsx), drawn before the bar: its pill, or (`inCard`) a cell of the presets'
   * line, which it is on a phone while the raise panel is open. The dock's band there holds the card alone, and the
   * table above it keeps the room nine seats need on a 375×667 phone (Table.tsx's dockBand).
   */
  bank?: (inCard: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const prefs = usePrefs();
  const phone = useSyncExternalStore(subscribePhone, readPhone, () => false);
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
  /** The sizing's own button: Escape gives it the focus back. */
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const tipId = useId();
  /**
   * The toggle's tip, put away once it is pressed, so it does not cover the amount field beside it while the pointer
   * rests there; back when the pointer leaves the toggle or the focus comes to it again.
   */
  const [tipOff, setTipOff] = useState(false);
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

  // The dock scrolls when what it holds is taller than its band (the raise panel under a side-pot line, a phone on its
  // side, a beginner's notes): the buttons acted on are kept whole at its end, what is above them scrolled up, instead of
  // cut at the bottom. Only then: a dock that just fits (its padding aside) keeps its top line in view.
  useLayoutEffect(() => {
    const el = root.current;
    let box = el?.parentElement;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (el && box && el.getBoundingClientRect().bottom > box.getBoundingClientRect().bottom + 0.5) el.scrollIntoView({ block: 'nearest' });
  }, [open]);

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
  const commitText = (c: NonNullable<typeof commit>) => `${c.type === 'allin' ? t('action.allin') : bet ? t('action.bet') : t('action.raiseBtn')} ${a.fmt(c.amount, true)}`;
  const doFold = () => tap('fold', !!check, foldSig, () => send('fold', t('action.fold'), 'fold'));
  const doCheck = () => tap('call', false, callSig, () => send('check', t('action.check'), 'check'));
  const doCall = () => tap('call', bigCall, callSig, () => send('call', `${t('action.call')} ${a.fmt(call?.amount ?? 0, true)}`, 'call'));
  const doCommit = () => commit && tap('commit', isRisky('commit', legal, myStack, streetBet, commit.amount), commitSig, () => send('commit', commitText(commit), commit.type, commit.amount));
  const doAllin = () => tap('allin', true, allinSig, () => send('allin', `${t('action.allin')} ${a.fmt(allin?.amount ?? 0, true)}`, 'allin'));

  // Keyboard: F fold, C check/call, R opens or closes the sizing (never bets), Escape closes it (back to its button).
  // Same confirmation as a tap.
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
  const panel = open && !!window_;
  /** The sizing open in the bar's own row: in the card, over its buttons. */
  const inCard = panel && !column;
  /**
   * The buttons laid out narrow, their amounts under their names: in the column, and on a phone, where Bet/Raise takes
   * the room of two. The same open or closed, so the row never moves.
   */
  const compact = column || phone;
  /** A phone's time bank, its pill over the bar, is a cell of the presets' line while the sizing is open (see `bank`). */
  const bankInCard = inCard && phone && !!bank;
  // 48px high, the row's buttons together: taller only for an amount too long for Bet/Raise even at its smallest face
  // (see `amountFit`), which then wraps inside it rather than past it.
  const btnBase = compact
    ? 'jc-tap jc-act flex min-h-12 min-w-0 flex-col items-center justify-center rounded-xl px-1 text-center text-xs font-bold leading-tight tracking-wide text-white shadow-lg transition active:translate-y-px disabled:opacity-50'
    : 'jc-tap jc-act flex min-h-12 min-w-0 items-center justify-center gap-1.5 rounded-xl text-sm font-bold tracking-wide text-white shadow-lg transition active:translate-y-px disabled:opacity-50';
  const btn = cx(btnBase, 'flex-1', !compact && 'px-2');
  // Bet/Raise: its name and the amount, beside each other while they fit (else the amount under the name), so a long
  // amount wraps instead of widening the row; three lines (a long press-again line over the amount) fit its 48px. Its
  // own width is what its amount's face is sized against (see `fit`).
  const commitBtn = cx(btnBase, '@container w-full', !compact && 'flex-wrap content-center gap-x-1.5 gap-y-0 px-2 leading-[1.1]');
  /** A button's amount, under its name when narrow; there, pressed once, the press-again line stands alone. */
  const amountOf = (key: ArmKey, sig: string, v: number) => !(compact && isArmed(key, sig)) && <span className={cx('font-mono', compact && 'text-[11px] font-semibold')}>{a.fmt(v, true)}</span>;
  const armedCls = 'ring-2 ring-ivory ring-offset-2 ring-offset-ink-950 animate-pulse';
  // The pressed button stays lit while the others dim.
  const sentCls = (key: ArmKey | 'check' | 'open') => (busy && sent?.key === key ? 'disabled:opacity-100 ring-2 ring-ivory/70' : '');
  const pending = (key: ArmKey | 'check' | 'open') => busy && sent?.key === key && <Spinner className="size-4" />;
  const isArmed = (key: ArmKey, sig: string) => armed?.key === key && armed.sig === sig;
  const label = (key: ArmKey, sig: string, text: string) => (isArmed(key, sig) ? t('action.tapAgain', { type: text }) : text);
  /**
   * What Bet/Raise does: its name and the amount set, never shortened or rounded (12,500, not 12.5K; in big blinds the
   * chips follow, 5 BB (12,501)), so what it bets reads on it. Pressed once in the column, too narrow for the whole
   * press-again line and the amount, a short word stands for the name.
   *
   * A line of the amount too long for the button's width takes a smaller face, never one under 9px; still too long
   * there, it wraps where it may (`amountFit`), inside the button. In the column, about 60px across, the blinds and the
   * chips take a line each.
   */
  const commitName = isAllInAmount ? t('action.allin') : bet ? t('action.bet') : t('action.raiseBtn');
  const commitLines = column && a.unit === 'bb' ? [a.fmt(amount), `(${formatChips(amount)})`] : [a.exact(amount)];
  const fit = (line: string) => ({ fontSize: lineFace(line, compact ? 11 : 14) });
  const commitAmountCls = cx('text-center font-mono leading-[1.1] tabular-nums', compact && 'text-[11px] font-semibold');
  const stepBtn = 'jc-tap grid size-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-ink-850 text-lg font-bold text-ivory active:bg-ink-700 disabled:opacity-40';
  const amountLabel = bet ? t('action.betTo') : t('action.raiseTo');
  // A raise is to a total: what already sits in front of me is part of it.
  const fromStackText = streetBet > 0 ? t('action.fromStack', { amount: a.fmt(Math.max(0, amount - streetBet), true) }) : '';
  const fromStack = fromStackText && (
    <span className={cx('font-mono tabular-nums', column && 'text-ink-400')} data-testid="action-from-stack">
      {fromStackText}
    </span>
  );
  const inChipsText = a.unit === 'bb' ? `= ${formatChips(amount)}` : '';
  const inChips = inChipsText && (
    <span className={cx('font-mono tabular-nums', column && 'text-ink-400')} data-testid="action-chips">
      {inChipsText}
    </span>
  );
  /** The amount typed, its name inside the field's top edge; an amount the server would refuse is edged in red. */
  const amountField = (cls: string) => (
    <label className={cx('relative min-w-0', cls)}>
      <span className="pointer-events-none absolute left-2 top-1 text-[10px] font-semibold uppercase leading-3 tracking-wider text-ink-300">{amountLabel}</span>
      <input
        inputMode={a.unit === 'bb' ? 'decimal' : 'numeric'}
        className={cx('h-10 w-full min-w-0 rounded-lg border bg-ink-850 px-2 pt-3.5 text-right font-mono text-base font-semibold text-gold-300', commit ? 'border-white/10' : 'border-danger/70')}
        value={draft ?? a.toInput(amount)}
        // Kept as typed when the field loses the focus (shutting the sizing does that): an amount the server would refuse
        // stays, Bet/Raise disabled and saying so, until the player sets one, never moved to the nearest legal amount.
        onChange={(e) => {
          const typed = a.clean(e.target.value);
          setDraft(typed);
          setAmount(a.fromInput(typed));
        }}
        aria-label={amountLabel}
        aria-invalid={!commit || undefined}
        data-testid="action-amount"
      />
    </label>
  );
  // In the bar's own row, what comes from the stack reads on Bet/Raise's lower edge, as the sizing's text rather than the
  // button's name (which stays the action and its amount, the chips with it in big blinds, so not again here). An amount
  // the server would refuse, Bet/Raise saying one is wanted, has no amount on it: in big blinds, its chips read there
  // instead (open or closed), so what was typed still reads in chips. Pressed once, the press-again line stands alone.
  // One line, its face smaller where it is longer than the button is wide (a phone's, in big blinds), never under 9px.
  const captionText = commit ? fromStackText : amount > 0 ? inChipsText : '';
  const caption = !column && !isArmed('commit', commitSig) && captionText && (
    <span
      className={cx('pointer-events-none absolute inset-x-0.5 bottom-1 flex justify-center overflow-hidden whitespace-nowrap font-semibold leading-3.5 text-ink-950/75', (!commit || (busy && sent?.key !== 'commit')) && 'opacity-50')}
      style={{ fontSize: captionFace(captionText) }}
    >
      {commit ? fromStack : inChips}
    </span>
  );
  const commitArmed = isArmed('commit', commitSig);
  // The same button open or closed: it bets the amount set (the sizing only sets it), so it is never a way to open it.
  const commitButton = window_ && (
    <div className={cx('@container relative flex min-w-0', column ? 'flex-[1.4]' : 'flex-[2]')}>
      <button
        type="button"
        disabled={busy || !commit}
        onClick={doCommit}
        className={cx(commitBtn, caption && 'pb-3.5', commitArmed && armedCls, sentCls('commit'))}
        style={{ background: 'linear-gradient(180deg,var(--act-raise-from),var(--act-raise-to))', color: 'var(--act-raise-fg)' }}
        aria-busy={busy && sent?.key === 'commit'}
        data-testid="action-commit"
      >
        {/* Narrow, the spinner beside the name, not a line of its own over it. */}
        {!compact && pending('commit')}
        {/* The amount on it pressed once too: the second press bets what it says. */}
        <span className={cx(compact && 'flex items-center justify-center gap-1')}>
          {compact && pending('commit')}
          {commitArmed ? (column ? t('action.again') : t('action.tapAgain', { type: commitName })) : commitName}
        </span>{' '}
        {commit ? (
          commitLines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              <span className={commitAmountCls} style={fit(line)}>
                {wrapPoints(line).map((part, j) => (
                  <Fragment key={j}>
                    {j > 0 && <wbr />}
                    {part}
                  </Fragment>
                ))}
              </span>
            </Fragment>
          ))
        ) : (
          <span className="text-[11px] font-semibold">{t('action.needAmount')}</span>
        )}
      </button>
      {caption}
    </div>
  );
  const sizingName = open ? t('action.sizingClose') : t('action.sizingOpen');
  // Opens and closes the sizing, nothing else: no amount, no confirmation, nothing sent. Not held while a press is in
  // flight either, since it sends nothing. Its tip (hovered, or focused from the keyboard) says it sets the amount, and
  // its key: at its left on the same line, inside the card, so the dock's scroll does not cut it and it covers no button.
  // Only while the sizing is shut: open, that line is the amount field and the slider, which it must not cover. Escape
  // on the toggle puts it away.
  const toggleButton = (
    <span className="relative flex shrink-0">
      <button
        ref={toggle}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setTipOff(true);
        }}
        onPointerLeave={() => setTipOff(false)}
        onFocus={() => setTipOff(false)}
        onKeyDown={(e) => e.key === 'Escape' && setTipOff(true)}
        className="jc-tap peer grid size-10 shrink-0 place-items-center rounded-lg border border-gold-500/40 bg-ink-900/80 text-gold-300 transition-colors hover:border-gold-400 hover:bg-gold-500/15 aria-expanded:border-gold-400 aria-expanded:bg-gold-500/20"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={sizingName}
        aria-describedby={tipId}
        aria-keyshortcuts="R"
        data-testid="action-dock-toggle"
      >
        {open ? <ChevronDownIcon className="size-5" /> : <ChevronUpIcon className="size-5" />}
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={cx(
          'pointer-events-none absolute right-full top-1/2 z-10 mr-2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg border border-gold-500/50 bg-ink-950/95 px-2 py-1 text-xs font-semibold text-gold-300 opacity-0 shadow-lg transition-opacity',
          !open && !tipOff && 'peer-hover:opacity-100 peer-hover:delay-300 peer-focus-visible:opacity-100',
        )}
        data-testid="action-dock-tip"
      >
        {t('action.sizingTip')}
        <kbd className="rounded border border-gold-500/40 px-1 font-mono text-[10px] leading-4 text-ink-200">R</kbd>
      </span>
    </span>
  );
  // Closed, the top line says what Bet/Raise will bet (or that an amount is wanted: in the column, with no line under
  // Bet/Raise, the chips of the amount refused beside its name, as the caption has them in the bar's row).
  const summary = (
    <p className={cx('flex min-w-0 flex-1 px-1', column ? 'flex-col justify-center' : 'items-baseline gap-2')}>
      <span className="shrink-0 text-[10px] font-semibold uppercase leading-3 tracking-wider text-ink-300">
        {amountLabel}
        {column && !commit && amount > 0 && inChips && <> {inChips}</>}
      </span>
      <span className={cx('truncate font-mono font-semibold tabular-nums', column ? 'text-sm' : 'text-base', commit ? 'text-gold-300' : 'text-[#f3b0b2]')} data-testid="action-dock-amount">
        {commit ? a.exact(amount) : t('action.needAmount')}
      </span>
    </p>
  );

  const steps = window_ && (
    <>
      <button type="button" className={stepBtn} disabled={amount <= window_.min} onClick={() => pick(clampAmt(amount - bb))} aria-label={`- ${a.fmt(bb)}`}>
        <MinusIcon className="size-5" />
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
        <PlusIcon className="size-5" />
      </button>
    </>
  );
  const presetRow = (
    <div className={cx('grid auto-cols-fr grid-flow-col', column ? 'gap-1' : 'gap-1.5')}>
      {presets.map((p) => (
        <button
          key={p.label}
          type="button"
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
      {bankInCard && bank?.(true)}
    </div>
  );
  const bar = (
    <div ref={root} className={cx('pointer-events-auto flex w-full flex-col', !column && 'sm:w-[26rem]')} data-testid="action-bar" data-raise-open={open ? '' : undefined}>
      {/* Shown only on my turn: a gold edge says the buttons are live. */}
      <div className={cx('relative flex flex-col rounded-2xl border border-gold-400/60 bg-ink-950/85 shadow-[0_0_14px_rgba(230,197,107,0.22)] backdrop-blur-md', column ? 'gap-1 p-1.5' : 'gap-1.5 p-2')}>
        {/* Over the card's top line, so the bar (and the table above it) does not move, and kept in the dock, which
            scrolls and would cut what stands above it. */}
        <p role="status" aria-live="polite" className="sr-only" data-testid="action-sending">
          {busy && sent ? t('action.sending', { action: sent.text }) : ''}
        </p>
        {unsent && (
          <p role="alert" className={cx('pointer-events-none absolute inset-x-2 z-10 rounded-lg border border-danger/40 bg-ink-950/95 px-3 py-2 text-center text-xs text-[#f3b0b2]', window_ ? 'top-2' : 'bottom-full mb-2')} data-testid="action-unsent">
            {t('action.notSent')}
          </p>
        )}
        {window_ && (
          // The sizing, its toggle at the right of the card's top line. Open, it grows the card upward inside the dock's
          // band (lines of 40px, what a finger needs, close together: a phone 375px wide holds them in the band, and a
          // phone on its side 360px high holds them, the turn line and the bar without scrolling), so neither the table
          // nor the buttons' row moves. In the bar's own row the slider (the amount at its end) takes the top line and
          // the presets the next; in the column the amount takes the top line, then the slider and the presets.
          <div id={panelId} className={cx('flex flex-col', column ? 'gap-1' : 'gap-1.5')} data-raise-panel={panel ? '' : undefined} data-momentary={panel ? '' : undefined}>
            {/* The toggle the second child either way, so it stays the same element and keeps the focus. */}
            <div className="flex items-center gap-1.5 sm:gap-2">
              {panel ? (
                column ? (
                  amountField('flex-1')
                ) : (
                  <>
                    {steps}
                    {amountField('w-[4.5rem] shrink-0 sm:w-28')}
                  </>
                )
              ) : (
                summary
              )}
              {toggleButton}
            </div>
            {panel && column && (fromStack || inChips) && <p className="-mt-0.5 flex justify-end gap-x-1.5 px-1 text-[10px] leading-3">{fromStack}{inChips}</p>}
            {panel && column && <div className="flex items-center gap-1.5">{steps}</div>}
            {panel && presetRow}
          </div>
        )}
        {/* One row either way, the same buttons in the same places doing the same things open or closed. */}
        <div className={cx('flex', column ? 'gap-1.5' : 'gap-2')}>
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
          {commitButton}
          {allin && !window_ && (
            <button disabled={busy} onClick={doAllin} className={cx(btn, isArmed('allin', allinSig) && armedCls, sentCls('allin'))} style={{ background: 'linear-gradient(180deg,var(--act-allin-from),var(--act-allin-to))', color: 'var(--act-allin-fg)' }} aria-busy={busy && sent?.key === 'allin'}>
              {pending('allin')}
              {label('allin', allinSig, t('action.allin'))} {amountOf('allin', allinSig, allin.amount)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
  // One tree either way, so the bar stays the same element when the time bank moves into its card and keeps the focus.
  return (
    <>
      {bank && !bankInCard && bank(false)}
      {bar}
    </>
  );
}
