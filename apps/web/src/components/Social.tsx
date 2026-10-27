import { BOT_STYLE_TRAITS, BOT_TRAITS, REPORT_REASONS, type BotStyle, type BotTraitTier, type FriendRequestResultDto, type PublicUserDto, type RelationDto, type RelationKind, type ReportReason, type ReportTarget, type SeatView } from '@jc/types';
import { Button, cx, Modal, Spinner } from '@jc/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { blockUser, setMuted, unblockUser, useMuted } from '../lib/safety';
import { refreshUnread } from '../lib/unread';
import { BOT_LEVEL_LABEL, MemberName, RoleBadge, VipBadge, vipOf } from './MemberName';

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
            {subject?.type === 'dm' && <span className="block">{t('report.dmHint')}</span>}
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

/** Confirms a block and spells out what it does; shared by the player card and the 1:1 chat. */
export function BlockConfirm({ name, busy, onConfirm, onCancel }: { name: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm" data-testid="block-confirm">
      <p className="font-semibold text-ivory">{t('block.confirmTitle', { name })}</p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-ink-200">
        <li>{t('block.effect1')}</li>
        <li>{t('block.effect2')}</li>
        <li>{t('block.effect3')}</li>
      </ul>
      <p className="mt-1.5 text-xs text-ink-400">{t('block.notice')}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="danger" loading={busy} onClick={onConfirm} data-testid="block-confirm-yes">{t('block.action')}</Button>
      </div>
    </div>
  );
}

/**
 * A table bot's card in place of a player's: what it is and how well it plays. A bot has no profile and takes no
 * friend request, message, block or report (the server refuses them), so the card offers none.
 */
export function BotCard({ seat, onClose }: { seat: SeatView | null; onClose: () => void }) {
  const { t } = useI18n();
  const level = seat?.bot;
  return (
    <Modal open={!!level} onClose={onClose} title={seat?.nickname ?? ''}>
      {seat && level && (
        <div className="flex flex-col gap-4" data-testid="bot-card">
          <div className="flex items-center gap-3">
            <Avatar user={{ nickname: seat.nickname ?? '', avatarUrl: null }} size="size-14" />
            <div className="min-w-0">
              <MemberName name={seat.nickname ?? ''} bot={level} className="text-lg font-bold text-ivory" />
              {level !== true && <div className="text-sm text-[#8fd9cb]" data-testid="bot-card-level">{t('bot.levelLine', { level: t(BOT_LEVEL_LABEL[level]) })}</div>}
              {seat.botLeaving && <div className="text-xs text-ink-300">{t('bot.leavingTitle')}</div>}
            </div>
          </div>
          {seat.botStyle && <BotStyleInfo style={seat.botStyle} />}
          <p className="text-sm leading-relaxed text-ink-200">{t('bot.about')}</p>
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Less, as much as or more than the balanced style: one, two or three of three steps lit. */
function TraitMeter({ tier }: { tier: BotTraitTier }) {
  return (
    <span className="flex shrink-0 gap-0.5" aria-hidden>
      {[-1, 0, 1].map((k) => (
        <span key={k} className={cx('h-1.5 w-4 rounded-full', k <= tier ? 'bg-[#8fd9cb]' : 'bg-white/10')} />
      ))}
    </span>
  );
}

/**
 * How a bot's style plays (BOT_STYLE_TRAITS, held to the bot's own numbers): its name, what it does, and each trait
 * against the balanced style. Only the tendency anyone at the table could read; nothing of its cards or next move.
 */
function BotStyleInfo({ style }: { style: BotStyle }) {
  const { t } = useI18n();
  const traits = BOT_STYLE_TRAITS[style];
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3" data-testid="bot-card-style" data-style={style}>
      <div className="text-sm font-bold text-[#8fd9cb]" data-testid="bot-card-style-name">{t('bot.styleLine', { style: t(`bot.style.${style}` as MsgKey) })}</div>
      <p className="text-sm leading-relaxed text-ink-100">{t(`bot.styleAbout.${style}` as MsgKey)}</p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        {BOT_TRAITS.map((k) => (
          <div key={k} className="contents" data-testid={`bot-trait-${k}`} data-tier={traits[k]}>
            <dt className="text-ink-300">{t(`bot.trait.${k}` as MsgKey)}</dt>
            <dd className="flex items-center gap-2 text-ink-100">
              <TraitMeter tier={traits[k]} />
              {t(`bot.trait.${k}.${traits[k] + 1}` as MsgKey)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-relaxed text-ink-400">{t('bot.styleNote')}</p>
    </section>
  );
}

/**
 * A player's name card: friend request / accept / message, block, and optionally a report button and (at a table)
 * a device-local mute for that player's table chat. Staff cannot be blocked, and the super admin cannot be reported
 * (the server refuses both); the card says so instead of offering the button.
 */
export function PlayerCard({ user, onClose, onReport, newTab, chatMute }: { user: PublicUserDto | null; onClose: () => void; onReport?: () => void; newTab?: boolean; chatMute?: boolean }) {
  const { t, err } = useI18n();
  const { me } = useAuth();
  const [rel, setRel] = useState<RelationKind | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const muted = useMuted(me?.id);
  useEffect(() => {
    setRel(null);
    setNote(null);
    setConfirmBlock(false);
    if (!user) return;
    let live = true;
    void api<RelationDto>(`/api/friends/${user.id}/relation`)
      .then((r) => live && setRel(r.relation))
      .catch(() => live && setRel('none'));
    return () => {
      live = false;
    };
  }, [user]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      void refreshUnread();
    } catch (x) {
      setNote(err(x instanceof ApiError ? x.code : null));
    } finally {
      setBusy(false);
    }
  }
  const befriend = () =>
    run(async () => {
      if (!user) return;
      if (rel === 'incoming') {
        await api(`/api/friends/${user.id}/accept`, { body: {} });
        setRel('friend');
        setNote(t('friends.nowFriends', { name: user.nickname }));
      } else {
        const r = await api<FriendRequestResultDto>('/api/friends/requests', { body: { userId: user.id } });
        setRel(r.status === 'accepted' ? 'friend' : 'outgoing');
        setNote(t(r.status === 'accepted' ? 'friends.nowFriends' : 'friends.sent', { name: user.nickname }));
      }
    });
  const block = () =>
    run(async () => {
      if (!user) return;
      await blockUser(user.id);
      setRel('blocked');
      setConfirmBlock(false);
      setNote(t('block.done', { name: user.nickname }));
    });
  const unblock = () =>
    run(async () => {
      if (!user) return;
      await unblockUser(user.id);
      setRel('none');
      setNote(t('block.undone', { name: user.nickname }));
    });
  const self = !!user && user.id === me?.id;
  const isMuted = !!user && muted.has(user.id);
  const staff = !!user?.role;
  const canBlock = rel !== null && rel !== 'blocked' && !confirmBlock && !staff;
  return (
    <Modal open={!!user} onClose={onClose} title={user?.nickname ?? ''}>
      {user && (
        <div className="flex flex-col gap-4" data-testid="player-card">
          <div className="flex items-center gap-3">
            <Avatar user={user} size="size-14" />
            <div className="min-w-0">
              <MemberName name={user.nickname} role={user.role} vip={user.vip} className="text-lg font-bold text-ivory" />
              {user.role && <RoleBadge role={user.role} className="mb-0.5 mt-1" />}
              {vipOf(user.role, user.vip) && <VipBadge className="mb-0.5 mt-1" />}
              {rel === 'friend' && <div className="text-xs font-semibold text-[#9fd8b6]">{t('friends.isFriend')}</div>}
              {rel === 'blocked' && <div className="text-xs font-semibold text-[#f0a0a2]" data-testid="player-blocked">{t('block.isBlocked')}</div>}
            </div>
          </div>
          {note && <p className="text-sm text-gold-300" role="status">{note}</p>}
          {confirmBlock && <BlockConfirm name={user.nickname} busy={busy} onConfirm={block} onCancel={() => setConfirmBlock(false)} />}
          <div className="flex flex-wrap justify-end gap-2">
            {onReport && user.role !== 'super_admin' && (
              <Button variant="ghost" className="mr-auto text-[#f0a0a2]" onClick={onReport} data-testid="player-report">
                {t('report.action')}
              </Button>
            )}
            {self ? null : rel === null ? (
              <Spinner className="size-5 self-center text-gold-400" />
            ) : rel === 'blocked' ? (
              <Button variant="outline" onClick={unblock} loading={busy} data-testid="player-unblock">{t('block.unblock')}</Button>
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
          {!self && me && (chatMute || canBlock || staff) && (
            <div className="flex flex-col gap-2 border-t border-white/5 pt-3">
              <div className="flex flex-wrap gap-2">
                {chatMute && (
                  <Button size="sm" variant="subtle" aria-pressed={isMuted} onClick={() => setMuted(me.id, user.id, !isMuted)} data-testid="player-mute">
                    {isMuted ? t('mute.off') : t('mute.on')}
                  </Button>
                )}
                {canBlock && (
                  <Button size="sm" variant="ghost" className="ml-auto text-[#f0a0a2]" onClick={() => setConfirmBlock(true)} data-testid="player-block">
                    {t('block.action')}
                  </Button>
                )}
              </div>
              {chatMute && <p className="text-xs text-ink-400">{t('mute.hint')}</p>}
              {staff && <p className="text-xs text-ink-400" data-testid="player-staff-note">{t(user.role === 'super_admin' ? 'staff.noReportBlock' : 'staff.noBlock')}</p>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
