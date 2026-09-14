import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { TaskSqliteStore } from './task-sqlite-store.js';
import { TaskStore } from './tasks.js';

const writerPath = fileURLToPath(new URL('../../test/fixtures/task-sqlite-crash-writer.ts', import.meta.url));
const tsxPath = createRequire(import.meta.url).resolve('tsx');

async function withDeadline<T>(label: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function crashWriter(dbPath: string, inputPath: string, phase: 'mid-flush' | 'after-commit'): Promise<void> {
  const child = spawn(process.execPath, ['--import', tsxPath, writerPath, dbPath, inputPath, phase], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('\n')) {
        if (output === `READY ${phase}\n`) resolve();
        else reject(new Error(`Unexpected writer barrier: ${output}`));
      }
    });
    child.once('error', reject);
    void closed.then(({ code, signal }) => {
      reject(new Error(`Writer exited before its barrier: ${code ?? signal}\n${stderr}`));
    });
  });

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    await withDeadline(`Writer ${phase} readiness`, 10_000, ready);
  } finally {
    // Also reap the owned child on startup failure, a missing barrier, or timeout.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    exit = await withDeadline('Writer SIGKILL cleanup', 5_000, closed);
  }
  expect(exit, stderr).toEqual({ code: null, signal: 'SIGKILL' });
}

describe('TaskSqliteStore abrupt writer death', () => {
  test.each(['mid-flush', 'after-commit'] as const)(
    'SIGKILL %s preserves the last committed tasks and complete session mappings',
    async (phase) => {
      const dir = mkdtempSync(join(tmpdir(), 'kookr-sqlite-crash-'));
      try {
        const memory = new TaskStore();
        for (const name of ['first', 'second']) {
          const task = memory.createTask(name, dir);
          memory.renameTask(task.id, `before-${name}`);
          for (const n of [1, 2]) {
            memory.addSession(task.id, {
              tmuxSession: `old-${name}-${n}`,
              agentType: 'claude-code',
              cwd: dir,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              lastStatus: 'completed',
            });
          }
        }
        const before = memory.getAllTasks();
        const after = before.map((task) => ({
          ...task,
          name: `after-${task.prompt}`,
          status: 'inProgress' as const,
          sessions: task.sessions.map((session) => ({
            ...session,
            tmuxSession: session.tmuxSession.replace('old-', 'new-'),
            lastStatus: 'running' as const,
          })),
        }));
        const inputPath = join(dir, 'input.json');
        const dbPath = join(dir, 'tasks.sqlite');
        writeFileSync(inputPath, JSON.stringify({ before, after }));

        await crashWriter(dbPath, inputPath, phase);

        const expected = phase === 'mid-flush' ? before : after;
        const reopened = new TaskSqliteStore(dbPath);
        try {
          const loaded = reopened.loadAll();
          expect(loaded.quarantinedRows).toBe(0);
          expect(loaded.tasks.sort((a, b) => a.id.localeCompare(b.id)))
            .toEqual([...expected].sort((a, b) => a.id.localeCompare(b.id)));
        } finally {
          reopened.close();
        }

        // Read the projection separately: loadAll hydrates sessions from task JSON,
        // so checking that alone would miss a partially replaced task_sessions table.
        const raw = new Database(dbPath, { readonly: true });
        try {
          expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
          expect(raw.pragma('foreign_key_check')).toEqual([]);
          expect(raw.prepare('SELECT * FROM task_sessions ORDER BY tmux_session').all()).toEqual(
            expected.flatMap((task) => task.sessions.map((session) => ({
              tmux_session: session.tmuxSession,
              task_id: task.id,
              last_status: session.lastStatus,
            }))).sort((a, b) => a.tmux_session.localeCompare(b.tmux_session)),
          );
        } finally {
          raw.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
