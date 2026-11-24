// A tournament's hand in the member's hand history (docs/TOURNAMENT.md "대회 핸드 기록"): marked as tournament chips so
// that its pot and result are not read as the member's own chips, on a phone and on a desktop, without widening the page.
import { expect } from '@playwright/test';
import { sql } from './analytics-helpers';
import { idOf, seedHands } from './hand-review-seed';
import { signUp, test, widerThanDevice } from './helpers';

for (const mobile of [true, false]) {
  test(`${mobile ? 'mobile' : 'desktop'}: a tournament hand is marked in hand history, a cash hand is not`, async ({ browser }) => {
    const a = await signUp(browser, { mobile });
    const b = await signUp(browser);
    const ids = seedHands(await idOf(a.page), await idOf(b.page));
    // Hand B was a tournament's, dealt at its third level (blinds 50/100).
    sql(
      `UPDATE hands SET tournament_id = 'e2e-tn', tournament = '{"format":"sng","level":2,"sb":50,"bb":100,"hand":7,"left":4,"startStack":1500}' WHERE id = '${ids.B}';` +
        `UPDATE hand_players SET tournament_id = 'e2e-tn' WHERE hand_id = '${ids.B}';`,
    );
    const page = a.page;
    await page.goto('/me?tab=history');
    await page.getByTestId('me-all-hands').click();
    const row = (id: string) => page.locator(`[data-testid=hand-row][data-hand="${id}"]`);
    await expect(row(ids.B).getByTestId('hand-tournament')).toBeVisible();
    await expect(row(ids.B).getByTestId('hand-tournament')).toHaveText(/대회 칩|Tournament chips/);
    for (const cash of [ids.A, ids.C, ids.D]) {
      await expect(row(cash)).toBeVisible();
      await expect(row(cash).getByTestId('hand-tournament')).toHaveCount(0);
    }
    // The mark sits inside its row and does not push the page wider than the screen.
    const [mark, box] = await Promise.all([row(ids.B).getByTestId('hand-tournament').boundingBox(), row(ids.B).boundingBox()]);
    expect(mark!.x).toBeGreaterThanOrEqual(box!.x);
    expect(mark!.x + mark!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
    expect(await widerThanDevice(page)).toBe(false);
    await page.screenshot({ path: test.info().outputPath(`hands-tournament-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    // The replay of a tournament hand opens like any other.
    await row(ids.B).getByRole('link').click();
    await expect(page).toHaveURL(`/me/hands/${ids.B}`);
    await expect(page.getByTestId('hand-note')).toBeVisible();
  });
}
