import { expect, type Locator, type Page } from '@playwright/test';

export const SHOW = /^(비밀번호 보기|Show password)$/;
export const HIDE = /^(비밀번호 숨기기|Hide password)$/;

const caret = (field: Locator) => field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);

/**
 * The eye button next to `field` flips it between hidden and shown, by mouse, tap or keyboard: what was typed stays,
 * and by mouse or tap the focus and the caret stay too, so typing goes on where it was. Returns what the field holds
 * at the end (`typed` with an x typed at the caret while shown).
 */
export async function eyeKeepsField(page: Page, field: Locator, typed: string, how: 'click' | 'tap' | 'keys') {
  const eye = field.locator('xpath=following-sibling::button[@data-testid="password-toggle"]');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(eye).toHaveAccessibleName(SHOW);
  await expect(eye).toHaveAttribute('aria-controls', (await field.getAttribute('id'))!);
  await field.fill(typed);
  await field.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  const flip = async () => {
    if (how === 'click') await eye.click();
    else if (how === 'tap') await eye.tap();
    else {
      // The next Tab from the field is its eye button, and Enter presses it.
      await page.keyboard.press('Tab');
      await expect(eye).toBeFocused();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+Tab');
    }
  };
  await flip();
  await expect(field).toHaveAttribute('type', 'text');
  await expect(eye).toHaveAccessibleName(HIDE);
  await expect(field).toHaveValue(typed);
  await expect(field).toBeFocused();
  if (how === 'keys') await field.evaluate((el: HTMLInputElement) => el.setSelectionRange(3, 3));
  expect(await caret(field)).toEqual([3, 3]);
  await page.keyboard.type('x');
  const edited = `${typed.slice(0, 3)}x${typed.slice(3)}`;
  await expect(field).toHaveValue(edited);
  await flip();
  await expect(field).toHaveAttribute('type', 'password');
  await expect(eye).toHaveAccessibleName(SHOW);
  await expect(field).toHaveValue(edited);
  await expect(field).toBeFocused();
  if (how !== 'keys') expect(await caret(field)).toEqual([4, 4]);
  return edited;
}

/** Nothing typed into a password field ends up in the address, the browser's storage or the console. */
export async function leftNowhere(page: Page, secret: string, logs: string[]) {
  expect(page.url()).not.toContain(secret);
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  expect(stored).not.toContain(secret);
  expect(logs.join('\n')).not.toContain(secret);
}
