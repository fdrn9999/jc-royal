import { sound, type AudioSettings } from '@jc/audio';
import { SETTINGS_COLOR_VISIONS, type AutoBuyPolicy, type AutoBuyRequest, type ChatMessage, type TableView } from '@jc/types';
import { Button, cx, Field, formatChips, Modal, MusicIcon, SendHorizontalIcon, THEMES } from '@jc/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EmojiPicker } from '../components/EmojiPicker';
import { InstallSettingsLazy } from '../components/InstallLazy';
import { RefillHintLazy } from '../components/RefillHintLazy';
import { MemberName, RoleBadge } from '../components/MemberName';
import { PresenceModePicker } from '../components/Presence';
import { useAmounts, type Amounts } from '../lib/amount';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { AMOUNT_UNITS, pullSettings, setPrefs, usePrefs, useSettingsSync } from '../lib/prefs';
import { AUTO_TIMES, autoBuyEstimate, draftFrom, draftRequest, editDraft, seatPolicy, type AutoBuyDraft } from './autoBuy';
import { RequestError, rid, type TableSocketApi } from './useTableSocket';

/**
 * Whether chips ran short at any point while a dialog was open: the free refill note then stays until it closes, so
 * a refill taken from it still shows what it paid once the dialog offers the buy-in or top-up it made possible.
 */
function useShortWhileOpen(open: boolean, short: boolean) {
  const [was, setWas] = useState(false);
  useEffect(() => {
    setWas((w) => (open ? w || short : false));
  }, [open, short]);
  return open && (was || short);
}

export function BuyInModal({
  open,
  onClose,
  state,
  seatIndex,
  wallet,
  onConfirm,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  state: TableView;
  seatIndex: number | null;
  wallet: number;
  /** `autoBuy`: the automatic chip policy chosen with the buy-in (absent when off). */
  onConfirm: (amount: number, autoBuy?: AutoBuyRequest) => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const { minBuyIn, maxBuyIn, bigBlind } = state.table;
  // The wallet reads in chips; what goes to the table reads in the player's unit, with the exact chips where it is paid.
  const a = useAmounts(bigBlind);
  const cap = Math.min(maxBuyIn, wallet);
  const [amount, setAmount] = useState(() => Math.min(cap, Math.max(minBuyIn, bigBlind * 100)));
  useEffect(() => {
    if (open) setAmount(Math.min(cap, Math.max(minBuyIn, bigBlind * 100)));
  }, [open, cap, minBuyIn, bigBlind]);
  const affordable = cap >= minBuyIn;
  const refill = useShortWhileOpen(open, !affordable);
  // Off unless the player picks one. A room older than automatic top-ups would drop the choice: none is offered there.
  const offerAuto = state.you.autoBuy !== undefined && state.table.roomType !== 'tournament';
  const [draft, setDraft] = useState(() => draftFrom(null, 'off', amount));
  // Until the player sets the policy's amounts, they are the buy-in's: a rebuy of it, a top-up back to it.
  const touched = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    touched.current = false;
    setDraft(draftFrom(null, 'off', amount));
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (touched.current) return;
    setDraft((d) => (d.mode === 'off' || (d.amount === amount && d.target === amount) ? d : editDraft(d, { amount, target: amount, trigger: amount })));
  }, [amount]);
  const autoReq = offerAuto && draft.mode !== 'off' ? draftRequest(draft) : null;
  const ready = affordable && (!offerAuto || draft.mode === 'off' || autoReq !== null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('table.buyInTitle', { seat: (seatIndex ?? 0) + 1 })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!ready} loading={busy} onClick={() => onConfirm(amount, autoReq ?? undefined)} data-testid="buyin-confirm">
            {t('table.buyIn')} {a.exact(amount)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex justify-between text-sm">
          <span className="text-ink-300">{t('table.wallet')}</span>
          <span className="font-mono font-semibold text-gold-300">{formatChips(wallet)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-ink-300">{t('lobby.buyin')}</span>
          <span className="font-mono">
            {a.fmt(minBuyIn)} – {a.fmt(maxBuyIn)}
          </span>
        </div>
        {affordable ? (
          <>
            <div className="flex items-center gap-3">
              <input type="range" min={minBuyIn} max={cap} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label={t('table.buyIn')} className="min-w-0 flex-1" />
              <AmountInput a={a} value={amount} min={minBuyIn} max={cap} onChange={setAmount} label={t('table.buyIn')} testId="buyin-input" />
            </div>
            <div className="text-center font-mono text-3xl font-semibold text-gold-300 tabular-nums" data-testid="buyin-amount">
              {a.fmt(amount)}
              {a.unit === 'bb' && <span className="block text-xs font-normal text-ink-400">{formatChips(amount)}</span>}
            </div>
          </>
        ) : (
          <p className="text-sm text-danger">{t('err.insufficient_balance')}</p>
        )}
        {affordable && offerAuto && (
          <section className="flex flex-col gap-2 border-t border-white/5 pt-3" data-testid="buyin-autobuy">
            <div>
              <h4 className="text-sm font-bold text-ivory">{t('autobuy.title')}</h4>
              <p className="mt-1 text-xs text-ink-400">{t('autobuy.desc')}</p>
            </div>
            <AutoBuyFields
              draft={draft}
              edit={(p) => {
                if (p.consent === undefined) touched.current = true;
                setDraft((d) => editDraft(d, p));
              }}
              // A new choice starts from the buy-in being made.
              onMode={(mode) => setDraft(draftFrom(null, mode, amount))}
              modes={['off', 'rebuy', 'topup']}
              table={state.table}
            />
          </section>
        )}
        {refill && <RefillHintLazy />}
        {error &&<p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** Typed text that holds a number (0 included), not an empty field or a lone point. */
const hasDigit = (s: string) => /\d/.test(s);

/**
 * An amount typed beside a slider, in the player's unit (a big-blind amount becomes whole chips). What it hands on is
 * always within [min, max], so the button that pays shows what it will send; the field keeps what was typed (outlined
 * when outside them) until it is left. `onTyping` says when typing starts and stops.
 */
function AmountInput({
  a,
  value,
  min,
  max,
  onChange,
  onTyping,
  label,
  testId,
}: {
  a: Amounts;
  value: number;
  min: number;
  max: number;
  onChange: (chips: number) => void;
  onTyping?: (on: boolean) => void;
  label: string;
  testId: string;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState<string | null>(null);
  const n = typed === null ? value : a.fromInput(typed);
  const outside = typed !== null && hasDigit(typed) && (n < min || n > max);
  return (
    <span className={cx('flex h-10 w-28 shrink-0 items-center gap-1 rounded-lg border bg-ink-850 px-2 focus-within:border-gold-400', outside ? 'border-danger' : 'border-white/10')}>
      {/* 16px text, or iOS zooms the page in when the field takes focus. */}
      <input
        inputMode={a.unit === 'bb' ? 'decimal' : 'numeric'}
        enterKeyHint="done"
        autoComplete="off"
        className="w-full min-w-0 bg-transparent text-right font-mono text-base font-semibold text-gold-300 tabular-nums outline-none"
        value={typed ?? a.toInput(value)}
        onFocus={(e) => {
          e.currentTarget.select();
          onTyping?.(true);
        }}
        onChange={(e) => {
          const s = a.clean(e.target.value);
          setTyped(s);
          // Nothing typed yet (an empty field, a lone point) keeps the amount; leaving the field shows it again. A 0 is
          // a number below the range like any other: the amount goes to the minimum and the field is outlined.
          if (hasDigit(s)) onChange(clamp(a.fromInput(s), min, max));
        }}
        onBlur={() => {
          setTyped(null);
          onTyping?.(false);
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        aria-label={t('amount.typed', { label })}
        aria-invalid={outside || undefined}
        data-testid={testId}
      />
      {a.unit === 'bb' && <span className="text-xs text-ink-400">BB</span>}
    </span>
  );
}

/**
 * The controls of an automatic chip policy: the mode, its terms, the total limit and the player's consent to them
 * (`draftRequest` turns them into what the room is sent). Rebuy amounts and top-up targets stay within the buy-in range.
 */
function AutoBuyFields({
  draft: d,
  edit,
  onMode,
  modes,
  table,
}: {
  draft: AutoBuyDraft;
  edit: (patch: Partial<AutoBuyDraft>) => void;
  onMode: (mode: AutoBuyDraft['mode']) => void;
  modes: AutoBuyDraft['mode'][];
  table: TableView['table'];
}) {
  const { t } = useI18n();
  const { minBuyIn, maxBuyIn, bigBlind } = table;
  const a = useAmounts(bigBlind);
  const fmt = (n: number) => formatChips(n);
  const topup = d.mode === 'topup';
  const per = topup ? d.target : d.amount;
  const id = topup ? 'autotop' : 'rebuy';
  const range = (value: number, min: number, max: number, set: (n: number) => void, testId: string, label: string, inputId: string, onTyping?: (on: boolean) => void) => (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={1} value={value} onChange={(e) => set(Number(e.target.value))} aria-label={label} className="min-w-0 flex-1" data-testid={testId} />
      <AmountInput a={a} value={value} min={min} max={max} onChange={set} onTyping={onTyping} label={label} testId={inputId} />
    </div>
  );
  // A typed target is weighed against the terms as they were when typing began, so the numbers passing through the field
  // on the way to the one typed do not move a trigger the player set (one that was the target follows it, as on the slider).
  const typingFrom = useRef<AutoBuyDraft | null>(null);
  const setTarget = (target: number) => {
    const s = typingFrom.current;
    edit(s ? { target, trigger: s.trigger === s.target ? target : s.trigger } : { target });
  };
  return (
    <div className="flex flex-col gap-3">
      {modes.length > 1 && (
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t('autobuy.mode')}>
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={d.mode === m}
              onClick={() => d.mode !== m && onMode(m)}
              className={cx('jc-tap rounded-lg border px-3 py-2 text-left text-xs font-semibold', d.mode === m ? 'border-gold-400 bg-gold-500/10 text-gold-300' : 'border-white/10 text-ink-200')}
              data-testid={`autobuy-mode-${m}`}
            >
              {t(`autobuy.${m}`)}
            </button>
          ))}
        </div>
      )}
      {d.mode === 'rebuy' && (
        // Not a <label>: it holds two controls (the slider and the typed amount), each named on its own.
        <div className="flex flex-col gap-1.5 text-xs text-ink-300">
          <span className="flex justify-between">
            {t('rebuy.amount')}
            <span className="font-mono text-sm font-semibold text-ivory tabular-nums" data-testid="rebuy-amount">{a.exact(d.amount)}</span>
          </span>
          {range(d.amount, minBuyIn, maxBuyIn, (amount) => edit({ amount }), 'rebuy-range', t('rebuy.amount'), 'rebuy-input')}
        </div>
      )}
      {topup && (
        <>
          <div className="flex flex-col gap-1.5 text-xs text-ink-300">
            <span className="flex justify-between">
              {t('autotop.target')}
              <span className="font-mono text-sm font-semibold text-ivory tabular-nums" data-testid="autotop-target-amount">{a.exact(d.target)}</span>
            </span>
            {range(d.target, minBuyIn, maxBuyIn, setTarget, 'autotop-target', t('autotop.target'), 'autotop-target-input', (on) => (typingFrom.current = on ? d : null))}
          </div>
          <div className="flex flex-col gap-1.5 text-xs text-ink-300">
            <span className="flex justify-between gap-2">
              {t('autotop.trigger')}
              <span className="shrink-0 font-mono text-sm font-semibold text-ivory tabular-nums" data-testid="autotop-trigger-amount">{a.exact(d.trigger)}</span>
            </span>
            {range(d.trigger, 1, d.target, (trigger) => edit({ trigger }), 'autotop-trigger', t('autotop.trigger'), 'autotop-trigger-input')}
          </div>
          <label className="flex items-start gap-2 text-xs text-ink-200">
            <input type="checkbox" checked={d.partial} onChange={(e) => edit({ partial: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="autotop-partial" />
            {t('autotop.partial')}
          </label>
        </>
      )}
      {d.mode !== 'off' && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-300">{t('rebuy.cap')}</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={t('rebuy.cap')}>
              {AUTO_TIMES.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={d.times === n}
                  onClick={() => edit({ times: n })}
                  className={cx('jc-tap rounded-lg border px-2 py-2 text-xs font-semibold', d.times === n ? 'border-gold-400 text-gold-300' : 'border-white/10 text-ink-200')}
                  data-testid={`${id}-times-${n}`}
                >
                  {t('rebuy.times', { n, total: a.fmt(per * n) })}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-start gap-2 text-xs text-ink-200">
            <input type="checkbox" checked={d.consent} onChange={(e) => edit({ consent: e.target.checked })} className="mt-0.5 size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid={`${id}-consent`} />
            {topup
              ? t(d.partial ? 'autotop.consentPartial' : 'autotop.consent', { target: fmt(d.target), trigger: fmt(d.trigger), cap: fmt(per * d.times) })
              : t('rebuy.consent', { amount: fmt(d.amount), cap: fmt(per * d.times) })}
          </label>
        </>
      )}
    </div>
  );
}

/** The policy the room holds for this seat: its terms, what it used of its limit, and for a top-up what the next one may take. */
function AutoBuyStatus({ policy: p, stack, wallet, table }: { policy: AutoBuyPolicy; stack: number; wallet: number; table: TableView['table'] }) {
  const { t } = useI18n();
  const a = useAmounts(table.bigBlind);
  if (p.mode === 'rebuy') {
    return (
      <p className="text-sm text-gold-300" data-testid="rebuy-active">
        {t('rebuy.active', { amount: a.exact(p.amount), spent: a.fmt(p.spent), cap: a.fmt(p.cap) })}
      </p>
    );
  }
  const next = autoBuyEstimate(p, stack, table, wallet);
  return (
    <div className="flex flex-col gap-1 text-xs text-ink-300" data-testid="autotop-active">
      <p className="text-sm font-semibold text-gold-300">{t('autotop.active')}</p>
      <p>{t('autotop.terms', { target: a.exact(p.target), trigger: a.exact(p.trigger) })}</p>
      <p>{t('autotop.used', { spent: a.fmt(p.spent), cap: a.fmt(p.cap) })}</p>
      <p className="font-semibold text-ivory" data-testid="autotop-estimate">
        {next.stop ? t(next.stop === 'short' ? 'autotop.estimateShort' : 'autotop.estimateCap') : next.amount > 0 ? t('autotop.estimate', { amount: a.exact(next.amount) }) : t('autotop.estimateNone')}
      </p>
      <p className="text-ink-400">{t('autotop.estimateNote', { stack: a.exact(stack) })}</p>
    </div>
  );
}

/**
 * Adding chips from the wallet to a seated player's stack, and the opt-in automatic chip policy (rebuy or top-up). The
 * server checks everything again; the limits here only keep the controls within what it accepts.
 */
export function TopUpModal({
  open,
  onClose,
  state,
  wallet,
  request,
  onCancelQueued,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  state: TableView;
  wallet: number;
  request: TableSocketApi['request'];
  onCancelQueued: () => void;
  /** After a request succeeded (the wallet changed or will change). */
  onDone: () => void;
}) {
  const { t, err } = useI18n();
  const { minBuyIn, maxBuyIn, bigBlind } = state.table;
  const seat = state.seats.find((x) => x.seatIndex === state.you.seatIndex);
  // In a hand this is the stack behind the bets, which is what the server measures a top-up against.
  const stack = seat?.stack ?? 0;
  const inHand = !!state.hand && state.hand.stage !== 'settled' && (seat?.state === 'active' || seat?.state === 'folded' || seat?.state === 'allin');
  const lo = Math.max(1, minBuyIn - stack);
  const room = maxBuyIn - stack;
  const hi = Math.min(room, wallet);
  const refill = useShortWhileOpen(open, room > 0 && wallet < lo);
  const [amount, setAmount] = useState(lo);
  const [busy, setBusy] = useState<'topup' | 'rebuy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A retry after a lost connection reuses the request id, so the server applies the top-up at most once.
  const pendingReq = useRef<{ amount: number; id: string } | null>(null);

  const policy = seatPolicy(state.you);
  // A room older than automatic top-ups knows only the rebuy (and its own message for it).
  const topUpOffered = state.you.autoBuy !== undefined;
  const base = clamp(bigBlind * 100, minBuyIn, maxBuyIn);
  const [draft, setDraft] = useState(() => draftFrom(null, 'rebuy', base));
  // Changing the policy the seat holds, rather than choosing one.
  const [editing, setEditing] = useState(false);

  // A layout effect, so the dialog never shows (or lets anyone move) the amount left from the last time it was open:
  // a passive effect could run after a quick pick and replace it with the suggestion.
  useLayoutEffect(() => {
    if (!open) return;
    setAmount(clamp(bigBlind * 100 - stack, lo, Math.max(lo, hi)));
    setDraft(draftFrom(null, 'rebuy', base));
    setEditing(false);
    setError(null);
    pendingReq.current = null;
    // Only when the dialog opens: later stack changes must not move the chosen amount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function topUp() {
    if (pendingReq.current?.amount !== amount) pendingReq.current = { amount, id: rid() };
    setBusy('topup');
    setError(null);
    try {
      await request({ t: 'topUp', amount }, pendingReq.current.id);
      pendingReq.current = null;
      onDone();
      onClose();
    } catch (e) {
      const code = e instanceof RequestError ? e.code : null;
      // Only an unanswered request (connection lost) may already have been applied; anything else was refused.
      if (code !== 'internal') pendingReq.current = null;
      setError(err(code));
    } finally {
      setBusy(null);
    }
  }

  /** Sets (or with `{ mode: 'off' }` ends) the seat's policy; the room answers with the policy it now holds. */
  async function setPolicy(p: AutoBuyRequest) {
    setBusy('rebuy');
    setError(null);
    try {
      if (topUpOffered) await request({ t: 'autoBuy', policy: p });
      else await request(p.mode === 'rebuy' ? { t: 'autoRebuy', on: true, amount: p.amount, cap: p.cap, consent: true } : { t: 'autoRebuy', on: false });
      setDraft((d) => ({ ...d, consent: false }));
      setEditing(false);
    } catch (e) {
      setError(err(e instanceof RequestError ? e.code : null));
    } finally {
      setBusy(null);
    }
  }

  // The wallet, and sentences that name chips, stay in chips; the stack and the amounts for it read in the player's unit.
  const fmt = (n: number) => formatChips(n);
  const a = useAmounts(bigBlind);
  return (
    <Modal open={open} onClose={onClose} title={t('topup.title')}>
      <div className="flex flex-col gap-4" data-testid="topup-modal">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex flex-col rounded-lg bg-ink-850/80 px-3 py-2">
            <span className="text-xs text-ink-400">{t('topup.stack')}</span>
            <span className="font-mono font-semibold tabular-nums" data-testid="topup-stack">{a.fmt(stack)}</span>
          </div>
          <div className="flex flex-col rounded-lg bg-ink-850/80 px-3 py-2">
            <span className="text-xs text-ink-400">{t('table.wallet')}</span>
            <span className="font-mono font-semibold text-gold-300 tabular-nums" data-testid="topup-wallet">{fmt(wallet)}</span>
          </div>
        </div>
        <p className="text-xs text-ink-300">{t('topup.limit', { min: a.fmt(minBuyIn), max: a.fmt(maxBuyIn) })}</p>

        {state.you.topUpQueued !== null && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold-500/30 bg-gold-500/10 px-3 py-2 text-sm text-gold-300" role="status">
            <span>{t('topup.queuedNote', { amount: fmt(state.you.topUpQueued) })}</span>
            <Button size="sm" variant="ghost" onClick={onCancelQueued} data-testid="topup-modal-cancel">
              {t('topup.cancel')}
            </Button>
          </div>
        )}

        {room <= 0 ? (
          <p className="text-sm text-ink-300" data-testid="topup-at-max">{t('topup.atMax')}</p>
        ) : wallet < lo ? (
          <div className="flex flex-col gap-1 text-sm" data-testid="topup-short">
            <p className="text-[#f3b0b2]">{t('topup.short', { need: fmt(lo) })}</p>
            {/* A new tab: only a seated player tops up, and leaving this page would leave the game behind. */}
            <Link to="/me" target="_blank" rel="noopener" className="jc-tap self-start py-1 text-gold-300 underline underline-offset-2" data-testid="topup-wallet-link">
              {t('topup.wallet')} →
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {inHand && <p className="text-xs text-ink-300">{t('topup.afterHand')}</p>}
            {hi > lo && (
              <div className="flex items-center gap-3">
                <input type="range" min={lo} max={hi} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label={t('topup.open')} className="min-w-0 flex-1" data-testid="topup-range" />
                <AmountInput a={a} value={amount} min={lo} max={hi} onChange={setAmount} label={t('topup.open')} testId="topup-input" />
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-2xl font-semibold text-gold-300 tabular-nums" data-testid="topup-amount">+{a.fmt(amount)}</span>
              <span className="font-mono text-xs text-ink-400">→ {a.fmt(stack + amount)}</span>
            </div>
            <Button loading={busy === 'topup'} disabled={busy !== null} onClick={topUp} data-testid="topup-confirm">
              {t('topup.confirm', { amount: a.exact(amount) })}
            </Button>
          </div>
        )}
        {refill && <RefillHintLazy />}

        <div className="jc-divider" />
        <section className="flex flex-col gap-3" data-testid="rebuy-section">
          <div>
            <h4 className="text-sm font-bold text-ivory">{t(topUpOffered ? 'autobuy.title' : 'rebuy.title')}</h4>
            <p className="mt-1 text-xs text-ink-400">{t(topUpOffered ? 'autobuy.descSeated' : 'rebuy.desc')}</p>
          </div>
          {policy && !editing ? (
            <div className="flex flex-col gap-2">
              <AutoBuyStatus policy={policy} stack={stack} wallet={wallet} table={state.table} />
              <div className="flex flex-wrap gap-2">
                {topUpOffered && (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setDraft(draftFrom(policy, policy.mode, base));
                      setEditing(true);
                    }}
                    data-testid="autobuy-change"
                  >
                    {t('autobuy.change')}
                  </Button>
                )}
                <Button variant="outline" loading={busy === 'rebuy'} disabled={busy !== null} onClick={() => setPolicy({ mode: 'off' })} data-testid={policy.mode === 'rebuy' ? 'rebuy-off' : 'autotop-off'}>
                  {t(policy.mode === 'rebuy' ? 'rebuy.off' : 'autotop.off')}
                </Button>
              </div>
              <Link to="/me" target="_blank" rel="noopener" className="jc-tap self-start py-1 text-xs text-gold-300 underline underline-offset-2" data-testid="autobuy-wallet-link">
                {t('topup.wallet')} →
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <AutoBuyFields
                draft={draft}
                edit={(p) => setDraft((d) => editDraft(d, p))}
                onMode={(mode) => setDraft(draftFrom(null, mode, base))}
                modes={topUpOffered ? ['rebuy', 'topup'] : ['rebuy']}
                table={state.table}
              />
              {editing && <p className="text-xs text-ink-400">{t('autobuy.changeNote')}</p>}
              <div className="flex flex-wrap gap-2">
                {editing && (
                  <Button variant="ghost" disabled={busy !== null} onClick={() => setEditing(false)} data-testid="autobuy-change-cancel">
                    {t('common.cancel')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  loading={busy === 'rebuy'}
                  disabled={!draft.consent || busy !== null}
                  onClick={() => {
                    const p = draftRequest(draft);
                    if (p) void setPolicy(p);
                  }}
                  data-testid={draft.mode === 'topup' ? 'autotop-on' : 'rebuy-on'}
                >
                  {t(editing ? 'autobuy.save' : draft.mode === 'topup' ? 'autotop.on' : 'rebuy.on')}
                </Button>
              </div>
            </div>
          )}
        </section>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

export function ChatPanel({
  chat,
  onSend,
  canChat,
  myId,
  onPick,
  hidden,
}: {
  chat: ChatMessage[];
  onSend: (text: string) => void;
  canChat: boolean;
  myId?: string;
  onPick?: (m: ChatMessage) => void;
  /** Players whose lines are left out (muted or blocked by me). */
  hidden?: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const shown = hidden?.size ? chat.filter((m) => !hidden.has(m.userId)) : chat;
  useEffect(() => {
    // Block body on purpose: newer Chrome returns a Promise from scrollIntoView,
    // and React would call a returned value as the effect cleanup.
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);
  function submit(e: FormEvent) {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    onSend(v);
    setText('');
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 text-sm">
        {shown.map((m) => (
          <div key={m.id} className={cx('break-words', m.role && 'jc-role-line')} data-role={m.role} data-testid="chat-line">
            {onPick && m.userId !== myId ? (
              <button type="button" className="max-w-full align-bottom font-semibold text-gold-300 hover:underline" onClick={() => onPick(m)} data-testid="chat-author">
                <MemberName name={m.nickname} role={m.role} vip={m.vip} />
              </button>
            ) : (
              <MemberName name={m.nickname} role={m.role} vip={m.vip} className="font-semibold text-gold-300" />
            )}
            {m.role && <RoleBadge role={m.role} className="ml-1 align-[1px]" />}{' '}
            <span className="text-ink-100">{m.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      {canChat && (
        <form onSubmit={submit} className="relative mt-2 flex gap-2">
          <input
            ref={field}
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('table.chatPlaceholder')}
            className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-850 px-3 text-base sm:h-9 sm:text-sm"
            aria-label={t('table.chat')}
            data-testid="chat-input"
          />
          <EmojiPicker inputRef={field} value={text} onChange={setText} maxLength={200} small />
          <Button size="sm" type="submit" className="h-11! sm:h-9!" aria-label={t('table.send')}>
            <SendHorizontalIcon />
          </Button>
        </form>
      )}
    </div>
  );
}

function useAudioSettings(): AudioSettings {
  return useSyncExternalStore(
    (cb) => sound.subscribe(cb),
    () => sound.settings,
  );
}

/**
 * Where the table look and aids are kept and how saving them goes: the account's, on every device. A failed save still
 * applies here and is retried; an administrator's reset and a newer change from another device are told once.
 */
function SettingsSyncLine() {
  const { t } = useI18n();
  const { me } = useAuth();
  const sync = useSettingsSync();
  if (!me || sync.state === 'off') return null;
  const text = { loading: 'settings.sync.loading', saving: 'settings.sync.saving', saved: 'settings.sync.saved', error: 'settings.sync.error' } as const;
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="settings-sync" data-state={sync.state}>
      <div className="flex items-center justify-between gap-2">
        <span role="status" className={sync.state === 'error' ? 'text-danger' : 'text-ink-300'}>
          {t(text[sync.state])}
        </span>
        {sync.state === 'error' && (
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => pullSettings(true)} data-testid="settings-sync-retry">
            {t('settings.sync.retry')}
          </Button>
        )}
      </div>
      {sync.reset && <span className="text-ink-300">{t('settings.sync.reset')}</span>}
      {sync.kept > 0 && <span className="text-ink-300">{t('settings.sync.kept')}</span>}
    </div>
  );
}

/** Sound, table look and language; from the header it also offers logout (`onLogout`), at a table its invite link (`top`). */
export function SettingsModal({ open, onClose, onLogout, top }: { open: boolean; onClose: () => void; onLogout?: () => void; top?: ReactNode }) {
  const { t, locale } = useI18n();
  const { me, chooseLocale } = useAuth();
  const prefs = usePrefs();
  const audio = useAudioSettings();
  const cvName = useId();
  // Opening the settings reads the account's again unless they were a moment ago (another device may have changed them).
  useEffect(() => {
    if (open) pullSettings();
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t('settings.title')}>
      <div className="flex flex-col gap-5">
        {top && (
          <>
            {top}
            <div className="jc-divider" />
          </>
        )}
        {me && (
          <>
            <section className="flex flex-col gap-3">
              <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-300">{t('presence.title')}</h4>
              <PresenceModePicker />
            </section>
            <div className="jc-divider" />
          </>
        )}
        <section className="flex flex-col gap-3">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-300">{t('settings.sound')}</h4>
          <p className="-mt-1.5 text-xs text-ink-300">{t('settings.deviceOnly')}</p>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.master')}
            <input type="range" min={0} max={1} step={0.05} value={audio.master} onChange={(e) => sound.update({ master: Number(e.target.value) })} className="w-40" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.effects')}
            <input type="range" min={0} max={1} step={0.05} value={audio.effects} onChange={(e) => sound.update({ effects: Number(e.target.value) })} className="w-40" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.mute')}
            <input type="checkbox" checked={audio.muted} onChange={(e) => sound.update({ muted: e.target.checked })} className="size-4 accent-[var(--color-gold-500)]" />
          </label>
          {/* The table's background music: its own on/off and volume, under the master volume and mute. */}
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <MusicIcon className="size-4 text-ink-300" />
              {t('settings.music')}
            </span>
            <input
              type="checkbox"
              checked={audio.musicOn}
              onChange={(e) => sound.update({ musicOn: e.target.checked })}
              className="size-4 accent-[var(--color-gold-500)]"
              data-testid="settings-music"
            />
          </label>
          <label className={cx('flex items-center justify-between gap-3 text-sm', !audio.musicOn && 'opacity-50')}>
            {t('settings.musicVolume')}
            <span className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={audio.music}
                disabled={!audio.musicOn}
                onChange={(e) => sound.update({ music: Number(e.target.value) })}
                className="w-40"
                data-testid="settings-music-volume"
              />
              <span className="w-9 text-right tabular-nums text-ink-300">{Math.round(audio.music * 100)}%</span>
            </span>
          </label>
        </section>
        <div className="jc-divider" />
        <section className="flex flex-col gap-3">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-300">{t('settings.theme')}</h4>
          <SettingsSyncLine />
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((th) => (
              <button
                key={th}
                data-theme={th}
                onClick={() => setPrefs({ theme: th })}
                className={`flex items-center gap-2 rounded-lg border p-2 text-left text-xs font-semibold ${prefs.theme === th ? 'border-gold-400 text-gold-300' : 'border-white/10 text-ink-200'}`}
                aria-pressed={prefs.theme === th}
              >
                <span className="size-6 shrink-0 rounded-full border border-white/20" style={{ background: 'var(--t-felt)' }} />
                {t(`theme.${th}` as MsgKey)}
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.fourColor')}
            <input type="checkbox" checked={prefs.fourColor} onChange={(e) => setPrefs({ fourColor: e.target.checked })} className="size-4 accent-[var(--color-gold-500)]" />
          </label>
          <fieldset data-testid="settings-color-vision">
            <legend className="text-sm">{t('settings.colorVision')}</legend>
            <p className="mt-0.5 text-xs text-ink-300">{t('settings.colorVisionHint')}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {SETTINGS_COLOR_VISIONS.map((cv) => (
                <label
                  key={cv}
                  className={cx('flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 text-xs font-semibold', prefs.colorVision === cv ? 'border-gold-400 text-gold-300' : 'border-white/10 text-ink-200')}
                >
                  <input type="radio" name={cvName} value={cv} checked={prefs.colorVision === cv} onChange={() => setPrefs({ colorVision: cv })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" />
                  {t(`settings.cv.${cv}` as MsgKey)}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.beginner')}
            <input type="checkbox" checked={prefs.beginner} onChange={(e) => setPrefs({ beginner: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-beginner" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col gap-0.5">
              {t('settings.showHand')}
              <span className="text-xs text-ink-300">{t('settings.showHandHint')}</span>
            </span>
            <input type="checkbox" checked={prefs.showHand} onChange={(e) => setPrefs({ showHand: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-show-hand" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.confirmRisky')}
            <input type="checkbox" checked={prefs.confirmRisky} onChange={(e) => setPrefs({ confirmRisky: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col gap-0.5">
              {t('settings.reactions')}
              <span className="text-xs text-ink-300">{t('settings.reactionsHint')}</span>
            </span>
            <input type="checkbox" checked={prefs.reactions} onChange={(e) => setPrefs({ reactions: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-reactions" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col gap-0.5">
              {t('settings.turnVibrate')}
              <span className="text-xs text-ink-300">{t('settings.turnVibrateHint')}</span>
            </span>
            <input type="checkbox" checked={prefs.turnVibrate} onChange={(e) => setPrefs({ turnVibrate: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-turn-vibrate" />
          </label>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col gap-0.5" id="amount-unit-label">
              {t('settings.amountUnit')}
              <span className="text-xs text-ink-300">{t('settings.amountUnitHint')}</span>
            </span>
            <div className="flex shrink-0 rounded-lg border border-white/10 p-0.5" role="radiogroup" aria-labelledby="amount-unit-label">
              {AMOUNT_UNITS.map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={prefs.amountUnit === u}
                  onClick={() => setPrefs({ amountUnit: u })}
                  className={cx('jc-tap min-h-9 min-w-12 rounded-md px-2.5 text-xs font-semibold', prefs.amountUnit === u ? 'bg-gold-500/20 text-gold-300' : 'text-ink-300 hover:text-ivory')}
                  data-testid={`settings-unit-${u}`}
                >
                  {t(`settings.unit.${u}` as MsgKey)}
                </button>
              ))}
            </div>
          </div>
        </section>
        <div className="jc-divider" />
        <Field label={t('settings.language')}>
          {(id) => (
            <select id={id} value={locale} onChange={(e) => chooseLocale(e.target.value as 'ko' | 'en')} className="h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-base sm:text-sm">
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </select>
          )}
        </Field>
        <InstallSettingsLazy />
        {onLogout && (
          <>
            <div className="jc-divider" />
            <Button variant="outline" className="w-full" onClick={onLogout} data-testid="settings-logout">
              {t('nav.logout')}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
