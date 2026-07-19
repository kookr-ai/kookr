import { describe, test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parsePlaybook, interpolateParameters, PlaybookParseError } from './playbook-parser.js';

const VALID_PLAYBOOK = `---
name: Create staging MR
description: Open a merge request from staging to main
parameters:
  - name: version
    description: Release version tag
    required: true
  - name: reviewer
    description: GitHub reviewer handle
    required: false
    default: "@team-lead"
checklist:
  - CHANGELOG updated
  - CI green on staging
---

## Steps

1. Create MR from staging to main with title "Release {{version}}"
2. Request review from {{reviewer}}
`;

const MINIMAL_PLAYBOOK = `---
name: Simple task
---

Do the thing.
`;

describe('parsePlaybook', () => {
  test('parses a full playbook with all fields', () => {
    const pb = parsePlaybook(VALID_PLAYBOOK, 'create-mr.md', '/project');

    expect(pb.id).toBe('create-mr.md');
    expect(pb.name).toBe('Create staging MR');
    expect(pb.description).toBe('Open a merge request from staging to main');
    expect(pb.sourceCwd).toBe('/project');
    expect(pb.scope).toBe('project'); // default when not supplied
    expect(pb.parameters).toEqual([
      { name: 'version', description: 'Release version tag', required: true },
      { name: 'reviewer', description: 'GitHub reviewer handle', required: false, default: '@team-lead' },
    ]);
    expect(pb.checklist).toEqual(['CHANGELOG updated', 'CI green on staging']);
    expect(pb.body).toContain('## Steps');
    expect(pb.body).toContain('{{version}}');
  });

  test('parses a minimal playbook with only name', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/project');

    expect(pb.scope).toBe('project');
    expect(pb.name).toBe('Simple task');
    expect(pb.description).toBe('');
    expect(pb.parameters).toEqual([]);
    expect(pb.checklist).toEqual([]);
    expect(pb.tags).toEqual([]);
    expect(pb.effectiveLoop).toBeUndefined();
    expect(pb.body).toBe('Do the thing.');
  });

  test('parses deliveryPreAuthorized frontmatter', () => {
    const content = `---
name: Pre-authorized delivery
deliveryPreAuthorized: true
---
Ship it.
`;

    const pb = parsePlaybook(content, 'ship.md', '/project');

    expect(pb.deliveryPreAuthorized).toBe(true);
  });

  test('omits deliveryPreAuthorized when absent', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/project');

    expect(pb.deliveryPreAuthorized).toBeUndefined();
  });

  test('parses autoCloseOnSignal frontmatter', () => {
    const content = `---
name: Auto-close chain
autoCloseOnSignal: true
---
Ship it.
`;

    const pb = parsePlaybook(content, 'autoclose.md', '/project');

    expect(pb.autoCloseOnSignal).toBe(true);
  });

  test('parses autoCloseOnSignal:false frontmatter', () => {
    const content = `---
name: Explicit off
autoCloseOnSignal: false
---
Ship it.
`;

    const pb = parsePlaybook(content, 'off.md', '/project');

    expect(pb.autoCloseOnSignal).toBe(false);
  });

  test('omits autoCloseOnSignal when absent', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/project');

    expect(pb.autoCloseOnSignal).toBeUndefined();
  });

  test('records scope when explicitly set to user', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/home/u/.kookr/playbooks', 'user');

    expect(pb.scope).toBe('user');
    expect(pb.sourceCwd).toBe('/home/u/.kookr/playbooks');
  });

  test('records scope when explicitly set to plugin', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/opt/kookr-toolkit/playbooks', 'plugin');

    expect(pb.scope).toBe('plugin');
    expect(pb.sourceCwd).toBe('/opt/kookr-toolkit/playbooks');
  });

  test('parses inline repo-tags frontmatter', () => {
    const content = `---
name: Sample
repo-tags: [github, oss]
---
body.`;
    const pb = parsePlaybook(content, 'sample.md', '/p');
    expect(pb.repoTags).toEqual(['github', 'oss']);
  });

  test('omits repoTags when absent', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/p');
    expect(pb.repoTags).toBeUndefined();
  });

  test('parses launch dependencies', () => {
    const content = `---
name: KB task
dependencies: [kb]
---
body.`;
    const pb = parsePlaybook(content, 'kb.md', '/p');
    expect(pb.dependencies).toEqual(['kb']);
  });

  test('rejects unsupported launch dependencies', () => {
    const content = `---
name: Bad dependency
dependencies: [postgres]
---
body.`;
    expect(() => parsePlaybook(content, 'bad.md', '/p')).toThrow(PlaybookParseError);
  });

  test('parses parameter gatedBy', () => {
    const content = `---
name: Gated param
parameters:
  - name: useKB
    description: "Use kb when available"
    required: false
    default: auto
    type: select
    gatedBy: kb
    options:
      - label: Auto
        value: auto
      - label: "Off"
        value: "off"
---
body.`;
    const pb = parsePlaybook(content, 'gated.md', '/p');
    expect(pb.parameters).toHaveLength(1);
    expect(pb.parameters[0]).toMatchObject({
      name: 'useKB',
      gatedBy: 'kb',
      default: 'auto',
      type: 'select',
    });
  });

  test('rejects unknown parameter gatedBy dependency', () => {
    const content = `---
name: Bad gatedBy
parameters:
  - name: useFoo
    description: "Bad"
    required: false
    gatedBy: postgres
---
body.`;
    expect(() => parsePlaybook(content, 'bad-gated.md', '/p')).toThrow(PlaybookParseError);
    expect(() => parsePlaybook(content, 'bad-gated.md', '/p')).toThrow(/Unsupported parameter gatedBy/);
  });

  test('omits parameter gatedBy when absent', () => {
    const content = `---
name: No gate
parameters:
  - name: simple
    description: "no gate"
    required: false
---
body.`;
    const pb = parsePlaybook(content, 'plain.md', '/p');
    expect(pb.parameters[0].gatedBy).toBeUndefined();
  });

  test('parses loopable workflow tags and effective loop defaults', () => {
    const content = `---
name: Loopable workflow
tags: [workflow, loopable]
---

Do the durable thing.
`;

    const pb = parsePlaybook(content, 'loopable.md', '/project');

    expect(pb.tags).toEqual(['workflow', 'loopable']);
    expect(pb.loop).toBeUndefined();
    expect(pb.loopValidationError).toBeUndefined();
    expect(pb.effectiveLoop).toEqual({
      iterationCap: 6,
      costCapUsd: 25,
      sources: {
        iterationCap: 'default',
        costCapUsd: 'default',
      },
    });
  });

  test('parses quoted inline tags and loop config', () => {
    const content = `---
name: Configured loop
tags: ["workflow", "loopable"]
loop:
  iterationCap: 9
  zeroDiffConsecutiveIterations: 3
  costCapUsd: 2.5
---

Do the durable thing.
`;

    const pb = parsePlaybook(content, 'configured.md', '/project');

    expect(pb.tags).toEqual(['workflow', 'loopable']);
    expect(pb.loop).toEqual({
      iterationCap: 9,
      zeroDiffConsecutiveIterations: 3,
      costCapUsd: 2.5,
    });
    expect(pb.effectiveLoop).toEqual({
      iterationCap: 9,
      zeroDiffConsecutiveIterations: 3,
      costCapUsd: 2.5,
      sources: {
        iterationCap: 'playbook',
        zeroDiffConsecutiveIterations: 'playbook',
        costCapUsd: 'playbook',
      },
    });
  });

  test('parses list-style tags', () => {
    const content = `---
name: List tags
tags:
  - workflow
  - loopable
---

Body.
`;

    const pb = parsePlaybook(content, 'tags.md', '/project');

    expect(pb.tags).toEqual(['workflow', 'loopable']);
    expect(pb.effectiveLoop?.iterationCap).toBe(6);
  });

  test('preserves standard launch metadata when loop config is invalid', () => {
    const content = `---
name: Bad loop
tags: [workflow, loopable]
loop:
  iterationCap: 50
---

Body.
`;

    const pb = parsePlaybook(content, 'bad-loop.md', '/project');

    expect(pb.tags).toEqual(['workflow', 'loopable']);
    expect(pb.loop).toBeUndefined();
    expect(pb.effectiveLoop).toBeUndefined();
    expect(pb.loopValidationError).toBe('loop.iterationCap must be between 1 and 20');
    expect(pb.body).toBe('Body.');
  });

  test('parses single-line stopPredicate and propagates through effectiveLoop', () => {
    const content = `---
name: Stop predicate
tags: [workflow, loopable]
loop:
  iterationCap: 8
  stopPredicate: 'test -f .batch-stop && grep -qE "^STOP:" .batch-stop'
---

Body.
`;

    const pb = parsePlaybook(content, 'predicate.md', '/project');

    expect(pb.loop?.stopPredicate).toBe('test -f .batch-stop && grep -qE "^STOP:" .batch-stop');
    expect(pb.effectiveLoop?.stopPredicate).toBe('test -f .batch-stop && grep -qE "^STOP:" .batch-stop');
    expect(pb.loopValidationError).toBeUndefined();
  });

  test('rejects empty stopPredicate', () => {
    const content = `---
name: Empty predicate
tags: [workflow, loopable]
loop:
  iterationCap: 5
  stopPredicate: ""
---

Body.
`;

    const pb = parsePlaybook(content, 'empty-predicate.md', '/project');

    expect(pb.effectiveLoop).toBeUndefined();
    expect(pb.loopValidationError).toBe('loop.stopPredicate must be a non-empty string');
  });

  test('shipped GitHub issue playbook uses grep status for duplicate branch detection', async () => {
    const playbook = await readFile('plugin/playbooks/implement-github-issue.md', 'utf8');

    expect(playbook).toContain('grep -qE "(^|[-_./])issue[-_.]${N}([-_.]|$)"');
    expect(playbook).not.toContain('| grep -E "(^|[-_./])issue[-_.]${N}([-_.]|$)" | head -1');
  });

  test('high-risk actor-verifier-distiller playbook covers required manual workflow contracts', async () => {
    const content = await readFile('.kookr/playbooks/high-risk-actor-verifier-distiller.md', 'utf8');
    const playbook = parsePlaybook(content, 'high-risk-actor-verifier-distiller.md', process.cwd());

    expect(playbook.name).toBe('High-Risk Actor-Verifier-Distiller');
    expect(playbook.checklist).toEqual([
      'Trigger criteria reviewed and mode selected only when risk justifies the extra roles',
      'Actor produced the required bounded output package',
      'Verifier completed hard-gate and advisory rubric checks',
      'Distiller produced only verified candidates and handoff notes',
      'Stop conditions checked before any persistence, PR, or follow-up action',
    ]);

    expect(playbook.body).toContain('## Trigger Criteria');
    expect(playbook.body).toContain('Actor output contract:');
    expect(playbook.body).toContain('Verifier rubric:');
    expect(playbook.body).toContain('Distiller output contract:');
    expect(playbook.body).toContain('## Stop Conditions');
  });

  test('shipped parallel issue batch playbook keeps orchestration guardrails', async () => {
    const playbook = await readFile('plugin/playbooks/parallel-issue-batch.md', 'utf8');
    const parsed = parsePlaybook(playbook, 'parallel-issue-batch.md', '/project');

    expect(parsed.name).toBe('Parallel Issue Batch');
    expect(parsed.parameters.map((p) => p.name)).toContain('repoFullName');
    expect(parsed.effectiveLoop?.stopPredicate).toContain('.batch-stop');
    expect(parsed.body).toContain('write-scope matrix');
    expect(parsed.body).toContain('No two selected **work units** may have overlapping expected files');
    expect(parsed.body).toContain('[Pasted text #N +M lines]');
    expect(parsed.body).toContain('node "$KOOKR_REPO/bin/kookr-spawn.js"');

    // Child agent picker includes Grok Build; spawn validation accepts it.
    const childAgent = parsed.parameters.find((p) => p.name === 'childAgent');
    expect(childAgent?.options?.map((o) => o.value)).toEqual([
      'default',
      'claude-code',
      'codex-cli',
      'grok-build',
    ]);
    expect(parsed.body).toContain('grok-build');

    // Multi-issue work units: one child/PR may cover several tightly related issues.
    expect(parsed.body).toContain('work unit');
    expect(parsed.body).toContain('reason_bundled');
    expect(parsed.body).toContain('Bundle related issues into multi-issue work units');
  });

  test('shipped Repository Idea Scout playbook grounds ideas in the knowledge base', async () => {
    const content = await readFile('plugin/playbooks/repository-idea-scout.md', 'utf8');
    const parsed = parsePlaybook(content, 'repository-idea-scout.md', '/project');

    expect(parsed.name).toBe('Repository Idea Scout');
    expect(parsed.dependencies).toEqual(['kb']);

    const useKb = parsed.parameters.find((p) => p.name === 'useKnowledgeBase');
    expect(useKb?.type).toBe('select');
    expect(useKb?.required).toBe(false);
    expect(useKb?.default).toBe('auto');
    expect(useKb?.options?.map((o) => o.value)).toEqual(['auto', 'off']);

    // KB grounding is best-effort augmentation. Lock the three injection
    // points — seed (Phase 3.5), refine (4.3), critique (4.4) — and the
    // per-idea report contract so a regression in any of them fails here.
    expect(parsed.body).toContain('## Knowledge Base Grounding');
    expect(parsed.body).toContain('## Phase 3.5: Domain Knowledge Survey');
    expect(parsed.body).toContain('### 4.3 Knowledge Base Refinement');
    expect(parsed.body).toContain('### 4.4 Critic Review');
    expect(parsed.body).toContain(
      'literal headings `## Classification (authority, changeShape, size, confidence, risks)`, `## Duplicate evidence table`, and `## Knowledge base grounding`',
    );
  });

  test('shipped Autonomous Evolution playbook gates typed launch parameters on valid evolution config', async () => {
    const content = await readFile('.kookr/playbooks/autonomous-evolution.md', 'utf8');
    const parsed = parsePlaybook(content, 'autonomous-evolution.md', '/project');

    expect(parsed.parameters.find((p) => p.name === 'projectCwd')).toMatchObject({
      type: 'textarea',
      default: '',
    });
    expect(parsed.parameters.find((p) => p.name === 'projectCwd')?.gatedBy).toBeUndefined();
    for (const name of ['targetScore', 'patience', 'deadlineMinutes']) {
      expect(parsed.parameters.find((p) => p.name === name)).toMatchObject({
        type: 'text',
        default: '',
        gatedBy: 'evolution-config',
      });
    }
  });

  test('playbooks reference example parses with the real parser', async () => {
    const content = await readFile('docs/reference/playbooks.md', 'utf8');
    const match = content.match(/```playbook frontmatter-reference-example\n([\s\S]*?)\n```/);

    expect(match).not.toBeNull();

    const parsed = parsePlaybook(match?.[1] ?? '', 'docs/reference/playbooks.md example', '/project');

    expect(parsed.name).toBe('Investigate GitHub Issue');
    expect(parsed.tags).toEqual(['workflow', 'loopable']);
    expect(parsed.repoTags).toEqual(['github']);
    expect(parsed.dependencies).toEqual(['kb']);
    expect(parsed.parameters.map((parameter) => parameter.name)).toEqual([
      'repoFullName',
      'issueNumber',
      'useKnowledgeBase',
    ]);
    expect(parsed.parameters[0].defaultFrom).toBe('git-remote');
    expect(parsed.parameters[0].source).toBe('tracked-projects');
    expect(parsed.parameters[2].gatedBy).toBe('kb');
    expect(parsed.checklist).toEqual([
      'Issue context summarized',
      'Implementation scope identified',
      'Risks and verification plan recorded',
    ]);
    expect(parsed.effectiveLoop).toMatchObject({
      iterationCap: 4,
      zeroDiffConsecutiveIterations: 2,
      costCapUsd: 10,
    });
    expect(parsed.effectiveLoop?.stopPredicate).toContain('.kookr-stop');
  });

  test('validates zero-diff convergence against default iteration cap', () => {
    const content = `---
name: Bad zero-diff
tags: [workflow, loopable]
loop:
  zeroDiffConsecutiveIterations: 10
---

Body.
`;

    const pb = parsePlaybook(content, 'bad-zero-diff.md', '/project');

    expect(pb.effectiveLoop).toBeUndefined();
    expect(pb.loopValidationError).toBe('loop.zeroDiffConsecutiveIterations must not exceed loop.iterationCap');
  });

  test('throws on missing frontmatter delimiter', () => {
    expect(() => parsePlaybook('no frontmatter here', 'bad.md', '/p')).toThrow(PlaybookParseError);
  });

  test('throws on missing closing frontmatter delimiter', () => {
    const content = '---\nname: Broken\nno closing delimiter';
    expect(() => parsePlaybook(content, 'bad.md', '/p')).toThrow(PlaybookParseError);
  });

  test('throws on missing name field', () => {
    const content = '---\ndescription: No name\n---\nBody';
    expect(() => parsePlaybook(content, 'bad.md', '/p')).toThrow(PlaybookParseError);
    expect(() => parsePlaybook(content, 'bad.md', '/p')).toThrow(/missing required field: name/);
  });

  test('handles quoted strings in frontmatter', () => {
    const content = `---
name: "Quoted name"
description: 'Single quoted'
---

Body.
`;
    const pb = parsePlaybook(content, 'q.md', '/p');
    expect(pb.name).toBe('Quoted name');
    expect(pb.description).toBe('Single quoted');
  });

  test('handles leading whitespace before frontmatter', () => {
    const content = `  \n---\nname: Trimmed\n---\nBody.`;
    const pb = parsePlaybook(content, 't.md', '/p');
    expect(pb.name).toBe('Trimmed');
  });

  test('handles empty body', () => {
    const content = '---\nname: Empty body\n---\n';
    const pb = parsePlaybook(content, 'e.md', '/p');
    expect(pb.name).toBe('Empty body');
    expect(pb.body).toBe('');
  });

  test('parses optional cwd field from frontmatter', () => {
    const content = `---
name: Cross-project task
description: Runs in another repo
cwd: /workspace/codex
---

Do the thing in codex.
`;
    const pb = parsePlaybook(content, 'cross.md', '/workspace/kookr');
    expect(pb.cwd).toBe('/workspace/codex');
    expect(pb.sourceCwd).toBe('/workspace/kookr');
  });

  test('cwd is undefined when not specified in frontmatter', () => {
    const pb = parsePlaybook(MINIMAL_PLAYBOOK, 'simple.md', '/project');
    expect(pb.cwd).toBeUndefined();
  });

  test('handles parameters with boolean required as string', () => {
    const content = `---
name: Bool test
parameters:
  - name: flag
    description: A flag
    required: true
---
Body.
`;
    const pb = parsePlaybook(content, 'b.md', '/p');
    expect(pb.parameters[0].required).toBe(true);
  });

  test('parses select parameter with options', () => {
    const content = `---
name: Select test
parameters:
  - name: env
    description: Target environment
    type: select
    required: true
    options:
      - label: Production
        value: prod
      - label: Staging
        value: staging
      - label: Development
        value: dev
---
Deploy to {{env}}.
`;
    const pb = parsePlaybook(content, 'select.md', '/p');
    expect(pb.parameters[0]).toEqual({
      name: 'env',
      description: 'Target environment',
      type: 'select',
      required: true,
      options: [
        { label: 'Production', value: 'prod' },
        { label: 'Staging', value: 'staging' },
        { label: 'Development', value: 'dev' },
      ],
    });
  });

  test('select options with label falling back to value', () => {
    const content = `---
name: Fallback test
parameters:
  - name: choice
    description: Pick one
    type: select
    required: true
    options:
      - value: alpha
      - value: beta
---
Body.
`;
    const pb = parsePlaybook(content, 'fb.md', '/p');
    expect(pb.parameters[0].options).toEqual([
      { label: 'alpha', value: 'alpha' },
      { label: 'beta', value: 'beta' },
    ]);
  });

  test('type field omitted defaults to no type property', () => {
    const pb = parsePlaybook(VALID_PLAYBOOK, 'create-mr.md', '/project');
    expect(pb.parameters[0].type).toBeUndefined();
    expect(pb.parameters[0].options).toBeUndefined();
  });

  test('unknown type value is not mapped', () => {
    const content = `---
name: Unknown type
parameters:
  - name: x
    description: test
    type: number
    required: false
---
Body.
`;
    const pb = parsePlaybook(content, 'u.md', '/p');
    // Only 'select' and 'textarea' are mapped; other types are ignored
    expect(pb.parameters[0].type).toBeUndefined();
  });

  test('textarea type is preserved with empty default', () => {
    const content = `---
name: Textarea param
parameters:
  - name: note
    description: "Free-text note"
    required: false
    default: ""
    type: textarea
---
Body with {{note}}.
`;
    const pb = parsePlaybook(content, 't.md', '/p');
    expect(pb.parameters[0].name).toBe('note');
    expect(pb.parameters[0].type).toBe('textarea');
    expect(pb.parameters[0].required).toBe(false);
    expect(pb.parameters[0].default).toBe('');
  });

  test('select parameter with default value', () => {
    const content = `---
name: Default select
parameters:
  - name: priority
    description: Priority level
    type: select
    required: false
    default: normal
    options:
      - label: High
        value: high
      - label: Normal
        value: normal
---
Priority is {{priority}}.
`;
    const pb = parsePlaybook(content, 'ds.md', '/p');
    expect(pb.parameters[0].type).toBe('select');
    expect(pb.parameters[0].default).toBe('normal');
    expect(pb.parameters[0].options).toHaveLength(2);
  });

  test('parses source field on select parameter', () => {
    const content = `---
name: Source test
parameters:
  - name: repoFullName
    description: Target repository
    type: select
    required: true
    source: tracked-projects
    options:
      - label: "fallback/repo"
        value: "fallback/repo"
---
Target: {{repoFullName}}.
`;
    const pb = parsePlaybook(content, 'src.md', '/p');
    expect(pb.parameters[0].source).toBe('tracked-projects');
    expect(pb.parameters[0].type).toBe('select');
    expect(pb.parameters[0].options).toHaveLength(1);
  });

  test('source field without options', () => {
    const content = `---
name: Source only
parameters:
  - name: repo
    description: Repo
    type: select
    required: true
    source: tracked-projects
---
Body.
`;
    const pb = parsePlaybook(content, 'so.md', '/p');
    expect(pb.parameters[0].source).toBe('tracked-projects');
    expect(pb.parameters[0].options).toBeUndefined();
  });

  test('source field absent leaves it undefined', () => {
    const pb = parsePlaybook(VALID_PLAYBOOK, 'create-mr.md', '/project');
    expect(pb.parameters[0].source).toBeUndefined();
  });

  test('parses git-remote default resolver on optional parameter', () => {
    const content = `---
name: Current repo
parameters:
  - name: repoFullName
    description: Target repository
    required: false
    defaultFrom: git-remote
---
Target: {{repoFullName}}.
`;
    const pb = parsePlaybook(content, 'current-repo.md', '/p');
    expect(pb.parameters[0].defaultFrom).toBe('git-remote');
  });
});

describe('interpolateParameters', () => {
  const params = [
    { name: 'version', description: '', required: true },
    { name: 'reviewer', description: '', required: false, default: '@lead' },
  ];

  test('interpolates all parameters', () => {
    const body = 'Release {{version}} reviewed by {{reviewer}}';
    const result = interpolateParameters(body, params, { version: '1.0', reviewer: '@alice' });
    expect(result).toBe('Release 1.0 reviewed by @alice');
  });

  test('applies defaults for missing optional parameters', () => {
    const body = 'Release {{version}} reviewed by {{reviewer}}';
    const result = interpolateParameters(body, params, { version: '2.0' });
    expect(result).toBe('Release 2.0 reviewed by @lead');
  });

  test('throws on missing required parameter', () => {
    const body = 'Release {{version}}';
    expect(() => interpolateParameters(body, params, {})).toThrow(PlaybookParseError);
    expect(() => interpolateParameters(body, params, {})).toThrow(/Required parameter "version"/);
  });

  test('throws on empty string for required parameter', () => {
    const body = 'Release {{version}}';
    expect(() => interpolateParameters(body, params, { version: '' })).toThrow(PlaybookParseError);
  });

  test('replaces all occurrences of a parameter', () => {
    const body = '{{version}} is {{version}}';
    const result = interpolateParameters(body, params, { version: '3.0' });
    expect(result).toBe('3.0 is 3.0');
  });

  test('leaves unrecognized placeholders untouched', () => {
    const body = 'Hello {{unknown}}';
    const result = interpolateParameters(body, [], {});
    expect(result).toBe('Hello {{unknown}}');
  });

  test('later-declared param value is not re-interpolated for earlier-declared params', () => {
    // Regression guard: declaration order determines substitution order.
    // If a later param value contains {{earlier-param}}, it must survive as a literal.
    // Relied on by the oss-contribution-pipeline playbook's extraInstruction field,
    // which is declared last so user-pasted `{{repoFullName}}` text stays inert.
    const orderedParams = [
      { name: 'repoFullName', description: '', required: true },
      { name: 'extraInstruction', description: '', required: false, default: '' },
    ];
    const body = 'Repo: {{repoFullName}}\nNote: {{extraInstruction}}';
    const result = interpolateParameters(body, orderedParams, {
      repoFullName: 'grafana/grafana',
      extraInstruction: 'also look at {{repoFullName}} issue #123',
    });
    expect(result).toBe(
      'Repo: grafana/grafana\nNote: also look at {{repoFullName}} issue #123',
    );
  });

  test('optional param with empty default substitutes empty string', () => {
    const optionalParams = [
      { name: 'note', description: '', required: false, default: '' },
    ];
    const body = 'start[{{note}}]end';
    const result = interpolateParameters(body, optionalParams, {});
    expect(result).toBe('start[]end');
  });
});
