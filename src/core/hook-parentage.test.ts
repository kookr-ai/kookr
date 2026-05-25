import { describe, expect, it } from 'vitest';
import {
  classifyHookParentage,
  createSessionRuntimeIdentity,
  recordSessionStart,
} from './hook-parentage.js';

describe('classifyHookParentage', () => {
  const now = new Date('2026-05-13T12:00:00Z').toISOString();
  const parentTranscript = '/home/jean/.codex/sessions/rollout-2026-05-20T21-10-13-codex-parent.jsonl';
  const childTranscript = '/home/jean/.codex/sessions/rollout-2026-05-20T21-10-24-codex-child.jsonl';

  it('returns unknown when parent has not been established', () => {
    const identity = createSessionRuntimeIdentity();
    expect(classifyHookParentage('codex-abc', identity)).toBe('unknown');
  });

  it('returns unknown when raw session id is missing', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', undefined, now);
    expect(classifyHookParentage(undefined, identity)).toBe('unknown');
  });

  it('returns parent for the established parent session id', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', now);
    expect(classifyHookParentage('codex-parent', identity)).toBe('parent');
  });

  it('returns child when the provider reuses the parent session id with a child transcript', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', parentTranscript, now);
    recordSessionStart(identity, 'codex-parent', childTranscript, now);

    expect(classifyHookParentage('codex-parent', identity, childTranscript)).toBe('child');
    expect(classifyHookParentage('codex-parent', identity, parentTranscript)).toBe('parent');
  });

  it('keeps same-session-id events parent when ownership of the transcript is ambiguous', () => {
    // Neither transcript embeds the session id, so the transcript-path heuristic
    // cannot fire. Without a prior SessionStart for the new transcript, we err
    // toward parent so a benign turn rotation is not silently dropped.
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/parent.jsonl', now);

    expect(classifyHookParentage('codex-parent', identity, '/t/new-turn.jsonl')).toBe('parent');
  });

  it('returns child for a sidechain transcript without a prior SessionStart (codex spawn_agent)', () => {
    // Codex spawn_agent reuses the parent session id but the sidechain transcript
    // is named after the subagent's own uuid. The subagent's UserPromptSubmit can
    // arrive before its SessionStart is recorded — classification must still
    // recognize it as a child so the AI-authored prompt does not surface in the
    // parent activity panel as "You". Classification stays pure: the identity
    // child registry is not mutated as a side effect.
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', parentTranscript, now);

    expect(classifyHookParentage('codex-parent', identity, childTranscript)).toBe('child');
    expect(identity.childSessionIds.size).toBe(0);
    // The parent's own transcript still classifies as parent on the same call site.
    expect(classifyHookParentage('codex-parent', identity, parentTranscript)).toBe('parent');
  });

  it('returns child for a Claude Code sidechain transcript without a prior SessionStart', () => {
    // Claude Code sidechain transcripts live next to the parent transcript but
    // are named after the subagent session id, even when the hook payload's
    // session_id still references the parent. Paths are inert test data — never
    // touched on disk — so literal fixtures keep the test deterministic.
    const claudeParent = '/tmp/test/.claude/projects/-repo/parent-uuid-1234.jsonl';
    const claudeChild = '/tmp/test/.claude/projects/-repo/sidechain-uuid-5678.jsonl';
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'parent-uuid-1234', claudeParent, now);

    expect(classifyHookParentage('parent-uuid-1234', identity, claudeChild)).toBe('child');
    expect(identity.childSessionIds.size).toBe(0);
  });

  it('keeps same-session-id events parent when both transcripts embed the session id (turn rotation)', () => {
    // Both the parent and the new transcript embed the parent session id, so the
    // sidechain heuristic must NOT misfire. This guards against classifying a
    // legitimate parent turn-rotation as a subagent.
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/codex-parent-turn1.jsonl', now);

    expect(classifyHookParentage('codex-parent', identity, '/t/codex-parent-turn2.jsonl')).toBe('parent');
  });

  it('returns parent for same-session-id events when transcriptPath is undefined', () => {
    // PreToolUse and other hooks may omit transcript_path; the heuristic must
    // short-circuit to parent rather than treating "no signal" as a sidechain.
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', parentTranscript, now);

    expect(classifyHookParentage('codex-parent', identity, undefined)).toBe('parent');
  });

  it('returns child for any other session id once parent is set', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', now);
    expect(classifyHookParentage('codex-child-1', identity)).toBe('child');
  });
});

describe('recordSessionStart', () => {
  const t0 = new Date('2026-05-13T12:00:00Z').toISOString();
  const t1 = new Date('2026-05-13T12:01:00Z').toISOString();
  const t2 = new Date('2026-05-13T12:02:00Z').toISOString();
  const parentTranscript = '/home/jean/.codex/sessions/rollout-2026-05-20T21-10-13-codex-parent.jsonl';
  const childTranscript = '/home/jean/.codex/sessions/rollout-2026-05-20T21-10-24-codex-child.jsonl';

  it('claims parent on first sighting and freezes it', () => {
    const identity = createSessionRuntimeIdentity();

    expect(recordSessionStart(identity, 'codex-parent', '/t/p', t0)).toBe('parent');
    expect(identity.parentSessionId).toBe('codex-parent');
    expect(identity.parentTranscriptPath).toBe('/t/p');
    expect(identity.parentSeenAt).toBe(t0);

    // Four child reviewer sessions arrive — must not overwrite parent.
    for (const id of ['codex-r1', 'codex-r2', 'codex-r3', 'codex-r4']) {
      expect(recordSessionStart(identity, id, `/t/${id}`, t1)).toBe('child');
    }
    expect(identity.parentSessionId).toBe('codex-parent');
    expect(identity.parentTranscriptPath).toBe('/t/p');
    expect(identity.childSessionIds.size).toBe(4);
  });

  it('idempotently records a repeat child session start', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', t0);

    recordSessionStart(identity, 'codex-child', '/t/c', t1);
    recordSessionStart(identity, 'codex-child', '/t/c2', t2);

    expect(identity.childSessionIds.get('codex-child')?.firstSeenAt).toBe(t1);
    expect(identity.childSessionIds.get('codex-child')?.transcriptPath).toBe('/t/c');
  });

  it('returns parent for a repeated parent SessionStart (resume case)', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', t0);
    expect(recordSessionStart(identity, 'codex-parent', '/t/p', t2)).toBe('parent');
    expect(identity.childSessionIds.size).toBe(0);
  });

  it('records same-session-id subagents by transcript path', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', parentTranscript, t0);

    expect(recordSessionStart(identity, 'codex-parent', childTranscript, t1)).toBe('child');
    expect(recordSessionStart(identity, 'codex-parent', childTranscript, t2)).toBe('child');

    expect(identity.parentSessionId).toBe('codex-parent');
    expect(identity.parentTranscriptPath).toBe(parentTranscript);
    expect(identity.childSessionIds.size).toBe(1);
    expect(identity.childSessionIds.get(`transcript:${childTranscript}`)).toEqual({
      firstSeenAt: t1,
      transcriptPath: childTranscript,
      reason: 'inherited_settings',
    });
  });

  it('does not record a same-session-id SessionStart as child when transcript ownership is ambiguous', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/parent.jsonl', t0);

    expect(recordSessionStart(identity, 'codex-parent', '/t/new-turn.jsonl', t1)).toBe('parent');
    expect(identity.childSessionIds.size).toBe(0);
  });
});
