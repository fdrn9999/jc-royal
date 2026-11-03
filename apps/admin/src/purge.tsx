/**
 * 영구 삭제 (the API's lib/purge.ts; docs/ADMIN_SECURITY.md "영구 삭제") for the three kinds that offer it: a board
 * post, a closed table at which nothing happened, an archived template no tournament was opened from. A step of its own
 * after the ordinary delete, in red: the server's plan first (what goes, what stays, what stops it and what to do
 * instead), then a reason and the target's short id typed by hand; the password is asked when it is sent (lib.tsx).
 * What is shown is what the server decided: a target that changed meanwhile is shown again as it is now, one that
 * cannot go says why and offers no way to send it.
 */
import { Button, Input, TriangleAlertIcon } from '@jc/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { REASONS } from './adminTemplates';
import { useT, type Key } from './i18n';
import type { Tr } from './labels';
import { ApiError, errText, useAdmin } from './lib';
import { AdminReasonField } from './templateFields';
import { Modal, type Note } from './ui';

export type PurgeKind = 'post' | 'table' | 'tournament_template';

interface PurgeBlocker {
  code: string;
  count: number;
}

interface PurgePlan {
  kind: PurgeKind;
  id: string;
  label: string;
  deletable: boolean;
  blockers: PurgeBlocker[];
  removes: Record<string, number>;
  keeps: Record<string, number>;
  fingerprint: string;
  confirmText: string;
}

const PATH: Record<PurgeKind, string> = { post: 'board/posts', table: 'tables', tournament_template: 'tournament-templates' };
const KIND: Record<PurgeKind, Key> = { post: 'targetPost', table: 'targetTable', tournament_template: 'targetTournamentTemplate' };
/** What each blocker is, with what to do instead. */
const BLOCKER: Record<string, Key> = {
  open_reports: 'purgeBlkOpenReports',
  live_notice: 'purgeBlkLiveNotice',
  not_closed: 'purgeBlkNotClosed',
  tournament_table: 'purgeBlkTournamentTable',
  hands: 'purgeBlkHands',
  sessions: 'purgeBlkSessions',
  ledger: 'purgeBlkLedger',
  invites: 'purgeBlkInvites',
  tournaments: 'purgeBlkTournaments',
  open_alerts: 'purgeBlkOpenAlerts',
  occupied: 'purgeBlkOccupied',
  room_unreachable: 'purgeBlkRoomUnreachable',
  room_seated: 'purgeBlkRoomSeated',
  room_connections: 'purgeBlkRoomConnections',
  room_hand: 'purgeBlkRoomHand',
  not_archived: 'purgeBlkNotArchived',
};
/** A template's tournaments block it with their own words: a table's tournaments are a different record. */
const blockerKey = (kind: PurgeKind, code: string): Key | null => (kind === 'tournament_template' && code === 'tournaments' ? 'purgeBlkTplUsed' : (BLOCKER[code] ?? null));
const ROWS: Record<string, Key> = {
  comments: 'purgeRowComments',
  post_hands: 'purgeRowPostHands',
  posts: 'purgeRowPosts',
  tables: 'purgeRowTables',
  tournament_templates: 'purgeRowTemplates',
  reports: 'purgeRowReports',
  service_notices: 'purgeRowNotices',
  admin_audit_log: 'purgeRowAudit',
  ops_events: 'purgeRowOpsEvents',
  ops_alerts: 'purgeRowOpsAlerts',
  bot_events: 'purgeRowBotEvents',
};
const rows = (t: Tr, list: Record<string, number>) =>
  Object.entries(list)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => t('purgeRowN', { what: ROWS[k] ? t(ROWS[k]) : k, n }))
    .join(' · ') || t('none');

export function PurgeDialog({ kind, id, onClose, onDone }: { kind: PurgeKind; id: string; onClose: () => void; onDone: (n: Note) => void | Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const [plan, setPlan] = useState<PurgePlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [changed, setChanged] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const confirmId = useId();
  const path = `/api/admin/${PATH[kind]}/${encodeURIComponent(id)}/purge`;
  // The plan as the server reads it now; `again` when it is read again because the target changed.
  const read = (again: boolean) => {
    const n = ++seq.current;
    setError(null);
    api<PurgePlan>(path, { body: { preview: true } }).then(
      (p) => {
        if (n !== seq.current) return;
        setPlan(p);
        setChanged(again);
        if (again) setTyped('');
      },
      (e: unknown) => n === seq.current && setError(e),
    );
  };
  useEffect(() => {
    read(false);
    return () => {
      seq.current++;
    };
    // Read once for the target the dialog was opened for (it is opened again for another).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  const submit = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      await api(path, { body: { reason, confirm: typed.trim(), fingerprint: plan.fingerprint } });
      await onDone({ ok: true, text: t('purgeDone', { what: plan.label }) });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
      // Changed or blocked since it was read: shown again as it is now, to be checked before sending again.
      if (e instanceof ApiError && (e.code === 'purge_changed' || e.code === 'purge_blocked')) {
        read(true);
        return;
      }
      // Gone meanwhile (another administrator removed it): nothing left to do here.
      if (e instanceof ApiError && e.code === 'not_found') {
        await onDone({ ok: false, text: errText(e, t) });
        return;
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const ready = !!plan && plan.deletable && reason.trim().length >= 2 && typed.trim() === plan.confirmText;
  const shownError = error && !(error instanceof ApiError && error.code === 'reauth_cancelled') ? error : null;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('purgeTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="danger" disabled={!ready} loading={busy} onClick={() => void submit()} data-testid="purge-submit">{t('purgeProceed')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 break-keep text-sm" data-testid="purge-dialog" data-kind={kind}>
        {!plan && !shownError && <p className="text-ink-400" aria-live="polite">{t('pvLoading')}</p>}
        {shownError && <p className="break-words text-danger" role="alert" data-testid="purge-error">{errText(shownError, t)}</p>}
        {plan && (
          <>
            {changed && <p className="text-gold-300" role="status" data-testid="purge-changed">{t('purgeChanged')}</p>}
            <div className="flex flex-col gap-2 rounded-lg border-2 border-danger/70 bg-danger/10 px-3 py-2" data-testid="purge-plan" data-deletable={plan.deletable}>
              <p className="flex items-start gap-2 font-semibold text-danger">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{t('purgeIrreversible')}</span>
              </p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-ink-400">{t('purgeTarget')}</dt>
                <dd className="break-words">{t(KIND[kind])} · {plan.label}</dd>
                <dt className="text-ink-400">{t('purgeId')}</dt>
                <dd className="break-all font-mono text-xs">{plan.id}</dd>
                <dt className="text-ink-400">{t('purgeRemoves')}</dt>
                <dd data-testid="purge-removes">{rows(t, plan.removes)}</dd>
                <dt className="text-ink-400">{t('purgeKeeps')}</dt>
                <dd data-testid="purge-keeps">{rows(t, plan.keeps)}</dd>
                <dt className="text-ink-400">{t('purgeIntegrity')}</dt>
                <dd data-testid="purge-integrity" className={plan.deletable ? 'text-success' : 'font-semibold text-danger'}>{t(plan.deletable ? 'purgeClear' : 'purgeBlocked')}</dd>
                <dt className="text-ink-400">{t('purgeWho')}</dt>
                <dd>{t('purgeWhoText')}</dd>
              </dl>
              {!plan.deletable && (
                <ul className="flex list-disc flex-col gap-1 pl-5" data-testid="purge-blockers">
                  {plan.blockers.map((b) => {
                    const key = blockerKey(kind, b.code);
                    return (
                      <li key={b.code} data-code={b.code}>
                        {key ? t(key, { n: b.count }) : t('purgeBlkOther', { code: b.code, n: b.count })}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {plan.deletable && (
              <>
                <AdminReasonField label={t('reasonRequired')} templates={REASONS.purge} value={reason} onChange={setReason} maxLength={200} testid="purge-reason" />
                {/* Field's label is set in capitals; the text to type is shown as it must be typed. */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={confirmId} className="text-xs font-semibold tracking-[0.12em] text-ink-300" data-testid="purge-confirm-label">
                    {t('purgeType', { text: plan.confirmText })}
                  </label>
                  <Input id={confirmId} className="font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} maxLength={40} data-testid="purge-confirm" />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
