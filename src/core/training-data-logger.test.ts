import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to mock homedir so the logger writes to a temp directory
import { vi } from 'vitest';
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import { homedir } from 'node:os';
import { logTaskNaming, logResponseSuggestions, getTrainingDataDir } from './training-data-logger.js';

describe('training-data-logger', () => {
  let tempDir: string;
  const mockedHomedir = vi.mocked(homedir);

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-training-'));
    mockedHomedir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('logTaskNaming', () => {
    test('writes a JSONL entry with prompt, cwd, and output', async () => {
      logTaskNaming('Fix the auth bug', '/home/user/project', undefined, 'Fix JWT token invalidation');

      const filePath = join(tempDir, '.kookr', 'training-data', 'task-naming.jsonl');

      // Wait for the fire-and-forget write to complete
      await vi.waitFor(() => {
        const content = readFileSync(filePath, 'utf-8');
        expect(content.includes('"timestamp":')).toBe(true);
      }, { timeout: 2000 });

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.input.prompt).toBe('Fix the auth bug');
      expect(entry.input.cwd).toBe('/home/user/project');
      expect(entry.output).toBe('Fix JWT token invalidation');
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
      expect(entry.input.criteria).toBeUndefined();
    });

    test('includes criteria when provided', async () => {
      logTaskNaming('Add pagination', '/project', 'All tests pass', 'Add user pagination');

      const filePath = join(tempDir, '.kookr', 'training-data', 'task-naming.jsonl');
      await vi.waitFor(() => {
        const content = readFileSync(filePath, 'utf-8');
        expect(content.includes('"timestamp":')).toBe(true);
      }, { timeout: 2000 });
      const content = readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(content.trim());
      expect(entry.input.prompt).toBe('Add pagination');
      expect(entry.input.cwd).toBe('/project');
      expect(entry.input.criteria).toBe('All tests pass');
      expect(entry.output).toBe('Add user pagination');
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    test('appends multiple entries on separate lines', async () => {
      logTaskNaming('Fix bug', '/project', undefined, 'Fix login flow');
      logTaskNaming('Add feature', '/project', undefined, 'Add dark mode toggle');

      const filePath = join(tempDir, '.kookr', 'training-data', 'task-naming.jsonl');
      await vi.waitFor(() => {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        expect(lines).toHaveLength(2);
      }, { timeout: 2000 });

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      const outputs = lines.map(l => JSON.parse(l).output).sort();
      expect(outputs).toEqual(['Add dark mode toggle', 'Fix login flow']);
    });

    test('does not throw on write failure', () => {
      // Point homedir to an invalid path
      mockedHomedir.mockReturnValue('/nonexistent/root/path\0invalid');
      expect(() => {
        logTaskNaming('Fix bug', '/project', undefined, 'Fix it');
      }).not.toThrow();
    });
  });

  describe('logResponseSuggestions', () => {
    test('writes a JSONL entry with context and suggestions', async () => {
      const ctx = {
        lastAssistantMessage: 'I found the bug. Should I fix it?',
        taskPrompt: 'Fix auth',
        cwd: '/project',
        recentToolCalls: ['Read', 'Grep'],
      };
      logResponseSuggestions(ctx, ['yes go ahead', 'wait, let me check', 'no revert it']);

      const filePath = join(tempDir, '.kookr', 'training-data', 'response-suggestions.jsonl');
      await vi.waitFor(() => {
        const content = readFileSync(filePath, 'utf-8');
        expect(content.includes('"timestamp":')).toBe(true);
      }, { timeout: 2000 });

      const content = readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(content.trim());
      expect(entry.input.lastAssistantMessage).toBe('I found the bug. Should I fix it?');
      expect(entry.input.taskPrompt).toBe('Fix auth');
      expect(entry.input.cwd).toBe('/project');
      expect(entry.input.recentToolCalls).toEqual(['Read', 'Grep']);
      expect(entry.output).toEqual(['yes go ahead', 'wait, let me check', 'no revert it']);
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    test('omits optional fields when not provided', async () => {
      logResponseSuggestions(
        { lastAssistantMessage: 'Done.' },
        ['ok'],
      );

      const filePath = join(tempDir, '.kookr', 'training-data', 'response-suggestions.jsonl');
      await vi.waitFor(() => {
        const content = readFileSync(filePath, 'utf-8');
        expect(content.includes('"timestamp":')).toBe(true);
      }, { timeout: 2000 });
      const content = readFileSync(filePath, 'utf-8');
      const entry = JSON.parse(content.trim());
      expect(entry.input.lastAssistantMessage).toBe('Done.');
      expect(entry.input).not.toHaveProperty('taskPrompt');
      expect(entry.input).not.toHaveProperty('cwd');
      expect(entry.input).not.toHaveProperty('recentToolCalls');
      expect(entry.output).toEqual(['ok']);
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    test('does not throw on write failure', () => {
      mockedHomedir.mockReturnValue('/nonexistent/root/path\0invalid');
      expect(() => {
        logResponseSuggestions({ lastAssistantMessage: 'hi' }, ['ok']);
      }).not.toThrow();
    });
  });

  describe('getTrainingDataDir', () => {
    test('returns path under mocked home/.kookr/training-data', () => {
      const dir = getTrainingDataDir();
      expect(dir).toBe(join(tempDir, '.kookr', 'training-data'));
    });
  });
});
