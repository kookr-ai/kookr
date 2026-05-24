import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SupervisorFeedbackCaseStore,
  SUPERVISOR_FEEDBACK_CASE_FILE,
  SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION,
  type SupervisorFeedbackCaseRecordV1,
} from './supervisor-feedback-case-store.js';

describe('SupervisorFeedbackCaseStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-feedback-case-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('round-trips a false-positive record', async () => {
    const store = SupervisorFeedbackCaseStore.forKookrDir(dir);
    const record: SupervisorFeedbackCaseRecordV1 = {
      schemaVersion: SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION,
      kind: 'false_positive',
      agentId: 'kookr-abc',
      timestamp: '2026-05-25T01:00:00.000Z',
      anomalyType: 'needs_input',
      supervisorExplanation: 'Agent is waiting for input. Last message: "### Finding 1"',
      userReason: 'agent emitted a long review report, not a question',
      snapshot: {
        anomalyExplanation: 'Agent is waiting for input.',
        recentEvents: [{ type: 'stop', sessionId: 's1', lastMessage: '### Finding 1' }],
      },
    };

    await store.append(record);

    const { records, diagnostics } = await store.readAll();
    expect(diagnostics).toEqual([]);
    expect(records).toEqual([record]);
  });

  test('round-trips a false-negative record', async () => {
    const store = SupervisorFeedbackCaseStore.forKookrDir(dir);
    const record: SupervisorFeedbackCaseRecordV1 = {
      schemaVersion: SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION,
      kind: 'false_negative',
      agentId: 'kookr-xyz',
      timestamp: '2026-05-25T01:01:00.000Z',
      userReason: 'agent had been stuck for 10 minutes but no finding appeared',
      suspectedType: 'stale_agent',
      snapshot: { recentEvents: [] },
    };

    await store.append(record);

    const { records, diagnostics } = await store.readAll();
    expect(diagnostics).toEqual([]);
    expect(records).toEqual([record]);
  });

  test('readAll returns empty when file is missing', async () => {
    const store = SupervisorFeedbackCaseStore.forKookrDir(dir);
    const result = await store.readAll();
    expect(result).toEqual({ records: [], diagnostics: [] });
  });

  test('append serializes concurrent writes so neither is dropped', async () => {
    const store = SupervisorFeedbackCaseStore.forKookrDir(dir);
    const base = {
      schemaVersion: SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION as const,
      timestamp: '2026-05-25T01:02:00.000Z',
      snapshot: {},
    };

    await Promise.all([
      store.append({ ...base, kind: 'false_positive', agentId: 'a1', anomalyType: 'needs_input', supervisorExplanation: 'x' }),
      store.append({ ...base, kind: 'false_negative', agentId: 'a2', userReason: 'r' }),
    ]);

    const { records } = await store.readAll();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.agentId).sort()).toEqual(['a1', 'a2']);
  });

  test('readAll reports diagnostics for malformed lines without failing valid ones', async () => {
    const path = join(dir, SUPERVISOR_FEEDBACK_CASE_FILE);
    const valid: SupervisorFeedbackCaseRecordV1 = {
      schemaVersion: SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION,
      kind: 'false_negative',
      agentId: 'kookr-ok',
      timestamp: '2026-05-25T01:03:00.000Z',
      userReason: 'real',
      snapshot: {},
    };
    await writeFile(
      path,
      [
        JSON.stringify(valid),
        'this is not json',
        JSON.stringify({ schemaVersion: 'wrong', kind: 'false_negative' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const store = SupervisorFeedbackCaseStore.forKookrDir(dir);
    const { records, diagnostics } = await store.readAll();
    expect(records).toEqual([valid]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].failureKind).toBe('malformed_json');
    expect(diagnostics[1].failureKind).toBe('invalid_record');
  });

  test('false-negative records reject empty userReason at schema-validation read', async () => {
    const path = join(dir, SUPERVISOR_FEEDBACK_CASE_FILE);
    const invalid = {
      schemaVersion: SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION,
      kind: 'false_negative',
      agentId: 'kookr-empty',
      timestamp: '2026-05-25T01:04:00.000Z',
      userReason: '',
      snapshot: {},
    };
    await writeFile(path, `${JSON.stringify(invalid)}\n`, 'utf8');

    const store = SupervisorFeedbackCaseStore.forKookrDir(dir);
    const { records, diagnostics } = await store.readAll();
    expect(records).toEqual([]);
    expect(diagnostics).toHaveLength(1);
  });

  test('append creates the kookrDir when missing', async () => {
    const subdir = join(dir, 'nested', 'kookr');
    const store = SupervisorFeedbackCaseStore.forKookrDir(subdir);
    await store.append({
      schemaVersion: SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION,
      kind: 'false_negative',
      agentId: 'a',
      timestamp: '2026-05-25T01:05:00.000Z',
      userReason: 'r',
      snapshot: {},
    });
    const text = await readFile(join(subdir, SUPERVISOR_FEEDBACK_CASE_FILE), 'utf8');
    expect(text).toContain('"agentId":"a"');
  });
});
