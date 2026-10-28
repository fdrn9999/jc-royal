import { Badge, Button, Empty, Field, formatDate, Input, Panel } from '@jc/ui';
import type { NoticeKind } from '@jc/types';
import { useState } from 'react';
import { Link } from 'react-router';
import { byKind, MAINTENANCE_TEMPLATES, maintenanceVars, NOTICE_TEMPLATES, REASONS } from '../adminTemplates';
import { useT } from '../i18n';
import { maintStateLabel, noticeKindLabel, noticeStateLabel } from '../labels';
import { ApiError, errText, hasGrant, useAdmin, useData } from '../lib';
import { AdminReasonField, ContentTemplateFields, TemplateMissing, TemplatePreview, useContentTemplate } from '../templateFields';
import { Feedback, LoadError, Modal, type Note } from '../ui';

interface NoticeRow {
  id: string;
  kind: NoticeKind;
  titleKo: string;
  titleEn: string;
  bodyKo: string | null;
  bodyEn: string | null;
  startsAt: number;
  endsAt: number | null;
  postId: string | null;
  author: string | null;
  state: 'live' | 'scheduled' | 'ended' | 'deleted';
}
interface WindowRow {
  id: string;
  startsAt: number;
  endsAt: number;
  blockLogin: boolean;
  messageKo: string | null;
  messageEn: string | null;
  author: string | null;
  endedAt: number | null;
  cancelledAt: number | null;
  state: 'active' | 'scheduled' | 'finished' | 'ended_early' | 'cancelled';
}
interface RoomFanOut { tables: number; reached: number; unreached: string[]; truncated: boolean }

const PAGE = 30;
const textarea = 'w-full rounded-lg border border-white/10 bg-ink-850 p-3 text-sm';
const select = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3';
const tz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
})();

/** epoch ms ↔ the value of a datetime-local input, both in this device's time zone. */
function toInput(ms: number | null | undefined) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromInput(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Where a change reached the tables (rooms not reached take it on at their next hand record or at the window's edges). */
function fanOutText(t: ReturnType<typeof useT>['t'], r: RoomFanOut) {
  const parts = [t('maintRooms', { reached: r.reached, tables: r.tables })];
  if (r.unreached.length) parts.push(t('maintUnreached', { n: r.unreached.length }));
  if (r.truncated) parts.push(t('maintTruncated'));
  return parts.join(' ');
}

// ------------------------------------------------------------------ maintenance
interface MaintForm { id?: string; started: boolean; start: string; end: string; blockLogin: boolean; messageKo: string; messageEn: string; reason: string }

function MaintenancePanel() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, error, reload } = useData<{ now: number; tables: { playing: number; withSeats: number; players: number }; items: WindowRow[] }>('/api/admin/service/maintenance?limit=20');
  const [form, setForm] = useState<MaintForm | null>(null);
  const [confirm, setConfirm] = useState<'save' | 'stop' | null>(null);
  const [stopReason, setStopReason] = useState('');
  const [msg, setMsg] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const current = data?.items.find((w) => w.state === 'active' || w.state === 'scheduled') ?? null;
  const past = data?.items.filter((w) => w !== current) ?? [];
  const time = (ms: number) => formatDate(ms, locale);

  const blank = (): MaintForm => ({ started: false, start: '', end: toInput(Date.now() + 3600_000), blockLogin: false, messageKo: '', messageEn: '', reason: '' });
  const fromWindow = (w: WindowRow): MaintForm => ({ id: w.id, started: w.state === 'active', start: toInput(w.startsAt), end: toInput(w.endsAt), blockLogin: w.blockLogin, messageKo: w.messageKo ?? '', messageEn: w.messageEn ?? '', reason: '' });
  const startMs = form ? (form.started ? null : (fromInput(form.start) ?? Date.now())) : null;
  const endMs = form ? fromInput(form.end) : null;
  // The member message's times come from the form (a window under way keeps its start); the template writes nothing else.
  const tpl = useContentTemplate({
    templates: MAINTENANCE_TEMPLATES,
    values: { bodyKo: form?.messageKo ?? '', bodyEn: form?.messageEn ?? '' },
    apply: (patch) => setForm((f) => f && { ...f, messageKo: patch.bodyKo ?? f.messageKo, messageEn: patch.bodyEn ?? f.messageEn }),
    auto: maintenanceVars(form ? (startMs ?? fromInput(form.start)) : null, endMs),
  });
  const edit = (f: MaintForm) => {
    tpl.reset();
    setForm(f);
  };
  const formOk = !!form && endMs !== null && endMs > Date.now() && endMs > (startMs ?? 0) && form.reason.trim().length >= 2 && !tpl.missing.length;

  async function run(fn: () => Promise<{ rooms: RoomFanOut }>, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: true, text: `${done} ${fanOutText(t, r.rooms)}` });
      setForm(null);
      setStopReason('');
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setMsg({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
      setConfirm(null);
      await reload();
    }
  }
  const save = () =>
    form &&
    run(
      () => {
        const body = { endsAt: endMs!, blockLogin: form.blockLogin, messageKo: form.messageKo, messageEn: form.messageEn, reason: form.reason };
        return form.id
          ? api(`/api/admin/service/maintenance/${form.id}`, { method: 'PATCH', body: form.started ? body : { ...body, startsAt: startMs! } })
          : api('/api/admin/service/maintenance', { body: { ...body, startsAt: startMs! } });
      },
      t('saved'),
    );
  const stop = () => current && run(() => api(`/api/admin/service/maintenance/${current.id}/stop`, { body: { reason: stopReason } }), t('saved'));

  return (
    <Panel title={t('maintTitle')}>
      <div className="flex flex-col gap-4 text-sm" data-testid="maintenance-panel">
        {error && <LoadError error={error} onRetry={reload} />}
        {data && <p className="text-ink-300" data-testid="maint-live">{t('maintLive', data.tables)}</p>}
        <Feedback note={msg} testid="maint-msg" />
        {!data ? (
          <Empty>{t('loading')}</Empty>
        ) : current ? (
          <div className="rounded-lg border border-gold-500/30 bg-gold-500/5 p-3" data-testid="maint-current">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={current.state === 'active' ? 'red' : 'gold'}>{maintStateLabel(t, current.state)}</Badge>
              <span className="font-mono tabular-nums">{time(current.startsAt)} – {time(current.endsAt)}</span>
              {current.blockLogin && <Badge tone="red">{t('maintBlockLoginOn')}</Badge>}
              <span className="text-xs text-ink-400">{current.author ?? '—'}</span>
            </div>
            {(current.messageKo || current.messageEn) && (
              <dl className="mt-2 grid gap-1 text-xs text-ink-200">
                {current.messageKo && <div><dt className="inline text-ink-400">KO </dt><dd className="inline whitespace-pre-line">{current.messageKo}</dd></div>}
                {current.messageEn && <div><dt className="inline text-ink-400">EN </dt><dd className="inline whitespace-pre-line">{current.messageEn}</dd></div>}
              </dl>
            )}
            {!form && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => edit(fromWindow(current))} data-testid="maint-edit">{t('maintEdit')}</Button>
                </div>
                <AdminReasonField
                  label={t('reasonRequired')}
                  templates={current.state === 'active' ? REASONS.maintenance.end : REASONS.maintenance.cancel}
                  value={stopReason}
                  onChange={setStopReason}
                  maxLength={200}
                  testid="maint-stop-reason"
                />
                <p className="text-xs text-ink-400" data-testid="maint-stop-note">{t(current.state === 'active' ? 'maintStopNote' : 'maintCancelNote')}</p>
                <Button variant="danger" disabled={stopReason.trim().length < 2 || busy} onClick={() => setConfirm('stop')} data-testid="maint-stop">
                  {current.state === 'active' ? t('maintStop') : t('maintCancel')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          !form && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-ink-300">{t('maintNone')}</span>
              <Button onClick={() => edit(blank())} data-testid="maint-new">{t('maintSchedule')}</Button>
            </div>
          )
        )}
        {form && (
          <div className="flex flex-col gap-3 rounded-lg border border-white/10 p-3" data-testid="maint-form">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('maintStart')} hint={form.started ? t('maintStartFixed') : undefined}>
                {(fid) => <Input id={fid} type="datetime-local" value={form.start} disabled={form.started} onChange={(e) => setForm({ ...form, start: e.target.value })} data-testid="maint-start" />}
              </Field>
              <Field label={t('maintEnd')}>{(fid) => <Input id={fid} type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} data-testid="maint-end" />}</Field>
            </div>
            <p className="text-xs text-ink-400">{t('timeHintMaint', { tz })}</p>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={form.blockLogin} onChange={(e) => setForm({ ...form, blockLogin: e.target.checked })} data-testid="maint-block-login" />
              <span>{t('maintBlockLogin')}</span>
            </label>
            <p className="text-xs text-ink-400">{t('maintTplNote')}</p>
            <ContentTemplateFields tpl={tpl} testid="maint-tpl" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('maintMsgKo')}>{(fid) => <textarea id={fid} rows={6} maxLength={2000} value={form.messageKo} onChange={(e) => setForm({ ...form, messageKo: e.target.value })} className={textarea} data-testid="maint-msg-ko" />}</Field>
              <Field label={t('maintMsgEn')}>{(fid) => <textarea id={fid} rows={6} maxLength={2000} value={form.messageEn} onChange={(e) => setForm({ ...form, messageEn: e.target.value })} className={textarea} data-testid="maint-msg-en" />}</Field>
            </div>
            <TemplatePreview
              testid="maint-preview"
              items={[
                { label: t('langKo'), body: form.messageKo },
                { label: t('langEn'), body: form.messageEn },
              ]}
            />
            <AdminReasonField
              label={t('reasonRequired')}
              templates={form.id ? REASONS.maintenance.change : REASONS.maintenance.schedule}
              value={form.reason}
              onChange={(v) => setForm((f) => f && { ...f, reason: v })}
              maxLength={200}
              testid="maint-reason"
            />
            {endMs !== null && endMs <= (startMs ?? Date.now()) && <p className="text-xs text-danger">{t('errMaintEnd')}</p>}
            <TemplateMissing tpl={tpl} testid="maint-missing" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setForm(null)}>{t('cancel')}</Button>
              <Button disabled={!formOk || busy} onClick={() => setConfirm('save')} data-testid="maint-save">{form.id ? t('maintEdit') : t('maintSchedule')}</Button>
            </div>
          </div>
        )}
        <ul className="list-disc space-y-1 pl-4 text-xs text-ink-400">
          <li>{t('maintRule1')}</li>
          <li>{t('maintRule2')}</li>
          <li>{t('maintRule3')}</li>
        </ul>
        {past.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold text-ink-300">{t('maintHistory')}</h3>
            <ul className="divide-y divide-white/5 text-xs">
              {past.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <Badge>{maintStateLabel(t, w.state)}</Badge>
                  <span className="font-mono tabular-nums">{time(w.startsAt)} – {time(w.endedAt ?? w.endsAt)}</span>
                  {w.blockLogin && <span className="text-ink-400">{t('maintBlockLoginOn')}</span>}
                  <span className="text-ink-400">{w.author ?? '—'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'stop' ? (current?.state === 'active' ? t('maintStop') : t('maintCancel')) : form?.id ? t('maintEdit') : t('maintSchedule')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('cancel')}</Button>
            <Button variant="danger" disabled={busy} onClick={() => void (confirm === 'stop' ? stop() : save())} data-testid="maint-confirm">{t('confirm')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          {confirm === 'stop' ? (
            <p>{current?.state === 'active' ? t('maintConfirmStop') : t('maintConfirmCancel')}</p>
          ) : (
            form && endMs !== null && (
              <>
                <p>{t('maintConfirmSave', { start: time(startMs ?? Date.now()), end: time(endMs) })}</p>
                {form.blockLogin && <p className="text-danger">{t('maintConfirmLogin')}</p>}
              </>
            )
          )}
          {data && <p className="text-ink-300">{t('maintLive', data.tables)}</p>}
          <p className="break-all text-ink-300">{t('reason')}: {confirm === 'stop' ? stopReason : form?.reason}</p>
        </div>
      </Modal>
    </Panel>
  );
}

// ------------------------------------------------------------------ notices
interface NoticeForm {
  id?: string;
  kind: NoticeKind;
  titleKo: string;
  titleEn: string;
  bodyKo: string;
  bodyEn: string;
  start: string;
  end: string;
  postToBoard: boolean;
  sendInbox: boolean;
}

function NoticesPanel() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) q.set('status', status);
  const { data, error, reload, loading } = useData<{ now: number; items: NoticeRow[] }>(`/api/admin/service/notices?${q}`);
  const [form, setForm] = useState<NoticeForm | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'inbox' | 'delete'; row?: NoticeRow } | null>(null);
  const [msg, setMsg] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const time = (ms: number) => formatDate(ms, locale);

  const blank = (): NoticeForm => ({ kind: 'general', titleKo: '', titleEn: '', bodyKo: '', bodyEn: '', start: '', end: '', postToBoard: false, sendInbox: false });
  const fromRow = (n: NoticeRow): NoticeForm => ({ id: n.id, kind: n.kind, titleKo: n.titleKo, titleEn: n.titleEn, bodyKo: n.bodyKo ?? '', bodyEn: n.bodyEn ?? '', start: toInput(n.startsAt), end: toInput(n.endsAt), postToBoard: false, sendInbox: false });
  const tpl = useContentTemplate({
    templates: byKind(NOTICE_TEMPLATES, form?.kind ?? 'general', { suited: t('tplSuited'), others: t('tplOthers') }),
    values: { titleKo: form?.titleKo ?? '', titleEn: form?.titleEn ?? '', bodyKo: form?.bodyKo ?? '', bodyEn: form?.bodyEn ?? '' },
    apply: (patch) => setForm((f) => f && { ...f, ...patch }),
  });
  const open = (f: NoticeForm) => {
    tpl.reset();
    setForm(f);
  };
  const titlesOk = !!form && form.titleKo.trim().length >= 2 && form.titleEn.trim().length >= 2;
  const endMs = form ? fromInput(form.end) : null;
  const startMs = form ? fromInput(form.start) : null;
  const windowOk = endMs === null || (endMs > Date.now() && endMs > (startMs ?? Date.now()));
  // A board post and inbox messages go out on saving, not at the start: said plainly when the start is later.
  const later = !form?.id && startMs !== null && startMs > Date.now() && (form?.postToBoard || form?.sendInbox);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      await reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setMsg({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  const save = () =>
    form &&
    !tpl.missing.length &&
    act(async () => {
      const body = { kind: form.kind, titleKo: form.titleKo, titleEn: form.titleEn, bodyKo: form.bodyKo, bodyEn: form.bodyEn, endsAt: endMs };
      if (form.id) {
        await api(`/api/admin/service/notices/${form.id}`, { method: 'PATCH', body: startMs === null ? body : { ...body, startsAt: startMs } });
        setForm(null);
        return t('saved');
      }
      const r = await api<{ sent: number }>('/api/admin/service/notices', { body: { ...body, startsAt: startMs ?? undefined, postToBoard: form.postToBoard, sendInbox: form.sendInbox } });
      setForm(null);
      return form.sendInbox ? `${t('saved')} ${t('sentTo', { n: r.sent })}` : t('saved');
    });

  return (
    <Panel
      title={t('noticesTitle')}
      actions={<Button size="sm" onClick={() => open(blank())} data-testid="notice-new">{t('noticeNew')}</Button>}
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="notices-panel">
        <div className="flex flex-wrap items-center gap-2">
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} className={`${select} h-10 text-sm`} aria-label={t('status')}>
            <option value="">{t('statusAll')}</option>
            <option value="live">{noticeStateLabel(t, 'live')}</option>
            <option value="scheduled">{noticeStateLabel(t, 'scheduled')}</option>
            <option value="ended">{noticeStateLabel(t, 'ended')}</option>
            <option value="deleted">{noticeStateLabel(t, 'deleted')}</option>
          </select>
          {loading && <span className="text-xs text-ink-400">{t('loading')}</span>}
        </div>
        {error && <LoadError error={error} onRetry={reload} />}
        <Feedback note={msg} testid="notice-msg" />
        {data && data.items.length === 0 ? (
          <Empty>{t('noticesEmpty')}</Empty>
        ) : (
          <ul className="divide-y divide-white/5">
            {data?.items.map((n) => (
              <li key={n.id} className="flex flex-col gap-1 py-2.5" data-testid="notice-row">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={n.kind === 'urgent' ? 'red' : n.kind === 'maintenance' ? 'gold' : 'neutral'}>{noticeKindLabel(t, n.kind)}</Badge>
                  <Badge tone={n.state === 'live' ? 'green' : n.state === 'scheduled' ? 'blue' : 'neutral'}>{noticeStateLabel(t, n.state)}</Badge>
                  <span className="min-w-0 flex-1 truncate font-semibold">{n.titleKo}</span>
                </div>
                <span className="truncate text-xs text-ink-300">EN · {n.titleEn}</span>
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                  <span className="font-mono tabular-nums">{time(n.startsAt)} – {n.endsAt ? time(n.endsAt) : t('untilEnded')}</span>
                  <span>{n.author ?? '—'}</span>
                  {n.postId && <span>{t('noticeOnBoard')}</span>}
                  <span className="ml-auto flex flex-wrap gap-1.5">
                    {n.state !== 'deleted' && n.state !== 'ended' && <Button size="sm" variant="subtle" onClick={() => open(fromRow(n))}>{t('edit')}</Button>}
                    {(n.state === 'live' || n.state === 'scheduled') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => (await api(`/api/admin/service/notices/${n.id}/end`, { body: {} }), t('saved')))} data-testid="notice-end">{t('noticeEnd')}</Button>}
                    {n.state !== 'deleted' && <Button size="sm" variant="danger" onClick={() => setConfirm({ kind: 'delete', row: n })}>{t('delete')}</Button>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data && (offset > 0 || data.items.length === PAGE) && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('prevPage')}</Button>
            <Button size="sm" variant="outline" disabled={data.items.length < PAGE || loading} onClick={() => setOffset(offset + PAGE)}>{t('nextPage')}</Button>
          </div>
        )}
      </div>
      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? t('noticeEdit') : t('noticeNew')}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(null)}>{t('cancel')}</Button>
            <Button disabled={!titlesOk || !windowOk || tpl.missing.length > 0 || busy} onClick={() => (form?.sendInbox ? setConfirm({ kind: 'inbox' }) : void save())} data-testid="notice-save">{t('save')}</Button>
          </>
        }
      >
        {form && (
          <div className="flex flex-col gap-3 text-sm" data-testid="notice-form">
            <Field label={t('noticeKind')}>
              {(fid) => (
                <select id={fid} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as NoticeKind })} className={select} data-testid="notice-kind">
                  <option value="general">{noticeKindLabel(t, 'general')}</option>
                  <option value="urgent">{noticeKindLabel(t, 'urgent')}</option>
                  <option value="maintenance">{noticeKindLabel(t, 'maintenance')}</option>
                </select>
              )}
            </Field>
            <ContentTemplateFields tpl={tpl} testid="notice-tpl" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('noticeTitleKo')}>{(fid) => <Input id={fid} value={form.titleKo} maxLength={100} onChange={(e) => setForm({ ...form, titleKo: e.target.value })} data-testid="notice-title-ko" />}</Field>
              <Field label={t('noticeTitleEn')}>{(fid) => <Input id={fid} value={form.titleEn} maxLength={100} onChange={(e) => setForm({ ...form, titleEn: e.target.value })} data-testid="notice-title-en" />}</Field>
              <Field label={t('noticeBodyKo')}>{(fid) => <textarea id={fid} rows={6} maxLength={2000} value={form.bodyKo} onChange={(e) => setForm({ ...form, bodyKo: e.target.value })} className={textarea} data-testid="notice-body-ko" />}</Field>
              <Field label={t('noticeBodyEn')}>{(fid) => <textarea id={fid} rows={6} maxLength={2000} value={form.bodyEn} onChange={(e) => setForm({ ...form, bodyEn: e.target.value })} className={textarea} data-testid="notice-body-en" />}</Field>
            </div>
            <TemplatePreview
              testid="notice-preview"
              items={[
                { label: t('langKo'), title: form.titleKo, body: form.bodyKo },
                { label: t('langEn'), title: form.titleEn, body: form.bodyEn },
              ]}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('noticeStarts')}>{(fid) => <Input id={fid} type="datetime-local" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} data-testid="notice-start" />}</Field>
              <Field label={t('noticeEnds')}>{(fid) => <Input id={fid} type="datetime-local" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} data-testid="notice-end-at" />}</Field>
            </div>
            <p className="text-xs text-ink-400">{t('timeHintNotice', { tz })}</p>
            {!windowOk && <p className="text-xs text-danger">{t('errNoticeEnd')}</p>}
            {form.id ? (
              <p className="text-xs text-ink-400">{t('noticeEditHint')}</p>
            ) : (
              <>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={form.postToBoard} onChange={(e) => setForm({ ...form, postToBoard: e.target.checked })} data-testid="notice-board" />
                  <span className="flex flex-col gap-0.5">
                    <span>{t('noticeBoard')}</span>
                    <span className="text-xs text-ink-400">{t('noticeBoardWhen')}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={form.sendInbox} onChange={(e) => setForm({ ...form, sendInbox: e.target.checked })} data-testid="notice-inbox" />
                  <span className="flex flex-col gap-0.5">
                    <span>{t('noticeInbox')}</span>
                    <span className="text-xs text-ink-400">{t('noticeInboxWhen')}</span>
                  </span>
                </label>
                {later && startMs !== null && (
                  <p className="rounded-lg border border-gold-500/40 bg-gold-500/10 p-3 text-xs text-gold-200" data-testid="notice-later-warn">
                    {t('noticeLaterWarn', { at: time(startMs) })}
                  </p>
                )}
              </>
            )}
            <TemplateMissing tpl={tpl} testid="notice-missing" />
          </div>
        )}
      </Modal>
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'delete' ? t('delete') : t('noticeNew')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t('cancel')}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const row = confirm?.row;
                if (confirm?.kind === 'delete' && row) void act(async () => (await api(`/api/admin/service/notices/${row.id}`, { method: 'DELETE' }), t('saved')));
                else void save();
              }}
              data-testid="notice-confirm"
            >
              {t('confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirm?.kind === 'delete' ? t('noticeDeleteConfirm', { title: confirm.row?.titleKo ?? '' }) : t('noticeInboxConfirm')}</p>
        {confirm?.kind === 'inbox' && later && startMs !== null && <p className="mt-2 text-sm text-gold-200">{t('noticeLaterWarn', { at: time(startMs) })}</p>}
      </Modal>
    </Panel>
  );
}

export function ServicePage() {
  const { t } = useT();
  const { me } = useAdmin();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{t('service')}</h1>
        {/* The brand check goes with maintenance (the API's permission table): a notices-only administrator is not sent to a refusal. */}
        {hasGrant(me, 'maintenance') && <Link to="/service/brand" className="text-sm text-gold-300 hover:underline" data-testid="brand-link">{t('brManage')} →</Link>}
      </div>
      <p className="text-xs text-ink-400">{t('serviceHint')}</p>
      <MaintenancePanel />
      <NoticesPanel />
    </div>
  );
}
