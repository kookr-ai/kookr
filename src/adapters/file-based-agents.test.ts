import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFileBasedAgents, parseAgentText, __setWarnSinkForTests } from './file-based-agents.js';

describe('parseAgentText', () => {
  test('parses standard frontmatter + body', () => {
    const text = `---
name: my-agent
description: Does the thing
model: opus
---

# Body header

Body paragraph.`;
    const parsed = parseAgentText(text);
    expect(parsed).toEqual({
      name: 'my-agent',
      def: {
        description: 'Does the thing',
        model: 'opus',
        prompt: '# Body header\n\nBody paragraph.',
      },
    });
  });

  test('returns null when frontmatter is missing', () => {
    expect(parseAgentText('No frontmatter here.')).toBeNull();
  });

  test('returns null when frontmatter has no name field', () => {
    const text = `---
description: Anonymous
---

body`;
    expect(parseAgentText(text)).toBeNull();
  });

  test('omits model field when absent', () => {
    const text = `---
name: thin-agent
description: minimal
---

body`;
    const parsed = parseAgentText(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.def.model).toBeUndefined();
  });

  test('strips surrounding quotes from frontmatter values', () => {
    const text = `---
name: "quoted-name"
description: 'single-quoted'
---

body`;
    const parsed = parseAgentText(text);
    expect(parsed!.name).toBe('quoted-name');
    expect(parsed!.def.description).toBe('single-quoted');
  });

  test('parses YAML literal block scalar (description: |) with indented body', () => {
    // Real agents (e.g. ~/.claude/agents/kb-scout.md) use this shape. Naive
    // line-by-line `key: value` parsing produces description = "|" and drops
    // the indented continuation. The block-scalar branch must dedent and
    // join with newlines.
    const text = `---
name: kb-scout
description: |
  First paragraph.
  Second line of first paragraph.

  Second paragraph.
model: haiku
---

body`;
    const parsed = parseAgentText(text);
    expect(parsed!.name).toBe('kb-scout');
    expect(parsed!.def.model).toBe('haiku');
    expect(parsed!.def.description).toBe(
      'First paragraph.\nSecond line of first paragraph.\n\nSecond paragraph.',
    );
  });

  test('parses YAML folded block scalar (description: >) into a single line', () => {
    const text = `---
name: folded-agent
description: >
  This is one logical
  paragraph that the folded
  scalar joins with spaces.
---

body`;
    const parsed = parseAgentText(text);
    expect(parsed!.def.description).toBe(
      'This is one logical paragraph that the folded scalar joins with spaces.',
    );
  });

  test('skips list-shaped values without breaking subsequent key parsing', () => {
    // Real agents declare `tools:\n  - Bash\n  - Read`. The parser does not
    // expose `tools` to the inline-agent contract, but it must NOT let those
    // indented `- ...` lines bleed into the next field.
    const text = `---
name: with-tools
description: ok
tools:
  - Bash
  - Read
model: haiku
---

body`;
    const parsed = parseAgentText(text);
    expect(parsed!.name).toBe('with-tools');
    expect(parsed!.def.description).toBe('ok');
    // The key MUST be visible after the indented list — regression of the
    // continuation-line skipper would drop `model`.
    expect(parsed!.def.model).toBe('haiku');
  });

  test('block-scalar prompt body with shell-special characters round-trips through JSON', () => {
    // Verifies that nothing in the parser attempts shell-style escaping.
    // The body is preserved byte-for-byte (mod trailing whitespace) so the
    // `--agents <json>` argv element survives backticks, quotes, newlines.
    const tricky = '`backticks` "double" \'single\' $VAR\n# heading\n```bash\necho hi\n```';
    const text = `---
name: tricky
description: tricky body
---

${tricky}`;
    const parsed = parseAgentText(text);
    expect(parsed!.def.prompt).toBe(tricky);
    // Round-trip through JSON.stringify/JSON.parse — what the adapter does.
    const round = JSON.parse(JSON.stringify({ x: parsed!.def })).x;
    expect(round.prompt).toBe(tricky);
  });
});

describe('loadFileBasedAgents', () => {
  let tempRoot: string;
  let userDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kookr-agents-loader-'));
    userDir = join(tempRoot, 'user-agents');
    projectDir = join(tempRoot, 'project-agents');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('loads user-scope agents', () => {
    writeFileSync(
      join(userDir, 'kb-scout.md'),
      `---
name: kb-scout
description: User-scope agent
---

User-scope body.`,
      'utf-8',
    );
    const agents = loadFileBasedAgents('/unused', { userAgentsDir: userDir, projectAgentsDir: projectDir });
    expect(agents['kb-scout']).toBeDefined();
    expect(agents['kb-scout'].description).toBe('User-scope agent');
  });

  test('loads project-scope agents', () => {
    writeFileSync(
      join(projectDir, 'fixture-project-agent.md'),
      `---
name: fixture-project-agent
description: Project-scope agent
model: opus
---

Project body.`,
      'utf-8',
    );
    const agents = loadFileBasedAgents('/unused', { userAgentsDir: userDir, projectAgentsDir: projectDir });
    expect(agents['fixture-project-agent']).toEqual({
      description: 'Project-scope agent',
      model: 'opus',
      prompt: 'Project body.',
    });
  });

  test('project-scope wins on name collision', () => {
    // Same agent name in both scopes — Claude Code natively gives project
    // precedence; the loader must mirror that so behavior under bypass mode
    // matches behavior outside bypass mode.
    writeFileSync(
      join(userDir, 'shared.md'),
      `---
name: shared
description: from user
---

USER`,
      'utf-8',
    );
    writeFileSync(
      join(projectDir, 'shared.md'),
      `---
name: shared
description: from project
---

PROJECT`,
      'utf-8',
    );
    const agents = loadFileBasedAgents('/unused', { userAgentsDir: userDir, projectAgentsDir: projectDir });
    expect(agents['shared'].description).toBe('from project');
    expect(agents['shared'].prompt).toBe('PROJECT');
  });

  test('skips files without frontmatter without crashing the load', () => {
    writeFileSync(join(userDir, 'malformed.md'), 'No frontmatter at all.', 'utf-8');
    writeFileSync(
      join(userDir, 'good.md'),
      `---
name: good
description: ok
---

ok`,
      'utf-8',
    );
    // Explicit fail-open assertion — a future change that throws on malformed
    // frontmatter would fail launch, not just silently drop one agent.
    const warnings: string[] = [];
    __setWarnSinkForTests((msg) => warnings.push(msg));
    let agents: Record<string, unknown> = {};
    expect(() => {
      agents = loadFileBasedAgents('/unused', {
        userAgentsDir: userDir,
        projectAgentsDir: projectDir,
      });
    }).not.toThrow();
    __setWarnSinkForTests((msg) => console.warn(msg));
    expect(Object.keys(agents)).toEqual(['good']);
    // The malformed file emits a warning so a user whose agent silently
    // disappeared can find the trail in the spawned session's stderr.
    expect(warnings.some((w) => w.includes('malformed.md'))).toBe(true);
  });

  test('survives file-read errors (e.g. unreadable agent file)', () => {
    // Permission-denied is the realistic case — the loader must not crash
    // launch and must skip the unreadable file.
    const restricted = join(userDir, 'restricted.md');
    writeFileSync(restricted, '---\nname: restricted\n---\n\nbody', 'utf-8');
    chmodSync(restricted, 0o000);
    try {
      const agents = loadFileBasedAgents('/unused', {
        userAgentsDir: userDir,
        projectAgentsDir: projectDir,
      });
      // We don't strictly require the absence of the entry (root may bypass
      // the chmod on some systems), but we DO require no throw.
      expect(typeof agents).toBe('object');
    } finally {
      chmodSync(restricted, 0o644);
    }
  });

  test('returns empty object when both directories are missing', () => {
    const agents = loadFileBasedAgents('/unused', {
      userAgentsDir: join(tempRoot, 'does-not-exist-1'),
      projectAgentsDir: join(tempRoot, 'does-not-exist-2'),
    });
    expect(agents).toEqual({});
  });

  test('ignores non-.md files in the agents directory', () => {
    writeFileSync(join(userDir, 'README.txt'), 'not an agent', 'utf-8');
    writeFileSync(join(userDir, '.hidden.md'), 'malformed', 'utf-8');
    writeFileSync(
      join(userDir, 'real.md'),
      `---
name: real
description: ok
---

body`,
      'utf-8',
    );
    const agents = loadFileBasedAgents('/unused', { userAgentsDir: userDir, projectAgentsDir: projectDir });
    expect(Object.keys(agents).sort()).toEqual(['real']);
  });
});
