import { describe, test, expect } from 'vitest';
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

    expect(pb.name).toBe('Simple task');
    expect(pb.description).toBe('');
    expect(pb.parameters).toEqual([]);
    expect(pb.checklist).toEqual([]);
    expect(pb.tags).toEqual([]);
    expect(pb.effectiveLoop).toBeUndefined();
    expect(pb.body).toBe('Do the thing.');
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
      costCapUsd: 5,
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
