import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EVOLUTION_CONFIG_RELATIVE_PATH = '.kookr/evolution/config.json';

export interface EvolutionConfig {
  schemaVersion: 'kookr-evolution-config.v1';
  evaluate: string;
  propose?: string;
  apply?: string;
  artifact: string;
  higherIsBetter?: boolean;
  targetScore?: number;
  patience?: number;
  minImprovementDelta?: number;
  maxConsecutiveFailedTrials?: number;
  deadlineAt?: string;
  maxTrials?: number;
}

export type EvolutionConfigValidationResult =
  | { ok: true; config: EvolutionConfig }
  | { ok: false; error: string };

const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'evaluate',
  'propose',
  'apply',
  'artifact',
  'higherIsBetter',
  'targetScore',
  'patience',
  'minImprovementDelta',
  'maxConsecutiveFailedTrials',
  'deadlineAt',
  'maxTrials',
]);

export async function readEvolutionConfig(projectCwd: string): Promise<EvolutionConfigValidationResult> {
  const configPath = join(projectCwd, EVOLUTION_CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, error: `Missing ${EVOLUTION_CONFIG_RELATIVE_PATH} in ${projectCwd}` };
    }
    return { ok: false, error: `Could not read ${EVOLUTION_CONFIG_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Malformed ${EVOLUTION_CONFIG_RELATIVE_PATH}: ${err instanceof Error ? err.message : String(err)}` };
  }

  const validation = validateEvolutionConfig(parsed);
  if (!validation.ok) {
    return { ok: false, error: `Invalid ${EVOLUTION_CONFIG_RELATIVE_PATH}: ${validation.error}` };
  }
  return validation;
}

export function validateEvolutionConfig(value: unknown): EvolutionConfigValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'config must be an object' };

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `unsupported field "${key}"` };
  }

  if (value.schemaVersion !== 'kookr-evolution-config.v1') {
    return { ok: false, error: 'schemaVersion must be "kookr-evolution-config.v1"' };
  }
  const evaluate = requiredNonEmptyString(value.evaluate, 'evaluate');
  if (evaluate) return { ok: false, error: evaluate };
  const artifact = requiredNonEmptyString(value.artifact, 'artifact');
  if (artifact) return { ok: false, error: artifact };

  for (const field of ['propose', 'apply'] as const) {
    const error = optionalNonEmptyString(value[field], field);
    if (error) return { ok: false, error };
  }
  if (value.higherIsBetter !== undefined && typeof value.higherIsBetter !== 'boolean') {
    return { ok: false, error: 'higherIsBetter must be a boolean' };
  }
  for (const field of ['targetScore', 'minImprovementDelta'] as const) {
    const error = optionalFiniteNumber(value[field], field);
    if (error) return { ok: false, error };
  }
  if (typeof value.minImprovementDelta === 'number' && value.minImprovementDelta < 0) {
    return { ok: false, error: 'minImprovementDelta must be greater than or equal to 0' };
  }
  for (const field of ['patience', 'maxConsecutiveFailedTrials', 'maxTrials'] as const) {
    const error = optionalPositiveInteger(value[field], field);
    if (error) return { ok: false, error };
  }
  if (value.deadlineAt !== undefined) {
    const error = optionalDateTime(value.deadlineAt, 'deadlineAt');
    if (error) return { ok: false, error };
  }

  const config: EvolutionConfig = {
    schemaVersion: 'kookr-evolution-config.v1',
    evaluate: String(value.evaluate),
    artifact: String(value.artifact),
    ...(typeof value.propose === 'string' ? { propose: value.propose } : {}),
    ...(typeof value.apply === 'string' ? { apply: value.apply } : {}),
    ...(typeof value.higherIsBetter === 'boolean' ? { higherIsBetter: value.higherIsBetter } : {}),
    ...(typeof value.targetScore === 'number' ? { targetScore: value.targetScore } : {}),
    ...(typeof value.patience === 'number' ? { patience: value.patience } : {}),
    ...(typeof value.minImprovementDelta === 'number' ? { minImprovementDelta: value.minImprovementDelta } : {}),
    ...(typeof value.maxConsecutiveFailedTrials === 'number' ? { maxConsecutiveFailedTrials: value.maxConsecutiveFailedTrials } : {}),
    ...(typeof value.deadlineAt === 'string' ? { deadlineAt: value.deadlineAt } : {}),
    ...(typeof value.maxTrials === 'number' ? { maxTrials: value.maxTrials } : {}),
  };

  return { ok: true, config };
}

function requiredNonEmptyString(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${field} is required and must be a non-empty string`;
  }
  return null;
}

function optionalNonEmptyString(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${field} must be a non-empty string when supplied`;
  }
  return null;
}

function optionalFiniteNumber(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${field} must be a finite number`;
  }
  return null;
}

function optionalPositiveInteger(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 1) {
    return `${field} must be an integer greater than or equal to 1`;
  }
  return null;
}

function optionalDateTime(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return `${field} must be an ISO date-time string`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
