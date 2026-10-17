/**
 * Display names for the codes the API returns (roles, statuses, ledger types, hand actions, audit actions …), so
 * the Korean console shows Korean words. A value with no name here (a code added later) is shown as it is.
 */
import { handLabelKey } from '@jc/types';
import type { Key } from './i18n';

export type Tr = (key: Key, vars?: Record<string, string | number>) => string;

function labeler(names: Record<string, Key>) {
  const m = new Map(Object.entries(names));
  return (t: Tr, v: string | null | undefined): string => {
    if (!v) return '';
    const k = m.get(v);
    return k ? t(k) : v;
  };
}

export const roleLabel = labeler({ user: 'roleUser', admin: 'roleAdmin', super_admin: 'roleSuperAdmin' });
export const userStatusLabel = labeler({ active: 'userActive', suspended: 'userSuspended', deleted: 'userDeleted' });
export const ledgerTypeLabel = labeler({
  signup_grant: 'ledgerSignupGrant',
  buy_in: 'ledgerBuyIn',
  top_up: 'ledgerTopUp',
  cash_out: 'ledgerCashOut',
  admin_adjust: 'ledgerAdminAdjust',
  reconcile: 'ledgerReconcile',
  free_refill: 'ledgerFreeRefill',
  bot_fund: 'ledgerBotFund',
  referral: 'ledgerReferral',
});
/** The memos the server writes itself (sign-up grant, buy-in seat, top-ups); a memo an admin typed is shown as it is. */
const SYSTEM_MEMOS: Record<string, Key> = {
  'welcome chips': 'memoWelcome',
  'top-up': 'memoTopUp',
  'auto rebuy': 'memoAutoRebuy',
  'recorded difference': 'memoRecorded',
  'balance corrected': 'memoCorrected',
  'free refill': 'memoFreeRefill',
  'bot fund': 'memoBotFund',
  'referral reward (invited)': 'memoReferralInvited',
  'referral reward (referrer)': 'memoReferralReferrer',
};
export function memoLabel(t: Tr, memo: string | null | undefined): string {
  if (!memo) return '';
  const seat = /^seat (\d+)$/.exec(memo);
  if (seat) return t('memoSeat', { n: seat[1]! });
  return Object.hasOwn(SYSTEM_MEMOS, memo) ? t(SYSTEM_MEMOS[memo]!) : memo;
}
export const scopeLabel = labeler({ user_ledger: 'scopeUserLedger', table: 'scopeTable' });
export const contentStatusLabel = labeler({ visible: 'contentVisible', hidden: 'contentHidden', deleted: 'contentDeleted' });
export const categoryLabel = labeler({ system: 'catSystem', event: 'catEvent', sanction: 'catSanction', notice: 'catNotice', admin: 'catAdmin' });
export const academyKindLabel = labeler({ lesson: 'kindLesson', scenario: 'kindScenario', question: 'kindQuestion' });
export const actionLabel = labeler({
  fold: 'actFold',
  check: 'actCheck',
  call: 'actCall',
  bet: 'actBet',
  raise: 'actRaise',
  allin: 'actAllin',
  'post-sb': 'actPostSb',
  'post-bb': 'actPostBb',
  'timeout-fold': 'actTimeoutFold',
  'timeout-check': 'actTimeoutCheck',
});
export const stageLabel = labeler({ preflop: 'stagePreflop', flop: 'stageFlop', turn: 'stageTurn', river: 'stageRiver', showdown: 'stageShowdown', settled: 'stageSettled' });
const auditNames = labeler({
  'admin.access_denied': 'auditAccessDenied',
  'admin.bootstrap': 'auditAdminBootstrap',
  'admin.grants.list': 'auditGrantsList',
  'admin.grants.reset': 'auditGrantsReset',
  'admin.grants.update': 'auditGrantsUpdate',
  'admin.grants.view': 'auditGrantsView',
  'admin.login': 'auditAdminLogin',
  'admin.login.failed': 'auditAdminLoginFailed',
  'admin.reauth': 'auditAdminReauth',
  'admin.reauth.failed': 'auditAdminReauthFailed',
  'admin.session.end': 'auditSessionEnd',
  'admin.session.end_others': 'auditSessionEndOthers',
  'board.comment.status': 'auditCommentStatus',
  'bots.events': 'auditBotsEvents',
  'bots.integrity': 'auditBotsIntegrity',
  'bots.policy': 'auditBotsPolicy',
  'bots.stop': 'auditBotsStop',
  'bots.view': 'auditBotsView',
  'board.notice.create': 'auditNoticeCreate',
  'board.notice.update': 'auditNoticeUpdate',
  'board.post.status': 'auditPostStatus',
  'hand.list': 'auditHandList',
  'hand.view_sensitive': 'auditHandView',
  'ledger.view': 'auditLedgerView',
  'maintenance.cancel': 'auditMaintCancel',
  'maintenance.end': 'auditMaintEnd',
  'maintenance.schedule': 'auditMaintSchedule',
  'maintenance.stop': 'auditMaintStop',
  'maintenance.update': 'auditMaintUpdate',
  'message.send': 'auditMessageSend',
  note: 'noteEntry',
  'note.create': 'auditNoteCreate',
  'note.delete': 'auditNoteDelete',
  'reconcile.resolve': 'auditReconcileResolve',
  'reconcile.run': 'auditReconcileRun',
  'referral.approve': 'auditReferralApprove',
  'referral.list': 'auditReferralList',
  'referral.member': 'auditReferralMember',
  'referral.pause': 'auditReferralPause',
  'referral.policy': 'auditReferralPolicy',
  'referral.reject': 'auditReferralReject',
  'referral.resume': 'auditReferralResume',
  'referral.settle': 'auditReferralSettle',
  'referral.view': 'auditReferralView',
  'refill.claims': 'auditRefillClaims',
  'refill.member': 'auditRefillMember',
  'refill.pause': 'auditRefillPause',
  'refill.policy': 'auditRefillPolicy',
  'refill.resume': 'auditRefillResume',
  'refill.stats': 'auditRefillStats',
  'refill.view': 'auditRefillView',
  'settings.member': 'auditSettingsMember',
  'settings.reset': 'auditSettingsReset',
  'settings.restore': 'auditSettingsRestore',
  'service.notice.create': 'auditSvcNoticeCreate',
  'service.notice.delete': 'auditSvcNoticeDelete',
  'service.notice.end': 'auditSvcNoticeEnd',
  'service.notice.update': 'auditSvcNoticeUpdate',
  'report.view': 'auditReportView',
  'report.resolved': 'auditReportResolved',
  'report.dismissed': 'auditReportDismissed',
  'report.severity': 'auditReportSeverity',
  'report.assign': 'auditReportAssign',
  'report.note': 'auditReportNote',
  'report.update': 'auditReportUpdate',
  'report.resolve': 'auditReportResolve',
  'table.close': 'auditTableClose',
  'table.create': 'auditTableCreate',
  'table.update': 'auditTableUpdate',
  'table.control': 'auditTableControl',
  'table.timer_recover': 'auditTimerRecover',
  'timebank.policy': 'auditTimeBankPolicy',
  'timebank.view': 'auditTimeBankView',
  'tournament.abort': 'auditTnAbort',
  'tournament.cancel': 'auditTnCancel',
  'tournament.create': 'auditTnCreate',
  'tournament.list': 'auditTnList',
  'tournament.pause': 'auditTnPause',
  'tournament.recover': 'auditTnRecover',
  'tournament.registration': 'auditTnRegistration',
  'tournament.resume': 'auditTnResume',
  'tournament.start': 'auditTnStart',
  'tournament.view': 'auditTnView',
  'tournament_template.create': 'auditTplCreate',
  'tournament_template.list': 'auditTplList',
  'tournament_template.status': 'auditTplStatus',
  'tournament_template.update': 'auditTplUpdate',
  'user.chips': 'auditUserChips',
  'user.chips_duplicate': 'auditChipsDuplicate',
  'user.chips_refused': 'auditChipsRefused',
  'user.disconnect': 'auditUserDisconnect',
  'user.export': 'auditUserExport',
  'user.list': 'auditUserList',
  'user.reconcile': 'auditUserReconcile',
  'user.reset_link': 'auditUserResetLink',
  'user.role': 'auditUserRole',
  'user.suspend': 'auditUserSuspend',
  'user.unsuspend': 'auditUserUnsuspend',
  'user.view': 'auditUserView',
});
/**
 * An audit action's name. A refused or failed attempt is `<action>.failed` (the API's permission table names it); it
 * is shown as the action's name and "failed" when the action has a name here, as it is otherwise.
 */
export function auditActionLabel(t: Tr, v: string | null | undefined): string {
  if (!v) return '';
  const own = auditNames(t, v);
  if (own !== v || !v.endsWith('.failed')) return own;
  const base = v.slice(0, -'.failed'.length);
  const name = auditNames(t, base);
  return name === base ? v : t('auditFailedOf', { action: name });
}
/** The action families the audit page filters by (`family.*`). */
export const AUDIT_FAMILIES = ['admin', 'user', 'note', 'table', 'hand', 'ledger', 'reconcile', 'refill', 'bots', 'referral', 'settings', 'timebank', 'report', 'board', 'message', 'service', 'maintenance', 'tournament', 'tournament_template'] as const;
export const auditFamilyLabel = labeler({
  admin: 'famAdmin',
  user: 'famUser',
  note: 'famNote',
  table: 'famTable',
  hand: 'famHand',
  ledger: 'famLedger',
  reconcile: 'famReconcile',
  refill: 'famRefill',
  bots: 'famBots',
  referral: 'famReferral',
  settings: 'famSettings',
  timebank: 'famTimeBank',
  report: 'famReport',
  board: 'famBoard',
  message: 'famMessage',
  service: 'famService',
  maintenance: 'famMaintenance',
  tournament: 'famTournament',
  tournament_template: 'famTournamentTemplate',
});
/** Super-admin abilities (the API's lib/permissions.ts). */
export const capabilityLabel = labeler({
  'members.export': 'capMembersExport',
  'roles.change': 'capRolesChange',
  'admins.manage': 'capAdminsManage',
  'admins.grants': 'capAdminsGrants',
  'chips.large': 'capChipsLarge',
  'ledger.correct': 'capLedgerCorrect',
  'notes.delete_any': 'capNotesDeleteAny',
  'audit.all': 'capAuditAll',
  'sessions.all': 'capSessionsAll',
  'refill.policy': 'capRefillPolicy',
  'bots.policy': 'capBotsPolicy',
  'referral.policy': 'capReferralPolicy',
  'timebank.policy': 'capTimeBankPolicy',
  'tournament.structure': 'capTournamentStructure',
});
/** Console features in the permission table; most are the menu's names. */
export const featureLabel = labeler({
  dashboard: 'dashboard',
  members: 'users',
  memberExport: 'featMemberExport',
  memberNotes: 'featMemberNotes',
  sanctions: 'featSanctions',
  disconnect: 'featDisconnect',
  chips: 'featChips',
  resetLinks: 'featResetLinks',
  roles: 'featRoles',
  tables: 'tables',
  tableControl: 'featTableControl',
  hands: 'hands',
  handRecords: 'featHandRecords',
  ledger: 'ledger',
  economy: 'economy',
  stats: 'featStats',
  reconcile: 'reconcile',
  refill: 'featRefill',
  bots: 'featBots',
  referral: 'featReferral',
  settings: 'featSettings',
  tournaments: 'tournamentsNav',
  audit: 'audit',
  reports: 'reports',
  board: 'board',
  messages: 'messages',
  notices: 'featNotices',
  maintenance: 'featMaintenance',
  academy: 'academy',
  security: 'security',
});
/** A feature switch (the API's GRANTS): each is named after the feature it opens. */
export const grantLabel = featureLabel;
/** What became of a member's seat when an admin ended their connections (the room's `kick`). */
export const seatOutcomeLabel = labeler({ left: 'seatLeft', after_hand: 'seatAfterHand', kept: 'seatKept', retrying: 'seatRetrying' });
/** Problems the table room and the D1 comparison report on the admin table page. */
export const tableIssueLabel = labeler({
  stalled_hand: 'issueStalledHand',
  turn_overdue: 'issueTurnOverdue',
  next_hand_overdue: 'issueNextHandOverdue',
  no_hand_scheduled: 'issueNoHandScheduled',
  pending_seat: 'issuePendingSeat',
  cashing_seat: 'issueCashingSeat',
  topup_debiting: 'issueTopupDebiting',
  unrecorded_hands: 'issueUnrecordedHands',
  close_unfinished: 'issueCloseUnfinished',
  no_retry_alarm: 'issueNoRetryAlarm',
  settings_not_applied: 'issueSettingsNotApplied',
  session_without_seat: 'issueSessionWithoutSeat',
  seat_without_session: 'issueSeatWithoutSession',
  timer_unarmed: 'issueTimerUnarmed',
});
/** Service notices and maintenance windows (the admin service page). */
export const noticeKindLabel = labeler({ general: 'noticeKindGeneral', urgent: 'noticeKindUrgent', maintenance: 'noticeKindMaintenance' });
export const noticeStateLabel = labeler({ live: 'noticeStateLive', scheduled: 'noticeStateScheduled', ended: 'noticeStateEnded', deleted: 'noticeStateDeleted' });
export const maintStateLabel = labeler({ active: 'maintStateActive', scheduled: 'maintStateScheduled', finished: 'maintStateFinished', ended_early: 'maintStateEndedEarly', cancelled: 'maintStateCancelled' });
/** Table bots: difficulty, the operations log's kinds and the codes the room writes with them (others are shown as they are). */
export const botLevelLabel = labeler({ easy: 'botLevelEasy', normal: 'botLevelNormal', hard: 'botLevelHard' });
export const botEventKindLabel = labeler({ join: 'botEvJoin', leave: 'botEvLeave', fund_exhausted: 'botEvFundExhausted', join_failed: 'botEvJoinFailed', action_failed: 'botEvActionFailed' });
const botCodes = labeler({
  busted: 'botCodeBusted',
  bots_off: 'botCodeBotsOff',
  no_members: 'botCodeNoMembers',
  yield: 'botCodeYield',
  limit: 'botCodeLimit',
  policy_off: 'botCodePolicyOff',
  busy: 'botCodeBusy',
  max_bots: 'botCodeMaxBots',
  fund_exhausted: 'botCodeFundExhausted',
  error: 'botCodeError',
  no_view: 'botCodeNoView',
});
export function botEventCodeLabel(t: Tr, code: string | null | undefined): string {
  const funded = code ? /^funded (\d+)$/.exec(code) : null;
  return funded ? t('botCodeFunded', { n: Number(funded[1]).toLocaleString() }) : botCodes(t, code);
}
export const seatPhaseLabel = labeler({ pending: 'phasePending', cashing: 'phaseCashing' });
export const topUpStateLabel = labeler({ queued: 'topUpQueued', debiting: 'topUpDebiting' });
export const targetTypeLabel = labeler({
  batch: 'targetBatch',
  comment: 'targetComment',
  hand: 'targetHand',
  maintenance: 'targetMaintenance',
  notice: 'targetNotice',
  post: 'targetPost',
  reconciliation: 'targetReconciliation',
  referral: 'targetReferral',
  report: 'targetReport',
  session: 'targetSession',
  table: 'targetTable',
  tournament: 'targetTournament',
  tournament_template: 'targetTournamentTemplate',
  user: 'targetUser',
});
/** Tournaments (docs/TOURNAMENT.md): the tournament's and each entry's state, why one needs an operator, how it ended. */
export const tnStatusLabel = labeler({ registering: 'tnStRegistering', closed: 'tnStClosed', running: 'tnStRunning', finished: 'tnStFinished', cancelled: 'tnStCancelled', aborted: 'tnStAborted' });
export const tnEntryStatusLabel = labeler({
  registered: 'tnEnRegistered',
  unregistered: 'tnEnUnregistered',
  dropped: 'tnEnDropped',
  playing: 'tnEnPlaying',
  eliminated: 'tnEnEliminated',
  won: 'tnEnWon',
  stopped: 'tnEnStopped',
});
export const tnRecoveryLabel = labeler({
  room_silent: 'tnRcRoomSilent',
  pause_stuck: 'tnRcPauseStuck',
  resume_stuck: 'tnRcResumeStuck',
  stalled: 'tnRcStalled',
  table_open: 'tnRcTableOpen',
  start_stuck: 'tnRcStartStuck',
});
/** `end_reason` (completed | cancelled | aborted), or the status when it has none. */
export const tnEndReasonLabel = labeler({ completed: 'tnStFinished', finished: 'tnStFinished', cancelled: 'tnStCancelled', aborted: 'tnStAborted' });
/** Why a template's values do not hold together (@jc/types tournamentStructureProblem). */
export const structureProblemLabel = labeler({
  min_players_over_capacity: 'tnPbMinPlayers',
  small_blind_not_below_big: 'tnPbSmallBlind',
  levels_decrease: 'tnPbLevelsDecrease',
  start_stack_too_small: 'tnPbStartStack',
  initial_over_max: 'tbInitialOverMax',
  unit_over_max: 'tbUnitOverMax',
  whole_seconds: 'tbWholeSeconds',
});
/** Why a registration was dropped when the tournament started. */
export const startDroppedLabel = labeler({ suspended: 'tnDrSuspended', bot: 'tnDrBot', unverified: 'tnDrUnverified', min_hands: 'tnDrMinHands', active_elsewhere: 'tnDrElsewhere' });

const HAND_NAMES: Record<string, Key> = {
  'high-card': 'handHighCard',
  pair: 'handPair',
  'two-pair': 'handTwoPair',
  'three-of-a-kind': 'handTrips',
  straight: 'handStraight',
  flush: 'handFlush',
  'full-house': 'handFullHouse',
  'four-of-a-kind': 'handQuads',
  'straight-flush': 'handStraightFlush',
  'royal-flush': 'handRoyalFlush',
};
/** The made hand's name; an ace-high straight flush is a royal flush (the engine has no class for it). */
export function handRankLabel(t: Tr, rankClass: string | null, bestFive: readonly string[] | null): string {
  if (!rankClass) return '';
  const k = HAND_NAMES[handLabelKey(rankClass, bestFive ?? [])];
  return k && rankClass in HAND_NAMES ? t(k) : rankClass;
}
