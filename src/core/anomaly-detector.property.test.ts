import { beforeEach, describe, expect, test } from 'vitest';
import { detectAnomalies } from './anomaly-detector.js';
import type { AgentEvent, AnomalyType } from './types.js';
import {
  eventSequence,
  resetAnomalyDetectorBuilderIds,
} from './__fixtures__/anomaly-detector-builders.js';

const agentId = 'agent-1';
const propertyConfig = { repeatedErrorThreshold: 3, windowSize: 50 };

interface MinimalCase {
  name: string;
  expectedType: AnomalyType;
  events: () => AgentEvent[];
}

const minimalCases: MinimalCase[] = [
  {
    name: 'stop needs_input',
    expectedType: 'needs_input',
    events: () => eventSequence().stop('Waiting for input').build(),
  },
  {
    name: 'ask_user_question needs_input',
    expectedType: 'needs_input',
    events: () => eventSequence().askUserQuestion().build(),
  },
  {
    name: 'permission request',
    expectedType: 'permission_blocked',
    events: () => eventSequence().permissionRequest('Bash').build(),
  },
  {
    name: 'repeated error',
    expectedType: 'repeated_error',
    events: () => eventSequence().error('TypeError: x is not a function', 3).build(),
  },
  {
    name: 'merge conflict',
    expectedType: 'merge_conflict',
    events: () => eventSequence().gitConflict('src/index.ts').build(),
  },
  {
    name: 'api error',
    expectedType: 'api_error',
    events: () => eventSequence().stopFailure('billing_error', 'Credit balance is too low').build(),
  },
];

function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG: deterministic, tiny, and sufficient for reproducible test permutations.
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function safePrefixEvents(seed: number, length: number): AgentEvent[] {
  const random = makeSeededRandom(seed);
  const events: AgentEvent[] = [];
  for (let i = 0; i < length; i += 1) {
    const choice = Math.floor(random() * 5);
    const toolUseId = `prefix_${seed}_${i}`;
    switch (choice) {
      case 0:
        events.push({
          type: 'session_start',
          sessionId: 's1',
          model: `model-${i % 3}`,
        });
        break;
      case 1:
        events.push({
          type: 'tool_use',
          sessionId: 's1',
          toolName: 'Read',
          toolInput: { file_path: `src/file-${i}.ts` },
          toolUseId,
        });
        break;
      case 2:
        events.push({
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Read',
          toolUseId,
          toolResponse: `read ${i}`,
        });
        break;
      case 3:
        events.push({
          type: 'notification',
          sessionId: 's1',
          notificationType: 'auth_success',
          message: `authenticated ${i}`,
        });
        break;
      default:
        events.push({
          type: 'subagent_stop',
          sessionId: 's1',
          agentId: `subagent-${i}`,
          agentType: 'test-agent',
          lastMessage: 'done',
        });
        break;
    }
  }
  return events;
}

function overlayTail(seed: number, length: number): AgentEvent[] {
  const random = makeSeededRandom(seed);
  const events: AgentEvent[] = [];
  for (let i = 0; i < length; i += 1) {
    if (random() < 0.5) {
      events.push({
        type: 'notification',
        sessionId: 's1',
        notificationType: i % 2 === 0 ? 'idle_prompt' : 'auth_success',
        message: `overlay ${i}`,
      });
    } else {
      events.push({
        type: 'subagent_stop',
        sessionId: 's1',
        agentId: `tail-subagent-${seed}-${i}`,
        agentType: 'test-agent',
        lastMessage: 'subagent done',
      });
    }
  }
  return events;
}

describe('anomaly detector fixture builders and invariants', () => {
  beforeEach(() => {
    resetAnomalyDetectorBuilderIds();
  });

  test.each(minimalCases)(
    'builder can produce a minimal triggering sequence for $name',
    ({ expectedType, events }) => {
      const anomaly = detectAnomalies(events(), agentId, propertyConfig);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe(expectedType);
    },
  );

  test('trailing overlay events do not downgrade established anomaly verdicts', () => {
    for (const minimalCase of minimalCases) {
      const base = detectAnomalies(minimalCase.events(), agentId, propertyConfig);
      expect(base).not.toBeNull();

      for (let seed = 1; seed <= 20; seed += 1) {
        const events = [...minimalCase.events(), ...overlayTail(seed, (seed % 7) + 1)];
        const withOverlay = detectAnomalies(events, agentId, propertyConfig);
        expect(withOverlay, `${minimalCase.name} with overlay seed ${seed}`).not.toBeNull();
        expect(withOverlay!.type).toBe(base!.type);
        expect(withOverlay!.severity).toBe(base!.severity);
      }
    }
  });

  test('permuting unrelated prefix noise before terminal states preserves verdicts', () => {
    for (const minimalCase of minimalCases) {
      const base = detectAnomalies(minimalCase.events(), agentId, propertyConfig);
      expect(base).not.toBeNull();

      for (let seed = 1; seed <= 20; seed += 1) {
        const prefix = safePrefixEvents(seed, 12);
        const events = [...shuffled(prefix, makeSeededRandom(seed + 1000)), ...minimalCase.events()];
        const anomaly = detectAnomalies(events, agentId, propertyConfig);
        expect(anomaly, `${minimalCase.name} with prefix seed ${seed}`).not.toBeNull();
        expect(anomaly!.type).toBe(base!.type);
        expect(anomaly!.severity).toBe(base!.severity);
      }
    }
  });

  test('repeated-error threshold sweep flips only when the repeated count reaches the threshold', () => {
    for (let threshold = 1; threshold <= 6; threshold += 1) {
      for (let count = 0; count <= 6; count += 1) {
        const events = eventSequence().error('same failure', count).build();
        const anomaly = detectAnomalies(events, agentId, {
          repeatedErrorThreshold: threshold,
          windowSize: 50,
        });
        if (count >= threshold && threshold > 0) {
          expect(anomaly?.type, `threshold=${threshold} count=${count}`).toBe('repeated_error');
        } else {
          expect(anomaly, `threshold=${threshold} count=${count}`).toBeNull();
        }
      }
    }
  });

  test('window boundary excludes matching errors outside the effective window', () => {
    const events = [
      ...eventSequence().error('same failure', 1).build(),
      ...safePrefixEvents(99, 2),
      ...eventSequence().error('same failure', 2).build(),
    ];

    const anomaly = detectAnomalies(events, agentId, {
      repeatedErrorThreshold: 3,
      windowSize: 3,
    });
    expect(anomaly).toBeNull();
  });

  test('window boundary includes exactly enough matching errors inside the window', () => {
    const events = [
      ...safePrefixEvents(100, 4),
      ...eventSequence().error('same failure', 3).build(),
    ];

    const anomaly = detectAnomalies(events, agentId, {
      repeatedErrorThreshold: 3,
      windowSize: 3,
    });
    expect(anomaly?.type).toBe('repeated_error');
  });
});
