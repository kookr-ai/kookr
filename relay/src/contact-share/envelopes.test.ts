import { describe, expect, it } from 'vitest';

import type { ContactShareEnvelope } from '../../../src/shared/contracts/contact-share.js';
import { InMemoryContactShareEnvelopeStore } from './envelopes.js';

function makeEnvelope(overrides: Partial<ContactShareEnvelope> = {}): ContactShareEnvelope {
  return {
    schemaVersion: 'contact-share-envelope.v1',
    envelopeId: 'env-1',
    shareId: 'share-1',
    decisionVersion: 0,
    senderContactId: 'sender-1',
    recipientContactId: 'recipient-1',
    recipientDeviceId: 'device-1',
    kind: 'share.invite',
    createdAt: '2026-01-01T00:00:00.000Z',
    ciphertext: 'cipher',
    senderSignature: 'sig',
    ...overrides,
  };
}

describe('InMemoryContactShareEnvelopeStore', () => {
  describe('validation', () => {
    it('rejects a non-envelope value', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      // Callers may hand the store untrusted input reconstructed from persistence.
      expect(() => store.put({} as unknown as ContactShareEnvelope)).toThrow(
        'invalid contact share envelope',
      );
    });

    it('rejects an envelope with the wrong schema version', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      const bad = makeEnvelope({ schemaVersion: 'contact-share-envelope.v0' as ContactShareEnvelope['schemaVersion'] });
      expect(() => store.put(bad)).toThrow('invalid contact share envelope');
    });

    it('rejects an envelope with an empty ciphertext', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      expect(() => store.put(makeEnvelope({ ciphertext: '' }))).toThrow(
        'invalid contact share envelope',
      );
    });

    it('does not store an envelope that failed validation', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      expect(() => store.put(makeEnvelope({ senderSignature: '' }))).toThrow();
      expect(store.list()).toEqual([]);
    });

    it('accepts a valid envelope and returns it', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      const envelope = makeEnvelope();
      expect(store.put(envelope)).toEqual(envelope);
      expect(store.list()).toEqual([envelope]);
    });
  });

  describe('first-write-wins deduplication', () => {
    it('preserves the first value for a duplicate envelope id', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      const first = makeEnvelope({ envelopeId: 'dup', ciphertext: 'first' });
      const second = makeEnvelope({ envelopeId: 'dup', ciphertext: 'second' });

      store.put(first);
      const returned = store.put(second);

      expect(returned.ciphertext).toBe('first');
      expect(store.list()).toEqual([first]);
    });
  });

  describe('defensive cloning', () => {
    it('does not retain a reference to the input object', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      const envelope = makeEnvelope();
      store.put(envelope);

      envelope.ciphertext = 'mutated';

      expect(store.list()[0]?.ciphertext).toBe('cipher');
    });

    it('returns a fresh object from put that does not leak back into the store', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      const returned = store.put(makeEnvelope());

      returned.ciphertext = 'mutated';

      expect(store.list()[0]?.ciphertext).toBe('cipher');
    });

    it('returns a defensive clone of an existing envelope on a duplicate put', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ envelopeId: 'dup' }));
      const returned = store.put(makeEnvelope({ envelopeId: 'dup' }));

      returned.ciphertext = 'mutated';

      expect(store.list()[0]?.ciphertext).toBe('cipher');
    });

    it('returns fresh objects from list on every call', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope());

      store.list()[0]!.ciphertext = 'mutated';

      expect(store.list()[0]?.ciphertext).toBe('cipher');
    });

    it('returns a fresh array from list that callers can mutate safely', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope());

      const list = store.list();
      list.pop();

      expect(store.list()).toHaveLength(1);
    });
  });

  describe('recipient filtering', () => {
    it('returns only envelopes for the exact recipient device id', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ envelopeId: 'a', recipientDeviceId: 'device-a' }));
      store.put(makeEnvelope({ envelopeId: 'b', recipientDeviceId: 'device-b' }));

      const forA = store.listForDevice('device-a');

      expect(forA.map((e) => e.envelopeId)).toEqual(['a']);
    });

    it('does not match on a prefix of the recipient device id', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ envelopeId: 'a', recipientDeviceId: 'device-1' }));

      expect(store.listForDevice('device')).toEqual([]);
      expect(store.listForDevice('device-10')).toEqual([]);
    });

    it('returns an empty list for an unknown recipient device id', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ recipientDeviceId: 'device-a' }));

      expect(store.listForDevice('nobody')).toEqual([]);
    });

    it('returns recipient-filtered results as defensive clones', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ recipientDeviceId: 'device-a' }));

      store.listForDevice('device-a')[0]!.ciphertext = 'mutated';

      expect(store.listForDevice('device-a')[0]?.ciphertext).toBe('cipher');
    });
  });

  describe('ordering', () => {
    it('lists envelopes ordered by createdAt regardless of insertion order', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ envelopeId: 'later', createdAt: '2026-03-01T00:00:00.000Z' }));
      store.put(makeEnvelope({ envelopeId: 'earlier', createdAt: '2026-01-01T00:00:00.000Z' }));
      store.put(makeEnvelope({ envelopeId: 'middle', createdAt: '2026-02-01T00:00:00.000Z' }));

      expect(store.list().map((e) => e.envelopeId)).toEqual(['earlier', 'middle', 'later']);
    });

    it('orders recipient-filtered results by createdAt', () => {
      const store = new InMemoryContactShareEnvelopeStore();
      store.put(makeEnvelope({ envelopeId: 'b', recipientDeviceId: 'device-a', createdAt: '2026-02-01T00:00:00.000Z' }));
      store.put(makeEnvelope({ envelopeId: 'a', recipientDeviceId: 'device-a', createdAt: '2026-01-01T00:00:00.000Z' }));

      expect(store.listForDevice('device-a').map((e) => e.envelopeId)).toEqual(['a', 'b']);
    });
  });
});
