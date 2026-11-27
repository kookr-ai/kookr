import { describe, expect, test } from 'vitest';
import { deriveSubagentTranscriptPath } from './subagent-transcript-path.js';

describe('deriveSubagentTranscriptPath', () => {
  test('places the subagent under the session folder, as Claude Code does', () => {
    // Paths taken from a real SubagentStart / SubagentStop pair.
    expect(deriveSubagentTranscriptPath(
      '/srv/claude/projects/-srv-app/ebcdd83d-d80a-4c0f-a958-719ef385c0d6.jsonl',
      'a001d0fe78c042e33',
    )).toBe('/srv/claude/projects/-srv-app/ebcdd83d-d80a-4c0f-a958-719ef385c0d6/subagents/agent-a001d0fe78c042e33.jsonl');
  });

  test('gives nothing when either part is missing', () => {
    expect(deriveSubagentTranscriptPath(undefined, 'a1')).toBeNull();
    expect(deriveSubagentTranscriptPath('/p/s.jsonl', '')).toBeNull();
    expect(deriveSubagentTranscriptPath(null, null)).toBeNull();
  });

  test('gives nothing for a parent that is not a .jsonl transcript', () => {
    expect(deriveSubagentTranscriptPath('/p/session.db', 'a1')).toBeNull();
    expect(deriveSubagentTranscriptPath('.jsonl', 'a1')).toBeNull();
    expect(deriveSubagentTranscriptPath('/p/.jsonl', 'a1')).toBeNull();
  });

  test('refuses an agent id that could point somewhere else', () => {
    expect(deriveSubagentTranscriptPath('/p/s.jsonl', '../../etc/passwd')).toBeNull();
    expect(deriveSubagentTranscriptPath('/p/s.jsonl', 'a/b')).toBeNull();
    expect(deriveSubagentTranscriptPath('/p/s.jsonl', 'a b')).toBeNull();
  });
});
