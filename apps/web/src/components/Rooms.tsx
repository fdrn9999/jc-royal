/**
 * Members' own rooms: the create dialog (lobby) and the host's room dialog (table). The server checks every
 * value; the host can rename the room, change spectating and the join code, share the link and close it.
 */
import { MAX_ACTIVE_ROOMS, ROOM_BIG_BLINDS, SUPPORTED_MAX_SEATS, type TableView } from '@jc/types';
import { Button, cx, Field, formatChips, Input, Modal } from '@jc/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { copyText } from '../lib/share';

const MIN_BB = [10, 20, 50, 100] as const;
const MAX_BB = [50, 100, 200] as const;

export function Choice<T extends string | number>({ label, value, options, onChange, render, testid }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render: (v: T) => ReactNode; testid: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          data-testid={`${testid}-${o}`}
          className={cx('jc-tap min-h-11 rounded-lg border px-3 text-sm font-semibold transition', value === o ? 'border-gold-500 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory')}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, children, testid }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; testid: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm">
      <span>{children}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 shrink-0 accent-[var(--color-gold-500)]" data-testid={testid} />
    </label>
  );
}

export function CreateRoomModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, err } = useI18n();
  const { me } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [maxSeats, setMaxSeats] = useState<(typeof SUPPORTED_MAX_SEATS)[number]>(6);
  const [bigBlind, setBigBlind] = useState<(typeof ROOM_BIG_BLINDS)[number]>(20);
  const [minBb, setMinBb] = useState<(typeof MIN_BB)[number]>(20);
  const [maxBb, setMaxBb] = useState<(typeof MAX_BB)[number]>(100);
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(me ? t('room.defaultName', { name: me.nickname }).slice(0, 30) : '');
    setError(null);
  }, [open, me, t]);

  const codeOk = !isPrivate || code.trim().length >= 4;
  const valid = name.trim().length >= 2 && maxBb >= minBb && codeOk;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>('/api/rooms', {
        body: { name: name.trim(), maxSeats, bigBlind, minBuyIn: minBb * bigBlind, maxBuyIn: maxBb * bigBlind, allowSpectators, isPrivate, ...(isPrivate ? { joinCode: code.trim() } : {}) },
      });
      onClose();
      // The host needs no join code for their own room, so none goes in the address.
      nav(`/table/${id}?sit=1`);
    } catch (e) {
      setError(err(e instanceof ApiError ? e.code : null));
    } finally {
      setBusy(false);
    }
  }

  const bb = (n: number) => `${n} BB · ${formatChips(n * bigBlind, true)}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('room.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!valid} loading={busy} onClick={create} data-testid="room-create">
            {t('room.create')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('room.name')}>{(id) => <Input id={id} value={name} maxLength={30} onChange={(e) => setName(e.target.value)} data-testid="room-name" />}</Field>
        <Field label={t('room.seats')}>{() => <Choice label={t('room.seats')} value={maxSeats} options={SUPPORTED_MAX_SEATS} onChange={setMaxSeats} render={(n) => t('room.seatsN', { n })} testid="room-seats" />}</Field>
        <Field label={t('lobby.blinds')}>
          {() => <Choice label={t('lobby.blinds')} value={bigBlind} options={ROOM_BIG_BLINDS} onChange={setBigBlind} render={(n) => `${formatChips(n / 2)}/${formatChips(n)}`} testid="room-bb" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('room.buyInMin')}>
            {(id) => (
              <select id={id} value={minBb} onChange={(e) => setMinBb(Number(e.target.value) as (typeof MIN_BB)[number])} className="h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-2 text-base text-ivory focus:border-gold-500/70 focus:outline-none sm:text-sm" data-testid="room-min">
                {MIN_BB.map((n) => (
                  <option key={n} value={n}>
                    {bb(n)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('room.buyInMax')}>
            {(id) => (
              <select id={id} value={maxBb} onChange={(e) => setMaxBb(Number(e.target.value) as (typeof MAX_BB)[number])} className="h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-2 text-base text-ivory focus:border-gold-500/70 focus:outline-none sm:text-sm" data-testid="room-max">
                {MAX_BB.map((n) => (
                  <option key={n} value={n}>
                    {bb(n)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {maxBb < minBb && <p className="text-sm text-[#f3b0b2]">{t('room.buyInOrder')}</p>}
        <div className="flex flex-col">
          <Check checked={allowSpectators} onChange={setAllowSpectators} testid="room-spectators">
            {t('room.spectators')}
          </Check>
          <Check checked={isPrivate} onChange={setIsPrivate} testid="room-private">
            {t('room.private')}
          </Check>
        </div>
        {isPrivate && (
          <Field label={t('room.code')}>{(id) => <Input id={id} value={code} maxLength={32} autoComplete="off" onChange={(e) => setCode(e.target.value)} data-testid="room-code" />}</Field>
        )}
        <p className="text-xs leading-relaxed text-ink-400">{t('room.rules', { n: MAX_ACTIVE_ROOMS })}</p>
        {error && (
          <p className="text-sm text-[#f3b0b2]" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The host's dialog. Seats, stakes, chips, cards and results are not here: the host cannot change them. */
export function HostRoomModal({ open, onClose, table }: { open: boolean; onClose: () => void; table: TableView['table'] }) {
  const { t, err } = useI18n();
  const [name, setName] = useState(table.name);
  const [allowSpectators, setAllowSpectators] = useState(table.allowSpectators);
  const [isPrivate, setIsPrivate] = useState(table.isPrivate);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(table.name);
    setAllowSpectators(table.allowSpectators);
    setIsPrivate(table.isPrivate);
    setCode('');
    setNote(null);
    setCopied(false);
    setConfirmClose(false);
    // Only when the dialog opens; live updates while it is open must not overwrite what the host is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const link = `${window.location.origin}/table/${table.id}`;
  const codeNeeded = isPrivate && !table.isPrivate;
  const valid = name.trim().length >= 2 && (code.trim() === '' ? !codeNeeded : code.trim().length >= 4);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await api(`/api/rooms/${table.id}`, { method: 'PATCH', body: { name: name.trim(), allowSpectators, isPrivate, ...(isPrivate && code.trim() ? { joinCode: code.trim() } : {}) } });
      setCode('');
      setNote({ ok: true, text: t('room.saved') });
    } catch (e) {
      setNote({ ok: false, text: err(e instanceof ApiError ? e.code : null) });
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!confirmClose) {
      setConfirmClose(true);
      return;
    }
    setBusy(true);
    try {
      await api(`/api/rooms/${table.id}/close`, { body: {} });
      onClose();
    } catch (e) {
      setNote({ ok: false, text: err(e instanceof ApiError ? e.code : null) });
    } finally {
      setBusy(false);
      setConfirmClose(false);
    }
  }

  async function copy() {
    try {
      setCopied(await copyText(link));
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('room.manage')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button disabled={!valid} loading={busy} onClick={save} data-testid="room-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('room.name')}>{(id) => <Input id={id} value={name} maxLength={30} onChange={(e) => setName(e.target.value)} data-testid="room-name" />}</Field>
        <div className="flex flex-col">
          <Check checked={allowSpectators} onChange={setAllowSpectators} testid="room-spectators">
            {t('room.spectators')}
          </Check>
          <Check checked={isPrivate} onChange={setIsPrivate} testid="room-private">
            {t('room.private')}
          </Check>
        </div>
        {isPrivate && (
          <Field label={t('room.code')} hint={table.isPrivate ? t('room.codeKeep') : undefined}>
            {(id) => <Input id={id} value={code} maxLength={32} autoComplete="off" onChange={(e) => setCode(e.target.value)} data-testid="room-code" />}
          </Field>
        )}
        {note && (
          <p className={cx('text-sm', note.ok ? 'text-[#9fd8b6]' : 'text-[#f3b0b2]')} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        <div className="border-t border-white/5 pt-4">
          <div className="mb-1.5 text-xs font-semibold text-ink-300">{t('room.invite')}</div>
          <div className="flex gap-2">
            <Input readOnly value={link} className="min-w-0 flex-1 font-mono text-xs" aria-label={t('room.invite')} data-testid="room-link" onFocus={(e) => e.target.select()} />
            <Button variant="outline" onClick={copy} data-testid="room-copy">
              {copied ? t('room.copied') : t('room.copy')}
            </Button>
          </div>
          {isPrivate && <p className="mt-1.5 text-xs text-ink-400">{t('room.inviteHint')}</p>}
        </div>
        <div className="border-t border-white/5 pt-4">
          {confirmClose && (
            <p className="mb-2 text-sm text-[#f3b0b2]" role="alert">
              {t('room.closeConfirm')}
            </p>
          )}
          <Button variant={confirmClose ? 'danger' : 'outline'} className="w-full" disabled={busy} onClick={close} data-testid="room-close">
            {confirmClose ? t('room.closeNow') : t('room.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
