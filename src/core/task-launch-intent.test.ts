import { describe, expect, it } from 'vitest';
import {
  buildTaskLaunchIntent,
  launchIntentFingerprint,
  launchIntentPins,
  sameLaunchIntent,
  validatePersistedLaunchIntent,
} from './task-launch-intent.js';

describe('task launch intent', () => {
  it('represents an explicit unpinned launch separately from a missing legacy intent', () => {
    const intent = buildTaskLaunchIntent('claude-code');

    expect(validatePersistedLaunchIntent({ agentType: 'claude-code', launchIntent: intent })).toEqual({
      ok: true,
      intent,
    });
    expect(validatePersistedLaunchIntent({ agentType: 'claude-code' })).toMatchObject({
      ok: false,
      reason: 'missing_launch_intent',
    });
  });

  it.each([
    { launchIntent: null, detail: 'not an object' },
    { launchIntent: { schemaVersion: 'task-launch-intent.v0', agentType: 'claude-code' }, detail: 'schema' },
    { launchIntent: { schemaVersion: 'task-launch-intent.v1', agentType: 'codex-cli' }, detail: 'does not match' },
    { launchIntent: { schemaVersion: 'task-launch-intent.v1', agentType: 'claude-code', effort: '' }, detail: 'non-empty' },
    { launchIntent: { schemaVersion: 'task-launch-intent.v1', agentType: 'claude-code', model: null }, detail: 'null' },
  ])('rejects malformed persisted intent ($detail)', ({ launchIntent }) => {
    expect(validatePersistedLaunchIntent({ agentType: 'claude-code', launchIntent })).toMatchObject({
      ok: false,
      reason: 'malformed_launch_intent',
    });
  });

  it('keeps model and effort as independent pins in fingerprints and adapter fields', () => {
    const intent = buildTaskLaunchIntent('claude-code', {
      model: 'claude-fable-5',
      effort: 'high',
    });

    expect(launchIntentPins(intent)).toEqual({ model: 'claude-fable-5', effort: 'high' });
    expect(sameLaunchIntent(intent, 'claude-code', {
      model: 'claude-fable-5',
      effort: 'high',
    })).toBe(true);
    expect(sameLaunchIntent(intent, 'claude-code', {
      model: 'claude-fable-5',
      effort: 'max',
    })).toBe(false);
    expect(launchIntentFingerprint(intent)).not.toBe(launchIntentFingerprint(
      buildTaskLaunchIntent('claude-code', { model: 'claude-fable-5', effort: 'max' }),
    ));
    expect(launchIntentFingerprint({
      schemaVersion: 'task-launch-intent.v1',
      agentType: 'claude-code',
      model: null as unknown as string,
    })).not.toBe(launchIntentFingerprint(buildTaskLaunchIntent('claude-code')));
    expect(launchIntentFingerprint(null)).not.toBeUndefined();
    expect(launchIntentFingerprint(null)).not.toBe(launchIntentFingerprint(undefined));
  });

  it('distinguishes portable tier policy from identical concrete raw pins', () => {
    const tierIntent = buildTaskLaunchIntent('claude-code', {
      modelTier: 'small',
      model: 'claude-haiku-4-5',
    });
    const rawIntent = buildTaskLaunchIntent('claude-code', {
      model: 'claude-haiku-4-5',
    });

    expect(launchIntentFingerprint(tierIntent)).not.toBe(launchIntentFingerprint(rawIntent));
    expect(sameLaunchIntent(tierIntent, 'claude-code', { model: 'claude-haiku-4-5' })).toBe(false);
  });

  it('validates and sanitizes the full replay contract', () => {
    const result = validatePersistedLaunchIntent({
      agentType: 'claude-code',
      launchIntent: {
        schemaVersion: 'task-launch-intent.v1',
        agentType: 'claude-code',
        prompt: 'original prompt',
        cwd: '/repo',
        projectId: 'github.com/acme/repo',
        ralphVerdictEnv: true,
        dependencies: ['kb', 'kb'],
        idempotencyKey: 'launch-1',
      },
    });

    expect(result).toEqual({
      ok: true,
      intent: expect.objectContaining({
        prompt: 'original prompt',
        cwd: '/repo',
        projectId: 'github.com/acme/repo',
        ralphVerdictEnv: true,
        dependencies: ['kb'],
        idempotencyKey: 'launch-1',
      }),
    });
  });

  it('accepts only exact resolved pins when a portable model tier is persisted', () => {
    const intent = buildTaskLaunchIntent('codex-cli', {
      modelTier: 'small',
      model: 'gpt-5.6-luna',
      effort: 'high',
    });
    expect(validatePersistedLaunchIntent({ agentType: 'codex-cli', launchIntent: intent }))
      .toEqual({ ok: true, intent });
    expect(validatePersistedLaunchIntent({
      agentType: 'codex-cli',
      launchIntent: { ...intent, model: 'gpt-5.6-sol' },
    })).toMatchObject({ ok: false, reason: 'malformed_launch_intent' });
  });

  it('rejects unsupported raw persisted pins before an adapter can receive them', () => {
    expect(validatePersistedLaunchIntent({
      agentType: 'codex-cli',
      launchIntent: buildTaskLaunchIntent('codex-cli', { model: 'arbitrary-model' }),
    })).toMatchObject({ ok: false, reason: 'malformed_launch_intent' });
    expect(validatePersistedLaunchIntent({
      agentType: 'grok-build',
      launchIntent: buildTaskLaunchIntent('grok-build', { model: 'arbitrary-model' }),
    })).toMatchObject({ ok: false, reason: 'malformed_launch_intent' });
  });

  it('keeps dependency and Ralph wiring in the dedup identity', () => {
    const dependent = buildTaskLaunchIntent('claude-code', {
      dependencies: ['kb'],
      ralphVerdictEnv: true,
    });

    expect(sameLaunchIntent(dependent, 'claude-code', { dependencies: ['kb'], ralphVerdictEnv: true })).toBe(true);
    expect(sameLaunchIntent(dependent, 'claude-code', { dependencies: [] })).toBe(false);
    expect(sameLaunchIntent(dependent, 'claude-code', { dependencies: ['kb'] })).toBe(false);
  });
});
