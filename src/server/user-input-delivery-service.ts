import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { isPaneBusyOrAwaitingDialog } from '../adapters/agent-launch-context.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { stripTerminalControls, visibleLinesFromTerminalText } from '../shared/pane-semantics.js';
import type {
  UserInputDeliverySnapshot,
  UserInputDeliverySource,
} from '../shared/contracts/user-input-delivery.js';

interface UserInputDeliveryServiceDeps {
  adapter: Pick<AgentAdapter, 'sendInput'>;
  interactionLog?: DeferredInteractionLogWriter;
  retry?: UserInputDeliveryRetryDeps;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface UserInputDeliveryRetryDeps {
  /** Send one bare Enter keystroke to the session. */
  sendEnter: (sessionId: string) => Promise<void>;
  /** Capture the current rendered pane for retry evidence gates. */
  capturePane: (sessionId: string) => Promise<string>;
  /** Age after PTY acceptance or last retry before another Enter nudge. */
  confirmTimeoutMs?: number;
  /** Max bare-Enter retries per delivery. */
  maxEnterRetries?: number;
}

const DEFAULT_SUBMIT_CONFIRM_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ENTER_RETRIES = 2;
const PASTED_TEXT_PLACEHOLDER = '[Pasted text';
const PANE_EVIDENCE_FRAGMENT_CHARS = 48;
const COMPOSER_DRAFT_LINE_RE = /^\s*[❯›]\s+\S/;
const EMPTY_COMPOSER_LINE_RE = /^\s*[❯›]\s*$/;
const TRAILING_COMPOSER_EVIDENCE_LINES = 6;
const COMPOSER_TRAILING_DECORATION_RES = [
  /^\s*$/,
  /^[╭╰│─\s]+$/,
  /\b(?:esc to interrupt|ctrl\+[a-z]|shift\+tab|tab to queue message)\b/i,
  /^\s{2}(?:gpt-[\w.-].*|Fast on\s*$|.*(?:% left|context left).*)$/i,
];

function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function paneShowsUnsubmittedDelivery(pane: string, deliveryText: string): boolean {
  const trailingLines = visibleLinesFromTerminalText(stripTerminalControls(pane))
    .map((line) => line.trimEnd())
    .slice(-TRAILING_COMPOSER_EVIDENCE_LINES);
  if (trailingLines.length === 0) return false;
  const firstLine = normalizePrompt(deliveryText).split('\n').find((line) => line.trim().length > 0);
  if (!firstLine) return false;
  const fragment = firstLine.slice(0, PANE_EVIDENCE_FRAGMENT_CHARS);

  for (let i = trailingLines.length - 1; i >= 0; i -= 1) {
    const line = trailingLines[i];
    if (EMPTY_COMPOSER_LINE_RE.test(line)) return false;
    if (!COMPOSER_DRAFT_LINE_RE.test(line)) {
      if (COMPOSER_TRAILING_DECORATION_RES.some((re) => re.test(line))) continue;
      return false;
    }
    return line.includes(PASTED_TEXT_PLACEHOLDER) || line.includes(fragment);
  }
  return false;
}

export class UserInputDeliveryService {
  private readonly deliveriesBySession = new Map<string, UserInputDeliverySnapshot[]>();
  private readonly nextSeqBySession = new Map<string, number>();
  private readonly observedHookIds = new Set<string>();

  constructor(private readonly deps: UserInputDeliveryServiceDeps) {}

  async submitMessage(
    sessionId: string,
    text: string,
    source: UserInputDeliverySource,
  ): Promise<UserInputDeliverySnapshot> {
    const delivery = this.createDelivery(sessionId, text, source);
    this.appendDelivery(delivery);

    try {
      await this.deps.adapter.sendInput(sessionId, text);
      const acceptedAt = this.nowIso();
      const current = this.getDelivery(sessionId, delivery.deliveryId);
      if (current.status !== 'queued' || current.terminalReason) {
        return current;
      }
      this.replaceDelivery(sessionId, delivery.deliveryId, {
        ...current,
        status: 'queued',
        ptyAcceptedAt: acceptedAt,
        updatedAt: acceptedAt,
      });
      try {
        await this.deps.interactionLog?.append({
          type: 'user_input',
          agentId: sessionId,
          content: text,
          source,
          timestamp: acceptedAt,
        });
      } catch (error) {
        console.warn('[user-input-delivery] Failed to write user_input interaction log', error);
      }
      return this.getDelivery(sessionId, delivery.deliveryId);
    } catch (error) {
      const failedAt = this.nowIso();
      this.replaceDelivery(sessionId, delivery.deliveryId, {
        ...delivery,
        status: 'failed',
        updatedAt: failedAt,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  observeProviderUserPrompt(
    sessionId: string,
    prompt: string,
    hookLineId: string,
    observedAtMs = Date.now(),
  ): void {
    const hookKey = `${sessionId}:${hookLineId}`;
    if (this.observedHookIds.has(hookKey)) return;
    this.observedHookIds.add(hookKey);

    const deliveries = this.deliveriesBySession.get(sessionId) ?? [];
    const normalizedPrompt = normalizePrompt(prompt);
    const match = deliveries.find((delivery) => (
      delivery.status === 'queued'
      && delivery.ptyAcceptedAt !== undefined
      && delivery.submittedHookLineId === undefined
      && observedAtMs > Date.parse(delivery.createdAt)
      && normalizePrompt(delivery.text) === normalizedPrompt
    ));
    if (!match) return;

    const submittedAt = this.nowIso();
    this.replaceDelivery(sessionId, match.deliveryId, {
      ...match,
      status: 'submitted_by_agent',
      submittedHookLineId: hookLineId,
      updatedAt: submittedAt,
    });
  }

  finalizeSession(sessionId: string): void {
    const deliveries = this.deliveriesBySession.get(sessionId) ?? [];
    for (const delivery of deliveries) {
      if (delivery.status !== 'queued') continue;
      const finalizedAt = this.nowIso();
      this.replaceDelivery(sessionId, delivery.deliveryId, {
        ...delivery,
        status: 'failed',
        updatedAt: finalizedAt,
        terminalReason: 'session_ended_before_submit_hook',
      });
    }
  }

  /**
   * Closed-loop submit retry for mid-session messages. If a delivery was
   * accepted by the PTY but no provider `UserPromptSubmit` hook arrives, the
   * original Enter may have been swallowed by TUI paste-burst handling. Send a
   * bare Enter only when the pane still shows the queued text and is not busy
   * or awaiting a permission choice.
   */
  async sweepUnsubmittedDeliveries(): Promise<number> {
    const retry = this.deps.retry;
    if (!retry) return 0;

    const confirmTimeoutMs = retry.confirmTimeoutMs ?? DEFAULT_SUBMIT_CONFIRM_TIMEOUT_MS;
    const maxEnterRetries = retry.maxEnterRetries ?? DEFAULT_MAX_ENTER_RETRIES;
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    let nudges = 0;

    for (const [sessionId, deliveries] of this.deliveriesBySession) {
      const candidates = deliveries.filter((delivery) => (
        delivery.status === 'queued'
        && delivery.ptyAcceptedAt !== undefined
        && delivery.submittedHookLineId === undefined
        && (delivery.enterRetries ?? 0) < maxEnterRetries
        && nowMs - Date.parse(delivery.lastRetryAt ?? delivery.ptyAcceptedAt) >= confirmTimeoutMs
      ));
      if (candidates.length === 0) continue;

      let pane: string;
      try {
        pane = await retry.capturePane(sessionId);
      } catch {
        continue;
      }
      if (isPaneBusyOrAwaitingDialog(pane)) continue;

      for (const delivery of candidates) {
        if (!paneShowsUnsubmittedDelivery(pane, delivery.text)) continue;
        try {
          await retry.sendEnter(sessionId);
        } catch {
          break;
        }

        const retriedAt = this.nowIso();
        const attempt = (delivery.enterRetries ?? 0) + 1;
        this.replaceDelivery(sessionId, delivery.deliveryId, {
          ...delivery,
          enterRetries: attempt,
          lastRetryAt: retriedAt,
          updatedAt: retriedAt,
        });
        nudges += 1;
        console.log(JSON.stringify({
          event: 'user_input_delivery.retry_enter',
          sessionId,
          deliveryId: delivery.deliveryId,
          attempt,
        }));
        break;
      }
    }

    return nudges;
  }

  getSnapshot(sessionId: string): UserInputDeliverySnapshot[] {
    return [...(this.deliveriesBySession.get(sessionId) ?? [])]
      .sort((a, b) => a.deliverySeq - b.deliverySeq)
      .map((delivery) => ({ ...delivery }));
  }

  private createDelivery(
    sessionId: string,
    text: string,
    source: UserInputDeliverySource,
  ): UserInputDeliverySnapshot {
    const createdAt = this.nowIso();
    const deliverySeq = this.nextSeqBySession.get(sessionId) ?? 1;
    this.nextSeqBySession.set(sessionId, deliverySeq + 1);
    return {
      deliveryId: this.deps.idGenerator?.() ?? randomUUID(),
      sessionId,
      deliverySeq,
      source,
      text,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    };
  }

  private appendDelivery(delivery: UserInputDeliverySnapshot): void {
    const deliveries = this.deliveriesBySession.get(delivery.sessionId) ?? [];
    deliveries.push(delivery);
    this.deliveriesBySession.set(delivery.sessionId, deliveries);
  }

  private replaceDelivery(
    sessionId: string,
    deliveryId: string,
    next: UserInputDeliverySnapshot,
  ): void {
    const deliveries = this.deliveriesBySession.get(sessionId) ?? [];
    const index = deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
    if (index === -1) return;
    deliveries[index] = next;
  }

  private getDelivery(sessionId: string, deliveryId: string): UserInputDeliverySnapshot {
    const delivery = (this.deliveriesBySession.get(sessionId) ?? [])
      .find((candidate) => candidate.deliveryId === deliveryId);
    if (!delivery) {
      throw new Error(`User input delivery ${deliveryId} disappeared for ${sessionId}`);
    }
    return { ...delivery };
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
