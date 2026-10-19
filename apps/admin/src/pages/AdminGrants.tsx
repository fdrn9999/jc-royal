/**
 * Feature switches per administrator (super admins only), on the security page under the permission table. A plain
 * administrator may use a feature when their role allows it (the table) and the switch is on; the server checks both
 * on every request, so this panel only edits the switches: against the version it read (another super admin saving
 * first is told), with a reason, the password and a preview of what opens or closes.
 */
import { Badge, Button, Empty, formatDate, Input, Panel } from '@jc/ui';
import { useEffect, useMemo, useState } from 'react';
import { useT, type Key } from '../i18n';
import { auditActionLabel, grantLabel, roleLabel, userStatusLabel } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { Feedback, ListState, LoadError, Modal, PageState, Pager, type Note } from '../ui';

type Level = 'all' | 'some' | 'none';
export interface FeatureRow {
  feature: string;
  admin: Level;
  reauth: Level;
  grant: string;
  actions: { route: string; action: string; role: string; reauth: boolean }[];
}
interface StaffItem {
  id: string;
  nickname: string;
  role: 'admin' | 'super_admin' | 'user';
  status: 'active' | 'suspended' | 'deleted';
  lastLoginAt: number | null;
  grants: string[] | null;
  version: number;
  updatedAt: number | null;
  updatedBy: { id: string; nickname: string | null } | null;
}
interface HistoryItem {
  id: string;
  action: string;
  outcome: string;
  createdAt: number;
  actor: { id: string | null; nickname: string | null; role: string | null };
  detail: { before?: string[]; after?: string[]; gained?: string[]; lost?: string[]; reason?: string; version?: number; cause?: string; from?: string; to?: string; code?: string } | null;
}
interface HistoryPage { items: HistoryItem[]; nextBefore: number | null; nextBeforeId: string | null }
interface Detail { admin: StaffItem; grantKeys: string[]; history: HistoryPage }
interface Preview { gained: string[]; lost: string[]; version: number; actions: { from: number; to: number } }

/** The switches grouped as the console's menus are. A switch the API adds later lands in the last group. */
const GROUPS: [Key, string[]][] = [
  ['grantGroupMembers', ['members', 'sanctions', 'disconnect', 'chips', 'resetLinks', 'settings', 'vip']],
  ['grantGroupCommunity', ['reports', 'board', 'notices', 'messages']],
  ['grantGroupGame', ['tables', 'tableControl', 'hands', 'tournaments', 'bots']],
  ['grantGroupEconomy', ['ledger', 'economy', 'refill', 'reconcile', 'referral']],
  ['grantGroupOps', ['dashboard', 'stats', 'maintenance']],
];
/**
 * Switches whose actions are reached from another feature's page: member actions from the member page (members), table
 * emergency control from the table page (tables). The server does not tie them together; the editor says so.
 */
const NEEDS: Record<string, string> = { sanctions: 'members', disconnect: 'members', chips: 'members', resetLinks: 'members', settings: 'members', vip: 'members', tableControl: 'tables' };
const PAGE = 20;
const selectCls = 'h-11 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((g) => b.includes(g));

export function AdminGrantsPanel({ features, grantKeys }: { features: FeatureRow[]; grantKeys: string[] }) {
  const { t, locale } = useT();
  const { api, me } = useAdmin();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(query ? { q: query } : {}), ...(role ? { role } : {}) });
  const list = useData<{ items: StaffItem[]; total: number }>(`/api/admin/security/admins?${params}`);
  const detail = useData<Detail>(selected ? `/api/admin/security/admins/${encodeURIComponent(selected)}` : null);
  const [draft, setDraft] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [older, setOlder] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<{ at: number; id: string } | null>(null);
  const time = (ms: number | null | undefined) => (ms ? formatDate(ms, locale) : '—');

  const admin = detail.data?.admin.id === selected ? detail.data.admin : null;
  const saved = admin?.grants ?? [];
  // A new administrator, or the same one at a new version (saved here or elsewhere): the editor starts from what is stored.
  useEffect(() => {
    if (!admin) return;
    setDraft(admin.grants ?? []);
    setOlder([]);
    const h = detail.data!.history;
    setCursor(h.nextBefore !== null && h.nextBeforeId ? { at: h.nextBefore, id: h.nextBeforeId } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin?.id, admin?.version, detail.data]);

  // Per switch, the features it opens and how many of their actions a plain administrator may use.
  const covers = useMemo(() => {
    const m = new Map<string, { features: string[]; actions: number }>();
    for (const f of features) {
      const e = m.get(f.grant) ?? { features: [], actions: 0 };
      e.features.push(f.feature);
      e.actions += f.actions.filter((a) => a.role === 'admin').length;
      m.set(f.grant, e);
    }
    return m;
  }, [features]);
  const usable = (on: readonly string[]) => features.reduce((n, f) => (f.grant === 'always' || on.includes(f.grant) ? n + f.actions.filter((a) => a.role === 'admin').length : n), 0);
  const groups = useMemo(() => {
    const known = GROUPS.flatMap(([, g]) => g);
    const extra = grantKeys.filter((g) => !known.includes(g));
    return GROUPS.map(([k, g], i) => [k, [...g.filter((x) => grantKeys.includes(x)), ...(i === GROUPS.length - 1 ? extra : [])]] as const);
  }, [grantKeys]);

  const editable = !!admin && admin.role === 'admin' && admin.id !== me?.user.id;
  const dirty = !!admin && !same(draft, saved);
  const toggle = (g: string) => setDraft((d) => (d.includes(g) ? d.filter((x) => x !== g) : [...d, g]));

  const pick = (id: string) => {
    setSelected(id);
    setNote(null);
    setReason('');
  };
  const search = () => {
    setOffset(0);
    setQuery(q.trim());
  };
  const send = async (dry: boolean) => {
    if (!admin) return null;
    const body = { grants: draft, baseVersion: admin.version, reason: reason.trim(), ...(dry ? { preview: true } : {}) };
    return api<Preview & { version: number }>(`/api/admin/security/admins/${encodeURIComponent(admin.id)}/grants`, { method: 'PUT', body });
  };
  const failed = async (e: unknown) => {
    setPreview(null);
    setNote({ ok: false, text: errText(e, t) });
    // Someone else saved first (or the account is no longer a plain admin): show what is stored now.
    if (e instanceof ApiError && (e.code === 'admin_grants_conflict' || e.code === 'not_plain_admin')) await Promise.all([detail.reload(), list.reload()]);
  };
  const review = async () => {
    setBusy(true);
    setNote(null);
    try {
      setPreview(await send(true));
    } catch (e) {
      await failed(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await send(false);
      setPreview(null);
      setReason('');
      setNote({ ok: true, text: t('grantsSaved', { name: admin!.nickname, v: r!.version }) });
      await Promise.all([detail.reload(), list.reload()]);
    } catch (e) {
      // Cancelling the password prompt leaves the preview open to try again.
      if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
      await failed(e);
    } finally {
      setBusy(false);
    }
  };
  const more = async () => {
    if (!cursor || !selected) return;
    setBusy(true);
    try {
      const r = await api<Detail>(`/api/admin/security/admins/${encodeURIComponent(selected)}?before=${cursor.at}&beforeId=${encodeURIComponent(cursor.id)}`);
      setOlder((o) => [...o, ...r.history.items]);
      const h = r.history;
      setCursor(h.nextBefore !== null && h.nextBeforeId ? { at: h.nextBefore, id: h.nextBeforeId } : null);
    } catch (e) {
      setNote({ ok: false, text: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const history = [...(detail.data?.history.items ?? []), ...older];
  const names = (gs: readonly string[] | undefined) => (gs && gs.length ? gs.map((g) => grantLabel(t, g)).join(', ') : t('grantsNoneOn'));

  return (
    <Panel title={t('grantsTitle')}>
      <div className="flex flex-col gap-4" data-testid="admin-grants">
        <p className="text-xs text-ink-400">{t('grantsNote')}</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <Input className="min-w-0 flex-1 basis-48" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('grantsSearch')} aria-label={t('grantsSearch')} data-testid="grants-q" />
          <select
            className={selectCls}
            value={role}
            onChange={(e) => {
              setOffset(0);
              setRole(e.target.value);
            }}
            aria-label={t('role')}
            data-testid="grants-role"
          >
            <option value="">{t('grantsRoleAll')}</option>
            <option value="admin">{t('roleAdmin')}</option>
            <option value="super_admin">{t('roleSuperAdmin')}</option>
          </select>
          <Button type="submit" variant="outline">{t('searchBtn')}</Button>
        </form>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <div className={`flex min-w-0 flex-col gap-2 ${list.loading && items.length ? 'opacity-60' : ''}`}>
            {list.error && <LoadError error={list.error} onRetry={() => void list.reload()} />}
            {!list.error && <ListState loading={list.loading} empty={items.length === 0} />}
            <ul className="flex flex-col gap-1.5" data-testid="grants-list">
              {items.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => pick(a.id)}
                    aria-pressed={a.id === selected}
                    className={`flex w-full min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-sm ${a.id === selected ? 'border-gold-500/50 bg-gold-500/10' : 'border-white/5 hover:border-white/20'}`}
                    data-testid="grants-admin"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold">{a.nickname}</span>
                      <Badge tone={a.role === 'super_admin' ? 'gold' : 'neutral'} className="whitespace-nowrap">{roleLabel(t, a.role)}</Badge>
                      {a.status === 'suspended' && <Badge tone="red" className="whitespace-nowrap">{userStatusLabel(t, 'suspended')}</Badge>}
                    </span>
                    <span className="text-xs text-ink-400">
                      {a.grants === null ? t('grantsAllOn') : a.version === 0 ? t('grantsNever') : t('grantsCount', { n: a.grants.length, total: grantKeys.length })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {total > PAGE && (
              <Pager
                label={t('grantsTitle')}
                range={`${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`}
                prev={offset > 0 ? () => setOffset(Math.max(0, offset - PAGE)) : null}
                next={offset + PAGE < total ? () => setOffset(offset + PAGE) : null}
                busy={list.loading}
                testid="grants-pager"
              />
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3" data-testid="grants-editor">
            <Feedback note={note} testid="grants-msg" />
            {!selected ? (
              <Empty>{t('grantsPick')}</Empty>
            ) : !admin ? (
              <PageState error={detail.error} onRetry={() => void detail.reload()} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-bold" data-testid="grants-name">{admin.nickname}</h3>
                  <Badge tone={admin.role === 'super_admin' ? 'gold' : 'neutral'}>{roleLabel(t, admin.role)}</Badge>
                  {admin.version > 0 && (
                    <span className="text-xs text-ink-400">{t('grantsLastChange', { v: admin.version, name: admin.updatedBy?.nickname ?? '—', time: time(admin.updatedAt) })}</span>
                  )}
                </div>
                {admin.role === 'super_admin' && <p className="text-sm text-ink-300" data-testid="grants-super">{t('grantsSuper')}</p>}
                {admin.role === 'admin' && admin.id === me?.user.id && <p className="text-sm text-ink-300" data-testid="grants-self">{t('grantsSelf')}</p>}
                {admin.role === 'admin' && admin.status === 'suspended' && <p className="text-xs text-ink-400">{t('grantsSuspended')}</p>}
                {admin.role === 'admin' && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {groups.map(([k, gs]) =>
                        gs.length === 0 ? null : (
                          <fieldset key={k} className="min-w-0 rounded-lg border border-white/5 p-3">
                            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-400">{t(k)}</legend>
                            <ul className="flex flex-col gap-2">
                              {gs.map((g) => {
                                const c = covers.get(g);
                                const others = (c?.features ?? []).filter((f) => f !== g);
                                const need = NEEDS[g];
                                const on = draft.includes(g);
                                return (
                                  <li key={g} className="min-w-0">
                                    <label className={`flex min-h-11 cursor-pointer items-start gap-2 ${editable ? '' : 'cursor-default'}`}>
                                      <input
                                        type="checkbox"
                                        className="mt-0.5 size-5 shrink-0 cursor-pointer accent-gold-500"
                                        checked={on}
                                        disabled={!editable || busy}
                                        onChange={() => toggle(g)}
                                        data-testid={`grant-${g}`}
                                      />
                                      <span className="flex min-w-0 flex-col">
                                        <span className="flex flex-wrap items-center gap-1.5 text-sm">
                                          {grantLabel(t, g)}
                                          {on !== saved.includes(g) && <Badge tone={on ? 'green' : 'red'} className="whitespace-nowrap">{on ? t('secOn') : t('secOff')}</Badge>}
                                        </span>
                                        <span className="text-[11px] text-ink-400">
                                          {t('grantActions', { n: c?.actions ?? 0 })}
                                          {others.length > 0 && ` · ${t('grantCovers', { list: others.map((f) => grantLabel(t, f)).join(', ') })}`}
                                        </span>
                                        {on && need && !draft.includes(need) && (
                                          <span className="text-[11px] text-gold-300" data-testid={`grant-needs-${g}`}>{t('grantNeeds', { needs: grantLabel(t, need) })}</span>
                                        )}
                                      </span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          </fieldset>
                        ),
                      )}
                    </div>
                    <p className="text-xs text-ink-300" data-testid="grants-effective">{t('grantsEffective', { n: usable(draft) })}</p>
                    {editable && (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="subtle" disabled={busy} onClick={() => setDraft([...grantKeys])} data-testid="grants-all">{t('grantsAll')}</Button>
                          <Button size="sm" variant="subtle" disabled={busy} onClick={() => setDraft([])} data-testid="grants-none">{t('grantsNone')}</Button>
                          <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setDraft(saved)} data-testid="grants-undo">{t('grantsUndo')}</Button>
                        </div>
                        {dirty && <p className="text-xs text-gold-300" role="status">{t('grantsUnsaved')}</p>}
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input className="min-w-0 sm:flex-1" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t('grantsReasonPh')} aria-label={t('reason')} data-testid="grants-reason" />
                          <Button disabled={!dirty || reason.trim().length < 2} loading={busy && !preview} onClick={() => void review()} data-testid="grants-review">{t('grantsReview')}</Button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                <section className="flex flex-col gap-2" data-testid="grants-history">
                  <h4 className="text-sm font-semibold">{t('grantsHistory')}</h4>
                  {history.length === 0 ? (
                    <p className="text-xs text-ink-400">{t('grantsHistoryEmpty')}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {history.map((h) => (
                        <li key={h.id} className="rounded-lg border border-white/5 px-3 py-2 text-xs" data-testid="grants-history-item">
                          <p className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold">{auditActionLabel(t, h.action)}</span>
                            {h.outcome !== 'ok' && <Badge tone="red">{t('outcomeFailed')}</Badge>}
                            <span className="text-ink-400">{h.actor.nickname ?? '—'} · {time(h.createdAt)}</span>
                          </p>
                          {h.detail?.cause === 'role' && <p className="mt-1 text-ink-300">{t('grantsByRole', { from: roleLabel(t, h.detail.from), to: roleLabel(t, h.detail.to) })}</p>}
                          {!!h.detail?.gained?.length && <p className="mt-1 text-[#9fe0b0]">+ {names(h.detail.gained)}</p>}
                          {!!h.detail?.lost?.length && h.detail.cause !== 'role' && <p className="mt-1 text-[#f3b0b2]">− {names(h.detail.lost)}</p>}
                          {h.detail?.cause === 'role' && !!h.detail.before?.length && <p className="mt-1 text-[#f3b0b2]">− {names(h.detail.before)}</p>}
                          {h.detail?.code && <p className="mt-1 font-mono text-ink-400">{h.detail.code}</p>}
                          {h.detail?.reason && <p className="mt-1 break-words text-ink-300">{t('reason')}: {h.detail.reason}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {cursor && (
                    <Button size="sm" variant="subtle" className="self-start" loading={busy} onClick={() => void more()} data-testid="grants-history-more">{t('loadMore')}</Button>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t('grantsReviewTitle', { name: admin?.nickname ?? '' })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>{t('cancel')}</Button>
            <Button loading={busy} onClick={() => void save()} data-testid="grants-save">{t('save')}</Button>
          </>
        }
      >
        {preview && (
          <div className="flex flex-col gap-3 text-sm" data-testid="grants-preview">
            {preview.gained.length > 0 && (
              <div>
                <p className="font-semibold text-[#9fe0b0]">{t('grantsGained')}</p>
                <ul className="list-disc pl-5 text-xs">{preview.gained.map((g) => <li key={g}>{grantLabel(t, g)}</li>)}</ul>
              </div>
            )}
            {preview.lost.length > 0 && (
              <div>
                <p className="font-semibold text-[#f3b0b2]">{t('grantsLost')}</p>
                <ul className="list-disc pl-5 text-xs">{preview.lost.map((g) => <li key={g}>{grantLabel(t, g)}</li>)}</ul>
              </div>
            )}
            <p className="text-xs text-ink-300">{t('grantsActionsDelta', { from: preview.actions.from, to: preview.actions.to })}</p>
            <p className="text-xs text-ink-400">{t('reason')}: {reason.trim()}</p>
            <p className="text-xs text-ink-400">{t('grantsApplies')}</p>
          </div>
        )}
      </Modal>
    </Panel>
  );
}
