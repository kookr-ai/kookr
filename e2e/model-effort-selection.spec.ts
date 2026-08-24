import { test, expect } from './fixtures.js';

test.describe('model and effort parity', () => {
  test('launch dialog exposes both controls for every registered agent', async ({ page }) => {
    await page.addInitScript(() => {
      const frames: string[] = [];
      Object.defineProperty(window, '__kookrLaunchFrames', { value: frames });
      const nativeSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function send(data) {
        if (typeof data === 'string') frames.push(data);
        return nativeSend.call(this, data);
      };
    });
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await page.locator('.btn-launch').click();
    const dialog = page.getByRole('dialog', { name: 'Launch New Task' });
    await expect(dialog).toBeVisible();

    const agent = dialog.getByLabel('Agent');
    const agentTypes = await agent.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
    );
    expect(agentTypes.length).toBeGreaterThan(0);

    for (const agentType of agentTypes) {
      await agent.selectOption(agentType);
      const effort = dialog.getByLabel('Reasoning effort').first();
      const model = dialog.getByLabel('Model').first();
      await expect(effort).toBeVisible();
      await expect(model).toBeVisible();
      if (await effort.evaluate((element) => element.tagName) === 'SELECT') {
        await effort.selectOption({ index: 1 });
      } else {
        await effort.fill('custom-effort');
      }
      if (await model.evaluate((element) => element.tagName) === 'SELECT') {
        await model.selectOption({ index: 1 });
      } else {
        await model.fill('custom-model');
      }
      const expectedLaunchCount = await page.evaluate(() => {
        const frames = (window as Window & { __kookrLaunchFrames?: string[] }).__kookrLaunchFrames ?? [];
        return frames.filter((frame) => frame.includes('"type":"launch"')).length + 1;
      });
      await dialog.getByRole('textbox', { name: 'Task description' }).fill(`model-effort-${agentType}`);
      await dialog.getByRole('button', { name: 'Launch', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect.poll(async () => page.evaluate(() => {
        const frames = (window as Window & { __kookrLaunchFrames?: string[] }).__kookrLaunchFrames ?? [];
        return frames.filter((frame) => frame.includes('"type":"launch"')).length;
      })).toBe(expectedLaunchCount);
      const message = await page.evaluate(() => {
        const frames = (window as Window & { __kookrLaunchFrames?: string[] }).__kookrLaunchFrames ?? [];
        const launch = frames.filter((frame) => frame.includes('"type":"launch"')).at(-1);
        return launch ? JSON.parse(launch) as Record<string, unknown> : null;
      });
      expect(message).toMatchObject({
        type: 'launch',
        agentType,
      });
      expect(typeof message?.effort).toBe('string');
      expect(typeof message?.model).toBe('string');
      if (agentType !== agentTypes.at(-1)) {
        await page.locator('.btn-launch').click();
        await expect(dialog).toBeVisible();
      }
    }

    await page.keyboard.press('Escape');
  });
});
