/**
 * A member's VIP state on their page (the API's routes/admin-vip.ts): whether they are VIP, their name color, a
 * preview of the name as other players see it, and who changed it last and when (the audit log has the whole history).
 *
 * Making a member VIP (gold unless another color is picked first), changing the color and ending it all show the
 * server's preview first (from → to, the tables where the name redraws), then take a reason and the password. The page
 * sends the version it showed: when another administrator changed it in between, the server refuses and the panel
 * shows the state as it is now, ready to try again. A change another administrator saves while the panel is open is
 * announced (adminChanges.ts) and read only when asked, the color picked and the reason typed kept. Staff, table bots and deleted accounts cannot be made VIP (the
 * server refuses them too); a color such an account still has can be ended.
 */
import { VIP_COLORS, VIP_DEFAULT_COLOR, type AdminVipDto, type AdminVipPreviewDto, type AdminVipResultDto, type VipColor } from '@jc/types';
import { Badge, Button, formatDate, Panel } from '@jc/ui';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useHeardRevision } from '../adminChanges';
import { REASONS } from '../adminTemplates';
import { useT } from '../i18n';
import type { Tr } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { AdminReasonField } from '../templateFields';
import { ChangedNotice, Feedback, jumpTarget, Modal, PageState, type Note } from '../ui';

type Change = { enabled: true; color: VipColor } | { enabled: false };

/** The reasons that fit the change: making a member VIP, changing the color of one, or ending it. */
const vipReasons = (c: Change | null, isVip: boolean) => {
  const give = c?.enabled === true;
  const fits: Record<string, boolean> = { 'vip.assign': give && !isVip, 'vip.color': give && isVip, 'vip.event': give, 'vip.remove': c?.enabled === false };
  return REASONS.vip.filter((x) => fits[x.id] ?? true);
};
type Kind = 'assign' | 'color' | 'remove';
const kindOf = (from: VipColor | null, c: Change): Kind => (!c.enabled ? 'remove' : from === null ? 'assign' : 'color');
export const vipColorLabel = (t: Tr, c: VipColor | null) => (c ? t(`vipColor_${c}`) : t('vipNone'));

/** The VIP pill as the web app draws it (gold on near-black, a thin gold rim, a small diamond). */
function VipPill() {
  return (
    <span className="jc-vip-badge" data-testid="vip-pill">
      <svg viewBox="0 0 10 10" aria-hidden className="size-[0.85em] shrink-0">
        <path d="M5 .6 9.4 4 5 9.4.6 4Z" fill="currentColor" />
      </svg>
      VIP
    </span>
  );
}

/** A name in a VIP color with the pill, or plain (no color) for a regular member. */
export function VipName({ name, color }: { name: string; color: VipColor | null }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" data-testid="vip-name" data-vip={color ?? undefined}>
      <span className={color ? 'jc-vip-name min-w-0 truncate font-semibold' : 'min-w-0 truncate font-semibold'} data-vip={color ?? undefined}>{name}</span>
      {color && <VipPill />}
    </span>
  );
}

export function MemberVipPanel({ userId, onChanged }: { userId: string; onChanged?: () => void }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, error, loading, reload, setData } = useData<AdminVipDto>(`/api/admin/users/${userId}/vip`);
  // The color picked on the panel; null until the administrator picks one (the member's own color, or gold).
  const [pick, setPick] = useState<VipColor | null>(null);
  const [act, setAct] = useState<Change | null>(null);
  const [pv, setPv] = useState<{ data: AdminVipPreviewDto } | { error: unknown } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const seq = useRef(0);
  const [reading, setReading] = useState(false);
  const heard = useHeardRevision(userId, (e) => e.type === 'admin.monitor.changed' && e.kind === 'vip' && e.resourceId === userId);
  const title = t('vipTitle');
  if (!data) {
    return (
      <Panel title={title}>
        <PageState error={error} onRetry={reload} />
      </Panel>
    );
  }
  const d = data;
  const shownPick = pick ?? d.color ?? VIP_DEFAULT_COLOR;
  // Ending a color is always allowed; giving or changing one only to an account that may carry it (the server checks).
  const mayGive = d.ineligible === null;
  const conflict = (e: unknown) => e instanceof ApiError && e.code === 'vip_conflict';
  const url = `/api/admin/users/${userId}/vip`;

  const open = async (c: Change, version = d.version, keepReason = false) => {
    const n = ++seq.current;
    setNote(null);
    if (!keepReason) setReason('');
    setAct(c);
    setPv(null);
    try {
      const r = await api<AdminVipPreviewDto>(url, { method: 'PATCH', body: { ...c, expectedVersion: version, preview: true } });
      if (seq.current === n) setPv({ data: r });
    } catch (e) {
      if (seq.current !== n) return;
      setPv({ error: e });
      if (conflict(e)) {
        setPick(null);
        await reload();
      }
    }
  };
  const close = () => {
    seq.current++;
    setAct(null);
    setPv(null);
  };
  // Another administrator changed it since it was shown: read it again and, with the modal open, redo its preview from
  // that (the color picked and the reason typed stay).
  const again = async () => {
    const c = act;
    const n = seq.current;
    setReading(true);
    try {
      const fresh = await api<AdminVipDto>(url);
      setData(fresh);
      if (c && seq.current === n) await open(c, fresh.version, true);
    } catch (e) {
      setNote({ ok: false, text: errText(e, t) });
    } finally {
      setReading(false);
    }
  };
  const stale = heard !== null && heard > d.version && !busy;
  const confirm = async () => {
    if (!act || !pv || !('data' in pv)) return;
    setBusy(true);
    try {
      const r = await api<AdminVipResultDto>(url, { method: 'PATCH', body: { ...act, reason: reason.trim(), expectedVersion: d.version } });
      const text = r.changed
        ? [t('vipDone', { v: r.vip.version }), r.tables > 0 ? t('vipDoneTables', { n: r.tables, m: r.reached }) : null].filter(Boolean).join(' ')
        : t('vipPvNoChange');
      setNote({ ok: true, text });
      close();
      setPick(null);
      await reload();
      if (r.changed) onChanged?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
      close();
      // Someone else changed it first: the panel shows the state as it is now, and the administrator can try again.
      setNote({ ok: false, text: conflict(e) ? t('vipConflict') : errText(e, t) });
      if (e instanceof ApiError) {
        setPick(null);
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const pvData = pv && 'data' in pv ? pv.data : null;
  const kind = act ? kindOf(d.color, act) : null;
  return (
    <Panel title={title} id="member-vip" className={jumpTarget}>
      <div className={`flex flex-col gap-4 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`} data-testid="member-vip" data-vip={d.color ?? ''} data-version={d.version}>
        {error && <Feedback note={{ ok: false, text: errText(error, t) }} />}
        {stale && act === null && <ChangedNotice onRefresh={() => void again()} busy={reading} testid="vip-changed" />}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-400">{t('vipState')}</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2" data-testid="vip-state">
              {d.color ? <Badge tone="gold">{t('vipOn')}</Badge> : <Badge>{t('vipOff')}</Badge>}
              {d.color && <span className="text-ink-300">{vipColorLabel(t, d.color)}</span>}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-ink-400">{t('vipNamePreview')}</dt>
            <dd className="mt-1 min-w-0" data-testid="vip-current-name">
              <VipName name={d.member.nickname} color={d.color} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">{t('vipLastChange')}</dt>
            <dd className="mt-1 text-ink-200" data-testid="vip-last-change">
              {d.changedAt ? (
                <>
                  {formatDate(d.changedAt, locale)}
                  {' · '}
                  {d.changedBy ? <Link to={`/users/${d.changedBy.id}`} className="text-gold-300 hover:underline">{d.changedBy.nickname ?? d.changedBy.id}</Link> : '—'}
                  <span className="ml-1 font-mono text-xs text-ink-400">{t('vipVersion', { v: d.version })}</span>
                </>
              ) : (
                <span className="text-ink-400">{t('vipNeverChanged')}</span>
              )}
            </dd>
          </div>
        </dl>
        {d.ineligible && (
          <p className="text-ink-300" data-testid="vip-ineligible" data-reason={d.ineligible}>
            {t(`vipIneligible_${d.ineligible}`)} {d.color && t('vipIneligibleClear')}
          </p>
        )}
        {mayGive && d.member.status === 'suspended' && <p className="text-ink-300" data-testid="vip-suspended">{t('vipSuspendedHidden')}</p>}
        {mayGive && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs text-ink-400">{d.color ? t('vipColorLabel') : t('vipPickColor')}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('vipColorLabel')}>
              {VIP_COLORS.map((c) => (
                <label
                  key={c}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${shownPick === c ? 'border-gold-500/60 bg-gold-500/5' : 'border-white/10'}`}
                  data-testid={`vip-color-${c}`}
                >
                  <input type="radio" name={`vip-color-${userId}`} className="size-4 shrink-0 accent-gold-500" checked={shownPick === c} onChange={() => setPick(c)} />
                  <span className="min-w-0">
                    <span className="block text-xs text-ink-300">{vipColorLabel(t, c)}{d.color === c ? ` · ${t('vipState')}` : ''}</span>
                    <span className="jc-vip-name block truncate font-semibold" data-vip={c}>{d.member.nickname}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2" data-testid="vip-pick-preview">
              <span className="text-xs text-ink-400">{t('vipNamePreview')}:</span>
              <VipName name={d.member.nickname} color={shownPick} />
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap gap-2">
          {mayGive && !d.color && (
            <Button size="sm" variant="gold" onClick={() => void open({ enabled: true, color: shownPick })} data-testid="vip-assign">{t('vipAssign')}</Button>
          )}
          {mayGive && d.color && (
            <Button size="sm" variant="outline" disabled={shownPick === d.color} onClick={() => void open({ enabled: true, color: shownPick })} data-testid="vip-change-color">
              {t('vipChangeColor')}
            </Button>
          )}
          {d.color && <Button size="sm" variant="danger" onClick={() => void open({ enabled: false })} data-testid="vip-remove">{t('vipRemove')}</Button>}
        </div>
        <Feedback note={note} testid="member-vip-feedback" />
        <p className="text-xs text-ink-400">{t('vipHint')}</p>
      </div>
      <Modal
        open={act !== null}
        onClose={close}
        title={kind === 'remove' ? t('vipRemove') : kind === 'color' ? t('vipChangeColor') : t('vipAssign')}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
            <Button
              variant={kind === 'remove' ? 'danger' : 'gold'}
              disabled={stale || !pvData || !pvData.changed || reason.trim().length < 2}
              loading={busy}
              onClick={() => void confirm()}
              data-testid="vip-confirm"
            >
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm" data-testid="vip-act" data-kind={kind ?? undefined}>
          {stale && <ChangedNotice onRefresh={() => void again()} busy={reading} testid="vip-changed-modal" />}
          <p className="text-ink-200">{kind && t(`vipConfirm_${kind}`, { name: d.member.nickname })}</p>
          {!pv ? (
            <p className="text-ink-400" aria-live="polite">{t('pvLoading')}</p>
          ) : 'error' in pv ? (
            <Feedback note={{ ok: false, text: conflict(pv.error) ? t('vipConflict') : errText(pv.error, t) }} testid="vip-pv-error" />
          ) : (
            <>
              <p className="font-semibold" data-testid="vip-pv-change" data-from={pv.data.from ?? ''} data-to={pv.data.to ?? ''}>
                <span className="font-normal text-ink-400">{t('changeLine')}:</span> {t('histChange', { from: vipColorLabel(t, pv.data.from), to: vipColorLabel(t, pv.data.to) })}
              </p>
              <div className="flex flex-wrap items-center gap-2" data-testid="vip-pv-name">
                <VipName name={d.member.nickname} color={pv.data.from} />
                <span aria-hidden className="text-ink-400">→</span>
                <VipName name={d.member.nickname} color={pv.data.to} />
              </div>
              {!pv.data.changed ? (
                <p className="text-danger" role="alert">{t('vipPvNoChange')}</p>
              ) : (
                <p className="text-ink-300" data-testid="vip-pv-tables" data-tables={pv.data.tables}>
                  {pv.data.tables > 0 ? t('vipPvTables', { n: pv.data.tables }) : t('vipPvNoTables')}
                </p>
              )}
              <p className="text-xs text-ink-400">{t('vipHint')}</p>
              <p className="text-xs text-ink-400">{t('pvBasis')}</p>
            </>
          )}
          <AdminReasonField label={t('reasonRequired')} templates={vipReasons(act, d.color !== null)} value={reason} onChange={setReason} maxLength={200} testid="vip-reason" />
        </div>
      </Modal>
    </Panel>
  );
}
