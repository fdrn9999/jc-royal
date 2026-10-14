import { createTranslator } from '@jc/ui';
import { useSyncExternalStore } from 'react';

const ko = {
  title: '관리자 콘솔',
  email: '이메일',
  password: '비밀번호',
  next: '다음',
  login: '로그인',
  logout: '로그아웃',
  reauth: '비밀번호 재확인',
  reauthHint: '민감한 작업입니다. 관리자 비밀번호를 다시 입력해 주세요(5분간 유효).',
  cancel: '취소',
  confirm: '확인',
  save: '저장',
  dashboard: '대시보드',
  users: '회원',
  tables: '테이블',
  hands: '게임 감사',
  ledger: '칩 원장',
  reconcile: '정합성 검사',
  audit: '관리 이력',
  totalUsers: '총 회원',
  onlineUsers: '현재 접속자',
  activeTables: '활성 테이블',
  playingTables: '진행 중 게임',
  wsConnections: 'WebSocket 연결',
  handsCompleted: '완료된 핸드',
  hands24h: '24시간 핸드',
  openSeats: '착석 세션',
  serverStatus: '서버 상태',
  issues: '문제 상황',
  search: '이메일·닉네임·ID 검색',
  status: '상태',
  role: '권한',
  balance: '잔액',
  createdAt: '가입일',
  detail: '상세',
  suspend: '정지',
  unsuspend: '정지 해제',
  reason: '사유',
  adjustChips: '가상 칩 조정',
  amount: '금액(±)',
  memo: '메모',
  resetLink: '비밀번호 재설정 링크 발급',
  setRole: '권한 변경',
  createTable: '테이블 생성',
  name: '이름',
  maxSeats: '정원',
  blinds: '블라인드',
  buyin: '바이인',
  turnSeconds: '턴 시간(초)',
  private: '비공개',
  joinCode: '참가 코드',
  spectators: '관전 허용',
  entryBlocked: '신규 입장 차단',
  closeTable: '테이블 종료',
  closeConfirm: '진행 중인 핸드가 끝나면 모든 플레이어의 칩을 정산하고 테이블을 종료합니다.',
  live: '실시간 상태',
  appliesNextHand: '블라인드 변경은 다음 핸드부터 적용됩니다.',
  sensitive: '종료된 핸드의 전체 카드 정보입니다. 열람은 감사 로그에 기록됩니다.',
  runReconcile: '정합성 검사 실행',
  resolve: '해결 처리',
  note: '처리 내용',
  noAccess: '관리자 권한이 없습니다.',
  error: '오류',
  saved: '저장되었습니다.',
  open: '열림',
  closing: '종료 중',
  closed: '종료',
  yes: '예',
  no: '아니요',
  actor: '관리자',
  action: '조치',
  target: '대상',
  time: '시각',
} as const;
type Dict = Record<keyof typeof ko, string>;
const en: Dict = {
  title: 'Admin Console',
  email: 'Email',
  password: 'Password',
  next: 'Next',
  login: 'Log in',
  logout: 'Log out',
  reauth: 'Confirm password',
  reauthHint: 'Sensitive action. Re-enter your admin password (valid for 5 minutes).',
  cancel: 'Cancel',
  confirm: 'Confirm',
  save: 'Save',
  dashboard: 'Dashboard',
  users: 'Users',
  tables: 'Tables',
  hands: 'Game audit',
  ledger: 'Chip ledger',
  reconcile: 'Reconciliation',
  audit: 'Admin log',
  totalUsers: 'Users',
  onlineUsers: 'Online now',
  activeTables: 'Active tables',
  playingTables: 'Games in play',
  wsConnections: 'WebSocket connections',
  handsCompleted: 'Hands completed',
  hands24h: 'Hands (24h)',
  openSeats: 'Open seats',
  serverStatus: 'Server',
  issues: 'Issues',
  search: 'Search email, nickname or id',
  status: 'Status',
  role: 'Role',
  balance: 'Balance',
  createdAt: 'Joined',
  detail: 'Details',
  suspend: 'Suspend',
  unsuspend: 'Unsuspend',
  reason: 'Reason',
  adjustChips: 'Adjust virtual chips',
  amount: 'Amount (±)',
  memo: 'Memo',
  resetLink: 'Issue password reset link',
  setRole: 'Change role',
  createTable: 'Create table',
  name: 'Name',
  maxSeats: 'Seats',
  blinds: 'Blinds',
  buyin: 'Buy-in',
  turnSeconds: 'Turn (s)',
  private: 'Private',
  joinCode: 'Join code',
  spectators: 'Spectators',
  entryBlocked: 'Block new entries',
  closeTable: 'Close table',
  closeConfirm: 'After the current hand, everyone is cashed out and the table closes.',
  live: 'Live status',
  appliesNextHand: 'Blind changes apply from the next hand.',
  sensitive: 'Full card information of a finished hand. Access is audited.',
  runReconcile: 'Run reconciliation',
  resolve: 'Resolve',
  note: 'Resolution note',
  noAccess: 'Administrator access required.',
  error: 'Error',
  saved: 'Saved.',
  open: 'Open',
  closing: 'Closing',
  closed: 'Closed',
  yes: 'Yes',
  no: 'No',
  actor: 'Admin',
  action: 'Action',
  target: 'Target',
  time: 'Time',
};

export type Key = keyof typeof ko;
const make = createTranslator<Dict>({ ko, en });
let locale: 'ko' | 'en' = (() => {
  try {
    return localStorage.getItem('jc.admin.locale') === 'en' ? 'en' : 'ko';
  } catch {
    return 'ko';
  }
})();
const subs = new Set<() => void>();
export function setLocale(l: 'ko' | 'en') {
  locale = l;
  try {
    localStorage.setItem('jc.admin.locale', l);
  } catch {
    /* ignore */
  }
  subs.forEach((f) => f());
}
export function useT() {
  const l = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => locale,
  );
  return { t: make(l), locale: l };
}
