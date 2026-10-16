import { expect } from '@playwright/test';
import { balanceOf, signUp, test, widerThanDevice } from './helpers';

const shot = (name: string) => `test-results/referral-${name}.png`;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test('referrals on a phone: the code and link on the Me page, a friend signing up through the link, and both paid once', async ({ browser }) => {
  // The seeded E2E policy: on, 1,000 chips to each side, no hands asked, 5 a day and 50 in all.
  const a = await signUp(browser, { mobile: true });
  const page = a.page;
  await page.goto('/me');
  const card = page.getByTestId('referral-card');
  await expect(card).toHaveAttribute('data-state', 'on');
  const code = (await page.getByTestId('referral-my-code').innerText()).trim();
  expect(code).toMatch(/^JC[A-Z0-9]{5,10}$/);
  await expect(page.getByTestId('referral-link-url')).toHaveValue(new RegExp(`/register\\?ref=${code}$`));
  await expect(page.getByTestId('referral-terms')).toContainText('친구가 내 코드로 가입하면 친구는 1,000칩, 나는 1,000칩을 받습니다.');
  await expect(page.getByTestId('referral-terms')).toContainText('하루 5명, 모두 합쳐 50명까지');
  await expect(page.getByTestId('referral-invited')).toHaveText('0');
  await expect(card).toContainText('아직 내 코드로 가입한 친구가 없습니다.');
  expect(await widerThanDevice(page)).toBe(false);
  await card.screenshot({ path: shot('me-empty') });

  // A code that is no one's, and one that is not a code at all: the field says so before signing up.
  const other = await (await browser.newContext(PHONE)).newPage();
  await other.goto('/register?ref=JCZZZZZZ');
  const otherField = other.getByTestId('referral-field');
  await expect(otherField).toHaveAttribute('data-state', 'invalid');
  await expect(otherField).toContainText('사용할 수 없는 추천 코드입니다.');
  await other.getByTestId('referral-code').fill('hello');
  await expect(other.getByTestId('referral-code')).toHaveValue('HELLO');
  await expect(otherField).toHaveAttribute('data-state', 'invalid');
  await other.getByTestId('referral-code').fill('');
  await expect(otherField).toHaveAttribute('data-state', 'idle');
  await expect(otherField).not.toContainText('사용할 수 없는');

  // The friend opens the link: the code is filled in, whose it is and what it gives, then the reward at signup.
  const b = await signUp(browser, {
    mobile: true,
    ref: code.toLowerCase(),
    beforeSubmit: async (p) => {
      const field = p.getByTestId('referral-field');
      await expect(p.getByTestId('referral-code')).toHaveValue(code);
      await expect(field).toHaveAttribute('data-state', 'ok');
      await expect(field).toContainText(`'${a.nickname}' 님의 추천 코드입니다.`);
      await expect(field).toContainText('가입하면 추천 보상 1,000칩을 받습니다.');
      await expect(field).toContainText('가입 축하 칩과 별도');
      expect(await widerThanDevice(p)).toBe(false);
      await field.screenshot({ path: shot('signup-field') });
    },
  });
  expect(await balanceOf(b.page)).toBe(11_000);
  await b.page.goto('/me');
  const own = b.page.getByTestId('referral-invited-by');
  await expect(own).toHaveAttribute('data-side', 'paid');
  await expect(own).toContainText(`'${a.nickname}' 님의 추천으로 가입했습니다.`);
  await expect(own).toContainText('추천 보상 1,000칩을 받았습니다');
  await expect(b.page.getByTestId('me-balance')).toHaveText('11,000');
  await expect(b.page.getByTestId('ledger')).toContainText('추천 보상');
  // B has a code of their own, and nobody invited yet.
  await expect(b.page.getByTestId('referral-my-code')).not.toHaveText(code);
  await expect(b.page.getByTestId('referral-invited')).toHaveText('0');
  expect(await widerThanDevice(b.page)).toBe(false);
  await b.page.getByTestId('referral-card').screenshot({ path: shot('me-invited') });

  // A's card: one friend, one reward, and the friend in the recent list.
  await page.reload();
  await expect(page.getByTestId('referral-invited')).toHaveText('1');
  await expect(page.getByTestId('referral-paid')).toHaveText('1');
  await expect(page.getByTestId('referral-pending')).toHaveText('0');
  await expect(page.getByTestId('referral-earned')).toHaveText('1,000');
  const recent = page.getByTestId('referral-recent').getByRole('listitem').filter({ hasText: b.nickname });
  await expect(recent).toHaveAttribute('data-side', 'paid');
  await expect(recent).toContainText('+1,000');
  await expect(page.getByTestId('me-balance')).toHaveText('11,000');
  // Opening the card again pays nothing more.
  const again = await page.evaluate(async () => ((await (await fetch('/api/me/referral')).json()) as { paidNow: number; earned: number }));
  expect(again).toMatchObject({ paidNow: 0, earned: 1000 });
  expect(await balanceOf(page)).toBe(11_000);
  await page.getByTestId('referral-card').getByText('안내', { exact: true }).click();
  await expect(page.getByTestId('referral-card')).toContainText('같은 인터넷 연결이라는 이유만으로 거절하지 않습니다.');
  expect(await widerThanDevice(page)).toBe(false);
  await page.getByTestId('referral-card').screenshot({ path: shot('me-referrer') });

  // English: the Me card, and the link opened by someone who reads English.
  await page.getByTestId('settings-open').click();
  await page.getByLabel('언어', { exact: true }).selectOption('en');
  await page.keyboard.press('Escape');
  await expect(page.getByText('Invite friends', { exact: true })).toBeVisible();
  await expect(page.getByTestId('referral-terms')).toContainText('When a friend signs up with your code, they receive 1,000 chips and you receive 1,000 chips.');
  await expect(page.getByTestId('referral-card')).toContainText('Friends invited');
  expect(await widerThanDevice(page)).toBe(false);
  await page.getByTestId('referral-card').screenshot({ path: shot('me-referrer-en') });

  const en = await (await browser.newContext(PHONE)).newPage();
  await en.goto(`/register?ref=${code}&lang=en`);
  const enField = en.getByTestId('referral-field');
  await expect(enField).toHaveAttribute('data-state', 'ok');
  await expect(enField).toContainText(`This is ${a.nickname}'s referral code.`);
  await expect(enField).toContainText('You receive a 1,000-chip referral reward when you sign up.');
  expect(await widerThanDevice(en)).toBe(false);
  await enField.screenshot({ path: shot('signup-field-en') });
});
