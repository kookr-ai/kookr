import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { interpolateParameters, parsePlaybook } from './playbook-parser.js';

describe('architecture-refactor-rfc playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'architecture-refactor-rfc.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'architecture-refactor-rfc.md', '/', 'plugin');
  const phasePlaybookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'architecture-refactor-phase.md',
  );

  test('parses as a delivery-authorized GitHub playbook with an explicit finding handoff', () => {
    expect(pb.name).toBe('Architecture Refactor RFC');
    expect(pb.deliveryPreAuthorized).toBe(true);
    expect(pb.autoCloseOnSignal).toBe(true);
    expect(pb.repoTags).toEqual(['github']);
    expect(pb.parameters.map((parameter) => parameter.name)).toEqual([
      'repoFullName',
      'findingKey',
      'findingTitle',
      'findingEvidence',
      'phasePlan',
      'sourceRef',
    ]);
  });

  test('renders every parameter without leaving an unresolved placeholder', () => {
    const rendered = interpolateParameters(pb.body, pb.parameters, {
      repoFullName: 'octocat/hello-world',
      findingKey: 'split-god-module',
      findingTitle: 'Split the command hub',
      findingEvidence: 'src/hub.ts owns unrelated workflows.',
      phasePlan: 'P1: extract parsing\nP2: extract persistence',
      sourceRef: 'architecture-health-check:2026-08-26',
    });
    expect(rendered).not.toMatch(/\{\{[a-zA-Z]/);
  });

  test('orders convergence, reviewed merge, reachability, umbrella, then Phase-1 launch', () => {
    const headings = [
      '## Phase 2 — Draft and Converge the RFC',
      '## Phase 3 — Review and Merge the RFC PR',
      '## Phase 4 — Prove the Merge Is Reachable from Fresh Main',
      '## Phase 5 — Create or Resume the Durable Umbrella',
      '## Phase 6 — Launch Phase 1',
    ];
    const positions = headings.map((heading) => pb.body.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test('fails closed without exact-head independent review and wrapper merge evidence', () => {
    const mergePhase = pb.body.slice(
      pb.body.indexOf('## Phase 3 — Review and Merge the RFC PR'),
      pb.body.indexOf('## Phase 4 — Prove the Merge Is Reachable from Fresh Main'),
    );
    expect(mergePhase).toContain('independent-merge-review');
    expect(mergePhase).toContain('review-head-sha');
    expect(mergePhase).toMatch(/missing|stale/i);
    expect(mergePhase).toMatch(/fail closed|stop/i);
    expect(mergePhase).toContain('pnpm merge');
    expect(mergePhase).toContain('sha: <rfcHeadSha>');
    expect(mergePhase).toMatch(/allowed merge method/i);
    expect(mergePhase).toContain('gh api --method PUT');
    expect(mergePhase).toContain('repos/$REPO/pulls/$RFC_PR_NUMBER/merge');
    expect(mergePhase).toContain('--field sha="$RFC_HEAD_SHA"');
    expect(mergePhase).toContain('--field merge_method="$MERGE_METHOD"');
  });

  test('creates no umbrella until the RFC merge commit is reachable from fresh origin/main', () => {
    const reachabilityPhase = pb.body.slice(
      pb.body.indexOf('## Phase 4 — Prove the Merge Is Reachable from Fresh Main'),
      pb.body.indexOf('## Phase 5 — Create or Resume the Durable Umbrella'),
    );
    expect(reachabilityPhase).toContain('git fetch origin main');
    expect(reachabilityPhase).toContain('git merge-base --is-ancestor');
    expect(reachabilityPhase).toContain('RFC_MERGE_SHA');
    expect(reachabilityPhase).toMatch(/do not create|must not create/i);
  });

  test('persists idempotent RFC, umbrella, and Phase-1 references', () => {
    expect(pb.body).toContain('rfcPrUrl');
    expect(pb.body).toContain('rfcHeadSha');
    expect(pb.body).toContain('rfcMergeSha');
    expect(pb.body).toContain('umbrellaIssueUrl');
    expect(pb.body).toContain('umbrellaIssueNumber');
    expect(pb.body).toContain('phase1TaskId');
    expect(pb.body).toContain('kookr-architecture-refactor-rfc:{{findingKey}}');
    expect(pb.body).toContain('--idempotency-key');
    const discoveryPhase = pb.body.slice(
      pb.body.indexOf('## Phase 0 — Validate and Resume Durable State'),
      pb.body.indexOf('## Phase 1 — Verify Evidence and Freeze the Phase Plan'),
    );
    expect(discoveryPhase).toContain('gh api');
    expect(discoveryPhase).toContain('--paginate');
    expect(discoveryPhase).toContain('per_page=100');
    expect(discoveryPhase).toMatch(/all RFC PR states.*all open\/closed issues/is);
    expect(discoveryPhase).toMatch(/exclude pull requests from the issue collection/i);
    expect(discoveryPhase).toMatch(/filter.*bodies.*exact marker/is);
    expect(discoveryPhase).not.toMatch(/--limit (200|1000)/);
  });

  test('writes the self-advancing ledger and records launch only after a confirmed task id', () => {
    const umbrellaPhase = pb.body.slice(
      pb.body.indexOf('## Phase 5 — Create or Resume the Durable Umbrella'),
      pb.body.indexOf('## Phase 6 — Launch Phase 1'),
    );
    expect(umbrellaPhase).toContain('kookr-phase-ledger');
    expect(umbrellaPhase).toContain('dependsOn');
    expect(umbrellaPhase).toContain('RFC reference commit');
    expect(umbrellaPhase).toMatch(/validate.*ledger|round-trip/i);

    const launchPhase = pb.body.slice(pb.body.indexOf('## Phase 6 — Launch Phase 1'));
    expect(launchPhase).toContain('kookr spawn');
    expect(launchPhase).toContain('--playbook architecture-refactor-phase.md');
    expect(launchPhase).toContain('--playbook-scope plugin');
    expect(launchPhase).toContain('--idempotency-key "chain:${REPO_KEY}:${UMBRELLA_NUMBER}:phase:P1"');
    expect(launchPhase).not.toContain('chain:${UMBRELLA_NUMBER}:phase:P1');
    expect(launchPhase).toContain('kookr-phase-result');
    expect(launchPhase).toMatch(/task id|taskId/i);
    expect(launchPhase).toMatch(/missing.*task id|without.*task id/i);
  });

  test('launches phase prompts through a real self-advancing wrapper playbook', () => {
    const phaseContent = readFileSync(phasePlaybookPath, 'utf-8');
    const phase = parsePlaybook(phaseContent, 'architecture-refactor-phase.md', '/', 'plugin');

    expect(phase.deliveryMode).toBe('self-advancing');
    expect(phase.parameters.map((parameter) => parameter.name)).toEqual(['prompt']);
    expect(phase.body).toContain('{{prompt}}');
    expect(phase.body).toContain('self-continuation-task');
    expect(phase.body).toContain('--playbook architecture-refactor-phase.md');
    expect(phase.body).toContain('--playbook-scope plugin');
    expect(phase.body).toContain('chain:${REPO_KEY}:${UMBRELLA_NUMBER}:phase:${NEXT_PHASE_ID}');
    expect(phase.body).toContain('--parent-task-id "$KOOKR_TASK_ID"');
  });

  test('keeps the front-end key identical to the background umbrella-chain monitor key', () => {
    const advancer = readFileSync(join(
      import.meta.dirname,
      '..',
      'server',
      'use-cases',
      'umbrella-chain-advancer.ts',
    ), 'utf-8');
    const d2Key = advancer.match(/function phaseClaimKey[\s\S]*?return `([^`]+)`;/)?.[1];
    const frontEndKey = pb.body.match(/--idempotency-key "([^"]+)"/)?.[1];
    const normalize = (value: string | undefined) => value
      ?.replace('${normalizedRepo}', '${REPO_KEY}')
      .replace('${issueNumber}', '${ISSUE_NUMBER}')
      .replace('${UMBRELLA_NUMBER}', '${ISSUE_NUMBER}')
      .replace('${phaseId}', '${PHASE_ID}')
      .replace('P1', '${PHASE_ID}');

    expect(d2Key).toBeDefined();
    expect(frontEndKey).toBeDefined();
    expect(normalize(frontEndKey)).toBe(normalize(d2Key));
  });

  test('extends rfc-iterative-review with a narrowly authorized continuation tail', () => {
    const skill = readFileSync(join(
      import.meta.dirname,
      '..',
      '..',
      'plugin',
      'skills',
      'rfc-iterative-review',
      'SKILL.md',
    ), 'utf-8');
    const defaultStop = skill.indexOf('### STOP here');
    const tail = skill.indexOf('## Phase 4 — Authorized Architecture-Refactor Continuation Tail');
    expect(defaultStop).toBeGreaterThan(-1);
    expect(tail).toBeGreaterThan(defaultStop);
    const tailBody = skill.slice(tail);
    expect(tailBody).toContain('architecture-refactor-rfc');
    expect(tailBody).toContain('rfcDeliveryAuthorized');
    expect(tailBody).toContain('independent-merge-review');
    expect(tailBody).toContain('review-head-sha');
    expect(tailBody).toContain('git merge-base --is-ancestor');
    expect(tailBody).toContain('kookr-phase-ledger');
    expect(tailBody).toContain('--idempotency-key');
    expect(tailBody).toMatch(/missing|stale/);
    expect(tailBody).toMatch(/fail closed|stop/i);
  });
});
