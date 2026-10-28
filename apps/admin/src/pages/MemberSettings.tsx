/**
 * A member's account settings on their page (the API's routes/admin-settings.ts): what diagnosing a sync problem needs
 * (revision, epoch, how many settings and favourite tables the account has, when they changed and when the member's
 * devices last synced, the last reset), never the values, and nothing to edit.
 *
 * Resetting puts the synced settings and favourite tables back to the defaults and raises the epoch, so the member's
 * devices drop what they had not saved and none uploads its old settings again. It can be undone for a week while the
 * member changes nothing. Both show their scope first (the server's preview), then take a reason and the password.
 */
import { SETTINGS_RESTORE_MS, SYNCED_PREF_KEYS, type AdminSettingsDiagDto } from '@jc/types';
import { Badge, Button, formatDate, Panel, Stat } from '@jc/ui';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { REASONS } from '../adminTemplates';
import { useT } from '../i18n';
import { ApiError, canDo, errText, useAdmin, useData } from '../lib';
import { AdminReasonField } from '../templateFields';
import { Feedback, LoadError, Modal, PageState, type Note } from '../ui';

type Kind = 'reset' | 'restore';
type ResetPreview = { preview: true; settings: AdminSettingsDiagDto; restorableMs: number };
type RestorePreview = { preview: true; settings: AdminSettingsDiagDto; restore: { fields: number; favourites: number } };
type Preview = ResetPreview | RestorePreview;
/** A refusal that means the settings moved on since the page loaded: the panel shows them as they are now. */
const STALE = ['settings_changed', 'settings_already_reset', 'settings_not_restorable'];
const DAY_MS = 86_400_000;

export function MemberSettingsPanel({ userId }: { userId: string }) {
  const { t, locale } = useT();
  const { api, me } = useAdmin();
  const { data, error, loading, reload } = useData<AdminSettingsDiagDto>(`/api/admin/users/${userId}/settings`);
  const [act, setAct] = useState<Kind | null>(null);
  const [pv, setPv] = useState<{ data: Preview } | { error: unknown } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const seq = useRef(0);
  const title = t('setMemberTitle');
  if (!data) {
    return (
      <Panel title={title}>
        <PageState error={error} onRetry={reload} />
      </Panel>
    );
  }
  const d = data;
  const when = (ms: number | null) => (ms == null ? '—' : formatDate(ms, locale));
  // Not their own, and an administrator's only by a super admin (the server checks both again).
  const canAct = me?.user.id !== userId && (d.member.role === 'user' || canDo(me, 'admins.manage'));
  const restorable = !!d.reset?.restorableUntil;
  const reverted = (e: unknown) => e instanceof ApiError && STALE.includes(e.code);

  const open = async (kind: Kind) => {
    const n = ++seq.current;
    setNote(null);
    setReason('');
    setAct(kind);
    setPv(null);
    try {
      const r = await api<Preview>(`/api/admin/users/${userId}/settings/${kind}`, { body: { preview: true, rev: d.rev } });
      if (seq.current === n) setPv({ data: r });
    } catch (e) {
      if (seq.current !== n) return;
      if (reverted(e)) await reload();
      setPv({ error: e });
    }
  };
  const close = () => {
    seq.current++;
    setAct(null);
    setPv(null);
  };
  const confirm = async () => {
    if (!act || !pv || !('data' in pv)) return;
    setBusy(true);
    try {
      await api(`/api/admin/users/${userId}/settings/${act}`, { body: { reason: reason.trim(), rev: pv.data.settings.rev } });
      setNote({ ok: true, text: t(act === 'reset' ? 'setResetDone' : 'setRestoreDone') });
      close();
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
      close();
      setNote({ ok: false, text: errText(e, t) });
      if (reverted(e)) await reload();
    } finally {
      setBusy(false);
    }
  };

  const r = d.reset;
  const pvData = pv && 'data' in pv ? pv.data : null;
  const scope = pvData && 'restore' in pvData ? pvData.restore : pvData ? { fields: pvData.settings.fields, favourites: pvData.settings.favourites } : null;
  return (
    <Panel title={title}>
      <div className={`flex flex-col gap-4 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} data-testid="member-settings" data-rev={d.rev} data-epoch={d.epoch}>
        {error && <LoadError error={error} onRetry={reload} />}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label={t('setSaved')}
            value={<span className="text-sm break-keep sm:text-base" data-testid="member-settings-state">{d.exists ? t('setRevEpoch', { rev: d.rev, epoch: d.epoch }) : t('setNever')}</span>}
            sub={d.exists ? t('setSchema', { v: d.schemaVersion ?? '—' }) : t('setNeverSub')}
          />
          <Stat
            label={t('setFields')}
            value={<span data-testid="member-settings-fields">{t('setOf', { n: d.fields, of: SYNCED_PREF_KEYS.length })}</span>}
            sub={t('setFavourites', { n: d.favourites })}
          />
          <Stat label={t('setUpdated')} value={<span className="text-base">{when(d.updatedAt)}</span>} />
          <Stat label={t('setSynced')} value={<span className="text-base" data-testid="member-settings-synced">{when(d.syncedAt)}</span>} sub={t('setSyncedSub')} />
        </div>
        <div className="flex flex-col gap-1 rounded-xl border border-white/10 p-3" data-testid="member-settings-last-reset">
          <h3 className="text-sm font-bold">{t('setLastReset')}</h3>
          {r ? (
            <p className="flex flex-wrap items-center gap-2 text-ink-200">
              <span>{when(r.at)}</span>
              <span>· {r.by ? <Link to={`/users/${r.by.id}`} className="text-gold-300 hover:underline">{r.by.nickname ?? r.by.id}</Link> : '—'}</span>
              {r.restoredAt ? (
                <Badge tone="blue">{t('setRestoredAt', { at: when(r.restoredAt) })}</Badge>
              ) : r.restorableUntil ? (
                <Badge tone="gold">{t('setRestorableUntil', { at: when(r.restorableUntil) })}</Badge>
              ) : (
                <Badge>{t('setNotRestorable')}</Badge>
              )}
            </p>
          ) : (
            <p className="text-ink-400">{t('setNoReset')}</p>
          )}
        </div>
        {canAct && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="danger" onClick={() => void open('reset')} data-testid="member-settings-reset">{t('setReset')}</Button>
            {restorable && <Button size="sm" variant="outline" onClick={() => void open('restore')} data-testid="member-settings-restore">{t('setRestore')}</Button>}
          </div>
        )}
        <Feedback note={note} testid="member-settings-feedback" />
        <p className="text-xs text-ink-400">{t('setMemberHint')}</p>
      </div>
      <Modal
        open={act !== null}
        onClose={close}
        title={act === 'restore' ? t('setRestore') : t('setReset')}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
            <Button variant={act === 'restore' ? 'gold' : 'danger'} disabled={!pvData || reason.trim().length < 2} loading={busy} onClick={() => void confirm()} data-testid="settings-act-confirm">
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm" data-testid="settings-act">
          <p className="text-ink-200">{t('setWho', { name: d.member.nickname })}</p>
          {!pv ? (
            <p className="text-ink-400" aria-live="polite">{t('pvLoading')}</p>
          ) : 'error' in pv ? (
            <Feedback note={{ ok: false, text: errText(pv.error, t) }} testid="settings-pv-error" />
          ) : (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink-200" data-testid="settings-pv-scope" data-fields={scope?.fields} data-favourites={scope?.favourites}>
              {act === 'reset' ? (
                <>
                  <li>{scope && scope.fields + scope.favourites > 0 ? t('setPvReset', { f: scope.fields, n: scope.favourites }) : t('setPvResetEmpty')}</li>
                  <li>{t('setPvDevices')}</li>
                  <li>
                    {scope && scope.fields + scope.favourites > 0
                      ? t('setPvUndo', { days: Math.round(('restorableMs' in pv.data ? pv.data.restorableMs : SETTINGS_RESTORE_MS) / DAY_MS) })
                      : t('setPvNoUndo')}
                  </li>
                </>
              ) : (
                <>
                  <li>{t('setPvRestore', { at: when(pv.data.settings.reset?.at ?? null), f: scope?.fields ?? 0, n: scope?.favourites ?? 0 })}</li>
                  <li>{t('setPvDevices')}</li>
                  <li>{t('setPvNoUndoAgain')}</li>
                </>
              )}
              <li>{t('setPvDeviceOnly')}</li>
              <li>{t('setPvNotice')}</li>
            </ul>
          )}
          {pvData && <p className="text-xs text-ink-400">{t('pvBasis')}</p>}
          <AdminReasonField label={t('reasonRequired')} templates={act ? REASONS.settings[act] : []} value={reason} onChange={setReason} maxLength={200} testid="settings-act-reason" />
        </div>
      </Modal>
    </Panel>
  );
}
