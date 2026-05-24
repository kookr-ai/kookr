import { beforeEach, describe, expect, test } from 'vitest';
import {
  getBugReportAlerts,
  getBugReportWireObservations,
  recordInbound,
  recordOutbound,
  recordReportableAlert,
  resetBugReportRecorderForTests,
} from './bug-report-recorder.js';

describe('bug report recorder', () => {
  beforeEach(() => {
    resetBugReportRecorderForTests();
  });

  test('records malformed inbound messages before dispatch can drop them', () => {
    recordInbound('{not-json', null);

    expect(getBugReportWireObservations()[0]).toMatchObject({
      direction: 'inbound',
      type: null,
      parseOk: false,
      validationError: 'json_parse_failed',
    });
  });

  test('stores outbound summaries without prompt payloads', () => {
    recordOutbound({ type: 'respond', agentId: 'agent-1', input: 'secret customer prompt' });

    const observations = getBugReportWireObservations();
    expect(observations[0]).toMatchObject({
      direction: 'outbound',
      type: 'respond',
      fieldNames: ['agentId', 'input', 'type'],
    });
    expect(JSON.stringify(observations)).not.toContain('secret customer prompt');
  });

  test('evicts old wire observations by count', () => {
    for (let i = 0; i < 12; i += 1) {
      recordInbound(JSON.stringify({ type: 'snapshot', i }), { type: 'snapshot', i });
    }

    const observations = getBugReportWireObservations();
    expect(observations).toHaveLength(10);
    expect(observations[0].sequence).toBe(3);
  });

  test('keeps a bounded reportable alert history', () => {
    for (let i = 0; i < 22; i += 1) {
      recordReportableAlert({ agentId: 'agent-1', severity: 'error', summary: `alert ${i}` });
    }

    const alerts = getBugReportAlerts();
    expect(alerts).toHaveLength(20);
    expect(alerts[0].summary).toBe('alert 2');
    expect(alerts[0].summaryCategory).toBe('general');
  });
});
