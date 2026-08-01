import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFeedbackBundle } from './write-feedback-bundle.js';
import type { InteractionEvent } from '../../core/interaction-log.js';
import type { FeedbackBundle } from '../../core/feedback-bundle.js';
import { aSession, aTask } from '../../core/__fixtures__/task-builders.js';

const feedbackTask = aTask({
  id: 'task-fb-1',
  name: 'Feedback target',
  prompt: 'Ship the feature',
  agentType: 'claude-code',
  cwd: '/tmp/project',
  sessions: [
    aSession({
      tmuxSession: 'sess-present',
      cwd: '/tmp/project',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    aSession({
      tmuxSession: 'sess-missing',
      cwd: '/tmp/project',
      createdAt: new Date('2026-01-01T00:01:00.000Z'),
    }),
  ],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

async function setupFeedbackDirs(): Promise<{
  dir: string;
  feedbackDir: string;
  hooksDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'write-feedback-bundle-'));
  const feedbackDir = join(dir, 'feedback');
  const hooksDir = join(dir, 'hooks');
  await mkdir(hooksDir);
  return { dir, feedbackDir, hooksDir };
}

describe('writeFeedbackBundle', () => {
  test('missing hook does not throw and is omitted from hookFiles', async () => {
    const { dir, feedbackDir, hooksDir } = await setupFeedbackDirs();
    // Only one of two session hook files is present
    await writeFile(join(hooksDir, 'sess-present.jsonl'), '{"type":"SessionStart"}\n', 'utf-8');

    try {
      const result = await writeFeedbackBundle(
        feedbackTask,
        { rating: 'down', downReason: 'agent_behavior' },
        {
          feedbackDir,
          hooksDir,
          readInteractionLog: async () => [],
        },
      );

      const bundle = JSON.parse(await readFile(join(result.bundlePath, 'bundle.json'), 'utf-8')) as FeedbackBundle;
      expect(bundle.hookFiles).toEqual(['hook-sess-present.jsonl']);
      expect(bundle.hookFiles).not.toContain('hook-sess-missing.jsonl');
      expect(await readFile(join(result.bundlePath, 'hook-sess-present.jsonl'), 'utf-8')).toContain('SessionStart');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('bundle.json includes rating, agentType, and taskPrompt', async () => {
    const { dir, feedbackDir, hooksDir } = await setupFeedbackDirs();

    try {
      const result = await writeFeedbackBundle(
        feedbackTask,
        { rating: 'up', note: 'great work' },
        {
          feedbackDir,
          hooksDir,
          readInteractionLog: async () => [],
        },
      );

      const bundle = JSON.parse(await readFile(join(result.bundlePath, 'bundle.json'), 'utf-8')) as FeedbackBundle;
      expect(bundle.rating).toBe('up');
      expect(bundle.agentType).toBe('claude-code');
      expect(bundle.taskPrompt).toBe('Ship the feature');
      expect(bundle.taskId).toBe('task-fb-1');
      expect(bundle.note).toBe('great work');
      // No sessions had hook files — hookFiles is empty, not thrown
      expect(bundle.hookFiles).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('present hook is copied into the bundle dir', async () => {
    const { dir, feedbackDir, hooksDir } = await setupFeedbackDirs();
    await writeFile(join(hooksDir, 'sess-present.jsonl'), '{"type":"PostToolUse"}\n', 'utf-8');

    try {
      const result = await writeFeedbackBundle(
        aTask({
          id: 'task-fb-copy',
          prompt: 'copy hook',
          sessions: [aSession({ tmuxSession: 'sess-present' })],
        }),
        { rating: 'up' },
        {
          feedbackDir,
          hooksDir,
          readInteractionLog: async () => [],
        },
      );

      const bundle = JSON.parse(await readFile(join(result.bundlePath, 'bundle.json'), 'utf-8')) as FeedbackBundle;
      expect(bundle.hookFiles).toEqual(['hook-sess-present.jsonl']);
      expect(await readFile(join(result.bundlePath, 'hook-sess-present.jsonl'), 'utf-8')).toContain('PostToolUse');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two sequential writes create two dirs and leave the prior dir intact', async () => {
    const { dir, feedbackDir, hooksDir } = await setupFeedbackDirs();
    await writeFile(join(hooksDir, 'sess-present.jsonl'), '{"type":"SessionStart"}\n', 'utf-8');

    const singleSessionTask = aTask({
      id: 'task-fb-immutable',
      prompt: 'immutable bundles',
      agentType: 'codex-cli',
      sessions: [aSession({ tmuxSession: 'sess-present' })],
    });

    try {
      const first = await writeFeedbackBundle(
        singleSessionTask,
        { rating: 'up' },
        {
          feedbackDir,
          hooksDir,
          readInteractionLog: async () => [],
        },
      );

      // Ensure distinct bundleIds (ISO-based ids need at least 1ms separation)
      await new Promise((r) => setTimeout(r, 5));

      const second = await writeFeedbackBundle(
        singleSessionTask,
        { rating: 'down', downReason: 'my_prompt', note: 'second write' },
        {
          feedbackDir,
          hooksDir,
          readInteractionLog: async () => [],
        },
      );

      expect(first.bundleId).not.toBe(second.bundleId);
      expect(first.bundlePath).not.toBe(second.bundlePath);

      // Prior dir still exists with original contents
      const firstBundle = JSON.parse(await readFile(join(first.bundlePath, 'bundle.json'), 'utf-8')) as FeedbackBundle;
      expect(firstBundle.rating).toBe('up');
      expect(firstBundle.note).toBeUndefined();
      expect(await readFile(join(first.bundlePath, 'hook-sess-present.jsonl'), 'utf-8')).toContain('SessionStart');

      const secondBundle = JSON.parse(await readFile(join(second.bundlePath, 'bundle.json'), 'utf-8')) as FeedbackBundle;
      expect(secondBundle.rating).toBe('down');
      expect(secondBundle.note).toBe('second write');
      expect(secondBundle.downReason).toBe('my_prompt');

      // Task parent has exactly two bundle subdirs
      const taskDir = join(feedbackDir, singleSessionTask.id);
      const entries = await readdir(taskDir);
      expect(entries).toHaveLength(2);
      expect(entries).toContain(first.bundleId);
      expect(entries).toContain(second.bundleId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writes interaction-slice.jsonl filtered to the task', async () => {
    const { dir, feedbackDir, hooksDir } = await setupFeedbackDirs();
    await writeFile(join(hooksDir, 'sess-present.jsonl'), '{"type":"SessionStart"}\n', 'utf-8');

    const events: InteractionEvent[] = [
      {
        type: 'user_input',
        agentId: 'sess-present',
        content: 'task-related',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        type: 'user_input',
        agentId: 'other-sess',
        content: 'noise',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];

    try {
      const result = await writeFeedbackBundle(
        aTask({
          id: 'task-fb-slice',
          prompt: 'slice',
          sessions: [aSession({ tmuxSession: 'sess-present' })],
        }),
        { rating: 'up' },
        {
          feedbackDir,
          hooksDir,
          readInteractionLog: async () => events,
        },
      );

      const sliceText = await readFile(join(result.bundlePath, 'interaction-slice.jsonl'), 'utf-8');
      expect(sliceText).toContain('task-related');
      expect(sliceText).not.toContain('noise');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
