import { randomUUID } from 'node:crypto';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import type {
  UserInputDeliverySnapshot,
  UserInputDeliverySource,
} from '../shared/contracts/user-input-delivery.js';

interface UserInputDeliveryServiceDeps {
  adapter: Pick<AgentAdapter, 'sendInput'>;
  interactionLog?: DeferredInteractionLogWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
