import { describe, expect, test, vi } from 'vitest';
import {
  AMBIGUITY_FLOOR,
  CONFIDENCE_EXTRACTED,
  CONFIDENCE_PROMPT_STRUCTURED,
  LLM_CONFIDENCE_CAP,
  inferRelations,
  parseChildrenJson,
  parseKookrSpawnTaskId,
  parseStateMd,
  type InferenceInput,
  type InferenceTask,
} from './task-relation-inference.js';
import { HIGH_CONFIDENCE_RELATION_THRESHOLD } from '../shared/contracts/task-relations.js';
import type { TaskRelation } from '../shared/contracts/task-relations.js';
import type { LlmClient } from './llm-types.js';

const PARENT_ID = '11111111-1111-1111-1111-111111111111';
const CHILD_A_ID = '22222222-2222-2222-2222-222222222222';
const CHILD_B_ID = '33333333-3333-3333-3333-333333333333';
const PRIOR_PARENT_ID = '44444444-4444-4444-4444-444444444444';

function emptyInput(overrides: Partial<InferenceInput> = {}): InferenceInput {
  return {
    tasks: [],
    existingRelations: [],
    spawnEvents: [],
    playbookChildren: [],
    playbookStates: [],
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<InferenceTask> = {}): InferenceTask {
  return {
    id,
    createdAt: '2026-05-26T19:00:00Z',
    ...overrides,
  };
}

describe('parseKookrSpawnTaskId', () => {
  test('extracts the uuid from a real kookr-spawn response line', () => {
    // Fixture: observed in ~/.kookr/hooks/*.jsonl (issue #600 fixture).
    const sample = 'task_id=737e3dc2-0a2d-4dcc-bd3a-3df373ae22ff\n✓ Task created\n   agent:  codex-cli\n';
    expect(parseKookrSpawnTaskId(sample)).toBe('737e3dc2-0a2d-4dcc-bd3a-3df373ae22ff');
  });

  test('returns null when no task_id token is present', () => {
    expect(parseKookrSpawnTaskId('kookr-spawn — create a Kookr task ...')).toBeNull();
  });
});

describe('parseChildrenJson', () => {
  test('parses real children.json shape from parallel-issue-batch', () => {
    // Fixture: observed shape from
    //   ~/.kookr/playbook-state/parallel-issue-batch/<owner-repo>/<run-key>/children.json
    const raw = JSON.stringify([
      {
        issue: 600,
        task_id: '4b3a8c2b-cab6-4db2-aaf9-0d851cb5f0f4',
        status: 'spawned',
      },
      {
        issue: 612,
        task_id: '647ee7c2-ef3e-4c15-ba37-1fed79ea390e',
        status: 'spawned',
      },
    ]);
    const entries = parseChildrenJson(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ issue: 600, task_id: '4b3a8c2b-cab6-4db2-aaf9-0d851cb5f0f4' });
  });

  test('tolerates a malformed body without throwing', () => {
    expect(parseChildrenJson('not json')).toEqual([]);
    expect(parseChildrenJson('{}')).toEqual([]);
  });
});

describe('parseStateMd', () => {
  test('extracts parent, prior parent, run key, and referenced task ids', () => {
    // Fixture: observed shape from state.md.
    const sample = `# Parallel Issue Batch: kookr-ai/kookr\n\n`
      + `Run key: \`b5fde2b0-8023-4706-9827-ae74e9df557f\`\n`
      + `Parent task: \`b5fde2b0-8023-4706-9827-ae74e9df557f\`\n`
      + `Prior parent task: \`41cb9bff-80b9-4f74-b597-baaa2433db9d\`\n\n`
      + `## Children\n\n`
      + `- 4b3a8c2b-cab6-4db2-aaf9-0d851cb5f0f4 — issue #600\n`;
    const parsed = parseStateMd(sample);
    expect(parsed.runKey).toBe('b5fde2b0-8023-4706-9827-ae74e9df557f');
    expect(parsed.parentTaskId).toBe('b5fde2b0-8023-4706-9827-ae74e9df557f');
    expect(parsed.priorParentTaskId).toBe('41cb9bff-80b9-4f74-b597-baaa2433db9d');
    expect(parsed.referencedTaskIds).toContain('4b3a8c2b-cab6-4db2-aaf9-0d851cb5f0f4');
  });
});

describe('inferRelations — deterministic high-confidence rules', () => {
  test('R1: kookr-spawn task_id= with known parent → spawned_by at deterministic confidence', async () => {
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), makeTask(CHILD_A_ID)],
      spawnEvents: [
        {
          taskId: CHILD_A_ID,
          parentTaskId: PARENT_ID,
          observedAt: '2026-05-26T19:05:00Z',
          rawSnippet: `task_id=${CHILD_A_ID}`,
          filePath: '/path/to/kookr/hooks/kookr-abc.jsonl',
        },
      ],
    });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(1);
    const rel = result.inferred[0];
    expect(rel.sourceTaskId).toBe(CHILD_A_ID);
    expect(rel.targetTaskId).toBe(PARENT_ID);
    expect(rel.type).toBe('spawned_by');
    expect(rel.source).toBe('kookr-spawn');
    expect(rel.confidence).toBe(CONFIDENCE_EXTRACTED);
    expect(rel.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_RELATION_THRESHOLD);
    expect(rel.evidence?.[0]).toMatchObject({
      path: '/path/to/kookr/hooks/kookr-abc.jsonl',
      observedAt: '2026-05-26T19:05:00Z',
    });
    expect(result.metrics.inferred).toBe(1);
  });

  test('R2: children.json entries → spawned_by per child + same_chain across siblings', async () => {
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), makeTask(CHILD_A_ID), makeTask(CHILD_B_ID)],
      playbookChildren: [
        {
          runKey: 'b5fde2b0-8023-4706-9827-ae74e9df557f',
          parentTaskId: PARENT_ID,
          filePath: '/path/to/kookr/playbook-state/parallel-issue-batch/x/y/children.json',
          observedAt: '2026-05-26T19:01:00Z',
          entries: [
            { issue: 600, task_id: CHILD_A_ID },
            { issue: 612, task_id: CHILD_B_ID },
          ],
        },
      ],
    });
    const result = await inferRelations(input);
    const spawnedBy = result.inferred.filter((r) => r.type === 'spawned_by');
    const sameChain = result.inferred.filter((r) => r.type === 'same_chain');
    expect(spawnedBy).toHaveLength(2);
    for (const rel of spawnedBy) {
      expect(rel.targetTaskId).toBe(PARENT_ID);
      expect(rel.source).toBe('playbook-state');
      expect(rel.confidence).toBe(CONFIDENCE_EXTRACTED);
    }
    expect(sameChain).toHaveLength(1);
    expect(sameChain[0].confidence).toBe(CONFIDENCE_PROMPT_STRUCTURED);
  });

  test('R3: state.md with Prior parent task → successor_of edge between parents', async () => {
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), makeTask(PRIOR_PARENT_ID)],
      playbookStates: [
        {
          parentTaskId: PARENT_ID,
          priorParentTaskId: PRIOR_PARENT_ID,
          runKey: 'b5fde2b0',
          referencedTaskIds: [PARENT_ID, PRIOR_PARENT_ID],
          filePath: '/path/to/kookr/playbook-state/parallel-issue-batch/x/y/state.md',
          observedAt: '2026-05-26T19:01:00Z',
        },
      ],
    });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(1);
    const rel = result.inferred[0];
    expect(rel.type).toBe('successor_of');
    expect(rel.sourceTaskId).toBe(PARENT_ID);
    expect(rel.targetTaskId).toBe(PRIOR_PARENT_ID);
    expect(rel.confidence).toBe(CONFIDENCE_EXTRACTED);
  });

  test('R3 does not emit same_chain edges from raw state.md task-id co-occurrence', async () => {
    // Regression guard: state.md files in long-running playbooks accumulate
    // task ids from many prior waves; emitting O(N²) same_chain edges from
    // that pool drowns the high-signal children.json siblings under noise.
    const input = emptyInput({
      tasks: [
        makeTask(CHILD_A_ID),
        makeTask(CHILD_B_ID),
        makeTask(PRIOR_PARENT_ID),
      ],
      playbookStates: [
        {
          referencedTaskIds: [CHILD_A_ID, CHILD_B_ID, PRIOR_PARENT_ID],
          filePath: '/tmp/state.md',
          observedAt: '2026-05-26T19:01:00Z',
        },
      ],
    });
    const result = await inferRelations(input);
    const sameChain = result.inferred.filter((r) => r.type === 'same_chain');
    expect(sameChain).toHaveLength(0);
  });

  test('tasks with parentTaskId on API create are counted as alreadyLinked, not re-emitted', async () => {
    // #599 already wrote the spawned_by edge; we should NOT inflate `inferred`.
    const existing: TaskRelation = {
      id: 'rel-existing',
      sourceTaskId: CHILD_A_ID,
      targetTaskId: PARENT_ID,
      type: 'spawned_by',
      confidence: 1,
      source: 'api',
      evidence: [],
      createdAt: '2026-05-26T18:00:00Z',
      updatedAt: '2026-05-26T18:00:00Z',
      lifecycle: 'active',
    };
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), makeTask(CHILD_A_ID, { parentTaskId: PARENT_ID })],
      existingRelations: [existing],
    });
    const result = await inferRelations(input);
    expect(result.metrics.alreadyLinked).toBe(1);
    expect(result.metrics.inferred).toBe(0);
  });
});

describe('inferRelations — medium-confidence prompt rules', () => {
  test('successor prompt naming previous task-id → successor_of edge', async () => {
    const child = makeTask(CHILD_A_ID, {
      prompt: 'You are continuing a Kookr self-continuation chain.\n'
        + `Previous task id: ${PRIOR_PARENT_ID}\n`
        + 'Implement the next issue.',
    });
    const input = emptyInput({
      tasks: [makeTask(PRIOR_PARENT_ID), child],
    });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(1);
    const rel = result.inferred[0];
    expect(rel.type).toBe('successor_of');
    expect(rel.sourceTaskId).toBe(CHILD_A_ID);
    expect(rel.targetTaskId).toBe(PRIOR_PARENT_ID);
    expect(rel.confidence).toBe(CONFIDENCE_PROMPT_STRUCTURED);
    expect(rel.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_RELATION_THRESHOLD);
  });

  test('"Kookr child task spawned by" prompt with run-key uuid → spawned_by edge', async () => {
    const child = makeTask(CHILD_A_ID, {
      prompt: 'You are a Kookr child task spawned by a parent parallel-issue-batch orchestrator.\n'
        + `Run key: ${PARENT_ID}\nImplement issue #600.`,
    });
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), child],
    });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(1);
    const rel = result.inferred[0];
    expect(rel.type).toBe('spawned_by');
    expect(rel.sourceTaskId).toBe(CHILD_A_ID);
    expect(rel.targetTaskId).toBe(PARENT_ID);
    expect(rel.confidence).toBe(CONFIDENCE_PROMPT_STRUCTURED);
  });

  test('"parent state dir <uuid>" in prompt → spawned_by (not successor_of)', async () => {
    // Regression guard: PARENT_STATE_PATH_RE used to route into the prior-parent
    // bucket and emit `successor_of` edges, which mis-typed the relation for
    // children that reference the parallel-issue-batch parent state directory.
    const child = makeTask(CHILD_A_ID, {
      prompt: 'You are a Kookr child task spawned by orchestrator.\n'
        + `parent state dir /path/to/kookr/playbook-state/parallel-issue-batch/x/${PARENT_ID}/.\n`,
    });
    const result = await inferRelations(emptyInput({
      tasks: [makeTask(PARENT_ID), child],
    }));
    expect(result.inferred).toHaveLength(1);
    expect(result.inferred[0].type).toBe('spawned_by');
    expect(result.inferred[0].targetTaskId).toBe(PARENT_ID);
  });
});

describe('inferRelations — LLM fallback for ambiguous prompt-only text', () => {
  test('ambiguous "spawned by" prompt with no uuid → mocked LLM verdict, capped at LLM_CONFIDENCE_CAP', async () => {
    const child = makeTask(CHILD_A_ID, {
      createdAt: '2026-05-26T19:05:00Z',
      prompt: 'You are a Kookr child task spawned by a parent orchestrator. Implement the next thing.',
    });
    const parent = makeTask(PARENT_ID, { createdAt: '2026-05-26T19:00:00Z' });
    const llmClient: LlmClient = {
      provider: 'mock',
      model: 'mock-1',
      complete: vi.fn(async () => JSON.stringify({
        type: 'spawned_by',
        confidence: 0.95, // model is overconfident; we must cap this.
        rationale: 'child prompt explicitly says "spawned by" and parent was just created.',
      })),
    };
    const input = emptyInput({ tasks: [parent, child] });
    const result = await inferRelations(input, { llmClient });
    expect(llmClient.complete).toHaveBeenCalledTimes(1);
    expect(result.inferred).toHaveLength(1);
    const rel = result.inferred[0];
    expect(rel.source).toBe('llm-inference');
    expect(rel.type).toBe('spawned_by');
    expect(rel.confidence).toBe(LLM_CONFIDENCE_CAP);
    expect(rel.confidence).toBeLessThan(HIGH_CONFIDENCE_RELATION_THRESHOLD);
  });

  test('LLM verdict "unrelated" produces no edge and one ambiguous entry', async () => {
    const child = makeTask(CHILD_A_ID, {
      createdAt: '2026-05-26T19:05:00Z',
      prompt: 'You are a Kookr child task spawned by something. Do work.',
    });
    const parent = makeTask(PARENT_ID, { createdAt: '2026-05-26T19:00:00Z' });
    const llmClient: LlmClient = {
      provider: 'mock',
      model: 'mock-1',
      complete: vi.fn(async () => JSON.stringify({
        type: 'unrelated',
        confidence: 0.9,
        rationale: 'unrelated topic',
      })),
    };
    const input = emptyInput({ tasks: [parent, child] });
    const result = await inferRelations(input, { llmClient });
    expect(result.inferred).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.metrics.ambiguous).toBe(1);
  });

  test('no LLM client → ambiguous "spawned by" prompt with no uuid surfaces as ambiguous', async () => {
    const child = makeTask(CHILD_A_ID, {
      createdAt: '2026-05-26T19:05:00Z',
      prompt: 'You are a Kookr child task spawned by an orchestrator. Do work.',
    });
    const parent = makeTask(PARENT_ID, { createdAt: '2026-05-26T19:00:00Z' });
    const input = emptyInput({ tasks: [parent, child] });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({ sourceTaskId: CHILD_A_ID, targetTaskId: PARENT_ID });
  });
});

describe('inferRelations — idempotency and dedup', () => {
  test('idempotent re-run: existing relations match → metrics.inferred stays 0', async () => {
    const tasks = [makeTask(PARENT_ID), makeTask(CHILD_A_ID)];
    const inputA: InferenceInput = emptyInput({
      tasks,
      spawnEvents: [{
        taskId: CHILD_A_ID,
        parentTaskId: PARENT_ID,
        observedAt: '2026-05-26T19:05:00Z',
      }],
    });
    const first = await inferRelations(inputA);
    expect(first.metrics.inferred).toBe(1);

    // Simulate that the first pass was applied: store now has the relation.
    const existing: TaskRelation = {
      id: 'rel-existing',
      sourceTaskId: CHILD_A_ID,
      targetTaskId: PARENT_ID,
      type: 'spawned_by',
      confidence: CONFIDENCE_EXTRACTED,
      source: 'kookr-spawn',
      evidence: [],
      createdAt: '2026-05-26T19:05:00Z',
      updatedAt: '2026-05-26T19:05:00Z',
      lifecycle: 'active',
    };
    const second = await inferRelations({ ...inputA, existingRelations: [existing] });
    expect(second.metrics.inferred).toBe(0);
    // The candidate is still returned (so callers can refresh evidence),
    // but does not count as new.
    expect(second.inferred).toHaveLength(1);
  });

  test('dedup: two evidence sources for the same (source,target,type) collapse to one record', async () => {
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), makeTask(CHILD_A_ID)],
      spawnEvents: [{
        taskId: CHILD_A_ID,
        parentTaskId: PARENT_ID,
        observedAt: '2026-05-26T19:05:00Z',
        rawSnippet: 'task_id=22222222-2222-2222-2222-222222222222',
      }],
      playbookChildren: [{
        runKey: 'rk',
        parentTaskId: PARENT_ID,
        filePath: '/tmp/children.json',
        observedAt: '2026-05-26T19:06:00Z',
        entries: [{ issue: 600, task_id: CHILD_A_ID }],
      }],
    });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(1);
    expect(result.inferred[0].evidence?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('candidates below AMBIGUITY_FLOOR surface only in the ambiguous list', async () => {
    // Build a synthetic input that drives a sub-floor confidence via LLM
    // by setting the cap to 0 — anything the model says is then dropped.
    const child = makeTask(CHILD_A_ID, {
      createdAt: '2026-05-26T19:05:00Z',
      prompt: 'Kookr child task spawned by orchestrator. Do work.',
    });
    const parent = makeTask(PARENT_ID, { createdAt: '2026-05-26T19:00:00Z' });
    const llmClient: LlmClient = {
      provider: 'mock',
      model: 'mock-1',
      complete: vi.fn(async () => JSON.stringify({
        type: 'spawned_by',
        confidence: 0.1, // below AMBIGUITY_FLOOR after the cap.
        rationale: 'weak signal',
      })),
    };
    const result = await inferRelations(
      emptyInput({ tasks: [parent, child] }),
      { llmClient, ambiguityFloor: AMBIGUITY_FLOOR },
    );
    expect(result.inferred).toHaveLength(0);
    expect(result.ambiguous.length).toBeGreaterThanOrEqual(1);
  });

  test('never emits a self-edge even if spawn event lists the same uuid as parent', async () => {
    const input = emptyInput({
      tasks: [makeTask(CHILD_A_ID)],
      spawnEvents: [{
        taskId: CHILD_A_ID,
        parentTaskId: CHILD_A_ID,
        observedAt: '2026-05-26T19:05:00Z',
      }],
    });
    const result = await inferRelations(input);
    expect(result.inferred).toHaveLength(0);
    expect(result.metrics.inferred).toBe(0);
  });

  test('empty input → empty result with zeroed metrics', async () => {
    const result = await inferRelations(emptyInput());
    expect(result.inferred).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.metrics).toEqual({
      totalTasks: 0,
      alreadyLinked: 0,
      inferred: 0,
      ambiguous: 0,
    });
  });

  test('engine returns TaskRelationInput shape only (never carries a parentTaskId field)', async () => {
    // Acceptance criterion: the inference job never mutates parentTaskId.
    // The engine output type cannot carry one — but we lock the invariant
    // here so a future widening of TaskRelationInput is caught early.
    const child = makeTask(CHILD_A_ID, { parentTaskId: PARENT_ID });
    const input = emptyInput({
      tasks: [makeTask(PARENT_ID), child],
      spawnEvents: [{ taskId: CHILD_A_ID, parentTaskId: PARENT_ID, observedAt: '2026-05-26T19:05:00Z' }],
    });
    const result = await inferRelations(input);
    for (const rel of result.inferred) {
      expect(Object.prototype.hasOwnProperty.call(rel, 'parentTaskId')).toBe(false);
    }
    // Input task is also unchanged.
    expect(child.parentTaskId).toBe(PARENT_ID);
  });

  test('LLM client that throws → ambiguous, not crash', async () => {
    const child = makeTask(CHILD_A_ID, {
      createdAt: '2026-05-26T19:05:00Z',
      prompt: 'You are a Kookr child task spawned by an orchestrator. Do work.',
    });
    const parent = makeTask(PARENT_ID, { createdAt: '2026-05-26T19:00:00Z' });
    const llmClient: LlmClient = {
      provider: 'mock',
      model: 'mock-1',
      complete: vi.fn(async () => { throw new Error('network'); }),
    };
    const result = await inferRelations(emptyInput({ tasks: [parent, child] }), { llmClient });
    expect(result.inferred).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
  });

  test('LLM client returns malformed JSON → ambiguous, not crash', async () => {
    const child = makeTask(CHILD_A_ID, {
      createdAt: '2026-05-26T19:05:00Z',
      prompt: 'You are a Kookr child task spawned by orchestrator.',
    });
    const parent = makeTask(PARENT_ID, { createdAt: '2026-05-26T19:00:00Z' });
    const llmClient: LlmClient = {
      provider: 'mock',
      model: 'mock-1',
      complete: vi.fn(async () => '{this is not json'),
    };
    const result = await inferRelations(emptyInput({ tasks: [parent, child] }), { llmClient });
    expect(result.inferred).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
  });
});
