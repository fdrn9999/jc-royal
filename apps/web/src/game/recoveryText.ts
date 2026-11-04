/** What the table says at each recovery step (recovery.ts). Only the table page imports it, so it loads with that page. */
import { createTranslator } from '@jc/ui';
import type { Recovery } from './recovery';

const ko: Record<Recovery, string> = {
  offline: '연결이 끊겼습니다. 인터넷 연결을 확인해 주세요. 연결되면 자동으로 이어집니다.',
  reconnecting: '연결이 끊겼습니다. 서버에 다시 연결하는 중…',
  syncing: '게임 상태 동기화 중… 확인될 때까지 액션을 잠급니다.',
  restoring: '현재 핸드 복구 중… 확인될 때까지 액션을 잠급니다.',
  restored: '게임에 복귀했습니다.',
  failed: '복구하지 못했습니다. 계속 다시 시도합니다.',
};

const en: Record<Recovery, string> = {
  offline: 'Connection lost. Check your internet connection: the table picks up again once you are back online.',
  reconnecting: 'Connection lost. Reconnecting to the server…',
  syncing: 'Syncing the game… actions are locked until it is confirmed.',
  restoring: 'Restoring the current hand… actions are locked until it is confirmed.',
  restored: 'Back in the game.',
  failed: 'Could not recover. Still trying…',
};

export const recoveryText = createTranslator({ ko, en });

/** The same in a word or two and what follows from it, for a header too narrow for the sentence: each fits the 320px phone's (RecoveryNote). */
type Brief = Record<Recovery, readonly [head: string, then?: string]>;

const koBrief: Brief = {
  offline: ['오프라인', '연결 확인'],
  reconnecting: ['연결 끊김', '재연결 중'],
  syncing: ['동기화 중', '액션 잠금'],
  restoring: ['핸드 복구', '액션 잠금'],
  restored: ['복귀 완료'],
  failed: ['복구 실패', '재시도 중'],
};

const enBrief: Brief = {
  offline: ['Offline', 'Waiting'],
  reconnecting: ['Dropped', 'Retrying'],
  syncing: ['Syncing', 'Locked'],
  restoring: ['Restoring', 'Locked'],
  restored: ['Rejoined'],
  failed: ['Failed', 'Retrying'],
};

export const recoveryBrief = (locale: 'ko' | 'en') => (r: Recovery) => (locale === 'en' ? enBrief : koBrief)[r];
