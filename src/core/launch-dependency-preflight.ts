import { execFile } from 'node:child_process';
import type { LaunchDependency } from './playbook.js';

export type LaunchPreflightFailureCategory =
  | 'server_reachability'
  | 'configuration'
  | 'empty_index_data'
  | 'provider_api'
  | 'unknown';

export interface LaunchPreflightFinding {
  dependency: LaunchDependency;
  status: 'failed';
  category: LaunchPreflightFailureCategory;
  summary: string;
  detail?: string;
  recommendedAction: string;
}

export type DependencyPreflightRunner = (
  dependencies: LaunchDependency[] | undefined,
) => Promise<LaunchPreflightFinding[]>;

export class LaunchPreflightError extends Error {
  readonly findings: LaunchPreflightFinding[];

  constructor(findings: LaunchPreflightFinding[]) {
    super(formatLaunchPreflightError(findings));
    this.name = 'LaunchPreflightError';
    this.findings = findings;
  }
}

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
    }
  }

  return findings;
}

export function formatLaunchPreflightError(findings: LaunchPreflightFinding[]): string {
  if (findings.length === 0) return 'Launch preflight failed';
  return findings
    .map((finding) => {
      const detail = finding.detail ? ` ${finding.detail}` : '';
      return `${finding.summary} (${finding.category}).${detail} Recommended action: ${finding.recommendedAction}`;
    })
    .join(' ');
}

async function runKbAvailabilityPreflight(): Promise<LaunchPreflightFinding | null> {
  let result: CommandResult;
  try {
    result = await execFileBounded('kb', ['doctor', '--format=json'], 5_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return kbFindingFromCommandFailure(message, '');
  }

  if (result.exitCode !== 0) {
    return kbFindingFromCommandFailure(result.stderr || result.stdout || `kb doctor exited ${result.exitCode}`, result.stdout);
  }

  let parsed: KbDoctorOutput;
  try {
    parsed = JSON.parse(result.stdout) as KbDoctorOutput;
  } catch {
    return {
      dependency: 'kb',
      status: 'failed',
      category: 'unknown',
      summary: 'KB preflight could not parse `kb doctor --format=json` output',
      detail: result.stdout.slice(0, 500),
      recommendedAction: 'Run `kb doctor --format=json` manually and fix the reported output or CLI version.',
    };
  }

  return classifyKbDoctorOutput(parsed);
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execFileBounded(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
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

interface KbDoctorCheck {
  name?: string;
  status?: string;
  detail?: string;
}

interface KbDoctorOutput {
  status?: string;
  checks?: KbDoctorCheck[];
  backend?: {
    provider?: string;
    healthy?: boolean;
    detail?: string;
  };
}

export function classifyKbDoctorOutput(parsed: KbDoctorOutput): LaunchPreflightFinding | null {
  const checks = parsed.checks ?? [];
  const failed = checks.find((check) => check.status === 'error' || check.status === 'failed');
  if (!failed && parsed.status !== 'error' && parsed.backend?.healthy !== false) {
    return null;
  }

  const name = failed?.name ?? (parsed.backend?.healthy === false ? 'backend' : 'kb');
  const detail = failed?.detail ?? parsed.backend?.detail ?? 'kb doctor reported an error';
  const category = classifyKbFailure(name, detail);

  return {
    dependency: 'kb',
    status: 'failed',
    category,
    summary: `KB dependency preflight failed: ${name}`,
    detail,
    recommendedAction: recommendedKbAction(category),
  };
}

function kbFindingFromCommandFailure(message: string, stdout: string): LaunchPreflightFinding {
  const combined = `${message}\n${stdout}`;
  const category = classifyKbFailure('command', combined);
  return {
    dependency: 'kb',
    status: 'failed',
    category,
    summary: 'KB dependency preflight failed before launch',
    detail: message.slice(0, 500),
    recommendedAction: recommendedKbAction(category),
  };
}

function classifyKbFailure(name: string, detail: string): LaunchPreflightFailureCategory {
  const text = `${name} ${detail}`.toLowerCase();
  if (
    text.includes('econnrefused') ||
    text.includes('connection refused') ||
    text.includes('server') ||
    text.includes('unreachable') ||
    text.includes('timed out') ||
    text.includes('timeout')
  ) {
    return 'server_reachability';
  }
  if (
    text.includes('api key') ||
    text.includes('provider') ||
    text.includes('ollama') ||
    text.includes('openai') ||
    text.includes('huggingface') ||
    text.includes('embedding')
  ) {
    return 'provider_api';
  }
  if (
    text.includes('index') ||
    text.includes('faiss') ||
    text.includes('no chunks') ||
    text.includes('empty') ||
    text.includes('not ingested') ||
    text.includes('no knowledge bases')
  ) {
    return 'empty_index_data';
  }
  if (
    text.includes('env') ||
    text.includes('config') ||
    text.includes('active_model') ||
    text.includes('model') ||
    text.includes('not found') ||
    text.includes('enoent')
  ) {
    return 'configuration';
  }
  return 'unknown';
}

function recommendedKbAction(category: LaunchPreflightFailureCategory): string {
  switch (category) {
    case 'server_reachability':
      return 'Start the KB backend or fix its configured URL, then run `kb doctor --format=json` again.';
    case 'configuration':
      return 'Fix KB CLI configuration, model selection, or PATH, then run `kb doctor --format=json` again.';
    case 'empty_index_data':
      return 'Ingest or refresh the knowledge-base index before launching this KB-dependent task.';
    case 'provider_api':
      return 'Start or reconfigure the embedding provider/API used by the KB index.';
    case 'unknown':
      return 'Run `kb doctor --format=json` manually and address the reported KB failure.';
  }
}
