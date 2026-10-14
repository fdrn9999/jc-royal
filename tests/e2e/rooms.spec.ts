import { expect } from '@playwright/test';
import { balanceOf, signUp, test } from './helpers';

const CLOSED = /테이블이 종료되었습니다|The table has been closed/;

test('rooms: a member opens a private room from the lobby, is marked as host, renames and shares it, then closes it and gets the chips back', async ({ browser }) => {
  const host = await signUp(browser);
  const guest = await signUp(browser);
  const start = await balanceOf(host.page);

  await host.page.getByTestId('room-create-open-wide').click();
  const name = host.page.getByTestId('room-name');
  await expect(name).toHaveValue(new RegExp(host.nickname));
  await name.fill('E2E 친구 방');
  await host.page.getByTestId('room-seats-2').click();
  await host.page.getByTestId('room-bb-10').click();
  await host.page.getByTestId('room-private').check();
  await expect(host.page.getByTestId('room-create')).toBeDisabled();
  await host.page.getByTestId('room-code').fill('pals-2026');
  await host.page.screenshot({ path: 'test-results/room-create.png', animations: 'disabled' });
  await host.page.getByTestId('room-create').click();

  // The new room opens with the buy-in dialog; the host sits and wears the crown.
  await expect(host.page).toHaveURL(/\/table\/[\w-]+/);
  const id = host.page.url().match(/\/table\/([\w-]+)/)![1]!;
  await host.page.getByTestId('buyin-confirm').click();
  await expect(host.page.getByTestId('seat-0')).toHaveAttribute('data-state', /waiting|active/);
  await expect(host.page.getByTestId('seat-0').getByTestId('host-mark')).toBeVisible();

  // The lobby lists it as a member's room, with its host and a lock.
  await guest.page.reload();
  const card = guest.page.getByTestId('lobby-table').filter({ hasText: 'E2E 친구 방' });
  await expect(card.getByTestId('member-badge')).toContainText(host.nickname);
  await expect(card).toContainText('🔒');
  await guest.page.screenshot({ path: 'test-results/room-lobby.png' });

  // With the code the guest may sit; they see who the host is but get no host controls.
  await guest.page.goto(`/table/${id}?code=pals-2026&sit=1`);
  await expect(guest.page.getByTestId('buyin-confirm')).toBeVisible();
  await guest.page.getByRole('dialog').getByRole('button', { name: /^(취소|Cancel)$/ }).click();
  await expect(guest.page.getByTestId('seat-0').getByTestId('host-mark')).toBeVisible();
  await expect(guest.page.getByTestId('room-manage')).toHaveCount(0);

  // The host's dialog: the invite link carries no code; a new name reaches everyone at the table.
  await host.page.getByTestId('room-manage').click();
  const dialog = host.page.getByRole('dialog');
  await expect(dialog.getByTestId('room-link')).toHaveValue(new RegExp(`/table/${id}$`));
  await dialog.getByTestId('room-name').fill('E2E 새 이름');
  await dialog.getByTestId('room-save').click();
  await expect(dialog.getByRole('status')).toContainText(/저장했습니다|Saved/);
  await expect(guest.page.getByText('E2E 새 이름')).toBeVisible();
  await host.page.screenshot({ path: 'test-results/room-host.png', animations: 'disabled' });

  // Closing asks once more, then everyone is cashed out and the room ends.
  await dialog.getByTestId('room-close').click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByTestId('room-close').click();
  await expect(host.page.getByText(CLOSED)).toBeVisible();
  await expect(guest.page.getByText(CLOSED)).toBeVisible();
  expect(await balanceOf(host.page)).toBe(start);
  await guest.page.goto('/');
  await expect(guest.page.getByTestId('lobby-table').filter({ hasText: 'E2E 새 이름' })).toHaveCount(0);
});
