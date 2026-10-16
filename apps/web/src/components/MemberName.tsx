/**
 * How a member's name looks to other players. Staff (`role` from the server, never chosen by the client) get their
 * own color and mark: a crown for the super admin, a shield for an admin, and where there is room the SUPER ADMIN /
 * ADMIN badge. Ordinary members look exactly as before. The crown is drawn, so it never reads as the 👑 host mark.
 */
import type { PublicRole } from '@jc/types';
import { cx } from '@jc/ui';
import { useI18n } from '../lib/i18n';

const LABEL = { super_admin: 'role.superAdmin', admin: 'role.admin' } as const;

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

/**
 * "Host {name}" on a lobby room: 👤 for a member, the staff mark and color for staff. The sentence comes from the
 * translation, so only the name inside it is colored.
 */
export function HostedBy({ host }: { host: { nickname: string; role?: PublicRole } }) {
  const { t } = useI18n();
  const MARK = '\u0000';
  const [before = '', after = ''] = t('room.hostedBy', { name: MARK }).split(MARK);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {host.role ? <RoleIcon role={host.role} className="size-3" /> : <span aria-hidden>👤</span>}
      <span className="min-w-0 truncate">
        {before}
        <span className={host.role && 'jc-role-name'} data-role={host.role}>
          {host.nickname}
        </span>
        {after}
      </span>
    </span>
  );
}

/**
 * A member's name: for staff, the mark and their color (over whatever color `className` gives other members), and the
 * badge with `badge`. Long names are cut with an ellipsis; the mark and the badge always stay whole.
 */
export function MemberName({ name, role, badge, className }: { name: string; role?: PublicRole; badge?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-1 align-bottom', className)} data-testid="member-name">
      <RoleIcon role={role} className="size-[1.05em]" />
      <span className={cx('min-w-0 truncate', role && 'jc-role-name')} data-role={role}>
        {name}
      </span>
      {badge && <RoleBadge role={role} />}
    </span>
  );
}
