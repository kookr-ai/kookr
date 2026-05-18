import type { ContactShareEnvelope } from '../../../src/shared/contracts/contact-share.js';
import { isContactShareEnvelope } from '../../../src/shared/contracts/contact-share.js';

function cloneEnvelope(envelope: ContactShareEnvelope): ContactShareEnvelope {
  return { ...envelope };
}

export class InMemoryContactShareEnvelopeStore {
  private readonly envelopes = new Map<string, ContactShareEnvelope>();

  put(envelope: ContactShareEnvelope): ContactShareEnvelope {
    if (!isContactShareEnvelope(envelope)) {
      throw new Error('invalid contact share envelope');
    }
    const existing = this.envelopes.get(envelope.envelopeId);
    if (existing) return cloneEnvelope(existing);
    const stored = cloneEnvelope(envelope);
    this.envelopes.set(stored.envelopeId, stored);
    return cloneEnvelope(stored);
  }

  listForDevice(recipientDeviceId: string): ContactShareEnvelope[] {
    return this.list().filter((envelope) => envelope.recipientDeviceId === recipientDeviceId);
  }

  list(): ContactShareEnvelope[] {
    return [...this.envelopes.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(cloneEnvelope);
  }
}
