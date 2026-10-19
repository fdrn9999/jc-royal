import { PRESENCE_MODES, type PresenceMode, type PresenceState } from '@jc/types';
import { cx } from '@jc/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { choosePresenceMode, loadMyPresence, useMyPresence } from '../lib/presence';

const TONE: Record<PresenceState, string> = { online: 'text-presence-online', away: 'text-presence-away', offline: 'text-presence-offline' };
/** The state each mode shows at most, for its icon. */
const MODE_ICON: Record<PresenceMode, PresenceState> = { auto: 'online', away: 'away', invisible: 'offline' };

/** A status's shape (always with its word somewhere beside it): a filled dot, a moon, an empty ring. */
export function PresenceIcon({ state, className = 'size-2.5' }: { state: PresenceState; className?: string }) {
  const c = cx('shrink-0', TONE[state], className);
  if (state === 'online')
    return (
      <svg viewBox="0 0 10 10" className={c} aria-hidden="true">
        <circle cx="5" cy="5" r="5" fill="currentColor" />
      </svg>
    );
  if (state === 'away')
    return (
      <svg viewBox="0 0 10 10" className={c} aria-hidden="true">
        <path d="M7 0.5A5 5 0 1 0 9.5 7A4 4 0 0 1 7 0.5Z" fill="currentColor" />
      </svg>
    );
  return (
    <svg viewBox="0 0 10 10" className={c} aria-hidden="true">
      <circle cx="5" cy="5" r="3.9" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

/** A status in words, with its shape. Squeezed (`min-w-0` from the row), the words end in an ellipsis; the shape stays. */
export function PresenceLabel({ state, className }: { state: PresenceState; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-xs', state === 'offline' ? 'text-ink-300' : 'text-ink-200', className)} data-presence={state}>
      <PresenceIcon state={state} />
      <span className="truncate">{t(`presence.${state}` as MsgKey)}</span>
    </span>
  );
}

/** An avatar with the friend's status at its corner (the words are elsewhere on the row; this is a glance). */
export function PresenceCorner({ state, children }: { state: PresenceState | undefined; children: ReactNode }) {
  return (
    <span className="relative shrink-0">
      {children}
      {state && (
        <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-ink-900" aria-hidden="true">
          <PresenceIcon state={state} className="size-2.5" />
        </span>
      )}
    </span>
  );
}

/**
 * The member's own status: auto (online while active, away after five idle minutes), away, or invisible (offline to
 * friends). The account's choice: every signed-in device follows it. Saved on the server; a failed save says so and
 * keeps the choice that is in effect.
 */
export function PresenceModePicker({ className }: { className?: string }) {
  const { t, err } = useI18n();
  const mine = useMyPresence();
  const [saving, setSaving] = useState<PresenceMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = useId();
  const reason = (e: unknown) => (e instanceof ApiError ? err(e.code) : t('common.error'));
  const load = () => {
    setError(null);
    loadMyPresence().catch((e: unknown) => setError(reason(e)));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function choose(mode: PresenceMode) {
    if (saving || !mine || mode === mine.mode) return;
    setSaving(mode);
    setError(null);
    try {
      await choosePresenceMode(mode);
    } catch (e) {
      setError(t('presence.saveFailed', { reason: reason(e) }));
    } finally {
      setSaving(null);
    }
  }
  return (
    <div className={cx('flex flex-col gap-2', className)} data-testid="presence-picker">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span id={label}>{t('presence.mine')}</span>
        {mine && (
          <span className="flex items-center gap-1.5 text-xs text-ink-300" data-testid="presence-mine-state">
            {t('presence.friendsSee')}
            <PresenceLabel state={mine.state} />
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 rounded-lg border border-white/10 p-1" role="radiogroup" aria-labelledby={label} aria-busy={saving ? true : undefined}>
        {PRESENCE_MODES.map((m) => {
          const on = mine?.mode === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              aria-describedby={`${label}-${m}`}
              disabled={!mine || !!saving}
              onClick={() => void choose(m)}
              className={cx(
                'jc-tap flex min-h-11 items-start gap-2.5 rounded-md px-2.5 py-2 text-left disabled:cursor-default',
                on ? 'bg-gold-500/15 ring-1 ring-gold-400/60' : 'enabled:hover:bg-white/[0.04]',
                saving === m && 'opacity-70',
              )}
              data-testid={`presence-mode-${m}`}
            >
              {/* The choice in effect says so by a mark as well as by colour. */}
              <span className={cx('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border', on ? 'border-gold-400' : 'border-ink-400')} aria-hidden="true">
                {on && <span className="size-2 rounded-full bg-gold-400" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cx('flex items-center gap-1.5 text-sm font-semibold', on ? 'text-gold-300' : 'text-ink-100')}>
                  <PresenceIcon state={MODE_ICON[m]} />
                  {t(`presence.mode.${m}` as MsgKey)}
                </span>
                <span id={`${label}-${m}`} className="text-xs text-ink-300">
                  {t(`presence.hint.${m}` as MsgKey)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-400">{t('presence.note')}</p>
      {error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger" data-testid="presence-error">
          {error}
          {!mine && (
            <button type="button" className="jc-tap min-h-8 rounded-md border border-white/10 px-2 font-semibold text-ink-200 hover:text-ivory" onClick={load}>
              {t('common.retry')}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** The header's status button (wide screens): the member's status, and a panel to change it (not a dialog). */
export function PresenceMenu() {
  const { t } = useI18n();
  const mine = useMyPresence();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const state = mine?.state;
  return (
    <div ref={box} className="relative">
      <button
        ref={btn}
        type="button"
        className="jc-tap flex min-h-9 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-xs font-semibold text-ink-200 hover:text-ivory"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={state ? `${t('presence.mine')}: ${t(`presence.${state}` as MsgKey)}` : t('presence.mine')}
        title={t('presence.mine')}
        onClick={() => setOpen((o) => !o)}
        data-testid="presence-menu"
      >
        {state ? <PresenceIcon state={state} /> : <span className="size-2.5 rounded-full border border-ink-400" aria-hidden="true" />}
        <span className="hidden xl:inline">{state ? t(`presence.${state}` as MsgKey) : t('presence.mine')}</span>
        <svg viewBox="0 0 12 12" className="size-3 text-ink-400" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={panel} className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-white/10 bg-ink-900 p-4 shadow-panel">
          <PresenceModePicker />
        </div>
      )}
    </div>
  );
}
