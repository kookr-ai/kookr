import type { AgentSelection, ModelTier, Playbook, PlaybookScope, ScheduleListResponse, ScheduleResponse, ScheduleRollup } from '../shared/protocol.js';

export interface SchedulePreviewResponse {
  cronDescription: string;
  nextRuns: string[];
  timezone: string;
}

export interface ScheduleApiErrorBody {
  error?: string;
  fieldErrors?: Record<string, string>;
}

export interface CreateScheduleRequest {
  name: string;
  cron: string;
  maxTriggers?: number;
  cwd: string;
  enabled: boolean;
  agentType: AgentSelection;
  modelTier?: ModelTier;
  /** Optional per-schedule reasoning-effort pin (#1518). */
  effort?: string;
  /** Optional per-schedule model pin (#1518). */
  model?: string;
  playbook: {
    path: string;
    parameters: Record<string, string>;
    /** Pinned tier for the selected playbook (project | user | plugin). */
    scope?: PlaybookScope;
  };
}

export async function listSchedules(): Promise<ScheduleListResponse> {
  return requestJson<ScheduleListResponse>('/api/schedules');
}

/** Fleet rollups from the materialized store — no tasks.json / hook-log scan. */
export async function listScheduleRollups(): Promise<ScheduleRollup[]> {
  const body = await requestJson<{ rollups?: ScheduleRollup[] }>('/api/schedules/rollups');
  return Array.isArray(body.rollups) ? body.rollups : [];
}

export async function listPlaybooksForCwd(cwd: string): Promise<Playbook[]> {
  return requestJson<Playbook[]>(`/api/playbooks?cwd=${encodeURIComponent(cwd)}`);
}

export async function previewScheduleCron(cron: string): Promise<SchedulePreviewResponse | null> {
  const res = await fetch('/api/schedules/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cron }),
  });
  if (!res.ok) return null;
  return (await res.json()) as SchedulePreviewResponse;
}

export async function createSchedule(input: CreateScheduleRequest): Promise<ScheduleResponse> {
  return requestJson<ScheduleResponse>('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleResponse> {
  return requestJson<ScheduleResponse>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export async function runScheduleNow(id: string): Promise<void> {
  await requestJson<unknown>(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' });
}

export async function deleteSchedule(id: string): Promise<void> {
  await requestJson<unknown>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw body as ScheduleApiErrorBody;
  }
  return body as T;
}
