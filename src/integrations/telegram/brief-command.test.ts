import { describe, expect, test } from 'vitest';
import type { OperatorInbox } from '../../shared/contracts/operator-inbox.js';
import {
  fixtureInbox,
  fixtureSources,
  KOOKR_CWD,
  NOW,
  PLANTED_COMMAND,
  PLANTED_ERROR,
  PLANTED_TOKEN,
  WEBSITE_CWD,
} from '../../../test/fixtures/operator-inbox.js';
import { BRIEF_REPLY_MAX_CHARS, formatBriefReply, isBriefCommand } from './brief-command.js';

const BASE = 'https://kookr.example.com';

describe('isBriefCommand', () => {
  test('matches /brief with or without the bot suffix, and nothing with arguments', () => {
    expect(isBriefCommand('/brief')).toBe(true);
    expect(isBriefCommand('/brief@kookr_core_bot')).toBe(true);
    expect(isBriefCommand('/brief  ')).toBe(true);
    expect(isBriefCommand('/brief me')).toBe(false);
    expect(isBriefCommand('/briefing')).toBe(false);
  });
});

describe('formatBriefReply', () => {
  test('both projects enabled: five items, oldest first, after the totals line', () => {
    const reply = formatBriefReply(fixtureInbox(), { allowedCwds: [KOOKR_CWD, WEBSITE_CWD], dashboardBaseUrl: BASE, now: NOW });
    const lines = reply.text.split('\n');
    expect(lines[0]).toBe('5 waiting: 1 permission prompt, 1 question, 1 flagged task, 1 review, train halted');
    const order = ['Release the build', 'Redesign settings page', 'Upgrade dependencies', 'Fix login redirect', 'integration train']
      .map((needle) => reply.text.indexOf(needle));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(reply.text).toContain('🔐 50 min · "Release the build" (kookr) wants permission to use Bash');
    expect(reply.text).toContain(`${BASE}/?task=perm`);
    expect(reply.text).toContain('"Which layout should the settings page use?');
    expect(reply).toMatchObject({ namedCount: 5, hiddenCount: 0 });
  });

  test('never shows the command, the error text or a secret', () => {
    const reply = formatBriefReply(fixtureInbox(), { allowedCwds: [], dashboardBaseUrl: BASE, now: NOW });
    expect(reply.text).not.toContain(PLANTED_COMMAND);
    expect(reply.text).not.toContain('git push');
    expect(reply.text).not.toContain(PLANTED_ERROR);
    expect(reply.text).not.toContain(PLANTED_TOKEN);
    // Even when the inbox itself carried an unredacted name and question.
    const raw = fixtureInbox();
    const leaky: OperatorInbox = {
      ...raw,
      items: raw.items.map((item) => ({ ...item, taskName: `${item.taskName ?? ''} ${PLANTED_TOKEN}`, ...(item.question ? { question: `${item.question} ${PLANTED_TOKEN}` } : {}) })),
    };
    expect(formatBriefReply(leaky, { allowedCwds: [], dashboardBaseUrl: BASE, now: NOW }).text).not.toContain(PLANTED_TOKEN);
  });

  test('items in projects not enabled here are counted but not named; the train is always named', () => {
    const reply = formatBriefReply(fixtureInbox(), { allowedCwds: [KOOKR_CWD], dashboardBaseUrl: BASE, now: NOW });
    expect(reply.text.split('\n')[0]).toBe('5 waiting: 1 permission prompt, 1 question, 1 flagged task, 1 review, train halted');
    expect(reply.text).toContain('Release the build');
    expect(reply.text).toContain('Fix login redirect');
    expect(reply.text).toContain('integration train is halted');
    expect(reply.text).not.toContain('Redesign settings page');
    expect(reply.text).not.toContain('Upgrade dependencies');
    expect(reply.text).not.toContain('Which layout');
    expect(reply.text).toContain('And 2 in projects not enabled here.');
    expect(reply).toMatchObject({ namedCount: 3, hiddenCount: 2 });
  });

  test('an item whose task has no known directory is counted, not named', () => {
    const raw = fixtureInbox();
    const inbox: OperatorInbox = { ...raw, items: raw.items.map((item) => (item.kind === 'question' ? { ...item, cwd: undefined } : item)) };
    const reply = formatBriefReply(inbox, { allowedCwds: [KOOKR_CWD, WEBSITE_CWD], dashboardBaseUrl: BASE, now: NOW });
    expect(reply.text).not.toContain('Which layout');
    expect(reply.text).toContain('And 1 in projects not enabled here.');
  });

  test('an empty inbox is the summary alone', () => {
    const quiet = fixtureInbox({
      liveTasks: fixtureSources().liveTasks.map((task) => ({ ...task, pendingSignal: undefined })),
      monitor: { getCurrentAnomaly: () => null, getAgentEvents: () => [], getAgentState: () => ({ anomaly: null }) },
      asks: [],
      train: null,
    });
    expect(formatBriefReply(quiet, { allowedCwds: [KOOKR_CWD], dashboardBaseUrl: BASE, now: NOW }).text)
      .toBe('Nothing is waiting on you. 5 tasks are working in 2 projects.');
  });

  test('a long inbox fills up to the limit and keeps both footers with the right counts', () => {
    const raw = fixtureInbox();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...raw.items[3], taskId: `review-${i}`, taskName: `Review task number ${i} with a fairly long descriptive name` }));
    const inbox: OperatorInbox = { ...raw, items: [...many, { ...raw.items[1], cwd: '/elsewhere' }] };
    const reply = formatBriefReply(inbox, { allowedCwds: [KOOKR_CWD], dashboardBaseUrl: BASE, now: NOW });
    expect(reply.text.length).toBeLessThanOrEqual(BRIEF_REPLY_MAX_CHARS);
    expect(reply.text.length).toBeGreaterThan(BRIEF_REPLY_MAX_CHARS - 400);
    const shown = (reply.text.match(/Review task number \d+/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(reply.text.endsWith(`…and ${60 - shown} more here: kookr brief lists them all.\nAnd 1 in projects not enabled here.`)).toBe(true);
  });

  test('a partly hidden inbox leaks nothing either', () => {
    const text = formatBriefReply(fixtureInbox(), { allowedCwds: [KOOKR_CWD], dashboardBaseUrl: BASE, now: NOW }).text;
    for (const planted of [PLANTED_COMMAND, PLANTED_ERROR, PLANTED_TOKEN]) expect(text).not.toContain(planted);
  });
});
