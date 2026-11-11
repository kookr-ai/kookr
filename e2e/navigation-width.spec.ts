/**
 * Resizable left navigation.
 *
 * At 1280 px and wider, with "All projects" selected, the left navigation
 * (queues and named projects) has a divider on its right edge. Dragging it,
 * or the arrow keys while it has focus, changes the navigation's width. The
 * width is kept in localStorage, is always pulled back inside its bounds, and
 * can be reset by double-clicking the divider or from the command palette.
 * The 52 px icon rail (narrower windows, or a project's drawer open) is never
 * resized.
 */
import { test, expect } from './fixtures.js';
import { resetServer } from './reset-server.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { getTmuxNameForPrompt, injectSessionStart, injectToolUse } from './battle-helpers.js';
import {
  DASHBOARD_SPLIT_KEY,
  MAX_FINDINGS_WIDTH,
  MIN_FINDINGS_WIDTH,
  DEFAULT_NAV_WIDTH,
  MAX_NAV_WIDTH,
  MIN_NAV_WIDTH,
  NAV_WIDTH_KEY,
} from '../src/frontend/store/dashboard-layout-prefs.js';

const PROJECT_ID = 'github.com/org/nav-width';
// Floor the reading pane keeps beside the navigation (see styles.css: the
// 480 px terminal reserve minus the 52 px icon rail).
const READING_PANE_FLOOR = 428;

/** Open the dashboard with one working task, so the navigation has a project to list. */
async function openWithProject(page: Page, request: APIRequestContext, viewportWidth = 1440) {
  await page.setViewportSize({ width: viewportWidth, height: 900 });
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 10000 });

  const res = await request.post('/api/tasks', { data: { prompt: 'Navigation width task', cwd: '/tmp' } });
  expect(res.ok(), await res.text()).toBe(true);
  const taskId = (await res.json()).id as string;
  const tmux = await getTmuxNameForPrompt(request, 'Navigation width task');
  await injectSessionStart(request, tmux);
  await injectToolUse(request, tmux);
  expect((await request.post('/api/test/set-project-id', { data: { taskId, projectId: PROJECT_ID } })).ok()).toBe(true);
  expect((await request.post('/api/test/broadcast-project-summaries')).ok()).toBe(true);
  await expect(page.getByTestId('project-sidebar')).toBeVisible();
}

async function widthOf(page: Page, selector: string): Promise<number> {
  return Math.round((await page.locator(selector).boundingBox())?.width ?? 0);
}

const navWidth = (page: Page) => widthOf(page, '[data-testid="project-sidebar"]');
const storedNavWidth = (page: Page) => page.evaluate((key) => localStorage.getItem(key), NAV_WIDTH_KEY);

/** Press the divider, move the pointer `dx` px horizontally, and release. */
async function dragDivider(page: Page, dx: number) {
  const box = await page.getByTestId('nav-resizer').boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test.describe('resizable left navigation', () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test('dragging the divider resizes the navigation, the width survives a reload, and a double-click resets it', async ({ page, request }) => {
    await openWithProject(page, request);
    const divider = page.getByTestId('nav-resizer');
    await expect(divider).toBeVisible();
    await expect(divider).toHaveAttribute('role', 'separator');
    // What a screen reader needs from a focusable separator: a name, an
    // orientation, and the current value with its range.
    await expect(divider).toHaveAttribute('aria-label', 'Resize navigation');
    await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
    await expect(divider).toHaveAttribute('aria-valuenow', String(DEFAULT_NAV_WIDTH));
    await expect(divider).toHaveAttribute('aria-valuemin', String(MIN_NAV_WIDTH));
    await expect(divider).toHaveAttribute('aria-valuemax', String(MAX_NAV_WIDTH));
    expect(await navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBeNull();

    // A plain click is not a resize: it must not pin the current width.
    await divider.click();
    expect(await navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBeNull();

    await dragDivider(page, 100);
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 100);
    expect(await storedNavWidth(page)).toBe(String(DEFAULT_NAV_WIDTH + 100));
    await expect(divider).toHaveAttribute('aria-valuenow', String(DEFAULT_NAV_WIDTH + 100));

    await page.reload();
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 10000 });
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 100);

    await page.getByTestId('nav-resizer').dblclick();
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    // The key is removed, not rewritten with the default: nothing is pinned.
    expect(await storedNavWidth(page)).toBeNull();
  });

  test('the navigation follows the pointer during a drag and the width is stored only on release', async ({ page, request }) => {
    await openWithProject(page, request);
    const box = await page.getByTestId('nav-resizer').boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 6 });
    // Still held: the navigation has already moved, nothing is stored yet, and
    // the resize cursor is locked on the whole layout.
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 60);
    expect(await storedNavWidth(page)).toBeNull();
    await expect(page.locator('main.main')).toHaveClass(/main-resizing-nav/);
    await expect(page.getByTestId('nav-resizer')).toHaveClass(/dragging/);

    await page.mouse.up();
    expect(await storedNavWidth(page)).toBe(String(DEFAULT_NAV_WIDTH + 60));
    await expect(page.locator('main.main')).not.toHaveClass(/main-resizing-nav/);
    await expect(page.getByTestId('nav-resizer')).not.toHaveClass(/dragging/);

    // Released: the pointer no longer drags the navigation along.
    await page.mouse.move(x + 200, y + 40, { steps: 4 });
    expect(await navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 60);
    expect(await storedNavWidth(page)).toBe(String(DEFAULT_NAV_WIDTH + 60));
  });

  test('a click with a slightly unsteady hand is still a click, not a resize', async ({ page, request }) => {
    await openWithProject(page, request);
    const box = await page.getByTestId('nav-resizer').boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 1);
    await page.mouse.up();

    expect(await navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBeNull();
  });

  test('a drag far past either edge stops at the bounds', async ({ page, request }) => {
    await openWithProject(page, request);

    await dragDivider(page, 900);
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBe(String(MAX_NAV_WIDTH));

    await dragDivider(page, -900);
    await expect.poll(() => navWidth(page)).toBe(MIN_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBe(String(MIN_NAV_WIDTH));
    // Still usable at the minimum: queue names fit without being shortened, and
    // the project filter ends inside the navigation instead of running under its edge.
    const queueName = page.getByTestId('nav-queue-needs-you').locator('.project-nav-name');
    await expect(queueName).toBeVisible();
    expect(await queueName.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const nav = await page.getByTestId('project-sidebar').boundingBox();
    const filter = await page.getByTestId('project-sidebar-filter').boundingBox();
    expect(filter!.x + filter!.width).toBeLessThanOrEqual(nav!.x + nav!.width);
  });

  test('the divider is keyboard-operable and the command palette resets the width', async ({ page, request }) => {
    await openWithProject(page, request);
    const divider = page.getByTestId('nav-resizer');

    await divider.focus();
    // Each expected width stays strictly inside the bounds, so a wrong step
    // size cannot hide behind the clamp.
    await divider.press('ArrowRight');
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 16);
    await divider.press('Shift+ArrowRight');
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 16 + 48);
    await divider.press('ArrowLeft');
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH + 48);
    await divider.press('Shift+ArrowLeft');
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBe(String(DEFAULT_NAV_WIDTH));
    await divider.press('End');
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);
    await divider.press('Home');
    await expect.poll(() => navWidth(page)).toBe(MIN_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBe(String(MIN_NAV_WIDTH));

    await page.getByTestId('command-trigger').click();
    await page.getByTestId('command-palette-input').fill('reset navigation');
    await page.locator('[data-testid="command-palette-action"][data-action-id="reset-nav-width"]').click();
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    expect(await storedNavWidth(page)).toBeNull();
  });

  for (const [stored, expected] of [
    ['abc', DEFAULT_NAV_WIDTH],
    ['', DEFAULT_NAV_WIDTH],
    ['99999', MAX_NAV_WIDTH],
    ['-5', MIN_NAV_WIDTH],
  ] as const) {
    test(`a stored width of ${JSON.stringify(stored)} loads as ${expected} px`, async ({ page, request }) => {
      await page.addInitScript(
        ({ key, value }) => window.localStorage.setItem(key, value),
        { key: NAV_WIDTH_KEY, value: stored },
      );
      await openWithProject(page, request);
      await expect.poll(() => navWidth(page)).toBe(expected);
      await expect(page.getByTestId('nav-resizer')).toBeVisible();
    });
  }

  test('the icon rail is never resized: no divider under 1280 px or beside a project drawer', async ({ page, request }) => {
    await page.addInitScript(
      ({ key }) => window.localStorage.setItem(key, '400'),
      { key: NAV_WIDTH_KEY },
    );
    await openWithProject(page, request);
    await expect.poll(() => navWidth(page)).toBe(400);

    // A selected project opens its drawer and the navigation becomes the rail.
    await page.getByTestId(`project-icon-${PROJECT_ID}`).click();
    await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
    await expect.poll(() => navWidth(page)).toBe(52);
    await expect(page.getByTestId('nav-resizer')).toBeHidden();

    // Back on "All projects" the stored width applies again.
    await page.getByTestId('project-icon-all').click();
    await expect.poll(() => navWidth(page)).toBe(400);
    await expect(page.getByTestId('nav-resizer')).toBeVisible();

    await page.setViewportSize({ width: 1279, height: 900 });
    await expect.poll(() => navWidth(page)).toBe(52);
    await expect(page.getByTestId('nav-resizer')).toBeHidden();
  });

  test('while the coordinator findings pane is open, a wide navigation gives its extra width back', async ({ page, request }) => {
    // That pane is a fourth column. At 1280 px there is no room for it beside
    // a 480 px navigation, so the navigation is drawn at the default width
    // and the divider is hidden; the stored width is left alone.
    await page.addInitScript(
      ({ key, max }) => window.localStorage.setItem(key, String(max)),
      { key: NAV_WIDTH_KEY, max: MAX_NAV_WIDTH },
    );
    await openWithProject(page, request, 1280);
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);

    const trigger = page.getByRole('button', { name: /Coordinator findings/ });
    await trigger.click();
    await expect(page.getByTestId('coordinator-findings-pane')).toBeVisible();
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    await expect(page.getByTestId('nav-resizer')).toBeHidden();
    expect(await storedNavWidth(page)).toBe(String(MAX_NAV_WIDTH));

    // A window with room for all four columns keeps the chosen width.
    await page.setViewportSize({ width: 1700, height: 900 });
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);

    // Closing the pane restores the chosen width and the divider.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => navWidth(page)).toBe(DEFAULT_NAV_WIDTH);
    await trigger.click();
    await expect(page.getByTestId('coordinator-findings-pane')).toHaveCount(0);
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);
    await expect(page.getByTestId('nav-resizer')).toBeVisible();
  });

  test('at 1280 px the widest navigation leaves the task list its default width', async ({ page, request }) => {
    // The reason MAX_NAV_WIDTH is 480: on the narrowest window that shows this
    // layout, an untouched task list (28% of the window, 358 px) still fits
    // beside the reading pane's floor.
    await page.addInitScript(
      ({ key, max }) => window.localStorage.setItem(key, String(max)),
      { key: NAV_WIDTH_KEY, max: MAX_NAV_WIDTH },
    );
    await openWithProject(page, request, 1280);
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);

    await page.locator('.healthy-row').first().click();
    await expect(page.locator('.detail-panel')).toBeVisible();
    await expect.poll(() => widthOf(page, '.findings-panel')).toBe(Math.round(1280 * 0.28));
    await expect.poll(() => widthOf(page, '.detail-panel')).toBeGreaterThanOrEqual(READING_PANE_FLOOR);
  });

  test('at 1280 px the widest navigation and the widest stored task list still leave the reading pane its floor', async ({ page, request }) => {
    // Worst case: the narrowest window that shows this layout, the navigation
    // at its maximum, and the widest task list the other divider can store.
    await page.addInitScript(
      ({ navKey, navMax, splitKey, splitMax }) => {
        window.localStorage.setItem(navKey, String(navMax));
        window.localStorage.setItem(splitKey, String(splitMax));
      },
      { navKey: NAV_WIDTH_KEY, navMax: MAX_NAV_WIDTH, splitKey: DASHBOARD_SPLIT_KEY, splitMax: MAX_FINDINGS_WIDTH },
    );
    await openWithProject(page, request, 1280);
    await expect.poll(() => navWidth(page)).toBe(MAX_NAV_WIDTH);

    // What is left for the task list once the navigation and the reading
    // pane's floor are taken out of the window.
    const taskListRoom = 1280 - MAX_NAV_WIDTH - READING_PANE_FLOOR;
    expect(taskListRoom).toBeGreaterThanOrEqual(MIN_FINDINGS_WIDTH);

    await page.locator('.healthy-row').first().click();
    await expect(page.locator('.detail-panel')).toBeVisible();
    await expect.poll(() => widthOf(page, '.findings-panel')).toBe(taskListRoom);
    await expect.poll(() => widthOf(page, '.detail-panel')).toBe(READING_PANE_FLOOR);

    // The other divider's own upper bound follows the navigation's width: its
    // widest setting stores what fits, not the 720 px it allows on a wide window.
    const findingsDivider = page.getByTestId('findings-resizer');
    await expect(findingsDivider).toHaveAttribute('aria-valuemax', String(taskListRoom));
    await findingsDivider.focus();
    await page.keyboard.press('End');
    await expect.poll(
      () => page.evaluate((key) => localStorage.getItem(key), DASHBOARD_SPLIT_KEY),
    ).toBe(String(taskListRoom));
    await expect.poll(() => widthOf(page, '.detail-panel')).toBe(READING_PANE_FLOOR);

    // The reading pane ends inside the window rather than being cut off by it.
    const pane = await page.locator('.detail-panel').boundingBox();
    expect(pane!.x + pane!.width).toBeLessThanOrEqual(1280);
  });
});
