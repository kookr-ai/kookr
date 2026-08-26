import type { LaunchDependency } from './playbook.js';

export type LaunchPreflightFailureCategory =
  | 'server_reachability'
  | 'configuration'
  | 'empty_index_data'
  | 'provider_api'
  | 'query_runtime_failure'
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

export interface DependencyCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  collectionFailure?: 'timeout' | 'max_buffer';
}

export class LaunchPreflightError extends Error {
  readonly findings: LaunchPreflightFinding[];

  constructor(findings: LaunchPreflightFinding[]) {
    super(formatLaunchPreflightError(findings));
    this.name = 'LaunchPreflightError';
    this.findings = findings;
  }
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

export function classifyKbDoctorCommandResult(result: DependencyCommandResult): LaunchPreflightFinding | null {
  const collectionFinding = classifyCollectionFailure(result, 'doctor');
  if (collectionFinding) return collectionFinding;
  let parsed: KbDoctorOutput;
  try {
    parsed = JSON.parse(result.stdout) as KbDoctorOutput;
  } catch {
    if (result.exitCode !== 0) {
      return kbFindingFromCommandFailure(
        result.stderr || result.stdout || `kb doctor exited ${result.exitCode}`,
        result.stdout,
      );
    }
    return {
      dependency: 'kb',
      status: 'failed',
      category: 'unknown',
      summary: 'KB preflight could not parse `kb doctor --format=json` output',
      detail: redactDiagnosticText(result.stdout, 500),
      recommendedAction: 'Run `kb doctor --format=json` manually and fix the reported output or CLI version.',
    };
  }

  const doctorFinding = classifyKbDoctorOutput(parsed);
  if (doctorFinding || result.exitCode === 0) return doctorFinding;
  return kbFindingFromCommandFailure(
    result.stderr || result.stdout || `kb doctor exited ${result.exitCode}`,
    result.stdout,
  );
}

export function classifyKbSearchSmokeResult(result: DependencyCommandResult): LaunchPreflightFinding | null {
  const collectionFinding = classifyCollectionFailure(result, 'search smoke');
  if (collectionFinding) return collectionFinding;
  if (result.exitCode === 0) return null;
  const message = [result.stdout, result.stderr].filter(Boolean).join('\n') || `kb search exited ${result.exitCode}`;
  return {
    dependency: 'kb',
    status: 'failed',
    category: 'query_runtime_failure',
    summary: 'KB dependency preflight search smoke failed',
    detail: redactDiagnosticText(message, 500),
    recommendedAction: recommendedKbAction('query_runtime_failure'),
  };
}

function classifyCollectionFailure(
  result: DependencyCommandResult,
  command: string,
): LaunchPreflightFinding | null {
  if (!result.collectionFailure) return null;
  return {
    dependency: 'kb',
    status: 'failed',
    category: 'unknown',
    summary: `KB dependency preflight ${command} did not produce bounded health evidence`,
    detail: redactDiagnosticText(result.stderr || result.stdout || result.collectionFailure, 500),
    recommendedAction: 'Run the KB health commands manually; a collection timeout alone is not confirmed degradation.',
  };
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
    detail: redactDiagnosticText(detail, 500),
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
    detail: redactDiagnosticText(message, 500),
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
    text.includes('apikey') ||
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
    case 'query_runtime_failure':
      return 'Run `kb doctor --format=json` and a small `kb search` manually; fix the KB query path before relying on KB-backed task context.';
    case 'unknown':
      return 'Run `kb doctor --format=json` manually and address the reported KB failure.';
  }
}

export function redactDiagnosticText(input: string, maxLength = 500): string {
  const redacted = input
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/([?&](?:token|api[_-]?key|password|secret)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b(token|api[_-]?key|password|secret)=\S+/gi, '$1=<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-<redacted>');

  if (redacted.length <= maxLength) return redacted;
  return redacted.slice(0, Math.max(0, maxLength - 3)) + '...';
}
