import { describe, test, expect } from 'vitest';
import { generateTaskName } from '../../core/task-naming.js';
import { createLlmClient } from './factory.js';

const hasApiKey = !!(
  process.env.GROQ_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.ANTHROPIC_API_KEY
);

describe.skipIf(!hasApiKey)('task-naming integration (real API)', () => {
  test('generates a short name for a coding task', async () => {
    const client = await createLlmClient();
    if (!client) throw new Error('No LLM client available');

    const name = await generateTaskName(
      client,
      'Fix the authentication bug in the login flow where expired JWT tokens are not being properly invalidated, causing users to remain logged in after their session should have expired',
      '/workspace/kookr',
    );

    expect(name).not.toBeNull();
    expect(name!.length).toBeGreaterThan(0);
    expect(name!.length).toBeLessThan(80);
    // Should be roughly 3-8 words
    const wordCount = name!.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(2);
    expect(wordCount).toBeLessThanOrEqual(12);
    console.log(`Generated name: "${name}"`);
  }, 10_000);

  test('generates a name incorporating criteria context', async () => {
    const client = await createLlmClient();
    if (!client) throw new Error('No LLM client available');

    const name = await generateTaskName(
      client,
      'Add pagination to the /api/users endpoint',
      '/workspace/webapp',
      'All existing tests pass and new pagination tests cover edge cases',
    );

    expect(name).not.toBeNull();
    expect(name!.length).toBeGreaterThan(0);
    console.log(`Generated name with criteria: "${name}"`);
  }, 10_000);
});
