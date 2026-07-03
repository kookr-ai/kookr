import type { AgentState } from '../shared/protocol.js';

/** Group findings by anomaly type, only when ≥3 findings share the same type. */
export function groupFindings(findings: AgentState[]): { ungrouped: AgentState[]; groups: Map<string, AgentState[]> } {
  const byType = new Map<string, AgentState[]>();
  for (const agent of findings) {
    const type = agent.anomaly?.type ?? '';
    const list = byType.get(type) ?? [];
    list.push(agent);
    byType.set(type, list);
  }

  const groups = new Map<string, AgentState[]>();
  const ungrouped: AgentState[] = [];
  for (const [type, agents] of byType) {
    if (agents.length >= 3) {
      groups.set(type, agents);
    } else {
      ungrouped.push(...agents);
    }
  }

  return { ungrouped, groups };
}

export function groupLabel(type: string): string {
  switch (type) {
    case 'permission_blocked': return 'blocked on permission';
    case 'repeated_error': return 'hitting repeated errors';
    case 'needs_input': return 'waiting for input';
    default: return type;
  }
}

export interface IdenticalPendingPromptGroup {
  key: string;
  prompt: string;
  agents: AgentState[];
  approvalResponse?: string;
}

interface PendingPromptFingerprint {
  key: string;
  prompt: string;
}

/**
 * Build exact-match batches for agents waiting on the same operator decision.
 * Completed-turn findings intentionally do not participate: those need review,
 * not a blind "yes" fan-out.
 */
export function groupIdenticalPendingPrompts(
  findings: AgentState[],
  minSize = 2,
): IdenticalPendingPromptGroup[] {
  const byPrompt = new Map<string, IdenticalPendingPromptGroup>();

  for (const agent of findings) {
    const fingerprint = pendingPromptFingerprint(agent);
    if (!fingerprint) continue;
    const current = byPrompt.get(fingerprint.key);
    if (current) {
      current.agents.push(agent);
    } else {
      byPrompt.set(fingerprint.key, {
        key: fingerprint.key,
        prompt: fingerprint.prompt,
        approvalResponse: policyCoveredApprovalResponse(fingerprint.prompt),
        agents: [agent],
      });
    }
  }

  return [...byPrompt.values()]
    .filter((group) => group.agents.length >= minSize)
    .sort((left, right) => right.agents.length - left.agents.length || left.prompt.localeCompare(right.prompt));
}

function pendingPromptFingerprint(agent: AgentState): PendingPromptFingerprint | null {
  if (!agent.anomaly) return null;
  if (agent.turnState === 'completed_turn') return null;

  const question = latestPendingAskUserQuestion(agent);
  if (question) return question;

  if (agent.anomaly.type === 'permission_blocked') {
    const request = latestPermissionRequest(agent);
    if (request) return request;
  }

  const transcriptPrompt = transcriptContextText(agent.anomaly.transcriptContext?.lastAssistantMessage);
  if (transcriptPrompt) return fingerprintFromText(`assistant:${normalizePromptText(transcriptPrompt)}`, transcriptPrompt);

  if (typeof agent.anomaly.explanation === 'string') {
    return fingerprintFromText(`anomaly:${normalizePromptText(agent.anomaly.explanation)}`, agent.anomaly.explanation);
  }

  return null;
}

function transcriptContextText(message: unknown): string | null {
  if (typeof message === 'string') return message;
  const record = objectRecord(message);
  return typeof record?.excerpt === 'string' ? record.excerpt : null;
}

function latestPendingAskUserQuestion(agent: AgentState): PendingPromptFingerprint | null {
  for (let i = agent.events.length - 1; i >= 0; i--) {
    const event = agent.events[i];
    if (event.type === 'tool_result' || event.type === 'input_received') break;
    if (event.type === 'tool_use' && event.toolName === 'AskUserQuestion') {
      const input = objectRecord(event.toolInput);
      const question = typeof input?.question === 'string' ? input.question : 'AskUserQuestion';
      const choices = Array.isArray(input?.choices)
        ? input.choices.map((choice) => String(choice)).join('\n')
        : '';
      const prompt = choices ? `${question}\n${choices}` : question;
      return fingerprintFromText(`ask:${normalizePromptText(prompt)}`, prompt);
    }
  }
  return null;
}

function latestPermissionRequest(agent: AgentState): PendingPromptFingerprint | null {
  for (let i = agent.events.length - 1; i >= 0; i--) {
    const event = agent.events[i];
    if (event.type === 'tool_result' || event.type === 'input_received') break;
    if (event.type === 'permission_request') {
      const input = stablePreview(event.toolInput);
      const prompt = input ? `${event.toolName}: ${input}` : event.toolName;
      return fingerprintFromText(`permission:${normalizePromptText(prompt)}`, prompt);
    }
  }
  return null;
}

function fingerprintFromText(key: string, prompt: string): PendingPromptFingerprint | null {
  const normalized = normalizePromptText(prompt);
  if (!normalized) return null;
  return { key, prompt: normalized };
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function policyCoveredApprovalResponse(prompt: string): string | undefined {
  const lower = prompt.toLowerCase();
  // Only auto-approve already-policy-covered continuation prompts. Merge,
  // scope, destructive, permission, and secret-related prompts remain manual.
  if (
    /\b(merge|scope|delete|remove|destructive|permission|credential|secret)\b/.test(lower)
    || /\b(before|without|even though|even if|although|despite|not|never|fail|fails|failed|failing|red|blocked)\b/.test(lower)
  ) {
    return undefined;
  }

  const openPr = /\b(open|create)\b.*\b(pr|pull request)\b/.test(lower);
  const gateThenOpenPr = /\b(when|after|once)\b.*\b(checks?|ci|tests?)\b.*\b(green|pass|passing|passed)\b.*\b(open|create)\b.*\b(pr|pull request)\b/.test(lower);
  const openPrThenGate = /\b(open|create)\b.*\b(pr|pull request)\b.*\b(when|after|once)\b.*\b(checks?|ci|tests?)\b.*\b(green|pass|passing|passed)\b/.test(lower);
  const openPrOnGreen = openPr && /\bon green\b/.test(lower);
  if (gateThenOpenPr || openPrThenGate || openPrOnGreen) {
    return 'yes';
  }

  if (/\b(proceed|continue|move on)\b.*\b(next reviewer|reviewer)\b/.test(lower)) {
    return 'yes, continue';
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stablePreview(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(sortForStableStringify(value));
  } catch {
    return String(value);
  }
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (typeof value !== 'object' || value === null) return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortForStableStringify((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
