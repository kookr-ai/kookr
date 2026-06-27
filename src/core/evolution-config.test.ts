import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvolutionConfig, validateEvolutionConfig } from './evolution-config.js';

describe('validateEvolutionConfig', () => {
  test('accepts the minimal schema-valid manifest', () => {
    expect(validateEvolutionConfig({
      schemaVersion: 'kookr-evolution-config.v1',
      evaluate: './evaluate.sh',
      artifact: 'strategy.json',
    })).toEqual({
      ok: true,
      config: {
        schemaVersion: 'kookr-evolution-config.v1',
        evaluate: './evaluate.sh',
        artifact: 'strategy.json',
      },
    });
  });

  test('rejects missing required fields with clear errors', () => {
    expect(validateEvolutionConfig({
      schemaVersion: 'kookr-evolution-config.v1',
      artifact: 'strategy.json',
    })).toEqual({
      ok: false,
      error: 'evaluate is required and must be a non-empty string',
    });
  });

  test('rejects schema drift and unsupported fields', () => {
    expect(validateEvolutionConfig({
      schemaVersion: 'kookr-evolution-config.v2',
      evaluate: './evaluate.sh',
      artifact: 'strategy.json',
    })).toEqual({
      ok: false,
      error: 'schemaVersion must be "kookr-evolution-config.v1"',
    });

    expect(validateEvolutionConfig({
      schemaVersion: 'kookr-evolution-config.v1',
      evaluate: './evaluate.sh',
      artifact: 'strategy.json',
      metricName: 'sharpe',
    })).toEqual({
      ok: false,
      error: 'unsupported field "metricName"',
    });
  });

  test('validates numeric stop settings', () => {
    expect(validateEvolutionConfig({
      schemaVersion: 'kookr-evolution-config.v1',
      evaluate: './evaluate.sh',
      artifact: 'strategy.json',
      patience: 0,
    })).toEqual({
      ok: false,
      error: 'patience must be an integer greater than or equal to 1',
    });
  });
});

describe('readEvolutionConfig', () => {
  test('reports missing and malformed config files clearly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'evolution-config-'));
    try {
      await expect(readEvolutionConfig(cwd)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('Missing .kookr/evolution/config.json'),
      });

      await mkdir(join(cwd, '.kookr', 'evolution'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'evolution', 'config.json'), '{bad');
      await expect(readEvolutionConfig(cwd)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('Malformed .kookr/evolution/config.json'),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
