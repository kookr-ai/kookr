import { describe, expect, test } from 'vitest';
import {
  classifyIssueState,
  collectIdeasFiled,
  formatIdeasTable,
  parseGhIssueResponse,
  parseIssueRef,
  parseReflectionLog,
  resolveIdeas,
  summarizeIdeas,
  type FiledIdea,
  type IssueProbe,
  type RawIssueState,
} from './reflection-ideas.js';

const OPEN: RawIssueState = { state: 'OPEN', stateReason: null, closingPrs: [] };
const SHIPPED = (pr: number): RawIssueState => ({
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  closingPrs: [{ number: pr, url: `https://github.com/o/r/pull/${pr}`, merged: true }],
});
const CLOSED_UNSHIPPED: RawIssueState = {
  state: 'CLOSED',
  stateReason: 'NOT_PLANNED',
  closingPrs: [],
};

describe('parseIssueRef', () => {
  test('parses a canonical issue URL', () => {
    expect(parseIssueRef('https://github.com/kookr-ai/kookr/issues/1751')).toEqual({
      url: 'https://github.com/kookr-ai/kookr/issues/1751',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 1751,
    });
  });

  test('parses cross-repo issue URLs', () => {
    expect(parseIssueRef('https://github.com/jeanibarz/lucy/issues/1842')?.owner).toBe('jeanibarz');
  });

  test('tolerates trailing fragments and whitespace', () => {
    expect(parseIssueRef('  https://github.com/o/r/issues/12#comment  ')?.number).toBe(12);
  });

  test('rejects pull-request and non-issue URLs', () => {
    expect(parseIssueRef('https://github.com/o/r/pull/12')).toBeNull();
    expect(parseIssueRef('not a url')).toBeNull();
    expect(parseIssueRef('https://github.com/o/r/issues/0')).toBeNull();
  });
});

describe('parseReflectionLog', () => {
  test('parses JSONL entries and skips blank / malformed lines', () => {
    const text = [
      '{"date":"2026-07-30","directionVerdict":"forward","ideasFiled":["https://github.com/o/r/issues/1"],"topFriction":"x"}',
      '',
      'not json',
      '{"date":"2026-07-31","ideasFiled":["https://github.com/o/r/issues/2","https://github.com/o/r/issues/3"]}',
      '{"ideasFiled":"not-an-array"}',
    ].join('\n');
    const entries = parseReflectionLog(text);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ date: '2026-07-30', directionVerdict: 'forward' });
    expect(entries[1]!.ideasFiled).toHaveLength(2);
    expect(entries[2]!.ideasFiled).toEqual([]);
  });
});

describe('collectIdeasFiled', () => {
  const entries = parseReflectionLog(
    [
      '{"date":"2026-07-29","ideasFiled":["https://github.com/o/r/issues/1"]}',
      '{"date":"2026-07-30","ideasFiled":["https://github.com/o/r/issues/2"]}',
      '{"date":"2026-07-31","ideasFiled":["https://github.com/o/r/issues/2","https://github.com/o/r/issues/3"]}',
    ].join('\n'),
  );

  test('defaults to the most recent run only', () => {
    const filed = collectIdeasFiled(entries);
    expect(filed.map((f) => f.ref?.number)).toEqual([2, 3]);
    expect(filed[0]!.filedDate).toBe('2026-07-31');
  });

  test('spans the last N runs and de-dupes keeping the earliest date', () => {
    const filed = collectIdeasFiled(entries, { runs: 3 });
    expect(filed.map((f) => f.ref?.number)).toEqual([1, 2, 3]);
    // #2 first appears in the 07-30 run.
    expect(filed.find((f) => f.ref?.number === 2)!.filedDate).toBe('2026-07-30');
  });

  test('retains unparseable URLs with a null ref', () => {
    const bad = parseReflectionLog('{"date":"2026-08-01","ideasFiled":["https://github.com/o/r/pull/9"]}');
    const filed = collectIdeasFiled(bad);
    expect(filed[0]!.ref).toBeNull();
    expect(filed[0]!.url).toBe('https://github.com/o/r/pull/9');
  });
});

describe('classifyIssueState', () => {
  test('open stays open', () => {
    expect(classifyIssueState(OPEN).state).toBe('open');
  });
  test('closed by a merged PR is shipped', () => {
    expect(classifyIssueState(SHIPPED(1705))).toMatchObject({
      state: 'shipped',
      shippedByPr: 1705,
    });
  });
  test('closed without a merged PR is closed-unshipped', () => {
    expect(classifyIssueState(CLOSED_UNSHIPPED).state).toBe('closed');
  });
  test('prefers the merged PR when multiple references exist', () => {
    const raw: RawIssueState = {
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closingPrs: [
        { number: 10, url: 'u10', merged: false },
        { number: 11, url: 'u11', merged: true },
      ],
    };
    expect(classifyIssueState(raw).shippedByPr).toBe(11);
  });
});

describe('resolveIdeas', () => {
  const filed: FiledIdea[] = [
    { url: 'https://github.com/o/r/issues/1', ref: parseIssueRef('https://github.com/o/r/issues/1'), filedDate: '2026-07-31' },
    { url: 'https://github.com/o/r/issues/2', ref: parseIssueRef('https://github.com/o/r/issues/2'), filedDate: '2026-07-31' },
    { url: 'https://github.com/o/r/issues/3', ref: parseIssueRef('https://github.com/o/r/issues/3'), filedDate: '2026-07-31' },
    { url: 'https://github.com/o/r/pull/4', ref: null, filedDate: '2026-07-31' },
  ];

  test('resolves each idea through the probe', async () => {
    const probe: IssueProbe = async (ref) => {
      if (ref.number === 1) return OPEN;
      if (ref.number === 2) return SHIPPED(99);
      return CLOSED_UNSHIPPED;
    };
    const resolved = await resolveIdeas(filed, probe);
    expect(resolved.map((r) => r.state)).toEqual(['open', 'shipped', 'closed', 'unknown']);
    expect(resolved[1]!.shippedByPr).toBe(99);
    expect(resolved[3]!.error).toBe('unparseable issue URL');
  });

  test('probe failures degrade to unknown, not a rejection', async () => {
    const probe: IssueProbe = async (ref) => {
      if (ref.number === 2) throw new Error('boom');
      return OPEN;
    };
    const resolved = await resolveIdeas(filed.slice(0, 3), probe);
    expect(resolved[1]!.state).toBe('unknown');
    expect(resolved[1]!.error).toBe('boom');
    expect(resolved[0]!.state).toBe('open');
  });

  test('bounds in-flight work at the concurrency limit and preserves order', async () => {
    let active = 0;
    let maxActive = 0;
    const probe: IssueProbe = async (ref) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return ref.number % 2 === 0 ? SHIPPED(ref.number) : OPEN;
    };
    const many: FiledIdea[] = Array.from({ length: 6 }, (_, i) => ({
      url: `https://github.com/o/r/issues/${i + 1}`,
      ref: parseIssueRef(`https://github.com/o/r/issues/${i + 1}`),
      filedDate: null,
    }));
    const resolved = await resolveIdeas(many, probe, { concurrency: 2 });
    expect(resolved.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]); // input order preserved
    expect(maxActive).toBe(2); // work-stealing loop ran with >limit items
  });
});

describe('parseGhIssueResponse', () => {
  test('parses an open issue', () => {
    const raw = parseGhIssueResponse(
      '{"data":{"repository":{"issue":{"state":"OPEN","stateReason":null,"closedByPullRequestsReferences":{"nodes":[]}}}}}',
    );
    expect(raw).toEqual({ state: 'OPEN', stateReason: null, closingPrs: [] });
  });

  test('parses a shipped issue with a merged closing PR', () => {
    const raw = parseGhIssueResponse(
      '{"data":{"repository":{"issue":{"state":"CLOSED","stateReason":"COMPLETED","closedByPullRequestsReferences":{"nodes":[{"number":1705,"url":"u","merged":true}]}}}}}',
    );
    expect(classifyIssueState(raw)).toMatchObject({ state: 'shipped', shippedByPr: 1705 });
  });

  test('drops null / malformed PR nodes', () => {
    const raw = parseGhIssueResponse(
      '{"data":{"repository":{"issue":{"state":"CLOSED","stateReason":"COMPLETED","closedByPullRequestsReferences":{"nodes":[null,{"merged":true},{"number":9,"url":"u9","merged":false}]}}}}}',
    );
    expect(raw.closingPrs).toEqual([{ number: 9, url: 'u9', merged: false }]);
  });

  test('throws on a null issue, surfacing the GraphQL error message', () => {
    expect(() =>
      parseGhIssueResponse(
        '{"data":{"repository":{"issue":null}},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to an Issue"}]}',
      ),
    ).toThrow('Could not resolve to an Issue');
  });

  test('throws on non-JSON output', () => {
    expect(() => parseGhIssueResponse('gh: command failed')).toThrow('non-JSON');
  });
});

describe('summarizeIdeas', () => {
  test('tallies states and computes ship-rate over resolvable ideas', async () => {
    const probe: IssueProbe = async (ref) =>
      ref.number === 1 ? OPEN : ref.number === 2 ? SHIPPED(9) : CLOSED_UNSHIPPED;
    const filed: FiledIdea[] = [1, 2, 3].map((n) => ({
      url: `https://github.com/o/r/issues/${n}`,
      ref: parseIssueRef(`https://github.com/o/r/issues/${n}`),
      filedDate: '2026-07-31',
    }));
    const summary = summarizeIdeas(await resolveIdeas(filed, probe));
    expect(summary).toMatchObject({ total: 3, open: 1, shipped: 1, closed: 1, unknown: 0 });
    expect(summary.shippedRate).toBeCloseTo(1 / 3);
  });

  test('ship-rate is null when nothing is resolvable', () => {
    const summary = summarizeIdeas([
      {
        url: 'x',
        owner: null,
        repo: null,
        number: null,
        filedDate: null,
        state: 'unknown',
        stateReason: null,
        shippedByPr: null,
        shippedByPrUrl: null,
        error: 'bad',
      },
    ]);
    expect(summary.shippedRate).toBeNull();
  });
});

describe('formatIdeasTable', () => {
  test('renders a compact filed→shipped table', async () => {
    const probe: IssueProbe = async (ref) => (ref.number === 2 ? SHIPPED(1705) : OPEN);
    const filed: FiledIdea[] = [1, 2].map((n) => ({
      url: `https://github.com/kookr-ai/kookr/issues/${n}`,
      ref: parseIssueRef(`https://github.com/kookr-ai/kookr/issues/${n}`),
      filedDate: '2026-07-31',
    }));
    const table = formatIdeasTable(await resolveIdeas(filed, probe));
    expect(table).toContain('kookr#2');
    expect(table).toContain('shipped by PR #1705');
    expect(table).toContain('1 shipped');
  });

  test('renders the closed-unshipped and unknown branches with the error suffix', () => {
    const table = formatIdeasTable([
      {
        url: 'https://github.com/o/r/issues/3',
        owner: 'o',
        repo: 'r',
        number: 3,
        filedDate: '2026-07-31',
        state: 'closed',
        stateReason: 'NOT_PLANNED',
        shippedByPr: null,
        shippedByPrUrl: null,
        error: null,
      },
      {
        url: 'https://github.com/o/r/issues/4',
        owner: 'o',
        repo: 'r',
        number: 4,
        filedDate: null,
        state: 'unknown',
        stateReason: null,
        shippedByPr: null,
        shippedByPrUrl: null,
        error: 'boom',
      },
    ]);
    expect(table).toContain('closed (unshipped)');
    expect(table).toContain('unknown (boom)');
    expect(table).toContain('filed ?');
  });

  test('handles the empty case', () => {
    expect(formatIdeasTable([])).toContain('no ideas filed');
  });
});
