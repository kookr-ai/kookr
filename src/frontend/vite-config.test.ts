import { describe, expect, test } from 'vitest';
import viteConfig from '../../vite.config';

describe('frontend Vite config', () => {
  test('emits hidden production source maps', () => {
    const config = viteConfig as { build?: { sourcemap?: unknown } };

    expect(config.build?.sourcemap).toBe('hidden');
  });

  test('splits stable frontend vendors into named chunks', () => {
    const config = viteConfig as {
      build?: {
        rolldownOptions?: {
          output?: {
            manualChunks?: (id: string) => string | undefined;
          };
        };
      };
    };
    const manualChunks = config.build?.rolldownOptions?.output?.manualChunks;

    expect(manualChunks).toBeTypeOf('function');
    expect(manualChunks?.('/repo/node_modules/react/index.js')).toBe('vendor-react');
    expect(manualChunks?.('/repo/node_modules/react-dom/client.js')).toBe('vendor-react');
    expect(manualChunks?.('/repo/node_modules/zustand/esm/index.mjs')).toBe('vendor-state');
    expect(manualChunks?.('/repo/node_modules/@xterm/xterm/lib/xterm.js')).toBe('vendor-terminal');
    expect(manualChunks?.('/repo/node_modules/zod/index.js')).toBe('vendor');
    expect(manualChunks?.('/repo/src/frontend/App.tsx')).toBeUndefined();
  });
});
