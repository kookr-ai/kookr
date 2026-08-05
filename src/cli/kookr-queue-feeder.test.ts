import { describe, expect, it } from 'vitest';
import {
  QueueFeederUsageError,
  parseQueueFeederArgs,
  parseSnapshot,
  runQueueFeederCli,
} from './kookr-queue-feeder.js';

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  const ledger: Array<{ path: string; line: string }> = [];
  return {
    lines,
    errs,
    ledger,
    out: { log: (...a: unknown[]) => lines.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errs.push(a.map(String).join(' ')) },
    appendLine: (path: string, line: string) => ledger.push({ path, line }),
    now: () => new Date('2026-08-01T18:00:00Z'),
  };
}

const SNAPSHOT = JSON.stringify({
  capacity: { free: 5, pendingQueueDepth: 0 },
  candidates: [
    { repo: 'jeanibarz/lucy', number: 1588, title: 'anchor truth — SEC acceptance anchors', openChildrenCount: 0 },
    { repo: 'jeanibarz/lucy', number: 1590, title: 'refactor the harness', labels: ['refactor'], openChildrenCount: 0 },
  ],
});

describe('parseQueueFeederArgs', () => {
  it('parses plan flags', () => {
    const a = parseQueueFeederArgs(['plan', '--input', '-', '--free', '5', '--emit', '--json']);
    expect(a.verb).toBe('plan');
    expect(a.input).toBe('-');
    expect(a.free).toBe(5);
    expect(a.emit).toBe(true);
    expect(a.json).toBe(true);
  });

  it('parses --free-threshold and rejects a non-positive value', () => {
    expect(parseQueueFeederArgs(['plan', '--free-threshold', '2']).freeThreshold).toBe(2);
    expect(() => parseQueueFeederArgs(['plan', '--free-threshold', '0'])).toThrow(QueueFeederUsageError);
  });

  it('rejects unknown flags and negative numbers', () => {
    expect(() => parseQueueFeederArgs(['plan', '--nope'])).toThrow(QueueFeederUsageError);
    expect(() => parseQueueFeederArgs(['plan', '--free', '-1'])).toThrow(QueueFeederUsageError);
  });
});

describe('parseSnapshot', () => {
  it('parses a valid snapshot', () => {
    const snap = parseSnapshot(SNAPSHOT);
    expect(snap.capacity.free).toBe(5);
    expect(snap.candidates).toHaveLength(2);
  });

  it('rejects malformed input', () => {
    expect(() => parseSnapshot('not json')).toThrow(QueueFeederUsageError);
    expect(() => parseSnapshot('{"capacity":{}}')).toThrow(QueueFeederUsageError);
    expect(() => parseSnapshot('{"capacity":{"free":1,"pendingQueueDepth":0}}')).toThrow(
      QueueFeederUsageError,
    );
  });

  it('rejects a null candidate element as a usage error (not a raw TypeError)', () => {
    const bad = '{"capacity":{"free":1,"pendingQueueDepth":0},"candidates":[null]}';
    expect(() => parseSnapshot(bad)).toThrow(QueueFeederUsageError);
  });
});

describe('runQueueFeederCli plan (dry-run default)', () => {
  it('selects the SEC-anchor umbrella and does not emit by default', async () => {
    const c = capture();
    const ghCalls: string[][] = [];
    const code = await runQueueFeederCli(['plan', '--input', '-', '--json'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: (a) => {
        ghCalls.push(a);
        return '';
      },
    });
    expect(code).toBe(0);
    expect(ghCalls).toHaveLength(0); // dry-run — no gh issue create
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.decision.selected.ref).toBe('jeanibarz/lucy#1588');
    expect(payload.decision.selected.productMetricBlocking).toBe(true);
    expect(payload.record.dryRun).toBe(true);
    expect(payload.record.leafCount).toBe(3);
    // Ledger row written for observability.
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0]!.path).toMatch(/queue-feeder\/decisions\.jsonl$/);
  });

  it('skips lucy#1588 once it already has open children (idempotent)', async () => {
    const c = capture();
    const snap = JSON.stringify({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        { repo: 'jeanibarz/lucy', number: 1588, title: 'SEC anchors', labels: ['sec-anchor'], openChildrenCount: 3 },
      ],
    });
    const code = await runQueueFeederCli(['plan', '--input', '-'], { ...c, readInput: () => snap });
    expect(code).toBe(0);
    expect(c.lines.join('\n')).toMatch(/skip-invent|no eligible umbrella/);
  });

  it('does not trigger when overridden pending depth is non-zero', async () => {
    const c = capture();
    const code = await runQueueFeederCli(['plan', '--input', '-', '--pending', '4'], {
      ...c,
      readInput: () => SNAPSHOT,
    });
    expect(code).toBe(0);
    expect(c.lines.join('\n')).toMatch(/not triggered/);
  });

  it('emits leaf issues via gh only with --emit, targeting the umbrella repo', async () => {
    const c = capture();
    const listCalls: string[][] = [];
    const createCalls: string[][] = [];
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit', '--json'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: (a) => {
        if (a[1] === 'list') {
          listCalls.push(a);
          return '[]'; // no existing issue with that title → proceed to create
        }
        createCalls.push(a);
        return 'https://github.com/jeanibarz/lucy/issues/9001';
      },
    });
    expect(code).toBe(0);
    // Each leaf is checked for an existing title before it is created (#2120).
    expect(listCalls).toHaveLength(3);
    for (const call of listCalls) {
      expect(call.slice(0, 6)).toEqual([
        'issue',
        'list',
        '-R',
        'jeanibarz/lucy',
        '--state',
        'all',
      ]);
    }
    expect(createCalls).toHaveLength(3); // one gh issue create per leaf
    // Each call is a well-formed `gh issue create -R <repo> --title ... --body ...`.
    for (const call of createCalls) {
      expect(call.slice(0, 4)).toEqual(['issue', 'create', '-R', 'jeanibarz/lucy']);
      expect(call).toContain('--title');
      expect(call).toContain('--body');
      // lucy#1588 leaves carry labels → each create passes them through.
      expect(call).toContain('--label');
    }
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.emitted).toHaveLength(3);
    expect(payload.skipped).toHaveLength(0);
    expect(payload.record.dryRun).toBe(false);
  });

  it('files ZERO new issues when every leaf title already exists closed (#2120)', async () => {
    const c = capture();
    const listCalls: string[][] = [];
    const createCalls: string[][] = [];
    let existingNumber = 2099;
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit', '--json'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: (a) => {
        if (a[1] === 'list') {
          listCalls.push(a);
          // Pull the searched title out of the --search arg and echo it back as
          // an already-landed CLOSED fixture so every leaf matches.
          const search = a[a.indexOf('--search') + 1]!;
          const title = JSON.parse(search.replace(/^in:title /, '')) as string;
          return JSON.stringify([{ number: existingNumber++, title }]);
        }
        createCalls.push(a);
        return 'https://github.com/jeanibarz/lucy/issues/9999';
      },
    });
    expect(code).toBe(0);
    expect(listCalls).toHaveLength(3); // every leaf checked
    expect(createCalls).toHaveLength(0); // ...and none re-filed
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.skipped).toHaveLength(3);
    // Existing refs are reused in `emitted` so the ledger reflects reality.
    expect(payload.emitted).toEqual([
      'jeanibarz/lucy#2099',
      'jeanibarz/lucy#2100',
      'jeanibarz/lucy#2101',
    ]);
    // Ledger row notes the skips for agent audit.
    expect(c.ledger).toHaveLength(1);
    const ledgerRow = JSON.parse(c.ledger[0]!.line);
    expect(ledgerRow.skipped).toHaveLength(3);
    expect(ledgerRow.emitError).toBeNull();
  });

  it('files only the NEW title in a mixed closed/new leaf plan (#2120)', async () => {
    const c = capture();
    const listCalls: string[][] = [];
    const createCalls: string[][] = [];
    // Mark the first leaf's title as an already-landed closed fixture; the rest
    // are new. Exactly the new titles should be filed.
    let closedTitle: string | null = null;
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit', '--json'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: (a) => {
        if (a[1] === 'list') {
          listCalls.push(a);
          const search = a[a.indexOf('--search') + 1]!;
          const title = JSON.parse(search.replace(/^in:title /, '')) as string;
          if (closedTitle === null) {
            closedTitle = title; // first leaf → treat as pre-existing closed
            return JSON.stringify([{ number: 2099, title }]);
          }
          return '[]'; // remaining leaves are genuinely new
        }
        createCalls.push(a);
        return 'https://github.com/jeanibarz/lucy/issues/9001';
      },
    });
    expect(code).toBe(0);
    expect(listCalls).toHaveLength(3);
    expect(createCalls).toHaveLength(2); // only the two new titles filed
    // The one skipped title is never handed to `gh issue create`.
    for (const call of createCalls) {
      const filedTitle = call[call.indexOf('--title') + 1];
      expect(filedTitle).not.toBe(closedTitle);
    }
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.skipped).toHaveLength(1);
    expect(payload.skipped[0].existing).toBe('jeanibarz/lucy#2099');
    expect(payload.emitted).toHaveLength(3); // 1 reused ref + 2 fresh URLs
    // The reused ref is carried in `emitted`, not only in `skipped` (#2120).
    expect(payload.emitted).toContain('jeanibarz/lucy#2099');
  });

  it('fails open and files the leaf when the existence check returns unparseable JSON', async () => {
    const c = capture();
    const createCalls: string[][] = [];
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit', '--json'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: (a) => {
        if (a[1] === 'list') return 'not json at all'; // gh exit 0, garbage stdout
        createCalls.push(a);
        return 'https://github.com/jeanibarz/lucy/issues/9001';
      },
    });
    expect(code).toBe(0);
    // Unparseable payload → treated as no match → leaf is still filed (fail open).
    expect(createCalls).toHaveLength(3);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.skipped).toHaveLength(0);
  });

  it('with --emit but no vetted leaf plan, files nothing and exits 0', async () => {
    const c = capture();
    const ghCalls: string[][] = [];
    const snap = JSON.stringify({
      capacity: { free: 5, pendingQueueDepth: 0 },
      // A product umbrella with no curated plan → selected but needs-authoring.
      candidates: [
        { repo: 'jeanibarz/lucy', number: 4242, title: 'SEC anchors v2', labels: ['sec-anchor'], openChildrenCount: 0 },
      ],
    });
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit', '--json'], {
      ...c,
      readInput: () => snap,
      runGh: (a) => {
        ghCalls.push(a);
        return '';
      },
    });
    expect(code).toBe(0);
    expect(ghCalls).toHaveLength(0); // needs-authoring guard prevents emission
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.decision.selected.needsAuthoring).toBe(true);
    // Product umbrella + no curated plan → invent-product-wave (#2069), not
    // silent skip-invent. CLI still does not auto-create leaves without a plan.
    expect(payload.decision.action).toBe('invent-product-wave');
    expect(payload.decision.inventLeafCap).toBe(3);
    expect(payload.emitted).toHaveLength(0);
  });

  it('secondary-emits unassigned idea-scout issues when product leaves are empty (#2044)', async () => {
    const c = capture();
    const ghCalls: string[][] = [];
    const snap = JSON.stringify({
      capacity: { free: 7, pendingQueueDepth: 0 },
      openProductMetricIssues: 0,
      candidates: [
        {
          repo: 'jeanibarz/lucy',
          number: 1588,
          title: 'SEC anchors',
          labels: ['sec-anchor'],
          openChildrenCount: 5,
        },
        {
          repo: 'jeanibarz/lucy',
          number: 2047,
          title: 'Umbrella: idea-scout residual docs',
          openChildrenCount: 0,
        },
      ],
      readyIssues: [
        {
          repo: 'kookr-ai/kookr',
          number: 2032,
          title: 'feat: secondary A',
          labels: ['idea-scout'],
          assignees: [],
        },
        {
          repo: 'kookr-ai/kookr',
          number: 2033,
          title: 'feat: claimed',
          labels: ['idea-scout'],
          assignees: ['someone-else'],
        },
      ],
    });
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit', '--json'], {
      ...c,
      readInput: () => snap,
      runGh: (a) => {
        ghCalls.push(a);
        return '';
      },
    });
    expect(code).toBe(0);
    // Secondary path never creates issues (they already exist).
    expect(ghCalls).toHaveLength(0);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.decision.action).toBe('emit-secondary');
    expect(payload.decision.actionSource).toBe('idea-scout');
    expect(payload.decision.secondaryEmitted).toHaveLength(1);
    expect(payload.decision.secondaryEmitted[0].ref).toBe('kookr-ai/kookr#2032');
    expect(payload.emitted).toEqual(['kookr-ai/kookr#2032']);
    expect(payload.record.action).toBe('emit-secondary');
    expect(payload.record.source).toBe('idea-scout');
    // Ledger row carries action for agent audit.
    expect(c.ledger).toHaveLength(1);
    const ledgerRow = JSON.parse(c.ledger[0]!.line);
    expect(ledgerRow.action).toBe('emit-secondary');
    expect(ledgerRow.secondaryEmitted).toEqual(['kookr-ai/kookr#2032']);
  });

  it('honours --free-threshold when overriding the idle-capacity gate', async () => {
    const c = capture();
    const snap = JSON.stringify({
      capacity: { free: 2, pendingQueueDepth: 0 },
      candidates: [
        { repo: 'jeanibarz/lucy', number: 1588, title: 'SEC anchors', labels: ['sec-anchor'], openChildrenCount: 0 },
      ],
    });
    // free=2 is below the default threshold (3) → not triggered...
    const below = capture();
    expect(await runQueueFeederCli(['plan', '--input', '-'], { ...below, readInput: () => snap })).toBe(0);
    expect(below.lines.join('\n')).toMatch(/not triggered/);
    // ...but a --free-threshold of 2 makes free=2 enough to fire.
    const code = await runQueueFeederCli(['plan', '--input', '-', '--free-threshold', '2'], {
      ...c,
      readInput: () => snap,
    });
    expect(code).toBe(0);
    expect(c.lines.join('\n')).toContain('jeanibarz/lucy#1588');
  });

  it('returns exit 4 when the existence check gh call fails during --emit', async () => {
    // With #2120 the first gh call in the emit loop is `gh issue list` (the
    // title existence check). A failure there fails closed → exit 4, never a
    // blind create.
    const c = capture();
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: () => {
        throw new Error('gh: rate limited');
      },
    });
    expect(code).toBe(4);
    expect(c.errs.join('\n')).toMatch(/gh issue create failed/);
  });

  it('returns exit 4 when gh issue create itself fails during --emit', async () => {
    const c = capture();
    const code = await runQueueFeederCli(['plan', '--input', '-', '--emit'], {
      ...c,
      readInput: () => SNAPSHOT,
      runGh: (a) => {
        if (a[1] === 'list') return '[]'; // existence check passes...
        throw new Error('gh: rate limited'); // ...but the create fails
      },
    });
    expect(code).toBe(4);
    expect(c.errs.join('\n')).toMatch(/gh issue create failed/);
  });
});

describe('runQueueFeederCli leaves', () => {
  it('renders the curated lucy#1588 leaf bodies', async () => {
    const c = capture();
    const code = await runQueueFeederCli(['leaves', '--umbrella', 'jeanibarz/lucy#1588', '--json'], {
      ...c,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(c.lines[0]!);
    expect(payload.umbrella).toBe('jeanibarz/lucy#1588');
    expect(payload.bodies).toHaveLength(3);
    expect(payload.bodies[0].body).toContain('## Acceptance criteria');
  });

  it('errors for an unknown umbrella or malformed ref', async () => {
    const c = capture();
    expect(await runQueueFeederCli(['leaves', '--umbrella', 'nope'], { ...c })).toBe(2);
    expect(await runQueueFeederCli(['leaves', '--umbrella', 'owner/repo#999'], { ...c })).toBe(2);
  });
});

describe('help / unknown verb', () => {
  it('prints usage with no verb', async () => {
    const c = capture();
    expect(await runQueueFeederCli([], { ...c })).toBe(0);
    expect(c.lines.join('\n')).toMatch(/auto-decompose product umbrellas/);
  });

  it('rejects an unknown verb', async () => {
    const c = capture();
    expect(await runQueueFeederCli(['bogus'], { ...c })).toBe(2);
  });
});
