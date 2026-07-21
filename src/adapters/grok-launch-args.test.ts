import { describe, it, expect } from 'vitest';
import {
  buildGrokLaunchArgs,
  buildAllowlistedGrokEnv,
  resolveGrokLaunchGate,
  resolveGrokModel,
  DEFAULT_GROK_MODEL,
  GROK_BUILD_KILL_SWITCH_ENV,
  GROK_MODEL_ENV,
} from './grok-launch-args.js';

describe('buildGrokLaunchArgs', () => {
  it('mirrors the POC-A interactive invocation: --no-alt-screen --model <model>', () => {
    expect(buildGrokLaunchArgs({ model: 'grok-build' })).toEqual([
      '--no-alt-screen',
      '--model',
      'grok-build',
    ]);
  });

  it('never emits a --reasoning-effort flag (Grok exposes no validated effort)', () => {
    const args = buildGrokLaunchArgs({ model: 'grok-build' });
    expect(args.join(' ')).not.toContain('effort');
  });

  it('maps explicit bypass opt-in to --permission-mode bypassPermissions', () => {
    expect(buildGrokLaunchArgs({ model: 'grok-build', bypassAllPermissions: true })).toEqual([
      '--no-alt-screen',
      '--model',
      'grok-build',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('never places the prompt on argv', () => {
    const args = buildGrokLaunchArgs({ model: 'grok-build' });
    expect(args).not.toContain('-p');
  });
});

describe('buildAllowlistedGrokEnv', () => {
  const processEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/dev',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    // Secrets that MUST NOT reach the Grok child:
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    GITHUB_TOKEN: 'ghp_should_not_leak',
    XAI_API_KEY: 'xai-should-not-leak',
    AWS_SECRET_ACCESS_KEY: 'aws-should-not-leak',
    KOOKR_DEPLOY_SECRET: 'deploy-should-not-leak',
    GROK_CLAUDE_HOOKS_ENABLED: '1',
  } as NodeJS.ProcessEnv;

  const env = buildAllowlistedGrokEnv({
    processEnv,
    launchContextEnv: { KOOKR_TASK_ID: 't1', PATH: '/launcher:/usr/bin:/bin' },
    grokHome: '/tmp/session/.grok',
    authPath: '/home/dev/.grok/auth.json',
  });

  it('excludes unrelated provider/GitHub/deploy secrets (allowlist, not blocklist)', () => {
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.KOOKR_DEPLOY_SECRET).toBeUndefined();
  });

  it('passes through safe TUI/shell vars and preserves the real HOME', () => {
    expect(env.HOME).toBe('/home/dev');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('includes Kookr task context, with launch-context PATH winning', () => {
    expect(env.KOOKR_TASK_ID).toBe('t1');
    expect(env.PATH).toBe('/launcher:/usr/bin:/bin');
  });

  it('redirects GROK_HOME, shares auth via GROK_AUTH_PATH, disables auto-update + data collection', () => {
    expect(env.GROK_HOME).toBe('/tmp/session/.grok');
    expect(env.GROK_AUTH_PATH).toBe('/home/dev/.grok/auth.json');
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(env.GROK_AUTO_UPDATE).toBe('0');
    expect(env.GROK_WORKSPACE_DATA_COLLECTION_DISABLED).toBe('1');
    expect(env.GROK_FOLDER_TRUST).toBe('1');
  });

  it('disables inherited Claude hooks while keeping Kookr native hooks active', () => {
    expect(env.GROK_CLAUDE_HOOKS_ENABLED).toBe('0');
  });

  it('defaults TERM when the server env lacks it', () => {
    const e = buildAllowlistedGrokEnv({
      processEnv: { PATH: '/bin' } as NodeJS.ProcessEnv,
      launchContextEnv: {},
      grokHome: '/g',
      authPath: '/home/dev/.grok/auth.json',
    });
    expect(e.TERM).toBe('xterm-256color');
  });

  it('strips XAI_API_KEY even if launchContextEnv tried to inject it', () => {
    const e = buildAllowlistedGrokEnv({
      processEnv,
      launchContextEnv: { XAI_API_KEY: 'xai-must-not-reach-agent' },
      grokHome: '/tmp/session/.grok',
      authPath: '/home/dev/.grok/auth.json',
    });
    expect(e.XAI_API_KEY).toBeUndefined();
  });
});

describe('resolveGrokLaunchGate', () => {
  it('allows by default (GA — no opt-in flag)', () => {
    expect(resolveGrokLaunchGate({}).allowed).toBe(true);
  });

  it('refuses new launches when the kill switch is set', () => {
    const gate = resolveGrokLaunchGate({
      [GROK_BUILD_KILL_SWITCH_ENV]: 'true',
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('kill switch');
  });
});

describe('resolveGrokModel', () => {
  it('defaults to the requalified model', () => {
    expect(resolveGrokModel({})).toBe(DEFAULT_GROK_MODEL);
    expect(DEFAULT_GROK_MODEL).toBe('grok-4.5');
  });
  it('honors the env override', () => {
    expect(resolveGrokModel({ [GROK_MODEL_ENV]: 'grok-composer-2.5-fast' })).toBe('grok-composer-2.5-fast');
  });
});
