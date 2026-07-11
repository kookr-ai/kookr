import { describe, it, expect } from 'vitest';
import {
  buildGrokMonitoringHooksConfig,
  GROK_MONITORING_EVENTS,
  GROK_HOOK_TIMEOUT_SECONDS,
} from './monitoring-hooks.js';

const BASE_OPTS = {
  tmuxName: 'kookr-abc',
  hookFile: '/h/kookr-abc.jsonl',
  serverPort: 4801,
  writerPath: '/repo/bin/kookr-hook-writer.js',
  nodePath: '/usr/bin/node',
};

describe('GROK_MONITORING_EVENTS', () => {
  it('includes the expected PascalCase event names', () => {
    const expected = [
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionDenied',
      'Stop',
      'StopFailure',
      'Notification',
      'SubagentStart',
      'SubagentStop',
      'SessionEnd',
      'UserPromptSubmit',
    ];
    for (const event of expected) {
      expect(GROK_MONITORING_EVENTS).toContain(event);
    }
  });
});

describe('buildGrokMonitoringHooksConfig', () => {
  it('returns a hooks object whose keys equal GROK_MONITORING_EVENTS', () => {
    const config = buildGrokMonitoringHooksConfig(BASE_OPTS);
    expect(Object.keys(config.hooks).sort()).toEqual([...GROK_MONITORING_EVENTS].sort());
  });

  it('maps each event to one matcher group with a single command entry', () => {
    const config = buildGrokMonitoringHooksConfig(BASE_OPTS);
    for (const event of GROK_MONITORING_EVENTS) {
      const groups = config.hooks[event];
      expect(groups).toHaveLength(1);
      expect(groups[0].hooks).toHaveLength(1);
      const entry = groups[0].hooks[0];
      expect(entry.type).toBe('command');
      expect(typeof entry.command).toBe('string');
      expect(entry.timeout).toBe(GROK_HOOK_TIMEOUT_SECONDS);
    }
  });

  it('embeds the writerPath, hookFile, and tmuxName into the command', () => {
    const config = buildGrokMonitoringHooksConfig(BASE_OPTS);
    const command = config.hooks.PreToolUse[0].hooks[0].command;
    expect(command).toContain(BASE_OPTS.writerPath);
    expect(command).toContain(BASE_OPTS.hookFile);
    expect(command).toContain(BASE_OPTS.tmuxName);
  });

  it('defaults the timeout to GROK_HOOK_TIMEOUT_SECONDS (10)', () => {
    expect(GROK_HOOK_TIMEOUT_SECONDS).toBe(10);
    const config = buildGrokMonitoringHooksConfig(BASE_OPTS);
    expect(config.hooks.Stop[0].hooks[0].timeout).toBe(10);
  });

  it('honors a custom timeoutSeconds override', () => {
    const config = buildGrokMonitoringHooksConfig({ ...BASE_OPTS, timeoutSeconds: 42 });
    for (const event of GROK_MONITORING_EVENTS) {
      expect(config.hooks[event][0].hooks[0].timeout).toBe(42);
    }
  });

  it('produces a plain command string with no trailing "&" (not backgrounded)', () => {
    const config = buildGrokMonitoringHooksConfig(BASE_OPTS);
    for (const event of GROK_MONITORING_EVENTS) {
      const command = config.hooks[event][0].hooks[0].command;
      expect(typeof command).toBe('string');
      expect(command.trim().endsWith('&')).toBe(false);
    }
  });
});
