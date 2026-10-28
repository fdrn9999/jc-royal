/**
 * Ready-made wording for the console: reasons for admin actions (A), service and board notices (B), maintenance
 * messages and reasons (C) and operator messages (D), on one shape. A template only writes text into a field the page
 * already has; the page still sends it to the same API, which checks it as before. Nothing here decides an action:
 * choosing a template never changes an amount, a time, a switch or who receives a message.
 *
 * Ids are stable (they may be kept in tests and notes); labels and text may change. `{key}` in a title or body is a
 * value the admin fills in (VARS); one still in braces is not finished, and pages refuse to save or send it.
 */
import type { NoticeKind } from '@jc/types';

export type Lang = 'ko' | 'en';

export interface AdminTemplate {
  id: string;
  /** What the dropdown shows; for a reason it is also the reason itself. */
  labelKo: string;
  labelEn: string;
  titleKo?: string;
  titleEn?: string;
  bodyKo?: string;
  bodyEn?: string;
  /** The action a reason fits where one field serves several (table control: pause, resume, block, unblock). */
  action?: string;
  /** The label alone is not enough: an important sanction names what happened. */
  detailRequired?: boolean;
  /** Notice kinds the template suits; it is listed first for them. */
  kinds?: NoticeKind[];
}

export interface TemplateGroup {
  label: string;
  items: AdminTemplate[];
}

/** Between a reason template and the admin's detail: "이벤트 보상 지급 - 10월 출석". */
export const SEP = ' - ';
/** The dropdown's "type it yourself" choice. */
export const CUSTOM = 'custom';

export const label = (t: AdminTemplate, lang: Lang) => (lang === 'en' ? t.labelEn : t.labelKo);

// ─── A. Reasons ─────────────────────────────────────────────────────────────────────────────────────────────────

const r = (id: string, labelKo: string, labelEn: string, more: Partial<AdminTemplate> = {}): AdminTemplate => ({ id, labelKo, labelEn, ...more });

/**
 * The chip memo is shown to the member with the change (and in their history): plain wording, nothing from an
 * investigation and nothing personal. Grants and deductions are separate lists; a memo picked for one sign is cleared
 * when the amount's sign flips.
 */
const chipGrant = [
  r('chip.grant.event', '이벤트 보상 지급', 'Event reward'),
  r('chip.grant.support', '고객지원 보상 지급', 'Customer support compensation'),
  r('chip.grant.outage', '서비스 장애 보상', 'Compensation for a service outage'),
  r('chip.grant.missed', '지급 누락분 보정', 'Missed payment made up'),
  r('chip.grant.settle', '정산 오류 보정', 'Settlement error corrected'),
  r('chip.grant.balance', '회원 잔액 정정', 'Balance corrected'),
  r('chip.grant.policy', '운영 정책에 따른 지급', 'Granted under our operating policy'),
];
const chipDeduct = [
  r('chip.deduct.duplicate', '중복 지급분 회수', 'Duplicate payment recovered'),
  r('chip.deduct.wrong', '오지급 칩 회수', 'Chips paid in error recovered'),
  r('chip.deduct.balance', '잔액 오류 정정', 'Balance error corrected'),
  r('chip.deduct.event', '이벤트 보상 회수', 'Event reward recovered'),
  r('chip.deduct.settle', '정산 오류 복구', 'Settlement error reverted'),
  r('chip.deduct.policy', '운영 정책에 따른 차감', 'Deducted under our operating policy'),
];

/** Nothing is preselected: a reason that states a breach is the admin's choice, and it needs the detail. */
const suspend = [
  r('suspend.terms', '서비스 이용약관 위반', 'Breach of the terms of service', { detailRequired: true }),
  r('suspend.cheating', '부정행위 확인', 'Cheating confirmed', { detailRequired: true }),
  r('suspend.multi', '다중 계정 악용', 'Abuse of multiple accounts', { detailRequired: true }),
  r('suspend.play', '비정상적인 게임 행위', 'Abnormal play', { detailRequired: true }),
  r('suspend.harass', '타 회원 괴롭힘', 'Harassing other members', { detailRequired: true }),
  r('suspend.spam', '스팸 및 광고', 'Spam or advertising'),
  r('suspend.security', '보안상 임시 이용 제한', 'Temporary hold for security'),
  r('suspend.policy', '운영 정책 위반', 'Breach of our operating policy', { detailRequired: true }),
];
const unsuspend = [
  r('unsuspend.expired', '제재 기간 종료', 'Suspension period over'),
  r('unsuspend.appeal', '이의신청 검토 후 해제', 'Lifted after an appeal'),
  r('unsuspend.mistake', '오제재 확인', 'Suspended by mistake'),
  r('unsuspend.review', '운영자 재검토', 'Lifted on staff review'),
  r('unsuspend.resolved', '제재 사유 해소', 'The reason no longer applies'),
];
const disconnect = [
  r('disconnect.outage', '서비스 장애 대응', 'Responding to a service outage'),
  r('disconnect.session', '세션 이상 복구', 'Recovering a broken session'),
  r('disconnect.stale', '비정상 접속 상태 정리', 'Clearing a stuck connection'),
  r('disconnect.check', '운영 점검', 'Operations check'),
  r('disconnect.security', '보안상 연결 종료', 'Disconnected for security'),
];
const role = [
  r('role.grant', '관리자 권한 신규 부여', 'Admin role granted'),
  r('role.adjust', '관리자 권한 조정', 'Admin role adjusted'),
  r('role.revoke', '관리자 권한 회수', 'Admin role withdrawn'),
  r('role.duty', '담당 업무 변경', 'Change of duties'),
  r('role.org', '운영 조직 변경', 'Change in the team'),
  r('role.security', '보안 정책에 따른 조정', 'Adjusted under the security policy'),
];
const adminGrants = [
  r('grants.new', '권한 신규 부여', 'New permission granted'),
  r('grants.revoke', '권한 회수', 'Permission withdrawn'),
  r('grants.duty', '담당 업무 변경', 'Change of duties'),
  r('grants.org', '운영 조직 변경', 'Change in the team'),
  r('grants.security', '보안 정책에 따른 조정', 'Adjusted under the security policy'),
];
const vip = [
  r('vip.assign', 'VIP 등급 신규 부여', 'VIP granted'),
  // No "VIP 등급 변경": VIP has no levels here, only on/off and a color.
  r('vip.color', 'VIP 색상 변경', 'VIP color changed'),
  r('vip.event', '이벤트 혜택 적용', 'Event benefit'),
  r('vip.remove', 'VIP 자격 해제', 'VIP ended'),
  r('vip.request', '관리자 요청에 따른 조정', 'Adjusted at a staff request'),
];

const botLevel = r('bots.level', '봇 난이도 조정', 'Bot difficulty adjusted');
const botStyle = r('bots.style', '봇 플레이 스타일 조정', 'Bot play style adjusted');
const botBuyIn = r('bots.buyin', '봇 바이인 변경', 'Bot buy-in changed');
const botBalance = r('bots.balance', '봇 플레이 밸런스 개선', 'Bot play balance improved');
const botFund = r('bots.fund', '봇 기금 정책 조정', 'Bot fund policy adjusted');
const botPolicy = r('bots.policy', '봇 운영 정책 변경', 'Bot operating policy changed');
const botPause = r('bots.pause', '봇 운영 일시중지', 'Bots paused');
const outage = r('common.outage', '서비스 장애 대응', 'Responding to a service outage');

const control = {
  pause: [
    r('control.pause.check', '서비스 점검', 'Service check', { action: 'pause' }),
    r('control.pause.error', '게임 진행 오류', 'Game progress error', { action: 'pause' }),
    r('control.pause.restore', '테이블 상태 복구', 'Restoring the table state', { action: 'pause' }),
    r('control.pause.staff', '운영자 점검', 'Staff check', { action: 'pause' }),
  ],
  resume: [
    r('control.resume.done', '점검 완료', 'Check complete', { action: 'resume' }),
    r('control.resume.fixed', '오류 복구 완료', 'Error fixed', { action: 'resume' }),
    r('control.resume.normal', '운영 정상화', 'Back to normal', { action: 'resume' }),
  ],
  block: [
    r('control.block.check', '테이블 점검', 'Table check', { action: 'block' }),
    r('control.block.policy', '운영 정책에 따른 제한', 'Limited under our operating policy', { action: 'block' }),
    r('control.block.outage', '장애 대응', 'Outage response', { action: 'block' }),
    r('control.block.abnormal', '비정상 상태 확인', 'Abnormal state found', { action: 'block' }),
  ],
  unblock: [
    r('control.unblock.done', '점검 완료', 'Check complete', { action: 'unblock' }),
    r('control.unblock.normal', '서비스 정상화', 'Service back to normal', { action: 'unblock' }),
    r('control.unblock.resolved', '입장 제한 사유 해소', 'The reason for the limit no longer applies', { action: 'unblock' }),
  ],
};

const policyChange = r('common.policy', '운영 정책 변경', 'Operating policy changed');
const economyBalance = r('common.economy', '게임 경제 밸런스 조정', 'Game economy rebalanced');
const eventPolicy = r('common.event', '이벤트 정책 적용', 'Event policy applied');
const feedback = r('common.feedback', '이용자 의견 반영', 'Member feedback');

export const REASONS = {
  chipGrant,
  chipDeduct,
  suspend,
  unsuspend,
  disconnect,
  role,
  adminGrants,
  vip,
  botsProfile: [botLevel, botStyle, botBuyIn, botBalance, botPolicy],
  botsPolicy: [botFund, botPolicy, botBalance, botPause],
  botsStop: [botPause, outage, botPolicy],
  control,
  timerRecover: [
    r('timer.stuck', '턴 타이머 멈춤 복구', 'Stuck turn timer recovered'),
    r('timer.error', '게임 진행 오류', 'Game progress error'),
    r('timer.restore', '테이블 상태 복구', 'Restoring the table state'),
    r('timer.staff', '운영자 점검', 'Staff check'),
  ],
  refillSwitch: {
    pause: [r('refill.pause.check', '무료 칩 정책 점검', 'Checking the free-chip policy'), r('refill.pause.abuse', '비정상 수령 의심 대응', 'Responding to suspected abuse'), outage],
    resume: [r('refill.resume.done', '점검 완료', 'Check complete'), r('refill.resume.normal', '운영 정상화', 'Back to normal')],
  },
  refillPolicy: [r('refill.amount', '지급량 조정', 'Amount adjusted'), r('refill.cooldown', '대기 시간 조정', 'Wait time adjusted'), economyBalance, eventPolicy, policyChange],
  referralSwitch: {
    pause: [r('referral.pause.check', '추천 보상 정책 점검', 'Checking the referral policy'), r('referral.pause.abuse', '비정상 추천 의심 대응', 'Responding to suspected abuse'), outage],
    resume: [r('referral.resume.done', '점검 완료', 'Check complete'), r('referral.resume.normal', '운영 정상화', 'Back to normal')],
  },
  referralPolicy: [r('referral.reward', '추천 보상 조정', 'Referral reward adjusted'), r('referral.rules', '추천 조건 조정', 'Referral conditions adjusted'), economyBalance, eventPolicy, policyChange],
  referralAct: {
    approve: [r('referral.approve.met', '추천 조건 충족 확인', 'Conditions met'), r('referral.approve.review', '재검토 후 승인', 'Approved after review')],
    reject: [
      r('referral.reject.unmet', '추천 조건 미충족', 'Conditions not met'),
      r('referral.reject.duplicate', '중복 추천', 'Duplicate referral'),
      r('referral.reject.suspect', '비정상 추천 의심', 'Suspected abuse', { detailRequired: true }),
    ],
  },
  timeBank: [r('timebank.time', '타임뱅크 시간 조정', 'Time bank adjusted'), r('timebank.pace', '게임 진행 속도 개선', 'Game pace improved'), feedback, policyChange],
  social: [r('social.rules', '이모지·반응 정책 변경', 'Emote and reaction rules changed'), r('social.community', '커뮤니티 환경 개선', 'Better community environment'), r('social.abuse', '악용 대응', 'Responding to abuse'), policyChange],
  tournamentAct: {
    start: [r('tn.start.manual', '운영자 수동 시작', 'Started by staff'), r('tn.start.delay', '지연된 시작 진행', 'Delayed start')],
    cancel: [r('tn.cancel.players', '참가 인원 부족', 'Not enough players'), r('tn.cancel.schedule', '운영 일정 변경', 'Schedule changed'), outage, r('tn.cancel.policy', '운영 정책에 따른 취소', 'Cancelled under our operating policy')],
    pause: [r('tn.pause.check', '서비스 점검', 'Service check'), r('tn.pause.error', '진행 오류 확인', 'Checking a progress error'), r('tn.pause.staff', '운영자 점검', 'Staff check')],
    resume: [r('tn.resume.done', '점검 완료', 'Check complete'), r('tn.resume.fixed', '오류 복구 완료', 'Error fixed')],
    abort: [outage, r('tn.abort.error', '진행 오류', 'Progress error'), r('tn.abort.policy', '운영 정책에 따른 중단', 'Stopped under our operating policy')],
    recover: [r('tn.recover.error', '진행 오류 복구', 'Progress error recovered'), r('tn.recover.table', '테이블 상태 복구', 'Restoring the table state')],
  },
  tournamentTplStatus: {
    archived: [r('tpl.archive.unused', '더 이상 쓰지 않는 템플릿', 'No longer used'), r('tpl.archive.replaced', '새 템플릿으로 대체', 'Replaced by a new template'), r('tpl.archive.ended', '운영 일정 종료', 'Schedule over')],
    active: [r('tpl.active.resume', '운영 재개', 'Back in use'), r('tpl.active.event', '이벤트 일정 시작', 'Event schedule starting')],
  },
  tournamentTpl: {
    create: [r('tpl.new', '신규 대회 추가', 'New tournament'), r('tpl.event', '이벤트 대회 준비', 'Preparing an event tournament'), policyChange],
    edit: [r('tpl.structure', '대회 구조 조정', 'Structure adjusted'), r('tpl.prize', '상금 구조 변경', 'Prize structure changed'), r('tpl.blinds', '블라인드 구조 조정', 'Blind structure adjusted'), policyChange],
  },
  economy: {
    note: [r('rec.note.cause', '원인 확인 기록', 'Cause recorded'), r('rec.note.normal', '정상 거래 확인', 'Normal transaction confirmed')],
    record: [r('rec.record.missing', '원장 누락분 기록', 'Missing ledger entry recorded'), r('rec.record.settle', '정산 차이 기록', 'Settlement difference recorded')],
    revert: [r('rec.revert.wrong', '오지급 되돌림', 'Wrong payment reverted'), r('rec.revert.settle', '정산 오류 복구', 'Settlement error reverted')],
  },
  /** Filing a review asserts nothing: the wording asks for a look. */
  integrity: [
    r('integrity.flow', '칩 이동 패턴 검토 요청', 'Review of chip movements'),
    r('integrity.seating', '반복 동석 패턴 검토 요청', 'Review of repeated seating together'),
    r('integrity.multi', '다중 계정 의심 검토 요청', 'Review for possible multiple accounts'),
    r('integrity.play', '비정상 플레이 검토 요청', 'Review of unusual play'),
    r('integrity.report', '회원 신고 관련 확인', 'Follow-up on a member report'),
  ],
  settings: {
    reset: [r('settings.reset.request', '회원 요청에 따른 초기화', 'Reset at the member’s request'), r('settings.reset.broken', '설정 오류 복구', 'Fixing broken settings'), r('settings.reset.sync', '동기화 문제 해결', 'Fixing a sync problem')],
    restore: [r('settings.restore.request', '회원 요청에 따른 복원', 'Restored at the member’s request'), r('settings.restore.mistake', '잘못된 초기화 되돌림', 'Undoing a mistaken reset')],
  },
  maintenance: {
    schedule: [
      r('maint.schedule.regular', '정기 서버 점검', 'Scheduled server maintenance'),
      r('maint.schedule.update', '서비스 업데이트', 'Service update'),
      r('maint.schedule.db', '데이터베이스 점검', 'Database maintenance'),
      r('maint.schedule.perf', '성능 개선 작업', 'Performance work'),
      r('maint.schedule.security', '보안 업데이트', 'Security update'),
      r('maint.schedule.recovery', '장애 복구 작업', 'Outage recovery'),
      r('maint.schedule.emergency', '긴급 서버 점검', 'Emergency server maintenance'),
    ],
    change: [
      r('maint.change.extend', '점검 시간 연장', 'Maintenance extended'),
      r('maint.change.shorten', '점검 시간 단축', 'Maintenance shortened'),
      r('maint.change.reschedule', '작업 일정 변경', 'Work rescheduled'),
      r('maint.change.more', '추가 점검 필요', 'More work needed'),
      r('maint.change.outage', '장애 대응 일정 조정', 'Adjusted for an outage'),
    ],
    end: [
      r('maint.end.done', '점검 작업 완료', 'Maintenance work complete'),
      r('maint.end.normal', '서비스 정상화 확인', 'Service confirmed normal'),
      r('maint.end.recovered', '장애 복구 완료', 'Outage recovered'),
      r('maint.end.early', '예정보다 빠른 점검 완료', 'Finished early'),
    ],
    cancel: [
      r('maint.cancel.cancelled', '점검 일정 취소', 'Maintenance called off'),
      r('maint.cancel.schedule', '운영 일정 변경', 'Schedule changed'),
      r('maint.cancel.unneeded', '작업 불필요 확인', 'Work not needed'),
      r('maint.cancel.reschedule', '점검 일정 재조정', 'To be rescheduled'),
    ],
  },
};

// ─── Values the admin fills into a title or body ───────────────────────────────────────────────────────────────

export interface TemplateVar {
  key: string;
  ko: string;
  en: string;
  /** The language of the text the value goes into; none = the same value in both (a date, a time). */
  lang?: Lang;
  multiline?: boolean;
  hintKo?: string;
  hintEn?: string;
  /** Written from the maintenance form's times there; typed like any other value in a form without them (a notice). */
  auto?: boolean;
}

const v = (key: string, ko: string, en: string, more: Partial<TemplateVar> = {}): TemplateVar => ({ key, ko, en, ...more });
/** The same value written in Korean (`key`) and in English (`keyEn`). */
const both = (key: string, ko: string, en: string, more: Partial<TemplateVar> = {}) => [v(key, ko, en, { ...more, lang: 'ko' }), v(`${key}En`, ko, en, { ...more, lang: 'en' })];
const WHEN = { hintKo: '예: 2026-10-29 02:00 (KST)', hintEn: 'e.g. 2026-10-29 02:00 (KST)' };

export const VARS: TemplateVar[] = [
  ...both('updateDetails', '업데이트 내용', 'What’s new', { multiline: true }),
  ...both('eventName', '이벤트명', 'Event name'),
  v('eventPeriod', '진행 기간', 'Period', { hintKo: '예: 2026-11-01 ~ 2026-11-07', hintEn: 'e.g. 2026-11-01 – 2026-11-07' }),
  ...both('participation', '참여 방법', 'How to join', { multiline: true }),
  ...both('reward', '보상', 'Rewards', { multiline: true }),
  ...both('policyDetails', '변경 내용', 'What changes', { multiline: true }),
  v('effectiveDate', '적용 일자', 'Effective date', { hintKo: '예: 2026-11-01', hintEn: 'e.g. 2026-11-01' }),
  v('incidentTime', '장애 발생 시각', 'Started at', WHEN),
  ...both('affectedServices', '영향 범위', 'Affected services'),
  ...both('status', '현재 조치 상황', 'Current status', { multiline: true }),
  v('resolvedAt', '정상화 시각', 'Restored at', WHEN),
  ...both('period', '점검 일정', 'Maintenance period', { auto: true, hintKo: '예: 2026년 10월 29일 02:00 ~ 04:00 (KST)', hintEn: 'e.g. Oct 29, 2026 02:00 – 04:00 (KST)' }),
  ...both('endAt', '종료 예정 시각', 'End time', { auto: true, hintKo: '예: 2026년 10월 29일 04:00 (KST)', hintEn: 'e.g. Oct 29, 2026 04:00 (KST)' }),
  ...both('maintenanceDetails', '점검 내용', 'Maintenance details', { multiline: true }),
  ...both('noticeDetails', '공지 내용', 'Announcement', { multiline: true }),
  ...both('guideDetails', '안내 내용', 'Details', { multiline: true }),
  ...both('fixDetails', '수정 내용', 'Fixes', { multiline: true }),
  ...both('question', '질문', 'Question'),
  ...both('answer', '답변', 'Answer', { multiline: true }),
  ...both('result', '처리 결과', 'Outcome', { multiline: true }),
  ...both('correction', '정정 내용', 'Correction', { multiline: true }),
  ...both('requestDetails', '확인 요청 내용', 'What we need to check', { multiline: true }),
  ...both('sanctionReason', '제한 사유', 'Reason for the restriction', { multiline: true }),
  v('sanctionPeriod', '제한 기간', 'Restriction period', { hintKo: '예: 2026-10-29 ~ 2026-11-05', hintEn: 'e.g. 2026-10-29 – 2026-11-05' }),
  ...both('liftReason', '해제 사유', 'Why it was lifted', { multiline: true }),
];
const VAR_BY_KEY = new Map(VARS.map((x) => [x.key, x]));
export const varOf = (key: string) => VAR_BY_KEY.get(key);

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The known values still in braces, in order of first appearance. Braces around anything else are left alone. */
export function unfilled(texts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const text of texts) for (const m of (text ?? '').matchAll(PLACEHOLDER)) if (VAR_BY_KEY.has(m[1]!) && !out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Writes each filled value in; an empty one stays in braces, so it is seen and the page refuses it. */
export function fill(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(PLACEHOLDER, (all, key: string) => {
    const val = vars[key]?.trim();
    return VAR_BY_KEY.has(key) && val ? val : all;
  });
}

/**
 * The fields longer than the server takes (it trims first, so this does too). A field's own limit only stops typing:
 * text a template writes in, with the values filled, can still run past it. The page refuses to send it rather than
 * cut what the admin wrote.
 */
export function overLimit<K extends string>(values: Partial<Record<K, string>>, limits: Partial<Record<K, number>>): { key: K; length: number; max: number }[] {
  const out: { key: K; length: number; max: number }[] = [];
  for (const key of Object.keys(limits) as K[]) {
    const max = limits[key]!;
    const length = (values[key] ?? '').trim().length;
    if (length > max) out.push({ key, length, max });
  }
  return out;
}

// ─── B, C, D. Notices, maintenance messages, board notices and operator messages ───────────────────────────────

const HELLO_KO = '안녕하세요, JC ROYAL입니다.';
const HELLO_EN = 'Hello, this is the JC ROYAL team.';
const SIGN_KO = 'JC ROYAL 운영팀';
const SIGN_EN = 'JC ROYAL Team';

/** The maintenance texts serve the maintenance message, the service notice and the board post alike. */
const MAINT = {
  regularKo: `${HELLO_KO}\n\n보다 안정적인 게임 환경을 제공하기 위해\n정기 서버 점검이 진행될 예정입니다.\n\n■ 점검 일정\n{period}\n\n■ 점검 내용\n{maintenanceDetails}\n\n점검 중에는 일부 게임 기능의 이용이\n제한될 수 있습니다.\n\n이용에 불편을 드리는 점 양해 부탁드립니다.\n\n${SIGN_KO}`,
  regularEn: `${HELLO_EN}\n\nWe will perform scheduled maintenance\nto improve service stability.\n\n■ Maintenance Period\n{periodEn}\n\n■ Maintenance Details\n{maintenanceDetailsEn}\n\nSome game features may be unavailable\nduring this period.\n\nThank you for your understanding.\n\n${SIGN_EN}`,
  emergencyKo: `${HELLO_KO}\n\n안정적인 서비스 제공을 위해\n긴급 서버 점검을 진행합니다.\n\n■ 점검 일정\n{period}\n\n■ 점검 사유\n{maintenanceDetails}\n\n갑작스러운 점검으로 불편을 드려\n죄송합니다.\n\n안정적인 서비스 제공을 위해\n최선을 다하겠습니다.\n\n${SIGN_KO}`,
  emergencyEn: `${HELLO_EN}\n\nWe are performing emergency maintenance\nto keep the service stable.\n\n■ Maintenance Period\n{periodEn}\n\n■ Reason\n{maintenanceDetailsEn}\n\nWe apologize for the short notice\nand thank you for your patience.\n\n${SIGN_EN}`,
  extendKo: `${HELLO_KO}\n\n현재 진행 중인 점검 작업에\n추가 시간이 필요하여 점검 일정을\n다음과 같이 변경합니다.\n\n■ 변경된 종료 예정 시각\n{endAt}\n\n이용에 불편을 드려 죄송합니다.\n\n${SIGN_KO}`,
  extendEn: `${HELLO_EN}\n\nThe maintenance under way needs more time,\nso it will now end at the time below.\n\n■ New End Time\n{endAtEn}\n\nWe apologize for the inconvenience.\n\n${SIGN_EN}`,
  doneKo: `${HELLO_KO}\n\n예정된 서버 점검이 완료되었습니다.\n\n현재 정상적으로 서비스를\n이용하실 수 있습니다.\n\n앞으로도 안정적인 게임 환경을\n제공하겠습니다.\n\n감사합니다.\n${SIGN_KO}`,
  doneEn: `${HELLO_EN}\n\nThe scheduled maintenance is complete.\n\nAll services are available again.\n\nThank you for your patience.\n\n${SIGN_EN}`,
};

const UPDATE = {
  ko: `${HELLO_KO}\n\n서비스 업데이트 소식을 알려 드립니다.\n\n■ 업데이트 내용\n{updateDetails}\n\n더 나은 서비스를 위해 계속 노력하겠습니다.\n\n감사합니다.\n${SIGN_KO}`,
  en: `${HELLO_EN}\n\nHere is what changed in our latest update.\n\n■ Update Details\n{updateDetailsEn}\n\nThank you for playing JC ROYAL.\n\n${SIGN_EN}`,
};
/** Rewards are only what the admin writes in. */
const EVENT = {
  ko: `${HELLO_KO}\n\n새로운 이벤트를 안내드립니다.\n\n■ 이벤트명\n{eventName}\n\n■ 진행 기간\n{eventPeriod}\n\n■ 참여 방법\n{participation}\n\n■ 보상\n{reward}\n\n많은 참여 부탁드립니다.\n\n감사합니다.\n${SIGN_KO}`,
  en: `${HELLO_EN}\n\nA new event is here.\n\n■ Event\n{eventNameEn}\n\n■ Period\n{eventPeriod}\n\n■ How to Join\n{participationEn}\n\n■ Rewards\n{rewardEn}\n\nWe hope to see you there.\n\n${SIGN_EN}`,
};
const POLICY = {
  ko: `${HELLO_KO}\n\n운영 정책이 다음과 같이 변경됨을 안내드립니다.\n\n■ 변경 내용\n{policyDetails}\n\n■ 적용 일자\n{effectiveDate}\n\n변경된 정책을 확인해 주시기 바랍니다.\n\n감사합니다.\n${SIGN_KO}`,
  en: `${HELLO_EN}\n\nWe are making the following changes to our policies.\n\n■ What Changes\n{policyDetailsEn}\n\n■ Effective\n{effectiveDate}\n\nPlease take a moment to review them.\n\n${SIGN_EN}`,
};

const c = (
  id: string,
  labelKo: string,
  labelEn: string,
  titleKo: string | undefined,
  titleEn: string | undefined,
  bodyKo: string,
  bodyEn: string,
  more: Partial<AdminTemplate> = {},
): AdminTemplate => ({ id, labelKo, labelEn, titleKo, titleEn, bodyKo, bodyEn, ...more });

/** Service notices: all four of the Korean and English title and body. Unknown facts stay blanks to fill, never guesses. */
export const NOTICE_TEMPLATES: AdminTemplate[] = [
  c(
    'notice.feature',
    '신규 기능 안내',
    'New features',
    '[업데이트] JC ROYAL 신규 기능 안내',
    '[Update] New Features in JC ROYAL',
    `${HELLO_KO}\n\n더 나은 게임 환경을 제공하기 위해\n새로운 기능이 추가되었습니다.\n\n■ 업데이트 내용\n{updateDetails}\n\n앞으로도 더욱 편리하고 안정적인\n게임 환경을 제공하겠습니다.\n\n감사합니다.\n${SIGN_KO}`,
    `${HELLO_EN}\n\nWe have introduced new features to improve your\ngaming experience.\n\n■ What's New\n{updateDetailsEn}\n\nThank you for playing JC ROYAL.\n\n${SIGN_EN}`,
    { kinds: ['general'] },
  ),
  c('notice.update', '업데이트 안내', 'Update', '[업데이트] JC ROYAL 업데이트 안내', '[Update] JC ROYAL Update', UPDATE.ko, UPDATE.en, { kinds: ['general'] }),
  c('notice.event', '이벤트 안내', 'Event', '[이벤트] JC ROYAL 이벤트 안내', '[Event] JC ROYAL Event', EVENT.ko, EVENT.en, { kinds: ['general'] }),
  c('notice.policy', '운영 정책 변경', 'Policy change', '[안내] 운영 정책 변경 안내', '[Notice] Changes to Our Policies', POLICY.ko, POLICY.en, { kinds: ['general'] }),
  c(
    'notice.incident',
    '서비스 장애 안내',
    'Service disruption',
    '[안내] JC ROYAL 서비스 이용 장애 안내',
    '[Notice] JC ROYAL Service Disruption',
    `${HELLO_KO}\n\n현재 일부 서비스 이용에 장애가 발생하고 있습니다.\n\n■ 장애 발생 시각\n{incidentTime}\n\n■ 영향 범위\n{affectedServices}\n\n■ 현재 조치 상황\n{status}\n\n이용에 불편을 드려 죄송합니다.\n문제 해결 후 다시 안내드리겠습니다.\n\n${SIGN_KO}`,
    `${HELLO_EN}\n\nSome of our services are currently disrupted.\n\n■ Started\n{incidentTime}\n\n■ Affected\n{affectedServicesEn}\n\n■ Current Status\n{statusEn}\n\nWe apologize for the inconvenience.\nWe will update you once it is resolved.\n\n${SIGN_EN}`,
    { kinds: ['urgent'] },
  ),
  c(
    'notice.resolved',
    '서비스 정상화 안내',
    'Service restored',
    '[안내] 서비스 정상화 안내',
    '[Notice] Service Restored',
    `${HELLO_KO}\n\n서비스 이용 장애가 해결되어\n현재 정상적으로 이용하실 수 있습니다.\n\n■ 정상화 시각\n{resolvedAt}\n\n이용에 불편을 드려 죄송합니다.\n앞으로 더욱 안정적인 서비스를 제공하겠습니다.\n\n감사합니다.\n${SIGN_KO}`,
    `${HELLO_EN}\n\nThe service disruption has been resolved and\nall services are working normally again.\n\n■ Restored\n{resolvedAt}\n\nWe apologize for the inconvenience.\n\n${SIGN_EN}`,
    { kinds: ['urgent', 'general'] },
  ),
  c('notice.maintenance', '정기 점검 안내', 'Scheduled maintenance', '[점검] JC ROYAL 정기 점검 안내', '[Maintenance] Scheduled Maintenance', MAINT.regularKo, MAINT.regularEn, { kinds: ['maintenance'] }),
  c('notice.emergency', '긴급 점검 안내', 'Emergency maintenance', '[긴급 점검] JC ROYAL 긴급 점검 안내', '[Maintenance] Emergency Maintenance', MAINT.emergencyKo, MAINT.emergencyEn, { kinds: ['urgent', 'maintenance'] }),
  c('notice.maintDone', '점검 완료 안내', 'Maintenance complete', '[안내] 서버 점검 완료 안내', '[Notice] Maintenance Complete', MAINT.doneKo, MAINT.doneEn, { kinds: ['maintenance', 'general'] }),
];

/**
 * The member message shown with a maintenance window: on the banner from a day before it starts until it ends, and on
 * the maintenance page. It is never shown after the end, so there is no "complete" message here: the console points
 * to the notice of that name instead.
 */
export const MAINTENANCE_TEMPLATES: AdminTemplate[] = [
  c('maint.regular', '정기 점검', 'Scheduled maintenance', undefined, undefined, MAINT.regularKo, MAINT.regularEn),
  c('maint.emergency', '긴급 점검', 'Emergency maintenance', undefined, undefined, MAINT.emergencyKo, MAINT.emergencyEn),
  c('maint.extend', '점검 연장', 'Maintenance extended', undefined, undefined, MAINT.extendKo, MAINT.extendEn),
];

/** Board notices: one title and body, in the language the admin picks. */
export const BOARD_TEMPLATES: AdminTemplate[] = [
  c('board.general', '일반 공지', 'General notice', '[공지] JC ROYAL 공지사항', '[Notice] JC ROYAL Announcement', `${HELLO_KO}\n\n{noticeDetails}\n\n감사합니다.\n${SIGN_KO}`, `${HELLO_EN}\n\n{noticeDetailsEn}\n\nThank you.\n\n${SIGN_EN}`),
  c('board.update', '서비스 업데이트', 'Service update', '[업데이트] JC ROYAL 업데이트 안내', '[Update] JC ROYAL Update', UPDATE.ko, UPDATE.en),
  c('board.event', '이벤트 안내', 'Event', '[이벤트] JC ROYAL 이벤트 안내', '[Event] JC ROYAL Event', EVENT.ko, EVENT.en),
  c(
    'board.guide',
    '게임 이용 안내',
    'How to play',
    '[안내] JC ROYAL 이용 안내',
    '[Guide] Playing JC ROYAL',
    `${HELLO_KO}\n\n게임 이용 방법을 안내드립니다.\n\n■ 안내 내용\n{guideDetails}\n\n궁금한 점이 있으시면 언제든지 문의해 주세요.\n\n감사합니다.\n${SIGN_KO}`,
    `${HELLO_EN}\n\nHere is how to get the most out of JC ROYAL.\n\n■ Details\n{guideDetailsEn}\n\nIf you have any questions, just ask.\n\n${SIGN_EN}`,
  ),
  c('board.policy', '운영 정책 안내', 'Policy', '[안내] 운영 정책 안내', '[Notice] Our Policies', POLICY.ko, POLICY.en),
  c('board.maintenance', '서버 점검 안내', 'Server maintenance', '[점검] JC ROYAL 서버 점검 안내', '[Maintenance] Server Maintenance', MAINT.regularKo, MAINT.regularEn),
  c(
    'board.bugfix',
    '버그 수정 안내',
    'Bug fixes',
    '[안내] 버그 수정 안내',
    '[Notice] Bug Fixes',
    `${HELLO_KO}\n\n다음 문제를 수정했습니다.\n\n■ 수정 내용\n{fixDetails}\n\n이용에 불편을 드려 죄송합니다.\n\n감사합니다.\n${SIGN_KO}`,
    `${HELLO_EN}\n\nWe have fixed the following problems.\n\n■ Fixes\n{fixDetailsEn}\n\nSorry for the trouble.\n\n${SIGN_EN}`,
  ),
  c(
    'board.recovery',
    '장애 복구 안내',
    'Outage resolved',
    '[안내] 서비스 장애 복구 안내',
    '[Notice] Service Disruption Resolved',
    `${HELLO_KO}\n\n서비스 이용 장애가 복구되었습니다.\n\n■ 장애 발생 시각\n{incidentTime}\n\n■ 정상화 시각\n{resolvedAt}\n\n■ 영향 범위\n{affectedServices}\n\n이용에 불편을 드려 죄송합니다.\n앞으로 더욱 안정적인 서비스를 제공하겠습니다.\n\n${SIGN_KO}`,
    `${HELLO_EN}\n\nThe service disruption has been resolved.\n\n■ Started\n{incidentTime}\n\n■ Restored\n{resolvedAt}\n\n■ Affected\n{affectedServicesEn}\n\nWe apologize for the inconvenience.\n\n${SIGN_EN}`,
  ),
  c('board.faq', '자주 묻는 질문', 'FAQ', '[FAQ] 자주 묻는 질문', '[FAQ] Frequently Asked Questions', 'Q. {question}\n\nA. {answer}', 'Q. {questionEn}\n\nA. {answerEn}'),
];

export type MessageCategory = 'notice' | 'event' | 'admin' | 'sanction';

const msg = (id: string, labelKo: string, labelEn: string, titleKo: string, titleEn: string, ko: string, en: string) =>
  c(id, labelKo, labelEn, titleKo, titleEn, `${HELLO_KO}\n\n${ko}\n\n${SIGN_KO}`, `${HELLO_EN}\n\n${en}\n\n${SIGN_EN}`);

/**
 * Operator messages, one language per message (the admin picks it). Sanction wording states what the operator writes
 * in and nothing more: no reason or breach is filled in for them.
 */
export const MESSAGE_TEMPLATES: Record<MessageCategory, AdminTemplate[]> = {
  notice: [
    msg('msg.notice.guide', '서비스 이용 안내', 'Using the service', '[JC ROYAL] 서비스 이용 안내', '[JC ROYAL] About the Service', '서비스 이용과 관련하여 안내드립니다.\n\n■ 안내 내용\n{guideDetails}\n\n감사합니다.', 'Here is some information about using the service.\n\n■ Details\n{guideDetailsEn}\n\nThank you.'),
    msg('msg.notice.account', '계정 정보 안내', 'Your account', '[JC ROYAL] 계정 정보 안내', '[JC ROYAL] About Your Account', '회원님의 계정과 관련하여 안내드립니다.\n\n■ 안내 내용\n{guideDetails}\n\n운영팀은 비밀번호를 묻지 않습니다.\n\n감사합니다.', 'We have an update about your account.\n\n■ Details\n{guideDetailsEn}\n\nOur team will never ask for your password.\n\nThank you.'),
    msg('msg.notice.support', '고객지원 답변', 'Support answer', '[JC ROYAL] 문의 답변 안내', '[JC ROYAL] Answer to Your Question', '문의하신 내용에 대해 안내드립니다.\n\n{answer}\n\n추가로 궁금한 점이 있으시면 언제든지 문의해 주세요.\n\n감사합니다.', 'Thank you for reaching out. Here is our answer.\n\n{answerEn}\n\nIf you have any other questions, just let us know.'),
    msg('msg.notice.received', '문의 접수 안내', 'Question received', '[JC ROYAL] 문의 접수 안내', '[JC ROYAL] We Got Your Question', '문의가 정상적으로 접수되었습니다.\n확인 후 순서대로 답변드리겠습니다.\n\n감사합니다.', 'We have received your question.\nWe will get back to you as soon as we can.\n\nThank you.'),
    msg('msg.notice.resolved', '문의 처리 완료', 'Question resolved', '[JC ROYAL] 문의 처리 완료 안내', '[JC ROYAL] Your Question Is Resolved', '문의하신 건의 처리가 완료되었습니다.\n\n■ 처리 결과\n{result}\n\n감사합니다.', 'We have finished looking into your question.\n\n■ Outcome\n{resultEn}\n\nThank you.'),
    msg('msg.notice.policy', '서비스 정책 안내', 'Service policy', '[JC ROYAL] 서비스 정책 안내', '[JC ROYAL] Our Service Policy', '서비스 정책이 다음과 같이 변경됨을 안내드립니다.\n\n■ 변경 내용\n{policyDetails}\n\n■ 적용 일자\n{effectiveDate}\n\n감사합니다.', 'Our service policy is changing as follows.\n\n■ What Changes\n{policyDetailsEn}\n\n■ Effective\n{effectiveDate}\n\nThank you.'),
  ],
  event: [
    msg('msg.event.win', '이벤트 당첨 안내', 'Event win', '[이벤트] 이벤트 당첨 안내', '[Event] You Won!', '축하드립니다! 참여하신 이벤트에 당첨되셨습니다.\n\n■ 이벤트명\n{eventName}\n\n■ 보상\n{reward}\n\n참여해 주셔서 감사합니다.', 'Congratulations! You are a winner in our event.\n\n■ Event\n{eventNameEn}\n\n■ Reward\n{rewardEn}\n\nThank you for taking part.'),
    msg('msg.event.reward', '이벤트 보상 지급 안내', 'Event reward paid', '[이벤트] 이벤트 보상 지급 안내', '[Event] Your Event Reward', '참여하신 이벤트의 보상이 지급되었습니다.\n\n■ 이벤트명\n{eventName}\n\n■ 보상\n{reward}\n\n참여해 주셔서 감사합니다.', 'Your event reward has been paid.\n\n■ Event\n{eventNameEn}\n\n■ Reward\n{rewardEn}\n\nThank you for taking part.'),
    msg('msg.event.join', '이벤트 참여 안내', 'Join the event', '[이벤트] 이벤트 참여 안내', '[Event] Join Our Event', '진행 중인 이벤트를 안내드립니다.\n\n■ 이벤트명\n{eventName}\n\n■ 진행 기간\n{eventPeriod}\n\n■ 참여 방법\n{participation}\n\n많은 참여 부탁드립니다.', 'Our event is on now.\n\n■ Event\n{eventNameEn}\n\n■ Period\n{eventPeriod}\n\n■ How to Join\n{participationEn}\n\nWe hope to see you there.'),
    msg('msg.event.end', '이벤트 종료 안내', 'Event over', '[이벤트] 이벤트 종료 안내', '[Event] The Event Has Ended', '참여해 주신 이벤트가 종료되었습니다.\n\n■ 이벤트명\n{eventName}\n\n참여해 주셔서 감사합니다.', 'The event has ended.\n\n■ Event\n{eventNameEn}\n\nThank you for taking part.'),
    msg('msg.event.fix', '이벤트 보상 정정', 'Event reward corrected', '[이벤트] 이벤트 보상 정정 안내', '[Event] Correction to Your Reward', '이벤트 보상 지급 내용에 정정이 있어 안내드립니다.\n\n■ 이벤트명\n{eventName}\n\n■ 정정 내용\n{correction}\n\n혼란을 드려 죄송합니다.', 'We need to correct your event reward.\n\n■ Event\n{eventNameEn}\n\n■ Correction\n{correctionEn}\n\nSorry for the confusion.'),
  ],
  admin: [
    msg('msg.admin.chips', '칩 정정 안내', 'Chip correction', '[JC ROYAL] 칩 잔액 정정 안내', '[JC ROYAL] Chip Balance Corrected', '회원님의 칩 잔액이 정정되었음을 안내드립니다.\n\n■ 정정 내용\n{correction}\n\n이용에 불편을 드려 죄송합니다.', 'Your chip balance has been corrected.\n\n■ Correction\n{correctionEn}\n\nSorry for the trouble.'),
    msg('msg.admin.outage', '서비스 장애 보상 안내', 'Outage compensation', '[JC ROYAL] 서비스 장애 보상 안내', '[JC ROYAL] Compensation for the Outage', '서비스 이용 장애로 불편을 드려 죄송합니다.\n\n■ 보상 내용\n{reward}\n\n앞으로 더욱 안정적인 서비스를 제공하겠습니다.', 'We are sorry for the recent service disruption.\n\n■ Compensation\n{rewardEn}\n\nThank you for your patience.'),
    msg('msg.admin.check', '계정 확인 요청', 'Account check', '[JC ROYAL] 계정 확인 요청', '[JC ROYAL] Please Check Your Account', '회원님의 계정과 관련하여 확인이 필요한 사항이 있어 연락드립니다.\n\n■ 확인 요청 내용\n{requestDetails}\n\n운영팀은 비밀번호를 묻지 않습니다.', 'We need to check something about your account.\n\n■ What We Need\n{requestDetailsEn}\n\nOur team will never ask for your password.'),
    msg('msg.admin.policy', '운영 정책 변경 안내', 'Policy change', '[JC ROYAL] 운영 정책 변경 안내', '[JC ROYAL] Changes to Our Policies', '운영 정책이 다음과 같이 변경됨을 안내드립니다.\n\n■ 변경 내용\n{policyDetails}\n\n■ 적용 일자\n{effectiveDate}', 'Our policies are changing as follows.\n\n■ What Changes\n{policyDetailsEn}\n\n■ Effective\n{effectiveDate}'),
  ],
  sanction: [
    msg('msg.sanction.limit', '이용 제한 안내', 'Account restricted', '[JC ROYAL] 계정 이용 제한 안내', '[JC ROYAL] Your Account Is Restricted', '운영 정책에 따라 회원님의 계정 이용이 제한되었음을 안내드립니다.\n\n■ 제한 사유\n{sanctionReason}\n\n■ 제한 기간\n{sanctionPeriod}\n\n안내 내용에 이의가 있으시면 고객지원으로 문의해 주세요.', 'Under our operating policy, your account has been restricted.\n\n■ Reason\n{sanctionReasonEn}\n\n■ Period\n{sanctionPeriod}\n\nIf you disagree, please contact support.'),
    msg('msg.sanction.lift', '이용 제한 해제 안내', 'Restriction lifted', '[JC ROYAL] 계정 이용 제한 해제 안내', '[JC ROYAL] Your Restriction Is Lifted', '회원님의 계정 이용 제한이 해제되었습니다.\n\n■ 해제 사유\n{liftReason}\n\n다시 이용해 주셔서 감사합니다.', 'The restriction on your account has been lifted.\n\n■ Why\n{liftReasonEn}\n\nWelcome back.'),
    msg('msg.sanction.caution', '이용 주의 안내', 'Caution', '[JC ROYAL] 이용 주의 안내', '[JC ROYAL] A Note About Our Policies', '운영 정책과 관련하여 안내드릴 사항이 있어 연락드립니다.\n\n■ 안내 내용\n{guideDetails}\n\n건전한 게임 환경을 위해 운영 정책을 확인해 주세요.\n같은 상황이 반복되면 이용이 제한될 수 있습니다.', 'We are writing about our operating policies.\n\n■ Details\n{guideDetailsEn}\n\nPlease review our policies.\nIf this happens again, your account may be restricted.'),
    msg('msg.sanction.appeal', '이의신청 결과 안내', 'Appeal outcome', '[JC ROYAL] 이의신청 검토 결과 안내', '[JC ROYAL] Outcome of Your Appeal', '접수하신 이의신청의 검토가 완료되었습니다.\n\n■ 검토 결과\n{result}\n\n감사합니다.', 'We have reviewed your appeal.\n\n■ Outcome\n{resultEn}\n\nThank you.'),
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

export const flatten = (list: AdminTemplate[] | TemplateGroup[]): AdminTemplate[] =>
  list.length && 'items' in list[0]! ? (list as TemplateGroup[]).flatMap((g) => g.items) : (list as AdminTemplate[]);

/** The reason to record: the label, or "label - detail"; '' while a required detail is missing. */
export function composeReason(t: AdminTemplate, detail: string, lang: Lang): string {
  if (!detail.trim()) return t.detailRequired ? '' : label(t, lang);
  return `${label(t, lang)}${SEP}${detail}`;
}

/** The template a reason was written from, and the detail after it; null for a reason typed by hand. */
export function matchReason(list: AdminTemplate[], value: string, lang: Lang): { tpl: AdminTemplate; detail: string } | null {
  for (const t of list) {
    const l = label(t, lang);
    if (value === l) return { tpl: t, detail: '' };
    if (value.startsWith(l + SEP)) return { tpl: t, detail: value.slice(l.length + SEP.length) };
  }
  return null;
}

/**
 * Like matchReason, in whichever language the reason was written: `lang` first, then the other. The console's
 * language can change while a reason is being written; the detail typed so far is still found, with the language it is in.
 */
export function readReason(list: AdminTemplate[], value: string, lang: Lang): { tpl: AdminTemplate; detail: string; lang: Lang } | null {
  for (const l of [lang, lang === 'en' ? 'ko' : 'en'] as const) {
    const m = matchReason(list, value, l);
    if (m) return { ...m, lang: l };
  }
  return null;
}

/** A template's title or body in one language. */
export function part(t: AdminTemplate, which: 'title' | 'body', lang: Lang): string {
  return (which === 'title' ? (lang === 'en' ? t.titleEn : t.titleKo) : lang === 'en' ? t.bodyEn : t.bodyKo) ?? '';
}

/** Those suited to the notice kind first, then the rest. */
export function byKind(list: AdminTemplate[], kind: NoticeKind, labels: { suited: string; others: string }): TemplateGroup[] {
  const suited = list.filter((t) => t.kinds?.includes(kind));
  const others = list.filter((t) => !t.kinds?.includes(kind));
  return [
    { label: labels.suited, items: suited },
    { label: labels.others, items: others },
  ].filter((g) => g.items.length);
}

const KST = 9 * 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function kst(ms: number) {
  const d = new Date(ms + KST); // Korea keeps no summer time
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hm: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
}
const dateKo = (p: ReturnType<typeof kst>, year = true) => `${year ? `${p.y}년 ` : ''}${p.m}월 ${p.d}일`;
const dateEn = (p: ReturnType<typeof kst>, year = true) => `${MONTHS[p.m - 1]} ${p.d}${year ? `, ${p.y}` : ''}`;

/**
 * A window in Korea time, as members read it: "2026년 10월 29일 02:00 ~ 04:00 (KST)", the end's date written only when
 * it falls on another day.
 */
export function formatPeriod(start: number, end: number, lang: Lang): string {
  const a = kst(start);
  const b = kst(end);
  const sameDay = a.y === b.y && a.m === b.m && a.d === b.d;
  if (lang === 'en') return `${dateEn(a)} ${a.hm} – ${sameDay ? '' : `${dateEn(b, a.y !== b.y)} `}${b.hm} (KST)`;
  return `${dateKo(a)} ${a.hm} ~ ${sameDay ? '' : `${dateKo(b, a.y !== b.y)} `}${b.hm} (KST)`;
}
export const formatMoment = (ms: number, lang: Lang) => {
  const p = kst(ms);
  return lang === 'en' ? `${dateEn(p)} ${p.hm} (KST)` : `${dateKo(p)} ${p.hm} (KST)`;
};

/** The maintenance values written from the form's times; empty until both are set and in order. */
export function maintenanceVars(start: number | null, end: number | null): Record<string, string> {
  if (start === null || end === null || !(end > start)) return { period: '', periodEn: '', endAt: '', endAtEn: '' };
  return { period: formatPeriod(start, end, 'ko'), periodEn: formatPeriod(start, end, 'en'), endAt: formatMoment(end, 'ko'), endAtEn: formatMoment(end, 'en') };
}
