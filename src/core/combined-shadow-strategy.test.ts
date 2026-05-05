import { describe, test, expect } from 'vitest';
import { CombinedShadowStrategy } from './combined-shadow-strategy.js';
import { PaneSemanticsStrategy } from './pane-patterns.js';
import { ProcessLivenessStrategy } from './process-liveness.js';
import type { ShadowInputs } from './shadow-detector.js';

const AGENT = 'test-agent';

function inputs(paneText: string, realAnomaly = null as ShadowInputs['realAnomaly']): ShadowInputs {
  return { paneText, realAnomaly };
}

describe('CombinedShadowStrategy', () => {
  test('source is "combined"', () => {
    const strategy = new CombinedShadowStrategy();
    expect(strategy.source).toBe('combined');
  });

  test('returns null when neither sub-strategy detects anomaly', () => {
    const strategy = new CombinedShadowStrategy();
    // Pane text with no recognizable pattern, process liveness has no cached data
    const result = strategy.evaluate(AGENT, inputs('some random output'));
    expect(result).toBeNull();
  });

  test('returns pane verdict when only pane detects (needs_input)', () => {
    const strategy = new CombinedShadowStrategy();
    // ❯ prompt on its own line = input_prompt
    const result = strategy.evaluate(AGENT, inputs('Some output\n❯\n'));
    expect(result).not.toBeNull();
    expect(result!.type).toBe('needs_input');
    expect(result!.agentId).toBe(AGENT);
  });

  test('returns pane verdict when only pane detects (permission_blocked)', () => {
    const strategy = new CombinedShadowStrategy();
    const result = strategy.evaluate(AGENT, inputs('Tool: Bash\n  Allow  Deny  allow-always\n'));
    expect(result).not.toBeNull();
    expect(result!.type).toBe('permission_blocked');
  });

  test('prefers pane verdict when both detect (pane is more specific)', () => {
    // When pane sees ❯ (needs_input) and process sees stale_agent,
    // the combined strategy should return needs_input (more specific)
    const pane = new PaneSemanticsStrategy();
    const process = new ProcessLivenessStrategy();

    // Seed process liveness cache with a non-claude process
    // @ts-expect-error -- accessing private cache for testing
    process.cachedResults.set(AGENT, {
      panePid: 12345,
      cmdline: '/bin/bash',
      isClaude: false,
      isAlive: true,
    });

    const strategy = new CombinedShadowStrategy(pane, process);
    const result = strategy.evaluate(AGENT, inputs('Some output\n❯\n'));

    expect(result).not.toBeNull();
    expect(result!.type).toBe('needs_input'); // pane wins over stale_agent
  });

  test('returns process verdict when only process detects', () => {
    const pane = new PaneSemanticsStrategy();
    const process = new ProcessLivenessStrategy();

    // Seed process liveness cache with dead process
    // @ts-expect-error -- accessing private cache for testing
    process.cachedResults.set(AGENT, {
      panePid: 12345,
      cmdline: null,
      isClaude: false,
      isAlive: false,
    });

    const strategy = new CombinedShadowStrategy(pane, process);
    // Pane text that doesn't match any pattern
    const result = strategy.evaluate(AGENT, inputs('random unrecognized output'));

    expect(result).not.toBeNull();
    expect(result!.type).toBe('stale_agent');
  });

  test('accepts injected sub-strategy instances', () => {
    const pane = new PaneSemanticsStrategy();
    const process = new ProcessLivenessStrategy();
    const strategy = new CombinedShadowStrategy(pane, process);

    // Should work without errors
    const result = strategy.evaluate(AGENT, inputs(''));
    expect(result).toBeNull();
  });
});
