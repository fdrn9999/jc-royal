/**
 * Console security: open console sessions (your own; a super admin sees everyone's) with a way to end them, what this
 * administrator may do, and the permission table read from the API. The table is code-defined (lib/permissions.ts in
 * the API), so this page shows it and never edits it.
 */
import { Badge, Button, Empty, formatDate, Modal, Panel } from '@jc/ui';
import { useState } from 'react';
import { useT } from '../i18n';
import { auditActionLabel, capabilityLabel, featureLabel, roleLabel } from '../labels';
import { errText, useAdmin, useData } from '../lib';
import { Table } from './Console';

interface SessionItem {
  id: string;
  user: { id: string; nickname: string; role: string };
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  ip: string | null;
  userAgent: string | null;
  reauthValidUntil: number | null;
  current: boolean;
}
type Level = 'all' | 'some' | 'none';
interface PermissionsDto {
  role: string;
  capabilities: string[];
  capabilityRoles: Record<string, string>;
  features: { feature: string; admin: Level; reauth: Level; actions: { route: string; action: string; role: string; reauth: boolean }[] }[];
}

/** Browser and system from a user agent, enough to tell sessions apart (the full string is in the tooltip). */
function device(ua: string | null): string {
  if (!ua) return '—';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

const ADMIN_LEVEL = { all: 'secAdminAll', some: 'secAdminSome', none: 'secAdminNone' } as const;
const REAUTH_LEVEL = { all: 'secReauthAll', some: 'secReauthSome', none: 'secReauthNone' } as const;

export function SecurityPage() {
  const { t, locale } = useT();
  const { api, me, refresh } = useAdmin();
  const sessions = useData<{ scope: 'all' | 'own'; items: SessionItem[] }>('/api/admin/security/sessions');
  const perms = useData<PermissionsDto>('/api/admin/security/permissions');
  const [ending, setEnding] = useState<SessionItem | 'others' | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const time = (ms: number | null | undefined) => (ms ? formatDate(ms, locale) : '—');
  const mine = sessions.data?.items.filter((s) => s.user.id === me?.user.id && !s.current).length ?? 0;

  const end = async () => {
    const target = ending;
    if (!target) return;
    setBusy(true);
    setMsg(null);
    try {
      if (target === 'others') {
        const r = await api<{ ended: number }>('/api/admin/security/sessions/end-others', { body: {} });
        setMsg({ text: t('secEndedOthers', { n: r.ended }), error: false });
      } else {
        const r = await api<{ current: boolean }>(`/api/admin/security/sessions/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
        // This browser's own session: signed out, back to the sign-in page.
        if (r.current) {
          setEnding(null);
          await refresh();
          return;
        }
        setMsg({ text: t('secEnded'), error: false });
      }
    } catch (e) {
      setMsg({ text: errText(e, t), error: true });
    } finally {
      setBusy(false);
    }
    setEnding(null);
    await sessions.reload();
  };

  return (
    <div className="flex flex-col gap-6" data-testid="security-page">
      <h1 className="text-xl font-extrabold">{t('security')}</h1>
      {msg && (
        <p className={`break-all text-sm ${msg.error ? 'text-danger' : 'text-gold-300'}`} role={msg.error ? 'alert' : 'status'} data-testid="security-msg">
          {msg.text}
        </p>
      )}
      <Panel
        title={t('secSessions')}
        actions={
          <Button size="sm" variant="outline" disabled={mine === 0 || busy} onClick={() => setEnding('others')} data-testid="end-others">
            {t('secEndOthers')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3" data-testid="admin-sessions">
          <p className="text-xs text-ink-400">{sessions.data?.scope === 'all' ? t('secSessionsAll') : t('secSessionsOwn')} {t('secSessionsNote')}</p>
          {sessions.error && <Empty>{sessions.error}</Empty>}
          {sessions.data && sessions.data.items.length === 0 ? (
            <Empty>{t('noSessions')}</Empty>
          ) : (
            <Table head={[t('actor'), t('secSignedIn'), t('lastSeen'), t('secEnds'), t('colIp'), t('secDevice'), t('secReauthUntil'), '']}>
              {sessions.data?.items.map((s) => (
                <tr key={s.id} className={s.current ? 'bg-gold-500/5' : undefined} data-testid="admin-session">
                  <td className="px-2 py-1.5">
                    <span className="flex flex-wrap items-center gap-1">
                      {s.user.nickname}
                      {s.current && <Badge tone="gold" className="whitespace-nowrap">{t('secCurrent')}</Badge>}
                    </span>
                    <span className="block text-[10px] text-ink-400">{roleLabel(t, s.user.role)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-300">{time(s.createdAt)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-300">{time(s.lastSeenAt)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-300">{time(Math.min(s.idleExpiresAt, s.absoluteExpiresAt))}</td>
                  <td className="px-2 py-1.5 font-mono text-xs">{s.ip ?? '—'}</td>
                  <td className="px-2 py-1.5 text-xs" title={s.userAgent ?? undefined}>{device(s.userAgent)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-300">{s.reauthValidUntil ? time(s.reauthValidUntil) : '—'}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button size="sm" variant={s.current ? 'outline' : 'danger'} disabled={busy} onClick={() => setEnding(s)} data-testid="end-session">
                      {s.current ? t('secSignOutHere') : t('secEnd')}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Panel>

      <Panel title={t('secMine')}>
        <div className="flex flex-col gap-3 text-sm" data-testid="my-permissions">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="gold">{roleLabel(t, me?.user.role)}</Badge>
            <span className="text-ink-300">{me?.reauthValidUntil && me.reauthValidUntil > Date.now() ? t('secReauthValid', { time: time(me.reauthValidUntil) }) : t('secReauthNotNow')}</span>
          </p>
          {perms.data && (
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {Object.keys(perms.data.capabilityRoles).map((k) => {
                const has = perms.data!.capabilities.includes(k);
                return (
                  <li key={k} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 px-3 py-1.5">
                    <span>{capabilityLabel(t, k)}</span>
                    <Badge tone={has ? 'green' : 'neutral'} className="whitespace-nowrap">{has ? t('secHas') : t('secSuperOnly')}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>

      <Panel title={t('secMatrix')}>
        <div className="flex flex-col gap-3" data-testid="permission-matrix">
          <p className="text-xs text-ink-400">{t('secMatrixNote')}</p>
          {perms.error && <Empty>{perms.error}</Empty>}
          {perms.data && (
            <Table head={[t('secFeature'), t('roleAdmin'), t('roleSuperAdmin'), t('secReauth'), t('secRestricted')]}>
              {perms.data.features.map((f) => {
                const restricted = f.actions.filter((a) => a.role === 'super_admin' || a.reauth);
                return (
                  <tr key={f.feature}>
                    <td className="px-2 py-1.5 font-semibold">{featureLabel(t, f.feature)}</td>
                    <td className="px-2 py-1.5 text-xs">
                      <Badge tone={f.admin === 'all' ? 'green' : f.admin === 'some' ? 'gold' : 'red'} className="whitespace-nowrap">{t(ADMIN_LEVEL[f.admin])}</Badge>
                    </td>
                    <td className="px-2 py-1.5 text-xs">
                      <Badge tone="green" className="whitespace-nowrap">{t('secAdminAll')}</Badge>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-ink-300">{t(REAUTH_LEVEL[f.reauth])}</td>
                    <td className="px-2 py-1.5 text-xs">
                      {restricted.length === 0 ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {restricted.map((a) => (
                            <li key={a.route} className="flex flex-wrap items-center gap-1">
                              <span>{auditActionLabel(t, a.action)}</span>
                              {a.role === 'super_admin' && <Badge tone="gold" className="whitespace-nowrap">{t('secSuperOnly')}</Badge>}
                              {a.reauth && <Badge className="whitespace-nowrap">{t('secPassword')}</Badge>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
      </Panel>

      <Panel title={t('secPolicy')}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-200" data-testid="security-policy">
          <li>{t('secNoteCode')}</li>
          <li>{t('secNotePreview')}</li>
          <li>{t('secNoteFailed')}</li>
          <li>{t('secNoteImmediate')}</li>
          <li>{t('secNoteLive')}</li>
          <li>{t('secNoteHands')}</li>
          <li>{t('secNoteAccess')}</li>
        </ul>
      </Panel>

      <Modal
        open={ending !== null}
        onClose={() => setEnding(null)}
        title={ending === 'others' ? t('secEndOthers') : ending?.current ? t('secSignOutHere') : t('secEnd')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEnding(null)}>{t('cancel')}</Button>
            <Button variant="danger" loading={busy} onClick={() => void end()} data-testid="confirm-end-session">{t('confirm')}</Button>
          </>
        }
      >
        <p className="text-sm">
          {ending === 'others'
            ? t('secEndOthersConfirm', { n: mine })
            : ending?.current
              ? t('secEndCurrentConfirm')
              : ending
                ? t('secEndConfirm', { name: ending.user.nickname, device: device(ending.userAgent), time: time(ending.lastSeenAt) })
                : ''}
        </p>
      </Modal>
    </div>
  );
}
