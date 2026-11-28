import { test } from './helpers';
import { bustScenario, paceScenario, socialScenario } from './ingame-ux-helpers';

test('모바일 인게임 UX: 내 턴에도 이모지를 보내고, 채팅이 좌석 옆 말풍선으로 뜨고, 래빗헌팅 버튼이 보드의 빈자리에 있다', async ({ browser }) => {
  await socialScenario(browser, true);
});

test('모바일 인게임 UX: 올인으로 칩을 모두 잃어도 좌석과 결과가 6초 이상 남고, 승자 배너와 패배 사유가 보인다', async ({ browser }) => {
  await bustScenario(browser, true);
});

test('모바일 인게임 UX: 쇼다운 결과가 4초 이상 남고, 건너뛰기와 빠르게 설정은 내 화면에만 적용된다', async ({ browser }) => {
  await paceScenario(browser, true);
});
