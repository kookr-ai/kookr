import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { ClientMessageSchema, summarizeZodIssues } from './client-message-schema.js';

describe('summarizeZodIssues', () => {
  test('returns a placeholder when the error has no issues', () => {
    const fakeError = { issues: [] } as unknown as z.ZodError;
    expect(summarizeZodIssues(fakeError)).toBe('validation failed');
  });

  test('renders a single issue with its dotted path and message', () => {
    const result = ClientMessageSchema.safeParse({ type: 'launch', prompt: 'x', cwd: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeZodIssues(result.error);
      expect(summary).toContain('cwd');
    }
  });

  test('labels root-level issues as "(root)"', () => {
    const result = ClientMessageSchema.safeParse('not an object');
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeZodIssues(result.error);
      expect(summary).toContain('(root)');
    }
  });

  test('caps output at five issues', () => {
    const manyIssues = Array.from({ length: 12 }, (_, i) => ({
      code: 'custom',
      path: [`field${i}`],
      message: `msg${i}`,
    }));
    const fakeError = { issues: manyIssues } as unknown as z.ZodError;
    const summary = summarizeZodIssues(fakeError);
    // Expect only msg0..msg4 to appear; msg5 onward trimmed.
    expect(summary).toContain('msg0');
    expect(summary).toContain('msg4');
    expect(summary).not.toContain('msg5');
  });

  test('joins nested paths with dots', () => {
    const fakeError = {
      issues: [{ code: 'custom', path: ['config', 'dailyPrLimit'], message: 'expected number' }],
    } as unknown as z.ZodError;
    expect(summarizeZodIssues(fakeError)).toContain('config.dailyPrLimit');
  });
});

describe('ClientMessageSchema — happy path sanity', () => {
  test('accepts a minimal well-formed launch message', () => {
    const result = ClientMessageSchema.safeParse({ type: 'launch', prompt: 'hi', cwd: '/tmp' });
    expect(result.success).toBe(true);
  });

  test('accepts a respond message with all required fields', () => {
    const result = ClientMessageSchema.safeParse({ type: 'respond', agentId: 'a1', input: 'go' });
    expect(result.success).toBe(true);
  });

  test('rejects an unknown type as a discriminator error', () => {
    const result = ClientMessageSchema.safeParse({ type: 'wat' });
    expect(result.success).toBe(false);
  });
});
