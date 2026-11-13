import { describe, it, expect } from 'vitest';
import { decide, lastTestOutcome, latestVerdict, isParked } from './delivery-step-stop.mjs';

const tu = (id, command) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const tr = (id, text, is_error) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
const SHA = 'a'.repeat(40);
const verdict = (v, sha = SHA) => `<!-- kookr-independent-review -->\nkookr-review-verdict: ${v}\nreview-lane: claude\nreview-head-sha: ${sha}`;
const pr = (comments = []) => ({ number: 7, headSha: SHA, comments });
const ev = (extra = {}) => ({ session_id: 's', ...extra });

describe('transcript replay', () => {
  it('shape 1: red test with PR open blocks', () => {
    const t = [tu('1', 'pnpm test:changed 2>&1 | tee log'), tr('1', 'Exit code 1\nFAIL', true)].join('\n');
    expect(lastTestOutcome(t)).toBe('red');
    expect(decide({ event: ev(), testOutcome: 'red', pr: pr(), authorization: 'pre-authorized' })).toMatch(/last test\/gate run failed/);
  });
  it('a later green run clears the red', () => {
    const t = [tu('1', 'vitest run'), tr('1', 'Exit code 1', true), tu('2', 'vitest run'), tr('2', 'ok', false)].join('\n');
    expect(lastTestOutcome(t)).toBe('green');
  });
  it('shape 2: PR open, no review verdict blocks', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr(), authorization: 'ask-first' })).toMatch(/independent review/);
  });
  it('shape 3: pass verdict + pre-authorized blocks with the merge instruction', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr([verdict('pass')]), authorization: 'pre-authorized' })).toMatch(/pnpm merge/);
  });
  it('shape 3: ask-first escalates (allows stop)', () => {
    expect(decide({ event: ev(), testOutcome: 'green', pr: pr([verdict('pass')]), authorization: 'ask-first' })).toBeNull();
  });
  it('stale verdict (head moved) asks for a re-review', () => {
    expect(decide({ event: ev(), testOutcome: null, pr: pr([verdict('pass', 'b'.repeat(40))]), authorization: 'pre-authorized' })).toMatch(/head moved/);
  });
  it('block verdict asks for fixes', () => {
    expect(decide({ event: ev(), testOutcome: null, pr: pr([verdict('block')]), authorization: 'pre-authorized' })).toMatch(/BLOCK/);
  });
});

describe('does not fire', () => {
  it('when parked on background work or crons', () => {
    expect(isParked({ background_tasks: 1 })).toBe(true);
    expect(decide({ event: ev({ background_tasks: 2 }), testOutcome: 'red', pr: pr(), authorization: 'pre-authorized' })).toBeNull();
    expect(decide({ event: ev({ session_crons: [{}] }), testOutcome: 'red', pr: pr(), authorization: 'pre-authorized' })).toBeNull();
  });
  it('on the re-run after a block', () => {
    expect(decide({ event: ev({ stop_hook_active: true }), testOutcome: 'red', pr: pr(), authorization: 'pre-authorized' })).toBeNull();
  });
  it('when the task has no open PR', () => {
    expect(decide({ event: ev(), testOutcome: 'red', pr: null, authorization: 'pre-authorized' })).toBeNull();
  });
});

describe('latestVerdict', () => {
  it('takes the most recent verdict', () => {
    expect(latestVerdict([verdict('block'), 'chatter', verdict('pass')])?.verdict).toBe('pass');
  });
});
