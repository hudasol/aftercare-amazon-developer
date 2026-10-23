/**
 * Captures the screenshots in docs/screenshots from the running product.
 * Run with: CAPTURE=1 npx playwright test e2e/capture.spec.ts
 */
import { expect, test } from '@playwright/test';

test.skip(!process.env['CAPTURE'], 'Set CAPTURE=1 to refresh docs/screenshots');

const dir = 'docs/screenshots';

test('capture the Return Rescue journey', async ({ page }) => {
  await page.request.post('/api/demo/reset');
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${dir}/01-welcome.png` });

  await page.getByRole('button', { name: /keep disconnecting/ }).click();
  await expect(page.getByRole('heading', { name: 'Which one do you have?' })).toBeVisible();
  await page.getByRole('heading', { name: 'Which one do you have?' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/02-blocked-which-pair.png` });

  await page.getByLabel('Serial number').fill('HA-7Q2-4471');
  await page.getByRole('button', { name: 'Check serial' }).click();
  const slip = page.getByRole('article', { name: 'Return proposal' });
  await expect(slip).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.screenshot({ path: `${dir}/03-proposal-slip.png` });

  await page.getByRole('button', { name: 'Approve and send return' }).click();
  await expect(slip.locator('.slip-stamp')).toHaveText('OUTCOME UNKNOWN', { timeout: 15_000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.screenshot({ path: `${dir}/04-outcome-unknown.png` });

  await expect(slip.locator('.slip-stamp')).toHaveText('CONFIRMED', { timeout: 20_000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.screenshot({ path: `${dir}/05-confirmed.png` });

  const caseId = page.url().split('/').pop();
  await page.goto(`/lab/${caseId}`);
  await expect(page.getByText('Return confirmed').first()).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/06-resolution-lab.png`, fullPage: true });
  await page.locator('.lab-journey').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -16));
  await page.screenshot({ path: `${dir}/06b-lab-decision.png` });

  await expect(page.locator('#lab-connect li').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.locator('#lab-connect').boundingBox();
  if (box) {
    await page.screenshot({
      path: `${dir}/08-connect-client.png`,
      fullPage: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.post('/api/demo/reset');
  await page.goto('/');
  await page.getByRole('button', { name: /keep disconnecting/ }).click();
  await expect(page.getByRole('heading', { name: 'Which one do you have?' })).toBeVisible();
  await page.screenshot({ path: `${dir}/07-phone-blocked.png` });
});
