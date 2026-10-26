import { ArrowRightIcon, Badge, Button, Empty, Field, formatChips, formatDate, Input, Panel, PlayingCard, Stat, XIcon } from '@jc/ui';
import { academyItemName, ageOn, BOT_LEVELS, BOT_TABLE_STYLES, botSettingsIssues, isoDate, isVipColor, type AcademyItemKind, type BotLevel, type BotTableStyle, type VipColor } from '@jc/types';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useT } from '../i18n';
import {
  academyKindLabel,
  actionLabel,
  botLevelLabel,
  botStyleLabel,
  capabilityLabel,
  handRankLabel,
  ledgerTypeLabel,
  memoLabel,
  roleLabel,
  seatOutcomeLabel,
  seatPhaseLabel,
  stageLabel,
  tableIssueLabel,
  tnStatusLabel,
  topUpStateLabel,
  userStatusLabel,
} from '../labels';
import { ApiError, canDo, errText, hasGrant, useAdmin, useData } from '../lib';
import { dayStart, Feedback, JumpNav, jumpTarget, ListState, LoadError, Modal, PageState, Pager, type Note } from '../ui';
import { MemberActivityPanel, MemberHistoryPanel, MemberReportsPanel, RecentTablesPanel, type MemberReports, type RecentTable } from './Member';
import { MemberSettingsPanel } from './MemberSettings';
import { MemberVipPanel, vipColorLabel } from './MemberVip';
import { MemberReferralPanel } from './Referrals';
import { MemberRefillPanel, RefillRefLine, type RefillRef } from './Refill';

type Card = Parameters<typeof PlayingCard>[0]['card'];
const newKey = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
/** The API's LARGE_ADJUSTMENT: an adjustment this large is left to a super admin (the server enforces it). */
const LARGE_ADJUSTMENT = 100_000;

type Locale = 'ko' | 'en';
/** Account language: mail, reset links and system messages to this member use it. */
export function LangBadge({ locale }: { locale: Locale }) {
  const { t } = useT();
  return (
    <Badge tone={locale === 'en' ? 'blue' : 'neutral'} className="font-mono">
      <span aria-hidden>{locale.toUpperCase()}</span>
      <span className="sr-only">{locale === 'en' ? t('langEn') : t('langKo')}</span>
    </Badge>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="subtle"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t('copied') : label}
    </Button>
  );
}

function downloadCsv(filename: string, csv: string) {
  // The BOM makes Excel read the file as UTF-8 (Korean nicknames).
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A dense table. `stack`: on a phone each row becomes a block its cells lay out themselves (no sideways scrolling). */
export function Table({ head, children, stack = false }: { head: ReactNode[]; children: ReactNode; stack?: boolean }) {
  return (
    <div className={stack ? 'sm:overflow-x-auto' : 'overflow-x-auto'}>
      <table className={stack ? 'w-full text-left text-sm max-sm:block sm:min-w-[640px]' : 'w-full min-w-[640px] text-left text-sm'}>
        <thead className={stack ? 'text-[11px] uppercase tracking-wider text-ink-400 max-sm:hidden' : 'text-[11px] uppercase tracking-wider text-ink-400'}>
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-white/5 px-2 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className={stack ? 'divide-y divide-white/5 max-sm:block' : 'divide-y divide-white/5'}>{children}</tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ users
interface UserRow {
  id: string;
  email: string;
  nickname: string;
  locale: Locale;
  role: string;
  status: string;
  balance: number;
  createdAt: number;
  lastLoginAt?: number | null;
  online?: boolean;
  /** The VIP color, when the member is VIP (absent from older APIs). */
  vipColor?: string | null;
}

/** The VIP pill and the color's name, in that color (the member list and the member page header). */
function VipTag({ color }: { color: VipColor }) {
  const { t } = useT();
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid="user-vip" data-vip={color}>
      <span className="jc-vip-badge">VIP</span>
      <span className="jc-vip-name text-xs font-semibold" data-vip={color}>{vipColorLabel(t, color)}</span>
    </span>
  );
}

const EXPORT_MAX = 1000;
const PAGE = 50;
const SORTS = [
  ['created:desc', 'sortCreatedDesc'],
  ['created:asc', 'sortCreatedAsc'],
  ['login:desc', 'sortLoginDesc'],
  ['login:asc', 'sortLoginAsc'],
  ['balance:desc', 'sortBalanceDesc'],
  ['balance:asc', 'sortBalanceAsc'],
  ['nickname:asc', 'sortNickname'],
] as const;
const selectCls = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const checkbox = 'size-4 cursor-pointer accent-gold-500';

export function UsersPage() {
  const { t, locale } = useT();
  const { api, me } = useAdmin();
  const mayExport = canDo(me, 'members.export');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<'' | Locale>('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [vip, setVip] = useState<'' | 'vip' | 'regular'>('');
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>('created:desc');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [sortKey, dir] = sort.split(':') as [string, string];
  const params = new URLSearchParams({ q: query, sort: sortKey, dir, paged: '1', limit: String(PAGE), offset: String(offset) });
  if (lang) params.set('locale', lang);
  if (onlineOnly) params.set('online', '1');
  if (status) params.set('status', status);
  if (role) params.set('role', role);
  if (vip) params.set('vip', vip);
  const { data, error, loading, reload } = useData<{ items: UserRow[]; total: number }>(`/api/admin/users?${params}`);
  // Any change to what is searched starts again from the first page (the selection for export stays).
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };
  const shown = data?.items ?? [];
  const total = data?.total ?? 0;
  const shownSelected = shown.filter((u) => selected.has(u.id)).length;
  const allShown = shown.length > 0 && shownSelected === shown.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const toggleShown = (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const u of shown) {
        if (on) n.add(u.id);
        else n.delete(u.id);
      }
      return n;
    });
  async function exportCsv() {
    setExporting(true);
    setNote(null);
    try {
      const r = await api<{ filename: string; count: number; csv: string }>('/api/admin/users/export', { body: { userIds: [...selected] } });
      downloadCsv(r.filename, r.csv);
      setNote({ ok: true, text: t('exported', { n: r.count }) });
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setNote({ ok: false, text: errText(e, t) });
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">{t('users')}</h1>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); filter(setQuery)(q); }}>
        <Input className="min-w-0 flex-1 basis-56" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label={t('status')} value={status} onChange={(e) => filter(setStatus)(e.target.value)} className={selectCls} data-testid="status-filter">
          <option value="">{t('allStatuses')}</option>
          {(['active', 'suspended', 'deleted'] as const).map((s) => <option key={s} value={s}>{userStatusLabel(t, s)}</option>)}
        </select>
        <select aria-label={t('role')} value={role} onChange={(e) => filter(setRole)(e.target.value)} className={selectCls} data-testid="role-filter">
          <option value="">{t('allRoles')}</option>
          {(['user', 'admin', 'super_admin'] as const).map((r) => <option key={r} value={r}>{roleLabel(t, r)}</option>)}
        </select>
        <select aria-label={t('featVip')} value={vip} onChange={(e) => filter(setVip)(e.target.value as typeof vip)} className={selectCls} data-testid="vip-filter">
          <option value="">{t('vipFilterAll')}</option>
          <option value="vip">{t('vipFilterVip')}</option>
          <option value="regular">{t('vipFilterRegular')}</option>
        </select>
        <select aria-label={t('language')} value={lang} onChange={(e) => filter(setLang)(e.target.value as '' | Locale)} className={selectCls} data-testid="lang-filter">
          <option value="">{t('allLanguages')}</option>
          <option value="ko">{t('langKo')}</option>
          <option value="en">{t('langEn')}</option>
        </select>
        <select aria-label={t('sortLabel')} value={sort} onChange={(e) => filter(setSort)(e.target.value as typeof sort)} className={selectCls} data-testid="sort-select">
          {SORTS.map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
        </select>
        <label className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm" title={t('onlineBasis')}>
          <input type="checkbox" className={checkbox} checked={onlineOnly} onChange={(e) => filter(setOnlineOnly)(e.target.checked)} data-testid="online-filter" />
          {t('onlineOnly')}
        </label>
        <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
      </form>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-ink-900/60 px-3 py-2" data-testid="export-bar">
        <span className="text-sm font-semibold" aria-live="polite">{t('selectedN', { n: selected.size })}</span>
        {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t('clearSelection')}</Button>}
        <Button size="sm" className="ml-auto" onClick={exportCsv} loading={exporting} disabled={!mayExport || selected.size === 0 || selected.size > EXPORT_MAX} data-testid="export-csv">
          {t('exportCsv')}
        </Button>
        <p className="w-full text-xs text-ink-400">{mayExport ? t('exportHint') : t('exportSuperOnly')}</p>
      </div>
      <Feedback note={note} />
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <Table
          head={[
            <input
              key="all"
              type="checkbox"
              className={checkbox}
              aria-label={t('selectAllShown')}
              checked={allShown}
              ref={(el) => {
                if (el) el.indeterminate = shownSelected > 0 && !allShown;
              }}
              onChange={(e) => toggleShown(e.target.checked)}
              disabled={shown.length === 0}
              data-testid="select-all"
            />,
            t('nickname'), t('email'), t('language'), t('role'), t('status'), t('balance'), t('lastLogin'), t('createdAt'), '',
          ]}
        >
          {shown.map((u) => (
            <tr key={u.id} className={selected.has(u.id) ? 'bg-gold-500/5' : undefined}>
              <td className="w-8 px-2 py-2">
                <input type="checkbox" className={checkbox} aria-label={t('selectUser', { name: u.nickname })} checked={selected.has(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} />
              </td>
              <td className="px-2 py-2 font-semibold"><Link to={`/users/${u.id}`} className="inline-flex min-h-6 items-center text-gold-300 hover:underline">{u.nickname}</Link></td>
              <td className="px-2 py-2 text-ink-300">{u.email}</td>
              <td className="px-2 py-2"><LangBadge locale={u.locale} /></td>
              <td className="px-2 py-2">
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone={u.role === 'user' ? 'neutral' : 'gold'} className="whitespace-nowrap">{roleLabel(t, u.role)}</Badge>
                  {isVipColor(u.vipColor) && <VipTag color={u.vipColor} />}
                </span>
              </td>
              <td className="px-2 py-2">
                <Badge tone={u.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, u.status)}</Badge>
                {u.online && <Badge tone="blue" className="ml-1">{t('online')}</Badge>}
              </td>
              <td className="px-2 py-2 font-mono">{formatChips(u.balance)}</td>
              <td className="px-2 py-2 text-xs text-ink-300">{u.lastLoginAt ? formatDate(u.lastLoginAt, locale) : <span className="text-ink-400">{t('notRecorded')}</span>}</td>
              <td className="px-2 py-2 text-xs text-ink-400">{formatDate(u.createdAt, locale)}</td>
              <td className="px-2 py-2"><Link to={`/users/${u.id}`} className="text-gold-300">{t('detail')}</Link></td>
            </tr>
          ))}
        </Table>
        {data && shown.length === 0 && <p className="py-8 text-center text-sm text-ink-400" data-testid="no-members">{t('noMembers')}</p>}
        {total > 0 && (
          <nav className="mt-3 flex flex-wrap items-center justify-end gap-2" aria-label={t('users')} data-testid="users-pager">
            <span className="mr-auto text-xs text-ink-400" aria-live="polite">{t('pageRange', { from: offset + 1, to: offset + shown.length, total })}</span>
            <Button size="sm" variant="outline" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))} data-testid="page-prev">{t('prevPage')}</Button>
            <Button size="sm" variant="outline" disabled={offset + shown.length >= total || loading} onClick={() => setOffset(offset + PAGE)} data-testid="page-next">{t('nextPage')}</Button>
          </nav>
        )}
      </Panel>
    </div>
  );
}

interface UserDetail {
  user: UserRow & {
    suspendedReason: string | null;
    avatarUrl: string | null;
    birthDate: string | null;
    emailVerifiedAt: number | null;
    privacyConsentVersion: string | null;
    privacyConsentAt: number | null;
  };
  ledger: { id: string; type: string; amount: number; balanceAfter: number; memo: string | null; createdAt: number; actorId: string | null }[];
  openSeats: { id: string; tableId: string; seatIndex: number; buyIn: number }[];
  hands: { n: number; net: number };
  ledgerConsistent: boolean;
  /** Valid sign-in sessions, most recent first (no tokens or addresses). Absent from older APIs. */
  sessions?: { kind: 'user' | 'admin'; createdAt: number; lastSeenAt: number; expiresAt: number }[];
  online?: boolean;
  /** Latest seatings with their tables, and reports by and about the member. Absent from older APIs. */
  recentTables?: RecentTable[];
  reports?: MemberReports;
  /** What the server left out because the feature is off for this administrator (ledger, reports). Absent from older APIs. */
  hidden?: ('ledger' | 'reports')[];
}

type Role = 'user' | 'admin' | 'super_admin';
/**
 * What the confirmation dialog is about to do; lifting a suspension and changing a role ask for a reason there. A chip
 * adjustment carries its idempotency key, so confirming sends exactly the request that was previewed.
 */
type Pending =
  | null
  | { kind: 'suspend' }
  | { kind: 'disconnect' }
  | { kind: 'unsuspend' }
  | { kind: 'role'; role: Role }
  | { kind: 'chips'; amount: number; memo: string; key: string; ref: RefillRef | null };

/** The API's answer to `preview: true`: what the change would do, computed now; nothing is written. */
interface SanctionPreview {
  member: { nickname: string; role: string; status: string };
  sessions: { user: number; admin: number };
  seats: { tableId: string; tableName: string | null; seatIndex: number; buyIn: number }[];
  buyIns: number;
  removeFromTable?: boolean;
}
interface UnsuspendPreview { from: string; to: string; suspendedReason: string | null }
interface RolePreview {
  from: string;
  to: string;
  console: { from: boolean; to: boolean };
  adminSessions: number;
  capabilities: { gained: string[]; lost: string[] };
  /** The VIP color the change ends (staff are never VIP). Absent from older APIs. */
  vipCleared?: VipColor | null;
}
interface ChipPreview { amount: number; balanceBefore: number; balanceAfter: number; large: boolean; duplicate: boolean; ref: { id: string; type: string; amount: number; createdAt: number } | null }

function ChangePreview({ p, data }: { p: Exclude<Pending, null>; data: unknown }) {
  const { t } = useT();
  if (p.kind === 'suspend' || p.kind === 'disconnect') {
    const d = data as SanctionPreview;
    const leaves = p.kind === 'suspend' || !!d.removeFromTable;
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2" data-testid="change-preview">
        <p>{t('pvSessions', { user: d.sessions.user, admin: d.sessions.admin })}</p>
        {d.seats.length === 0 ? (
          <p className="text-ink-300">{t('pvNoSeats')}</p>
        ) : (
          <>
            <p>{t(leaves ? 'pvSeatsLeave' : 'pvSeatsKept', { n: d.seats.length, chips: formatChips(d.buyIns) })}</p>
            <ul className="flex flex-col gap-0.5 text-xs text-ink-300">
              {d.seats.map((s) => (
                <li key={`${s.tableId}:${s.seatIndex}`} className="break-all">#{s.seatIndex + 1} · {s.tableName ?? s.tableId} · {t('seatBuyIn', { n: formatChips(s.buyIn) })}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }
  if (p.kind === 'role') {
    const d = data as RolePreview;
    const access = (on: boolean) => t(on ? 'pvConsoleOn' : 'pvConsoleOff');
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2" data-testid="change-preview">
        <p>{t('pvConsole', { from: access(d.console.from), to: access(d.console.to) })}</p>
        <p>{d.adminSessions > 0 ? t('pvAdminSessions', { n: d.adminSessions }) : t('pvAdminSessionsNone')}</p>
        {d.capabilities.gained.length > 0 && (
          <div>
            <p className="text-xs text-ink-400">{t('pvGained')}</p>
            <ul className="list-disc pl-5 text-xs">{d.capabilities.gained.map((k) => <li key={k}>{capabilityLabel(t, k)}</li>)}</ul>
          </div>
        )}
        {d.capabilities.lost.length > 0 && (
          <div>
            <p className="text-xs text-ink-400">{t('pvLost')}</p>
            <ul className="list-disc pl-5 text-xs">{d.capabilities.lost.map((k) => <li key={k}>{capabilityLabel(t, k)}</li>)}</ul>
          </div>
        )}
        {d.capabilities.gained.length + d.capabilities.lost.length === 0 && <p className="text-ink-300">{t('pvNoCapChange')}</p>}
        {d.vipCleared && (
          <p className="text-ink-300" data-testid="pv-vip-cleared">
            {t('vipClearedByRole')} ({vipColorLabel(t, d.vipCleared)})
          </p>
        )}
      </div>
    );
  }
  if (p.kind === 'chips') {
    const d = data as ChipPreview;
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2" data-testid="change-preview">
        <p>
          {t('amount')}: <span className="font-mono">{d.amount > 0 ? '+' : ''}{formatChips(d.amount)}</span> {d.large && <Badge tone="gold">{t('pvLarge')}</Badge>}
        </p>
        <p className="break-all text-ink-300">{t('memo')}: {p.memo}</p>
        {d.ref && <RefillRefLine r={{ ...d.ref, seq: p.ref?.id === d.ref.id ? p.ref.seq : undefined }} />}
        {d.duplicate && <p className="text-danger" role="alert">{t('pvDuplicate')}</p>}
      </div>
    );
  }
  return null;
}

/** What ending a member's table connections did (the api's kickEverywhere). */
interface KickReport { tables: number; reached: number; unreached: string[]; truncated: boolean; sockets: number; seats: { tableId: string; seat: string }[] }

function KickResult({ r }: { r: { kick: KickReport; sessions?: number } }) {
  const { t } = useT();
  const k = r.kick;
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-sm text-ink-100" data-testid="kick-result" aria-live="polite">
      {r.sessions !== undefined && <p>{t('kickSessions', { n: r.sessions })}</p>}
      <p>{t('kickResult', { sockets: k.sockets, reached: k.reached, tables: k.tables })}</p>
      {k.seats.map((s) => (
        <p key={s.tableId}>
          <Link to={`/tables/${s.tableId}`} className="text-gold-300 hover:underline">{t('seatOutcome', { table: s.tableId, outcome: seatOutcomeLabel(t, s.seat) })}</Link>
        </p>
      ))}
      {k.unreached.length > 0 && <p className="break-all text-danger" role="alert">{t('kickUnreached', { n: k.unreached.length, ids: k.unreached.join(', ') })}</p>}
      {k.truncated && <p className="text-ink-300">{t('kickTruncated')}</p>}
    </section>
  );
}

interface ResetLink {
  path: string;
  /** Absolute link on the player site (relative when the API has no APP_ORIGIN). */
  url: string;
  expiresInMinutes: number;
  locale: Locale;
  mailed: boolean;
  message: { subject: string; text: string };
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useT();
  const { api, me } = useAdmin();
  const { data, error, reload } = useData<UserDetail>(`/api/admin/users/${id}`);
  const [note, setNote] = useState<Note>(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [reason, setReason] = useState('');
  const [reset, setReset] = useState<ResetLink | null>(null);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [cReason, setCReason] = useState('');
  const [dReason, setDReason] = useState('');
  const [removeSeat, setRemoveSeat] = useState(false);
  const [kick, setKick] = useState<{ kick: KickReport; sessions?: number } | null>(null);
  // The server's preview of the pending change; confirming waits for it.
  const [pv, setPv] = useState<{ data: unknown } | { error: unknown } | null>(null);
  const previewSeq = useRef(0);
  // Kept while the same amount and memo are tried again, so a retry after a lost answer cannot pay twice.
  const [chipKey, setChipKey] = useState<{ key: string; amount: number; memo: string; ref: string | null } | null>(null);
  // A free refill the adjustment takes back (the member's refill panel), named in the ledger row it writes.
  const [chipRef, setChipRef] = useState<RefillRef | null>(null);
  const chipForm = useRef<HTMLDivElement>(null);
  // Bumped after every change so the history panel reloads with the new entry.
  const [rev, setRev] = useState(0);
  // Another administrator suspended the member after this page loaded: show the member as they are now.
  const outdated = (e: unknown): e is ApiError => e instanceof ApiError && e.code === 'already_suspended';
  const run = async (fn: () => Promise<unknown>) => {
    setNote(null);
    setReset(null);
    setKick(null);
    try {
      await fn();
      setNote({ ok: true, text: t('saved') });
      setRev((n) => n + 1);
      await reload();
    } catch (e) {
      setNote({ ok: false, text: errText(e, t) });
      if (outdated(e)) {
        // The suspension was already there, but the tables were asked again: show what they did.
        const k = (e.details as { kick?: KickReport } | undefined)?.kick;
        if (k) setKick({ kick: k });
        await reload();
      }
    }
  };
  // The dialog shows what the server says the change would do; the password is asked only when it is confirmed.
  const ask = (p: Exclude<Pending, null>) => {
    setCReason('');
    setConfirm(p);
    setPv(null);
    const seq = ++previewSeq.current;
    const body =
      p.kind === 'suspend'
        ? { preview: true, reason }
        : p.kind === 'disconnect'
          ? { preview: true, reason: dReason, removeFromTable: removeSeat }
          : p.kind === 'role'
            ? { preview: true, role: p.role }
            : p.kind === 'chips'
              ? { preview: true, amount: p.amount, memo: p.memo, idempotencyKey: p.key, ...(p.ref ? { refLedgerId: p.ref.id } : {}) }
              : { preview: true };
    api<unknown>(`/api/admin/users/${id}/${p.kind}`, { body }).then(
      (data) => seq === previewSeq.current && setPv({ data }),
      (e: unknown) => {
        if (seq !== previewSeq.current) return;
        setPv({ error: e });
        if (outdated(e)) void reload();
      },
    );
  };
  const dismiss = () => {
    previewSeq.current++;
    setConfirm(null);
    setPv(null);
  };
  const askChips = () => {
    const n = Number(amount);
    const ref = chipRef?.id ?? null;
    const key = chipKey && chipKey.amount === n && chipKey.memo === memo && chipKey.ref === ref ? chipKey.key : newKey();
    setChipKey({ key, amount: n, memo, ref });
    ask({ kind: 'chips', amount: n, memo, key, ref: chipRef });
  };
  const clearChips = () => {
    setChipKey(null);
    setChipRef(null);
    setAmount('');
    setMemo('');
  };
  // Taking back a refill: what is left of it, as a negative adjustment linked to it, checked in the dialog like any other.
  const correctRefill = (r: RefillRef) => {
    setChipRef(r);
    setAmount(String(-r.amount));
    setMemo(t('refillCorrectMemo', { n: r.seq }));
    chipForm.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    chipForm.current?.querySelector('input')?.focus({ preventScroll: true });
  };
  const issueReset = async () => {
    setNote(null);
    setReset(null);
    try {
      setReset(await api<ResetLink>(`/api/admin/users/${id}/reset-link`, { body: {} }));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setNote({ ok: false, text: errText(e, t) });
    }
  };
  // Suspending and ending connections reach the member's tables: confirmed first, then the result says what each table did.
  const endConnections = (kind: 'suspend' | 'disconnect') => {
    dismiss();
    void run(async () => {
      setKick(
        kind === 'suspend'
          ? await api<{ kick: KickReport }>(`/api/admin/users/${id}/suspend`, { body: { reason } })
          : await api<{ kick: KickReport; sessions: number }>(`/api/admin/users/${id}/disconnect`, { body: { reason: dReason, removeFromTable: removeSeat } }),
      );
      // A used reason is not offered again for the next action.
      if (kind === 'suspend') setReason('');
      else setDReason('');
    });
  };
  const apply = () => {
    const p = confirm;
    if (!p) return;
    if (p.kind === 'suspend' || p.kind === 'disconnect') return endConnections(p.kind);
    dismiss();
    if (p.kind === 'chips') {
      // The previewed request itself: same amount, memo and key.
      void run(async () => {
        await api(`/api/admin/users/${id}/chips`, { body: { amount: p.amount, memo: p.memo, idempotencyKey: p.key, ...(p.ref ? { refLedgerId: p.ref.id } : {}) } });
        clearChips();
      });
      return;
    }
    const why = cReason.trim();
    void run(() =>
      p.kind === 'unsuspend'
        ? api(`/api/admin/users/${id}/unsuspend`, { body: { reason: why } })
        : api(`/api/admin/users/${id}/role`, { body: { role: p.role, reason: why } }),
    );
  };
  if (!data) return <PageState error={error} onRetry={reload} />;
  const u = data.user;
  const canModerate = me?.user.id !== u.id && (u.role === 'user' || canDo(me, 'admins.manage'));
  // Switched-off features are left out here; the server refuses them anyway.
  const on = (g: string) => hasGrant(me, g);
  const hidden = data.hidden ?? [];
  const statusActions = on('sanctions') || on('resetLinks') || canDo(me, 'roles.change');
  const pvData = pv && 'data' in pv ? pv.data : null;
  const pvError = pv && 'error' in pv && !(pv.error instanceof ApiError && pv.error.code === 'reauth_cancelled') ? errText(pv.error, t) : null;
  // Before → after, shown in the confirmation so the admin sees exactly what changes (the server's values once previewed).
  const fromTo = pvData as { from?: string; to?: string; member?: { status?: string }; balanceBefore?: number; balanceAfter?: number } | null;
  const change =
    confirm?.kind === 'suspend'
      ? t('histChange', { from: userStatusLabel(t, fromTo?.member?.status ?? u.status), to: userStatusLabel(t, 'suspended') })
      : confirm?.kind === 'unsuspend'
        ? t('histChange', { from: userStatusLabel(t, fromTo?.from ?? u.status), to: userStatusLabel(t, fromTo?.to ?? 'active') })
        : confirm?.kind === 'role'
          ? t('histChange', { from: roleLabel(t, fromTo?.from ?? u.role), to: roleLabel(t, fromTo?.to ?? confirm.role) })
          : confirm?.kind === 'chips' && fromTo?.balanceBefore !== undefined
            ? t('histChange', { from: formatChips(fromTo.balanceBefore), to: formatChips(fromTo.balanceAfter ?? fromTo.balanceBefore) })
            : null;
  const needsReason = confirm?.kind === 'unsuspend' || confirm?.kind === 'role';
  // Someone else already made this change: there is nothing left to confirm.
  const noChange = (confirm?.kind === 'unsuspend' || confirm?.kind === 'role') && !!fromTo?.from && fromTo.from === fromTo.to;
  const duplicate = confirm?.kind === 'chips' && !!(pvData as ChipPreview | null)?.duplicate;
  const closeDialog = () => {
    // An adjustment already applied under this key is done: the form starts over instead of offering it again.
    if (duplicate) clearChips();
    dismiss();
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{u.nickname}</h1>
        <Badge tone={u.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, u.status)}</Badge>
        {data.online && <Badge tone="blue">{t('online')}</Badge>}
        <Badge tone="gold">{roleLabel(t, u.role)}</Badge>
        {isVipColor(u.vipColor) && <VipTag color={u.vipColor} />}
        {!data.ledgerConsistent && <Badge tone="red">{t('ledgerMismatch')}</Badge>}
        <span className="ml-auto flex flex-wrap gap-3">
          <Link to={`/audit?targetType=user&targetId=${encodeURIComponent(u.id)}`} className="text-sm text-gold-300 hover:underline" data-testid="user-audit">{t('audit')} →</Link>
          {on('reports') && <Link to={`/reports?status=all&userId=${u.id}`} className="text-sm text-gold-300 hover:underline" data-testid="user-reports">{t('reportsOfUser')} →</Link>}
        </span>
      </div>
      <JumpNav
        testid="member-jump"
        items={[
          ...(on('chips') ? [['member-chips', t('adjustChips')] as [string, string]] : []),
          ...(statusActions ? [['member-status', t('status')] as [string, string]] : []),
          ...(on('vip') ? [['member-vip', t('vipTitle')] as [string, string]] : []),
          ['member-connections', t('connectionsTitle')],
          ['member-history', t('historyTitle')],
          ['member-ledger', t('ledger')],
        ]}
      />
      <Feedback note={note} pin />
      {error && <LoadError error={error} onRetry={reload} />}
      {kick && <KickResult r={kick} />}
      {reset && <ResetLinkResult reset={reset} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label={t('balance')} value={formatChips(u.balance)} />
        <Stat label={t('handsPlayed')} value={formatChips(data.hands.n)} sub={t('netN', { n: formatChips(data.hands.net) })} />
        <Stat label={t('openSeats')} value={data.openSeats.length} />
        <Stat label={t('lastLogin')} value={<span className="text-sm break-keep" data-testid="last-login">{u.lastLoginAt ? formatDate(u.lastLoginAt, locale) : t('notRecorded')}</span>} sub={data.online ? t('online') : undefined} />
        <Stat label={t('createdAt')} value={<span className="text-sm break-keep">{formatDate(u.createdAt, locale)}</span>} sub={<span className="break-all">{u.email}</span>} />
      </div>
      <Panel title={t('memberInfo')}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="member-info">
          <div>
            <dt className="text-xs text-ink-400">{t('language')}</dt>
            <dd className="mt-1 flex items-center gap-2"><LangBadge locale={u.locale} /> {u.locale === 'en' ? t('langEn') : t('langKo')}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">{t('birthDate')}</dt>
            <dd className="mt-1 font-mono">{u.birthDate ? <>{u.birthDate} <span className="font-sans text-xs text-ink-400">({t('ageYears', { n: ageOn(u.birthDate, isoDate()) })})</span></> : <span className="text-ink-400">{t('none')}</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">{t('emailVerified')}</dt>
            <dd className="mt-1">{u.emailVerifiedAt ? <span className="text-success">{formatDate(u.emailVerifiedAt, locale)}</span> : <span className="text-ink-400">{t('notVerified')}</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">{t('privacyConsent')}</dt>
            <dd className="mt-1">{u.privacyConsentAt ? <>{formatDate(u.privacyConsentAt, locale)} <span className="font-mono text-xs text-ink-400">v{u.privacyConsentVersion}</span></> : <span className="text-ink-400">{t('none')}</span>}</dd>
          </div>
        </dl>
      </Panel>
      {(on('chips') || statusActions) && (
      <div className="grid gap-6 lg:grid-cols-2">
        {on('chips') && (
        <Panel title={t('adjustChips')} id="member-chips" className={jumpTarget}>
          <div ref={chipForm}>
          <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); askChips(); }}>
            <Field
              label={t('amount')}
              hint={t('largeAdjustHint', { n: formatChips(LARGE_ADJUSTMENT) })}
              error={!canDo(me, 'chips.large') && Math.abs(Number(amount)) >= LARGE_ADJUSTMENT ? t('errLargeAdjustment') : null}
            >
              {(fid) => <Input id={fid} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ''))} data-testid="chip-amount" />}
            </Field>
            <Field label={t('memo')}>{(fid) => <Input id={fid} value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="chip-memo" />}</Field>
            {chipRef && <RefillRefLine r={{ type: 'free_refill', amount: chipRef.amount, createdAt: chipRef.at, seq: chipRef.seq }} onClear={() => setChipRef(null)} />}
            <p className="text-xs text-ink-400">{t('chipPreviewHint')}</p>
            <Button type="submit" disabled={!Number(amount) || memo.trim().length < 2} data-testid="chip-submit">{t('confirm')}</Button>
          </form>
          </div>
        </Panel>
        )}
        {statusActions && (
        <Panel title={t('status')} id="member-status" className={jumpTarget}>
          <div className="flex flex-col gap-3">
            {!on('sanctions') ? null : u.status === 'active' && me?.user.id !== u.id ? (
              <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); ask({ kind: 'suspend' }); }}>
                <Input placeholder={t('reason')} aria-label={t('reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button type="submit" variant="danger" disabled={reason.trim().length < 2} data-testid="suspend">{t('suspend')}</Button>
              </form>
            ) : u.status === 'suspended' ? (
              <Button variant="outline" onClick={() => ask({ kind: 'unsuspend' })} data-testid="unsuspend">{t('unsuspend')} ({u.suspendedReason})</Button>
            ) : null}
            {on('resetLinks') && <Button variant="subtle" onClick={issueReset} data-testid="reset-link">{t('resetLink')}</Button>}
            {canDo(me, 'roles.change') && me?.user.id !== u.id && (
              <div className="flex flex-wrap gap-2">
                <span className="self-center text-sm text-ink-300">{t('setRole')}:</span>
                {(['user', 'admin', 'super_admin'] as const).map((r) => (
                  <Button key={r} size="sm" variant={u.role === r ? 'gold' : 'outline'} disabled={u.role === r} onClick={() => ask({ kind: 'role', role: r })} data-testid={`role-${r}`}>{roleLabel(t, r)}</Button>
                ))}
              </div>
            )}
          </div>
        </Panel>
        )}
      </div>
      )}
      <Panel title={t('connectionsTitle')} id="member-connections" className={jumpTarget}>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2 text-sm" data-testid="user-sessions">
            {(data.sessions ?? []).length === 0 ? (
              <p className="text-ink-400">{t('noSessions')}</p>
            ) : (
              <ul className="divide-y divide-white/5">
                {data.sessions!.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                    <Badge tone={s.kind === 'admin' ? 'gold' : 'neutral'}>{s.kind === 'admin' ? t('sessionKindAdmin') : t('sessionKindUser')}</Badge>
                    <span className="text-xs text-ink-300">{t('lastSeen')} {formatDate(s.lastSeenAt, locale)}</span>
                    <span className="text-xs text-ink-400">{t('expiresAt')} {formatDate(s.expiresAt, locale)}</span>
                  </li>
                ))}
              </ul>
            )}
            {data.openSeats.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {data.openSeats.map((s) => (
                  <li key={s.id}>
                    <Link to={`/tables/${s.tableId}`} className="text-xs text-gold-300 hover:underline">#{s.seatIndex + 1} · {s.tableId} · {t('seatBuyIn', { n: formatChips(s.buyIn) })}</Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-ink-400">{t('onlineBasis')}</p>
          </div>
          {canModerate && on('disconnect') && (
            <form className="flex min-w-0 flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); ask({ kind: 'disconnect' }); }} data-testid="disconnect-form">
              <p className="text-xs text-ink-300">{t('disconnectHint')}</p>
              <Field label={t('reasonLogged')}>{(fid) => <Input id={fid} value={dReason} onChange={(e) => setDReason(e.target.value)} />}</Field>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className={`${checkbox} mt-0.5 shrink-0`} checked={removeSeat} onChange={(e) => setRemoveSeat(e.target.checked)} data-testid="remove-from-table" />
                <span>{t('removeFromTable')}</span>
              </label>
              <p className="text-xs text-ink-400">{t('seatPolicy')}</p>
              <Button type="submit" variant="danger" disabled={dReason.trim().length < 2} data-testid="disconnect">{t('disconnect')}</Button>
            </form>
          )}
        </div>
      </Panel>
      <Modal
        open={confirm !== null}
        onClose={closeDialog}
        title={
          confirm?.kind === 'suspend'
            ? t('suspend')
            : confirm?.kind === 'unsuspend'
              ? t('unsuspend')
              : confirm?.kind === 'role'
                ? t('setRole')
                : confirm?.kind === 'chips'
                  ? t('adjustChips')
                  : t('disconnect')
        }
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>{t('cancel')}</Button>
            <Button
              variant={confirm?.kind === 'unsuspend' || confirm?.kind === 'chips' ? 'gold' : 'danger'}
              onClick={apply}
              disabled={!pvData || noChange || duplicate || (needsReason && cReason.trim().length < 2)}
              data-testid="confirm-end"
            >
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {confirm?.kind === 'suspend'
              ? t('suspendConfirm', { name: u.nickname })
              : confirm?.kind === 'unsuspend'
                ? t('unsuspendConfirm', { name: u.nickname })
                : confirm?.kind === 'role'
                  ? t('roleConfirm', { name: u.nickname })
                  : confirm?.kind === 'chips'
                    ? t('chipConfirm', { name: u.nickname })
                    : t('disconnectConfirm', { name: u.nickname })}
          </p>
          {change && (
            <p className="font-semibold" data-testid="confirm-change">
              <span className="font-normal text-ink-400">{confirm?.kind === 'chips' ? t('balance') : t('changeLine')}:</span> {change}
            </p>
          )}
          {confirm && pvData !== null && <ChangePreview p={confirm} data={pvData} />}
          {confirm && !pv && <p className="text-ink-400" aria-live="polite" data-testid="preview-loading">{t('pvLoading')}</p>}
          {pvError && <p className="break-all text-danger" role="alert" data-testid="preview-error">{pvError}</p>}
          {noChange && <p className="text-danger" role="alert">{t('pvNoChange')}</p>}
          {confirm?.kind === 'unsuspend' && ((pvData as UnsuspendPreview | null)?.suspendedReason ?? u.suspendedReason) && (
            <p className="break-all text-ink-300">{t('currentSuspendReason', { r: (pvData as UnsuspendPreview | null)?.suspendedReason ?? u.suspendedReason ?? '' })}</p>
          )}
          {needsReason ? (
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={cReason} maxLength={200} onChange={(e) => setCReason(e.target.value)} data-testid="confirm-reason" />}</Field>
          ) : confirm?.kind === 'chips' ? null : (
            <p className="break-all text-ink-300">{t('reason')}: {confirm?.kind === 'suspend' ? reason : dReason}</p>
          )}
          {(confirm?.kind === 'suspend' || (confirm?.kind === 'disconnect' && removeSeat)) && <p className="text-xs text-ink-400">{t('seatPolicy')}</p>}
          {pvData !== null && <p className="text-xs text-ink-400">{t('pvBasis')}</p>}
        </div>
      </Modal>
      <MemberActivityPanel userId={u.id} />
      {data.recentTables && <RecentTablesPanel rows={data.recentTables} />}
      {data.reports && <MemberReportsPanel userId={u.id} reports={data.reports} hidden={hidden.includes('reports')} />}
      <MemberHistoryPanel key={rev} userId={u.id} />
      {on('refill') && <MemberRefillPanel key={`refill${rev}`} userId={u.id} onCorrect={correctRefill} />}
      {on('referral') && <MemberReferralPanel key={`referral${rev}`} userId={u.id} />}
      {on('settings') && <MemberSettingsPanel key={`settings${rev}`} userId={u.id} />}
      {/* A role or status change elsewhere on the page also changes what the VIP panel may do: it loads again. */}
      {on('vip') && (
        <MemberVipPanel
          key={`vip:${u.role}:${u.status}`}
          userId={u.id}
          onChanged={() => {
            setRev((n) => n + 1);
            void reload();
          }}
        />
      )}
      <Panel title={t('ledger')} id="member-ledger" className={jumpTarget}>
        {hidden.includes('ledger') && <p className="mb-2 text-xs text-ink-400" data-testid="ledger-hidden">{t('hiddenLedger')}</p>}
        <Table head={[t('time'), t('colKind'), t('amount'), t('balance'), t('memo')]}>
          {data.ledger.map((l) => (
            <tr key={l.id}>
              <td className="px-2 py-1.5 text-xs text-ink-400">{formatDate(l.createdAt, locale)}</td>
              <td className="px-2 py-1.5">{ledgerTypeLabel(t, l.type)}</td>
              <td className={`px-2 py-1.5 font-mono ${l.amount >= 0 ? 'text-success' : ''}`}>{l.amount > 0 ? '+' : ''}{formatChips(l.amount)}</td>
              <td className="px-2 py-1.5 font-mono">{formatChips(l.balanceAfter)}</td>
              <td className="px-2 py-1.5 text-xs text-ink-300">{memoLabel(t, l.memo)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}

function ResetLinkResult({ reset }: { reset: ResetLink }) {
  const { t } = useT();
  const link = reset.url;
  const lang = reset.locale === 'en' ? t('langEn') : t('langKo');
  const message = `${reset.message.subject}\n\n${reset.message.text}`;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-gold-500/30 bg-gold-500/5 p-4" data-testid="reset-result" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold text-gold-300">{t('resetLinkTitle', { m: reset.expiresInMinutes })}</h2>
        <LangBadge locale={reset.locale} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-ink-950/70 px-2 py-1.5 text-xs text-ink-100">{link}</code>
        <CopyButton text={link} label={t('copyLink')} />
      </div>
      <p className={reset.mailed ? 'text-sm text-success' : 'text-sm text-ink-200'}>{reset.mailed ? t('resetMailed', { lang }) : t('resetNotMailed', { lang })}</p>
      {!reset.mailed && (
        <div className="flex flex-col gap-2">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-950/70 p-3 font-sans text-xs leading-relaxed text-ink-200" data-testid="reset-message">{message}</pre>
          <div><CopyButton text={message} label={t('copyMessage')} /></div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ tables
interface TableRow {
  id: string; name: string; maxSeats: number; smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number; turnSeconds: number;
  isPrivate: boolean; allowSpectators: boolean; beginner: boolean; entryBlocked: boolean; handsPaused?: boolean; status: string; liveSeated: number; livePlaying: boolean; liveConnections: number; handsPlayed: number; lastIssue: string | null;
  roomType: 'official' | 'member' | 'tournament'; hostNickname: string | null;
  /** When its settings last changed; sent back with a change so one made meanwhile by another administrator is a conflict. */
  updatedAt: number;
  /** Table bots (official tables only); `liveBots` is how many of `liveSeated` are bots. */
  botsEnabled?: boolean; botLevel?: string; botStyle?: string; botMinHumans?: number; botMax?: number; botFillTo?: number; botYield?: boolean; liveBots?: number;
}
type BotForm = { botsEnabled: boolean; botLevel: BotLevel; botStyle: BotTableStyle; botMinHumans: number; botMax: number; botFillTo: number; botYield: boolean };
const BOT_DEFAULTS: BotForm = { botsEnabled: false, botLevel: 'normal', botStyle: 'auto', botMinHumans: 1, botMax: 1, botFillTo: 2, botYield: true };
/** Bot counts that still fit a table of maxSeats (the create form's size can change under them). */
const fitBots = (b: BotForm, maxSeats: number): Pick<BotForm, 'botMinHumans' | 'botMax' | 'botFillTo'> => {
  const botFillTo = Math.min(b.botFillTo, maxSeats);
  return { botFillTo, botMax: Math.min(b.botMax, maxSeats - 1), botMinHumans: Math.min(b.botMinHumans, botFillTo - 1) };
};
const BOT_ISSUE = { botFillTo: 'errBotFillTo', botMax: 'errBotMax', botMinHumans: 'errBotMinHumans' } as const;

/** The table bot settings: the same inputs when a table is created and on its page. */
function BotFields({ v, set, maxSeats, disabled }: { v: BotForm; set: (v: BotForm) => void; maxSeats: number; disabled?: boolean }) {
  const { t } = useT();
  const issues = botSettingsIssues(v, maxSeats);
  const num = (k: 'botMinHumans' | 'botMax' | 'botFillTo') => (e: React.ChangeEvent<HTMLSelectElement>) => set({ ...v, [k]: Number(e.target.value) });
  const counts = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const pick = (k: 'botMinHumans' | 'botMax' | 'botFillTo', from: number, to: number, testid: string) => (
    <Field label={t(k)}>{(id) => (
      <select id={id} className={selectCls} value={v[k]} disabled={disabled || !v.botsEnabled} onChange={num(k)} data-testid={testid}>
        {counts(from, to).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    )}</Field>
  );
  return (
    <div className="col-span-2 grid grid-cols-2 gap-3" data-testid="bot-fields">
      <label className="col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" className={checkbox} checked={v.botsEnabled} disabled={disabled} onChange={(e) => set({ ...v, botsEnabled: e.target.checked })} data-testid="bot-enabled" />
        {t('botsAllow')}
      </label>
      <Field label={t('botsLevel')}>{(id) => (
        <select id={id} className={selectCls} value={v.botLevel} disabled={disabled || !v.botsEnabled} onChange={(e) => set({ ...v, botLevel: e.target.value as BotLevel })} data-testid="bot-level">
          {BOT_LEVELS.map((l) => <option key={l} value={l}>{botLevelLabel(t, l)}</option>)}
        </select>
      )}</Field>
      <Field label={t('botsStyle')}>{(id) => (
        <select id={id} className={selectCls} value={v.botStyle} disabled={disabled || !v.botsEnabled} onChange={(e) => set({ ...v, botStyle: e.target.value as BotTableStyle })} data-testid="bot-style">
          {BOT_TABLE_STYLES.map((st) => <option key={st} value={st}>{botStyleLabel(t, st)}</option>)}
        </select>
      )}</Field>
      {pick('botMinHumans', 1, Math.min(8, maxSeats - 1), 'bot-min-humans')}
      {pick('botMax', 1, Math.min(8, maxSeats - 1), 'bot-max')}
      {pick('botFillTo', 2, maxSeats, 'bot-fill-to')}
      <label className="col-span-2 flex items-center gap-2 text-sm">
        <input type="checkbox" className={checkbox} checked={v.botYield} disabled={disabled || !v.botsEnabled} onChange={(e) => set({ ...v, botYield: e.target.checked })} data-testid="bot-yield" />
        {t('botYield')}
      </label>
      {issues.length > 0 && (
        <ul className="col-span-2 flex flex-col gap-0.5 text-xs text-danger" role="alert" data-testid="bot-issues">
          {issues.map((x) => <li key={x.message}>{t(BOT_ISSUE[x.path[0] as keyof typeof BOT_ISSUE] ?? 'errBotMax')}</li>)}
        </ul>
      )}
      <p className="col-span-2 text-xs text-ink-400">{t('botsFieldsHint')} {t('botStyleTableHint')}</p>
    </div>
  );
}

/** One colour per table state wherever a table's state is shown: open green, closing gold, closed grey. */
const TABLE_TONE = { open: 'green', closing: 'gold', closed: 'neutral' } as const;
const tableTone = (s: string) => TABLE_TONE[s as keyof typeof TABLE_TONE] ?? 'neutral';
const TABLE_STATUSES = ['active', 'open', 'closing', 'closed'] as const;

export function TablesPage() {
  const { t } = useT();
  const { api } = useAdmin();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [roomType, setRoomType] = useState('');
  const [issueOnly, setIssueOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ paged: '1', limit: String(PAGE), offset: String(offset) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (roomType) params.set('roomType', roomType);
  if (issueOnly) params.set('issue', '1');
  const { data, error, loading, reload } = useData<{ items: TableRow[]; total: number }>(`/api/admin/tables?${params}`);
  // Any change to what is searched starts again from the first page.
  const filter = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };
  const filtered = !!(q || status || roomType || issueOnly);
  const reset = () => {
    setText('');
    setQ('');
    setStatus('');
    setRoomType('');
    setIssueOnly(false);
    setOffset(0);
  };
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000, turnSeconds: 20, isPrivate: false, joinCode: '', allowSpectators: true, beginner: false, ...BOT_DEFAULTS });
  const [note, setNote] = useState<Note>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/tables', { body: { ...f, joinCode: f.isPrivate ? f.joinCode : undefined } });
      setOpen(false);
      setNote({ ok: true, text: t('saved') });
      await reload();
    } catch (x) {
      setNote({ ok: false, text: errText(x, t) });
    }
  }
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) || 0 });
  const shown = data?.items ?? [];
  const total = data?.total ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold">{t('tables')}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/tables/time-bank" className="text-sm text-gold-300 hover:underline" data-testid="time-bank-link">{t('tbManage')} →</Link>
          <Link to="/tables/social" className="text-sm text-gold-300 hover:underline" data-testid="social-link">{t('soManage')} →</Link>
          <Button onClick={() => setOpen(true)} data-testid="create-table">{t('createTable')}</Button>
        </div>
      </div>
      <Feedback note={note} />
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); filter(setQ)(text.trim()); }}>
        <Input className="min-w-0 flex-1 basis-56" placeholder={t('tableSearch')} aria-label={t('tableSearch')} value={text} maxLength={64} onChange={(e) => setText(e.target.value)} data-testid="table-q" />
        <select aria-label={t('status')} value={status} onChange={(e) => filter(setStatus)(e.target.value)} className={selectCls} data-testid="table-status">
          <option value="">{t('status')}: {t('statusAll')}</option>
          {TABLE_STATUSES.map((s) => <option key={s} value={s}>{t('status')}: {t(s === 'active' ? 'tableActive' : s)}</option>)}
        </select>
        <select aria-label={t('roomTypeLabel')} value={roomType} onChange={(e) => filter(setRoomType)(e.target.value)} className={selectCls} data-testid="table-room-type">
          <option value="">{t('roomTypeLabel')}: {t('statusAll')}</option>
          <option value="official">{t('roomTypeLabel')}: {t('officialRoom')}</option>
          <option value="member">{t('roomTypeLabel')}: {t('memberRoom')}</option>
          <option value="tournament">{t('roomTypeLabel')}: {t('tournamentRoom')}</option>
        </select>
        <label className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm">
          <input type="checkbox" className={checkbox} checked={issueOnly} onChange={(e) => filter(setIssueOnly)(e.target.checked)} data-testid="table-issue" />
          {t('issueOnly')}
        </label>
        <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
        {filtered && <Button type="button" variant="ghost" onClick={reset} data-testid="table-reset">{t('auditReset')}</Button>}
      </form>
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <Table head={[t('name'), t('status'), t('maxSeats'), t('blinds'), t('buyin'), t('colLive'), t('colHands'), '']}>
          {shown.map((tb) => (
            <tr key={tb.id}>
              <td className="px-2 py-2 font-semibold">
                <Link to={`/tables/${tb.id}`} className="inline-flex min-h-6 items-center text-gold-300 hover:underline">{tb.name}</Link> {tb.isPrivate && <Badge tone="red">{t('private')}</Badge>}
                {tb.roomType === 'member' && <Badge tone="blue" className="ml-1">{t('memberRoom')} · {tb.hostNickname ?? '—'}</Badge>}
                {tb.roomType === 'tournament' && <Badge tone="gold" className="ml-1">{t('tournamentRoom')}</Badge>}
              </td>
              <td className="px-2 py-2">
                <span className="flex flex-wrap gap-1">
                  <Badge tone={tableTone(tb.status)}>{t(tb.status as 'open')}</Badge>
                  {tb.entryBlocked && <Badge tone="red">{t('entryBlocked')}</Badge>}
                  {tb.handsPaused && <Badge tone="red">{t('pausedBadge')}</Badge>}
                  {tb.lastIssue && <span title={tb.lastIssue}><Badge tone="red">{t('lastIssue')}</Badge></span>}
                </span>
              </td>
              <td className="px-2 py-2">{tb.maxSeats}</td>
              <td className="px-2 py-2 font-mono">{tb.smallBlind}/{tb.bigBlind}</td>
              <td className="whitespace-nowrap px-2 py-2 font-mono">{tb.roomType === 'tournament' ? '—' : `${formatChips(tb.minBuyIn, true)}–${formatChips(tb.maxBuyIn, true)}`}</td>
              <td className="px-2 py-2 text-xs">{t('seatedWs', { seated: tb.liveSeated - (tb.liveBots ?? 0), ws: tb.liveConnections })} {!!tb.liveBots && <Badge tone="blue">{t('botsN', { n: tb.liveBots })}</Badge>} {tb.botsEnabled && !tb.liveBots && <Badge>{t('botsAllowedShort')}</Badge>} {tb.livePlaying && <Badge tone="green">{t('inHand')}</Badge>}</td>
              <td className="px-2 py-2">{tb.handsPlayed}</td>
              <td className="px-2 py-2"><Link to={`/tables/${tb.id}`} className="text-gold-300">{t('detail')}</Link></td>
            </tr>
          ))}
        </Table>
        {(data || !error) && <ListState loading={!data} empty={shown.length === 0}>{filtered ? t('noMatch') : t('noTables')}</ListState>}
        {total > 0 && (
          <Pager
            label={t('tables')}
            testid="tables-pager"
            range={t('auditRange', { from: offset + 1, to: offset + shown.length, total })}
            prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
            next={offset + shown.length < total ? () => setOffset(offset + PAGE) : null}
            busy={loading}
          />
        )}
      </Panel>
      <Modal open={open} onClose={() => setOpen(false)} title={t('createTable')} wide>
        <form className="grid grid-cols-2 gap-3" onSubmit={create}>
          <div className="col-span-2"><Field label={t('name')}>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field></div>
          <Field label={t('maxSeats')}>{(id) => (
            <select id={id} className="h-11 rounded-lg border border-white/10 bg-ink-850 px-3" value={f.maxSeats} onChange={(e) => setF({ ...f, ...fitBots(f, Number(e.target.value)), maxSeats: Number(e.target.value) })}>
              {[2, 6, 9].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}</Field>
          <Field label={t('turnSeconds')}>{(id) => <Input id={id} inputMode="numeric" value={f.turnSeconds} onChange={num('turnSeconds')} />}</Field>
          <Field label={t('smallBlind')}>{(id) => <Input id={id} inputMode="numeric" value={f.smallBlind} onChange={num('smallBlind')} />}</Field>
          <Field label={t('bigBlind')}>{(id) => <Input id={id} inputMode="numeric" value={f.bigBlind} onChange={num('bigBlind')} />}</Field>
          <Field label={t('minBuyIn')}>{(id) => <Input id={id} inputMode="numeric" value={f.minBuyIn} onChange={num('minBuyIn')} />}</Field>
          <Field label={t('maxBuyIn')}>{(id) => <Input id={id} inputMode="numeric" value={f.maxBuyIn} onChange={num('maxBuyIn')} />}</Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.allowSpectators} onChange={(e) => setF({ ...f, allowSpectators: e.target.checked })} /> {t('spectators')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.beginner} onChange={(e) => setF({ ...f, beginner: e.target.checked })} data-testid="table-beginner" /> {t('beginnerTable')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isPrivate} onChange={(e) => setF({ ...f, isPrivate: e.target.checked })} /> {t('private')}</label>
          {f.isPrivate && <div className="col-span-2"><Field label={t('joinCode')}>{(id) => <Input id={id} value={f.joinCode} onChange={(e) => setF({ ...f, joinCode: e.target.value })} />}</Field></div>}
          <BotFields v={f} set={(b) => setF({ ...f, ...b })} maxSeats={f.maxSeats} />
          <div className="col-span-2 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button><Button type="submit">{t('save')}</Button></div>
        </form>
      </Modal>
    </div>
  );
}

interface LiveSeat {
  seatIndex: number;
  nickname: string;
  stack: number;
  connected: boolean;
  sittingOut: boolean;
  phase?: string;
  /** Dealt into the hand being played; `folded`: folded in it at a cash table (a leave stands them up at once). */
  inHand?: boolean;
  folded?: boolean;
  leaveAfterHand?: boolean;
  timeouts?: number;
  topUp?: { state: string; amount: number; auto: boolean } | null;
  /** A table bot's level and style for the hand under way (the room plays it), and the account's own settings the room holds. */
  bot?: string | null;
  botStyle?: string;
  botProfile?: { level: string | null; style: string | null } | null;
  /** The member's time bank here: ms left, hands since the last refill (read only: no one sets it). */
  timeBank?: { ms: number; hands: number } | null;
}
/** The room's admin status (never cards). Fields after `chipsOnTable` are absent from rooms older than B2. */
interface LiveStatus {
  seats?: (LiveSeat | null)[];
  /** Empty seats the hand being played still deals to: their players folded and left mid-hand (paid), free once it ends. */
  heldSeats?: number[];
  handNumber?: number;
  handInProgress?: boolean;
  stage?: string | null;
  connections?: number;
  chipsOnTable?: number;
  paused?: boolean;
  hand?: { id: string; stage: string; actorSeat: number | null; deadline: number | null; stalled: boolean } | null;
  nextHandAt?: number | null;
  alarmAt?: number | null;
  unrecordedHands?: number;
  version?: number;
  at?: number;
  /** The service maintenance window the room knows of (active by its clock). */
  maintenance?: { startsAt: number; endsAt: number; active: boolean } | null;
  /** Table bots as the room sees them: allowed now (table setting and service policy), and when it tries a bot again after a failure. */
  bots?: { allowed: boolean; policyOn: boolean; retryAt: number | null; failures: number } | null;
  /** The running turn's clock (time bank time added included). Absent from rooms older than the time bank. */
  timer?: { turnStartedAt: number; baseMs: number; extraMs: number; deadline: number; alarmAt: number | null; lateMs: number } | null;
  /** The time bank rules of the hand being played and those the next hand gets, with banks kept for members who left. */
  timeBank?: { hand: TimeBankRulesView | null; next: TimeBankRulesView | null; policyVersion: number | null; kept: number; handUses: number } | null;
  /** The social policy version the room last read (null: none yet, the defaults) and whether it takes quick reactions. */
  social?: { policyVersion: number | null; reactions: boolean } | null;
}
interface TimeBankRulesView { version: number; initialMs: number; maxMs: number; unitMs: number; refillHands: number; refillMs: number }
interface Diagnosis {
  issues: string[];
  sessionsOnlyInD1: { id: string; userId: string; seatIndex: number; buyIn: number; nickname: string | null }[];
  seatsOnlyInRoom: { userId: string; nickname: string; phase: string; tableSessionId: string }[];
}
type TableControl = 'pause' | 'resume' | 'block' | 'unblock';
const CONTROL_HINT: Record<TableControl, 'pauseHint' | 'resumeHint' | 'blockHint' | 'unblockHint'> = { pause: 'pauseHint', resume: 'resumeHint', block: 'blockHint', unblock: 'unblockHint' };
const CONTROL_LABEL: Record<TableControl, 'pauseHands' | 'resumeHands' | 'entryBlocked' | 'unblockEntry'> = { pause: 'pauseHands', resume: 'resumeHands', block: 'entryBlocked', unblock: 'unblockEntry' };

/** The API's close preview: who is seated with how many chips (the room's stacks; null when it did not answer). */
interface ClosePreview {
  seats: { userId: string; nickname: string | null; seatIndex: number; buyIn: number; stack: number | null; inHand: boolean | null }[];
  chipsOnTable: number | null;
  handInProgress: boolean | null;
  waitlist: number | null;
  roomAnswered: boolean;
}

/**
 * An official table's table bots, saved as one change (the API checks them against the table's size). They take effect
 * between hands; the service-wide policy and the bots' log are on the bots page.
 */
function TableBotsPanel({ tb, live, act }: { tb: TableRow; live: LiveStatus | null; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const saved: BotForm = {
    botsEnabled: !!tb.botsEnabled,
    botLevel: (BOT_LEVELS as readonly string[]).includes(tb.botLevel ?? '') ? (tb.botLevel as BotLevel) : 'normal',
    botStyle: (BOT_TABLE_STYLES as readonly string[]).includes(tb.botStyle ?? '') ? (tb.botStyle as BotTableStyle) : 'auto',
    botMinHumans: tb.botMinHumans ?? 1,
    botMax: tb.botMax ?? 1,
    botFillTo: tb.botFillTo ?? 2,
    botYield: tb.botYield ?? true,
  };
  const [v, setV] = useState(saved);
  const dirty = (Object.keys(saved) as (keyof BotForm)[]).some((k) => saved[k] !== v[k]);
  const bad = botSettingsIssues(v, tb.maxSeats).length > 0;
  const closed = tb.status === 'closed';
  const b = live?.bots;
  const link = <Link to={`/bots?table=${encodeURIComponent(tb.id)}`} className="text-sm text-gold-300 hover:underline" data-testid="table-bots-link">{t('botsNav')} →</Link>;
  if (tb.roomType !== 'official') {
    return (
      <Panel title={t('botsPanel')} id="table-bots" className={jumpTarget}>
        <p className="text-sm text-ink-400">{t('botsMemberRoomNote')}</p>
      </Panel>
    );
  }
  return (
    <Panel title={t('botsPanel')} actions={link} id="table-bots" className={jumpTarget}>
      <form
        className="grid grid-cols-2 gap-3"
        data-testid="table-bots"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void act(() => api(`/api/admin/tables/${tb.id}`, { method: 'PATCH', body: { ...v, ifUpdatedAt: tb.updatedAt } }));
        }}
      >
        {b && (
          <p className="col-span-2 flex flex-wrap items-center gap-1 text-xs" data-testid="table-bots-live">
            <Badge tone={b.allowed ? 'green' : 'neutral'}>{b.allowed ? t('botsLiveAllowed') : t('botsLiveNotAllowed')}</Badge>
            {!b.policyOn && <Badge tone="gold">{t('botsPolicyOffShort')}</Badge>}
            {b.failures > 0 && <Badge tone="red">{t('botsLiveFailures', { n: b.failures, at: b.retryAt ? formatDate(b.retryAt, locale) : '—' })}</Badge>}
          </p>
        )}
        <BotFields v={v} set={setV} maxSeats={tb.maxSeats} disabled={closed} />
        <div className="col-span-2 flex flex-wrap gap-2">
          <Button type="submit" disabled={closed || !dirty || bad} data-testid="table-bots-save">{t('save')}</Button>
          {dirty && <Button type="button" variant="ghost" onClick={() => setV(saved)}>{t('cancel')}</Button>}
        </div>
      </form>
    </Panel>
  );
}

type RecoverResult = 'bot_moved' | 'timed_out' | 'rearmed' | 'none';
const RECOVER_TEXT: Record<RecoverResult, 'tbRecoverBotMoved' | 'tbRecoverTimedOut' | 'tbRecoverRearmed' | 'tbRecoverNone'> = {
  bot_moved: 'tbRecoverBotMoved',
  timed_out: 'tbRecoverTimedOut',
  rearmed: 'tbRecoverRearmed',
  none: 'tbRecoverNone',
};

/**
 * The running turn's timer and the table's time bank, read only: when the turn began, its turn time and the time bank
 * time added, the deadline, the room's alarm and how late it is; the rules of this hand and of the next (a policy change
 * shows here as a different next version). "Timer recovery" asks the room to apply its own rules now (a turn past its
 * deadline times out or its bot moves; otherwise the alarm is set again). No one's time is set here.
 */
function TimerPanel({ id, live, issues, open, onDone }: { id: string; live: LiveStatus; issues: string[]; open: boolean; onDone: (n: Note) => Promise<void> }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const tm = live.timer;
  const tb = live.timeBank;
  const unarmed = issues.includes('timer_unarmed');
  const late = !!tm && tm.lateMs > 0;
  // A turn's clock is read to the second.
  const time = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { timeStyle: 'medium' }).format(ms) : t('none'));
  const s = (ms: number) => t('tbSeconds', { n: Math.round(ms / 1000) });
  const recover = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: RecoverResult; lateMs: number }>(`/api/admin/tables/${id}/timer-recover`, { body: { reason: reason.trim() } });
      setAsk(false);
      setReason('');
      await onDone({ ok: true, text: t(RECOVER_TEXT[r.result] ?? 'tbRecoverNone') });
    } catch (e) {
      setAsk(false);
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) await onDone({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t('tbTimerTitle')} actions={<Link to="/tables/time-bank" className="text-sm text-gold-300 hover:underline">{t('tbManage')} →</Link>} id="table-timer" className={jumpTarget}>
      <div className="flex flex-col gap-3 text-sm" data-testid="table-timer" data-state={!tm ? 'idle' : unarmed ? 'unarmed' : late ? 'late' : 'ok'}>
        {!tm ? (
          <p className="text-ink-400">{t('tbNoTurn')}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-1">
              {unarmed ? <Badge tone="red">{t('tbTimerUnarmed')}</Badge> : late ? <Badge tone="gold">{t('tbTimerLate', { n: s(tm.lateMs) })}</Badge> : <Badge tone="green">{t('tbTimerOk')}</Badge>}
              {tm.extraMs > 0 && <Badge tone="blue">{t('tbExtraAdded', { n: s(tm.extraMs) })}</Badge>}
            </p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs text-ink-400">{t('tbTurnStarted')}</dt><dd>{time(tm.turnStartedAt)}</dd></div>
              <div><dt className="text-xs text-ink-400">{t('tbTurnTime')}</dt><dd className="font-mono">{s(tm.baseMs)} + {s(tm.extraMs)}</dd></div>
              <div><dt className="text-xs text-ink-400">{t('tbDeadline')}</dt><dd data-testid="timer-deadline">{time(tm.deadline)}</dd></div>
              <div><dt className="text-xs text-ink-400">{t('diagAlarm')}</dt><dd>{time(tm.alarmAt)}</dd></div>
            </dl>
          </>
        )}
        {tb && (
          <div className="flex flex-col gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs" data-testid="table-time-bank">
            <p>
              {tb.hand ? t('tbHandRules', { v: tb.hand.version, unit: s(tb.hand.unitMs), max: s(tb.hand.maxMs) }) : t('tbHandRulesOff')}
              {' · '}
              {tb.next ? t('tbNextRules', { v: tb.next.version }) : t('tbNextRulesOff')}
            </p>
            {(tb.hand?.version ?? null) !== (tb.next?.version ?? null) && <p className="text-gold-200">{t('tbPendingVersion')}</p>}
            <p className="text-ink-400">{t('tbHandUses', { n: tb.handUses, kept: tb.kept })}</p>
          </div>
        )}
        {live.social && (
          <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="table-social" data-reactions={live.social.reactions}>
            <Badge tone={live.social.reactions ? 'green' : 'neutral'}>{t(live.social.reactions ? 'soTableRules' : 'soTableRulesOff', { v: live.social.policyVersion ?? 0 })}</Badge>
            <Link to="/tables/social" className="text-gold-300 hover:underline">{t('soManage')} →</Link>
          </p>
        )}
        <div className="flex flex-col gap-1">
          <Button variant={unarmed || late ? 'gold' : 'outline'} disabled={!open} onClick={() => setAsk(true)} data-testid="timer-recover">{t('tbRecover')}</Button>
          <p className="text-xs text-ink-400">{t('tbRecoverHint')}</p>
        </div>
      </div>
      <Modal
        open={ask}
        onClose={() => setAsk(false)}
        title={t('tbRecover')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(false)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={recover} data-testid="timer-recover-confirm">{t('confirm')}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{t('tbRecoverConfirm')}</p>
          <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="timer-recover-reason" />}</Field>
        </div>
      </Modal>
    </Panel>
  );
}

/** A header badge that jumps to the panel behind it (`to`: its id), or the badge alone. */
function BadgeLink({ to, testid, children }: { to: string | null; testid?: string; children: ReactNode }) {
  if (!to) return <>{children}</>;
  return <a href={`#${to}`} className="inline-flex min-h-6 items-center rounded-full hover:brightness-125" data-testid={testid}>{children}</a>;
}

export function TableDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, error, reload } = useData<{ table: TableRow; live: LiveStatus | null; diagnosis?: Diagnosis | null; tournament?: { id: string; name: string; status: string } | null }>(`/api/admin/tables/${id}`);
  const [note, setNote] = useState<Note>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closePv, setClosePv] = useState<{ data: ClosePreview } | { error: unknown } | null>(null);
  const closeSeq = useRef(0);
  const [control, setControl] = useState<TableControl | null>(null);
  const [cReason, setCReason] = useState('');
  const [edit, setEdit] = useState<{ smallBlind?: number; bigBlind?: number; minBuyIn?: number; maxBuyIn?: number }>({});
  // Bumped after a conflict so the blinds form starts again from the reloaded values (its inputs are uncontrolled).
  const [blindsForm, setBlindsForm] = useState(0);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNote({ ok: true, text: t('saved') });
      await reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setNote({ ok: false, text: errText(e, t) });
      // Another administrator changed the table: show what it is now, to check before saving again. The typed blinds
      // go with it, so what the form shows is what a second save sends.
      if (e instanceof ApiError && e.code === 'table_conflict') {
        await reload();
        setEdit({});
        setBlindsForm((n) => n + 1);
      }
    }
  };
  const runControl = async (action: TableControl) => {
    setControl(null);
    setNote(null);
    try {
      const r = await api<{ paused: boolean; handInProgress: boolean }>(`/api/admin/tables/${id}/control`, { body: { action, reason: cReason } });
      setNote({ ok: true, text: action === 'pause' && r.handInProgress ? `${t('saved')} ${t('pausedAfterHand')}` : t('saved') });
      setCReason('');
      await reload();
    } catch (e) {
      setNote({ ok: false, text: errText(e, t) });
      await reload();
    }
  };
  // Closing shows who is cashed out first; the password is asked when it is confirmed.
  const askClose = () => {
    setConfirmClose(true);
    setClosePv(null);
    const seq = ++closeSeq.current;
    api<ClosePreview>(`/api/admin/tables/${id}/close`, { body: { preview: true } }).then(
      (d) => seq === closeSeq.current && setClosePv({ data: d }),
      (e: unknown) => seq === closeSeq.current && setClosePv({ error: e }),
    );
  };
  const endClose = () => {
    closeSeq.current++;
    setConfirmClose(false);
    setClosePv(null);
  };
  if (!data) return <PageState error={error} onRetry={reload} />;
  const tb = data.table;
  const live = data.live;
  const diag = data.diagnosis;
  const time = (ms: number | null | undefined) => (ms ? formatDate(ms, locale) : t('none'));
  const controllable = tb.status === 'open';
  // A tournament's table is paused, closed and set up from its tournament (the API refuses these here: tournament_table).
  const tn = tb.roomType === 'tournament' ? (data.tournament ?? null) : null;
  const tnTable = tb.roomType === 'tournament';
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{tb.name}</h1>
        <Badge tone={tableTone(tb.status)}>{t(tb.status as 'open')}</Badge>
        {/* A state the emergency controls set links to them; the last problem to the diagnosis that shows it in full. */}
        {tb.handsPaused && <BadgeLink to={tnTable ? null : 'table-emergency'}><Badge tone="red">{t('pausedBadge')}</Badge></BadgeLink>}
        {tb.entryBlocked && <BadgeLink to={tnTable ? null : 'table-emergency'}><Badge tone="red">{t('entryBlockedShort')}</Badge></BadgeLink>}
        {live?.maintenance?.active && <Badge tone="gold">{t('maintStateActive')}</Badge>}
        {tb.lastIssue && <BadgeLink to="table-diagnosis" testid="last-issue-link"><Badge tone="red">{t('lastIssue')}</Badge></BadgeLink>}
        {tnTable && <Badge tone="gold">{t('tournamentRoom')}</Badge>}
      </div>
      <JumpNav
        testid="table-jump"
        items={[
          ['table-live', t('live')],
          [tnTable ? 'table-tournament' : 'table-emergency', tnTable ? t('tnTableTitle') : t('emergencyTitle')],
          ...(live || tb.lastIssue ? [['table-diagnosis', t('diagnosisTitle')] as [string, string]] : []),
          ...(live ? [['table-timer', t('tbTimerTitle')] as [string, string]] : []),
          ...(tnTable ? [] : [['table-settings', t('blinds')], ['table-bots', t('botsPanel')]] as [string, string][]),
        ]}
      />
      <Feedback note={note} pin />
      {error && <LoadError error={error} onRetry={reload} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('live')} id="table-live" className={jumpTarget}>
          {!live ? <Empty>—</Empty> : (
            <div className="flex flex-col gap-2 text-sm">
              <div>{t('liveLine', { n: live.handNumber ?? 0, state: live.handInProgress ? stageLabel(t, live.stage) : t('idleState'), ws: live.connections ?? 0, chips: formatChips(live.chipsOnTable ?? 0) })}</div>
              <ul className="divide-y divide-white/5">
                {live.seats?.map((s, i) => !s ? (
                  live.heldSeats?.includes(i) && (
                    <li key={i} className="flex items-center gap-1 py-1.5 text-ink-400" data-testid={`held-seat-${i}`}>
                      #{i + 1} <Badge>{t('seatHeldByHand')}</Badge>
                    </li>
                  )
                ) : (
                  <li key={i} className="flex justify-between gap-2 py-1.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-1">
                      #{s.seatIndex + 1} {s.nickname}
                      {s.bot && <Badge tone="blue">{t('botBadge')} · {botLevelLabel(t, s.bot)}{s.botStyle ? ` · ${botStyleLabel(t, s.botStyle)}` : ''}</Badge>}
                      {!s.connected && <Badge>{t('offline')}</Badge>}
                      {s.sittingOut && <Badge>{t('sittingOut')}</Badge>}
                      {s.phase && s.phase !== 'seated' && <Badge tone="gold">{seatPhaseLabel(t, s.phase)}</Badge>}
                      {/* Leaving: folded (stood up at once; still here, the cash-out is being retried), still to act in the hand
                          (folds at their turn, or stands up after it all in), or between hands. */}
                      {s.leaveAfterHand && (
                        <Badge tone={s.folded ? 'gold' : undefined}>{t(s.folded ? 'leaveFolded' : s.inHand ? 'leaveAtTurn' : 'leaveAfterHand')}</Badge>
                      )}
                      {!!s.timeouts && <Badge>{t('timeoutsN', { n: s.timeouts })}</Badge>}
                      {s.topUp && <Badge tone="blue">{t('topUpN', { amount: formatChips(s.topUp.amount), state: topUpStateLabel(t, s.topUp.state) })}</Badge>}
                      {s.timeBank && <Badge>{t('tbSeatBank', { n: Math.floor(s.timeBank.ms / 1000) })}</Badge>}
                    </span>
                    <span className="shrink-0 font-mono">{formatChips(s.stack)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-400">{t('holeCardsHidden')}</p>
            </div>
          )}
        </Panel>
        {tnTable ? (
          <Panel title={t('tnTableTitle')} id="table-tournament" className={jumpTarget}>
            <div className="flex flex-col gap-3 text-sm" data-testid="tn-table-panel">
              {tn && (
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{tn.name}</span>
                  <Badge tone={tn.status === 'running' ? 'green' : tn.status === 'aborted' ? 'red' : 'neutral'}>{tnStatusLabel(t, tn.status)}</Badge>
                </p>
              )}
              <p className="text-ink-300">{t('tnTableBody')}</p>
              {tn && <Link to={`/tournaments/${tn.id}`} className="self-start text-gold-300 hover:underline" data-testid="tn-table-tournament">{t('tnTableLink')} →</Link>}
            </div>
          </Panel>
        ) : (
        <Panel title={t('emergencyTitle')} id="table-emergency" className={jumpTarget}>
          <div className="flex flex-col gap-3" data-testid="emergency">
            <Field label={t('reasonLogged')}>{(fid) => <Input id={fid} value={cReason} onChange={(e) => setCReason(e.target.value)} disabled={!controllable} data-testid="control-reason" />}</Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Button variant={tb.handsPaused ? 'gold' : 'outline'} disabled={!controllable || cReason.trim().length < 2} onClick={() => setControl(tb.handsPaused ? 'resume' : 'pause')} data-testid="toggle-pause">
                {tb.handsPaused ? t('resumeHands') : t('pauseHands')}
              </Button>
              <Button variant="outline" disabled={!controllable || cReason.trim().length < 2} onClick={() => setControl(tb.entryBlocked ? 'unblock' : 'block')} data-testid="toggle-block">
                {tb.entryBlocked ? t('unblockEntry') : t('entryBlocked')}
              </Button>
            </div>
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink-400">
              <li>{t('pauseHint')}</li>
              <li>{t('blockHint')}</li>
              <li>{t('closeHint')}</li>
            </ul>
            <Button variant="danger" disabled={tb.status !== 'open'} onClick={askClose} data-testid="close-table">{t('closeTable')}</Button>
          </div>
        </Panel>
        )}
      </div>
      {(live || tb.lastIssue) && (
        <Panel title={t('diagnosisTitle')} id="table-diagnosis" className={jumpTarget}>
          <div className="flex flex-col gap-3 text-sm" data-testid="diagnosis">
            {live && (diag && diag.issues.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {diag.issues.map((x) => (
                  <li key={x} className="flex items-start gap-2 text-danger"><span aria-hidden>●</span><span>{tableIssueLabel(t, x)}</span></li>
                ))}
              </ul>
            ) : (
              <p className="text-success">{t('noDiagIssues')}</p>
            ))}
            {/* The room's last failed operation as it recorded it (its time first), even while the room does not answer. */}
            {tb.lastIssue && (
              <div data-testid="last-issue">
                <h3 className="text-xs font-semibold text-ink-300">{t('lastIssue')}</h3>
                <p className="mt-1 break-all font-mono text-xs text-[#f0a0a2]">{tb.lastIssue}</p>
              </div>
            )}
            {live && (<>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="sr-only">{t('colHand')}</dt>
                <dd>{live.hand ? t('diagHand', { stage: stageLabel(t, live.hand.stage), seat: live.hand.actorSeat === null ? '—' : live.hand.actorSeat + 1, deadline: time(live.hand.deadline) }) : t('idleState')}</dd>
              </div>
              <div><dt className="text-xs text-ink-400">{t('diagNextHand')}</dt><dd>{time(live.nextHandAt)}</dd></div>
              <div><dt className="text-xs text-ink-400">{t('diagAlarm')}</dt><dd>{time(live.alarmAt)}</dd></div>
              <div><dt className="text-xs text-ink-400">{t('diagUnrecorded')}</dt><dd className="font-mono">{live.unrecordedHands ?? 0}</dd></div>
              <div><dt className="text-xs text-ink-400">{t('diagVersion')}</dt><dd className="font-mono">{live.version ?? '—'}</dd></div>
            </dl>
            {diag && diag.sessionsOnlyInD1.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-ink-300">{t('onlyInD1')}</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {diag.sessionsOnlyInD1.map((s) => (
                    <li key={s.id}><Link to={`/users/${s.userId}`} className="text-gold-300 hover:underline">#{s.seatIndex + 1} {s.nickname ?? s.userId}</Link> <span className="font-mono text-xs text-ink-400">{t('seatBuyIn', { n: formatChips(s.buyIn) })} · {s.id}</span></li>
                  ))}
                </ul>
              </div>
            )}
            {diag && diag.seatsOnlyInRoom.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-ink-300">{t('onlyInRoom')}</h3>
                <ul className="mt-1 flex flex-col gap-1">
                  {diag.seatsOnlyInRoom.map((s) => (
                    <li key={s.tableSessionId}><Link to={`/users/${s.userId}`} className="text-gold-300 hover:underline">{s.nickname}</Link> <span className="font-mono text-xs text-ink-400">{s.tableSessionId}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-ink-400">{t('diagBasis', { time: time(live.at) })} {t('diagCompare')}</p>
            </>)}
          </div>
        </Panel>
      )}
      {live && (
        <TimerPanel
          id={id}
          live={live}
          issues={diag?.issues ?? []}
          open={controllable}
          onDone={async (n) => {
            setNote(n);
            await reload();
          }}
        />
      )}
      {!tnTable && (
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('blinds')} id="table-settings" className={jumpTarget}>
          <form key={blindsForm} data-testid="table-blinds" className="grid grid-cols-2 gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void act(() => api(`/api/admin/tables/${id}`, { method: 'PATCH', body: { ...edit, ifUpdatedAt: tb.updatedAt } })); }}>
            {(['smallBlind', 'bigBlind', 'minBuyIn', 'maxBuyIn'] as const).map((k) => (
              <Field key={k} label={t(k)}>{(fid) => <Input id={fid} inputMode="numeric" defaultValue={tb[k]} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) || undefined })} />}</Field>
            ))}
            <p className="col-span-2 text-xs text-ink-400">{t('appliesNextHand')}</p>
            <div className="col-span-2 flex flex-wrap gap-2">
              <Button type="submit" disabled={tb.status === 'closed'}>{t('save')}</Button>
              <Button type="button" variant="outline" disabled={tb.status === 'closed'} onClick={() => act(() => api(`/api/admin/tables/${id}`, { method: 'PATCH', body: { allowSpectators: !tb.allowSpectators, ifUpdatedAt: tb.updatedAt } }))}>{t('spectators')}: {tb.allowSpectators ? t('yes') : t('no')}</Button>
              <Button type="button" variant="outline" disabled={tb.status === 'closed'} onClick={() => act(() => api(`/api/admin/tables/${id}`, { method: 'PATCH', body: { beginner: !tb.beginner, ifUpdatedAt: tb.updatedAt } }))}>{t('beginnerTable')}: {tb.beginner ? t('yes') : t('no')}</Button>
            </div>
          </form>
        </Panel>
        <TableBotsPanel key={[tb.botsEnabled, tb.botLevel, tb.botStyle, tb.botMinHumans, tb.botMax, tb.botFillTo, tb.botYield].join(':')} tb={tb} live={live} act={act} />
      </div>
      )}
      <div className="flex flex-wrap gap-4">
        <Link to={`/hands?tableId=${id}`} className="text-sm text-gold-300">{t('hands')} →</Link>
        <Link to={`/audit?targetType=table&targetId=${encodeURIComponent(id)}`} className="text-sm text-gold-300" data-testid="table-audit">{t('audit')} →</Link>
      </div>
      <Modal
        open={confirmClose}
        onClose={endClose}
        title={t('closeTable')}
        footer={
          <>
            <Button variant="ghost" onClick={endClose}>{t('cancel')}</Button>
            <Button
              variant="danger"
              disabled={!closePv || !('data' in closePv)}
              onClick={() => {
                endClose();
                void act(() => api(`/api/admin/tables/${id}/close`, { body: {} }));
              }}
              data-testid="confirm-close"
            >
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{t('closeConfirm')}</p>
          {!closePv && <p className="text-ink-400" aria-live="polite">{t('pvLoading')}</p>}
          {closePv && 'error' in closePv && !(closePv.error instanceof ApiError && closePv.error.code === 'reauth_cancelled') && (
            <p className="break-all text-danger" role="alert">{errText(closePv.error, t)}</p>
          )}
          {closePv && 'data' in closePv && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2" data-testid="close-preview">
              {!closePv.data.roomAnswered && <p className="text-danger" role="alert">{t('pvRoomSilent')}</p>}
              {closePv.data.handInProgress && <p className="text-gold-300">{t('pvHandRunning')}</p>}
              <p>{closePv.data.seats.length === 0 ? t('pvNoSeated') : t('pvSeated', { n: closePv.data.seats.length })}</p>
              {closePv.data.seats.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs text-ink-300">
                  {closePv.data.seats.map((s) => (
                    <li key={s.userId} className="flex flex-wrap items-center gap-x-2">
                      <span>#{s.seatIndex + 1} {s.nickname ?? s.userId}</span>
                      <span className="font-mono">{t('pvStack', { chips: s.stack === null ? '—' : formatChips(s.stack) })}</span>
                      <span>{t('seatBuyIn', { n: formatChips(s.buyIn) })}</span>
                      {s.inHand && <Badge tone="gold">{t('pvInHand')}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
              {closePv.data.chipsOnTable !== null && <p>{t('pvChipsOnTable', { chips: formatChips(closePv.data.chipsOnTable) })}</p>}
              {!!closePv.data.waitlist && <p>{t('pvWaitlist', { n: closePv.data.waitlist })}</p>}
              <p className="text-xs text-ink-400">{t('pvBasis')}</p>
            </div>
          )}
        </div>
      </Modal>
      <Modal
        open={control !== null}
        onClose={() => setControl(null)}
        title={control ? t(CONTROL_LABEL[control]) : ''}
        footer={<><Button variant="ghost" onClick={() => setControl(null)}>{t('cancel')}</Button><Button variant="danger" onClick={() => control && void runControl(control)} data-testid="confirm-control">{t('confirm')}</Button></>}
      >
        <div className="flex flex-col gap-2 text-sm">
          {control && <p>{t(CONTROL_HINT[control])}</p>}
          <p className="break-all text-ink-300">{t('reason')}: {cReason}</p>
        </div>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ hands (audit)
/** A keyset page of the API (ledger, hands): `next` is the cursor of the following page; `member` whom it is narrowed to. */
interface KeysetPage<T> {
  items: T[];
  next: string | null;
  member: { id: string; nickname: string } | null;
}
const chipCls = 'rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300';

/**
 * A list read cursor by cursor with its filters in the URL (a link opens it filtered): the cursors of the pages passed,
 * for "previous", start over whenever a filter changes.
 */
function useKeysetFilters(keys: readonly string[]) {
  const [params, setParams] = useSearchParams();
  const filterKey = keys.map((k) => `${k}=${params.get(k) ?? ''}`).join('&');
  const [pages, setPages] = useState<{ key: string; stack: string[] }>({ key: filterKey, stack: [] });
  const stack = pages.key === filterKey ? pages.stack : [];
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };
  return {
    params,
    set,
    filtered: keys.some((k) => params.get(k)),
    reset: () => set(Object.fromEntries(keys.map((k) => [k, null]))),
    cursor: stack[stack.length - 1] ?? null,
    depth: stack.length,
    prev: stack.length ? () => setPages({ key: filterKey, stack: stack.slice(0, -1) }) : null,
    nextOf: (next: string | null | undefined) => (next ? () => setPages({ key: filterKey, stack: [...stack, next] }) : null),
  };
}

/** The member box of the ledger and hand lists: an id, email or nickname, applied on submit. */
function MemberFilter({ value, onApply }: { value: string; onApply: (v: string) => void }) {
  const { t } = useT();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <form className="flex min-w-0 flex-1 basis-64 gap-2" onSubmit={(e) => { e.preventDefault(); onApply(text.trim()); }}>
      <Input className="min-w-0 flex-1" placeholder={t('search')} aria-label={t('memberFilter')} value={text} maxLength={254} onChange={(e) => setText(e.target.value)} data-testid="member-q" />
      <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
    </form>
  );
}

const HAND_KEYS = ['tableId', 'member'] as const;

export function HandsPage() {
  const { t, locale } = useT();
  const f = useKeysetFilters(HAND_KEYS);
  const tableId = f.params.get('tableId') ?? '';
  const member = f.params.get('member') ?? '';
  const q = new URLSearchParams({ paged: '1', limit: String(PAGE) });
  if (tableId) q.set('tableId', tableId);
  if (member) q.set('member', member);
  if (f.cursor) q.set('cursor', f.cursor);
  const { data, error, loading, reload } = useData<KeysetPage<{ id: string; tableId: string; tableName: string | null; handNumber: number; endedAt: number; board: string[]; potTotal: number }>>(`/api/admin/hands?${q}`);
  const shown = data?.items ?? [];
  const first = f.depth * PAGE + 1;
  const tableName = data?.items.find((h) => h.tableId === tableId)?.tableName ?? tableId;
  return (
    <div className="flex flex-col gap-4" data-testid="hands-page">
      <h1 className="text-xl font-extrabold">{t('hands')}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <MemberFilter value={member} onApply={(v) => f.set({ member: v })} />
        {tableId && (
          <button className={chipCls} onClick={() => f.set({ tableId: null })} data-testid="table-chip">
            {t('colTable')}: {tableName} <XIcon className="inline size-3 align-[-2px]" />
          </button>
        )}
        {member && data?.member && !loading && (
          <Link to={`/users/${data.member.id}`} className={chipCls} data-testid="member-chip">{t('colUser')}: {data.member.nickname} →</Link>
        )}
        {f.filtered && <Button size="sm" variant="ghost" onClick={f.reset} data-testid="hands-reset">{t('auditReset')}</Button>}
      </div>
      <p className="text-xs text-ink-400">{t('handsAccessNote')}</p>
      {member && data && !data.member && !loading && <p className="text-sm text-gold-300" role="status" data-testid="member-none">{t('memberNotFound', { q: member })}</p>}
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <Table head={[t('time'), t('colTable'), '#', t('colBoard'), t('colPot'), '']}>
          {shown.map((h) => (
            <tr key={h.id}>
              <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-400">{formatDate(h.endedAt, locale)}</td>
              <td className="px-2 py-1.5">
                <button className="text-left hover:underline" onClick={() => f.set({ tableId: h.tableId })} title={t('auditOnlyThis')}>{h.tableName ?? <span className="font-mono text-xs">{h.tableId}</span>}</button>
              </td>
              <td className="px-2 py-1.5">{h.handNumber}</td>
              <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">{h.board.join(' ') || '—'}</td>
              <td className="px-2 py-1.5 font-mono">{formatChips(h.potTotal)}</td>
              <td className="px-2 py-1.5"><Link className="text-gold-300" to={`/hands/${encodeURIComponent(h.id)}`}>{t('detail')}</Link></td>
            </tr>
          ))}
        </Table>
        {(data || !error) && <ListState loading={!data} empty={shown.length === 0}>{f.filtered ? t('noMatch') : t('noHands')}</ListState>}
        {data && (shown.length > 0 || f.depth > 0) && (
          <Pager label={t('hands')} testid="hands-pager" range={t('auditRangeNoTotal', { from: first, to: first + shown.length - 1 })} prev={f.prev} next={f.nextOf(data.next)} busy={loading} />
        )}
      </Panel>
    </div>
  );
}

interface HandAudit {
  hand: { id: string; tableId: string; handNumber: number; endedAt: number; board: string[]; potTotal: number; engineVersion: string };
  actions: { seatIndex: number; stage: string; type: string; amount: number }[];
  players: { userId: string; nickname: string; seatIndex: number; holeCards: string[]; stackStart: number; stackEnd: number; net: number; won: number; rankClass: string | null; bestFive: string[] | null; wentToShowdown: boolean }[];
  settlementBalanced: boolean;
}

export function HandDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useT();
  const { data, error, reload } = useData<HandAudit>(`/api/admin/hands/${encodeURIComponent(id)}`);
  if (!data) return <PageState error={error} onRetry={reload} />;
  const nick = (s: number) => data.players.find((p) => p.seatIndex === s)?.nickname ?? `#${s + 1}`;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-extrabold">{t('handN', { n: data.hand.handNumber })} <span className="text-sm text-ink-400">{data.hand.tableId} · {formatDate(data.hand.endedAt, locale)}</span></h1>
      <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-[#f3b0b2]">{t('sensitive')}</p>
      <Panel title={t('boardTitle')} actions={<Badge tone={data.settlementBalanced ? 'green' : 'red'}>{data.settlementBalanced ? t('settlementOk') : t('settlementBad')}</Badge>}>
        <div className="flex gap-1">{data.hand.board.map((c) => <PlayingCard key={c} card={c as Card} size="2.6rem" />)}</div>
        <p className="mt-2 text-xs text-ink-400">{t('potEngine', { pot: formatChips(data.hand.potTotal), v: data.hand.engineVersion })}</p>
      </Panel>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('playersTitle')}>
          <ul className="divide-y divide-white/5 text-sm">
            {data.players.map((p) => (
              <li key={p.userId} className="flex items-center gap-2 py-2">
                <span className="w-6 text-xs text-ink-400">#{p.seatIndex + 1}</span>
                <span className="flex gap-0.5">{p.holeCards.map((c) => <PlayingCard key={c} card={c as Card} size="1.6rem" />)}</span>
                <Link to={`/users/${p.userId}`} className="flex-1 truncate text-gold-300">{p.nickname}</Link>
                <span className="text-xs text-ink-300">{handRankLabel(t, p.rankClass, p.bestFive)}</span>
                <span className="font-mono">{p.net > 0 ? '+' : ''}{formatChips(p.net)}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('actionsTitle')}>
          <ol className="text-sm">{data.actions.map((a, i) => <li key={i} className="flex gap-2"><span className="w-16 text-xs text-ink-400">{stageLabel(t, a.stage)}</span><span className="flex-1">{nick(a.seatIndex)}</span><span>{actionLabel(t, a.type)}</span><span className="w-14 text-right font-mono">{a.amount || ''}</span></li>)}</ol>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ ledger, reconcile, audit
const LEDGER_KEYS = ['member', 'type', 'from', 'to'] as const;
const LEDGER_TYPES = ['signup_grant', 'free_refill', 'buy_in', 'top_up', 'cash_out', 'admin_adjust', 'reconcile', 'bot_fund', 'referral'] as const;

/**
 * The chip ledger, newest first, page by page. Every look (with its filters and page) is recorded in the audit log by
 * the API: it is every member's balance history.
 */
export function LedgerPage() {
  const { t, locale } = useT();
  const f = useKeysetFilters(LEDGER_KEYS);
  const member = f.params.get('member') ?? '';
  const type = f.params.get('type') ?? '';
  const q = new URLSearchParams({ paged: '1', limit: String(PAGE) });
  if (member) q.set('member', member);
  if (type) q.set('type', type);
  const from = dayStart(f.params.get('from'));
  const to = dayStart(f.params.get('to'), true);
  if (from) q.set('from', String(from));
  if (to) q.set('to', String(to));
  if (f.cursor) q.set('cursor', f.cursor);
  const { data, error, loading, reload } = useData<KeysetPage<{ id: string; nickname: string; userId: string; type: string; amount: number; balanceAfter: number; tableId: string | null; memo: string | null; createdAt: number }>>(`/api/admin/ledger?${q}`);
  const shown = data?.items ?? [];
  const first = f.depth * PAGE + 1;
  return (
    <div className="flex flex-col gap-4" data-testid="ledger-page">
      <h1 className="text-xl font-extrabold">{t('ledger')}</h1>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <MemberFilter value={member} onApply={(v) => f.set({ member: v })} />
          <select value={type} onChange={(e) => f.set({ type: e.target.value })} className={selectCls} aria-label={t('colKind')} data-testid="ledger-type">
            <option value="">{t('colKind')}: {t('statusAll')}</option>
            {LEDGER_TYPES.map((v) => <option key={v} value={v}>{t('colKind')}: {ledgerTypeLabel(t, v)}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-ink-300">
            {t('auditFrom')}
            <input type="date" className={selectCls} value={f.params.get('from') ?? ''} max={f.params.get('to') ?? undefined} onChange={(e) => f.set({ from: e.target.value })} data-testid="ledger-from" />
          </label>
          <label className="flex items-center gap-1 text-xs text-ink-300">
            {t('auditTo')}
            <input type="date" className={selectCls} value={f.params.get('to') ?? ''} min={f.params.get('from') ?? undefined} onChange={(e) => f.set({ to: e.target.value })} data-testid="ledger-to" />
          </label>
        </div>
        {(f.filtered || (member && data?.member)) && (
          <div className="flex flex-wrap items-center gap-2">
            {member && data?.member && !loading && (
              <Link to={`/users/${data.member.id}`} className={chipCls} data-testid="member-chip">{t('colUser')}: {data.member.nickname} →</Link>
            )}
            {f.filtered && <Button size="sm" variant="ghost" onClick={f.reset} data-testid="ledger-reset">{t('auditReset')}</Button>}
          </div>
        )}
      </div>
      <p className="text-xs text-ink-400" data-testid="ledger-note">{t('ledgerAccessNote')}</p>
      {member && data && !data.member && !loading && <p className="text-sm text-gold-300" role="status" data-testid="member-none">{t('memberNotFound', { q: member })}</p>}
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        <Table head={[t('time'), t('colUser'), t('colKind'), t('amount'), t('balance'), t('colTable'), t('memo')]}>
          {shown.map((l) => (
            <tr key={l.id} data-testid="ledger-row">
              <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-400">{formatDate(l.createdAt, locale)}</td>
              <td className="px-2 py-1.5">
                <button className="text-left hover:underline" onClick={() => f.set({ member: l.userId })} title={t('auditOnlyThis')}>{l.nickname}</button>
                <Link to={`/users/${l.userId}`} className="ml-1 text-gold-300" aria-label={t('detail')}><ArrowRightIcon className="inline size-3.5 align-[-2px]" /></Link>
              </td>
              <td className="px-2 py-1.5">
                <button className="text-left hover:underline" onClick={() => f.set({ type: l.type })} title={t('auditOnlyThis')}>{ledgerTypeLabel(t, l.type)}</button>
              </td>
              <td className={`whitespace-nowrap px-2 py-1.5 font-mono ${l.amount >= 0 ? 'text-success' : ''}`}>{l.amount > 0 ? '+' : ''}{formatChips(l.amount)}</td>
              <td className="whitespace-nowrap px-2 py-1.5 font-mono">{formatChips(l.balanceAfter)}</td>
              <td className="px-2 py-1.5 text-xs">{l.tableId ? <Link to={`/tables/${l.tableId}`} className="font-mono text-gold-300 hover:underline">{l.tableId}</Link> : '—'}</td>
              <td className="px-2 py-1.5 text-xs text-ink-300">{memoLabel(t, l.memo)}</td>
            </tr>
          ))}
        </Table>
        {(data || !error) && <ListState loading={!data} empty={shown.length === 0}>{f.filtered ? t('noMatch') : t('noLedger')}</ListState>}
        {data && (shown.length > 0 || f.depth > 0) && (
          <Pager label={t('ledger')} testid="ledger-pager" range={t('auditRangeNoTotal', { from: first, to: first + shown.length - 1 })} prev={f.prev} next={f.nextOf(data.next)} busy={loading} />
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ academy (anonymous aggregates)
/** The item's name in the console's language, with the tracked id underneath (an unnamed id is shown as it is). */
function AcademyItem({ kind, id }: { kind: AcademyItemKind; id: string }) {
  const { locale } = useT();
  const name = academyItemName(kind, id, locale);
  if (!name) return <span className="font-mono text-xs">{id}</span>;
  return (
    <>
      <span className="block">{name}</span>
      <span className="font-mono text-[10px] text-ink-400">{id}</span>
    </>
  );
}

export function AcademyStatsPage() {
  const { t } = useT();
  const { data, error, reload } = useData<{ kind: 'lesson' | 'question' | 'scenario'; itemId: string; starts: number; completes: number; correct: number; wrong: number }[]>('/api/admin/academy/stats');
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const funnel = (data ?? []).filter((r) => r.kind !== 'question' && r.starts > 0).sort((a, b) => b.starts - b.completes - (a.starts - a.completes));
  const hard = (data ?? []).filter((r) => r.kind === 'question' && r.correct + r.wrong > 0).sort((a, b) => b.wrong / (b.correct + b.wrong) - a.wrong / (a.correct + a.wrong)).slice(0, 30);
  return (
    <div className="flex flex-col gap-4" data-testid="academy-stats">
      <h1 className="text-xl font-extrabold">{t('academy')}</h1>
      <p className="text-xs text-ink-400">{t('academyNote')}</p>
      {error && <LoadError error={error} onRetry={reload} />}
      <Panel title={t('lessonsFunnel')}>
        {funnel.length === 0 ? <ListState loading={!data && !error} empty>—</ListState> : (
          <Table head={[t('colKind'), t('colItem'), t('starts'), t('completes'), t('dropRate')]}>
            {funnel.map((r) => (
              <tr key={`${r.kind}:${r.itemId}`}>
                <td className="px-2 py-1.5 text-xs text-ink-400">{academyKindLabel(t, r.kind)}</td>
                <td className="px-2 py-1.5"><AcademyItem kind={r.kind} id={r.itemId} /></td>
                <td className="px-2 py-1.5 font-mono">{r.starts}</td>
                <td className="px-2 py-1.5 font-mono">{r.completes}</td>
                <td className="px-2 py-1.5 font-mono">{pct(Math.max(0, r.starts - r.completes), r.starts)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <Panel title={t('questionsHard')}>
        {hard.length === 0 ? <ListState loading={!data && !error} empty>—</ListState> : (
          <Table head={[t('colItem'), t('correctN'), t('wrongN'), t('wrongRate')]}>
            {hard.map((r) => (
              <tr key={`${r.kind}:${r.itemId}`}>
                <td className="px-2 py-1.5"><AcademyItem kind={r.kind} id={r.itemId} /></td>
                <td className="px-2 py-1.5 font-mono">{r.correct}</td>
                <td className="px-2 py-1.5 font-mono">{r.wrong}</td>
                <td className="px-2 py-1.5 font-mono">{pct(r.wrong, r.correct + r.wrong)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
