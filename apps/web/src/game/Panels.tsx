import { sound, type AudioSettings } from '@jc/audio';
import type { ChatMessage, TableView } from '@jc/types';
import { Button, Field, formatChips, Modal, THEMES } from '@jc/ui';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { setPrefs, usePrefs } from '../lib/prefs';

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
            {t('table.buyIn')} {formatChips(amount)}
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
            {formatChips(minBuyIn)} – {formatChips(maxBuyIn)}
          </span>
        </div>
        {affordable ? (
          <>
            <input type="range" min={minBuyIn} max={cap} step={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label={t('table.buyIn')} />
            <div className="text-center font-mono text-3xl font-semibold text-gold-300 tabular-nums">{formatChips(amount)}</div>
          </>
        ) : (
          <p className="text-sm text-danger">{t('err.insufficient_balance')}</p>
        )}
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
          <div key={m.id} className="break-words" data-testid="chat-line">
            {onPick && m.userId !== myId ? (
              <button type="button" className="font-semibold text-gold-300 hover:underline" onClick={() => onPick(m)} data-testid="chat-author">{m.nickname}</button>
            ) : (
              <span className="font-semibold text-gold-300">{m.nickname}</span>
            )}{' '}
            <span className="text-ink-100">{m.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      {canChat && (
        <form onSubmit={submit} className="mt-2 flex gap-2">
          <input
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('table.chatPlaceholder')}
            className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-850 px-3 text-base sm:h-9 sm:text-sm"
            aria-label={t('table.chat')}
          />
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

/** Sound, table look and language; from the header it also offers logout (`onLogout`). */
export function SettingsModal({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout?: () => void }) {
  const { t, locale } = useI18n();
  const { chooseLocale } = useAuth();
  const prefs = usePrefs();
  const audio = useAudioSettings();
  return (
    <Modal open={open} onClose={onClose} title={t('settings.title')}>
      <div className="flex flex-col gap-5">
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
