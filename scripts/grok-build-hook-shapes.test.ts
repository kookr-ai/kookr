/**
 * Characterization test for the observed Grok Build hook payload shapes
 * (issue #1339, POC-A). This is EVIDENCE, not a production normalizer: it pins
 * the empirically captured payload field names so a future Phase-1 change that
 * assumes Claude Code's snake_case schema fails loudly here.
 *
 * Key finding: Grok hook payloads use camelCase keys (sessionId, hookEventName,
 * toolName, toolInput, subagentId, workspaceRoot, promptId) — NOT Claude Code's
 * snake_case (session_id, hook_event_name, tool_name, tool_input). Kookr's
 * existing parseHookEvent() therefore cannot decode Grok events unchanged.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const SAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../docs/poc/009-grok-build-basic-supervision/fixtures/hook-payloads.redacted.json',
);

const doc = JSON.parse(readFileSync(SAMPLES, 'utf8')) as {
  events: Record<string, Record<string, unknown>>;
};

describe('Grok Build hook payload shapes (POC-A evidence)', () => {
  it('captured the POC-A lifecycle events', () => {
    const events = Object.keys(doc.events);
    for (const required of [
      'session_start',
      'user_prompt_submit',
      'pre_tool_use',
      'post_tool_use',
      'subagent_start',
    ]) {
      expect(events).toContain(required);
    }
    // A failure path (HTTP 401) event was captured too.
    expect(events.some((e) => e === 'stop_failure')).toBe(true);
  });

  it('uses camelCase correlation keys (not Claude snake_case)', () => {
    for (const [event, payload] of Object.entries(doc.events)) {
      expect(payload, `${event} carries sessionId`).toHaveProperty('sessionId');
      // Claude Code's snake_case keys must be ABSENT — this is the divergence.
      expect(payload, `${event} must not use snake_case session_id`).not.toHaveProperty(
        'session_id',
      );
    }
  });

  it('pre_tool_use carries camelCase toolName/toolInput (Claude uses tool_name/tool_input)', () => {
    const pre = doc.events['pre_tool_use'];
    expect(pre).toHaveProperty('toolName');
    expect(pre).toHaveProperty('toolInput');
    expect(pre).not.toHaveProperty('tool_name');
    expect(pre).not.toHaveProperty('tool_input');
  });

  it('subagent_start proves child correlation (distinct subagentId vs parent sessionId)', () => {
    const sub = doc.events['subagent_start'] as { sessionId?: string; subagentId?: string };
    expect(sub.subagentId).toBeTruthy();
    expect(sub.subagentId).not.toEqual(sub.sessionId);
  });

  it('stop carries a semantic reason distinguishing success from failure', () => {
    // end_turn => completed; error => terminated (see the outcome truth table).
    const reasons = Object.keys(doc.events).filter((e) => e.startsWith('stop['));
    expect(reasons).toContain('stop[end_turn]');
    expect(reasons).toContain('stop[error]');
  });
});
