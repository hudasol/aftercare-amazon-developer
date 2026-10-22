import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function reset(page: Page, base = '') {
  const res = await page.request.post(`${base}/api/demo/reset`);
  expect(res.ok()).toBe(true);
}

async function startFlagship(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp('keep disconnecting') }).click();
  await expect(page.getByRole('heading', { name: 'Which one do you have?' })).toBeVisible();
}

async function giveSerial(page: Page, serial: string) {
  await page.getByLabel('Serial number').fill(serial);
  await page.getByRole('button', { name: 'Check serial' }).click();
}

test.beforeEach(async ({ page }) => {
  await reset(page);
});

test('Return Rescue: blocked, resolved, approved, ambiguous timeout, reconciled, confirmed, resumed', async ({
  page,
}) => {
  await startFlagship(page);
  // Blocked: two orders match, and the customer is told why it matters.
  await expect(page.getByText('returnable until October 30').first()).toBeVisible();
  await expect(page.getByText('closed on August 30').first()).toBeVisible();
  await expect(page.locator('.side .journey [data-status="waiting_on_customer"]')).toHaveCount(1);

  await giveSerial(page, 'HA-0X0-0000');
  await expect(page.getByText('The last serial didn’t match either order.')).toBeVisible();

  await giveSerial(page, 'HA-7Q2-4471');
  const slip = page.getByRole('article', { name: 'Return proposal' });
  await expect(slip).toBeVisible();
  await expect(slip).toContainText('$189.00');
  await expect(slip).toContainText('v2026.1');
  await expect(slip).toContainText('October 30, 2026');

  // Enthusiasm in chat is not approval.
  await page.getByLabel('Message').fill('Yes, go ahead!');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('I only act on an explicit approval').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and send return' })).toBeVisible();

  await page.getByRole('button', { name: 'Approve and send return' }).click();
  // The seeded retailer loses the first response; the surface reconciles and verifies by itself.
  await expect(slip.locator('.slip-stamp')).toHaveText('CONFIRMED', { timeout: 20_000 });
  await expect(page.locator('.now-speech')).toContainText('confirmed');

  // Resume after a refresh: state comes from the database, not the page.
  await page.reload();
  await expect(
    page.getByRole('article', { name: 'Return proposal' }).locator('.slip-stamp'),
  ).toHaveText('CONFIRMED');
  await expect(page.locator('.side .journey li[data-status="done"]')).toHaveCount(6);

  // The Lab shows the same case: the unknown outcome and the recovery are on record.
  await page.getByRole('link', { name: 'See how this was decided' }).click();
  await expect(page.getByRole('heading', { name: 'Resolution Lab' })).toBeVisible();
  await expect(page.getByText('Return confirmed').first()).toBeVisible();
  await expect(page.getByText('operation.outcome_unknown')).toBeVisible();
  await expect(page.getByText('reconciliation.found')).toBeVisible();
  await expect(page.getByText('verification.confirmed')).toBeVisible();
  await expect(page.getByText('approval.not_inferred')).toBeVisible();

  // Exactly one return exists at the (simulated) retailer.
  const sandbox = (await (await page.request.get('/api/demo/sandbox')).json()) as {
    returns: unknown[];
  };
  expect(sandbox.returns).toHaveLength(1);
});

test('the older pair is refused with the reason, and nothing is proposed', async ({ page }) => {
  await startFlagship(page);
  await giveSerial(page, 'HA-7Q2-0193');
  await expect(page.getByRole('heading', { name: 'This item can’t be returned' })).toBeVisible();
  await expect(page.getByText('The return window closed on August 30.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and send return' })).toHaveCount(0);
});

test('the Lab drives the scenario through MCP and introduces conflicts', async ({ page }) => {
  await page.goto('/lab');
  await page.getByRole('button', { name: 'Start Return Rescue' }).click();
  await expect(page.locator('.driver-next')).toContainText('misreads the serial');
  await page.getByRole('button', { name: 'Run next step' }).click();
  await expect(page.locator('.driver-next')).toContainText('reads the serial correctly');
  await page.getByRole('button', { name: 'Run next step' }).click();
  await expect(page.getByText('Return ready for your approval').first()).toBeVisible();

  await page.getByRole('button', { name: 'Carrier disagrees on delivery date' }).click();
  await expect(page.getByText('Does not change the decision: Delivery date')).toBeVisible();
  await page.getByRole('button', { name: 'Customer cites a 90-day blog post' }).click();
  await expect(page.getByText('Set aside: not an authoritative source')).toBeVisible();

  // Script a refusal for the next submission, then run to the end.
  await page.getByLabel('Retailer’s answer to the next submission').selectOption('reject');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  for (let i = 0; i < 6; i++) {
    await expect(page.locator('.thinking')).toHaveCount(0);
    if ((await page.locator('.driver-next').textContent())?.includes('nothing more')) break;
    await page.getByRole('button', { name: 'Run next step' }).click();
  }
  await expect(page.locator('.lc-node[data-node="refused"]')).toHaveAttribute(
    'data-current',
    'true',
  );
  await expect(page.locator('.lab-journey .pill')).toHaveText('Paused for review');

  // The measured comparison is rendered from the committed evaluation results.
  await expect(
    page.getByRole('heading', { name: /AFTERCARE against two baselines, 22 scenarios/ }),
  ).toBeVisible();
});

test('pages have no serious accessibility violations', async ({ page }) => {
  for (const path of ['/', '/lab']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      serious.map((v) => `${v.id}: ${v.nodes.length}`),
      `on ${path}`,
    ).toEqual([]);
  }
  await startFlagship(page);
  await giveSerial(page, 'HA-7Q2-4471');
  await expect(page.getByRole('button', { name: 'Approve and send return' })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .flatMap((v) =>
        v.nodes.map((n) => `${v.id}: ${n.target.join(' ')} ${n.failureSummary ?? ''}`),
      ),
  ).toEqual([]);
});

test('keyboard users can approve with visible focus', async ({ page }) => {
  await startFlagship(page);
  await giveSerial(page, 'HA-7Q2-4471');
  const approve = page.getByRole('button', { name: 'Approve and send return' });
  await expect(approve).toBeVisible();
  // Reach the button with the keyboard alone.
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await approve.evaluate((el) => el === document.activeElement);
  }
  expect(reached).toBe(true);
  const outline = await approve.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('article', { name: 'Return proposal' }).locator('.slip-stamp'),
  ).toHaveText('CONFIRMED', { timeout: 20_000 });
});

/** Elements that extend past the visible width, named so a failure says what to fix. */
async function wideElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= limit) return [];
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > limit + 0.5)
      .slice(0, 8)
      .map((el) => {
        const right = Math.round(el.getBoundingClientRect().right);
        const name = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
        return `${name} right=${right} limit=${limit}`;
      });
  });
}

test('works on a phone-sized screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Always render the voice button, whatever the browser supports, so the widest layout is tested.
  await page.addInitScript(() => {
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = class {};
  });
  await startFlagship(page);
  await expect(page.getByRole('button', { name: 'Speak', exact: true })).toBeVisible();
  expect(await wideElements(page), 'assistant at phone width').toEqual([]);
  await page.goto('/lab');
  await expect(page.getByRole('heading', { name: 'Resolution Lab' })).toBeVisible();
  expect(await wideElements(page), 'lab at phone width').toEqual([]);
});

test.describe('process restart', () => {
  let child: ChildProcess | null = null;
  let dir = '';
  const port = 8795;
  const base = `http://127.0.0.1:${port}`;

  async function startServer(): Promise<void> {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: join(dir, 'restart.db'),
        SANDBOX_LATENCY_MS: '0',
        SANDBOX_TIMEOUT_MS: '0',
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('server did not start');
  }

  async function stopServer(): Promise<void> {
    if (!child) return;
    const exited = new Promise((r) => child?.once('exit', r));
    // A hard kill, like a crash: nothing gets a chance to clean up.
    child.kill('SIGKILL');
    await exited;
    child = null;
  }

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aftercare-restart-'));
  });

  test.afterAll(async () => {
    await stopServer();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a case survives a server restart with its evidence, proposal and history', async ({
    page,
  }) => {
    await startServer();
    await page.goto(base);
    await page.getByRole('button', { name: new RegExp('keep disconnecting') }).click();
    await giveSerial(page, 'HA-7Q2-4471');
    await expect(page.getByRole('button', { name: 'Approve and send return' })).toBeVisible();
    const url = page.url();
    const before = await (
      await page.request.get(`${base}/api/cases/${url.split('/').pop()}`)
    ).json();

    await stopServer();
    await startServer();

    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Approve and send return' })).toBeVisible();
    const after = await (
      await page.request.get(`${base}/api/cases/${url.split('/').pop()}`)
    ).json();
    expect(after.case.state).toBe('awaiting_approval');
    expect(after.events.length).toBe(before.events.length);
    expect(after.proposals[0].digest).toBe(before.proposals[0].digest);
    expect(after.evidence.length).toBe(before.evidence.length);
  });
});
