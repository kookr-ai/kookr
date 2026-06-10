import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { CwdValidationError } from '../launch-service.js';
import { handleLaunchResult } from './launch-result.js';

function collect(): { send: (msg: ServerMessage) => void; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { send: (msg) => sent.push(msg), sent };
}

describe('handleLaunchResult', () => {
  it('sends a critical alert whose summary leads with the missing-cwd cause (RFC F12)', () => {
    const { send, sent } = collect();
    const err = new CwdValidationError('Working directory does not exist: /no/such/dir');

    const { duplicate } = handleLaunchResult(send, 'fix the bug', undefined, err);

    expect(duplicate).toBe(false);
    expect(sent).toHaveLength(1);
    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('critical');
    expect(alert.summary).toBe(
      'Error starting "fix the bug": Working directory does not exist: /no/such/dir',
    );
    // Cwd-specific recovery details lead with the actual cause instead of the
    // generic checklist that buried "verify the working directory" third.
    expect(alert.details).toMatch(/^The working directory was not found/);
    expect(alert.details).toContain('prompt is preserved');
  });

  it('keeps the generic recovery details for non-cwd launch failures', () => {
    const { send, sent } = collect();

    handleLaunchResult(send, 'fix the bug', undefined, new Error('tmux exploded'));

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.summary).toBe('Error starting "fix the bug": tmux exploded');
    expect(alert.details).toMatch(/^Launch recovery:/);
  });
});
