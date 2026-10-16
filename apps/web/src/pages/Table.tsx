import { sound } from '@jc/audio';
import type { ActionType, PublicUserDto, TableView } from '@jc/types';
import { Button, cx, formatChips, Logo, Modal } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { COACH_HANDS, coachActive, coachTip } from '../academy/coach';
import { HandRankingChart } from '../academy/HandChart';
import { updateProgress, useProgress } from '../academy/progress';
import { ActionBar } from '../game/ActionBar';
import { JoinCodeModal } from '../components/JoinCode';
import { LinkShare } from '../components/Share';
import { parseQuick, QuickMissNote, useQuickPlay } from '../components/QuickPlay';
import { HostRoomModal } from '../components/Rooms';
import { PlayerCard, ReportModal, type ReportSubject } from '../components/Social';
import { ActionHelp, CurrentHandPill, StageNote } from '../game/BeginnerAids';
import { BuyInModal, ChatPanel, SettingsModal, TopUpModal } from '../game/Panels';
import { PreActions } from '../game/PreActions';
import { TableScene, useBoxSize, useTableLayout } from '../game/TableScene';
import { RequestError, useTableSocket } from '../game/useTableSocket';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useHiddenChat } from '../lib/safety';
import { useI18n, type MsgKey } from '../lib/i18n';
import { rememberVisit } from '../lib/lobby';
import { siteUrl } from '../lib/share';
import { usePrefs } from '../lib/prefs';
import { when } from '../lib/service';
import { ServiceBanner } from '../components/ServiceBanner';

function useCountdown(target: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
}

/** Moving to another table remounts the page, so nothing from the previous table (state, dialogs, ?sit) carries over. */
export function TableRoute() {
  const { id = '' } = useParams();
  return <TablePage key={id} />;
}

export function TablePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  // Sent here by quick play: if the seat is gone on arrival, offer the next table instead of a dead end.
  const quick = useMemo(() => parseQuick(params.get('quick')), [params]);
  const quickPlay = useQuickPlay();
  const [quickMissed, setQuickMissed] = useState(false);
  const { t, err, locale } = useI18n();
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const prefs = usePrefs();
  const sock = useTableSocket(id);
  const { reopen } = sock;
  const s = sock.state;
  const [codeOpen, setCodeOpen] = useState(false);
  const [buySeat, setBuySeat] = useState<number | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyErr, setBuyErr] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chart, setChart] = useState(false);
  const [picked, setPicked] = useState<PublicUserDto | null>(null);
  const [reporting, setReporting] = useState<ReportSubject | null>(null);
  // Table chat from players I muted on this device or blocked; it hides their lines for me only.
  const hiddenChat = useHiddenChat(me?.id);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useEffect(() => sound.installAutoUnlock(), []);
  // iOS Safari ignores user-scalable=no; block pinch zoom on the game screen except in the chat panel.
  useEffect(() => {
    const block = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('[data-allow-zoom]')) e.preventDefault();
    };
    document.addEventListener('gesturestart', block);
    return () => document.removeEventListener('gesturestart', block);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.fourColor = prefs.fourColor ? '1' : '';
  }, [prefs.fourColor]);

  // Server errors that are not tied to a request → transient toast.
  useEffect(() => {
    if (!sock.lastError) return;
    setToast(err(sock.lastError.code));
    const h = setTimeout(() => setToast(null), 3_500);
    return () => clearTimeout(h);
  }, [sock.lastError, err]);

  // What happened to my top-up or automatic rebuy after a hand; the wallet changed (or a request ended), so refresh it.
  // A cancelled pre-action is only shown.
  useEffect(() => {
    if (!sock.lastNotice) return;
    setNotice(t(`notice.${sock.lastNotice.code}` as MsgKey, { amount: formatChips(sock.lastNotice.amount ?? 0) }));
    if (sock.lastNotice.code !== 'preaction_cancelled') void refresh();
    const h = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(h);
  }, [sock.lastNotice, t, refresh]);

  // An older link or bookmark with the join code in its address: take the code out of the address at once, then trade
  // it for a ticket like the code dialog does.
  const legacyCode = useRef(params.get('code'));
  useEffect(() => {
    const code = legacyCode.current;
    if (!code) return;
    legacyCode.current = null;
    setParams(
      (p) => {
        p.delete('code');
        return p;
      },
      { replace: true },
    );
    api(`/api/tables/${encodeURIComponent(id)}/access`, { body: { code } }).then(
      () => reopen(),
      (e) => setToast(err(e instanceof ApiError ? e.code : null)),
    );
  }, [id, setParams, reopen, err]);

  // After the code dialog on this page: the new connection carries the ticket, then ?sit / ?wait below go on.
  const codeThen = s && s.seats.every((x) => x.state !== 'empty') ? 'wait' : 'sit';
  const onCodeGranted = useCallback(() => {
    setParams(
      (p) => {
        p.set(codeThen, '1');
        return p;
      },
      { replace: true },
    );
    reopen();
  }, [codeThen, setParams, reopen]);

  // ?sit=1 from the lobby: open the buy-in dialog on the first free seat. A private table waits for the join code.
  useEffect(() => {
    if (!s || params.get('sit') !== '1' || s.you.needsCode) return;
    if (s.you.seatIndex === null && s.you.canSit) {
      const free = s.seats.find((x) => x.state === 'empty');
      if (free) setBuySeat(free.seatIndex);
      else if (quick) setQuickMissed(true);
    } else if (s.you.seatIndex === null && quick) {
      setQuickMissed(true);
    } else if (s.you.seatIndex === null && s.seats.every((x) => x.state !== 'empty')) {
      setToast(t('invite.fullNow'));
      setTimeout(() => setToast(null), 5_000);
    }
    params.delete('sit');
    setParams(params, { replace: true });
  }, [s, params, setParams, t, quick]);

  // ?wait=1 from a full table in the lobby: join the waitlist, or take the seat if one opened up meanwhile.
  useEffect(() => {
    if (!s || params.get('wait') !== '1' || s.you.needsCode) return;
    if (s.you.seatIndex === null) {
      const free = s.you.canSit ? s.seats.find((x) => x.state === 'empty') : undefined;
      if (free) setBuySeat(free.seatIndex);
      else if (!s.you.inWaitlist) sock.send({ t: 'waitlist', join: true });
    }
    params.delete('wait');
    setParams(params, { replace: true });
  }, [s, params, setParams, sock]);

  // Auto-muck is a device setting the room applies to my seat: tell it when the two differ. A room that predates muck
  // reports no setting and is not asked. Re-run on reconnect, since a command sent while offline is not kept.
  const roomMuck = s?.you.seatIndex != null ? s.you.autoMuck : undefined;
  const { send, status } = sock;
  useEffect(() => {
    if (status === 'open' && typeof roomMuck === 'boolean' && roomMuck !== prefs.autoMuck) send({ t: 'muck', on: prefs.autoMuck });
  }, [roomMuck, prefs.autoMuck, send, status]);

  // The lobby lists tables I opened under "recent".
  const opened = !!s;
  const myId = me?.id;
  useEffect(() => {
    if (opened && myId) rememberVisit(myId, id);
  }, [opened, myId, id]);

  const anchor = s?.you.seatIndex ?? 0;
  const layout = useTableLayout(area, s?.table.maxSeats, anchor);

  const hand = s?.hand ?? null;
  const myTurn = !!s && !!hand && s.you.seatIndex !== null && hand.actorSeat === s.you.seatIndex && s.you.legal.length > 0;
  const nextIn = useCountdown(s?.nextHandAt ?? null);

  // Timer warning beeps on my turn.
  const lastBeep = useRef(0);
  useEffect(() => {
    if (!myTurn || !hand?.deadline) return;
    const h = setInterval(() => {
      const left = hand.deadline! - Date.now();
      if (left < 5_000 && left > 0 && Date.now() - lastBeep.current > 950) {
        lastBeep.current = Date.now();
        sound.play('timer');
      }
    }, 200);
    return () => clearInterval(h);
  }, [myTurn, hand?.deadline]);


  const onAct = useCallback((type: ActionType, amount?: number) => sock.act(type, amount), [sock]);

  const academy = useProgress(me?.id);
  const tip = coachActive(academy, s?.you.seatIndex != null) && myTurn && s ? coachTip(s) : null;
  // First-hands coach: count each real hand this player was dealt into while coaching is on.
  const coachedHands = useRef(new Set<string>());
  useEffect(() => {
    if (!me || !hand || hand.stage !== 'settled' || coachedHands.current.has(hand.id)) return;
    const mine = s?.seats.find((x) => x.seatIndex === s.you.seatIndex);
    if (!mine?.holeCards?.length && mine?.state !== 'folded') return;
    coachedHands.current.add(hand.id);
    updateProgress(me.id, (p) => (coachActive(p, true) ? { ...p, coach: { ...p.coach, hands: p.coach.hands + 1 } } : p));
  }, [me, hand, s]);

  async function sit(amount: number) {
    if (buySeat === null) return;
    setBuyBusy(true);
    setBuyErr(null);
    try {
      await sock.request({ t: 'sit', seatIndex: buySeat, buyIn: amount });
      setBuySeat(null);
      setQuickMissed(false);
      void refresh();
    } catch (e) {
      const code = e instanceof RequestError ? e.code : null;
      if (quick && (code === 'seat_taken' || code === 'table_closed' || code === 'entry_blocked')) {
        setBuySeat(null);
        setQuickMissed(true);
      } else setBuyErr(err(code));
    } finally {
      setBuyBusy(false);
    }
  }

  async function leave() {
    try {
      await sock.request({ t: 'leave' });
      void refresh();
      if (s?.you.seatIndex === null) nav('/');
    } catch (e) {
      setToast(err(e instanceof RequestError ? e.code : null));
    }
  }

  if (sock.status === 'unauthorized') {
    nav('/login', { replace: true, state: { from: `/table/${id}` } });
    return null;
  }

  const banner =
    sock.status === 'locked'
      ? t('table.locked')
      : sock.status === 'kicked'
        ? t('table.kicked')
        : sock.status === 'replaced'
          ? t('table.replaced')
          : sock.status === 'closed'
            ? t('table.closed')
            : sock.status === 'reconnecting'
              ? t('table.reconnecting')
              : sock.status === 'connecting' || !s
                ? t('table.connecting')
                : s.status === 'closing' || s.status === 'closed'
                  ? null
                  : s.maintenance?.active
                    ? t('table.maintenance', { end: when(s.maintenance.endsAt, locale) })
                    : s.paused
                      ? t('table.paused')
                      : s.maintenance && s.maintenance.startsAt - Date.now() < 3600_000
                        ? t('table.maintenanceSoon', { start: when(s.maintenance.startsAt, locale) })
                        : null;

  const mySeat = s?.you.seatIndex ?? null;
  const seated = mySeat !== null;
  const canChat = !!s && (seated || s.table.allowSpectators);
  const isHost = !!s && !!me && s.table.hostId === me.id && s.status !== 'closed';

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: 'var(--t-bg)' }}>
      {/* top bar */}
      <header className="jc-game-surface z-40 flex h-14 shrink-0 items-center gap-2 border-b border-gold-500/10 bg-ink-950/70 px-3 backdrop-blur-md">
        <Link to="/" aria-label={t('nav.lobby')} className="shrink-0">
          <Logo size={32} />
        </Link>
        {(() => {
          const title = (
            <>
              <div className="flex min-w-0 items-center gap-1 text-sm font-bold text-ivory" data-testid="table-title">
                <span className="truncate">{s?.table.name ?? '…'}</span>
                {isHost && <span aria-hidden className="shrink-0 text-xs text-gold-300">▾</span>}
              </div>
              {s && (
                <div className="truncate font-mono text-[11px] text-ink-300">
                  {s.table.roomType === 'member' && <span className="font-sans">{isHost ? `👑 ${t('room.host')}` : t('room.member')} · </span>}
                  {formatChips(s.table.smallBlind)}/{formatChips(s.table.bigBlind)}
                  {hand && ` · ${t('table.handNo', { n: hand.number })} · ${t(`stage.${hand.stage}` as MsgKey)}`}
                </div>
              )}
            </>
          );
          // The host opens the room's settings from its name, so the header needs no extra button on a phone.
          return isHost ? (
            <button type="button" className="jc-tap min-w-0 rounded-lg px-1.5 py-0.5 text-left hover:bg-white/5" onClick={() => setHosting(true)} aria-label={t('room.manage')} data-testid="room-manage">
              {title}
            </button>
          ) : (
            <div className="min-w-0">{title}</div>
          );
        })()}
        <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
          {seated && (
            <Button size="icon" variant="subtle" onClick={() => sock.send({ t: s!.you.sittingOut ? 'sitIn' : 'sitOut' })} data-testid="sitout-toggle" aria-label={s!.you.sittingOut ? t('table.sitIn') : t('table.sitOut')}>
              <span aria-hidden className="sm:hidden">{s!.you.sittingOut ? '▶' : '❚❚'}</span>
              <span className="hidden sm:inline">{s!.you.sittingOut ? t('table.sitIn') : t('table.sitOut')}</span>
            </Button>
          )}
          <Button size="icon" variant="ghost" className="lg:hidden" onClick={() => setChatOpen((o) => !o)} aria-label={t('table.chat')} aria-expanded={chatOpen}>
            💬
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setChart(true)} aria-label={t('table.handChart')} data-testid="hand-chart-open">
            <span aria-hidden className="sm:hidden">♠≡</span>
            <span className="hidden sm:inline">{t('table.handChart')}</span>
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setSettings(true)} aria-label={t('table.settings')}>
            ⚙
          </Button>
          <Button size="icon" variant="outline" onClick={seated ? leave : () => nav('/')} data-testid="leave" aria-label={seated ? t('table.standUp') : t('table.leave')}>
            <span aria-hidden className="sm:hidden">⏏</span>
            <span className="hidden sm:inline">{seated ? t('table.standUp') : t('table.leave')}</span>
          </Button>
        </div>
      </header>
      <div className="z-40">
        <ServiceBanner compact />
      </div>

      {banner && (
        <div className="z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-gold-500/15 px-4 py-2 text-center text-sm text-gold-300" role="status">
          {banner}
          {sock.status === 'reconnecting' && (
            <button className="jc-tap rounded-full border border-gold-500/40 px-3 py-1 text-xs font-semibold hover:bg-gold-500/15" onClick={sock.reconnect}>
              {t('table.reconnectNow')}
            </button>
          )}
          {sock.status === 'locked' && (
            <button className="jc-tap rounded-full border border-gold-500/40 px-3 py-1 text-xs font-semibold hover:bg-gold-500/15" onClick={() => setCodeOpen(true)} data-testid="enter-code">
              {t('table.enterCode')}
            </button>
          )}
          {sock.status === 'kicked' && (
            <Link to="/" className="jc-tap rounded-full border border-gold-500/40 px-3 py-1 text-xs font-semibold hover:bg-gold-500/15" data-testid="kicked-lobby">
              {t('nav.lobby')}
            </Link>
          )}
        </div>
      )}
      {quick && quickMissed && !seated && (
        <div className="z-40 flex flex-col gap-2 bg-gold-500/15 px-4 py-2 text-sm text-gold-300 sm:items-center" role="status" data-testid="quick-missed">
          {quickPlay.miss ? (
            <>
              <QuickMissNote miss={quickPlay.miss} filtered={false} />
              <Link to="/" className="self-start text-xs font-semibold text-gold-300 underline underline-offset-2 sm:self-center">
                {t('nav.lobby')}
              </Link>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-center">
              <span>{t('quick.missed')}</span>
              <span className="flex gap-2">
                <Button size="sm" loading={quickPlay.busy} onClick={() => quickPlay.run(quick.filters, [...new Set([...quick.tried, id])])} data-testid="quick-another">
                  {t('quick.another')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setQuickMissed(false)}>
                  {s?.table.allowSpectators === false ? t('quick.stayHere') : t('quick.stay')}
                </Button>
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* table area */}
        <div className="jc-game-surface relative flex min-w-0 flex-1 flex-col">
          {/* Beginner aids and coaching stack above the action bar: reserve room so they never cover my seat. */}
          <div ref={areaRef} className={cx('relative mx-2 mt-1 flex min-h-0 flex-1 items-center justify-center sm:mx-6 sm:mb-24 sm:mt-6', seated && (prefs.beginner || tip) ? 'mb-[12rem]' : 'mb-[6.75rem]')}>
            {s && (
              <TableScene
                s={s}
                layout={layout}
                mySeat={mySeat}
                canSit={!seated && s.you.canSit}
                onSit={setBuySeat}
                onSeatClick={(seat) => seat.userId && setPicked({ id: seat.userId, nickname: seat.nickname ?? '', avatarUrl: seat.avatarUrl ?? null })}
                nextIn={nextIn}
                cues={sock.cues}
                consumeCues={sock.consumeCues}
                reducedMotion={reducedMotion}
              />
            )}
          </div>

          {/* bottom: action bar / status */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-6">
            {toast && <div className="pointer-events-auto rounded-lg border border-danger/40 bg-ink-950/90 px-3 py-2 text-sm text-[#f3b0b2]" role="alert">{toast}</div>}
            {notice && (
              <div className="pointer-events-auto max-w-md rounded-lg border border-gold-500/35 bg-ink-950/90 px-3 py-1 text-xs text-gold-300 sm:py-2 sm:text-sm" role="status" data-testid="table-notice">
                {notice}
              </div>
            )}
            {s && prefs.beginner && hand && (
              <div className="flex flex-col items-center gap-1.5 sm:items-end">
                {/* A notice takes the street note's place (the header names the street), so the stack stays below my seat. */}
                {!notice && <StageNote s={s} />}
                {seated && <CurrentHandPill s={s} />}
              </div>
            )}
            {tip && (
              <div className="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-xl border border-info/40 bg-ink-950/90 p-2.5 text-xs text-ivory backdrop-blur sm:w-[26rem]" role="status" data-testid="coach-tip">
                <span className="mt-0.5 shrink-0 rounded-full bg-info/25 px-1.5 text-[10px] font-bold text-[#a9c8ee]">{t('coach.title')}</span>
                <span className="min-w-0 flex-1">
                  {tip.key === 'coach.call'
                    ? t('coach.call', { amount: formatChips(tip.amount), pot: formatChips(tip.pot) })
                    : tip.key === 'coach.strong'
                      ? t('coach.strong', { hand: t(`hand.${tip.rankClass}` as MsgKey) })
                      : t(tip.key)}
                  <span className="mt-0.5 block text-[10px] text-ink-400">{t('coach.remaining', { n: COACH_HANDS - academy.coach.hands })}</span>
                </span>
                <button className="jc-tap shrink-0 rounded px-1.5 py-1 text-[10px] text-ink-300 hover:text-ivory" onClick={() => me && updateProgress(me.id, (p) => ({ ...p, coach: { ...p.coach, off: true } }))} data-testid="coach-off">
                  {t('coach.off')}
                </button>
              </div>
            )}
            {s && myTurn && (
              <>
                {prefs.beginner ? (
                  <ActionHelp s={s} />
                ) : (
                  <div className="hidden rounded-full bg-gold-500/15 px-3 py-1 text-xs font-bold tracking-wider text-gold-300 jc-pulse-gold sm:block sm:self-end">{t('table.yourTurn')}</div>
                )}
                <ActionBar state={s} onAct={onAct} busy={sock.acting} />
              </>
            )}
            {s && !myTurn && seated && <PreActions s={s} onPick={sock.preAct} />}
            {s && !myTurn && (
              <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/5 bg-ink-950/80 px-3 py-2 text-sm backdrop-blur sm:self-end">
                {s.you.leaving && <span className="text-gold-300">{t('table.leavingAfterHand')}</span>}
                {!seated && (
                  <span className="text-ink-300" data-testid="viewer-status">
                    {s.you.inWaitlist && me && s.waitlist.includes(me.nickname)
                      ? t('table.waitingN', { n: s.waitlist.indexOf(me.nickname) + 1 })
                      : s.table.allowSpectators && !s.you.inWaitlist
                        ? t('table.spectating')
                        : null}
                    {!s.table.allowSpectators && <span className="block text-xs text-ink-400">{t('table.noSpectate')}</span>}
                  </span>
                )}
                {!seated && s.reservation && <span className="text-gold-300">{t('table.reserved', { name: s.reservation.nickname })}</span>}
                {!seated && !s.you.canSit && !s.you.needsCode && !s.maintenance?.active && s.seats.every((x) => x.state !== 'empty') && (
                  <Button size="sm" variant="outline" onClick={() => sock.send({ t: 'waitlist', join: !s.you.inWaitlist })}>
                    {s.you.inWaitlist ? t('table.leaveWaitlist') : t('table.joinWaitlist')} ({s.waitlist.length})
                  </Button>
                )}
                {!seated && s.you.needsCode && (
                  <>
                    <span className="text-ink-400">{t('table.privateSeatLocked')}</span>
                    <Button size="sm" variant="outline" onClick={() => setCodeOpen(true)} data-testid="enter-code">
                      {t('table.enterCode')}
                    </Button>
                  </>
                )}
                {seated && <span className={cx('font-mono text-xs text-ink-300')}>{t('common.balance')} {formatChips(me?.balance ?? 0)}</span>}
                {seated && s.you.topUpQueued !== null && (
                  <span className="flex items-center gap-1 rounded-full border border-gold-500/35 bg-gold-500/10 py-0.5 pl-2.5 pr-1 text-xs text-gold-300" data-testid="topup-queued">
                    {t('topup.queued', { amount: formatChips(s.you.topUpQueued) })}
                    <button type="button" className="jc-tap grid size-6 place-items-center rounded-full hover:bg-gold-500/20" onClick={() => sock.send({ t: 'cancelTopUp' })} aria-label={t('topup.cancel')} data-testid="topup-cancel">
                      ✕
                    </button>
                  </span>
                )}
                {seated && s.you.autoRebuy && (
                  <span className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-xs text-ink-200" data-testid="rebuy-badge">
                    {t('rebuy.badge', { spent: formatChips(s.you.autoRebuy.spent), cap: formatChips(s.you.autoRebuy.cap) })}
                  </span>
                )}
                {seated && !s.you.leaving && (
                  <Button size="sm" variant="outline" onClick={() => setTopUpOpen(true)} data-testid="topup-open">
                    {t('topup.open')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* chat sidebar (desktop) / drawer (mobile) */}
        <aside
          data-allow-zoom
          data-no-shortcuts
          className={cx(
            'jc-tap z-50 flex w-full flex-col border-l border-gold-500/10 bg-ink-950/95 p-3 backdrop-blur lg:static lg:flex lg:w-80',
            chatOpen ? 'fixed inset-x-0 bottom-0 top-14' : 'hidden',
          )}
        >
          {chatOpen && myTurn && (
            <button className="jc-pulse-gold mb-2 rounded-xl border border-gold-400/60 bg-gold-500/20 px-3 py-2.5 text-sm font-bold text-gold-300 lg:hidden" onClick={() => setChatOpen(false)} data-testid="chat-your-turn">
              {t('table.yourTurn')} · {t('table.backToTable')} ↓
            </button>
          )}
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold tracking-[0.08em] text-gold-300">{t('table.chat')}</h2>
            <button className="grid size-10 place-items-center text-ink-300 lg:hidden" onClick={() => setChatOpen(false)} aria-label={t('common.close')}>
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel
              chat={sock.chat}
              onSend={(text) => sock.send({ t: 'chat', text })}
              canChat={canChat}
              myId={me?.id}
              hidden={hiddenChat}
              onPick={(m) => setPicked({ id: m.userId, nickname: m.nickname, avatarUrl: s?.seats.find((x) => x.userId === m.userId)?.avatarUrl ?? null })}
            />
          </div>
          {s && (
            <div className="mt-3 border-t border-white/5 pt-3 text-xs text-ink-400">
              {s.spectatorCount > 0 && <div>{t('lobby.spectators', { n: s.spectatorCount })}</div>}
              {s.waitlist.length > 0 && <div>{t('lobby.waitlist', { n: s.waitlist.length })}</div>}
              <Link to="/me" className="mt-1 inline-block text-gold-300 hover:underline">
                {t('table.history')} →
              </Link>
            </div>
          )}
        </aside>
      </div>

      {s && (
        <BuyInModal
          open={buySeat !== null}
          onClose={() => setBuySeat(null)}
          state={s as TableView}
          seatIndex={buySeat}
          wallet={me?.balance ?? 0}
          onConfirm={sit}
          busy={buyBusy}
          error={buyErr}
        />
      )}
      {s && seated && (
        <TopUpModal
          open={topUpOpen}
          onClose={() => setTopUpOpen(false)}
          state={s}
          wallet={me?.balance ?? 0}
          request={sock.request}
          onCancelQueued={() => sock.send({ t: 'cancelTopUp' })}
          onDone={() => void refresh()}
        />
      )}
      <JoinCodeModal table={codeOpen ? { id, name: s?.table.name ?? t('lobby.private') } : null} then={codeThen} onClose={() => setCodeOpen(false)} onGranted={onCodeGranted} />
      <SettingsModal
        open={settings}
        onClose={() => setSettings(false)}
        top={
          s && s.status !== 'closed' ? (
            <LinkShare
              data={{ title: s.table.name, text: t('share.tableText', { name: s.table.name }), url: siteUrl(`/table/${encodeURIComponent(s.table.id)}${locale === 'en' ? '?lang=en' : ''}`) }}
              label={t('share.table')}
              hint={s.table.isPrivate ? t('room.inviteHint') : undefined}
              testId="table-invite"
            />
          ) : undefined
        }
      />
      {s && isHost && <HostRoomModal open={hosting} onClose={() => setHosting(false)} table={s.table} />}
      {/* The 1:1 chat opens in a new tab so the game connection stays. */}
      <PlayerCard
        user={picked}
        onClose={() => setPicked(null)}
        newTab
        chatMute
        onReport={() => {
          if (picked) setReporting({ type: 'player', id: picked.id, tableId: id, label: picked.nickname });
          setPicked(null);
        }}
      />
      <ReportModal subject={reporting} onClose={() => setReporting(null)} />
      <Modal open={chart} onClose={() => setChart(false)} title={t('table.handChart')}>
        <HandRankingChart compact />
        <Link to="/academy/hands" className="mt-3 inline-block text-sm text-gold-300 hover:underline">
          {t('table.toAcademy')} →
        </Link>
      </Modal>
    </div>
  );
}
