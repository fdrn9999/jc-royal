/**
 * How a member's name looks to other players. Staff (`role` from the server, never chosen by the client) get their
 * own color and mark: a crown for the super admin, a shield for an admin, and where there is room the SUPER ADMIN /
 * ADMIN badge. A VIP member (`vip`, a palette key from the server, members only) gets the color an administrator chose
 * and always the VIP mark with it: the VIP pill where there is room, a small gold diamond where there is not. Other
 * members look exactly as before. The crown is drawn, so it never reads as the 👑 host mark.
 */
import type { BotLevel, PublicRole, VipColor } from '@jc/types';
import { cx } from '@jc/ui';
import { useI18n } from '../lib/i18n';

const LABEL = { super_admin: 'role.superAdmin', admin: 'role.admin' } as const;
/** How a table bot's level reads ("Normal"). */
export const BOT_LEVEL_LABEL = { easy: 'bot.easy', normal: 'bot.normal', hard: 'bot.hard', expert: 'bot.expert' } as const;

/**
 * The BOT pill on a table bot's name (the same word in Korean and English). The level, when known, is in its title and
 * read out by screen readers; the replay of a past hand knows only that the seat was a bot. A level this build does
 * not know yet (a newer server) reads as a plain table bot.
 */
export function BotBadge({ level, className }: { level: BotLevel | true; className?: string }) {
  const { t } = useI18n();
  const key = level === true ? undefined : (BOT_LEVEL_LABEL as Record<string, (typeof BOT_LEVEL_LABEL)[BotLevel] | undefined>)[level];
  const label = key ? t('bot.labelLevel', { level: t(key) }) : t('bot.label');
  return (
    <span className={cx('jc-bot-badge', className)} title={label} data-level={level === true ? undefined : level} data-testid="bot-badge">
      <span aria-hidden>BOT</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The crown (super admin) or shield (admin) in front of a staff name. Nothing for other members. */
export function RoleIcon({ role, className }: { role?: PublicRole; className?: string }) {
  const { t } = useI18n();
  if (!role) return null;
  const label = t(LABEL[role]);
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label={label} className={cx('jc-role-icon shrink-0', className)} data-role={role} data-testid="role-icon">
      <title>{label}</title>
      {role === 'super_admin' ? (
        <>
          <path d="M1.8 4.6 5 7.6 8 2.4l3 5.2 3.2-3-1.1 7.2H2.9L1.8 4.6Z" fill="#efcf7e" stroke="#fff1c9" strokeWidth=".7" strokeLinejoin="round" />
          <rect x="2.9" y="12.4" width="10.2" height="1.8" rx=".6" fill="#c99a3c" />
        </>
      ) : (
        <path d="M8 1.4 13.6 3.4v4.2c0 3.3-2.4 6-5.6 7-3.2-1-5.6-3.7-5.6-7V3.4L8 1.4Z" fill="#3d8ef0" stroke="#a8dcff" strokeWidth=".8" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** The SUPER ADMIN / ADMIN pill (the same words in Korean and English). Nothing for other members. */
export function RoleBadge({ role, className }: { role?: PublicRole; className?: string }) {
  const { t } = useI18n();
  if (!role) return null;
  return (
    <span className={cx('jc-role-badge', className)} data-role={role} title={t(LABEL[role])} data-testid="role-badge">
      {role === 'super_admin' ? 'SUPER ADMIN' : 'ADMIN'}
    </span>
  );
}

const DIAMOND = 'M5 .6 9.4 4 5 9.4.6 4Z';

/** The VIP pill (the same word in Korean and English): gold on near-black, a thin gold rim and a small diamond. */
export function VipBadge({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx('jc-vip-badge', className)} title={t('vip.label')} data-testid="vip-badge">
      <svg viewBox="0 0 10 10" aria-hidden className="size-[0.85em] shrink-0">
        <path d={DIAMOND} fill="currentColor" />
      </svg>
      <span aria-hidden>VIP</span>
      <span className="sr-only">{t('vip.label')}</span>
    </span>
  );
}

/** The VIP mark where the pill has no room (a seat, a lobby host): the gold diamond alone, read out as "VIP member". */
export function VipIcon({ className }: { className?: string }) {
  const { t } = useI18n();
  const label = t('vip.label');
  return (
    <svg viewBox="0 0 10 10" role="img" aria-label={label} className={cx('jc-vip-icon shrink-0', className)} data-testid="vip-icon">
      <title>{label}</title>
      <path d={DIAMOND} fill="currentColor" />
    </svg>
  );
}

/** A VIP color only for a member: staff keep their own (the server never sends both; this is the client's guard). */
export const vipOf = (role: PublicRole | undefined, vip: VipColor | undefined) => (role ? undefined : vip);

/**
 * "Host {name}" on a lobby room: 👤 for a member, the staff mark and color for staff, the VIP color and diamond for a
 * VIP member. The sentence comes from the translation, so only the name inside it is colored.
 */
export function HostedBy({ host }: { host: { nickname: string; role?: PublicRole; vip?: VipColor } }) {
  const { t } = useI18n();
  const MARK = '\u0000';
  const [before = '', after = ''] = t('room.hostedBy', { name: MARK }).split(MARK);
  const vip = vipOf(host.role, host.vip);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {host.role ? <RoleIcon role={host.role} className="size-3" /> : vip ? <VipIcon className="size-3" /> : <span aria-hidden>👤</span>}
      <span className="min-w-0 truncate">
        {before}
        <span className={cx(host.role && 'jc-role-name', vip && 'jc-vip-name') || undefined} data-role={host.role} data-vip={vip}>
          {host.nickname}
        </span>
        {after}
      </span>
    </span>
  );
}

/**
 * A member's name: for staff, the mark and their color (over whatever color `className` gives other members), and the
 * badge with `badge`; for a VIP member, their color with the diamond in front, or the VIP pill after it with `badge`.
 * `badge="wide"` (a row that also holds a status, a time or buttons): the badges from the sm width up, and below it the
 * marks alone (the diamond; staff keep the crown or shield either way), so a phone's narrow row still shows the name.
 * A table bot (`bot`) always carries the BOT pill. Long names are cut with an ellipsis; the marks and the badges always
 * stay whole, so a seat keeps its size and a long name gives way to them.
 */
export function MemberName({ name, role, vip: given, bot, badge, className }: { name: string; role?: PublicRole; vip?: VipColor; bot?: BotLevel | true; badge?: boolean | 'wide'; className?: string }) {
  const vip = vipOf(role, given);
  const pills =
    badge && (role || vip) ? (
      <>
        <RoleBadge role={role} />
        {vip && <VipBadge />}
      </>
    ) : null;
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-1 align-bottom', className)} data-testid="member-name">
      <RoleIcon role={role} className="size-[1.05em]" />
      {vip && badge !== true && <VipIcon className={cx('size-[0.85em]', badge === 'wide' && 'sm:hidden')} />}
      <span className={cx('min-w-0 truncate', role && 'jc-role-name', vip && 'jc-vip-name')} data-role={role} data-vip={vip}>
        {name}
      </span>
      {/* Hidden by a wrapper: the pills' own (unlayered) display would win over a utility on them. */}
      {badge === 'wide' && pills ? <span className="contents max-sm:hidden">{pills}</span> : pills}
      {bot && <BotBadge level={bot} />}
    </span>
  );
}
