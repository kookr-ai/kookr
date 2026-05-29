import { describe, it, expect } from 'vitest';
import { DrainController } from './drain-state.js';

describe('DrainController', () => {
  it('starts accepting by default', () => {
    const c = new DrainController();
    expect(c.isAccepting()).toBe(true);
    expect(c.status()).toEqual({ accepting: true, draining: false });
  });

  it('drain() stops accepting and records the start time', () => {
    const c = new DrainController();
    const at = new Date('2026-05-29T12:00:00.000Z');
    expect(c.drain(at)).toBe(true);
    expect(c.isAccepting()).toBe(false);
    expect(c.status()).toEqual({ accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z' });
  });

  it('drain() is idempotent — a second call reports no change and keeps the original since', () => {
    const c = new DrainController();
    c.drain(new Date('2026-05-29T12:00:00.000Z'));
    expect(c.drain(new Date('2026-05-29T13:00:00.000Z'))).toBe(false);
    expect(c.status().since).toBe('2026-05-29T12:00:00.000Z');
  });

  it('resume() restores accepting and clears the start time', () => {
    const c = new DrainController();
    c.drain();
    expect(c.resume()).toBe(true);
    expect(c.isAccepting()).toBe(true);
    expect(c.status()).toEqual({ accepting: true, draining: false });
  });

  it('resume() is idempotent — a no-op when already accepting', () => {
    const c = new DrainController();
    expect(c.resume()).toBe(false);
    expect(c.isAccepting()).toBe(true);
  });

  it('round-trips drain → resume → drain', () => {
    const c = new DrainController();
    c.drain();
    c.resume();
    expect(c.drain()).toBe(true);
    expect(c.isAccepting()).toBe(false);
  });
});
