import { handLabelKey, NICKNAME_RE, passwordOk, type HandDetailDto, type HandSummaryDto, type LedgerEntryDto, type MeDto, type MyCommentDto, type PostListItemDto, type StatsDto } from '@jc/types';
import { Badge, Button, Empty, Field, formatChips, formatDate, Input, Modal, Panel, PlayingCard, Stat, type ThemeId } from '@jc/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BadgeShelf } from '../academy/Badges';
import { useTr } from '../academy/content';
import { lessonLinksFor } from '../academy/handLinks';
import { useBadges } from '../academy/sync';
import { HandNotePanel, HandRow } from '../components/HandNotes';
import { MemberName } from '../components/MemberName';
import { PasswordInput, PasswordMatch, PasswordRules } from '../components/PasswordFields';
import { PositionTable, RatioStat, StatDefinitions, StatsTrend } from '../components/PlayStats';
import { ReferralCard } from '../components/Referral';
import { RefillCard } from '../components/Refill';
import { ReportModal, type ReportSubject } from '../components/Social';
import { HandReplay } from '../game/HandReplay';
import { oddsRatio, potOddsFor } from '../game/potOdds';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAmounts } from '../lib/amount';
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
  return { data, error, reload, set: setData };
}

function signed(n: number) {
  return `${n > 0 ? '+' : ''}${formatChips(n)}`;
}

export function MePage() {
  const { t, locale, err } = useI18n();
  const { me, setMe, logout } = useAuth();
  const nav = useNavigate();
  const stats = useLoad<StatsDto>('/api/me/stats');
  const badgeCount = useBadges().length;
  const hands = useLoad<HandSummaryDto[]>('/api/me/hands?limit=15');
  const ledger = useLoad<LedgerEntryDto[]>('/api/me/ledger?limit=20');
  const myPosts = useLoad<PostListItemDto[]>('/api/me/posts');
  const myComments = useLoad<MyCommentDto[]>('/api/me/comments');
  const sessions = useLoad<{ id: string; createdAt: number; lastSeenAt: number; userAgent: string | null; current: boolean }[]>('/api/auth/me/sessions');
  const [nickname, setNickname] = useState(me?.nickname ?? '');
  const [avatarUrl, setAvatarUrl] = useState(me?.avatarUrl ?? '');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState<string | null>(null);

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
      setPw({ current: '', next: '', confirm: '' });
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

      <RefillCard onClaimed={() => void ledger.reload()} />

      <ReferralCard onPaid={ledger.reload} />

      <Panel title={t('me.stats')}>
        {st ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="stats">
            <Stat label={t('me.handsPlayed')} value={formatChips(st.handsPlayed)} />
            <Stat label={t('me.handsWon')} value={formatChips(st.handsWon)} sub={`${t('me.winRate')} ${st.winRate}%`} />
            <Stat label={t('me.totalWon')} value={formatChips(st.totalWon)} sub={t('me.totalWonHint')} />
            <Stat label={t('me.net')} value={<span className={st.netChips >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}>{signed(st.netChips)}</span>} />
            <Stat label={t('me.largestPot')} value={formatChips(st.largestPot)} sub={t('me.largestPotHint')} />
            <Stat label={t('me.avgPot')} value={st.avgPot === null ? '—' : formatChips(st.avgPot)} sub={t('me.avgPotHint')} />
            <Stat label={t('me.biggestWin')} value={formatChips(st.biggestWin)} sub={t('me.biggestWinHint')} />
            <RatioStat label="VPIP" ratio={st.vpip} hint={t('me.vpipHint')} testid="stats-vpip" />
            <RatioStat label="PFR" ratio={st.pfr} hint={t('me.pfrHint')} testid="stats-pfr" />
            <RatioStat label={t('me.raiseShare')} ratio={st.raiseShare} hint={t('me.raiseShareHint')} testid="stats-raise-share" />
            <RatioStat label={t('me.wtsd')} ratio={st.wtsd} hint={t('me.wtsdHint')} testid="stats-wtsd" />
            <RatioStat label={t('me.wsd')} ratio={st.wsd} hint={t('me.wsdHint')} testid="stats-wsd" />
            <div className="col-span-2 rounded-xl border border-white/5 bg-ink-850/80 px-4 py-3 md:col-span-3">
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
            <div className="col-span-2 md:col-span-3">
              <PositionTable positions={st.positions} />
            </div>
            <div className="col-span-2 md:col-span-3">
              <StatsTrend />
            </div>
            <div className="col-span-2 md:col-span-3">
              <StatDefinitions />
            </div>
          </div>
        ) : (
          <Empty>{t('common.loading')}</Empty>
        )}
      </Panel>

      <Panel title={t('me.badges')} actions={<Link to="/academy" className="text-xs text-gold-300 hover:underline">{t('nav.academy')} →</Link>}>
        {badgeCount > 0 ? <BadgeShelf showLocked={false} /> : <p className="text-sm text-ink-400">{t('me.noBadges')}</p>}
      </Panel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('me.recent')} actions={<Link to="/me/hands" className="jc-tap py-1 text-xs text-gold-300 hover:underline" data-testid="me-all-hands">{t('me.allHands')} →</Link>}>
          {hands.data && hands.data.length === 0 && <Empty>{t('me.none')}</Empty>}
          <ul className="divide-y divide-white/5">
            {hands.data?.map((h) => (
              <HandRow key={h.id} hand={h} onChange={(n) => hands.set(hands.data!.map((x) => (x.id === n.id ? n : x)))} />
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('me.myPosts')} actions={<Link to="/board/write" className="text-xs text-gold-300 hover:underline">{t('board.write')}</Link>}>
          {myPosts.data && myPosts.data.length === 0 && <Empty>{t('me.none')}</Empty>}
          <ul className="divide-y divide-white/5" data-testid="my-posts">
            {myPosts.data?.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                <Link to={`/board/${p.id}`} className="min-w-0 flex-1 truncate hover:text-gold-300">{p.title}</Link>
                {p.commentCount > 0 && <span className="text-xs text-gold-400">[{p.commentCount}]</span>}
                <span className="shrink-0 text-xs text-ink-400">{formatDate(p.createdAt, locale)}</span>
                <Link to={`/board/${p.id}/edit`} className="shrink-0 text-xs text-gold-300">{t('board.edit')}</Link>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('me.myComments')}>
          {myComments.data && myComments.data.length === 0 && <Empty>{t('me.none')}</Empty>}
          <ul className="divide-y divide-white/5" data-testid="my-comments">
            {myComments.data?.map((c) => (
              <li key={c.id} className="py-2.5 text-sm">
                <Link to={`/board/${c.postId}`} className="block truncate text-ink-100 hover:text-gold-300">{c.body}</Link>
                <div className="mt-0.5 truncate text-xs text-ink-400">{c.postTitle} · {formatDate(c.createdAt, locale)}</div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('me.profile')}>
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
            <PasswordInput placeholder={t('me.currentPassword')} aria-label={t('me.currentPassword')} autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <PasswordInput id="me-new-password" placeholder={t('auth.newPassword')} aria-label={t('auth.newPassword')} autoComplete="new-password" maxLength={128} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} aria-describedby="me-new-password-rules" />
            <PasswordRules id="me-new-password-rules" value={pw.next} />
            <PasswordInput id="me-confirm-password" placeholder={t('auth.passwordConfirm')} aria-label={t('auth.passwordConfirm')} autoComplete="new-password" maxLength={128} value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} aria-describedby="me-confirm-password-match" />
            <PasswordMatch id="me-confirm-password-match" password={pw.next} confirm={pw.confirm} />
            {pwMsg && <p className="text-sm text-gold-300">{pwMsg}</p>}
            <Button type="submit" variant="outline" disabled={!pw.current || !passwordOk(pw.next) || pw.confirm !== pw.next}>
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await logout();
                nav('/login', { replace: true });
              }}
              data-testid="me-logout"
            >
              {t('nav.logout')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
              {t('me.delete')}
            </Button>
          </div>
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
    </div>
  );
}

export function HandDetailPage() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const { data, error } = useLoad<HandDetailDto>(`/api/me/hands/${encodeURIComponent(id)}`);
  const tr = useTr();
  const [reporting, setReporting] = useState<ReportSubject | null>(null);
  // This hand's amounts in the player's unit, at its own big blind; the wallet and the stats above stay in chips.
  const amt = useAmounts(data?.bigBlind ?? 0);
  if (error) return <Empty>{t('notFound')}</Empty>;
  if (!data) return <Empty>{t('common.loading')}</Empty>;
  const name = (seat: number) => data.players.find((p) => p.seatIndex === seat)?.nickname ?? `#${seat + 1}`;
  const links = lessonLinksFor(data);
  const odds = potOddsFor(data);
  const actionText = (type: string) => (['post-sb', 'post-bb', 'timeout-fold', 'timeout-check'].includes(type) ? t(`replay.${type}` as MsgKey) : t(`action.${type}` as MsgKey));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold tracking-[0.04em] jc-gold-text">{t('replay.title', { n: data.handNumber })}</h1>
        <Link to="/me" className="text-sm text-gold-300 hover:underline">← {t('nav.me')}</Link>
      </div>
      <Panel
        title={t('replay.player')}
        actions={
          <span className="text-xs text-ink-400">
            {data.tableName} · {formatDate(data.endedAt, locale)}
          </span>
        }
      >
        {/* Phones give the replay the panel's padding too: the table needs the width more than the frame does. */}
        <div className="-mx-4 sm:mx-0">
          <HandReplay hand={data} heroSeat={data.players.find((p) => p.isYou)?.seatIndex ?? null} />
        </div>
      </Panel>
      <HandNotePanel key={data.id} handId={data.id} initial={data.note} />
      {links.length > 0 && (
        <Panel title={t('replay.lessons')}>
          <ul className="flex flex-col gap-2" data-testid="hand-lessons">
            {links.map((x) => (
              <li key={x.id}>
                <Link to={x.to} className="jc-tap flex items-center gap-3 rounded-xl border border-gold-500/20 bg-gold-500/5 p-3 hover:border-gold-400/50" data-link={x.id}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-gold-300">{tr(x.title)}</span>
                    <span className="block text-xs text-ink-300">{tr(x.why)}</span>
                  </span>
                  <span className="text-gold-300">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('lobby.players')}>
          <ul className="divide-y divide-white/5">
            {data.players.map((p) => (
              <li key={p.seatIndex} className="flex items-center gap-3 py-2.5">
                <span className="w-6 text-xs text-ink-400">#{p.seatIndex + 1}</span>
                <span className="flex gap-0.5">{(p.holeCards ?? [null, null]).map((c, i) => <PlayingCard key={i} card={(c as Card) ?? null} size="1.7rem" />)}</span>
                <span className="flex min-w-0 flex-1 text-sm">
                  <MemberName name={p.nickname} role={p.role} bot={p.bot} className={p.isYou ? 'font-semibold text-gold-300' : undefined} />
                </span>
                {/* Stacked, so an amount in big blinds ("+2.5 BB") leaves the name its room on a phone. */}
                <span className="flex shrink-0 flex-col items-end leading-tight">
                  {p.rankClass && <span className="text-xs text-ink-300">{t(`hand.${handLabelKey(p.rankClass, [])}` as MsgKey)}</span>}
                  <span className={`font-mono text-sm tabular-nums ${p.net >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}`} data-testid="hand-net">{p.net > 0 ? '+' : ''}{amt.fmt(p.net)}</span>
                </span>
                {/* A table bot only plays the server's moves: nothing of its own to report (the server refuses too). */}
                {!p.isYou && p.role !== 'super_admin' && !p.bot && (
                  <button
                    type="button"
                    className="jc-tap -my-1 min-h-9 rounded-md px-2 text-xs font-semibold text-[#f0a0a2] hover:bg-danger/10"
                    onClick={() => setReporting({ type: 'player', id: p.userId, tableId: data.tableId, label: p.nickname })}
                    data-testid="hand-report"
                  >
                    {t('report.action')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-400">{t('report.afterHint')}</p>
        </Panel>
        <Panel title={t('replay.actions')}>
          <ol className="flex flex-col gap-1 text-sm">
            {data.actions.map((a, i) => {
              const o = odds.get(i);
              return (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <span className="w-16 shrink-0 text-xs uppercase text-ink-400">{t(`stage.${a.stage}` as MsgKey)}</span>
                  <span className="min-w-0 flex-1 truncate" title={name(a.seatIndex)}>{name(a.seatIndex)}</span>
                  <span className="shrink-0 whitespace-nowrap text-ink-200">{actionText(a.type)}</span>
                  <span className="w-20 shrink-0 text-right font-mono text-gold-300">{a.amount > 0 ? amt.fmt(a.amount) : ''}</span>
                  {o && (
                    <span className="basis-full pb-1 pl-[4.5rem] text-xs text-ink-300" data-testid="pot-odds">
                      {t('odds.line', { pot: amt.fmt(o.pot), call: amt.fmt(o.toCall), ratio: oddsRatio(o), need: o.need })}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          {odds.size > 0 && (
            <p className="mt-3 text-xs text-ink-400" data-testid="pot-odds-note">
              {t('odds.note')}
            </p>
          )}
        </Panel>
      </div>
      <ReportModal subject={reporting} onClose={() => setReporting(null)} />
    </div>
  );
}

export type { ThemeId };
