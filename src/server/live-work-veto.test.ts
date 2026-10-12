import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../core/tasks.js';
import {
  evaluateLiveWorkVeto,
  liveWorkVetoReasonText,
  type LiveWorkVetoReason,
} from './live-work-veto.js';

const NOW = new Date('2026-06-21T00:00:00.000Z');

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tmuxSession: 's1',
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: NOW,
    ...patch,
  };
}

// An idle, non-terminal session — the shape a genuinely abandoned
// completion_ready task has. No signal present here ⇒ nothing should veto.
const IDLE = { sessions: [session({ lastTurnState: 'completed_turn' })] };

// A high-confidence input-prompt pane (a `❯` composer line) — what the pane
// analyzer classifies as a human-interactive marker.
const HUMAN_PANE = 'some agent output\n❯\n';

describe('evaluateLiveWorkVeto', () => {
  it('does not veto a genuinely idle task with no live-human signals', () => {
    expect(evaluateLiveWorkVeto(IDLE)).toEqual({ veto: false });
    expect(
      evaluateLiveWorkVeto(IDLE, {
        paneText: 'just some agent output',
        present: false,
        holdingOpenPr: false,
      }),
    ).toEqual({ veto: false });
  });

  it('vetoes when a session reports a live turn (turn resumed since selection)', () => {
    expect(
      evaluateLiveWorkVeto({ sessions: [session({ lastTurnState: 'running' })] }),
    ).toEqual({ veto: true, reason: 'live_turn' });
    expect(
      evaluateLiveWorkVeto({ sessions: [session({ lastTurnState: 'waiting_for_input' })] }),
    ).toEqual({ veto: true, reason: 'live_turn' });
  });

  it('vetoes when the live pane shows a human-interactive prompt', () => {
    expect(evaluateLiveWorkVeto(IDLE, { paneText: HUMAN_PANE })).toEqual({
      veto: true,
      reason: 'interactive_pane',
    });
  });

  it('vetoes when a viewer currently has the task attached', () => {
    expect(evaluateLiveWorkVeto(IDLE, { present: true })).toEqual({
      veto: true,
      reason: 'viewer_present',
    });
  });

  it('vetoes only on a definite open-PR hold', () => {
    expect(evaluateLiveWorkVeto(IDLE, { holdingOpenPr: true })).toEqual({
      veto: true,
      reason: 'open_pr',
    });
    // Unknown / no PR must NOT veto (fail-safe parity with the ack reaper).
    expect(evaluateLiveWorkVeto(IDLE, { holdingOpenPr: undefined })).toEqual({ veto: false });
    expect(evaluateLiveWorkVeto(IDLE, { holdingOpenPr: false })).toEqual({ veto: false });
  });

  it('ignores turn state on terminal sessions', () => {
    expect(
      evaluateLiveWorkVeto({
        sessions: [session({ lastTurnState: 'running', lastStatus: 'completed' })],
      }),
    ).toEqual({ veto: false });
  });

  it('gives every reason a human-readable string', () => {
    const reasons: LiveWorkVetoReason[] = [
      'live_turn',
      'interactive_pane',
      'viewer_present',
      'open_pr',
    ];
    for (const reason of reasons) {
      expect(liveWorkVetoReasonText(reason).length).toBeGreaterThan(0);
    }
  });
});
