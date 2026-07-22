import { describe, test, expect } from 'vitest';
import type { AgentEvent } from './types.js';
import {
  extractRefsFromText,
  extractRefsFromPrompt,
  extractRefsFromEvents,
  parseGitRemoteUrl,
  toGitHubReferences,
} from './github-reference-scanner.js';

describe('extractRefsFromText', () => {
  test('extracts full PR URL', () => {
    const text = 'Created PR: https://github.com/kookr-ai/kookr/pull/42';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 42,
      url: 'https://github.com/kookr-ai/kookr/pull/42',
    });
  });

  test('extracts full issue URL', () => {
    const text = 'See https://github.com/kookr-ai/kookr/issues/16';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'issue',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 16,
      url: 'https://github.com/kookr-ai/kookr/issues/16',
    });
  });

  test('extracts explicit PR #N reference', () => {
    const text = 'This fixes PR #42 and addresses the feedback';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', number: 42 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "pull request #N" reference', () => {
    const text = 'Created pull request #99';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', number: 99 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "issue #N" reference', () => {
    const text = 'Closes issue #16';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 16 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts multiple references from same text', () => {
    const text = `
Created https://github.com/kookr-ai/kookr/pull/42
This closes issue #16 and PR #10
`;
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(3);
  });

  test('deduplicates identical references', () => {
    const text = `
PR https://github.com/kookr-ai/kookr/pull/42
See https://github.com/kookr-ai/kookr/pull/42
`;
    const refs = extractRefsFromText(text);
    const pr42 = refs.filter((r) => r.type === 'pr' && r.number === 42);
    expect(pr42).toHaveLength(1);
  });

  test('extracts "issue N" without hash sign', () => {
    const text = 'Fixes issue 18 in the codebase';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 18 });
    expect(refs[0].url).toBeUndefined();
  });

  test('returns empty array for text with no references', () => {
    const refs = extractRefsFromText('Just some normal text with no GitHub refs');
    expect(refs).toHaveLength(0);
  });

  test('extracts PR URL from non-GitHub domain', () => {
    const text = 'See https://github.example.com/org/project/pull/7';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'pr',
      owner: 'org',
      repo: 'project',
      number: 7,
      url: 'https://github.example.com/org/project/pull/7',
    });
  });

  test('extracts issue URL from non-GitHub domain', () => {
    const text = 'Filed at https://git.internal.corp/team/service/issues/99';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'issue',
      owner: 'team',
      repo: 'service',
      number: 99,
      url: 'https://git.internal.corp/team/service/issues/99',
    });
  });

  test('extracts GitLab merge request URL', () => {
    const text = 'MR: https://gitlab.example.com/org/repo/-/merge_requests/15';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'pr',
      owner: 'org',
      repo: 'repo',
      number: 15,
      url: 'https://gitlab.example.com/org/repo/-/merge_requests/15',
    });
  });

  test('extracts HTTP (non-HTTPS) URL', () => {
    const text = 'http://github.local/owner/repo/pull/3';
    const refs = extractRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', owner: 'owner', repo: 'repo', number: 3, url: 'http://github.local/owner/repo/pull/3' });
  });
});

describe('extractRefsFromPrompt', () => {
  test('extracts "fix issue #18" as issue ref', () => {
    const refs = extractRefsFromPrompt('Fix issue #18');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 18 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "fix issue 18" (no hash) as issue ref', () => {
    const refs = extractRefsFromPrompt('Fix issue 18');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 18 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "resolve #18" as issue ref via action verb', () => {
    const refs = extractRefsFromPrompt('resolve #18');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 18 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "fix #42" as issue ref via action verb', () => {
    const refs = extractRefsFromPrompt('fix #42');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 42 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "start working on issue #18" as issue ref', () => {
    const refs = extractRefsFromPrompt('Start working on issue #18');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 18 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts "implement feature from issue #42" as issue ref', () => {
    const refs = extractRefsFromPrompt('Implement feature from issue #42');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 42 });
    expect(refs[0].url).toBeUndefined();
  });

  test('does NOT extract mid-prose bare #N (over-attribution fix)', () => {
    // Previously "Please look at #25 and fix it" produced an issue ref. Bare
    // #N without an action verb or issue/PR adjacency no longer creates a
    // task↔GitHub edge — prompts cite many numbers as mere context.
    const refs = extractRefsFromPrompt('Please look at #25 and fix it');
    expect(refs).toHaveLength(0);
  });

  test('does NOT extract a list of bare context refs', () => {
    const refs = extractRefsFromPrompt('Background reading: #4 #7 #12 describe earlier attempts');
    expect(refs).toHaveLength(0);
  });

  test('extracts a prompt that is ONLY "#123" as an issue ref', () => {
    const refs = extractRefsFromPrompt('#123');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 123 });
    expect(refs[0].url).toBeUndefined();
  });

  test('extracts a prompt that starts with "#123:" as an issue ref', () => {
    const refs = extractRefsFromPrompt('#123: fix the login flow');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 123 });
  });

  test('still extracts PR references from prompt', () => {
    const refs = extractRefsFromPrompt('Review PR #10 and fix issue #18');
    // Exactly 2 refs — the old bare-#N pass used to add a bogus duplicate
    // issue #10 here; that false-positive is fixed.
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.type === 'pr' && r.number === 10)).toBeDefined();
    expect(refs.find((r) => r.type === 'issue' && r.number === 18)).toBeDefined();
    expect(refs.find((r) => r.type === 'issue' && r.number === 10)).toBeUndefined();
  });

  test('still extracts full URLs from prompt', () => {
    const refs = extractRefsFromPrompt('Fix https://github.com/owner/repo/issues/5');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', number: 5, owner: 'owner', url: 'https://github.com/owner/repo/issues/5' });
  });

  test('deduplicates refs extracted from multiple patterns', () => {
    const refs = extractRefsFromPrompt('fix issue #18, resolve #18');
    const issue18 = refs.filter((r) => r.type === 'issue' && r.number === 18);
    expect(issue18).toHaveLength(1);
  });

  test('returns empty for text without references', () => {
    const refs = extractRefsFromPrompt('Just add a new feature');
    expect(refs).toHaveLength(0);
  });
});

describe('extractRefsFromEvents', () => {
  test('extracts refs from gh pr create output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh pr create --title "Fix bug" --body "Details"' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'https://github.com/kookr-ai/kookr/pull/42\n',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', owner: 'kookr-ai', repo: 'kookr', number: 42, url: 'https://github.com/kookr-ai/kookr/pull/42' });
  });

  test('extracts refs from gh issue create output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh issue create --title "Bug report"' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'https://github.com/kookr-ai/kookr/issues/16\n',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'issue', owner: 'kookr-ai', repo: 'kookr', number: 16, url: 'https://github.com/kookr-ai/kookr/issues/16' });
  });

  test('ignores PR URLs from read-only commands like git log', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'git log --oneline' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'abc1234 Merge pull request https://github.com/kookr-ai/kookr/pull/19',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('Grok run_terminal_command: extracts refs from gh pr create', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'run_terminal_command',
        toolInput: { command: 'gh pr create --title "Fix bug" --body "Details"' },
        toolUseId: 'tool-g1',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'run_terminal_command',
        toolResponse: 'https://github.com/kookr-ai/kookr/pull/42\n',
        toolUseId: 'tool-g1',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 42,
      url: 'https://github.com/kookr-ai/kookr/pull/42',
    });
  });

  test('Grok run_terminal_command: ignores read-only gh pr list', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'run_terminal_command',
        toolInput: { command: 'gh pr list -R kookr-ai/kookr --limit 5' },
        toolUseId: 'tool-g2',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'run_terminal_command',
        toolResponse: [
          '1508\tOPEN\tdeps\thttps://github.com/kookr-ai/kookr/pull/1508',
          '1507\tOPEN\tdev-deps\thttps://github.com/kookr-ai/kookr/pull/1507',
        ].join('\n'),
        toolUseId: 'tool-g2',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('ignores PR URLs from non-shell tools like read_file and grep', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'read_file',
        toolInput: { target_file: 'docs/reports/old.md' },
        toolUseId: 'tool-r1',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'read_file',
        toolResponse: 'See https://github.com/kookr-ai/kookr/pull/1 for context',
        toolUseId: 'tool-r1',
      },
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'grep',
        toolInput: { pattern: 'pull/' },
        toolUseId: 'tool-r2',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'grep',
        toolResponse: 'file.md:https://github.com/kookr-ai/kookr/pull/1508',
        toolUseId: 'tool-r2',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('ignores PR refs from read-only gh pr view output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh pr view 19 --json url' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: '{"url":"https://github.com/kookr-ai/kookr/pull/19"}',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('ignores issue refs from read-only gh issue view output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh issue view 26' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'title: feat: track GitHub issues\nstatus: open\nurl: https://github.com/kookr-ai/kookr/issues/26',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('ignores issue refs from read-only gh issue list output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh issue list --repo kookr-ai/kookr --limit 50' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: [
          '26\tOPEN\tfirst issue\thttps://github.com/kookr-ai/kookr/issues/26',
          '27\tOPEN\tsecond issue\thttps://github.com/kookr-ai/kookr/issues/27',
        ].join('\n'),
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('extracts refs from stop event lastMessage', () => {
    const events: AgentEvent[] = [
      { type: 'stop', sessionId: 's1', lastMessage: 'Created PR https://github.com/kookr-ai/kookr/pull/42' },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', number: 42, owner: 'kookr-ai', repo: 'kookr', url: 'https://github.com/kookr-ai/kookr/pull/42' });
  });

  test('extracts refs from stop event with PR #N reference', () => {
    const events: AgentEvent[] = [
      { type: 'stop', sessionId: 's1', lastMessage: 'Done! See PR #42 for the changes.' },
    ];

    const refs = extractRefsFromEvents(events, 'kookr-ai', 'kookr');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', number: 42, owner: 'kookr-ai', repo: 'kookr' });
    expect(refs[0].url).toBeUndefined();
  });

  test('ignores Bash tool_result refs without paired tool command context', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'https://github.com/kookr-ai/kookr/pull/42\n',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('fills in default owner/repo for bare refs from mutating commands', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh pr create --title "Created"' },
        toolUseId: 'tool-1',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'Created PR #42',
        toolUseId: 'tool-1',
      },
    ];

    const refs = extractRefsFromEvents(events, 'kookr-ai', 'kookr');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', number: 42, owner: 'kookr-ai', repo: 'kookr' });
    expect(refs[0].url).toBeUndefined();
  });

  test('handles object toolResponse', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh pr create --title "Created"' },
        toolUseId: 'tool-1',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: { output: 'https://github.com/owner/repo/pull/5' },
        toolUseId: 'tool-1',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', owner: 'owner', repo: 'repo', number: 5, url: 'https://github.com/owner/repo/pull/5' });
  });

  test('extracts from gh pr edit output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'gh pr edit 42 --title "Updated title"' },
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'https://github.com/owner/repo/pull/42\n',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', owner: 'owner', repo: 'repo', number: 42, url: 'https://github.com/owner/repo/pull/42' });
  });

  test('extracts only refs from mutating tool_result commands', () => {
    const events: AgentEvent[] = [
      // git log
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'git log --oneline' } },
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'abc Merge https://github.com/o/r/pull/10' },
      // gh pr list
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'gh pr list' } },
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: '#11 open https://github.com/o/r/pull/11' },
      // gh pr create
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'gh pr create --title "New"' }, toolUseId: 'tool-20' },
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'https://github.com/o/r/pull/20\n', toolUseId: 'tool-20' },
      // gh issue view
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'gh issue view 30' } },
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'https://github.com/o/r/issues/30' },
      // gh issue create
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'gh issue create --title "New"' }, toolUseId: 'tool-31' },
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'https://github.com/o/r/issues/31\n', toolUseId: 'tool-31' },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.number === 20)).toMatchObject({ type: 'pr', owner: 'o', repo: 'r', url: 'https://github.com/o/r/pull/20' });
    expect(refs.find((r) => r.number === 31)).toMatchObject({ type: 'issue', owner: 'o', repo: 'r', url: 'https://github.com/o/r/issues/31' });
  });

  test('extracts refs from mutating curl API output', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'curl -s -X POST https://api.github.com/repos/o/r/pulls' },
        toolUseId: 'tool-55',
      },
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: '{"html_url":"https://github.com/o/r/pull/55"}',
        toolUseId: 'tool-55',
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', owner: 'o', repo: 'r', number: 55, url: 'https://github.com/o/r/pull/55' });
  });

  test('deduplicates refs across tool_result and stop events', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: 'https://github.com/o/r/pull/42\n',
      },
      { type: 'stop', sessionId: 's1', lastMessage: 'Created https://github.com/o/r/pull/42' },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ type: 'pr', owner: 'o', repo: 'r', number: 42, url: 'https://github.com/o/r/pull/42' });
  });

  test('ignores session_start and other non-scannable events', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/transcript.jsonl' },
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'echo hello' } },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });

  test('skips tool_result with non-string/object response', () => {
    const events: AgentEvent[] = [
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: undefined,
      },
    ];

    const refs = extractRefsFromEvents(events);
    expect(refs).toHaveLength(0);
  });
});

describe('parseGitRemoteUrl', () => {
  test('parses SSH URL', () => {
    const result = parseGitRemoteUrl('git@github.com:kookr-ai/kookr.git');
    expect(result).toEqual({ owner: 'kookr-ai', repo: 'kookr' });
  });

  test('parses SSH URL without .git', () => {
    const result = parseGitRemoteUrl('git@github.com:kookr-ai/kookr');
    expect(result).toEqual({ owner: 'kookr-ai', repo: 'kookr' });
  });

  test('parses HTTPS URL', () => {
    const result = parseGitRemoteUrl('https://github.com/kookr-ai/kookr.git');
    expect(result).toEqual({ owner: 'kookr-ai', repo: 'kookr' });
  });

  test('parses HTTPS URL without .git', () => {
    const result = parseGitRemoteUrl('https://github.com/kookr-ai/kookr');
    expect(result).toEqual({ owner: 'kookr-ai', repo: 'kookr' });
  });

  test('returns null for non-GitHub URLs', () => {
    expect(parseGitRemoteUrl('https://gitlab.com/owner/repo.git')).toBeNull();
  });
});

describe('toGitHubReferences', () => {
  test('converts extracted refs with owner/repo to GitHubReferences', () => {
    const extracted = [
      { type: 'pr' as const, owner: 'kookr-ai', repo: 'kookr', number: 42 },
    ];

    const refs = toGitHubReferences(extracted, 'agent-1', 'task-1');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 42,
      detectedFrom: 'agent-1',
      taskId: 'task-1',
    });
    expect(refs[0].url).toBe('https://github.com/kookr-ai/kookr/pull/42');
  });

  test('filters out refs without owner/repo', () => {
    const extracted = [
      { type: 'pr' as const, number: 42 }, // no owner/repo
    ];

    const refs = toGitHubReferences(extracted, 'agent-1', 'task-1');
    expect(refs).toHaveLength(0);
  });
});
