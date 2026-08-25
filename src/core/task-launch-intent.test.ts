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

  it('keeps model and effort as independent opaque pins in fingerprints and adapter fields', () => {
    const intent = buildTaskLaunchIntent('claude-code', {
      model: 'provider-model-a',
      effort: 'provider-effort-b',
    });

    expect(launchIntentPins(intent)).toEqual({ model: 'provider-model-a', effort: 'provider-effort-b' });
    expect(sameLaunchIntent(intent, 'claude-code', {
      model: 'provider-model-a',
      effort: 'provider-effort-b',
    })).toBe(true);
    expect(sameLaunchIntent(intent, 'claude-code', {
      model: 'provider-model-a',
      effort: 'provider-effort-c',
    })).toBe(false);
    expect(launchIntentFingerprint(intent)).not.toBe(launchIntentFingerprint(
      buildTaskLaunchIntent('claude-code', { model: 'provider-model-a', effort: 'provider-effort-c' }),
    ));
    expect(launchIntentFingerprint({
      schemaVersion: 'task-launch-intent.v1',
      agentType: 'claude-code',
      model: null as unknown as string,
    })).not.toBe(launchIntentFingerprint(buildTaskLaunchIntent('claude-code')));
    expect(launchIntentFingerprint(null)).not.toBeUndefined();
    expect(launchIntentFingerprint(null)).not.toBe(launchIntentFingerprint(undefined));
  });
});
