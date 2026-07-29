import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { AdapterRegistry, type AgentAdapter } from './agent-adapter.js';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { CodexCliAdapter } from './codex-cli-adapter.js';
import { GrokBuildAdapter } from './grok-build-adapter.js';
import type { GrokInstalledState } from './grok-build-preflight.js';
import { TaskStore } from '../core/tasks.js';

// getGitInfo touches the real filesystem/git; stub it for hermetic launches.
vi.mock('./git-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-info.js')>();
  return { ...actual, getGitInfo: vi.fn().mockResolvedValue(null) };
});

/** Probe stub: a kookr-fork codex advertising both --plugin-dir and --prompt-file. */
const forkProbeExec: import('./probe-agent-binary.js').ProbeExecRunner = async (_file, args) => {
  if (args.includes('--help')) {
    return {
      stdout: 'Usage: codex [OPTIONS] [PROMPT]\n      --plugin-dir <DIR>\n      --prompt-file <PATH>\n',
      stderr: '',
    };
  }
  return { stdout: 'codex 0.125.0\n', stderr: '' };
};

const GROK_CANONICAL = '/fake/.grok/bin/grok-0.2.93';

function grokTestedState(): GrokInstalledState {
  return {
    kind: 'ok',
    version: '0.2.93',
    buildId: 'f00f96316d',
    identity: {
      configured: 'grok',
      launcherPath: '/fake/.grok/bin/grok',
      canonicalPath: GROK_CANONICAL,
      sha256: '4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135',
      sizeBytes: 159465672,
      mode: 0o755,
      uid: 1000,
      gid: 1000,
    },
    qualification: { status: 'tested', reason: 'matches tested build', evidenceBuildId: '0.2.93 (f00f96316d)' },
  };
}

/**
 * A per-adapter test harness: constructs a real adapter over a FakeTerminalBackend
 * so its launch() SessionSpec can be inspected, plus an argv substring that only
 * appears when the launch bypasses permissions.
 */
interface AdapterCase {
  agentType: string;
  make(): { adapter: AgentAdapter; backend: FakeTerminalBackend; taskStore: TaskStore };
  /** Substring that appears in SessionSpec.args ONLY when permissions are bypassed. */
  bypassArgMarker: string;
}

describe('AdapterLaunchOptions contract — every registered adapter honors it', () => {
  const tmpDirs: string[] = [];
  let sourceGrokHome: string;
  let sessionHomeRoot: string;

  beforeEach(() => {
    sessionHomeRoot = mkdtempSync(join(tmpdir(), 'contract-grok-sess-'));
    sourceGrokHome = mkdtempSync(join(tmpdir(), 'contract-grok-src-'));
    tmpDirs.push(sessionHomeRoot, sourceGrokHome);
    writeFileSync(
      join(sourceGrokHome, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
          key: 'test-access-token',
          auth_mode: 'oidc',
          create_time: '2026-07-01T00:00:00Z',
          user_id: 'test-user',
          expires_at: '2030-01-01T00:00:00Z',
          refresh_token: 'test-refresh-token',
        },
      }),
    );
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /**
   * Build the case table fresh per assertion so no adapter state (or backend
   * session map) bleeds across launches. Each factory mirrors the adapter's own
   * unit-test construction so the launch path is the real one.
   */
  function adapterCases(caseOpts: { bypassDefault?: boolean } = {}): AdapterCase[] {
    const { bypassDefault } = caseOpts;
    return [
      {
        agentType: 'claude-code',
        bypassArgMarker: '--dangerously-skip-permissions',
        make() {
          const backend = new FakeTerminalBackend();
          const taskStore = new TaskStore();
          const adapter = new ClaudeCodeAdapter(backend, taskStore, {
            writeFile: async () => {},
            // Never scan the operator's real ~/.claude/agents in bypass mode.
            loadFileBasedAgents: () => [],
            bypassAllPermissions: bypassDefault,
          });
          return { adapter, backend, taskStore };
        },
      },
      {
        agentType: 'codex-cli',
        bypassArgMarker: '--dangerously-bypass-approvals-and-sandbox',
        make() {
          const backend = new FakeTerminalBackend();
          const taskStore = new TaskStore();
          vi.stubEnv('KOOKR_CODEX_MODEL', '');
          const adapter = new CodexCliAdapter(backend, taskStore, {
            trustWorkspace: false,
            probeExec: forkProbeExec,
            writeFile: async () => {},
            bypassAllPermissions: bypassDefault,
          });
          return { adapter, backend, taskStore };
        },
      },
      {
        agentType: 'grok-build',
        bypassArgMarker: 'bypassPermissions',
        make() {
          const backend = new FakeTerminalBackend();
          const taskStore = new TaskStore();
          const adapter = new GrokBuildAdapter(backend, taskStore, {
            env: { PATH: '/usr/bin:/bin', HOME: '/home/dev', TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
            installedStateOverride: grokTestedState(),
            sourceGrokHome,
            sessionHomeRoot,
            promptBracketedPaste: false,
            promptReadyTimeoutMs: 30,
            bypassAllPermissions: bypassDefault,
          });
          return { adapter, backend, taskStore };
        },
      },
    ];
  }

  function buildRegistry(cases: AdapterCase[]): {
    registry: AdapterRegistry;
    backends: Map<string, FakeTerminalBackend>;
    stores: Map<string, TaskStore>;
  } {
    const registry = new AdapterRegistry();
    const backends = new Map<string, FakeTerminalBackend>();
    const stores = new Map<string, TaskStore>();
    for (const c of cases) {
      const { adapter, backend, taskStore } = c.make();
      registry.register(adapter);
      backends.set(adapter.agentType, backend);
      stores.set(adapter.agentType, taskStore);
    }
    return { registry, backends, stores };
  }

  test('the registry actually holds all three shipping adapters', () => {
    const { registry } = buildRegistry(adapterCases());
    expect(registry.getAll().map((a) => a.agentType).sort()).toEqual(
      ['claude-code', 'codex-cli', 'grok-build'],
    );
  });

  test('a caller-supplied tmuxName is used verbatim as the session id', async () => {
    const { registry, stores } = buildRegistry(adapterCases());
    for (const adapter of registry.getAll()) {
      const taskStore = stores.get(adapter.agentType)!;
      const preallocated = `kookr-contract-${adapter.agentType}`;
      const task = taskStore.createTask('do it', '/workspace');
      const sessionId = await adapter.launch(task.id, 'do it', '/workspace', undefined, {
        tmuxName: preallocated,
      });
      expect(sessionId, `${adapter.agentType} must honor opts.tmuxName`).toBe(preallocated);
    }
  });

  test('caller-supplied extraEnv keys appear in the spawned process env', async () => {
    const { registry, backends, stores } = buildRegistry(adapterCases());
    for (const adapter of registry.getAll()) {
      const backend = backends.get(adapter.agentType)!;
      const taskStore = stores.get(adapter.agentType)!;
      const task = taskStore.createTask('do it', '/workspace');
      const sessionId = await adapter.launch(task.id, 'do it', '/workspace', undefined, {
        extraEnv: { RALPH_VERDICT_FILE: '/tmp/verdict.json', RALPH_ITERATION: '3' },
      });
      const env = backend.sessions.get(sessionId)!.spec.env!;
      expect(env.RALPH_VERDICT_FILE, `${adapter.agentType} must merge opts.extraEnv`).toBe(
        '/tmp/verdict.json',
      );
      expect(env.RALPH_ITERATION, `${adapter.agentType} must merge opts.extraEnv`).toBe('3');
    }
  });

  test('a per-call bypassPermissions override reaches the launch argv', async () => {
    const cases = adapterCases();
    const { registry, backends, stores } = buildRegistry(cases);
    const markerByType = new Map(cases.map((c) => [c.agentType, c.bypassArgMarker]));
    for (const adapter of registry.getAll()) {
      const backend = backends.get(adapter.agentType)!;
      const taskStore = stores.get(adapter.agentType)!;
      const marker = markerByType.get(adapter.agentType)!;

      // Constructor default is bypass=false, so the marker must be absent
      // unless the per-call override turns it on.
      const offTask = taskStore.createTask('do it', '/workspace');
      const offSession = await adapter.launch(offTask.id, 'do it', '/workspace', undefined, {
        bypassPermissions: false,
      });
      const offArgs = backend.sessions.get(offSession)!.spec.args;
      expect(offArgs, `${adapter.agentType} default should not bypass`).not.toContain(marker);

      const onTask = taskStore.createTask('do it', '/workspace');
      const onSession = await adapter.launch(onTask.id, 'do it', '/workspace', undefined, {
        bypassPermissions: true,
      });
      const onArgs = backend.sessions.get(onSession)!.spec.args;
      expect(onArgs, `${adapter.agentType} must honor opts.bypassPermissions`).toContain(marker);
    }
  });

  test('a per-call bypassPermissions:false overrides a constructor default of true', async () => {
    // The contract is `opts?.bypassPermissions ?? this.bypassAllPermissions`,
    // so the override must win in BOTH directions. With the instance default ON,
    // an unset opt keeps the marker but an explicit `false` must remove it — the
    // direction a `||` regression would silently break.
    const cases = adapterCases({ bypassDefault: true });
    const { registry, backends, stores } = buildRegistry(cases);
    const markerByType = new Map(cases.map((c) => [c.agentType, c.bypassArgMarker]));
    for (const adapter of registry.getAll()) {
      const backend = backends.get(adapter.agentType)!;
      const taskStore = stores.get(adapter.agentType)!;
      const marker = markerByType.get(adapter.agentType)!;

      // No override → instance default (ON) applies.
      const defTask = taskStore.createTask('do it', '/workspace');
      const defSession = await adapter.launch(defTask.id, 'do it', '/workspace');
      const defArgs = backend.sessions.get(defSession)!.spec.args;
      expect(defArgs, `${adapter.agentType} default-on should bypass when opt unset`).toContain(marker);

      // Explicit false must win over the instance default.
      const offTask = taskStore.createTask('do it', '/workspace');
      const offSession = await adapter.launch(offTask.id, 'do it', '/workspace', undefined, {
        bypassPermissions: false,
      });
      const offArgs = backend.sessions.get(offSession)!.spec.args;
      expect(offArgs, `${adapter.agentType} must let opts.bypassPermissions:false win`).not.toContain(
        marker,
      );
    }
  });
});
