import {
  type OperationalAlertConfig,
  readOperationalAlertConfigFromEnv,
} from './config.js';

export type OperationalAlertConfigField = keyof OperationalAlertConfig;

export type SetOperationalAlertConfigError =
  | 'invalid-payload'
  | 'empty-update'
  | 'invalid-threshold'
  | 'invalid-sustain-samples';

export interface SetOperationalAlertConfigResult {
  ok: boolean;
  error?: SetOperationalAlertConfigError;
  field?: OperationalAlertConfigField;
}

export interface OperationalAlertConfigState {
  /** Live thresholds used by the running evaluator. */
  config: OperationalAlertConfig;
  /** Boot-time defaults seeded from KOOKR_ALERT_* env. */
  default: OperationalAlertConfig;
}

const THRESHOLD_FIELDS = [
  'cpuPercent',
  'memoryPercent',
  'eventLoopDelayMs',
  'processRssBytes',
  'dataDirectoryFreePercent',
  'dataDirectoryFreeBytes',
  'circuitBreakerOpenMs',
] as const;
const UPDATE_FIELDS = [...THRESHOLD_FIELDS, 'sustainSamples'] as const;

let defaultConfig: OperationalAlertConfig = readOperationalAlertConfigFromEnv({});
let currentConfig: OperationalAlertConfig = { ...defaultConfig };

function cloneConfig(config: OperationalAlertConfig): OperationalAlertConfig {
  return { ...config };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateThreshold(
  field: (typeof THRESHOLD_FIELDS)[number],
  value: unknown,
): number | SetOperationalAlertConfigResult {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'invalid-threshold', field };
  }
  return value;
}

function validateSustainSamples(value: unknown): number | SetOperationalAlertConfigResult {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: 'invalid-sustain-samples', field: 'sustainSamples' };
  }
  return value;
}

export function getOperationalAlertConfig(): OperationalAlertConfig {
  return cloneConfig(currentConfig);
}

export function getOperationalAlertConfigState(): OperationalAlertConfigState {
  return {
    config: cloneConfig(currentConfig),
    default: cloneConfig(defaultConfig),
  };
}

/**
 * Seed the runtime holder from env. Startup calls this after env loading; tests
 * call it with explicit env objects to avoid depending on process state.
 */
export function resetOperationalAlertConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperationalAlertConfig {
  defaultConfig = readOperationalAlertConfigFromEnv(env);
  currentConfig = cloneConfig(defaultConfig);
  return getOperationalAlertConfig();
}

/**
 * Apply a partial live update. Unknown keys are ignored so clients can send a
 * wider settings object, but at least one known field must be present.
 */
export function setOperationalAlertConfig(patch: unknown): SetOperationalAlertConfigResult {
  if (!isRecord(patch)) {
    return { ok: false, error: 'invalid-payload' };
  }

  const next = cloneConfig(currentConfig);
  let changedFields = 0;

  for (const field of THRESHOLD_FIELDS) {
    if (!(field in patch)) continue;
    const value = validateThreshold(field, patch[field]);
    if (typeof value !== 'number') return value;
    next[field] = value;
    changedFields += 1;
  }

  if ('sustainSamples' in patch) {
    const value = validateSustainSamples(patch.sustainSamples);
    if (typeof value !== 'number') return value;
    next.sustainSamples = value;
    changedFields += 1;
  }

  if (changedFields === 0) {
    return { ok: false, error: 'empty-update' };
  }

  currentConfig = next;
  return { ok: true };
}

export const OPERATIONAL_ALERT_CONFIG_FIELDS = UPDATE_FIELDS;
