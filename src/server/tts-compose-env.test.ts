import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = join(import.meta.dirname, '..', '..');
const hasDockerCompose = (() => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const composeTest = hasDockerCompose ? test : test.skip;

function modelEnvReads(): string[] {
  const serverSource = readFileSync(join(repoRoot, 'tts', 'src', 'server.py'), 'utf8');
  return [...serverSource.matchAll(/os\.environ\.get\("(TTS_MODEL_[A-Z0-9_]+)"/g)]
    .map((match) => match[1])
    .sort();
}

function composeModelEnv(): Record<string, unknown> {
  const composeSource = readFileSync(join(repoRoot, 'tts', 'docker-compose.yml'), 'utf8');
  const compose = parse(composeSource) as {
    services: { 'kookr-tts': { environment: Record<string, unknown> } };
  };
  return compose.services['kookr-tts'].environment;
}

function resolvedNoiseClamp(hostValue?: string): string {
  const env = { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' };
  if (hostValue === undefined) {
    delete env.TTS_MODEL_NOISE_CLAMP;
  } else {
    env.TTS_MODEL_NOISE_CLAMP = hostValue;
  }

  const config = JSON.parse(execFileSync(
    'docker',
    ['compose', '-f', join(repoRoot, 'tts', 'docker-compose.yml'), 'config', '--format', 'json'],
    { encoding: 'utf8', env },
  )) as { services: { 'kookr-tts': { environment: Record<string, string> } } };
  return config.services['kookr-tts'].environment.TTS_MODEL_NOISE_CLAMP;
}

describe('TTS compose model environment', () => {
  test('forwards every model setting read by the sidecar', () => {
    const forwardedModelSettings = Object.keys(composeModelEnv())
      .filter((name) => name.startsWith('TTS_MODEL_'))
      .sort();

    expect(forwardedModelSettings).toEqual(modelEnvReads());
  });

  composeTest('resolves the optional empty default when the host setting is absent', () => {
    expect(resolvedNoiseClamp()).toBe('');
  });

  composeTest('resolves the host noise clamp into the sidecar environment', () => {
    expect(resolvedNoiseClamp('0.25')).toBe('0.25');
  });
});
