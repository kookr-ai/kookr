import type { AnomalySeverity } from './anomalies.js';

export interface ProjectWebhookRoutingSettings {
  enabled?: boolean;
  minSeverity?: AnomalySeverity;
}

export interface ProjectConfig {
  project: string;
  tracked?: boolean;
  dailyPrLimit?: number;
  weeklyPrLimit?: number;
  notes?: string;
  localPath?: string;
  webhook?: ProjectWebhookRoutingSettings;
}

export function isAnomalySeverity(value: unknown): value is AnomalySeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

export function normalizeProjectWebhookRoutingSettings(raw: unknown): ProjectWebhookRoutingSettings | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const input = raw as Record<string, unknown>;
  const settings: ProjectWebhookRoutingSettings = {};
  if (typeof input.enabled === 'boolean') settings.enabled = input.enabled;
  if (isAnomalySeverity(input.minSeverity)) settings.minSeverity = input.minSeverity;
  return settings;
}

export function sanitizeProjectConfig(raw: unknown): ProjectConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.project !== 'string' || !input.project.trim()) return null;

  const config: ProjectConfig = { project: input.project };
  if (typeof input.tracked === 'boolean') config.tracked = input.tracked;
  if (typeof input.dailyPrLimit === 'number') config.dailyPrLimit = input.dailyPrLimit;
  if (typeof input.weeklyPrLimit === 'number') config.weeklyPrLimit = input.weeklyPrLimit;
  if (typeof input.notes === 'string') config.notes = input.notes;
  if (typeof input.localPath === 'string') config.localPath = input.localPath;
  const webhook = normalizeProjectWebhookRoutingSettings(input.webhook);
  if (webhook !== undefined) config.webhook = webhook;
  return config;
}
