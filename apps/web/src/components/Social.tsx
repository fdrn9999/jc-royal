import { REPORT_REASONS, type FriendRequestResultDto, type FriendsDto, type PublicUserDto, type ReportReason, type ReportTarget } from '@jc/types';
import { Button, cx, Modal, Spinner } from '@jc/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { refreshUnread } from '../lib/unread';

export function Avatar({ user, size = 'size-10' }: { user: Pick<PublicUserDto, 'nickname' | 'avatarUrl'>; size?: string }) {
  return (
    <span className={cx('grid shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-gradient-to-br from-ink-600 to-ink-800 text-xs font-bold text-gold-300', size)}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : user.nickname.slice(0, 2).toUpperCase()}
    </span>
  );
}

export interface ReportSubject {
  type: ReportTarget;
  id: string;
  /** Required for player reports: the table where it happened. */
  tableId?: string;
  /** Shown in the dialog so the reporter can check what they are reporting. */
  label: string;
}

/** Reason + optional detail; the server snapshots the evidence itself. */
export function ReportModal({ subject, onClose }: { subject: ReportSubject | null; onClose: () => void }) {
  const { t, err } = useI18n();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setReason(null);
    setDetail('');
    setError(null);
    setDone(false);
  }, [subject]);
  const reasons = REPORT_REASONS.filter((r) => r !== 'cheating' || subject?.type === 'player');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!subject || !reason) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/reports', { body: { targetType: subject.type, targetId: subject.id, tableId: subject.tableId, reason, detail: detail.trim() || undefined } });
      setDone(true);
    } catch (x) {
      setError(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!subject} onClose={onClose} title={t('report.title')}>
      {done ? (
        <div className="flex flex-col gap-4" data-testid="report-done">
          <p className="text-sm text-ink-100" role="status">{t('report.done')}</p>
          <Button onClick={onClose} className="self-end">{t('common.close')}</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit} data-testid="report-form">
          <div className="rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-sm">
            <span className="mr-2 text-xs font-semibold text-ink-400">{subject && t(`report.target.${subject.type}` as MsgKey)}</span>
            <span className="break-words text-ink-100">{subject?.label}</span>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-300">{t('report.reason')}</legend>
            {reasons.map((r) => (
              <label key={r} className={cx('flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm', reason === r ? 'border-gold-500/60 bg-gold-500/10' : 'border-white/5')}>
                <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                {t(`report.reason.${r}` as MsgKey)}
              </label>
            ))}
          </fieldset>
          <textarea
            value={detail}
            maxLength={500}
            rows={3}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={t('report.detail')}
            aria-label={t('report.detail')}
            className="w-full rounded-lg border border-white/10 bg-ink-850 p-3 text-base text-ivory focus:border-gold-500/70 focus:outline-none sm:text-sm"
          />
          <p className="text-xs text-ink-400">
            {subject?.type === 'player' && <span className="block">{t('report.playerHint')}</span>}
            {t('report.warning')}
          </p>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="danger" disabled={!reason} loading={busy} data-testid="report-submit">{t('report.submit')}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

type Relation = 'friend' | 'outgoing' | 'incoming' | 'none';

/** A player's name card: friend request / accept / message, and optionally a report button. */
export function PlayerCard({ user, onClose, onReport, newTab }: { user: PublicUserDto | null; onClose: () => void; onReport?: () => void; newTab?: boolean }) {
  const { t, err } = useI18n();
  const [rel, setRel] = useState<Relation | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRel(null);
    setNote(null);
    if (!user) return;
    let live = true;
    void api<FriendsDto>('/api/friends')
      .then((f) => {
        if (!live) return;
        const has = (l: { id: string }[]) => l.some((x) => x.id === user.id);
        setRel(has(f.friends) ? 'friend' : has(f.outgoing) ? 'outgoing' : has(f.incoming) ? 'incoming' : 'none');
      })
      .catch(() => live && setRel('none'));
    return () => {
      live = false;
    };
  }, [user]);

  async function befriend() {
    if (!user) return;
    setBusy(true);
    setNote(null);
    try {
      if (rel === 'incoming') {
        await api(`/api/friends/${user.id}/accept`, { body: {} });
        setRel('friend');
        setNote(t('friends.nowFriends', { name: user.nickname }));
      } else {
        const r = await api<FriendRequestResultDto>('/api/friends/requests', { body: { userId: user.id } });
        setRel(r.status === 'accepted' ? 'friend' : 'outgoing');
        setNote(t(r.status === 'accepted' ? 'friends.nowFriends' : 'friends.sent', { name: user.nickname }));
      }
      void refreshUnread();
    } catch (x) {
      setNote(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!user} onClose={onClose} title={user?.nickname ?? ''}>
      {user && (
        <div className="flex flex-col gap-4" data-testid="player-card">
          <div className="flex items-center gap-3">
            <Avatar user={user} size="size-14" />
            <div className="min-w-0">
              <div className="truncate text-lg font-bold text-ivory">{user.nickname}</div>
              {rel === 'friend' && <div className="text-xs font-semibold text-[#9fd8b6]">{t('friends.isFriend')}</div>}
            </div>
          </div>
          {note && <p className="text-sm text-gold-300" role="status">{note}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {onReport && (
              <Button variant="ghost" className="mr-auto text-[#f0a0a2]" onClick={onReport} data-testid="player-report">
                {t('report.action')}
              </Button>
            )}
            {rel === null ? (
              <Spinner className="size-5 self-center text-gold-400" />
            ) : rel === 'friend' ? (
              <Link to={`/friends/${user.id}`} onClick={onClose} target={newTab ? '_blank' : undefined} rel={newTab ? 'noopener' : undefined} className="inline-flex h-10 items-center rounded-lg bg-gold-500 px-4 text-sm font-semibold text-ink-950" data-testid="player-chat">
                {t('friends.chat')}
              </Link>
            ) : rel === 'outgoing' ? (
              <Button disabled>{t('friends.requested')}</Button>
            ) : (
              <Button onClick={befriend} loading={busy} data-testid="player-befriend">
                {rel === 'incoming' ? t('friends.accept') : t('friends.request')}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
