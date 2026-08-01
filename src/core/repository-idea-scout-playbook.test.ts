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
      const block = pb.body.slice(logStart, logStart + 1600);
      for (const key of ['"authority"', '"changeShape"', '"rank"', '"parallelConflictRisk"', '"conflictsWith"', '"evidenceVerification"']) {
        expect(block).toContain(key);
      }
    });
  });

  describe('evidence-verification gate validates cited evidence before publishing', () => {
    // Issue #1756: a hallucinated-but-plausible problem must be caught by a
    // cheap validator pass before it can be classified, ranked, or published,
    // so it never costs a full downstream implementation task to discover.
    test('there is a dedicated evidence-verification gate phase before classification', () => {
      const gate = pb.body.indexOf('### 4.5 Evidence Verification Gate');
      const classification = pb.body.indexOf('### 4.6 Classification');
      expect(gate).toBeGreaterThan(-1);
      expect(classification).toBeGreaterThan(gate);
    });

    test('the gate checks cited file:line and claimed-missing capabilities against the real checkout', () => {
      const gate = pb.body.slice(
        pb.body.indexOf('### 4.5 Evidence Verification Gate'),
        pb.body.indexOf('### 4.6 Classification'),
      );
      // (a) cited file:line exists and supports the claim
      expect(gate).toMatch(/Cited `file:line` exists and supports the claim/);
      // (b) claimed-missing capability is absent, not merely unfound
      expect(gate).toMatch(/Claimed-missing capability is absent, not merely unfound/);
      // (c) the three deterministic verdicts, cheap-tier, reusing the spend ledger
      for (const token of ['pass', 'downgraded', 'discarded']) {
        expect(gate).toContain(token);
      }
      expect(gate).toMatch(/Haiku- or Sonnet-tier/);
      expect(gate).toMatch(/spend ledger/i);
    });

    test('a discarded candidate never reaches the ideas log and downgrades feed authority', () => {
      const gate = pb.body.slice(
        pb.body.indexOf('### 4.5 Evidence Verification Gate'),
        pb.body.indexOf('### 4.6 Classification'),
      );
      expect(gate).toMatch(/A `discarded` candidate never reaches classification, ranking/);
      expect(gate).toMatch(/`confidence` reduced to `low` forces `authority = review-required`/);
    });

    test('Phase 8 validates the evidence-verification artifact and verdict', () => {
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8: Final Validation'));
      expect(phase8).toContain('evidence-verification.json');
      expect(phase8).toMatch(/no entry has `verdict: discarded`/);
      expect(phase8).toContain('## Evidence verification');
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
      const sec = pb.body.slice(pb.body.indexOf('### 5.7 Write the reader-first issue bodies'));
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

  describe('coverage-ordered dimension rotation (issue #1749 follow-up)', () => {
    test('the ORDERED_DIMS shell list matches the Diversity Dimensions table exactly', () => {
      // The rotation snippet duplicates the table as a shell list; drift between
      // them silently excludes a dimension from rotation — the exact starvation
      // the mechanism exists to prevent. This test is the enforced drift guard.
      const tableSec = pb.body.slice(pb.body.indexOf('## Diversity Dimensions'), pb.body.indexOf('### Coverage-ordered rotation'));
      const tableDims = [...tableSec.matchAll(/^\| ([a-z][a-z-]*) \|/gm)].map((m) => m[1]).filter((d) => d !== undefined);
      const snippet = pb.body.match(/ORDERED_DIMS=\$\(printf '%s\\n' ([^|]+)\|/);
      expect(snippet).not.toBeNull();
      const shellDims = snippet![1]!.replace(/\\\s*/g, ' ').trim().split(/\s+/);
      expect(tableDims.length).toBeGreaterThanOrEqual(10);
      expect(shellDims).toEqual(tableDims);
    });

    test('coverage update is guarded by appliedRuns and heals schema-invalid files', () => {
      const sec = pb.body.slice(pb.body.indexOf('### 5.6 Update dimension coverage'));
      expect(sec).toMatch(/appliedRuns \| index\(\$rk\)/);
      expect(sec).toMatch(/\[ -s "\$COVERAGE_FILE" \]/);
      expect(sec).toMatch(/\.dimensions\|type=="object"/);
      expect(sec).toMatch(/tmp\.\$\$/);
    });

    test('no hard Phase 8 gate tests coverage content beyond existence and validity', () => {
      expect(pb.body).toMatch(/no hard gate may test it beyond existence \+ validity/i);
      expect(pb.body).toMatch(/Dimensions skipped this run:/);
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

  // Slice a `## <heading>` section bounded to the next `## ` heading so an
  // assertion nominally scoped to a section cannot be satisfied by text that
  // later migrated to a different section.
  const section = (heading: string) => {
    const start = pb.body.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    const rest = pb.body.slice(start + heading.length);
    const nextIdx = rest.indexOf('\n## ');
    return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  };

  describe('per-run spend cap (issue #1587)', () => {
    test('spendCapUsd is an optional parameter with a non-empty default', () => {
      const p = param('spendCapUsd');
      expect(p).toBeDefined();
      expect(p!.required).toBe(false);
      // Must be non-empty so renders stay clean when the launcher omits it.
      expect(p!.default).toBeTruthy();
      // The placeholder is wired into the Launch Parameters block.
      expect(pb.body).toContain('{{spendCapUsd}}');
    });

    test('spendCapUsd is validated and 0/blank disable the cap', () => {
      // The value flows into `jq --argjson` and `awk`, so its grammar is a
      // value-injection surface — lock the validation pattern and disable rule.
      const rules = pb.body.slice(pb.body.indexOf('Copy each value into a shell variable'));
      expect(rules).toMatch(/`spendCapUsd`:.*\^\[0-9\]\+\(\\\.\[0-9\]\{1,2\}\)\?\$/);
      expect(rules).toMatch(/`0`, `0\.00`, and empty all disable the cap/);
    });

    test('the run records spend against the cap and stops when it is reached', () => {
      const sec = section('## Per-Run Spend Cap');
      expect(sec).toMatch(/records? (its )?spend against the cap/i);
      expect(sec).toMatch(/aggregateTokenUsage\.costUsd/);
      // Cap enforcement is gated on the Kookr task API being present.
      expect(pb.body).toMatch(/read_spend_usd\(\)/);
      expect(pb.body).toMatch(/spend_gate\(\)/);
      // Phase 4 and Phase 7 both invoke the gate at their boundaries.
      const phase4 = pb.body.slice(pb.body.indexOf('## Phase 4:'), pb.body.indexOf('## Phase 5:'));
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7:'), pb.body.indexOf('## Phase 8:'));
      expect(phase4).toMatch(/spend_gate/);
      expect(phase7).toMatch(/spend_gate/);
    });

    test('a cap breach is a controlled early stop, not a BLOCKED failure', () => {
      expect(pb.body).toMatch(/cap breach is \*\*not\*\* a `BLOCKED`|not a `BLOCKED` condition/i);
      expect(pb.body).toMatch(/capBreached/);
    });

    test('the run manifest carries the spend cap fields and Phase 8 mirrors the breach', () => {
      // The schedule rollup reads per-run spend off run.json — a refactor that
      // dropped the manifest fields would silently lose the feature's point.
      const preflight = pb.body.slice(pb.body.indexOf('Write `<runManifest>`'), pb.body.indexOf('## Phase 2:'));
      for (const field of ['spendCapUsd:', 'capEnforced:', 'capBreached:']) {
        expect(preflight).toContain(field);
      }
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8:'), pb.body.indexOf('## Idempotency Rules'));
      expect(phase8).toMatch(/\.capBreached = \$breached.*run\.json|run\.json.*capBreached/s);
    });

    test('the spend ledger schema is validated in Phase 8', () => {
      expect(pb.body).toMatch(/write_spend_ledger\(\)/);
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8:'), pb.body.indexOf('## Idempotency Rules'));
      // The validation clause names the ledger's numeric/boolean field set.
      expect(phase8).toMatch(/`<spendLedgerFile>` exists and is valid JSON with numeric `spendCapUsd`, boolean `capEnforced`, and boolean `capBreached`/);
    });

    test('per-run spend and cap breaches are surfaced in the completion output', () => {
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8:'), pb.body.indexOf('## Idempotency Rules'));
      expect(phase8).toMatch(/Run spend: \$/);
      expect(phase8).toMatch(/schedule ledger\/rollup/i);
      expect(pb.body).toMatch(/spendLedgerFile/);
    });

    test('the cap is best-effort: absent task API means unenforced, not blocked', () => {
      const sec = section('## Per-Run Spend Cap');
      expect(sec).toMatch(/capEnforced:? ?false|unenforced/i);
      expect(sec).toMatch(/never blocks the run|proceeds without stopping/i);
    });
  });

  describe('provenance labels for conversion tracking (issue #1587)', () => {
    test('the label prohibition carves an explicit provenance exception', () => {
      // The original hard prohibition is retained verbatim (security guard),
      // with a narrow, explicit exception for the two provenance labels.
      expect(pb.body).toMatch(/Do not create comments, branches, PRs, labels, or tracked-file changes/);
      expect(pb.body).toMatch(/sole exception is the two \*\*provenance labels\*\*/);
    });

    test('idea issues get idea-scout and idea:<issue-number> labels at creation', () => {
      const sec = section('## Provenance Labels');
      expect(sec).toMatch(/`idea-scout`/);
      expect(sec).toMatch(/`idea:<issue-number>`/);
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7:'), pb.body.indexOf('## Phase 8:'));
      expect(phase7).toMatch(/gh label create idea-scout/);
      expect(phase7).toMatch(/--add-label idea-scout --add-label "idea:\$ISSUE_NUM"/);
    });

    test('labels are applied only in publish-safe mode and only to issues this run creates', () => {
      const sec = section('## Provenance Labels');
      expect(sec).toMatch(/\*\*only\*\* when `publishBehavior` is `publish-safe`/);
      expect(sec).toMatch(/never labels pre-existing issues, PRs, or any artifact it did not create/i);
    });

    test('the join key is an integer parsed from GitHub, never repo-derived text', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7:'), pb.body.indexOf('## Phase 8:'));
      // ISSUE_NUM is validated as an integer before it reaches shell interpolation.
      expect(phase7).toMatch(/\$\{?ISSUE_NUM\}?/);
      expect(phase7).toMatch(/\*\[!0-9\]\*\)/);
    });

    test('conversion is documented as computable from labels alone via gh', () => {
      const sec = section('## Provenance Labels');
      expect(sec).toMatch(/computable from labels alone/i);
      expect(sec).toMatch(/gh issue list -R "\$REPO" --label idea-scout/);
      expect(sec).toMatch(/gh pr list -R "\$REPO" --state merged --label idea-scout/);
    });
  });
});
