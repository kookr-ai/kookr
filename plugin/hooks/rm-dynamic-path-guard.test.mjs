// Tests for rm-dynamic-path-guard.sh (issue #3867): run the real hook (the .sh
// wrapper, as Claude Code does) on PreToolUse events and read its decision.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './rm-dynamic-path-guard.mjs';

const HOOK = join(import.meta.dirname, 'rm-dynamic-path-guard.sh');

/** Runs the hook; returns the denial reason, or null when allowed. */
function hook(command, toolName = 'Bash') {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: '/tmp' }),
    encoding: 'utf-8',
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return null;
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

describe('rm-dynamic-path-guard', () => {
  it('denies the issue #3867 cases with an instruction to delete by literal path', () => {
    for (const cmd of [
      'rm -rf "$(cat f)"',
      'rm -rf `cat f`',
      'rm -rf "$DIR"',
      'rm -r -- $X',
    ]) {
      const reason = hook(cmd);
      expect(reason, cmd).toMatch(/blocked a recursive rm on a computed path/);
      expect(reason, cmd).toMatch(/Delete by literal path/);
      expect(reason, cmd).toContain('find /literal/dir -mindepth 1 -delete');
    }
  });

  it('denies the command that stalled tasks #3743 and #3644', () => {
    const reason = hook('cd /repo && git status; rm -rf "$(cat /tmp/claude-1000/s/scratchpad/mutdir)"');
    expect(reason).toContain('`$(cat /tmp/claude-1000/s/scratchpad/mutdir)`');
  });

  it('denies other recursive flag spellings and command positions', () => {
    expect(hook('rm -Rf $TMP')).not.toBeNull();
    expect(hook('rm -fr "${WORK}/x"')).not.toBeNull();
    expect(hook('rm --recursive --force "$D"')).not.toBeNull();
    expect(hook('rm -f -r /literal "$D"')).not.toBeNull();
    expect(hook('/bin/rm -rf "$D"')).not.toBeNull();
    expect(hook('sudo rm -rf "$D"')).not.toBeNull();
    expect(hook('ls && rm -rf $(cat f)')).not.toBeNull();
    expect(hook('for d in a b; do rm -rf "$d"; done')).not.toBeNull();
    expect(hook('if test -d x; then rm -rf "$x"; fi')).not.toBeNull();
    expect(hook('trap true EXIT\nrm -rf "$T"')).not.toBeNull();
    expect(hook('rm -r -- "-$X"')).not.toBeNull();
    expect(hook('timeout 60 rm -rf "$D"')).not.toBeNull();
    expect(hook('FOO=1 env rm -rf "$D"')).not.toBeNull();
    expect(hook('command rm -rf "$D"')).not.toBeNull();
    expect(hook('exec rm -rf "$D"')).not.toBeNull();
  });

  it('keeps checking after a comment with an apostrophe or a here-string', () => {
    expect(hook("# don't leave junk\nrm -rf \"$TMP\"\necho 'done'")).not.toBeNull();
    expect(hook('jq . <<< "$json"\nrm -rf "$D"')).not.toBeNull();
    expect(hook('# rm -rf "$D" is denied\nls')).toBeNull();
  });

  it('allows literal paths, non-recursive rm and git rm', () => {
    expect(hook('rm -rf /tmp/claude-1000/x/scratchpad/mutdir')).toBeNull();
    expect(hook('rm file.txt')).toBeNull();
    expect(hook('git rm -r dir')).toBeNull();
    expect(hook('rm "$f"')).toBeNull();
    expect(hook('rm -f "$LOG"')).toBeNull();
    expect(hook('rm -rf /tmp/a/b 2>>"$LOG"')).toBeNull();
    expect(hook('rm -rf /tmp/a/b > "$LOG" 2>&1')).toBeNull();
    expect(hook('echo "$HOME" && rm -rf /tmp/a')).toBeNull();
    expect(hook('"$RM" -rf "$D"')).toBeNull();
  });

  it('allows text that only mentions such a command', () => {
    expect(hook('git commit -m \'fix: deny rm -rf "$(cat f)" in hooks\'')).toBeNull();
    expect(hook('git commit -m "fix: deny rm -rf \\"\\$(cat f)\\" in hooks"')).toBeNull();
    expect(hook("grep -rn 'rm -rf \"$(' plugin/")).toBeNull();
    expect(hook('echo "never run rm -rf $DIR"')).toBeNull();
    expect(hook('cat > notes.md <<\'EOF\'\nrm -rf "$(cat f)"\nrm -r -- $X\nEOF\nls')).toBeNull();
    expect(hook('gh pr create --title t --body "denies rm -rf `cat f`"')).toBeNull();
  });

  it('ignores other tools and malformed input', () => {
    expect(hook('rm -rf "$D"', 'Write')).toBeNull();
    const r = spawnSync('bash', [HOOK], { input: 'not json rm $', encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('allows every bash block the shipped playbooks and skills tell agents to run', () => {
    const plugin = join(import.meta.dirname, '..');
    const docs = [
      ...readdirSync(join(plugin, 'playbooks')).filter((f) => f.endsWith('.md')).map((f) => join(plugin, 'playbooks', f)),
      ...readdirSync(join(plugin, 'skills'), { recursive: true })
        .filter((f) => String(f).endsWith('.md'))
        .map((f) => join(plugin, 'skills', String(f))),
    ];
    const denied = [];
    for (const doc of docs) {
      const text = readFileSync(doc, 'utf-8');
      for (const m of text.matchAll(/^ *```(?:bash|sh)\n([\s\S]*?)^ *```/gm)) {
        const target = decide(m[1]);
        if (target !== null) denied.push(`${doc}: ${target}`);
      }
    }
    expect(denied).toEqual([]);
  });

  it('is registered for Bash in the plugin hook manifest', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'hooks.json'), 'utf-8'));
    const bash = manifest.hooks.PreToolUse.find((m) => m.matcher === 'Bash');
    expect(bash.hooks.map((h) => h.command)).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/rm-dynamic-path-guard.sh');
  });
});
