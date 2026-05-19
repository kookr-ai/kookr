import type { BurnedOutTarget, RalphLoopState } from '../shared/protocol.js';

export type RalphLoopCommand = 'pause' | 'resume' | 'cancel';

interface RalphLoopCommandResponse {
  ok: true;
  status: RalphLoopState['status'];
  ralphLoop?: RalphLoopState;
}

interface RalphLoopPromptResponse {
  ok: true;
  status: RalphLoopState['status'];
  ralphLoop: RalphLoopState;
}

interface RalphBurnedTargetsResponse {
  ok: true;
  burnedOutTargets: BurnedOutTarget[];
}

export async function sendRalphLoopCommand(
  taskId: string,
  command: RalphLoopCommand,
): Promise<RalphLoopCommandResponse> {
  const method = command === 'cancel' ? 'DELETE' : 'POST';
  const suffix = command === 'cancel' ? '' : `/${command}`;
  return requestJson<RalphLoopCommandResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/ralph-loop${suffix}`,
    { method },
  );
}

export async function updateRalphLoopPrompt(
  taskId: string,
  prompt: string,
): Promise<RalphLoopPromptResponse> {
  return requestJson<RalphLoopPromptResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/prompt`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    },
  );
}

export async function updateRalphBurnedTargets(
  taskId: string,
  input: { remove?: string[]; clear?: true },
): Promise<RalphBurnedTargetsResponse> {
  return requestJson<RalphBurnedTargetsResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/burned-targets`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed with ${res.status}`);
  return body;
}
