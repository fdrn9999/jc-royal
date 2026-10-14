import { handLabelKey, NICKNAME_RE, type HandSummaryDto, type LedgerEntryDto, type MeDto, type StatsDto } from '@jc/types';
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Modal, Panel, PlayingCard, Stat, type ThemeId } from '@jc/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SettingsModal } from '../game/Panels';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';

type Card = Parameters<typeof PlayingCard>[0]['card'];

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
    } catch {
      setError(true);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

function signed(n: number) {
  return `${n > 0 ? '+' : ''}${formatChips(n)}`;
}

export function MePage() {
  const { t, locale, err } = useI18n();
  const { me, setMe, logout } = useAuth();
  const nav = useNavigate();
  const stats = useLoad<StatsDto>('/api/me/stats');
  const hands = useLoad<HandSummaryDto[]>('/api/me/hands?limit=15');
  const ledger = useLoad<LedgerEntryDto[]>('/api/me/ledger?limit=20');
  const sessions = useLoad<{ id: string; createdAt: number; lastSeenAt: number; userAgent: string | null; current: boolean }[]>('/api/auth/me/sessions');
  const [nickname, setNickname] = useState(me?.nickname ?? '');
  const [avatarUrl, setAvatarUrl] = useState(me?.avatarUrl ?? '');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  if (!me) return null;

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setProfileMsg(null);
    try {
      const body: Record<string, unknown> = {};
      if (nickname !== me!.nickname) body.nickname = nickname;
      if ((avatarUrl || null) !== me!.avatarUrl) body.avatarUrl = avatarUrl || null;
      const updated = await api<MeDto>('/api/auth/me', { method: 'PATCH', body });
      setMe(updated);
      setProfileMsg(t('me.saved'));
    } catch (x) {
      setProfileMsg(err(x instanceof ApiError ? x.code : null));
    }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    try {
      await api('/api/auth/me/password', { body: { currentPassword: pw.current, newPassword: pw.next } });
      setPw({ current: '', next: '' });
      setPwMsg(t('me.saved'));
      void sessions.reload();
    } catch (x) {
      setPwMsg(err(x instanceof ApiError ? x.code : null));
    }
  }
  async function deleteAccount() {
    setDelErr(null);
    try {
      await api('/api/auth/me/delete', { body: { password: delPw } });
      await logout().catch(() => undefined);
      nav('/login', { replace: true });
    } catch (x) {
      setDelErr(err(x instanceof ApiError ? x.code : null));
    }
  }

  const st = stats.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="grid size-20 place-items-center overflow-hidden rounded-full border-2 border-gold-500/50 bg-ink-700 text-2xl font-bold text-gold-300">
          {me.avatarUrl ? <img src={me.avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : me.nickname.slice(0, 2)}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold">{me.nickname}</h1>
          <div className="text-sm text-ink-300">{me.email}</div>
          <div className="text-xs text-ink-400">{t('me.memberSince', { date: formatDate(me.createdAt, locale) })}</div>
        </div>
        <div className="sm:ml-auto">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-400">{t('common.balance')}</div>
          <div className="font-mono text-3xl font-semibold text-gold-300 tabular-nums" data-testid="me-balance">
            {formatChips(me.balance)}
          </div>
        </div>
      </div>

      <Panel title={t('me.stats')}>
        {st ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('me.handsPlayed')} value={formatChips(st.handsPlayed)} />
            <Stat label={t('me.handsWon')} value={formatChips(st.handsWon)} sub={`${t('me.winRate')} ${st.winRate}%`} />
            <Stat label={t('me.totalWon')} value={formatChips(st.totalWon)} sub={`${t('me.biggest')} ${formatChips(st.biggestPot)}`} />
            <Stat label={t('me.net')} value={<span className={st.netChips >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}>{signed(st.netChips)}</span>} />
            <div className="col-span-2 rounded-xl border border-white/5 bg-ink-850/80 px-4 py-3 md:col-span-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">{t('me.bestHand')}</div>
              {st.bestHand ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="font-semibold text-gold-300">{t(`hand.${handLabelKey(st.bestHand.rankClass, st.bestHand.cards)}` as MsgKey)}</span>
                  <span className="flex gap-1">
                    {st.bestHand.cards.map((c) => (
                      <PlayingCard key={c} card={c as Card} size="2rem" />
                    ))}
                  </span>
                </div>
              ) : (
                <div className="mt-1 text-sm text-ink-400">{t('me.none')}</div>
              )}
            </div>
          </div>
        ) : (
          <Empty>{t('common.loading')}</Empty>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('me.recent')}>
          {hands.data && hands.data.length === 0 && <Empty>{t('me.none')}</Empty>}
          <ul className="divide-y divide-white/5">
            {hands.data?.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2.5">
                <span className="flex gap-0.5">
                  {h.holeCards.map((c) => (
                    <PlayingCard key={c} card={c as Card} size="1.6rem" />
                  ))}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{h.tableName}</div>
                  <div className="text-xs text-ink-400">
                    #{h.handNumber} · {formatDate(h.endedAt, locale)}
                    {h.rankClass && ` · ${t(`hand.${handLabelKey(h.rankClass, [])}` as MsgKey)}`}
                  </div>
                </div>
                <span className={`font-mono text-sm font-semibold tabular-nums ${h.net >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}`}>{signed(h.net)}</span>
                <Link to={`/me/hands/${encodeURIComponent(h.id)}`} className="text-xs text-gold-300 hover:underline">
                  {t('me.viewHand')}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={t('me.ledger')}>
          {ledger.data && ledger.data.length === 0 && <Empty>{t('me.none')}</Empty>}
          <ul className="divide-y divide-white/5" data-testid="ledger">
            {ledger.data?.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <Badge tone={l.amount >= 0 ? 'green' : 'neutral'}>{t(`ledger.${l.type}` as MsgKey)}</Badge>
                  <div className="mt-1 text-xs text-ink-400">{formatDate(l.createdAt, locale)}</div>
                </div>
                <div className="text-right">
                  <div className={`font-mono font-semibold tabular-nums ${l.amount >= 0 ? 'text-[#9fd8b6]' : 'text-ink-100'}`}>{signed(l.amount)}</div>
                  <div className="font-mono text-xs text-ink-400">{formatChips(l.balanceAfter)}</div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('me.profile')} actions={<Button size="sm" variant="subtle" onClick={() => setSettings(true)}>{t('settings.title')}</Button>}>
          <form className="flex flex-col gap-4" onSubmit={saveProfile}>
            <Field label={t('auth.nickname')} hint={t('auth.nicknameHint')}>
              {(id) => <Input id={id} value={nickname} maxLength={16} onChange={(e) => setNickname(e.target.value.trim())} />}
            </Field>
            <Field label={t('me.avatarUrl')}>{(id) => <Input id={id} value={avatarUrl} placeholder="https://" onChange={(e) => setAvatarUrl(e.target.value.trim())} />}</Field>
            {profileMsg && <p className="text-sm text-gold-300">{profileMsg}</p>}
            <Button type="submit" disabled={!NICKNAME_RE.test(nickname)}>
              {t('common.save')}
            </Button>
          </form>
        </Panel>

        <Panel title={t('me.account')}>
          <form className="flex flex-col gap-3" onSubmit={changePassword}>
            <h3 className="text-sm font-semibold">{t('me.changePassword')}</h3>
            <Input type="password" placeholder={t('me.currentPassword')} autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <Input type="password" placeholder={t('auth.newPassword')} autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            {pwMsg && <p className="text-sm text-gold-300">{pwMsg}</p>}
            <Button type="submit" variant="outline" disabled={!pw.current || pw.next.length < 8}>
              {t('me.changePassword')}
            </Button>
          </form>
          <div className="jc-divider my-5" />
          <h3 className="mb-2 text-sm font-semibold">{t('me.sessions')}</h3>
          <ul className="flex flex-col gap-2">
            {sessions.data?.map((ss) => (
              <li key={ss.id} className="flex items-center justify-between gap-2 rounded-lg bg-black/25 px-3 py-2 text-xs">
                <span className="min-w-0 truncate text-ink-300">
                  {ss.current && <Badge tone="gold" className="mr-2">{t('me.thisDevice')}</Badge>}
                  {ss.userAgent?.slice(0, 60) ?? '—'} · {formatDate(ss.lastSeenAt, locale)}
                </span>
                {!ss.current && (
                  <button className="shrink-0 text-gold-300 hover:underline" onClick={async () => { await api(`/api/auth/me/sessions/${ss.id}`, { method: 'DELETE' }); void sessions.reload(); }}>
                    {t('me.revoke')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="jc-divider my-5" />
          <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
            {t('me.delete')}
          </Button>
        </Panel>
      </div>

      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t('me.delete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={!delPw} onClick={deleteAccount}>{t('me.delete')}</Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-200">{t('me.deleteConfirm')}</p>
        <Input type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} autoComplete="current-password" />
        {delErr && <p className="mt-2 text-sm text-danger">{delErr}</p>}
      </Modal>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

interface HandDetail {
  id: string;
  handNumber: number;
  board: string[];
  potTotal: number;
  endedAt: number;
  actions: { seatIndex: number; stage: string; type: string; amount: number }[];
  players: { seatIndex: number; nickname: string; isYou: boolean; holeCards: string[] | null; stackStart: number; net: number; won: number; rankClass: string | null }[];
}

export function HandDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const { data, error } = useLoad<HandDetail>(`/api/me/hands/${encodeURIComponent(id)}`);
  if (error) return <Empty>{t('notFound')}</Empty>;
  if (!data) return <Empty>{t('common.loading')}</Empty>;
  const name = (seat: number) => data.players.find((p) => p.seatIndex === seat)?.nickname ?? `#${seat + 1}`;
  const actionText = (type: string) => (['post-sb', 'post-bb', 'timeout-fold', 'timeout-check'].includes(type) ? t(`replay.${type}` as MsgKey) : t(`action.${type}` as MsgKey));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-[0.04em] jc-gold-text">{t('replay.title', { n: data.handNumber })}</h1>
        <Link to="/me" className="text-sm text-gold-300 hover:underline">← {t('nav.me')}</Link>
      </div>
      <Panel title={t('replay.board')} actions={<span className="font-mono text-sm text-gold-300">{t('table.pot')} {formatChips(data.potTotal)}</span>}>
        <div className="flex gap-1.5">{data.board.length ? data.board.map((c) => <PlayingCard key={c} card={c as Card} size="2.8rem" />) : <span className="text-sm text-ink-400">—</span>}</div>
        <div className="mt-2 text-xs text-ink-400">{formatDate(data.endedAt, locale)}</div>
      </Panel>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t('lobby.players')}>
          <ul className="divide-y divide-white/5">
            {data.players.map((p) => (
              <li key={p.seatIndex} className="flex items-center gap-3 py-2.5">
                <span className="w-6 text-xs text-ink-400">#{p.seatIndex + 1}</span>
                <span className="flex gap-0.5">{(p.holeCards ?? [null, null]).map((c, i) => <PlayingCard key={i} card={(c as Card) ?? null} size="1.7rem" />)}</span>
                <span className={`min-w-0 flex-1 truncate text-sm ${p.isYou ? 'font-semibold text-gold-300' : ''}`}>{p.nickname}</span>
                {p.rankClass && <span className="text-xs text-ink-300">{t(`hand.${handLabelKey(p.rankClass, [])}` as MsgKey)}</span>}
                <span className={`font-mono text-sm tabular-nums ${p.net >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}`}>{signed(p.net)}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('replay.actions')}>
          <ol className="flex flex-col gap-1 text-sm">
            {data.actions.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-16 shrink-0 text-xs uppercase text-ink-400">{t(`stage.${a.stage}` as MsgKey)}</span>
                <span className="flex-1">{name(a.seatIndex)}</span>
                <span className="text-ink-200">{actionText(a.type)}</span>
                <span className="w-16 text-right font-mono text-gold-300">{a.amount > 0 ? formatChips(a.amount) : ''}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

export type { ThemeId };
