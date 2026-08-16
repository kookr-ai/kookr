import { describe, expect, test } from 'vitest';
import {
  classifyTerminalSuccessVerdict,
  TERMINAL_SUCCESS_VERDICTS,
} from './terminal-success-verdict.js';
import { evaluateConvergence, formatConvergenceReceipt } from './deploy-convergence.js';

/** Local boolean helper mirroring the production `!== null` check at call sites. */
const isTerminalSuccessVerdict = (msg: string | undefined | null): boolean =>
  classifyTerminalSuccessVerdict(msg) !== null;

describe('classifyTerminalSuccessVerdict', () => {
  test('matches a deploy-convergence "converged —" receipt', () => {
    const match = classifyTerminalSuccessVerdict(
      'converged — prod serving 97ef54f4 == origin/main HEAD 97ef54f4 (exact match)',
    );
    expect(match?.verdict).toBe('converged');
  });

  test('matches a labelled "deploy-convergence: converged ·" receipt', () => {
    const match = classifyTerminalSuccessVerdict(
      'deploy-convergence: converged · serving=194eda77 main=194eda77',
    );
    expect(match?.verdict).toBe('converged');
  });

  test('matches the real formatConvergenceReceipt output for a converged result', () => {
    const result = evaluateConvergence({
      servingSha: '194eda77',
      targetSha: '194eda77',
      nowMs: 1_700_000_000_000,
    });
    expect(result.converged).toBe(true);
    const receipt = formatConvergenceReceipt(result);
    expect(isTerminalSuccessVerdict(receipt)).toBe(true);
  });

  test('matches bare "Completed." / "Complete" verdict lines', () => {
    expect(classifyTerminalSuccessVerdict('Completed.')?.verdict).toBe('completed');
    expect(classifyTerminalSuccessVerdict('Complete')?.verdict).toBe('complete');
    expect(classifyTerminalSuccessVerdict('✅ Complete — all checks pass')?.verdict).toBe('complete');
  });

  test('finds the verdict on a later line of a multi-line summary', () => {
    const msg = 'Ran the deploy-convergence check against prod.\n\nconverged · serving=abc main=abc';
    expect(classifyTerminalSuccessVerdict(msg)?.verdict).toBe('converged');
  });

  test('does NOT match non-success convergence outcomes (diverging / divergent)', () => {
    expect(classifyTerminalSuccessVerdict('diverging: prod serving abc not yet on main def')).toBeNull();
    expect(
      classifyTerminalSuccessVerdict('deploy-convergence: DIVERGENT · serving=abc main=def age=40m'),
    ).toBeNull();
    // The real divergent receipt must not be read as success.
    const divergent = evaluateConvergence({
      servingSha: 'aaaa1111',
      targetSha: 'bbbb2222',
      targetCommittedAtMs: 1_700_000_000_000 - 60 * 60_000,
      nowMs: 1_700_000_000_000,
    });
    expect(divergent.converged).toBe(false);
    expect(isTerminalSuccessVerdict(formatConvergenceReceipt(divergent))).toBe(false);
  });

  test('does NOT match a question, even if it contains a verdict word', () => {
    expect(classifyTerminalSuccessVerdict('Complete the migration?')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Should I mark this converged?')).toBeNull();
  });

  test('does NOT match a verdict headline followed by a question on a later line', () => {
    // Regression: the loop must not return on the first verdict-shaped line while
    // a genuine question waits on another line.
    expect(classifyTerminalSuccessVerdict('Complete.\nShould I also merge this to staging?')).toBeNull();
    expect(
      classifyTerminalSuccessVerdict('converged · serving=abc main=abc\n\nWant me to redeploy staging too?'),
    ).toBeNull();
  });

  test('does NOT match a caveated / non-success body after a receipt-style separator', () => {
    // The verdict token leads and is followed by a real separator, but the body
    // negates success — must be rejected, not read as done.
    expect(classifyTerminalSuccessVerdict('Completed — but 2 checks still failing, manual review needed')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Complete: 3 of 5 steps done, 2 failed')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Complete — FAILED to deploy, rollback required')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Converged — NOT safe to proceed')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Complete — however the tests did not run')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Converged — pending final review')).toBeNull();
    expect(classifyTerminalSuccessVerdict('converged (with caveats: staging still diverged)')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Status: complete, 2 failing')).toBeNull();
  });

  test('does NOT match a verdict followed by a comma/semicolon continuation clause', () => {
    expect(classifyTerminalSuccessVerdict('Complete, moving to next task')).toBeNull();
    expect(classifyTerminalSuccessVerdict("Converged; but let's verify with the team first")).toBeNull();
  });

  test('does NOT match mid-work prose where the verdict word leads into more words', () => {
    expect(classifyTerminalSuccessVerdict('Completed step 3, now fixing step 4')).toBeNull();
    expect(classifyTerminalSuccessVerdict('Converged on an approach, implementing it now')).toBeNull();
  });

  test('does NOT match a verdict word buried mid-sentence', () => {
    expect(
      classifyTerminalSuccessVerdict('I think the two branches have not yet converged on prod.'),
    ).toBeNull();
  });

  test('handles empty / non-string input safely', () => {
    expect(classifyTerminalSuccessVerdict('')).toBeNull();
    expect(classifyTerminalSuccessVerdict(undefined)).toBeNull();
    expect(classifyTerminalSuccessVerdict(null)).toBeNull();
    expect(isTerminalSuccessVerdict('   ')).toBe(false);
  });

  test('vocabulary is the documented terminal-success set', () => {
    expect([...TERMINAL_SUCCESS_VERDICTS]).toEqual(['converged', 'completed', 'complete']);
  });
});
