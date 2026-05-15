import { describe, test, expect } from 'vitest';
import {
  buildActivityDisclosure,
  summarizeActivity,
  compactToolSummary,
  categorizeTool,
  classifyPasteContent,
  pasteBurstLabel,
  toolLabel,
  PASTE_BURST_MIN_LINES,
  type ActivityItem,
  type ToolGroup,
  type UserPasteBurst,
} from './activity-summary.js';
import type { AgentActivityMeta, AgentEvent } from './types.js';

function emptyMeta(overrides: Partial<AgentActivityMeta> = {}): AgentActivityMeta {
  return {
    totalEventsSeen: 0,
    parentEventCount: 0,
    childEventCount: 0,
    foreignEventCount: 0,
    unknownParentageCount: 0,
    malformedRecordCount: 0,
    droppedRecordCount: 0,
    duplicateRecordCount: 0,
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function toolUse(toolName: string, toolInput?: unknown, toolUseId?: string): AgentEvent {
  return { type: 'tool_use', sessionId: 's1', toolName, toolInput, toolUseId };
}

function toolError(toolName: string, error: string, toolInput?: unknown): AgentEvent {
  return { type: 'tool_error', sessionId: 's1', toolName, error, isInterrupt: false, toolInput };
}

function toolResult(toolName: string): AgentEvent {
  return { type: 'tool_result', sessionId: 's1', toolName };
}

function userPrompt(prompt: string): AgentEvent {
  return { type: 'user_prompt', sessionId: 's1', prompt };
}

function stop(lastMessage: string): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage };
}

function stopFailure(lastMessage: string, error: string): AgentEvent {
  return { type: 'stop_failure', sessionId: 's1', lastMessage, error };
}

function sessionStart(): AgentEvent {
  return { type: 'session_start', sessionId: 's1' };
}

function sessionEnd(reason = 'user_exit'): AgentEvent {
  return { type: 'session_end', sessionId: 's1', reason };
}

function permissionRequest(toolName: string): AgentEvent {
  return { type: 'permission_request', sessionId: 's1', toolName };
}

function notification(message: string): AgentEvent {
  return { type: 'notification', sessionId: 's1', notificationType: 'info', message };
}

// ── categorizeTool ───────────────────────────────────────────────────

describe('categorizeTool', () => {
  test('categorizes read tools', () => {
    expect(categorizeTool('Read')).toBe('read');
    expect(categorizeTool('Grep')).toBe('read');
    expect(categorizeTool('Glob')).toBe('read');
  });

  test('categorizes edit tools', () => {
    expect(categorizeTool('Edit')).toBe('edit');
    expect(categorizeTool('Write')).toBe('edit');
  });

  test('categorizes bash commands', () => {
    expect(categorizeTool('Bash', { command: 'npm test' })).toBe('bash');
  });

  test('categorizes git bash commands', () => {
    expect(categorizeTool('Bash', { command: 'git status' })).toBe('git');
    expect(categorizeTool('Bash', { command: 'gh pr create' })).toBe('git');
  });

  test('categorizes agent and search', () => {
    expect(categorizeTool('Agent')).toBe('agent');
    expect(categorizeTool('WebSearch')).toBe('search');
    expect(categorizeTool('WebFetch')).toBe('search');
  });

  test('unknown tools categorize as other', () => {
    expect(categorizeTool('UnknownTool')).toBe('other');
  });
});

// ── toolLabel ────────────────────────────────────────────────────────

describe('toolLabel', () => {
  test('extracts basename for file tools', () => {
    expect(toolLabel('Read', { file_path: '/home/user/src/foo.ts' })).toBe('Read foo.ts');
    expect(toolLabel('Edit', { file_path: '/src/bar.ts' })).toBe('Edit bar.ts');
  });

  test('truncates long bash commands', () => {
    const longCmd = 'a'.repeat(100);
    const label = toolLabel('Bash', { command: longCmd });
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toContain('...');
  });

  test('extracts pattern for Grep/Glob', () => {
    expect(toolLabel('Grep', { pattern: 'TODO' })).toBe('Grep "TODO"');
    expect(toolLabel('Glob', { pattern: '*.ts' })).toBe('Glob "*.ts"');
  });

  test('returns tool name when no input', () => {
    expect(toolLabel('Read')).toBe('Read');
    expect(toolLabel('Bash', {})).toBe('Bash');
  });
});

// ── summarizeActivity ────────────────────────────────────────────────

describe('summarizeActivity', () => {
  test('returns empty array for empty events', () => {
    expect(summarizeActivity([])).toEqual([]);
  });

  test('extracts user messages from user_prompt events', () => {
    const items = summarizeActivity([userPrompt('Fix the bug')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'user_message', text: 'Fix the bug' });
  });

  test('extracts agent messages from stop events', () => {
    const items = summarizeActivity([stop('Done fixing the bug')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'agent_message', text: 'Done fixing the bug' });
  });

  test('extracts agent messages from stop_failure events', () => {
    const items = summarizeActivity([stopFailure('Something went wrong', 'timeout')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'agent_message', text: 'Something went wrong' });
  });

  test('skips stop events with empty lastMessage', () => {
    const items = summarizeActivity([stop('')]);
    expect(items).toHaveLength(0);
  });

  test('groups consecutive tool calls between messages', () => {
    const events: AgentEvent[] = [
      userPrompt('Fix the tests'),
      toolUse('Read', { file_path: '/src/a.ts' }),
      toolUse('Read', { file_path: '/src/b.ts' }),
      toolUse('Edit', { file_path: '/src/a.ts' }),
      stop('I fixed the tests'),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(3); // user_message, tool_group, agent_message

    expect(items[0].type).toBe('user_message');
    expect(items[1].type).toBe('tool_group');
    expect(items[2].type).toBe('agent_message');

    const group = items[1] as ToolGroup;
    expect(group.totalCalls).toBe(3);
    expect(group.totalErrors).toBe(0);
    expect(group.entries).toHaveLength(3); // Read a.ts, Read b.ts, Edit a.ts
  });

  test('merges repeated identical tool calls', () => {
    const events: AgentEvent[] = [
      toolUse('Bash', { command: 'npm test' }),
      toolUse('Bash', { command: 'npm test' }),
      toolUse('Bash', { command: 'npm test' }),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);

    const group = items[0] as ToolGroup;
    expect(group.totalCalls).toBe(3);
    expect(group.entries).toHaveLength(1);
    expect(group.entries[0].count).toBe(3);
  });

  test('tracks errors in tool groups', () => {
    const events: AgentEvent[] = [
      toolUse('Bash', { command: 'npm test' }),
      toolError('Bash', 'exit code 1', { command: 'npm test' }),
      toolUse('Bash', { command: 'npm test' }),
      toolError('Bash', 'exit code 1', { command: 'npm test' }),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);

    const group = items[0] as ToolGroup;
    expect(group.totalCalls).toBe(2); // 2 tool_use + 2 error marks (not additional calls)
    expect(group.totalErrors).toBe(2);
    expect(group.entries[0].errors).toBe(2);
  });

  test('handles tool_error without prior tool_use', () => {
    const events: AgentEvent[] = [
      toolError('Bash', 'command not found'),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);

    const group = items[0] as ToolGroup;
    expect(group.totalCalls).toBe(1);
    expect(group.totalErrors).toBe(1);
  });

  test('tool_error matches correct tool_use among interleaved calls', () => {
    const events: AgentEvent[] = [
      toolUse('Read', { file_path: '/a.ts' }),
      toolUse('Bash', { command: 'npm test' }),
      toolUse('Read', { file_path: '/b.ts' }),
      toolError('Bash', 'exit code 1', { command: 'npm test' }),
    ];

    const items = summarizeActivity(events);
    const group = items[0] as ToolGroup;
    // The Bash entry should have the error, not the Read entries
    const bashEntry = group.entries.find(e => e.toolName === 'Bash');
    expect(bashEntry?.errors).toBe(1);
    const readEntries = group.entries.filter(e => e.toolName === 'Read');
    for (const re of readEntries) {
      expect(re.errors).toBe(0);
    }
  });

  test('creates system notices for session lifecycle', () => {
    const events: AgentEvent[] = [
      sessionStart(),
      userPrompt('Hello'),
      stop('Hi there'),
      sessionEnd('user_exit'),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ type: 'system_notice', subType: 'session_start', text: 'Session started' });
    expect(items[3]).toEqual({ type: 'system_notice', subType: 'session_end', text: 'Session ended: user_exit' });
  });

  test('creates system notice for permission requests', () => {
    const events: AgentEvent[] = [
      permissionRequest('Bash'),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      type: 'system_notice',
      subType: 'permission_request',
      text: 'Permission requested for Bash',
    });
  });

  test('creates system notice for notifications', () => {
    const events: AgentEvent[] = [
      notification('Build succeeded'),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      type: 'system_notice',
      subType: 'notification',
      text: 'Build succeeded',
    });
  });

  test('flushes pending tools at end of stream', () => {
    const events: AgentEvent[] = [
      toolUse('Read', { file_path: '/src/x.ts' }),
      toolUse('Read', { file_path: '/src/y.ts' }),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('tool_group');
    expect((items[0] as ToolGroup).totalCalls).toBe(2);
  });

  test('ignores input_received and subagent events', () => {
    const events: AgentEvent[] = [
      { type: 'input_received', sessionId: 's1' },
      { type: 'subagent_start', sessionId: 's1', agentId: 'sub1', agentType: 'claude-code' },
      { type: 'subagent_stop', sessionId: 's1', agentId: 'sub1', agentType: 'claude-code', lastMessage: 'done' },
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(0);
  });

  test('stores category on tool group entries', () => {
    const events: AgentEvent[] = [
      toolUse('Read', { file_path: '/src/a.ts' }),
      toolUse('Bash', { command: 'git status' }),
      toolUse('Edit', { file_path: '/src/a.ts' }),
    ];

    const items = summarizeActivity(events);
    const group = items[0] as ToolGroup;
    expect(group.entries[0].category).toBe('read');
    expect(group.entries[1].category).toBe('git');
    expect(group.entries[2].category).toBe('edit');
  });

  test('full conversation sequence', () => {
    const events: AgentEvent[] = [
      sessionStart(),
      userPrompt('Add a login page'),
      toolUse('Read', { file_path: '/src/app.tsx' }),
      toolUse('Read', { file_path: '/src/routes.ts' }),
      toolUse('Grep', { pattern: 'login' }),
      stop('I\'ve read the codebase. I\'ll create a login component.'),
      toolUse('Write', { file_path: '/src/login.tsx' }),
      toolUse('Edit', { file_path: '/src/routes.ts' }),
      toolUse('Bash', { command: 'npm test' }),
      toolError('Bash', 'exit code 1', { command: 'npm test' }),
      toolUse('Edit', { file_path: '/src/login.tsx' }),
      toolUse('Bash', { command: 'npm test' }),
      stop('Login page is ready. All tests pass.'),
    ];

    const items = summarizeActivity(events);
    expect(items.map(i => i.type)).toEqual([
      'system_notice',   // session_start
      'user_message',    // user prompt
      'tool_group',      // 3 reads
      'agent_message',   // agent response
      'tool_group',      // write + edit + test fail + edit + test pass
      'agent_message',   // final message
    ]);

    // First tool group: 3 reads
    const firstGroup = items[2] as ToolGroup;
    expect(firstGroup.totalCalls).toBe(3);
    expect(firstGroup.totalErrors).toBe(0);

    // Second tool group: write + 2 edits + 2 bash (1 error)
    const secondGroup = items[4] as ToolGroup;
    expect(secondGroup.totalCalls).toBe(5);
    expect(secondGroup.totalErrors).toBe(1);
  });

  describe('lastEditId / lastEditFilePath scoping (regression: Codex P1 on PR #335)', () => {
    test('captures lastEditId + lastEditFilePath on Edit entries', () => {
      const events: AgentEvent[] = [
        toolUse('Edit', { file_path: '/src/a/foo.ts' }, 'tu_one'),
        stop('Done.'),
      ];
      const items = summarizeActivity(events);
      const group = items[0] as ToolGroup;
      const entry = group.entries[0];
      expect(entry.category).toBe('edit');
      expect(entry.lastEditId).toBe('tu_one');
      expect(entry.lastEditFilePath).toBe('/src/a/foo.ts');
    });

    test('scopes lastEditId to its OWN group — two groups editing the same file do not cross-contaminate', () => {
      // The exact bug Codex flagged: foo.ts edited in turn 1 and again in turn 2.
      // A click on the turn-1 entry must resolve to tu_one (not tu_two).
      const events: AgentEvent[] = [
        userPrompt('edit it'),
        toolUse('Edit', { file_path: '/src/foo.ts' }, 'tu_one'),
        stop('Done.'),
        userPrompt('edit again'),
        toolUse('Edit', { file_path: '/src/foo.ts' }, 'tu_two'),
        stop('Done again.'),
      ];
      const items = summarizeActivity(events);
      const groups = items.filter((i): i is ToolGroup => i.type === 'tool_group');
      expect(groups.length).toBe(2);
      expect(groups[0].entries[0].lastEditId).toBe('tu_one');
      expect(groups[1].entries[0].lastEditId).toBe('tu_two');
    });

    test('within one group, lastEditId is the most recent event for that file', () => {
      const events: AgentEvent[] = [
        toolUse('Edit', { file_path: '/src/foo.ts' }, 'tu_first'),
        toolUse('Edit', { file_path: '/src/foo.ts' }, 'tu_second'),
        stop('Done.'),
      ];
      const items = summarizeActivity(events);
      const group = items[0] as ToolGroup;
      const entry = group.entries[0];
      expect(entry.count).toBe(2);
      expect(entry.lastEditId).toBe('tu_second');
    });

    test('non-edit tools do not populate lastEditId', () => {
      const events: AgentEvent[] = [
        toolUse('Read', { file_path: '/src/foo.ts' }, 'tu_read'),
        stop('Done.'),
      ];
      const items = summarizeActivity(events);
      const entry = (items[0] as ToolGroup).entries[0];
      expect(entry.lastEditId).toBeUndefined();
      expect(entry.lastEditFilePath).toBeUndefined();
    });

    test('Edit event without toolUseId leaves lastEditId undefined', () => {
      // Codex CLI sessions may omit toolUseId on tool_use events.
      const events: AgentEvent[] = [
        toolUse('Edit', { file_path: '/src/foo.ts' }),
        stop('Done.'),
      ];
      const entry = (summarizeActivity(events)[0] as ToolGroup).entries[0];
      expect(entry.lastEditId).toBeUndefined();
    });
  });

  test('tool_result does not add extra tool calls', () => {
    const events: AgentEvent[] = [
      toolUse('Read', { file_path: '/src/a.ts' }),
      toolResult('Read'),
      toolUse('Read', { file_path: '/src/b.ts' }),
      toolResult('Read'),
    ];

    const items = summarizeActivity(events);
    expect(items).toHaveLength(1);
    const group = items[0] as ToolGroup;
    expect(group.totalCalls).toBe(2); // Only tool_use events counted
  });
});

// ── paste-burst coalescing (issue #357) ──────────────────────────────

describe('summarizeActivity — paste-burst coalescing (issue #357)', () => {
  test('collapses a burst of pasted single-line prompts into one item', () => {
    const lines = Array.from({ length: 43 }, (_, i) => `{"event": ${i}}`);
    const items = summarizeActivity(lines.map(userPrompt));

    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('user_paste_burst');
    const burst = items[0] as UserPasteBurst;
    expect(burst.lineCount).toBe(43);
    expect(burst.lines).toEqual(lines); // raw lines retained verbatim
    expect(burst.contentKind).toBe('JSON');
  });

  test('exactly PASTE_BURST_MIN_LINES single-line prompts coalesce', () => {
    const lines = Array.from({ length: PASTE_BURST_MIN_LINES }, (_, i) => `line ${i}`);
    const items = summarizeActivity(lines.map(userPrompt));
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('user_paste_burst');
  });

  test('one prompt below the threshold stays as separate user messages', () => {
    const lines = Array.from({ length: PASTE_BURST_MIN_LINES - 1 }, (_, i) => `line ${i}`);
    const items = summarizeActivity(lines.map(userPrompt));
    expect(items).toHaveLength(PASTE_BURST_MIN_LINES - 1);
    expect(items.every((i) => i.type === 'user_message')).toBe(true);
  });

  // Literal counts pin the boundary independently of PASTE_BURST_MIN_LINES, so
  // an off-by-one in the constant and the `>=` comparison cannot drift together
  // unnoticed.
  test('a literal pair of adjacent single-line prompts is not coalesced', () => {
    const items = summarizeActivity([userPrompt('alpha'), userPrompt('beta')]);
    expect(items).toEqual([
      { type: 'user_message', text: 'alpha' },
      { type: 'user_message', text: 'beta' },
    ]);
  });

  test('a literal run of three adjacent single-line prompts coalesces', () => {
    const items = summarizeActivity([userPrompt('alpha'), userPrompt('beta'), userPrompt('gamma')]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('user_paste_burst');
    expect((items[0] as UserPasteBurst).lineCount).toBe(3);
  });

  test('a single user prompt is an ordinary user_message, not a burst', () => {
    const items = summarizeActivity([userPrompt('just one message')]);
    expect(items).toEqual([{ type: 'user_message', text: 'just one message' }]);
  });

  test('does NOT merge normal separate messages with agent turns between them', () => {
    // Three deliberate prompts, each followed by an agent reply — the agent
    // activity ends every run, so no burst can form.
    const items = summarizeActivity([
      userPrompt('add a feature'),
      stop('feature added'),
      userPrompt('now add tests'),
      stop('tests added'),
      userPrompt('now fix the lint'),
      stop('lint fixed'),
    ]);
    expect(items.filter((i) => i.type === 'user_paste_burst')).toHaveLength(0);
    expect(items.filter((i) => i.type === 'user_message')).toHaveLength(3);
    expect(items.map((i) => i.type)).toEqual([
      'user_message', 'agent_message',
      'user_message', 'agent_message',
      'user_message', 'agent_message',
    ]);
  });

  test('a deliberate multiline prompt stays one user_message and is never a burst', () => {
    const multiline = 'Please do the following:\n- step one\n- step two\n- step three';
    const items = summarizeActivity([userPrompt(multiline)]);
    expect(items).toEqual([{ type: 'user_message', text: multiline }]);
  });

  test('a multiline prompt ends a preceding burst instead of joining it', () => {
    const burstLines = ['log line 1', 'log line 2', 'log line 3'];
    const multiline = 'a real follow-up\nspanning two lines';
    const items = summarizeActivity([
      ...burstLines.map(userPrompt),
      userPrompt(multiline),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('user_paste_burst');
    expect((items[0] as UserPasteBurst).lineCount).toBe(3);
    expect(items[1]).toEqual({ type: 'user_message', text: multiline });
  });

  test('intervening tool activity splits a paste so neither half reaches the threshold', () => {
    const items = summarizeActivity([
      userPrompt('a'),
      userPrompt('b'),
      toolUse('Read', { file_path: '/x.ts' }),
      userPrompt('c'),
      userPrompt('d'),
    ]);
    expect(items.filter((i) => i.type === 'user_paste_burst')).toHaveLength(0);
    expect(items.map((i) => i.type)).toEqual([
      'user_message', 'user_message', 'tool_group', 'user_message', 'user_message',
    ]);
  });

  test('a bare low-value event between prompts ends the run', () => {
    // A capped monitor window can surface a tool_result without its preceding
    // tool_use; it must still split a paste run rather than silently merge two
    // distinct message runs across it.
    const items = summarizeActivity([
      userPrompt('a'),
      userPrompt('b'),
      toolResult('Read'),
      userPrompt('c'),
      userPrompt('d'),
    ]);
    expect(items.filter((i) => i.type === 'user_paste_burst')).toHaveLength(0);
    expect(items.filter((i) => i.type === 'user_message')).toHaveLength(4);
  });

  test('a burst keeps chronological order ahead of the agent response', () => {
    const items = summarizeActivity([
      ...['x1', 'x2', 'x3', 'x4'].map(userPrompt),
      stop('handled the pasted content'),
    ]);
    expect(items.map((i) => i.type)).toEqual(['user_paste_burst', 'agent_message']);
  });

  test('two bursts separated by an agent turn each coalesce independently', () => {
    const items = summarizeActivity([
      ...['p1', 'p2', 'p3'].map(userPrompt),
      stop('first reply'),
      ...['q1', 'q2', 'q3'].map(userPrompt),
    ]);
    expect(items.map((i) => i.type)).toEqual([
      'user_paste_burst', 'agent_message', 'user_paste_burst',
    ]);
  });
});

describe('classifyPasteContent (issue #357)', () => {
  test('detects a pretty-printed JSON blob', () => {
    expect(classifyPasteContent(['{', '  "a": 1,', '  "b": 2', '}'])).toBe('JSON');
  });

  test('detects per-line JSON (NDJSON)', () => {
    expect(classifyPasteContent(['{"a":1}', '{"a":2}', '{"a":3}'])).toBe('JSON');
  });

  test('detects log lines by timestamp/level shape', () => {
    expect(classifyPasteContent([
      '2026-05-15T15:01:50Z INFO server started',
      '2026-05-15T15:01:51Z ERROR connection refused',
      '2026-05-15T15:01:52Z WARN retrying',
    ])).toBe('log');
  });

  test('falls back to text for ordinary prose', () => {
    expect(classifyPasteContent(['hello there', 'this is fine', 'nothing special here'])).toBe('text');
  });

  test('empty content classifies as text', () => {
    expect(classifyPasteContent(['', '   ', ''])).toBe('text');
  });
});

describe('pasteBurstLabel (issue #357)', () => {
  function burst(overrides: Partial<UserPasteBurst>): UserPasteBurst {
    return { type: 'user_paste_burst', lineCount: 1, lines: [], contentKind: 'text', ...overrides };
  }

  test('labels JSON content', () => {
    expect(pasteBurstLabel(burst({ lineCount: 43, contentKind: 'JSON' })))
      .toBe('Pasted 43 lines of JSON content');
  });

  test('labels log content', () => {
    expect(pasteBurstLabel(burst({ lineCount: 12, contentKind: 'log' })))
      .toBe('Pasted 12 lines of log content');
  });

  test('omits the content kind for plain text', () => {
    expect(pasteBurstLabel(burst({ lineCount: 5, contentKind: 'text' })))
      .toBe('Pasted 5 lines');
  });

  test('uses the singular noun for a one-line burst', () => {
    expect(pasteBurstLabel(burst({ lineCount: 1, contentKind: 'JSON' })))
      .toBe('Pasted 1 line of JSON content');
  });
});

// ── compactToolSummary ───────────────────────────────────────────────

describe('compactToolSummary', () => {
  test('summarizes reads', () => {
    const group: ToolGroup = {
      type: 'tool_group',
      entries: [
        { toolName: 'Read', category: 'read', count: 5, errors: 0 },
      ],
      totalCalls: 5,
      totalErrors: 0,
    };
    expect(compactToolSummary(group)).toBe('read 5 files');
  });

  test('summarizes mixed operations', () => {
    const group: ToolGroup = {
      type: 'tool_group',
      entries: [
        { toolName: 'Read', category: 'read', count: 3, errors: 0 },
        { toolName: 'Edit', category: 'edit', count: 2, errors: 0 },
        { toolName: 'Bash', category: 'bash', count: 1, errors: 1 },
      ],
      totalCalls: 6,
      totalErrors: 1,
    };
    expect(compactToolSummary(group)).toBe('read 3 files, edited 2 files, ran 1 command, 1 failure');
  });

  test('singular forms for count of 1', () => {
    const group: ToolGroup = {
      type: 'tool_group',
      entries: [
        { toolName: 'Read', category: 'read', count: 1, errors: 0 },
        { toolName: 'Edit', category: 'edit', count: 1, errors: 0 },
      ],
      totalCalls: 2,
      totalErrors: 0,
    };
    expect(compactToolSummary(group)).toBe('read 1 file, edited 1 file');
  });

  test('includes git operations via category', () => {
    const group: ToolGroup = {
      type: 'tool_group',
      entries: [
        { toolName: 'Bash', category: 'git', count: 2, errors: 0 },
      ],
      totalCalls: 2,
      totalErrors: 0,
    };
    expect(compactToolSummary(group)).toBe('2 git ops');
  });

  test('handles empty group', () => {
    const group: ToolGroup = {
      type: 'tool_group',
      entries: [],
      totalCalls: 0,
      totalErrors: 0,
    };
    expect(compactToolSummary(group)).toBe('');
  });

  test('end-to-end: git commands categorized through summarizeActivity', () => {
    const events: AgentEvent[] = [
      toolUse('Bash', { command: 'git status' }),
      toolUse('Bash', { command: 'git diff' }),
      toolUse('Bash', { command: 'npm test' }),
    ];

    const items = summarizeActivity(events);
    const group = items[0] as ToolGroup;
    expect(compactToolSummary(group)).toBe('ran 1 command, 2 git ops');
  });
});

describe('buildActivityDisclosure (rfc-activity-log-reliability §4)', () => {
  test('returns null when no metadata is available', () => {
    expect(buildActivityDisclosure(10, undefined)).toBeNull();
  });

  test('returns null when everything is in sync and nothing to disclose', () => {
    expect(buildActivityDisclosure(10, emptyMeta({ totalEventsSeen: 10, parentEventCount: 10 }))).toBeNull();
  });

  test('emits partialWindow when total seen exceeds events shown', () => {
    const d = buildActivityDisclosure(50, emptyMeta({ totalEventsSeen: 75, parentEventCount: 75 }));
    expect(d?.partialWindow).toEqual({ eventsShown: 50, totalEventsSeen: 75 });
  });

  test('does not emit partialWindow when events shown matches total seen', () => {
    const d = buildActivityDisclosure(75, emptyMeta({ totalEventsSeen: 75, parentEventCount: 75 }));
    expect(d?.partialWindow).toBeUndefined();
  });

  test('emits childActivity when childEventCount > 0', () => {
    const d = buildActivityDisclosure(50, emptyMeta({
      totalEventsSeen: 70, parentEventCount: 50, childEventCount: 20,
    }));
    expect(d?.childActivity).toEqual({ eventCount: 20, foreignCount: 0 });
  });

  test('emits malformed when malformed or dropped count > 0', () => {
    const d = buildActivityDisclosure(10, emptyMeta({
      totalEventsSeen: 12, malformedRecordCount: 2, droppedRecordCount: 1,
    }));
    expect(d?.malformed).toEqual({ malformedCount: 2, droppedCount: 1 });
  });

  test('can emit all three disclosures together', () => {
    const d = buildActivityDisclosure(50, emptyMeta({
      totalEventsSeen: 100, parentEventCount: 60, childEventCount: 30,
      malformedRecordCount: 4, foreignEventCount: 2,
    }));
    expect(d?.partialWindow).toBeDefined();
    expect(d?.childActivity).toEqual({ eventCount: 30, foreignCount: 2 });
    expect(d?.malformed).toEqual({ malformedCount: 4, droppedCount: 0 });
  });
});
