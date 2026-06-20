import { execFile } from 'node:child_process';
import type { LaunchDependency } from '../core/playbook.js';
import {
  classifyKbDoctorCommandResult,
  classifyKbSearchSmokeResult,
  type DependencyCommandResult,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';

const KB_PREFLIGHT_TIMEOUT_MS = 5_000;
const KB_SMOKE_QUERY = 'kookr launch dependency smoke';

export async function runLaunchDependencyPreflights(
  dependencies: LaunchDependency[] | undefined,
): Promise<LaunchPreflightFinding[]> {
  const unique = [...new Set(dependencies ?? [])];
  const findings: LaunchPreflightFinding[] = [];

  for (const dependency of unique) {
    switch (dependency) {
      case 'kb': {
        const finding = await runKbAvailabilityPreflight();
        if (finding) findings.push(finding);
        break;
      }
      case 'evolution-config': {
        // Evolution config validation is cwd- and playbook-parameter-dependent,
        // so preparePlaybookLaunch validates it before LaunchOpts are built.
        break;
      }
    }
  }

  return findings;
}

async function runKbAvailabilityPreflight(): Promise<LaunchPreflightFinding | null> {
  let doctor: DependencyCommandResult;
  try {
    doctor = await execFileBounded('kb', ['doctor', '--format=json'], KB_PREFLIGHT_TIMEOUT_MS);
  } catch (err) {
    return classifyKbDoctorCommandResult({
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    });
  }

  const doctorFinding = classifyKbDoctorCommandResult(doctor);
  if (doctorFinding) return doctorFinding;

  const search = await execFileBounded(
    'kb',
    ['search', KB_SMOKE_QUERY, '--k=1', '--format=json'],
    KB_PREFLIGHT_TIMEOUT_MS,
  );
  return classifyKbSearchSmokeResult(search);
}

function execFileBounded(file: string, args: string[], timeoutMs: number): Promise<DependencyCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const nodeError = error as NodeJS.ErrnoException | null;
      if (nodeError?.code === 'ENOENT') {
        reject(error);
        return;
      }
      const exitCode = typeof nodeError?.code === 'number' ? nodeError.code : error ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
    });
  });
}
