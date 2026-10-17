/**
 * Social administration (the API's routes/admin-social.ts): quick reactions at the tables and their limits, and which
 * staff badges other players see; who changed the policy and when, and how far a change reaches.
 *
 * Nothing about one member is set here: badges follow each member's role (changed only on their page), and this decides
 * only whether players are shown them. The console itself always shows real roles.
 */
import { Badge, Button, Empty, Field, formatDate, Input, Panel, Stat } from '@jc/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useT, type Key } from '../i18n';
import { roleLabel, type Tr } from '../labels';
import { ApiError, canDo, errText, useAdmin, useData } from '../lib';
import { Feedback, LoadError, Modal, PageState, type Note } from '../ui';
import { Table } from './Console';

interface Settings { reactionsEnabled: boolean; cooldownMs: number; burstMax: number; burstWindowMs: number; showSuperAdmin: boolean; showAdmin: boolean }
interface Policy extends Settings { version: number }
interface Version extends Policy { change: string; actorId: string | null; actorNickname: string | null; reason: string | null; createdAt: number }
type Range = { min: number; max: number };
type Limits = Record<'cooldownMs' | 'burstMax' | 'burstWindowMs', Range>;
type Role = 'super_admin' | 'admin';
interface Effects { reactions: 'same' | 'on' | 'off'; limits: boolean; badgesShown: Role[]; badgesHidden: Role[] }
interface Overview {
  now: number;
  policy: Version | null;
  versions: Version[];
  limits: Limits;
  defaults: Settings;
  appliesFrom: 'next_request';
  tables: { live: number; connections: number; reloadMax: number };
}
interface Preview { from: Policy | null; to: Policy; effects: Effects; tables: number; more: boolean }

const td = 'px-2 py-1.5';
/** Seconds as typed (0.5 steps are allowed) → whole milliseconds. */
const ms = (v: string) => Math.round(Number(v) * 1000);
const sec = (t: Tr, n: number) => t('soSeconds', { n: Number((n / 1000).toFixed(1)) });
const limitsText = (t: Tr, p: Settings) => `${sec(t, p.cooldownMs)} · ${t('soBurstRule', { n: p.burstMax, sec: Number((p.burstWindowMs / 1000).toFixed(1)) })}`;
function badgesText(t: Tr, p: Settings) {
  if (p.showSuperAdmin && p.showAdmin) return t('soBadgesBoth');
  if (!p.showSuperAdmin && !p.showAdmin) return t('soBadgesNone');
  return t('soBadgesOnly', { role: roleLabel(t, p.showSuperAdmin ? 'super_admin' : 'admin') });
}

function PolicyBadges({ p }: { p: Settings }) {
  const { t } = useT();
  return (
    <>
      <Badge tone={p.reactionsEnabled ? 'green' : 'neutral'}>{t('soReactions')}: {p.reactionsEnabled ? t('refillOn') : t('refillOff')}</Badge>
      <Badge tone={p.showSuperAdmin && p.showAdmin ? 'blue' : 'neutral'}>{badgesText(t, p)}</Badge>
    </>
  );
}

export function SocialPage() {
  const { t } = useT();
  const { me } = useAdmin();
  const overview = useData<Overview>('/api/admin/social');
  const [note, setNote] = useState<Note>(null);
  const superAdmin = canDo(me, 'social.policy');
  const changed = async (n: Note) => {
    setNote(n);
    await overview.reload();
  };
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('soTitle')}</h1>
      <Link to="/tables" className="text-sm text-gold-300 hover:underline">{t('tables')} →</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void overview.reload()} loading={overview.loading} data-testid="so-reload">{t('refresh')}</Button>
    </div>
  );
  if (!overview.data) return <div className="flex flex-col gap-4">{header}<PageState error={overview.error} onRetry={overview.reload} /></div>;
  const o = overview.data;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-sm text-ink-300">{t('soIntro')}</p>
      <Feedback note={note} testid="so-feedback" />
      {overview.error && <LoadError error={overview.error} onRetry={overview.reload} />}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Panel title={t('refillPolicy')}>
          <PolicyView o={o} />
        </Panel>
        <Panel title={t('refillEdit')}>
          {superAdmin ? (
            // A new version starts the form again from what is now in force.
            <PolicyForm key={o.policy?.version ?? 0} o={o} onChanged={changed} />
          ) : (
            <p className="text-sm text-ink-400" data-testid="so-edit-super-only">{t('soEditSuperOnly')}</p>
          )}
        </Panel>
      </div>
      <Panel title={t('refillVersions')}>
        <VersionTable rows={o.versions} />
      </Panel>
    </div>
  );
}

function PolicyView({ o }: { o: Overview }) {
  const { t, locale } = useT();
  const p = o.policy;
  const shown = p ?? o.defaults;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="so-policy">
      {p ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-ink-400">{t('refillVersion', { n: p.version })}</span>
          <PolicyBadges p={p} />
        </div>
      ) : (
        <p className="text-ink-400" data-testid="so-no-policy">{t('soNoPolicy')}</p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('soReactions')} value={<span data-testid="so-reactions">{shown.reactionsEnabled ? t('refillOn') : t('refillOff')}</span>} />
        <Stat label={t('soCooldown')} value={sec(t, shown.cooldownMs)} />
        <Stat label={t('soBurst')} value={<span className="font-sans text-base break-keep">{t('soBurstRule', { n: shown.burstMax, sec: Number((shown.burstWindowMs / 1000).toFixed(1)) })}</span>} />
        <Stat
          label={t('soColBadges')}
          value={
            <span className="flex flex-col gap-0.5 font-sans text-sm break-keep" data-testid="so-badges">
              {(['super_admin', 'admin'] as const).map((r) => (
                <span key={r} className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="font-normal text-ink-400">{roleLabel(t, r)}</span>
                  <span className="ml-auto">{(r === 'admin' ? shown.showAdmin : shown.showSuperAdmin) ? t('soShown') : t('soHidden')}</span>
                </span>
              ))}
            </span>
          }
        />
      </div>
      {p && (
        <p className="text-xs text-ink-300">
          {t('refillLastChange', { kind: t(p.change === 'seed' ? 'refillChangeSeed' : 'refillChangePolicy'), at: formatDate(p.createdAt, locale), who: p.actorNickname ?? t('refillSystem') })}
          {p.reason ? ` · ${p.reason}` : ''}
        </p>
      )}
      <p className="rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="so-boundary">{t('soBoundary', { n: o.tables.reloadMax })}</p>
      <p className="text-xs text-ink-400" data-testid="so-tables">{t('soTables', { n: o.tables.live, c: o.tables.connections })}</p>
      <ul className="list-disc space-y-1 pl-4 text-xs text-ink-400">
        <li>{t('soServer')}</li>
        <li>{t('soWhere')}</li>
      </ul>
    </div>
  );
}

function PolicyForm({ o, onChanged }: { o: Overview; onChanged: (n: Note) => Promise<void> }) {
  const { t } = useT();
  const { api } = useAdmin();
  const base: Policy = o.policy ?? { ...o.defaults, version: 0 };
  const [reactionsEnabled, setReactions] = useState(base.reactionsEnabled);
  const [showSuperAdmin, setShowSuper] = useState(base.showSuperAdmin);
  const [showAdmin, setShowAdmin] = useState(base.showAdmin);
  const [v, setV] = useState({ cooldown: String(base.cooldownMs / 1000), burst: String(base.burstMax), window: String(base.burstWindowMs / 1000) });
  const [pv, setPv] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = o.limits;
  const next = { baseVersion: base.version, reactionsEnabled, cooldownMs: ms(v.cooldown), burstMax: Number(v.burst), burstWindowMs: ms(v.window), showSuperAdmin, showAdmin };
  const inRange = (x: number, r: Range) => Number.isInteger(x) && x >= r.min && x <= r.max;
  const bad = {
    cooldown: !v.cooldown || !inRange(next.cooldownMs, L.cooldownMs),
    burst: !v.burst || !inRange(next.burstMax, L.burstMax),
    window: !v.window || !inRange(next.burstWindowMs, L.burstWindowMs),
  };
  const anyBad = Object.values(bad).some(Boolean);
  const fail = async (e: unknown) => {
    setPv(null);
    if (e instanceof ApiError && e.code === 'reauth_cancelled') return;
    // Someone else's change came first: the page shows the policy now in force, and this form starts again from it.
    if (e instanceof ApiError && e.code === 'social_policy_conflict') return onChanged({ ok: false, text: errText(e, t) });
    setError(errText(e, t));
  };
  const preview = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setReason('');
    setBusy(true);
    try {
      setPv(await api<Preview>('/api/admin/social/policy', { method: 'PUT', body: { ...next, preview: true } }));
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ rooms: { tables: number; reached: number; more: boolean } }>('/api/admin/social/policy', { method: 'PUT', body: { ...next, reason: reason.trim() } });
      setPv(null);
      await onChanged({ ok: true, text: `${t('soSaved')} ${t('soRoomsTold', { n: r.rooms.reached, of: r.rooms.tables })}` });
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const decimal = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value.replace(/[^\d.]/g, '') });
  const whole = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value.replace(/\D/g, '') });
  const secRange = (r: Range) => t('refillRange', { min: sec(t, r.min), max: sec(t, r.max) });
  const roles = (rs: Role[]) => rs.map((r) => roleLabel(t, r)).join(', ');
  const rows: [Key, (p: Settings) => string][] = [
    ['soReactions', (p) => (p.reactionsEnabled ? t('refillOn') : t('refillOff'))],
    ['soCooldown', (p) => sec(t, p.cooldownMs)],
    ['soBurst', (p) => t('soBurstRule', { n: p.burstMax, sec: Number((p.burstWindowMs / 1000).toFixed(1)) })],
    ['soBadgeSuper', (p) => (p.showSuperAdmin ? t('soShown') : t('soHidden'))],
    ['soBadgeAdmin', (p) => (p.showAdmin ? t('soShown') : t('soHidden'))],
  ];
  const check = 'size-4 cursor-pointer accent-gold-500';
  return (
    <form className="flex flex-col gap-3" onSubmit={preview} data-testid="so-form">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className={check} checked={reactionsEnabled} onChange={(e) => setReactions(e.target.checked)} data-testid="so-enabled" />
        {t('soEnabled')}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('soCooldownSec')} hint={secRange(L.cooldownMs)} error={bad.cooldown ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="decimal" value={v.cooldown} disabled={!reactionsEnabled} onChange={decimal('cooldown')} data-testid="so-cooldown" />}
        </Field>
        <Field label={t('soBurstMax')} hint={t('refillRange', { min: L.burstMax.min, max: L.burstMax.max })} error={bad.burst ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="numeric" value={v.burst} disabled={!reactionsEnabled} onChange={whole('burst')} data-testid="so-burst" />}
        </Field>
        <Field label={t('soBurstWindowSec')} hint={secRange(L.burstWindowMs)} error={bad.window ? t('refillOutOfRange') : null}>
          {(fid) => <Input id={fid} inputMode="decimal" value={v.window} disabled={!reactionsEnabled} onChange={decimal('window')} data-testid="so-window" />}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className={check} checked={showSuperAdmin} onChange={(e) => setShowSuper(e.target.checked)} data-testid="so-show-super" />
        {t('soShowSuper')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className={check} checked={showAdmin} onChange={(e) => setShowAdmin(e.target.checked)} data-testid="so-show-admin" />
        {t('soShowAdmin')}
      </label>
      <p className="text-xs text-ink-400">{t('soEditHint')}</p>
      {error && <p className="text-sm text-danger" role="alert" data-testid="so-form-error">{error}</p>}
      <Button type="submit" disabled={anyBad} loading={busy && !pv} data-testid="so-preview">{t('refillPreviewBtn')}</Button>
      <Modal
        open={pv !== null}
        onClose={() => setPv(null)}
        title={t('refillPreviewTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPv(null)}>{t('cancel')}</Button>
            <Button variant="gold" disabled={reason.trim().length < 2} loading={busy} onClick={apply} data-testid="so-apply">{t('confirm')}</Button>
          </>
        }
      >
        {pv && (
          <div className="flex flex-col gap-3 text-sm" data-testid="so-change">
            <p className="font-mono text-xs text-ink-400">{t('refillVersionChange', { from: pv.from?.version ?? 0, to: pv.to.version })}</p>
            <ul className="flex flex-col gap-1">
              {rows.map(([k, show]) => {
                const from = show(pv.from ?? o.defaults);
                const to = show(pv.to);
                return (
                  <li key={k} className={from === to ? 'text-ink-400' : 'font-semibold'} data-changed={from !== to}>
                    <span className="font-normal text-ink-400">{t(k)}:</span> {from === to ? to : t('histChange', { from, to })}
                  </li>
                );
              })}
            </ul>
            <ul className="flex flex-col gap-1 rounded-lg border border-white/10 bg-ink-950/40 px-3 py-2 text-ink-200" data-testid="so-effects">
              {pv.effects.reactions !== 'same' && <li>{t(pv.effects.reactions === 'on' ? 'soEffOn' : 'soEffOff')}</li>}
              {pv.effects.limits && <li>{t('soEffLimits')}</li>}
              {pv.effects.badgesShown.length > 0 && <li>{t('soEffShown', { roles: roles(pv.effects.badgesShown) })}</li>}
              {pv.effects.badgesHidden.length > 0 && <li>{t('soEffHidden', { roles: roles(pv.effects.badgesHidden) })}</li>}
              <li data-testid="so-applies">{t('soApplies', { tables: pv.tables })}</li>
              {pv.more && <li className="text-gold-200">{t('soAppliesMore', { n: o.tables.reloadMax })}</li>}
            </ul>
            <Field label={t('reasonRequired')}>{(fid) => <Input id={fid} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="so-reason" />}</Field>
            <p className="text-xs text-ink-400">{t('pvBasis')}</p>
          </div>
        )}
      </Modal>
    </form>
  );
}

function VersionTable({ rows }: { rows: Version[] }) {
  const { t, locale } = useT();
  if (rows.length === 0) return <Empty>{t('noneFound')}</Empty>;
  return (
    <div data-testid="so-versions">
      <Table head={[t('refillColVersion'), t('time'), t('colKind'), t('soColReactions'), t('soColLimits'), t('soColBadges'), t('actor'), t('reason')]}>
        {rows.map((v) => (
          <tr key={v.version}>
            <td className={`${td} font-mono`}>v{v.version}</td>
            <td className={`${td} text-xs text-ink-400`}>{formatDate(v.createdAt, locale)}</td>
            <td className={td}>{t(v.change === 'seed' ? 'refillChangeSeed' : 'refillChangePolicy')}</td>
            <td className={td}><Badge tone={v.reactionsEnabled ? 'green' : 'neutral'}>{v.reactionsEnabled ? t('refillOn') : t('refillOff')}</Badge></td>
            <td className={`${td} whitespace-nowrap font-mono text-xs`}>{limitsText(t, v)}</td>
            <td className={`${td} text-xs`}>{badgesText(t, v)}</td>
            <td className={`${td} text-xs`}>{v.actorNickname ?? (v.actorId ? v.actorId : t('refillSystem'))}</td>
            <td className={`${td} break-all text-xs text-ink-300`}>{v.reason ?? ''}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
