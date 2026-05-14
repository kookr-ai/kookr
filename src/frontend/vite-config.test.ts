import { describe, expect, test } from 'vitest';
import viteConfig from '../../vite.config';

describe('frontend Vite config', () => {
  test('emits hidden production source maps', () => {
    const config = viteConfig as { build?: { sourcemap?: unknown } };

    expect(config.build?.sourcemap).toBe('hidden');
  });
});
