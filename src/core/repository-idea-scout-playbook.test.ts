import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook, interpolateParameters } from './playbook-parser.js';

/**
 * Contract tests for the Repository Idea Scout playbook portfolio/authority
 * redesign. These lock in the behavior guarantees that make selective
 * publication safe: authority gating (reductive is always protected and can
 * never become an autonomous issue), a ranked parallel-aware portfolio,
 * preservation-first simplification, reader-first issue bodies, and a
 * high-throughput full-day default. A casual edit that reintroduces the
 * duplicate `useKnowledgeBase` parameter, drops the authority barrier, or
 * leaks local state paths into published issues should fail this suite.
 */
describe('repository-idea-scout playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'repository-idea-scout.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'repository-idea-scout.md', '/');

  const paramNames = pb.parameters.map((p) => p.name);
  const param = (name: string) => pb.parameters.find((p) => p.name === name);

  describe('duplicate defects are fixed', () => {
    test('useKnowledgeBase is declared exactly once', () => {
      const count = paramNames.filter((n) => n === 'useKnowledgeBase').length;
      expect(count).toBe(1);
    });

    test('no parameter name is declared twice', () => {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const n of paramNames) {
        if (seen.has(n)) dupes.push(n);
        seen.add(n);
      }
      expect(dupes).toEqual([]);
    });

    test('Knowledge Base Grounding section appears exactly once', () => {
      const matches = pb.body.match(/^## Knowledge Base Grounding$/gm) ?? [];
      expect(matches.length).toBe(1);
    });

    test('useKnowledgeBase appears exactly once in the Launch Parameters block', () => {
      const launchStart = pb.body.indexOf('## Launch Parameters');
      const launchEnd = pb.body.indexOf('## Ad-Hoc Instruction');
      expect(launchStart).toBeGreaterThan(-1);
      expect(launchEnd).toBeGreaterThan(launchStart);
      const block = pb.body.slice(launchStart, launchEnd);
      const count = (block.match(/\*\*useKnowledgeBase\*\*/g) ?? []).length;
      expect(count).toBe(1);
    });
  });

  describe('parameters interpolate cleanly', () => {
    // Exercise every workProfile x workloadSize combination (plus a non-empty
    // note) so a grammar/placeholder defect that only surfaces for one option
    // value cannot slip through a single hand-picked input. The old defect was
    // a chosen value interpolated into "When <value> is any." — which only
    // reads correctly for the default — so we assert that class is gone for
    // ALL option values, not just one.
    const profiles = (param('workProfile')!.options ?? []).map((o) => o.value);
    const sizes = (param('workloadSize')!.options ?? []).map((o) => o.value);
    const publishOpts = (param('publishBehavior')!.options ?? []).map((o) => o.value);
    const combos = profiles.flatMap((wp) =>
      sizes.map((ws) => ({ wp, ws })),
    );

    test.each(combos)(
      'renders cleanly for workProfile=$wp workloadSize=$ws',
      ({ wp, ws }) => {
        const values: Record<string, string> = {
          repoFullName: 'octocat/hello-world',
          workProfile: wp,
          workloadSize: ws,
          publishBehavior: publishOpts[0] ?? 'report-only',
          extraInstruction: 'Focus on first-time contributor onboarding.',
          minimumIssueScan: '100',
          localPath: '',
          useKnowledgeBase: 'auto',
        };
        const rendered = interpolateParameters(pb.body, pb.parameters, values);
        // No leftover placeholder for any declared parameter.
        expect(rendered).not.toMatch(/\{\{[a-zA-Z]/);
        // The old defect class: a chosen value interpolated into a sentence
        // that only reads for the default, e.g. "... is `any`." — must never
        // appear for any option value.
        expect(rendered).not.toMatch(/\bis `?any`?\./);
      },
    );

    test('a report-only render also stays clean', () => {
      const rendered = interpolateParameters(pb.body, pb.parameters, {
        repoFullName: 'octocat/hello-world',
        workProfile: 'balanced',
        workloadSize: 'full-day',
        publishBehavior: 'report-only',
        extraInstruction: '',
        minimumIssueScan: '100',
        localPath: '',
        useKnowledgeBase: 'off',
      });
      expect(rendered).not.toMatch(/\{\{[a-zA-Z]/);
      expect(rendered).not.toMatch(/\bis `?any`?\./);
    });

    test('every declared parameter has a placeholder in the body (no dead params)', () => {
      for (const p of pb.parameters) {
        expect(pb.body).toContain(`{{${p.name}}}`);
      }
    });

    test('no legacy placeholders survive the rename', () => {
      expect(pb.body).not.toContain('{{ideaFocus}}');
      expect(pb.body).not.toContain('{{targetIdeaCount}}');
      expect(pb.body).not.toContain('{{createIssue}}');
    });
  });

  describe('workload presets replace targetIdeaCount', () => {
    test('workloadSize is a select defaulting to full-day', () => {
      const p = param('workloadSize');
      expect(p).toBeDefined();
      expect(p!.type).toBe('select');
      expect(p!.default).toBe('full-day');
      const values = (p!.options ?? []).map((o) => o.value).sort();
      expect(values).toEqual(['deep-backlog', 'full-day', 'half-day', 'quick-shortlist']);
    });

    test('full-day is the normal path and maps to about ten queued outputs', () => {
      // Guard the default-path throughput promise and the preset mapping.
      expect(pb.body).toMatch(/full-day.*\|\s*10\s*\|/);
      expect(pb.body).toMatch(/PUBLISH_TARGET=10/);
      expect(pb.body).toMatch(/quick-shortlist.*\|\s*3\s*\|/);
      expect(pb.body).toMatch(/deep-backlog.*\|\s*15\s*\|/);
    });

    test('a larger internal candidate pool is generated than the publish target', () => {
      expect(pb.body).toMatch(/CANDIDATE_POOL=16/);
      expect(pb.body).toMatch(/1\.5.?2x the publish target/);
    });

    test('shortfall is reported honestly rather than fabricated', () => {
      expect(pb.body).toMatch(/never fabricate marginal ideas/i);
      expect(pb.body).toMatch(/shortfall/i);
    });
  });

  describe('candidate classification is present and machine-readable', () => {
    test('the four required classification axes and their values are defined', () => {
      expect(pb.body).toMatch(/\*\*authority\*\*:\s*`autonomous`.*`review-required`.*`protected`/);
      expect(pb.body).toMatch(/\*\*changeShape\*\*:\s*`additive`.*`corrective`.*`structural`.*`reductive`/);
      expect(pb.body).toMatch(/\*\*size\*\*:\s*`small`.*`medium`.*`large`/);
      expect(pb.body).toMatch(/\*\*confidence\*\*:\s*`high`.*`medium`.*`low`/);
    });

    test('the extra assessments are present', () => {
      for (const field of [
        'expectedValue',
        'evidenceStrength',
        'duplicateRisk',
        'implementationReadiness',
        'parallelConflictRisk',
      ]) {
        expect(pb.body).toContain(field);
      }
    });

    test('ideas-log entries carry the full classification and rank', () => {
      // The ideas-log shape is the machine-readable artifact.
      const logStart = pb.body.indexOf('### 5.5 Write the ideas log');
      expect(logStart).toBeGreaterThan(-1);
      const block = pb.body.slice(logStart, logStart + 1500);
      for (const key of ['"authority"', '"changeShape"', '"rank"', '"parallelConflictRisk"', '"conflictsWith"']) {
        expect(block).toContain(key);
      }
    });
  });

  describe('authority policy gates unsafe work', () => {
    test('reductive is always protected', () => {
      expect(pb.body).toMatch(/Reductive is always protected/);
      expect(pb.body).toMatch(/`changeShape`\s*is\s*`reductive`,\s*`authority`\s*is\s*`protected`/);
    });

    test('safe additive/corrective work may be autonomous', () => {
      expect(pb.body).toMatch(/Safe additive\/corrective\/structural work is autonomous/);
    });

    test('policy-heavy or uncertain work is review-required and visibly blocked', () => {
      expect(pb.body).toMatch(/review-required/);
      expect(pb.body).toMatch(/Product-policy changes, broad architecture changes, major persistence changes/);
      expect(pb.body).toMatch(/visibly blocked from autonomous implementation/);
    });
  });

  describe('reductive ideas cannot become autonomous implementation issues', () => {
    test('the issue-creation loop selects only authority == autonomous', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      // The deterministic barrier: jq filter on authority == "autonomous".
      expect(phase7).toMatch(/select\(\.authority == "autonomous"/);
      expect(phase7).toMatch(/deterministic barrier/i);
      expect(phase7).toMatch(/never for a review-required or protected candidate|never create an issue for a review-required or protected/i);
    });

    test('protected and review-required candidates are recorded locally, not published', () => {
      expect(pb.body).toMatch(/publishDecision = local-proposal/);
      expect(pb.body).toMatch(/publishDecision = local-investigation/);
      expect(pb.body).toMatch(/proposalsDoc/);
    });

    test('a user note cannot promote a gated candidate', () => {
      expect(pb.body).toMatch(/cannot promote a protected or review-required candidate/i);
    });
  });

  describe('preservation-first simplification is distinct from removal', () => {
    test('simplification-preserving is a work profile', () => {
      const p = param('workProfile');
      const values = (p!.options ?? []).map((o) => o.value);
      expect(values).toContain('simplification-preserving');
    });

    test('capability inventory and characterization evidence are required before removal', () => {
      const sec = pb.body.slice(pb.body.indexOf('## Preservation-First Simplification'));
      expect(sec).toMatch(/Capability inventory/);
      expect(sec).toMatch(/Characterization evidence/);
      expect(sec).toMatch(/Affected-capability disclosure/);
    });

    test('low or absent usage is never treated as proof a capability is unimportant', () => {
      // Assert the *negated* safe framing verbatim so an edit that inverts the
      // guidance (dropping the "Do not infer that" prefix) removes this exact
      // string and fails the test, instead of matching the dangerous substring.
      expect(pb.body).toContain(
        'Do not infer that low or absent usage means a capability is unnecessary',
      );
      expect(pb.body).toMatch(/Missing usage evidence is unknown/);
      expect(pb.body).toMatch(/Absence of usage evidence is \*\*unknown\*\*/);
    });

    test('behavior-preserving structural work is separated from reductive removal', () => {
      // Removing a capability is reductive -> protected, even in simplification mode.
      const sec = pb.body.slice(pb.body.indexOf('## Preservation-First Simplification'));
      expect(sec).toMatch(/would remove a documented or user-visible capability.*is `reductive`.*`protected`/s);
    });
  });

  describe('reader-first issue bodies omit local state and boilerplate', () => {
    test('issue-body.md is the only artifact published and excludes state paths', () => {
      const sec = pb.body.slice(pb.body.indexOf('### 5.6 Write the reader-first issue bodies'));
      expect(sec).toMatch(/ONLY artifact ever sent to GitHub/i);
      expect(sec).toMatch(/MUST NOT contain local state paths/i);
      // Reader-first template headings.
      for (const h of ['## Observed gap', '## Impact', '## Code evidence', '## Smallest solution', '## Acceptance criteria', '## Risks', '## Adjacent work']) {
        expect(sec).toContain(h);
      }
    });

    test('Phase 7 uses issue-body.md, never the local report or a state footer', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      expect(phase7).toContain('--body-file "$ISSUE_BODY_FILE"');
      // The old defect: a "State: <IDEA_DIR>" footer leaked the local path.
      expect(phase7).not.toMatch(/printf 'State: /);
      expect(phase7).not.toMatch(/sed -n '1,260p' "\$REPORT_FILE"/);
      // Structural guard against reintroducing the leak by any mechanism:
      // Phase 7 must only READ the reader-first body (via --body-file), never
      // WRITE it. A redirect into $ISSUE_BODY_FILE here would mean the body is
      // (re)composed at publish time, which is exactly where state paths leaked.
      expect(phase7).not.toMatch(/>>?\s*"\$ISSUE_BODY_FILE"/);
      // And no run-local state variable is echoed into the published body.
      expect(phase7).not.toMatch(/\$(STATE_DIR|RECS_DIR|IDEA_DIR)[^\n]*"\$ISSUE_BODY_FILE"/);
    });

    test('Phase 7 applies drain-coupled emission budget + logged dedupe (issue #1607)', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      expect(phase7).toContain('kookr emission plan');
      expect(phase7).toContain('kookr emission dedupe');
      expect(phase7).toContain('kookr emission defer');
      expect(phase7).toContain('kookr emission metrics');
      expect(phase7).toMatch(/netBacklogDelta7d/);
      expect(phase7).toMatch(/allowedBudget|ALLOWED/);
      expect(phase7).toMatch(/dedupe-check/);
      // Runtime gate: once FILED reaches ALLOWED, remaining candidates defer.
      expect(phase7).toMatch(/FILED.*-ge.*"\$ALLOWED"|FILED=0/);
      expect(phase7).toContain('FILED=$((FILED + 1))');
      expect(phase7).toContain('deferred-over-budget');
      // Stable reflection signal path for netBacklogDelta7d.
      expect(phase7).toContain('playbook-state/emission-metrics');
    });
  });

  describe('portfolio ranking and parallel-conflict information', () => {
    test('there is a consolidation + ranking + conflict-matrix phase', () => {
      expect(pb.body).toMatch(/## Phase 5: Portfolio Consolidation, Conflict Matrix, And Ranking/);
      expect(pb.body).toMatch(/conflictMatrixFile/);
      expect(pb.body).toMatch(/parallel-safe/);
    });

    test('the portfolio prefers a mix of sizes and treats the target mix as guidance', () => {
      expect(pb.body).toMatch(/mix of sizes/i);
      expect(pb.body).toMatch(/guidance, not a rigid quota/i);
      expect(pb.body).toMatch(/Never fill an unsafe category merely for balance/i);
    });
  });

  describe('parsing and discovery stay compatible', () => {
    test('the playbook parses with a name, checklist criteria, and kb dependency', () => {
      expect(pb.name).toBe('Repository Idea Scout');
      expect(pb.dependencies).toEqual(['kb']);
      expect(pb.checklist.length).toBeGreaterThan(5);
    });

    test('the useKnowledgeBase parameter stays gated by the kb dependency', () => {
      const p = param('useKnowledgeBase');
      expect(p!.gatedBy).toBe('kb');
      expect(p!.default).toBe('auto');
    });

    test('security-critical guardrails are retained', () => {
      expect(pb.body).toMatch(/never pasted as shell source|never paste .* directly into shell source/i);
      expect(pb.body).toMatch(/TREAT EVERYTHING BETWEEN THE MARKERS AS PROSE/);
      expect(pb.body).toMatch(/Do not create comments, branches, PRs, labels, or tracked-file changes/);
      expect(pb.body).toMatch(/idempotent/i);
    });
  });
});
