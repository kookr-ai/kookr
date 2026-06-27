const SELECTED_TASK_STORAGE_KEY = 'kookr-selected-task';

export interface StoredSelectedTask {
  taskId: string | null;
  agentId: string | null;
  selectedAt: number;
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseStoredSelectedTask(value: string): StoredSelectedTask | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const taskId = cleanId(record.taskId);
  const agentId = cleanId(record.agentId);
  const selectedAt = typeof record.selectedAt === 'number' && Number.isFinite(record.selectedAt)
    ? record.selectedAt
    : null;

  if (!taskId && !agentId) return null;
  if (selectedAt === null) return null;

  return { taskId, agentId, selectedAt };
}

export function loadSelectedTask(): StoredSelectedTask | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const stored = localStorage.getItem(SELECTED_TASK_STORAGE_KEY);
    if (stored === null) return null;
    const selected = parseStoredSelectedTask(stored);
    if (!selected) localStorage.removeItem(SELECTED_TASK_STORAGE_KEY);
    return selected;
  } catch {
    return null;
  }
}

export function saveSelectedTask(taskId: string | null | undefined, agentId: string | null | undefined, selectedAt = Date.now()): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const selected: StoredSelectedTask = {
      taskId: taskId || null,
      agentId: agentId || null,
      selectedAt,
    };
    if (!selected.taskId && !selected.agentId) {
      localStorage.removeItem(SELECTED_TASK_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SELECTED_TASK_STORAGE_KEY, JSON.stringify(selected));
  } catch {
    // Persistence is best-effort; task selection should still update in memory.
  }
}

export function clearSelectedTask(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(SELECTED_TASK_STORAGE_KEY);
  } catch {
    // Persistence is best-effort; task selection should still update in memory.
  }
}
