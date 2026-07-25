import { describe, test, expect } from 'vitest';
import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { KB_LESSON_SKIP_MARKER } from './kb-lesson-classifier.js';

/**
 * Contract tests for the post-task KB lesson decision policy (issue #227).
 *
 * The policy lives in `CLAUDE.md` because both Claude Code and Codex CLI
 * agents read it (Codex CLI cannot read Claude Code memory — see CLAUDE.md
 * "Persistence Mechanism Picker"). `AGENTS.md` is a symlink to `CLAUDE.md`,
 * so a single edit covers both runtimes; we still verify the symlink relation
 * here so a future split couldn't silently desync the two.
 */
describe('post-task KB lesson decision policy', () => {
  const repoRoot = join(import.meta.dirname, '..', '..');
  const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8');
  const agentsMd = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf-8');

  test('CLAUDE.md surfaces the post-task lesson decision protocol inside the KB-First section', () => {
    expect(claudeMd).toContain('### Post-task lesson decision');
    expect(claudeMd).toContain('kb remember --kb=agent-task-lessons');
    // The skip marker MUST match the classifier constant verbatim — the
    // report uses literal substring matching, so a drift here would
    // silently break detection.
    expect(claudeMd).toContain(KB_LESSON_SKIP_MARKER);

    // The decision sub-section MUST live under `## KB-First Task Policy` and
    // before `## Persistence Mechanism Picker` — that ordering is what gives
    // it its KB-lookup carveout context.
    const kbPolicyIdx = claudeMd.indexOf('## KB-First Task Policy');
    const decisionIdx = claudeMd.indexOf('### Post-task lesson decision');
    const persistenceIdx = claudeMd.indexOf('## Persistence Mechanism Picker');
    expect(kbPolicyIdx).toBeGreaterThan(0);
    expect(decisionIdx).toBeGreaterThan(kbPolicyIdx);
    expect(persistenceIdx).toBeGreaterThan(decisionIdx);
  });

  test('AGENTS.md is a symlink to CLAUDE.md so the two runtimes cannot desync', () => {
    // readFileSync transparently follows symlinks, so a future commit that
    // replaces AGENTS.md with a duplicated regular file would still report
    // identical content today and silently drift later. Pin the symlink
    // relation itself, not just byte equality.
    const agentsMdPath = join(repoRoot, 'AGENTS.md');
    const stat = lstatSync(agentsMdPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMdPath)).toBe('CLAUDE.md');
    // Belt-and-suspenders: also confirm the resolved bytes match, in case
    // the symlink ever points somewhere else.
    expect(agentsMd).toBe(claudeMd);
  });

  test('mechanical-task carveout is preserved so the nudge stays low-noise', () => {
    expect(claudeMd).toMatch(/purely mechanical/i);
  });

  test('CLAUDE.md documents the completion-ready lesson-decision gate (issue #1538)', () => {
    expect(claudeMd).toContain('lesson_decision_required');
    expect(claudeMd).toMatch(/completion-ready/i);
    expect(claudeMd).toContain('/api/diagnostics/lesson-yield');
  });
});
