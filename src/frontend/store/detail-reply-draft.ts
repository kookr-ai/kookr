export const DETAIL_REPLY_DRAFT_KEY_PREFIX = 'kookr:detailReplyDraft';

export interface DetailReplyDraftScope {
  taskId?: string | null;
  agentId?: string | null;
}

export function detailReplyDraftKey(scope: DetailReplyDraftScope): string | null {
  const taskId = scope.taskId?.trim();
  if (taskId) return `${DETAIL_REPLY_DRAFT_KEY_PREFIX}:task:${encodeURIComponent(taskId)}`;

  const agentId = scope.agentId?.trim();
  if (agentId) return `${DETAIL_REPLY_DRAFT_KEY_PREFIX}:agent:${encodeURIComponent(agentId)}`;

  return null;
}

export function loadDetailReplyDraft(scope: DetailReplyDraftScope): string {
  const key = detailReplyDraftKey(scope);
  if (!key || typeof localStorage === 'undefined') return '';

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return '';
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return '';
    const p = parsed as Record<string, unknown>;
    return typeof p.input === 'string' ? p.input : '';
  } catch {
    return '';
  }
}

export function saveDetailReplyDraft(scope: DetailReplyDraftScope, input: string): void {
  const key = detailReplyDraftKey(scope);
  if (!key || typeof localStorage === 'undefined') return;

  if (!input.trim()) {
    clearDetailReplyDraft(scope);
    return;
  }

  try {
    localStorage.setItem(key, JSON.stringify({ input }));
  } catch {
    // Quota exceeded / private browsing - silently ignore.
  }
}

export function clearDetailReplyDraft(scope: DetailReplyDraftScope): void {
  const key = detailReplyDraftKey(scope);
  if (!key || typeof localStorage === 'undefined') return;

  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}
