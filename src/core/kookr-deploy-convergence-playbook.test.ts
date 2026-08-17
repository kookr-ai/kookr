import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';
import { resolveScheduleProbe, shouldEscalateProbe } from './schedule-probe.js';

describe('kookr-deploy-convergence playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    '.kookr',
    'playbooks',
    'kookr-deploy-convergence.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'kookr-deploy-convergence.md', '/');

  test('declares a cheap probe the scheduler can exec without an agent', () => {
    expect(pb.name).toBe('Kookr Deploy Convergence');
    expect(pb.probe?.command).toContain('pnpm deploy:convergence');
    expect(pb.probe?.escalateOnExit).toEqual([2]);

    const spec = resolveScheduleProbe({
      playbookPath: 'kookr-deploy-convergence.md',
      probe: pb.probe,
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
    expect(shouldEscalateProbe(spec!, 0)).toBe(false);
    expect(shouldEscalateProbe(spec!, 2)).toBe(true);
  });
});
