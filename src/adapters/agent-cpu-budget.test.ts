import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildAgentCpuCommand, validateAgentCpuList } from './agent-cpu-budget.js';

describe('shared agent CPU allocation', () => {
  it('leaves unconfigured Linux and macOS launches unchanged', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(validateAgentCpuList(' ', platform)).toBeUndefined();
      expect(buildAgentCpuCommand('agent', ['a b'])).toEqual({ command: 'agent', args: ['a b'] });
    }
  });

  it('rejects malformed lists and explicit unsupported platform settings', () => {
    for (const value of ['-1', '3-1', '0;echo bad', '1,,2', 'Infinity', '9007199254740992']) {
      expect(() => validateAgentCpuList(value, 'linux')).toThrow('KOOKR_AGENT_CPU_LIST');
    }
    expect(validateAgentCpuList(' 0-3,8-11 ', 'linux')).toBe('0-3,8-11');
    expect(() => validateAgentCpuList('0-3', 'darwin')).toThrow('requires Linux');
  });

  it.runIf(process.platform === 'linux')('restricts the child and its descendant without restricting the caller', () => {
    const before = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)![1];
    const cpu = before.split(/[,-]/)[0];
    const probe = `const fs=require('fs');const cp=require('child_process');console.log(fs.readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\\s*(.+)$/m)[1]);cp.execFileSync(process.execPath,['-e',${JSON.stringify("console.log(require('fs').readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\\s*(.+)$/m)[1])")}],{stdio:'inherit'});`;
    const launch = buildAgentCpuCommand(process.execPath, ['-e', probe], cpu);
    expect(execFileSync(launch.command, launch.args, { encoding: 'utf8' }).trim().split('\n')).toEqual([cpu, cpu]);
    expect(readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)![1]).toBe(before);
  });
});
