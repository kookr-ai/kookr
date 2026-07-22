import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../core/types.js';
import {
  projectEventForClient,
  projectAgentFieldsForClient,
  projectCompletionDigestForClient,
  projectDescriptionForClient,
  TOOL_INPUT_MAX_BYTES,
  LAST_MESSAGE_MAX_BYTES,
  DESCRIPTION_MAX_BYTES,
  COMPLETION_DIGEST_MAX_FILES,
  DESCRIPTOR_KEYS,
} from './event-projection.js';

describe('DESCRIPTOR_KEYS coupling invariants', () => {
  it('contains file_path — load-bearing for activity-panel diff-click walk', () => {
    // See docs/rfc/rfc-activity-panel-ux.md §4 and the comment in
    // event-projection.ts. Removing file_path silently breaks diff click targets.
    expect(DESCRIPTOR_KEYS).toContain('file_path');
  });
});

describe('projectEventForClient — toolResponse omission', () => {
  it('omits toolResponse on tool_result with text response', () => {
    const event: AgentEvent = {
      type: 'tool_result',
      sessionId: 's1',
      toolName: 'Read',
      toolResponse: 'x'.repeat(10_000),
    };
    const projected = projectEventForClient(event);
    expect(projected.type).toBe('tool_result');
    expect('toolResponse' in projected).toBe(false);
  });

  it('omits toolResponse on tool_result with image (base64) response', () => {
    const event: AgentEvent = {
      type: 'tool_result',
      sessionId: 's1',
      toolName: 'Read',
      toolResponse: { type: 'image', file: { base64: 'AAAA'.repeat(10_000) } },
    };
    const projected = projectEventForClient(event);
    expect('toolResponse' in projected).toBe(false);
  });

  it('omits toolResponse on tool_result with structured response', () => {
    const event: AgentEvent = {
      type: 'tool_result',
      sessionId: 's1',
      toolName: 'Bash',
      toolResponse: { stdout: 'a'.repeat(5000), stderr: '', exit_code: 0 },
    };
    const projected = projectEventForClient(event);
    expect('toolResponse' in projected).toBe(false);
  });

  it('preserves other fields on tool_result', () => {
    const event: AgentEvent = {
      type: 'tool_result',
      sessionId: 's1',
      toolName: 'Read',
      toolUseId: 'tu_123',
      cwd: '/tmp',
      toolResponse: 'big',
    };
    const projected = projectEventForClient(event);
    expect(projected).toMatchObject({
      type: 'tool_result',
      sessionId: 's1',
      toolName: 'Read',
      toolUseId: 'tu_123',
      cwd: '/tmp',
    });
  });
});

describe('projectEventForClient — toolInput truncation', () => {
  it('small toolInput passes through unchanged', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Read',
      toolInput: { file_path: '/a/b/c.ts' },
    };
    const projected = projectEventForClient(event);
    expect(projected).toEqual(event);
  });

  it('redacts generic secrets in small client-facing toolInput values', () => {
    const secret = 'super-secret';
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Bash',
      toolInput: {
        command: `curl -H "Authorization: token=${secret}" https://api.github.com`,
        nested: { url: `https://example.com/callback?password=${secret}` },
      },
    };

    const projected = projectEventForClient(event) as typeof event;
    expect(JSON.stringify(projected.toolInput)).not.toContain(secret);
    expect((projected.toolInput as Record<string, unknown>).command).toContain('[REDACTED]');
    expect(((projected.toolInput as Record<string, unknown>).nested as Record<string, unknown>).url).toContain('[REDACTED]');
  });

  it('redacts generic secrets in structured credential fields', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'CustomTool',
      toolInput: {
        token: 'abc123',
        nested: { password: 'super-secret', client_secret: 'oauth-secret' },
        command: 'echo ok',
      },
    };

    const projected = projectEventForClient(event) as typeof event;
    expect(projected.toolInput).toEqual({
      token: '[REDACTED]',
      nested: { password: '[REDACTED]', client_secret: '[REDACTED]' },
      command: 'echo ok',
    });
  });

  it.each([
    [
      'tool_use',
      {
        type: 'tool_use',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'echo token=abc123' },
      } satisfies AgentEvent,
    ],
    [
      'tool_error',
      {
        type: 'tool_error',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'echo token=abc123' },
        error: 'boom',
        isInterrupt: false,
      } satisfies AgentEvent,
    ],
    [
      'permission_request',
      {
        type: 'permission_request',
        sessionId: 's1',
        toolName: 'Bash',
        toolInput: { command: 'echo token=abc123' },
      } satisfies AgentEvent,
    ],
  ])('redacts generic secrets in %s toolInput dispatch', (_label, event) => {
    const projected = projectEventForClient(event) as typeof event;
    expect(JSON.stringify(projected.toolInput)).not.toContain('abc123');
    expect((projected.toolInput as Record<string, unknown>).command).toBe('echo [REDACTED]');
  });

  it('large toolInput preserves descriptor keys and truncates the rest', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Write',
      toolInput: {
        file_path: '/README.md',
        content: 'x'.repeat(TOOL_INPUT_MAX_BYTES * 2),
      },
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(ti.file_path).toBe('/README.md');
    expect(ti.content).toBeUndefined();
    expect(ti._truncated).toMatch(/<\d+ bytes elided>/);
  });

  it('redacts preserved descriptor values in oversized toolInput', () => {
    const secret = 'sk-abcdefghijklmnop1234';
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Bash',
      toolInput: {
        command: `deploy --token=${secret}`,
        url: `https://example.com/deploy?api_key=${secret}`,
        extra_bulk: 'y'.repeat(TOOL_INPUT_MAX_BYTES * 2),
      },
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(JSON.stringify(ti)).not.toContain(secret);
    expect(ti.command).toContain('[REDACTED]');
    expect(ti.url).toContain('[REDACTED]');
    expect(ti._truncated).toMatch(/<\d+ bytes elided>/);
  });

  it('preserves all DESCRIPTOR_KEYS when present on oversized input', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'CustomTool',
      toolInput: {
        file_path: '/a',
        command: 'go',
        pattern: 'foo',
        url: 'https://example.com',
        prompt: 'go do a thing',
        extra_bulk: 'y'.repeat(TOOL_INPUT_MAX_BYTES * 2),
      },
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    for (const key of DESCRIPTOR_KEYS) {
      expect(ti[key]).toBeDefined();
    }
    expect(ti.extra_bulk).toBeUndefined();
  });

  it('redacts Claude subagent prompts from client-facing tool_use events', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Agent',
      toolInput: {
        description: 'Correctness review',
        subagent_type: 'general-purpose',
        prompt: 'Full reviewer prompt that should not appear in the activity panel.',
      },
    };

    const projected = projectEventForClient(event) as typeof event;
    expect(projected).not.toBe(event);
    expect((event.toolInput as Record<string, unknown>).prompt).toBe(
      'Full reviewer prompt that should not appear in the activity panel.',
    );
    expect(projected.toolInput).toEqual({
      description: 'Correctness review',
      subagent_type: 'general-purpose',
    });
  });

  it('redacts Codex subagent instructions from client-facing tool_use events', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'spawn_agent',
      toolInput: {
        task_name: 'review_correctness',
        instructions: 'Full specialist instructions that should not appear in the activity panel.',
      },
    };

    const projected = projectEventForClient(event) as typeof event;
    expect(projected).not.toBe(event);
    expect((event.toolInput as Record<string, unknown>).instructions).toBe(
      'Full specialist instructions that should not appear in the activity panel.',
    );
    expect(projected.toolInput).toEqual({
      task_name: 'review_correctness',
    });
  });

  it('redacts Claude Task prompts from client-facing tool_use events', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Task',
      toolInput: {
        description: 'Research branch state',
        prompt: 'Full Task prompt that should not appear in the activity panel.',
      },
    };

    const projected = projectEventForClient(event) as typeof event;
    expect(projected.toolInput).toEqual({
      description: 'Research branch state',
    });
    expect((event.toolInput as Record<string, unknown>).prompt).toBe(
      'Full Task prompt that should not appear in the activity panel.',
    );
  });

  it('applies truncation on tool_error', () => {
    const event: AgentEvent = {
      type: 'tool_error',
      sessionId: 's1',
      toolName: 'Bash',
      toolInput: { command: 'echo', extra: 'z'.repeat(TOOL_INPUT_MAX_BYTES * 2) },
      error: 'boom',
      isInterrupt: false,
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(ti.command).toBe('echo');
    expect(ti.extra).toBeUndefined();
  });

  it('applies truncation on permission_request', () => {
    const event: AgentEvent = {
      type: 'permission_request',
      sessionId: 's1',
      toolName: 'Write',
      toolInput: { file_path: '/x', content: 'q'.repeat(TOOL_INPUT_MAX_BYTES * 2) },
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(ti.file_path).toBe('/x');
    expect(ti.content).toBeUndefined();
  });

  it('undefined toolInput passes through untouched', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'TaskList',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('exactly-at-cap toolInput passes through unchanged', () => {
    // Build an input whose JSON-stringified length equals the cap exactly.
    const paddingLen = TOOL_INPUT_MAX_BYTES - JSON.stringify({ command: '', file_path: '' }).length;
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'Bash',
      toolInput: { command: 'x'.repeat(paddingLen), file_path: '' },
    };
    expect(JSON.stringify(event.toolInput).length).toBe(TOOL_INPUT_MAX_BYTES);
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('primitive string toolInput preserves a prefix with _preview + _truncated', () => {
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'CustomTool',
      toolInput: 'q'.repeat(TOOL_INPUT_MAX_BYTES * 2),
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(typeof ti._preview).toBe('string');
    expect((ti._preview as string).length).toBeLessThanOrEqual(200);
    expect((ti._preview as string).startsWith('q')).toBe(true);
    expect(ti._truncated).toMatch(/<\d+ bytes elided>/);
  });

  it('redacts primitive string toolInput previews before client projection', () => {
    const secret = 'npm_0123456789abcdefghij';
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'CustomTool',
      toolInput: `publish --token=${secret} ${'q'.repeat(TOOL_INPUT_MAX_BYTES * 2)}`,
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(ti._preview).toContain('[REDACTED]');
    expect(JSON.stringify(ti)).not.toContain(secret);
    expect(ti._truncated).toMatch(/<\d+ bytes elided>/);
  });

  it('array toolInput preserves a prefix instead of silently dropping all content', () => {
    const arr = Array.from({ length: 1000 }, (_, i) => ({ idx: i, data: 'z'.repeat(20) }));
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'BatchTool',
      toolInput: arr,
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    expect(typeof ti._preview).toBe('string');
    expect(ti._truncated).toMatch(/<\d+ bytes elided>/);
    // Confirm descriptor path is not accidentally applied to arrays
    expect(ti.file_path).toBeUndefined();
  });

  it('oversized descriptor value (tool prompt) is capped per-value, not preserved verbatim', () => {
    const hugePrompt = 'P'.repeat(TOOL_INPUT_MAX_BYTES * 3);
    const event: AgentEvent = {
      type: 'tool_use',
      sessionId: 's1',
      toolName: 'CustomTool',
      toolInput: { prompt: hugePrompt, file_path: '/a', extra: 'b'.repeat(TOOL_INPUT_MAX_BYTES) },
    };
    const projected = projectEventForClient(event) as typeof event;
    const ti = projected.toolInput as Record<string, unknown>;
    // Descriptor value was capped, not dropped
    expect(typeof ti.prompt).toBe('string');
    expect((ti.prompt as string).length).toBeLessThan(hugePrompt.length);
    expect((ti.prompt as string).endsWith('…')).toBe(true);
    expect(ti.file_path).toBe('/a');
    // Whole projected toolInput fits roughly within budget even when the descriptor was huge
    expect(JSON.stringify(ti).length).toBeLessThan(TOOL_INPUT_MAX_BYTES);
  });
});

describe('projectEventForClient — lastMessage truncation', () => {
  it('short lastMessage passes through unchanged', () => {
    const event: AgentEvent = {
      type: 'stop',
      sessionId: 's1',
      lastMessage: 'Done.',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('redacts generic secrets in short lastMessage events', () => {
    const event: AgentEvent = {
      type: 'stop',
      sessionId: 's1',
      lastMessage: 'Done. token=abc123.',
    };
    const projected = projectEventForClient(event) as typeof event;
    expect(projected.lastMessage).toBe('Done. [REDACTED]');
  });

  it('long lastMessage is truncated to below cap with marker suffix', () => {
    const event: AgentEvent = {
      type: 'subagent_stop',
      sessionId: 's1',
      agentId: 'sub-1',
      agentType: 'Agent',
      lastMessage: 'A'.repeat(LAST_MESSAGE_MAX_BYTES * 3),
    };
    const projected = projectEventForClient(event) as typeof event;
    expect(projected.lastMessage.length).toBeLessThan(event.lastMessage.length);
    expect(projected.lastMessage).toMatch(/…<\d+ bytes elided>$/);
  });

  it('redacts generic secrets before truncating long lastMessage events', () => {
    const event: AgentEvent = {
      type: 'stop',
      sessionId: 's1',
      lastMessage: `token=abc123 ${'A'.repeat(LAST_MESSAGE_MAX_BYTES * 3)}`,
    };
    const projected = projectEventForClient(event) as typeof event;
    expect(projected.lastMessage).toContain('[REDACTED]');
    expect(projected.lastMessage).not.toContain('abc123');
    expect(projected.lastMessage).toMatch(/…<\d+ bytes elided>$/);
  });

  it('UTF-8 multibyte boundary is not split (forces walk-back)', () => {
    // 'あ' is 3 bytes in UTF-8. 4096 % 3 = 1, so the cap lands *inside* a
    // codepoint — the walk-back loop must fire for this test to pass, making
    // it a real guard against regressing the continuation-byte check.
    const char = 'あ';
    expect(Buffer.byteLength(char, 'utf-8')).toBe(3);
    const body = char.repeat(Math.ceil(LAST_MESSAGE_MAX_BYTES / 3) + 10);
    const event: AgentEvent = {
      type: 'stop',
      sessionId: 's1',
      lastMessage: body,
    };
    const projected = projectEventForClient(event) as typeof event;
    const stripped = projected.lastMessage.replace(/…<\d+ bytes elided>$/, '');
    // Every codepoint is 3 bytes, so valid UTF-8 output must have a byte length
    // divisible by 3.
    expect(Buffer.byteLength(stripped, 'utf-8') % 3).toBe(0);
    // U+FFFD replacement character would appear if a multibyte sequence was
    // broken and the result round-tripped through Buffer.toString('utf-8').
    expect(stripped).not.toContain('�');
  });

  it('exactly-at-cap lastMessage passes through unchanged', () => {
    const body = 'A'.repeat(LAST_MESSAGE_MAX_BYTES);
    const event: AgentEvent = {
      type: 'stop',
      sessionId: 's1',
      lastMessage: body,
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('empty lastMessage passes through unchanged', () => {
    const event: AgentEvent = {
      type: 'stop',
      sessionId: 's1',
      lastMessage: '',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('applies to stop_failure', () => {
    const event: AgentEvent = {
      type: 'stop_failure',
      sessionId: 's1',
      error: 'oh no',
      lastMessage: 'B'.repeat(LAST_MESSAGE_MAX_BYTES * 2),
    };
    const projected = projectEventForClient(event) as typeof event;
    expect(projected.lastMessage.length).toBeLessThan(event.lastMessage.length);
    expect(projected.lastMessage).toMatch(/…<\d+ bytes elided>$/);
  });
});

describe('projectEventForClient — passthrough events', () => {
  it('session_start is unchanged', () => {
    const event: AgentEvent = {
      type: 'session_start',
      sessionId: 's1',
      model: 'opus',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('user_prompt is unchanged', () => {
    const event: AgentEvent = {
      type: 'user_prompt',
      sessionId: 's1',
      prompt: 'hi',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('notification is unchanged', () => {
    const event: AgentEvent = {
      type: 'notification',
      sessionId: 's1',
      notificationType: 'info',
      message: 'hello',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });

  it('input_received is unchanged', () => {
    const event: AgentEvent = {
      type: 'input_received',
      sessionId: 's1',
    };
    expect(projectEventForClient(event)).toEqual(event);
  });
});

describe('projectAgentFieldsForClient — description and completionDigest caps', () => {
  it('short description and compact digest pass through by identity', () => {
    const agent = {
      agentId: 'a-1',
      description: 'short prompt',
      completionDigest: {
        bullets: ['Did the thing'],
        filesChanged: ['src/a.ts'],
      },
    };
    expect(projectAgentFieldsForClient(agent)).toBe(agent);
  });

  it('truncates huge descriptions used as full task prompts', () => {
    const description = 'P'.repeat(DESCRIPTION_MAX_BYTES * 4);
    const projected = projectDescriptionForClient(description)!;
    expect(Buffer.byteLength(projected, 'utf-8')).toBeLessThan(Buffer.byteLength(description, 'utf-8'));
    expect(projected).toMatch(/…<\d+ bytes elided>$/);
  });

  it('caps huge filesChanged lists that dominate real prod snapshots', () => {
    const digest = {
      bullets: ['Changed 5000 files: …'],
      filesChanged: Array.from({ length: 5000 }, (_, i) => `file-${i}.ts`),
    };
    const projected = projectCompletionDigestForClient(digest);
    expect(projected.filesChanged.length).toBe(COMPLETION_DIGEST_MAX_FILES + 1);
    expect(projected.filesChanged.at(-1)).toMatch(/^…\+\d+ more$/);
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(digest).length / 10);
  });

  it('applies both caps on a combined agent payload', () => {
    const agent = {
      agentId: 'a-1',
      description: 'D'.repeat(DESCRIPTION_MAX_BYTES * 3),
      completionDigest: {
        bullets: ['x'.repeat(2000)],
        filesChanged: Array.from({ length: 200 }, (_, i) => `f${i}`),
        testSummary: 't'.repeat(2000),
        verificationCommands: Array.from({ length: 50 }, (_, i) => `cmd ${i} ${'y'.repeat(1000)}`),
      },
    };
    const projected = projectAgentFieldsForClient(agent);
    expect(projected).not.toBe(agent);
    expect(projected.description!.length).toBeLessThan(agent.description.length);
    expect(projected.completionDigest!.filesChanged.length).toBeLessThanOrEqual(COMPLETION_DIGEST_MAX_FILES + 1);
    expect(projected.completionDigest!.bullets[0]!.length).toBeLessThanOrEqual(501);
  });
});
