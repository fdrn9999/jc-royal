import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Modal, Panel, PlayingCard, Stat } from '@jc/ui';
import { academyItemName, ageOn, isoDate, type AcademyItemKind } from '@jc/types';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useT } from '../i18n';
import {
  academyKindLabel,
  actionLabel,
  auditActionLabel,
  handRankLabel,
  ledgerTypeLabel,
  memoLabel,
  roleLabel,
  scopeLabel,
  seatOutcomeLabel,
  seatPhaseLabel,
  stageLabel,
  tableIssueLabel,
  targetTypeLabel,
  topUpStateLabel,
  userStatusLabel,
} from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';

type Card = Parameters<typeof PlayingCard>[0]['card'];
const newKey = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

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

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wider text-ink-400">
          <tr>{head.map((h, i) => <th key={i} className="border-b border-white/5 px-2 py-2 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-white/5">{children}</tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ users
interface UserRow { id: string; email: string; nickname: string; locale: Locale; role: string; status: string; balance: number; createdAt: number; online?: boolean }

const EXPORT_MAX = 1000;
const checkbox = 'size-4 cursor-pointer accent-gold-500';

export function UsersPage() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [lang, setLang] = useState<'' | Locale>('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error } = useData<UserRow[]>(`/api/admin/users?q=${encodeURIComponent(query)}${lang ? `&locale=${lang}` : ''}${onlineOnly ? '&online=1' : ''}&limit=200`);
  const shown = data ?? [];
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
    setMsg(null);
    try {
      const r = await api<{ filename: string; count: number; csv: string }>('/api/admin/users/export', { body: { userIds: [...selected] } });
      downloadCsv(r.filename, r.csv);
      setMsg(t('exported', { n: r.count }));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setMsg(errText(e, t));
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">{t('users')}</h1>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <Input className="min-w-0 flex-1 basis-56" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value as '' | Locale)} className="h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm" data-testid="lang-filter">
          <option value="">{t('allLanguages')}</option>
          <option value="ko">{t('langKo')}</option>
          <option value="en">{t('langEn')}</option>
        </select>
        <label className="flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm" title={t('onlineBasis')}>
          <input type="checkbox" className={checkbox} checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} data-testid="online-filter" />
          {t('onlineOnly')}
        </label>
        <Button type="submit" variant="subtle">{t('searchBtn')}</Button>
      </form>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-ink-900/60 px-3 py-2" data-testid="export-bar">
        <span className="text-sm font-semibold" aria-live="polite">{t('selectedN', { n: selected.size })}</span>
        {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t('clearSelection')}</Button>}
        <Button size="sm" className="ml-auto" onClick={exportCsv} loading={exporting} disabled={selected.size === 0 || selected.size > EXPORT_MAX} data-testid="export-csv">
          {t('exportCsv')}
        </Button>
        <p className="w-full text-xs text-ink-400">{t('exportHint')}</p>
      </div>
      {msg && <p className="text-sm text-gold-300" role="status">{msg}</p>}
      {error && <Empty>{error}</Empty>}
      <Panel>
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
            t('nickname'), t('email'), t('language'), t('role'), t('status'), t('balance'), t('createdAt'), '',
          ]}
        >
          {data?.map((u) => (
            <tr key={u.id} className={selected.has(u.id) ? 'bg-gold-500/5' : undefined}>
              <td className="w-8 px-2 py-2">
                <input type="checkbox" className={checkbox} aria-label={t('selectUser', { name: u.nickname })} checked={selected.has(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} />
              </td>
              <td className="px-2 py-2 font-semibold">{u.nickname}</td>
              <td className="px-2 py-2 text-ink-300">{u.email}</td>
              <td className="px-2 py-2"><LangBadge locale={u.locale} /></td>
              <td className="px-2 py-2"><Badge tone={u.role === 'user' ? 'neutral' : 'gold'}>{roleLabel(t, u.role)}</Badge></td>
              <td className="px-2 py-2">
                <Badge tone={u.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, u.status)}</Badge>
                {u.online && <Badge tone="blue" className="ml-1">{t('online')}</Badge>}
              </td>
              <td className="px-2 py-2 font-mono">{formatChips(u.balance)}</td>
              <td className="px-2 py-2 text-xs text-ink-400">{formatDate(u.createdAt, locale)}</td>
              <td className="px-2 py-2"><Link to={`/users/${u.id}`} className="text-gold-300">{t('detail')}</Link></td>
            </tr>
          ))}
        </Table>
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
  const [msg, setMsg] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [reason, setReason] = useState('');
  const [reset, setReset] = useState<ResetLink | null>(null);
  const [confirm, setConfirm] = useState<null | 'suspend' | 'disconnect'>(null);
  const [dReason, setDReason] = useState('');
  const [removeSeat, setRemoveSeat] = useState(false);
  const [kick, setKick] = useState<{ kick: KickReport; sessions?: number } | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    setReset(null);
    setKick(null);
    try {
      await fn();
      setMsg(t('saved'));
      await reload();
    } catch (e) {
      setMsg(errText(e, t));
    }
  };
  const issueReset = async () => {
    setMsg(null);
    setReset(null);
    try {
      setReset(await api<ResetLink>(`/api/admin/users/${id}/reset-link`, { body: {} }));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setMsg(errText(e, t));
    }
  };
  // Suspending and ending connections reach the member's tables: confirmed first, then the result says what each table did.
  const endConnections = (kind: 'suspend' | 'disconnect') => {
    setConfirm(null);
    void run(async () => {
      setKick(
        kind === 'suspend'
          ? await api<{ kick: KickReport }>(`/api/admin/users/${id}/suspend`, { body: { reason } })
          : await api<{ kick: KickReport; sessions: number }>(`/api/admin/users/${id}/disconnect`, { body: { reason: dReason, removeFromTable: removeSeat } }),
      );
    });
  };
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>{t('loading')}</Empty>;
  const u = data.user;
  const canModerate = me?.user.id !== u.id && (u.role === 'user' || me?.user.role === 'super_admin');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{u.nickname}</h1>
        <Badge tone={u.status === 'active' ? 'green' : 'red'}>{userStatusLabel(t, u.status)}</Badge>
        {data.online && <Badge tone="blue">{t('online')}</Badge>}
        <Badge tone="gold">{roleLabel(t, u.role)}</Badge>
        {!data.ledgerConsistent && <Badge tone="red">{t('ledgerMismatch')}</Badge>}
        <Link to={`/reports?status=all&userId=${u.id}`} className="ml-auto text-sm text-gold-300 hover:underline" data-testid="user-reports">{t('reportsOfUser')} →</Link>
      </div>
      {msg && <p className="break-all rounded-lg border border-gold-500/30 bg-gold-500/5 px-3 py-2 text-sm text-gold-300" role="status">{msg}</p>}
      {kick && <KickResult r={kick} />}
      {reset && <ResetLinkResult reset={reset} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('balance')} value={formatChips(u.balance)} />
        <Stat label={t('handsPlayed')} value={formatChips(data.hands.n)} sub={t('netN', { n: formatChips(data.hands.net) })} />
        <Stat label={t('openSeats')} value={data.openSeats.length} />
        <Stat label={t('createdAt')} value={<span className="text-sm">{formatDate(u.createdAt, locale)}</span>} sub={u.email} />
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
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('adjustChips')}>
          <form className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => api(`/api/admin/users/${id}/chips`, { body: { amount: Number(amount), memo, idempotencyKey: newKey() } })); }}>
            <Field label={t('amount')}>{(fid) => <Input id={fid} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ''))} />}</Field>
            <Field label={t('memo')}>{(fid) => <Input id={fid} value={memo} onChange={(e) => setMemo(e.target.value)} />}</Field>
            <Button type="submit" disabled={!Number(amount) || memo.trim().length < 2}>{t('confirm')}</Button>
          </form>
        </Panel>
        <Panel title={t('status')}>
          <div className="flex flex-col gap-3">
            {u.status === 'active' && me?.user.id !== u.id ? (
              <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm('suspend'); }}>
                <Input placeholder={t('reason')} aria-label={t('reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button type="submit" variant="danger" disabled={reason.trim().length < 2} data-testid="suspend">{t('suspend')}</Button>
              </form>
            ) : u.status === 'suspended' ? (
              <Button variant="outline" onClick={() => run(() => api(`/api/admin/users/${id}/unsuspend`, { body: {} }))}>{t('unsuspend')} ({u.suspendedReason})</Button>
            ) : null}
            <Button variant="subtle" onClick={issueReset} data-testid="reset-link">{t('resetLink')}</Button>
            {me?.user.role === 'super_admin' && me.user.id !== u.id && (
              <div className="flex flex-wrap gap-2">
                <span className="self-center text-sm text-ink-300">{t('setRole')}:</span>
                {(['user', 'admin', 'super_admin'] as const).map((r) => (
                  <Button key={r} size="sm" variant={u.role === r ? 'gold' : 'outline'} disabled={u.role === r} onClick={() => run(() => api(`/api/admin/users/${id}/role`, { body: { role: r } }))}>{roleLabel(t, r)}</Button>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
      <Panel title={t('connectionsTitle')}>
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
          {canModerate && (
            <form className="flex min-w-0 flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); setConfirm('disconnect'); }} data-testid="disconnect-form">
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
        onClose={() => setConfirm(null)}
        title={confirm === 'suspend' ? t('suspend') : t('disconnect')}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>{t('cancel')}</Button><Button variant="danger" onClick={() => confirm && endConnections(confirm)} data-testid="confirm-end">{t('confirm')}</Button></>}
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{confirm === 'suspend' ? t('suspendConfirm', { name: u.nickname }) : t('disconnectConfirm', { name: u.nickname })}</p>
          <p className="break-all text-ink-300">{t('reason')}: {confirm === 'suspend' ? reason : dReason}</p>
          {(confirm === 'suspend' || removeSeat) && <p className="text-xs text-ink-400">{t('seatPolicy')}</p>}
        </div>
      </Modal>
      <Panel title={t('ledger')}>
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
  roomType: 'official' | 'member'; hostNickname: string | null;
}

export function TablesPage() {
  const { t } = useT();
  const { api } = useAdmin();
  const { data, reload } = useData<TableRow[]>('/api/admin/tables');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000, turnSeconds: 20, isPrivate: false, joinCode: '', allowSpectators: true, beginner: false });
  const [msg, setMsg] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/tables', { body: { ...f, joinCode: f.isPrivate ? f.joinCode : undefined } });
      setOpen(false);
      setMsg(t('saved'));
      await reload();
    } catch (x) {
      setMsg(errText(x, t));
    }
  }
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) || 0 });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold">{t('tables')}</h1>
        <Button onClick={() => setOpen(true)} data-testid="create-table">{t('createTable')}</Button>
      </div>
      {msg && <p className="text-sm text-gold-300">{msg}</p>}
      <Panel>
        <Table head={[t('name'), t('status'), t('maxSeats'), t('blinds'), t('buyin'), t('colLive'), t('colHands'), '']}>
          {data?.map((tb) => (
            <tr key={tb.id}>
              <td className="px-2 py-2 font-semibold">
                {tb.name} {tb.isPrivate && <Badge tone="red">{t('private')}</Badge>}
                {tb.roomType === 'member' && <Badge tone="blue" className="ml-1">{t('memberRoom')} · {tb.hostNickname ?? '—'}</Badge>}
              </td>
              <td className="px-2 py-2"><Badge tone={tb.status === 'open' ? 'green' : 'neutral'}>{t(tb.status as 'open')}</Badge>{tb.entryBlocked && <Badge tone="red" className="ml-1">{t('entryBlocked')}</Badge>}{tb.handsPaused && <Badge tone="red" className="ml-1">{t('pausedBadge')}</Badge>}</td>
              <td className="px-2 py-2">{tb.maxSeats}</td>
              <td className="px-2 py-2 font-mono">{tb.smallBlind}/{tb.bigBlind}</td>
              <td className="px-2 py-2 font-mono">{formatChips(tb.minBuyIn, true)}–{formatChips(tb.maxBuyIn, true)}</td>
              <td className="px-2 py-2 text-xs">{t('seatedWs', { seated: tb.liveSeated, ws: tb.liveConnections })} {tb.livePlaying && <Badge tone="green">{t('inHand')}</Badge>}</td>
              <td className="px-2 py-2">{tb.handsPlayed}</td>
              <td className="px-2 py-2"><Link to={`/tables/${tb.id}`} className="text-gold-300">{t('detail')}</Link></td>
            </tr>
          ))}
        </Table>
      </Panel>
      <Modal open={open} onClose={() => setOpen(false)} title={t('createTable')} wide>
        <form className="grid grid-cols-2 gap-3" onSubmit={create}>
          <div className="col-span-2"><Field label={t('name')}>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field></div>
          <Field label={t('maxSeats')}>{(id) => (
            <select id={id} className="h-11 rounded-lg border border-white/10 bg-ink-850 px-3" value={f.maxSeats} onChange={(e) => setF({ ...f, maxSeats: Number(e.target.value) })}>
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
  leaveAfterHand?: boolean;
  timeouts?: number;
  topUp?: { state: string; amount: number; auto: boolean } | null;
}
/** The room's admin status (never cards). Fields after `chipsOnTable` are absent from rooms older than B2. */
interface LiveStatus {
  seats?: (LiveSeat | null)[];
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
}
interface Diagnosis {
  issues: string[];
  sessionsOnlyInD1: { id: string; userId: string; seatIndex: number; buyIn: number; nickname: string | null }[];
  seatsOnlyInRoom: { userId: string; nickname: string; phase: string; tableSessionId: string }[];
}
type TableControl = 'pause' | 'resume' | 'block' | 'unblock';
const CONTROL_HINT: Record<TableControl, 'pauseHint' | 'resumeHint' | 'blockHint' | 'unblockHint'> = { pause: 'pauseHint', resume: 'resumeHint', block: 'blockHint', unblock: 'unblockHint' };
const CONTROL_LABEL: Record<TableControl, 'pauseHands' | 'resumeHands' | 'entryBlocked' | 'unblockEntry'> = { pause: 'pauseHands', resume: 'resumeHands', block: 'entryBlocked', unblock: 'unblockEntry' };

export function TableDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, reload } = useData<{ table: TableRow; live: LiveStatus | null; diagnosis?: Diagnosis | null }>(`/api/admin/tables/${id}`);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [control, setControl] = useState<TableControl | null>(null);
  const [cReason, setCReason] = useState('');
  const [edit, setEdit] = useState<{ smallBlind?: number; bigBlind?: number; minBuyIn?: number; maxBuyIn?: number }>({});
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMsg(t('saved'));
      await reload();
    } catch (e) {
      setMsg(errText(e, t));
    }
  };
  const runControl = async (action: TableControl) => {
    setControl(null);
    setMsg(null);
    try {
      const r = await api<{ paused: boolean; handInProgress: boolean }>(`/api/admin/tables/${id}/control`, { body: { action, reason: cReason } });
      setMsg(action === 'pause' && r.handInProgress ? `${t('saved')} ${t('pausedAfterHand')}` : t('saved'));
      setCReason('');
      await reload();
    } catch (e) {
      setMsg(errText(e, t));
      await reload();
    }
  };
  if (!data) return <Empty>{t('loading')}</Empty>;
  const tb = data.table;
  const live = data.live;
  const diag = data.diagnosis;
  const time = (ms: number | null | undefined) => (ms ? formatDate(ms, locale) : t('none'));
  const controllable = tb.status === 'open';
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold">{tb.name}</h1>
        <Badge tone={tb.status === 'open' ? 'green' : 'neutral'}>{t(tb.status as 'open')}</Badge>
        {tb.handsPaused && <Badge tone="red">{t('pausedBadge')}</Badge>}
        {tb.entryBlocked && <Badge tone="red">{t('entryBlockedShort')}</Badge>}
        {tb.lastIssue && <Badge tone="red">{t('lastIssue')}: <span className="font-mono">{tb.lastIssue}</span></Badge>}
      </div>
      {msg && <p className="text-sm text-gold-300" role="status">{msg}</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('live')}>
          {!live ? <Empty>—</Empty> : (
            <div className="flex flex-col gap-2 text-sm">
              <div>{t('liveLine', { n: live.handNumber ?? 0, state: live.handInProgress ? stageLabel(t, live.stage) : t('idleState'), ws: live.connections ?? 0, chips: formatChips(live.chipsOnTable ?? 0) })}</div>
              <ul className="divide-y divide-white/5">
                {live.seats?.map((s, i) => s && (
                  <li key={i} className="flex justify-between gap-2 py-1.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-1">
                      #{s.seatIndex + 1} {s.nickname}
                      {!s.connected && <Badge>{t('offline')}</Badge>}
                      {s.sittingOut && <Badge>{t('sittingOut')}</Badge>}
                      {s.phase && s.phase !== 'seated' && <Badge tone="gold">{seatPhaseLabel(t, s.phase)}</Badge>}
                      {s.leaveAfterHand && <Badge>{t('leaveAfterHand')}</Badge>}
                      {!!s.timeouts && <Badge>{t('timeoutsN', { n: s.timeouts })}</Badge>}
                      {s.topUp && <Badge tone="blue">{t('topUpN', { amount: formatChips(s.topUp.amount), state: topUpStateLabel(t, s.topUp.state) })}</Badge>}
                    </span>
                    <span className="shrink-0 font-mono">{formatChips(s.stack)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-400">{t('holeCardsHidden')}</p>
            </div>
          )}
        </Panel>
        <Panel title={t('emergencyTitle')}>
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
            <Button variant="danger" disabled={tb.status !== 'open'} onClick={() => setConfirmClose(true)} data-testid="close-table">{t('closeTable')}</Button>
          </div>
        </Panel>
      </div>
      {live && (
        <Panel title={t('diagnosisTitle')}>
          <div className="flex flex-col gap-3 text-sm" data-testid="diagnosis">
            {diag && diag.issues.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {diag.issues.map((x) => (
                  <li key={x} className="flex items-start gap-2 text-danger"><span aria-hidden>●</span><span>{tableIssueLabel(t, x)}</span></li>
                ))}
              </ul>
            ) : (
              <p className="text-success">{t('noDiagIssues')}</p>
            )}
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
          </div>
        </Panel>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('blinds')}>
          <form className="grid grid-cols-2 gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void act(() => api(`/api/admin/tables/${id}`, { method: 'PATCH', body: edit })); }}>
            {(['smallBlind', 'bigBlind', 'minBuyIn', 'maxBuyIn'] as const).map((k) => (
              <Field key={k} label={t(k)}>{(fid) => <Input id={fid} inputMode="numeric" defaultValue={tb[k]} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) || undefined })} />}</Field>
            ))}
            <p className="col-span-2 text-xs text-ink-400">{t('appliesNextHand')}</p>
            <div className="col-span-2 flex flex-wrap gap-2">
              <Button type="submit" disabled={tb.status === 'closed'}>{t('save')}</Button>
              <Button type="button" variant="outline" disabled={tb.status === 'closed'} onClick={() => act(() => api(`/api/admin/tables/${id}`, { method: 'PATCH', body: { allowSpectators: !tb.allowSpectators } }))}>{t('spectators')}: {tb.allowSpectators ? t('yes') : t('no')}</Button>
              <Button type="button" variant="outline" disabled={tb.status === 'closed'} onClick={() => act(() => api(`/api/admin/tables/${id}`, { method: 'PATCH', body: { beginner: !tb.beginner } }))}>{t('beginnerTable')}: {tb.beginner ? t('yes') : t('no')}</Button>
            </div>
          </form>
        </Panel>
      </div>
      <Link to={`/hands?tableId=${id}`} className="text-sm text-gold-300">{t('hands')} →</Link>
      <Modal open={confirmClose} onClose={() => setConfirmClose(false)} title={t('closeTable')} footer={<><Button variant="ghost" onClick={() => setConfirmClose(false)}>{t('cancel')}</Button><Button variant="danger" onClick={() => { setConfirmClose(false); void act(() => api(`/api/admin/tables/${id}/close`, { body: {} })); }}>{t('confirm')}</Button></>}>
        <p className="text-sm">{t('closeConfirm')}</p>
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
export function HandsPage() {
  const { t, locale } = useT();
  const tableId = new URLSearchParams(location.search).get('tableId');
  const { data } = useData<{ id: string; tableId: string; handNumber: number; endedAt: number; board: string[]; potTotal: number }[]>(`/api/admin/hands${tableId ? `?tableId=${tableId}` : ''}`);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">{t('hands')}</h1>
      <Panel>
        <Table head={[t('time'), t('colTable'), '#', t('colBoard'), t('colPot'), '']}>
          {data?.map((h) => (
            <tr key={h.id}>
              <td className="px-2 py-1.5 text-xs text-ink-400">{formatDate(h.endedAt, locale)}</td>
              <td className="px-2 py-1.5">{h.tableId}</td>
              <td className="px-2 py-1.5">{h.handNumber}</td>
              <td className="px-2 py-1.5 font-mono text-xs">{h.board.join(' ') || '—'}</td>
              <td className="px-2 py-1.5 font-mono">{formatChips(h.potTotal)}</td>
              <td className="px-2 py-1.5"><Link className="text-gold-300" to={`/hands/${encodeURIComponent(h.id)}`}>{t('detail')}</Link></td>
            </tr>
          ))}
        </Table>
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
  const { data, error } = useData<HandAudit>(`/api/admin/hands/${encodeURIComponent(id)}`);
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>{t('loading')}</Empty>;
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
export function LedgerPage() {
  const { t, locale } = useT();
  const { data } = useData<{ id: string; nickname: string; userId: string; type: string; amount: number; balanceAfter: number; tableId: string | null; memo: string | null; createdAt: number }[]>('/api/admin/ledger?limit=200');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">{t('ledger')}</h1>
      <Panel>
        <Table head={[t('time'), t('colUser'), t('colKind'), t('amount'), t('balance'), t('colTable'), t('memo')]}>
          {data?.map((l) => (
            <tr key={l.id}>
              <td className="px-2 py-1.5 text-xs text-ink-400">{formatDate(l.createdAt, locale)}</td>
              <td className="px-2 py-1.5"><Link className="text-gold-300" to={`/users/${l.userId}`}>{l.nickname}</Link></td>
              <td className="px-2 py-1.5">{ledgerTypeLabel(t, l.type)}</td>
              <td className={`px-2 py-1.5 font-mono ${l.amount >= 0 ? 'text-success' : ''}`}>{l.amount > 0 ? '+' : ''}{formatChips(l.amount)}</td>
              <td className="px-2 py-1.5 font-mono">{formatChips(l.balanceAfter)}</td>
              <td className="px-2 py-1.5 text-xs">{l.tableId}</td>
              <td className="px-2 py-1.5 text-xs text-ink-300">{memoLabel(t, l.memo)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}

export function ReconcilePage() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const { data, reload } = useData<{ id: string; scope: string; subjectId: string; expected: number; actual: number; detail: string | null; resolvedAt: number | null; createdAt: number }[]>('/api/admin/reconcile');
  const [result, setResult] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold">{t('reconcile')}</h1>
        <Button onClick={async () => { const r = await api<{ mismatches: unknown[]; created: number }>('/api/admin/reconcile/run', { body: {} }); setResult(t('reconcileResult', { n: r.mismatches.length, created: r.created })); await reload(); }} data-testid="run-reconcile">{t('runReconcile')}</Button>
      </div>
      {result && <p className="text-sm text-gold-300" role="status">{result}</p>}
      <Panel>
        {data && data.length === 0 ? <Empty>—</Empty> : (
          <Table head={[t('time'), t('colScope'), t('colSubject'), t('colExpected'), t('colActual'), t('colDetail'), '']}>
            {data?.map((e) => (
              <tr key={e.id}>
                <td className="px-2 py-1.5 text-xs text-ink-400">{formatDate(e.createdAt, locale)}</td>
                <td className="px-2 py-1.5">{scopeLabel(t, e.scope)}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{e.subjectId}</td>
                <td className="px-2 py-1.5 font-mono">{e.expected}</td>
                <td className="px-2 py-1.5 font-mono">{e.actual}</td>
                <td className="px-2 py-1.5 text-xs text-ink-300">{e.detail}</td>
                <td className="px-2 py-1.5">{e.resolvedAt ? <Badge tone="green">{t('resolvedBadge')}</Badge> : (
                  <span className="flex gap-1"><Input className="h-8 w-40" placeholder={t('note')} value={note} onChange={(x) => setNote(x.target.value)} /><Button size="sm" disabled={note.trim().length < 2} onClick={async () => { await api(`/api/admin/reconcile/${e.id}/resolve`, { body: { note } }); setNote(''); await reload(); }}>{t('resolve')}</Button></span>
                )}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

export function AuditPage() {
  const { t, locale } = useT();
  const { data } = useData<{ id: string; actor: string | null; action: string; targetType: string | null; targetId: string | null; detail: unknown; ip: string | null; createdAt: number }[]>('/api/admin/audit?limit=200');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-extrabold">{t('audit')}</h1>
      <Panel>
        <Table head={[t('time'), t('actor'), t('action'), t('target'), t('colDetail'), t('colIp')]}>
          {data?.map((a) => (
            <tr key={a.id}>
              <td className="px-2 py-1.5 text-xs text-ink-400">{formatDate(a.createdAt, locale)}</td>
              <td className="px-2 py-1.5">{a.actor ?? '—'}</td>
              <td className="px-2 py-1.5 text-xs"><span className="block">{auditActionLabel(t, a.action)}</span><span className="font-mono text-[10px] text-ink-400">{a.action}</span></td>
              <td className="px-2 py-1.5 text-xs">{targetTypeLabel(t, a.targetType)} <span className="font-mono">{a.targetId}</span></td>
              <td className="max-w-[18rem] truncate px-2 py-1.5 font-mono text-[11px] text-ink-300">{a.detail ? JSON.stringify(a.detail) : ''}</td>
              <td className="px-2 py-1.5 text-xs">{a.ip}</td>
            </tr>
          ))}
        </Table>
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
  const { data } = useData<{ kind: 'lesson' | 'question' | 'scenario'; itemId: string; starts: number; completes: number; correct: number; wrong: number }[]>('/api/admin/academy/stats');
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const funnel = (data ?? []).filter((r) => r.kind !== 'question' && r.starts > 0).sort((a, b) => b.starts - b.completes - (a.starts - a.completes));
  const hard = (data ?? []).filter((r) => r.kind === 'question' && r.correct + r.wrong > 0).sort((a, b) => b.wrong / (b.correct + b.wrong) - a.wrong / (a.correct + a.wrong)).slice(0, 30);
  return (
    <div className="flex flex-col gap-4" data-testid="academy-stats">
      <h1 className="text-xl font-extrabold">{t('academy')}</h1>
      <p className="text-xs text-ink-400">{t('academyNote')}</p>
      <Panel title={t('lessonsFunnel')}>
        {funnel.length === 0 ? <Empty>—</Empty> : (
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
        {hard.length === 0 ? <Empty>—</Empty> : (
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
