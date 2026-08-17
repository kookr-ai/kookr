import { describe, expect, it } from 'vitest';
import {
  dropEmptyFlagValues,
  fallbackProbeCommand,
  interpolateProbeTemplate,
  isTruthyScheduleParam,
  playbookBasename,
  probeReceiptLine,
  resolveScheduleProbe,
  shouldEscalateProbe,
  tokenizeProbeCommand,
} from './schedule-probe.js';

describe('schedule-probe', () => {
  it('tokenizes a command without a shell and keeps quoted spans', () => {
    expect(tokenizeProbeCommand('pnpm deploy:convergence -- --branch main')).toEqual([
      'pnpm',
      'deploy:convergence',
      '--',
      '--branch',
      'main',
    ]);
    expect(tokenizeProbeCommand('node script.mjs --base "http://127.0.0.1:4877"')).toEqual([
      'node',
      'script.mjs',
      '--base',
      'http://127.0.0.1:4877',
    ]);
  });

  it('interpolates {{param}} placeholders', () => {
    expect(interpolateProbeTemplate('--branch {{branch}}', { branch: 'main' })).toBe('--branch main');
    expect(interpolateProbeTemplate('--missing {{nope}}', {})).toBe('--missing ');
  });

  it('drops flags whose value interpolated to empty', () => {
    expect(dropEmptyFlagValues(['node', 'x.mjs', '--signal-file', '', '--branch', 'main'])).toEqual([
      'node',
      'x.mjs',
      '--branch',
      'main',
    ]);
    expect(dropEmptyFlagValues(['node', 'x.mjs', '--signal-file', '--act'])).toEqual([
      'node',
      'x.mjs',
      '--act',
    ]);
  });

  it('resolves the Kookr deploy-convergence fallback and appends --act when asked', () => {
    const spec = resolveScheduleProbe({
      playbookPath: 'kookr-deploy-convergence.md',
      parameters: { branch: 'main', graceMinutes: '15', act: 'true' },
    });
    expect(spec).not.toBeNull();
    expect(spec!.argv).toEqual([
      'pnpm',
      'deploy:convergence',
      '--',
      '--branch',
      'main',
      '--grace-minutes',
      '15',
      '--act',
    ]);
    expect(spec!.escalateOnExit).toEqual([2]);
    expect(shouldEscalateProbe(spec!, 0)).toBe(false);
    expect(shouldEscalateProbe(spec!, 1)).toBe(false);
    expect(shouldEscalateProbe(spec!, 2)).toBe(true);
  });

  it('resolves the Lucy deploy-convergence fallback and omits a blank signal file', () => {
    const spec = resolveScheduleProbe({
      playbookPath: '.kookr/playbooks/lucy-deploy-convergence.md',
      parameters: {
        healthBase: 'http://127.0.0.1:4877',
        branch: 'main',
        graceMinutes: '20',
        signalFile: '',
        act: 'true',
      },
    });
    expect(spec!.argv).toEqual([
      'node',
      'scripts/deploy-convergence-check.mjs',
      '--base',
      'http://127.0.0.1:4877',
      '--branch',
      'main',
      '--grace-minutes',
      '20',
      '--act',
    ]);
  });

  it('does not escalate a dry-run tick even on exit 2', () => {
    const spec = resolveScheduleProbe({
      playbookPath: 'kookr-deploy-convergence.md',
      parameters: { act: 'true', dryRun: 'true' },
    });
    expect(spec!.argv).not.toContain('--act');
    expect(shouldEscalateProbe(spec!, 2)).toBe(false);
  });

  it('prefers a declared probe command over the path fallback', () => {
    const spec = resolveScheduleProbe({
      playbookPath: 'kookr-deploy-convergence.md',
      probe: { command: 'node scripts/custom.mjs --branch {{branch}}', escalateOnExit: [3] },
      parameters: { branch: 'staging', act: 'false' },
    });
    expect(spec!.argv).toEqual(['node', 'scripts/custom.mjs', '--branch', 'staging']);
    expect(spec!.escalateOnExit).toEqual([3]);
    expect(shouldEscalateProbe(spec!, 2)).toBe(false);
    expect(shouldEscalateProbe(spec!, 3)).toBe(true);
  });

  it('returns null for an ordinary playbook with no probe', () => {
    expect(resolveScheduleProbe({ playbookPath: 'implement-github-issue.md' })).toBeNull();
    expect(fallbackProbeCommand('implement-github-issue.md')).toBeNull();
    expect(playbookBasename('plugin/playbooks/foo.md')).toBe('foo.md');
  });

  it('reads a receipt from JSON stdout or the last line', () => {
    expect(probeReceiptLine('{"receipt":"deploy-convergence: converged · serving=abc"}')).toBe(
      'deploy-convergence: converged · serving=abc',
    );
    expect(probeReceiptLine('noise\nconverged · serving=abc\n')).toBe('converged · serving=abc');
    expect(probeReceiptLine('')).toBe('');
  });

  it('treats true/1/yes as truthy schedule params', () => {
    expect(isTruthyScheduleParam('true')).toBe(true);
    expect(isTruthyScheduleParam('YES')).toBe(true);
    expect(isTruthyScheduleParam('1')).toBe(true);
    expect(isTruthyScheduleParam('false')).toBe(false);
    expect(isTruthyScheduleParam(undefined)).toBe(false);
  });
});
