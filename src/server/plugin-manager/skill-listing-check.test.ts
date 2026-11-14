import { describe, test, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkSkillsForPlugins,
  findSkillListingNames,
  readTranscriptSkillListing,
} from './skill-listing-check.js';
import { createSkillListingCheckProcessor } from '../event-processors/skill-listing-check-processor.js';
import type { Task } from '../../core/tasks.js';
import type { TaskLoadoutRecord } from '../../shared/contracts/plugins.js';

// Shaped like a real Claude Code transcript: the skill listing is an attachment
// line near the start, with namespaced names.
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { content: 'hi' }, uuid: 'u1' }),
  JSON.stringify({
    type: 'attachment',
    uuid: 'a1',
    attachment: {
      type: 'skill_listing',
      isInitial: true,
      skillCount: 3,
      content: '- kookr-toolkit:agent-safety: ...',
      names: ['kookr-toolkit:agent-safety', 'kookr-toolkit:tdd-workflow', 'notes:write'],
    },
  }),
  JSON.stringify({ type: 'assistant', message: { content: 'ok' }, uuid: 'x1' }),
].join('\n');

describe('skill listing check', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  test('finds the names of the skill_listing record', () => {
    expect(findSkillListingNames(TRANSCRIPT.split('\n'))).toEqual([
      'kookr-toolkit:agent-safety', 'kookr-toolkit:tdd-workflow', 'notes:write',
    ]);
    expect(findSkillListingNames(['{"type":"user"}'])).toBeNull();
  });

  test('marks each plugin by whether a skill carries its name prefix', () => {
    expect(checkSkillsForPlugins(['notes@m', 'rust-analyzer-lsp@official'], ['notes:write', 'kookr-toolkit:x']))
      .toEqual({ 'notes@m': 'skills_seen', 'rust-analyzer-lsp@official': 'no_skills_seen' });
  });

  test('reads the listing from a transcript file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-skill-listing-'));
    const path = join(dir, 't.jsonl');
    writeFileSync(path, TRANSCRIPT);
    expect(await readTranscriptSkillListing(path)).toContain('notes:write');
    expect(await readTranscriptSkillListing(join(dir, 'missing.jsonl'))).toBeNull();
  });

  test('processor: stores the result once on the loadout record, from the Stop session transcript', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-skill-listing-'));
    const path = join(dir, 't.jsonl');
    writeFileSync(path, TRANSCRIPT);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const loadout: TaskLoadoutRecord = {
      resolved: { enabledOverrides: { 'notes@m': true, 'lsp@m': true }, deniedSkills: [] },
      winningLevel: 'fleet', mode: 'bypass', settingsHash: null, settingsPath: null, recordedAt: 'then',
      plugins: [{ id: 'notes@m', version: '1.0.0', installPath: null }, { id: 'lsp@m', version: '1.0.0', installPath: null }],
      skipped: [],
    };
    let task = { id: 't1', loadout, sessions: [{ tmuxSession: 'kookr-1', transcriptPath: path }] } as unknown as Task;
    const writes: TaskLoadoutRecord[] = [];
    const taskStore = {
      getTask: () => task,
      setLoadout: (_id: string, l: TaskLoadoutRecord | undefined) => {
        writes.push(l!);
        task = { ...task, loadout: l } as Task;
        return task;
      },
    };
    const processor = createSkillListingCheckProcessor({ taskStore, now: () => new Date('2026-11-14T00:00:00Z') });
    await processor.process({ id: 't1' }, 'kookr-1');
    await processor.process({ id: 't1' }, 'kookr-1'); // second Stop: already checked
    expect(writes).toHaveLength(1);
    expect(writes[0].skillCheck).toEqual({
      checkedAt: '2026-11-14T00:00:00.000Z',
      results: { 'notes@m': 'skills_seen', 'lsp@m': 'no_skills_seen' },
    });
  });

  test('processor: a task with no given plugins is never read', async () => {
    const read = vi.fn();
    const processor = createSkillListingCheckProcessor({
      taskStore: { getTask: () => ({ id: 't', sessions: [] }) as unknown as Task, setLoadout: vi.fn() as never },
      readSkillListing: read,
    });
    await processor.process({ id: 't' }, 'x');
    expect(read).not.toHaveBeenCalled();
  });
});
