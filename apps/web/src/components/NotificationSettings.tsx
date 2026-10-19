import { NOTIFICATION_TYPES, type NotificationSettingsDto, type NotificationSettingsSave, type PushDevicesDto } from '@jc/types';
import { Badge, Button, cx, formatDate } from '@jc/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { consentWithdrawn, disableDevice, enableDevice, permission, pushSupport } from '../lib/push';

type Change = Omit<NotificationSettingsSave, 'expectedVersion'>;
const box = 'mt-0.5 size-4 shrink-0 accent-[var(--color-gold-500)] disabled:cursor-not-allowed';

/**
 * My page's notifications, the account's part: the two consents and each kind, the same on every device (saved on the
 * server from the version shown, so a change made on another device in the meantime is shown instead of overwritten).
 * What this browser allows and whether it is registered is the device's part, below it.
 */
export function NotificationSettings() {
  const { t, err, locale } = useI18n();
  const [s, setS] = useState<NotificationSettingsDto | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const savingRef = useRef(false);
  const [devicesRev, setDevicesRev] = useState(0);
  const id = useId();

  const load = useCallback(async () => {
    try {
      const next = await api<NotificationSettingsDto>('/api/me/notifications/settings');
      if (!savingRef.current) setS(next);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    // Back on this page after a while: what another device changed meanwhile shows before anything is changed here.
    const back = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [load]);

  async function change(c: Change) {
    if (!s || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setNote(null);
    try {
      const next = await api<NotificationSettingsDto>('/api/me/notifications/settings', { method: 'PUT', body: { expectedVersion: s.version, ...c } });
      setS(next);
      setNote({ tone: 'info', text: t('notify.saved') });
      if (s.service && !next.service) {
        // Withdrawn: the server removed every device; this browser's subscription goes as well.
        await consentWithdrawn().catch(() => undefined);
        setDevicesRev((n) => n + 1);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale_settings' && e.details && typeof e.details === 'object') {
        setS(e.details as NotificationSettingsDto);
        setNote({ tone: 'error', text: t('notify.stale') });
      } else {
        setNote({ tone: 'error', text: t('notify.saveFailed', { reason: e instanceof ApiError ? err(e.code) : t('common.error') }) });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (!s)
    return loadError ? (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
        {t('notify.loadFailed')}
        <button type="button" className="jc-tap min-h-8 rounded-md border border-white/10 px-2 text-xs font-semibold text-ink-200 hover:text-ivory" onClick={() => void load()}>
          {t('common.retry')}
        </button>
      </p>
    ) : (
      <p role="status" className="text-sm text-ink-400">
        {t('common.loading')}
      </p>
    );

  const when = (at: number | null, on: boolean) => (at ? t(on ? 'notify.agreedOn' : 'notify.withdrawnOn', { date: formatDate(at, locale) }) : null);
  return (
    <div className="flex max-w-xl flex-col gap-4" data-testid="notify-settings" aria-busy={saving || undefined}>
      <section className="flex flex-col gap-3" aria-labelledby={`${id}-account`}>
        <div>
          <h3 id={`${id}-account`} className="text-sm font-semibold text-ivory">
            {t('notify.account')}
          </h3>
          <p className="text-xs text-ink-400">{t('notify.accountHint')}</p>
        </div>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className={box} checked={s.service} disabled={saving} onChange={(e) => void change({ service: e.target.checked })} data-testid="notify-service" />
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold text-ink-100">{t('notify.service')}</span>
            <span className="text-xs text-ink-300">{t('consent.pushServiceHint')}</span>
            {when(s.serviceAt, s.service) && <span className="text-xs text-ink-400">{when(s.serviceAt, s.service)}</span>}
          </span>
        </label>
        <label className={cx('flex items-start gap-3 text-sm', s.service ? 'cursor-pointer' : 'cursor-not-allowed')}>
          <input type="checkbox" className={box} checked={s.night} disabled={saving || !s.service} onChange={(e) => void change({ night: e.target.checked })} data-testid="notify-night" />
          <span className="flex flex-col gap-0.5">
            <span className={cx('font-semibold', s.service ? 'text-ink-100' : 'text-ink-400')}>
              {t('notify.night')} <span className="font-normal text-ink-300">· {t('notify.nightRange')}</span>
            </span>
            <span className="text-xs text-ink-300">{t('consent.pushNightHint')}</span>
            <span className="text-xs text-ink-400">{s.service ? t('notify.nightOffHint') : t('consent.pushNightNeedsService')}</span>
            {s.service && when(s.nightAt, s.night) && <span className="text-xs text-ink-400">{when(s.nightAt, s.night)}</span>}
          </span>
        </label>
        <fieldset className="rounded-lg border border-white/10 px-3 pb-2 pt-1" disabled={saving || !s.service} aria-describedby={s.service ? undefined : `${id}-types`}>
          <legend className="px-1 text-xs font-semibold text-ink-300">{t('notify.types')}</legend>
          {!s.service && (
            <p id={`${id}-types`} className="pb-1 text-xs text-ink-400">
              {t('notify.typesNeedService')}
            </p>
          )}
          <div className="grid gap-x-4 sm:grid-cols-2">
            {NOTIFICATION_TYPES.map((k) => (
              <label key={k} className={cx('flex min-h-10 items-center gap-2.5 text-sm', s.service ? 'cursor-pointer text-ink-200' : 'cursor-not-allowed text-ink-400')}>
                <input type="checkbox" className={cx(box, 'mt-0')} checked={s.types[k]} onChange={(e) => void change({ types: { [k]: e.target.checked } })} data-testid={`notify-type-${k}`} />
                {t(`notify.type.${k}` as MsgKey)}
              </label>
            ))}
          </div>
        </fieldset>
        {!s.pushAvailable && <p className="text-xs text-ink-400">{t('notify.unavailable')}</p>}
      </section>
      <DevicePush service={s.service} available={s.pushAvailable} rev={devicesRev} />
      {note && (
        <p role={note.tone === 'error' ? 'alert' : 'status'} className={cx('text-xs', note.tone === 'error' ? 'text-danger' : 'text-ink-300')} data-testid="notify-note">
          {note.text}
        </p>
      )}
    </div>
  );
}

/**
 * This browser's part: whether it can get pushes, what it allows, and whether it is registered for this sign-in, with
 * every device the member registered (never their addresses). Turning it on asks the browser's permission, on a tap
 * only; it is never asked anywhere else.
 */
function DevicePush({ service, available, rev }: { service: boolean; available: boolean; rev: number }) {
  const { t, err, locale } = useI18n();
  const { me } = useAuth();
  const [devices, setDevices] = useState<PushDevicesDto['devices'] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [perm, setPerm] = useState(permission);
  const support = pushSupport();
  const id = useId();

  const load = useCallback(async () => {
    try {
      setDevices((await api<PushDevicesDto>('/api/me/notifications/devices')).devices);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, rev]);

  const current = devices?.find((d) => d.current);
  async function run(task: () => Promise<string | null>) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const done = await task();
      if (done) setNote({ tone: 'info', text: done });
    } catch (e) {
      setNote({ tone: 'error', text: t('notify.deviceFailed', { reason: e instanceof ApiError ? err(e.code) : t('common.error') }) });
    } finally {
      setPerm(permission());
      setBusy(false);
      void load();
    }
  }
  const turnOn = () =>
    run(async () => {
      const r = await enableDevice(me!.id);
      if (r.ok) return t('notify.deviceTurnedOn');
      setNote({ tone: 'error', text: t(r.reason === 'denied' ? 'notify.denied' : r.reason === 'dismissed' ? 'notify.permissionDismissed' : 'notify.unsupported') });
      return null;
    });
  const turnOff = () =>
    run(async () => {
      await disableDevice();
      return t('notify.deviceTurnedOff');
    });
  const remove = (deviceId: string) =>
    run(async () => {
      await api(`/api/me/notifications/subscriptions/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      return t('notify.deviceRemoved');
    });

  const blocker =
    support === 'unsupported'
      ? t('notify.unsupported')
      : support === 'ios-install'
        ? t('notify.iosInstall')
        : perm === 'denied'
          ? t('notify.denied')
          : !service
            ? t('notify.deviceNeedsService')
            : null;
  return (
    <section className="flex flex-col gap-3 border-t border-white/10 pt-4" aria-labelledby={`${id}-device`} data-testid="notify-device">
      <div>
        <h3 id={`${id}-device`} className="text-sm font-semibold text-ivory">
          {t('notify.device')}
        </h3>
        <p className="text-xs text-ink-400">{t('notify.deviceHint')}</p>
      </div>
      {available && (
        <>
          <p className="text-sm text-ink-200" data-testid="notify-device-state" data-on={current ? 'true' : 'false'}>
            <span aria-hidden className="mr-1.5">{current ? '●' : '○'}</span>
            {current ? t('notify.deviceActive') : t('notify.deviceInactive')}
          </p>
          {blocker && !current && <p className="text-xs text-ink-300" data-testid="notify-device-blocker">{blocker}</p>}
          <div>
            {current ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void turnOff()} data-testid="notify-device-off">
                {t('notify.deviceOff')}
              </Button>
            ) : (
              <Button size="sm" disabled={busy || !!blocker} onClick={() => void turnOn()} data-testid="notify-device-on">
                {t('notify.deviceOn')}
              </Button>
            )}
          </div>
        </>
      )}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold text-ink-300">{t('notify.devices')}</h4>
        {failed ? (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
            {t('notify.loadFailed')}
            <button type="button" className="jc-tap min-h-8 rounded-md border border-white/10 px-2 font-semibold text-ink-200 hover:text-ivory" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </p>
        ) : !devices ? (
          <p className="text-xs text-ink-400">{t('common.loading')}</p>
        ) : !devices.length ? (
          <p className="text-xs text-ink-400">{t('notify.devicesNone')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="notify-devices">
            {devices.map((d) => {
              const name = d.label ?? t('notify.deviceUnknown');
              return (
                <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/25 px-3 py-2 text-xs">
                  <span className="min-w-0 text-ink-300">
                    {d.current && (
                      <Badge tone="gold" className="mr-2">
                        {t('notify.deviceCurrent')}
                      </Badge>
                    )}
                    <span className="text-ink-100">{name}</span> · {t('notify.deviceAdded', { date: formatDate(d.createdAt, locale) })}
                    {d.lastSuccessAt && <> · {t('notify.deviceLastSent', { date: formatDate(d.lastSuccessAt, locale) })}</>}
                  </span>
                  <button
                    type="button"
                    className="jc-tap min-h-8 shrink-0 px-1 text-gold-300 hover:underline disabled:opacity-50"
                    disabled={busy}
                    aria-label={t('notify.deviceRemoveLabel', { name })}
                    onClick={() => void (d.current ? turnOff() : remove(d.id))}
                  >
                    {t('notify.deviceRemove')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-ink-400">{t('notify.deviceSignOutNote')}</p>
      </div>
      {note && (
        <p role={note.tone === 'error' ? 'alert' : 'status'} className={cx('text-xs', note.tone === 'error' ? 'text-danger' : 'text-ink-300')} data-testid="notify-device-note">
          {note.text}
        </p>
      )}
    </section>
  );
}
