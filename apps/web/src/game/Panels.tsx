import { sound, type AudioSettings } from '@jc/audio';
import { AUTO_REBUY_MAX_TIMES, type ChatMessage, type TableView } from '@jc/types';
import { Button, cx, Field, formatChips, Modal, THEMES } from '@jc/ui';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { EmojiPicker } from '../components/EmojiPicker';
import { MemberName, RoleBadge } from '../components/MemberName';
import { useAmounts } from '../lib/amount';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { AMOUNT_UNITS, setPrefs, usePrefs } from '../lib/prefs';
import { RequestError, rid, type TableSocketApi } from './useTableSocket';

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
  onConfirm: (amount: number) => void;
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
          <Button disabled={!affordable} loading={busy} onClick={() => onConfirm(amount)} data-testid="buyin-confirm">
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
            <input type="range" min={minBuyIn} max={cap} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label={t('table.buyIn')} />
            <div className="text-center font-mono text-3xl font-semibold text-gold-300 tabular-nums" data-testid="buyin-amount">
              {a.fmt(amount)}
              {a.unit === 'bb' && <span className="block text-xs font-normal text-ink-400">{formatChips(amount)}</span>}
            </div>
          </>
        ) : (
          <p className="text-sm text-danger">{t('err.insufficient_balance')}</p>
        )}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const REBUY_TIMES = [1, 2, 3, AUTO_REBUY_MAX_TIMES];

/**
 * Adding chips from the wallet to a seated player's stack, and the opt-in automatic rebuy. The server checks
 * everything again; the limits here only keep the controls within what it accepts.
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
  const [amount, setAmount] = useState(lo);
  const [busy, setBusy] = useState<'topup' | 'rebuy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A retry after a lost connection reuses the request id, so the server applies the top-up at most once.
  const pendingReq = useRef<{ amount: number; id: string } | null>(null);

  const auto = state.you.autoRebuy;
  const [rebuyAmount, setRebuyAmount] = useState(minBuyIn);
  const [times, setTimes] = useState(1);
  const [consent, setConsent] = useState(false);

  // A layout effect, so the dialog never shows (or lets anyone move) the amount left from the last time it was open:
  // a passive effect could run after a quick pick and replace it with the suggestion.
  useLayoutEffect(() => {
    if (!open) return;
    setAmount(clamp(bigBlind * 100 - stack, lo, Math.max(lo, hi)));
    setRebuyAmount(clamp(bigBlind * 100, minBuyIn, maxBuyIn));
    setTimes(1);
    setConsent(false);
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

  async function setRebuy(on: boolean) {
    setBusy('rebuy');
    setError(null);
    try {
      await request(on ? { t: 'autoRebuy', on, amount: rebuyAmount, cap: rebuyAmount * times, consent: true } : { t: 'autoRebuy', on });
      setConsent(false);
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
            <Link to="/me" className="self-start text-gold-300 underline underline-offset-2">
              {t('topup.wallet')} →
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {inHand && <p className="text-xs text-ink-300">{t('topup.afterHand')}</p>}
            {hi > lo && <input type="range" min={lo} max={hi} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label={t('topup.open')} data-testid="topup-range" />}
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-2xl font-semibold text-gold-300 tabular-nums" data-testid="topup-amount">+{a.fmt(amount)}</span>
              <span className="font-mono text-xs text-ink-400">→ {a.fmt(stack + amount)}</span>
            </div>
            <Button loading={busy === 'topup'} disabled={busy !== null} onClick={topUp} data-testid="topup-confirm">
              {t('topup.confirm', { amount: a.exact(amount) })}
            </Button>
          </div>
        )}

        <div className="jc-divider" />
        <section className="flex flex-col gap-3" data-testid="rebuy-section">
          <div>
            <h4 className="text-sm font-bold text-ivory">{t('rebuy.title')}</h4>
            <p className="mt-1 text-xs text-ink-400">{t('rebuy.desc')}</p>
          </div>
          {auto ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-gold-300" data-testid="rebuy-active">
                {t('rebuy.active', { amount: a.exact(auto.amount), spent: a.fmt(auto.spent), cap: a.fmt(auto.cap) })}
              </p>
              <Button variant="outline" loading={busy === 'rebuy'} disabled={busy !== null} onClick={() => setRebuy(false)} data-testid="rebuy-off">
                {t('rebuy.off')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-xs text-ink-300">
                <span className="flex justify-between">
                  {t('rebuy.amount')}
                  <span className="font-mono text-sm font-semibold text-ivory tabular-nums" data-testid="rebuy-amount">{a.exact(rebuyAmount)}</span>
                </span>
                <input
                  type="range"
                  min={minBuyIn}
                  max={maxBuyIn}
                  step={1}
                  value={rebuyAmount}
                  onChange={(e) => {
                    setRebuyAmount(Number(e.target.value));
                    setConsent(false);
                  }}
                  data-testid="rebuy-range"
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-300">{t('rebuy.cap')}</span>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label={t('rebuy.cap')}>
                  {REBUY_TIMES.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={times === n}
                      onClick={() => {
                        setTimes(n);
                        setConsent(false);
                      }}
                      className={cx('jc-tap rounded-lg border px-2 py-2 text-xs font-semibold', times === n ? 'border-gold-400 text-gold-300' : 'border-white/10 text-ink-200')}
                      data-testid={`rebuy-times-${n}`}
                    >
                      {t('rebuy.times', { n, total: a.fmt(rebuyAmount * n) })}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-start gap-2 text-xs text-ink-200">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="rebuy-consent" />
                {t('rebuy.consent', { amount: fmt(rebuyAmount), cap: fmt(rebuyAmount * times) })}
              </label>
              <Button variant="outline" loading={busy === 'rebuy'} disabled={!consent || busy !== null} onClick={() => setRebuy(true)} data-testid="rebuy-on">
                {t('rebuy.on')}
              </Button>
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
                <MemberName name={m.nickname} role={m.role} />
              </button>
            ) : (
              <MemberName name={m.nickname} role={m.role} className="font-semibold text-gold-300" />
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
          <Button size="sm" type="submit" className="h-11! sm:h-9!" aria-label={t('table.chat')}>
            ↵
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

/** Sound, table look and language; from the header it also offers logout (`onLogout`), at a table its invite link (`top`). */
export function SettingsModal({ open, onClose, onLogout, top }: { open: boolean; onClose: () => void; onLogout?: () => void; top?: ReactNode }) {
  const { t, locale } = useI18n();
  const { chooseLocale } = useAuth();
  const prefs = usePrefs();
  const audio = useAudioSettings();
  return (
    <Modal open={open} onClose={onClose} title={t('settings.title')}>
      <div className="flex flex-col gap-5">
        {top && (
          <>
            {top}
            <div className="jc-divider" />
          </>
        )}
        <section className="flex flex-col gap-3">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-300">{t('settings.sound')}</h4>
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
        </section>
        <div className="jc-divider" />
        <section className="flex flex-col gap-3">
          <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-300">{t('settings.theme')}</h4>
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
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.beginner')}
            <input type="checkbox" checked={prefs.beginner} onChange={(e) => setPrefs({ beginner: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-beginner" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.confirmRisky')}
            <input type="checkbox" checked={prefs.confirmRisky} onChange={(e) => setPrefs({ confirmRisky: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col gap-0.5">
              {t('settings.autoMuck')}
              <span className="text-xs text-ink-300">{t('settings.autoMuckHint')}</span>
            </span>
            <input type="checkbox" checked={prefs.autoMuck} onChange={(e) => setPrefs({ autoMuck: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-automuck" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex flex-col gap-0.5">
              {t('settings.reactions')}
              <span className="text-xs text-ink-300">{t('settings.reactionsHint')}</span>
            </span>
            <input type="checkbox" checked={prefs.reactions} onChange={(e) => setPrefs({ reactions: e.target.checked })} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid="settings-reactions" />
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
